//! Behaviour and fail-closed boundary tests for `crate_source` (`mod.rs`, `lockfile.rs`,
//! `manifest.rs`, `git.rs` and `verify.rs`).

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use gg_query::crate_source::{
    CrateSourceArgs, CrateSourceKind, CrateSourceMatch, CrateSourceReport, ResolutionStatus,
    format_crate_source_json, format_crate_source_text, resolve_crate_source,
};

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvGuard {
    saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
}

impl EnvGuard {
    fn save(keys: &[&'static str]) -> Self {
        let saved = keys.iter().map(|&k| (k, env::var_os(k))).collect();
        Self { saved }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (k, v) in &self.saved {
            // SAFETY: this integration test binary serialises every env mutation under `ENV_LOCK`,
            // and no other test in this binary reads `CARGO_HOME`, `HOME` or `USERPROFILE`.
            unsafe {
                match v {
                    Some(val) => env::set_var(k, val),
                    None => env::remove_var(k),
                }
            }
        }
    }
}

#[cfg(unix)]
struct ModeGuard {
    path: PathBuf,
    mode: u32,
}

#[cfg(unix)]
impl Drop for ModeGuard {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(self.mode));
    }
}

fn write_file(path: &Path, content: impl AsRef<[u8]>) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, content).unwrap();
}

fn make_lock(name: &str, version: &str, source: Option<&str>) -> String {
    match source {
        Some(s) => format!(
            "version = 4\n\n[[package]]\nname = \"{name}\"\nversion = \"{version}\"\nsource = \"{s}\"\n"
        ),
        None => format!("version = 4\n\n[[package]]\nname = \"{name}\"\nversion = \"{version}\"\n"),
    }
}

fn resolve_one(
    repo: &Path,
    cargo_home: &Path,
    name: &str,
    version: Option<&str>,
    lockfile: Option<&Path>,
) -> Result<CrateSourceReport, String> {
    resolve_crate_source(&CrateSourceArgs {
        crate_name: name,
        repo,
        version,
        cargo_home: Some(cargo_home),
        lockfile,
    })
}

#[test]
fn validates_crate_names_versions_missing_repo_not_found_dedup_and_truncation() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let ch = tmp.path().join("cargo_home");
    fs::create_dir_all(&repo).unwrap();
    fs::create_dir_all(&ch).unwrap();

    for bad in ["", &"a".repeat(129), "-bad", "foo/bar"] {
        let err = resolve_one(&repo, &ch, bad, None, None).unwrap_err();
        assert!(err.contains("invalid crate name"), "bad={bad:?}: {err}");
    }
    for bad_ver in ["", &"1".repeat(129), "1..2", "1.0.0/evil"] {
        let err = resolve_one(&repo, &ch, "demo", Some(bad_ver), None).unwrap_err();
        assert!(
            err.contains("invalid version filter"),
            "ver={bad_ver:?}: {err}"
        );
    }

    let err = resolve_one(&tmp.path().join("missing-repo"), &ch, "demo", None, None).unwrap_err();
    assert!(err.contains("cannot resolve repo"), "{err}");

    let mut lock = String::from("version = 4\n");
    for i in 0..17 {
        lock.push_str(&format!(
            "\n[[package]]\nname = \"many\"\nversion = \"0.1.{i}\"\n"
        ));
    }
    lock.push_str("\n[[package]]\nname = \"many\"\nversion = \"0.1.0\"\n");
    write_file(&repo.join("Cargo.lock"), &lock);

    let err_no_ver = resolve_one(&repo, &ch, "absent", None, None).unwrap_err();
    assert!(
        err_no_ver.contains("crate \"absent\" not found"),
        "{err_no_ver}"
    );
    let err_ver = resolve_one(&repo, &ch, "many", Some("9.9.9"), None).unwrap_err();
    assert!(
        err_ver.contains("crate \"many\" version 9.9.9 not found"),
        "{err_ver}"
    );

    let report = resolve_one(&repo, &ch, "many", None, None).unwrap();
    assert_eq!(report.matches.len(), 16);
    assert_eq!(report.truncated, 1);
}

#[test]
fn formats_text_and_json_across_kinds_statuses_hints_and_truncation() {
    let synthetic = CrateSourceReport {
        query: "demo".to_string(),
        version_filter: None,
        cargo_home: "/cache".to_string(),
        matches: vec![
            CrateSourceMatch {
                name: "demo".to_string(),
                version: "1.0.0".to_string(),
                kind: CrateSourceKind::Registry,
                status: ResolutionStatus::Found,
                lockfile: "Cargo.lock".to_string(),
                source: Some("registry+https://github.com/rust-lang/crates.io-index".to_string()),
                path: Some("/cache/demo-1.0.0".to_string()),
                manifest_path: Some("/cache/demo-1.0.0/Cargo.toml".to_string()),
                src_dir: None,
                hint: None,
            },
            CrateSourceMatch {
                name: "demo".to_string(),
                version: "2.0.0".to_string(),
                kind: CrateSourceKind::Git,
                status: ResolutionStatus::NotCached,
                lockfile: "Cargo.lock".to_string(),
                source: None,
                path: None,
                manifest_path: None,
                src_dir: None,
                hint: Some("run cargo fetch".to_string()),
            },
            CrateSourceMatch {
                name: "demo".to_string(),
                version: "3.0.0".to_string(),
                kind: CrateSourceKind::Path,
                status: ResolutionStatus::Unresolved,
                lockfile: "sub/Cargo.lock".to_string(),
                source: None,
                path: None,
                manifest_path: None,
                src_dir: None,
                hint: None,
            },
        ],
        truncated: 2,
    };

    let text = format_crate_source_text(&synthetic);
    assert!(text.contains("demo 1.0.0 (registry, Cargo.lock) → /cache/demo-1.0.0"));
    assert!(text.contains("⚠ demo 2.0.0 (git, Cargo.lock): run cargo fetch"));
    assert!(text.contains("⚠ demo 3.0.0 (path, sub/Cargo.lock): not cached locally"));
    assert!(text.contains("… and 2 more match(es)"));

    let mut untrun = synthetic;
    untrun.truncated = 0;
    assert!(!format_crate_source_text(&untrun).contains("more match(es)"));
    assert!(
        format_crate_source_json(&untrun)
            .unwrap()
            .contains("\"query\": \"demo\"")
    );
}

#[test]
fn resolves_cargo_home_from_env_vars_and_fails_when_unset() {
    let _lock = ENV_LOCK.lock().unwrap();
    let _guard = EnvGuard::save(&["CARGO_HOME", "HOME", "USERPROFILE"]);

    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let custom_ch = tmp.path().join("env_cargo");
    let fake_home = tmp.path().join("fake_home");
    let fake_profile = tmp.path().join("fake_profile");
    fs::create_dir_all(&custom_ch).unwrap();
    fs::create_dir_all(&fake_home).unwrap();
    fs::create_dir_all(&fake_profile).unwrap();
    write_file(&repo.join("Cargo.lock"), make_lock("demo", "1.0.0", None));

    let raw_ch = custom_ch.join(".").join("sub").join("..");
    // SAFETY: guarded by `ENV_LOCK`; no other test in this binary reads these variables.
    unsafe {
        env::set_var("CARGO_HOME", &raw_ch);
    }
    let rep1 = resolve_crate_source(&CrateSourceArgs {
        crate_name: "demo",
        repo: &repo,
        version: None,
        cargo_home: None,
        lockfile: None,
    })
    .unwrap();
    assert_eq!(PathBuf::from(&rep1.cargo_home), custom_ch);

    // SAFETY: guarded by `ENV_LOCK`.
    unsafe {
        env::set_var("CARGO_HOME", "   ");
        env::set_var("HOME", &fake_home);
        env::remove_var("USERPROFILE");
    }
    let rep2 = resolve_crate_source(&CrateSourceArgs {
        crate_name: "demo",
        repo: &repo,
        version: None,
        cargo_home: None,
        lockfile: None,
    })
    .unwrap();
    assert_eq!(PathBuf::from(&rep2.cargo_home), fake_home.join(".cargo"));

    // SAFETY: guarded by `ENV_LOCK`.
    unsafe {
        env::remove_var("CARGO_HOME");
        env::remove_var("HOME");
        env::set_var("USERPROFILE", &fake_profile);
    }
    let rep3 = resolve_crate_source(&CrateSourceArgs {
        crate_name: "demo",
        repo: &repo,
        version: None,
        cargo_home: None,
        lockfile: None,
    })
    .unwrap();
    assert_eq!(PathBuf::from(&rep3.cargo_home), fake_profile.join(".cargo"));

    // SAFETY: guarded by `ENV_LOCK`.
    unsafe {
        env::remove_var("USERPROFILE");
    }
    let err = resolve_crate_source(&CrateSourceArgs {
        crate_name: "demo",
        repo: &repo,
        version: None,
        cargo_home: None,
        lockfile: None,
    })
    .unwrap_err();
    assert!(err.contains("cannot determine CARGO_HOME"), "{err}");
}

#[test]
fn discovers_lockfiles_via_explicit_paths_and_bounded_auto_scan() {
    let tmp = tempfile::tempdir().unwrap();
    let ch = tmp.path().join("cargo_home");
    fs::create_dir_all(&ch).unwrap();

    let repo1 = tmp.path().join("repo1");
    let sub_lock = repo1.join("sub/Cargo.lock");
    write_file(&sub_lock, make_lock("demo", "1.0.0", None));
    write_file(
        &repo1.join("sub/Cargo.toml"),
        "[package]\nname = \"demo\"\nversion = \"1.0.0\"\n",
    );

    let r_rel = resolve_one(&repo1, &ch, "demo", None, Some(Path::new("sub/Cargo.lock"))).unwrap();
    assert_eq!(r_rel.matches[0].status, ResolutionStatus::Found);
    assert_eq!(r_rel.matches[0].lockfile, "sub/Cargo.lock");

    let abs_lock = fs::canonicalize(&sub_lock).unwrap();
    let r_abs = resolve_one(&repo1, &ch, "demo", None, Some(&abs_lock)).unwrap();
    assert_eq!(r_abs.matches[0].status, ResolutionStatus::Found);

    let err_esc = resolve_one(
        &repo1,
        &ch,
        "demo",
        None,
        Some(Path::new("../outside.lock")),
    )
    .unwrap_err();
    assert!(err_esc.contains("missing or escapes"), "{err_esc}");

    let err_dir = resolve_one(&repo1, &ch, "demo", None, Some(Path::new("sub"))).unwrap_err();
    assert!(err_dir.contains("not a regular file"), "{err_dir}");

    write_file(&repo1.join("README.md"), "hi\n");
    write_file(
        &repo1.join("target/Cargo.lock"),
        make_lock("skip", "1.0.0", None),
    );
    write_file(
        &repo1.join("a/b/c/d/Cargo.lock"),
        make_lock("deep", "1.0.0", None),
    );
    #[cfg(unix)]
    let _unreadable_guard = {
        use std::os::unix::fs::{PermissionsExt, symlink};
        symlink(&sub_lock, repo1.join("link.lock")).unwrap();
        let unreadable = repo1.join("unreadable");
        fs::create_dir(&unreadable).unwrap();
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).unwrap();
        ModeGuard {
            path: unreadable,
            mode: 0o755,
        }
    };
    let r_scan = resolve_one(&repo1, &ch, "demo", None, None).unwrap();
    assert_eq!(r_scan.matches[0].status, ResolutionStatus::Found);

    let empty_repo = tmp.path().join("empty_repo");
    fs::create_dir_all(&empty_repo).unwrap();
    let err_none = resolve_one(&empty_repo, &ch, "demo", None, None).unwrap_err();
    assert!(err_none.contains("no Cargo.lock found"), "{err_none}");

    let big_repo = tmp.path().join("big_repo");
    fs::create_dir_all(&big_repo).unwrap();
    for i in 0..515 {
        write_file(&big_repo.join(format!("f{i:04}")), "");
    }
    let err_budget = resolve_one(&big_repo, &ch, "demo", None, None).unwrap_err();
    assert!(
        err_budget.contains("lockfile scan budget exceeded"),
        "{err_budget}"
    );
}

#[test]
fn parses_lockfile_literal_strings_arrays_metadata_headers_and_bad_keys() {
    let tmp = tempfile::tempdir().unwrap();
    let ch = tmp.path().join("cargo_home");
    fs::create_dir_all(&ch).unwrap();

    let syntax_repo = tmp.path().join("syntax_repo");
    write_file(
        &syntax_repo.join("Cargo.lock"),
        concat!(
            "version = 3\n\n",
            "[[package]]\n",
            "name = 'litpkg' # literal string comment\n",
            "version = '1.2.3'\n",
            "dependencies = [\n",
            "  \"quoted \\\"[nested]\\\"\",\n",
            "  'single [bracket]',\n",
            "]\n",
            "bare_line_without_equals\n\n",
            "[metadata]\n",
            "\"checksum litpkg 1.2.3\" = \"abc\"\n",
        ),
    );
    let r_lit = resolve_one(&syntax_repo, &ch, "litpkg", None, None).unwrap();
    assert_eq!(r_lit.matches[0].version, "1.2.3");

    let bad_empty_key = tmp.path().join("bad_empty_key");
    write_file(
        &bad_empty_key.join("Cargo.lock"),
        "[[package]]\n= \"val\"\n",
    );
    let err_ek = resolve_one(&bad_empty_key, &ch, "demo", None, None).unwrap_err();
    assert!(err_ek.contains("empty key"), "{err_ek}");

    let bad_trailing_key = tmp.path().join("bad_trailing_key");
    write_file(
        &bad_trailing_key.join("Cargo.lock"),
        "[[package]]\nname extra = \"val\"\n",
    );
    let err_tk = resolve_one(&bad_trailing_key, &ch, "demo", None, None).unwrap_err();
    assert!(err_tk.contains("invalid TOML key"), "{err_tk}");
}

#[test]
fn parses_inline_workspace_versions_and_rejects_malformed_manifest_fields() {
    let tmp = tempfile::tempdir().unwrap();
    let ch = tmp.path().join("cargo_home");
    fs::create_dir_all(&ch).unwrap();

    let repo = tmp.path().join("repo");
    write_file(&repo.join("Cargo.lock"), make_lock("mem", "1.2.3", None));
    write_file(
        &repo.join("Cargo.toml"),
        "workspace = { package = { version = \"1.2.3\" } }\n",
    );
    write_file(
        &repo.join("crates/mem/Cargo.toml"),
        "[package]\nname = \"mem\"\nversion = { workspace = true }\n",
    );
    write_file(
        &repo.join("crates/bad1/Cargo.toml"),
        "[package]\nname = 123\nversion = \"1.2.3\"\n",
    );
    write_file(
        &repo.join("crates/bad2/Cargo.toml"),
        "[package]\nname = \"mem\"\nversion = { workspace = false }\n",
    );
    write_file(
        &repo.join("crates/bad3/Cargo.toml"),
        "[package]\nname = \"mem\"\nversion = 42\n",
    );
    write_file(
        &repo.join("crates/bad4/Cargo.toml"),
        "[package]\nname = \"mem\"\nversion.workspace = false\n",
    );
    write_file(
        &repo.join("crates/bad5/Cargo.toml"),
        "[package]\nname = \"mem\"\n",
    );
    #[cfg(unix)]
    let _unreadable_guard = {
        use std::os::unix::fs::PermissionsExt;
        let blocked = repo.join("crates/unreadable_dir");
        fs::create_dir_all(&blocked).unwrap();
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o000)).unwrap();
        ModeGuard {
            path: blocked,
            mode: 0o755,
        }
    };

    let rep = resolve_one(&repo, &ch, "mem", None, None).unwrap();
    assert_eq!(rep.matches[0].status, ResolutionStatus::Found);

    let repo_no_ver = tmp.path().join("repo_no_ver");
    write_file(
        &repo_no_ver.join("Cargo.lock"),
        make_lock("mem", "1.2.3", None),
    );
    write_file(
        &repo_no_ver.join("Cargo.toml"),
        "workspace = { package = { edition = \"2024\" } }\n",
    );
    write_file(
        &repo_no_ver.join("sub/Cargo.toml"),
        "[workspace]\npackage = \"not-a-table\"\n",
    );
    write_file(
        &repo_no_ver.join("sub/mem/Cargo.toml"),
        "[package]\nname = \"mem\"\nversion = { workspace = true }\n",
    );
    let rep_no = resolve_one(&repo_no_ver, &ch, "mem", None, None).unwrap();
    assert_eq!(rep_no.matches[0].status, ResolutionStatus::NotCached);

    let repo_huge_ws = tmp.path().join("repo_huge_ws");
    write_file(
        &repo_huge_ws.join("crates/mem/Cargo.lock"),
        make_lock("mem", "1.2.3", None),
    );
    write_file(&repo_huge_ws.join("Cargo.toml"), "a".repeat(260 * 1024));
    write_file(
        &repo_huge_ws.join("crates/mem/Cargo.toml"),
        "[package]\nname = \"mem\"\nversion.workspace = true\n",
    );
    let rep_huge = resolve_one(
        &repo_huge_ws,
        &ch,
        "mem",
        None,
        Some(Path::new("crates/mem/Cargo.lock")),
    )
    .unwrap();
    assert_eq!(
        rep_huge.matches[0].status,
        ResolutionStatus::BudgetExhausted
    );
}

#[test]
fn resolves_git_pointers_symbolic_refs_ambiguity_and_checkout_limits() {
    let sha = "0123456789abcdef0123456789abcdef01234567";
    let wrong_sha = "0123456789abcdef0123456789abcdef99999999";
    let short = &sha[..7];
    let src = format!("git+https://github.com/org/myrepo.git#{sha}");

    let tmp = tempfile::tempdir().unwrap();
    let ch_empty = tmp.path().join("ch_empty");
    fs::create_dir_all(&ch_empty).unwrap();

    for (bad_src, expect) in [
        ("git+https://github.com/org/myrepo", "lacks a commit SHA"),
        (
            "git+https://github.com/org/myrepo#abc123",
            "does not carry a 40-char commit SHA",
        ),
    ] {
        let r = tmp.path().join(format!("bad_{}", bad_src.len()));
        write_file(
            &r.join("Cargo.lock"),
            make_lock("gpkg", "1.0.0", Some(bad_src)),
        );
        let rep = resolve_one(&r, &ch_empty, "gpkg", None, None).unwrap();
        assert_eq!(rep.matches[0].status, ResolutionStatus::Unresolved);
        assert!(rep.matches[0].hint.as_deref().unwrap().contains(expect));
    }

    let repo = tmp.path().join("repo");
    write_file(
        &repo.join("Cargo.lock"),
        make_lock("gpkg", "1.0.0", Some(&src)),
    );
    assert_eq!(
        resolve_one(&repo, &ch_empty, "gpkg", None, None)
            .unwrap()
            .matches[0]
            .status,
        ResolutionStatus::NotCached
    );

    let ch_many = tmp.path().join("ch_many");
    for i in 0..130 {
        write_file(&ch_many.join(format!("git/checkouts/entry-{i:03}")), "");
    }
    assert_eq!(
        resolve_one(&repo, &ch_many, "gpkg", None, None)
            .unwrap()
            .matches[0]
            .status,
        ResolutionStatus::BudgetExhausted
    );

    let ch_abs = tmp.path().join("ch_abs");
    let db_dir = ch_abs.join("git/db/myrepo-db");
    write_file(
        &db_dir.join("config"),
        "[core]\n\tbare = false\n[remote \"origin\"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\turl = https://github.com/org/myrepo.git\n",
    );
    write_file(&db_dir.join("HEAD"), "ref: refs/heads/main\n");
    write_file(&db_dir.join("refs/heads/main"), format!("{sha}\n"));
    let rev_abs = ch_abs.join(format!("git/checkouts/myrepo-1111/{short}"));
    write_file(
        &rev_abs.join("Cargo.toml"),
        "[package]\nname = \"gpkg\"\nversion = \"1.0.0\"\n",
    );
    let abs_db = fs::canonicalize(&db_dir).unwrap();
    write_file(
        &rev_abs.join(".git"),
        format!("gitdir: {}\n", abs_db.display()),
    );
    write_file(&ch_abs.join("git/checkouts/.keep"), "");
    fs::create_dir_all(ch_abs.join("git/checkouts/norev-0000")).unwrap();
    let wrong_rev = ch_abs.join(format!("git/checkouts/wrong-2222/{short}"));
    write_file(&wrong_rev.join(".git/HEAD"), format!("{wrong_sha}\n"));
    write_file(
        &wrong_rev.join("Cargo.toml"),
        "[package]\nname = \"gpkg\"\nversion = \"1.0.0\"\n",
    );
    let unv_other = ch_abs.join(format!("git/checkouts/other-3333/{short}"));
    write_file(
        &unv_other.join("Cargo.toml"),
        "[package]\nname = \"unrelated\"\nversion = \"1.0.0\"\n",
    );
    assert_eq!(
        resolve_one(&repo, &ch_abs, "gpkg", None, None)
            .unwrap()
            .matches[0]
            .status,
        ResolutionStatus::Found
    );

    let rev_rel = ch_abs.join(format!("git/checkouts/myrepo-9999/{short}"));
    write_file(
        &rev_rel.join("Cargo.toml"),
        "[package]\nname = \"gpkg\"\nversion = \"1.0.0\"\n",
    );
    write_file(&rev_rel.join(".git"), "gitdir: ../../../db/myrepo-db\n");
    assert_eq!(
        resolve_one(&repo, &ch_abs, "gpkg", None, None)
            .unwrap()
            .matches[0]
            .status,
        ResolutionStatus::Ambiguous
    );

    fs::remove_dir_all(ch_abs.join("git/checkouts/myrepo-1111")).unwrap();
    assert_eq!(
        resolve_one(&repo, &ch_abs, "gpkg", None, None)
            .unwrap()
            .matches[0]
            .status,
        ResolutionStatus::Found
    );
}

#[test]
fn resolves_git_vcs_info_slug_matching_and_malformed_git_metadata() {
    let sha = "0123456789abcdef0123456789abcdef01234567";
    let short = &sha[..7];
    let src = format!("git+https://github.com/org/myrepo.git#{sha}");

    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    write_file(
        &repo.join("Cargo.lock"),
        make_lock("gpkg", "1.0.0", Some(&src)),
    );

    let ch_vcs = tmp.path().join("ch_vcs");
    let rev_bad_slug = ch_vcs.join(format!("git/checkouts/otherrepo-aaaa/{short}"));
    write_file(
        &rev_bad_slug.join(".git/config"),
        "[core]\n\tbare = false\n",
    );
    write_file(
        &rev_bad_slug.join(".cargo-vcs-info.json"),
        format!("{{\"git\":{{\"sha1\":\"{sha}\"}}}}"),
    );
    write_file(
        &rev_bad_slug.join("Cargo.toml"),
        "[package]\nname = \"gpkg\"\nversion = \"1.0.0\"\n",
    );
    assert_eq!(
        resolve_one(&repo, &ch_vcs, "gpkg", None, None)
            .unwrap()
            .matches[0]
            .status,
        ResolutionStatus::NotCached
    );

    let repo_noslug = tmp.path().join("repo_noslug");
    write_file(
        &repo_noslug.join("Cargo.lock"),
        make_lock("gpkg", "1.0.0", Some(&format!("git+#{sha}"))),
    );
    assert_eq!(
        resolve_one(&repo_noslug, &ch_vcs, "gpkg", None, None)
            .unwrap()
            .matches[0]
            .status,
        ResolutionStatus::NotCached
    );

    let rev_ok_slug = ch_vcs.join(format!("git/checkouts/myrepo-bbbb/{short}"));
    write_file(
        &rev_ok_slug.join(".cargo-vcs-info.json"),
        format!("{{\"git\":{{\"sha1\":\"{sha}\"}}}}"),
    );
    write_file(
        &rev_ok_slug.join("Cargo.toml"),
        "[package]\nname = \"gpkg\"\nversion = \"1.0.0\"\n",
    );
    assert_eq!(
        resolve_one(&repo, &ch_vcs, "gpkg", None, None)
            .unwrap()
            .matches[0]
            .status,
        ResolutionStatus::Found
    );
}

#[test]
fn rejects_malformed_git_pointers_refs_head_and_vcs_info() {
    let sha = "0123456789abcdef0123456789abcdef01234567";
    let short = &sha[..7];
    let src = format!("git+https://github.com/org/myrepo.git#{sha}");

    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    write_file(
        &repo.join("Cargo.lock"),
        make_lock("gpkg", "1.0.0", Some(&src)),
    );

    let outside_git = tmp.path().join("outside_git");
    fs::create_dir_all(&outside_git).unwrap();
    for tag in [
        "gitfile_bad_utf8",
        "gitfile_no_prefix",
        "gitfile_escape",
        "gitfile_to_file",
        "head_bad_utf8",
        "head_invalid_text",
        "ref_short_sha",
        "ref_bad_utf8",
        "ref_missing",
        "vcs_short_sha",
        "vcs_bad_utf8",
    ] {
        let ch = tmp.path().join(format!("ch_{tag}"));
        let rev = ch.join(format!("git/checkouts/myrepo-1/{short}"));
        write_file(
            &rev.join("Cargo.toml"),
            "[package]\nname = \"gpkg\"\nversion = \"1.0.0\"\n",
        );
        match tag {
            "gitfile_bad_utf8" => write_file(&rev.join(".git"), [0xff, 0xfe]),
            "gitfile_no_prefix" => write_file(&rev.join(".git"), "notgitdir\n"),
            "gitfile_escape" => {
                write_file(
                    &rev.join(".git"),
                    format!("gitdir: {}\n", outside_git.display()),
                );
            }
            "gitfile_to_file" => {
                let f = ch.join("git/not_a_dir");
                write_file(&f, "x");
                write_file(&rev.join(".git"), format!("gitdir: {}\n", f.display()));
            }
            "head_bad_utf8" => write_file(&rev.join(".git/HEAD"), [0xff, 0xfe]),
            "head_invalid_text" => write_file(&rev.join(".git/HEAD"), "corrupt-head\n"),
            "ref_short_sha" => {
                write_file(&rev.join(".git/HEAD"), "ref: refs/heads/main\n");
                write_file(&rev.join(".git/refs/heads/main"), "short\n");
            }
            "ref_bad_utf8" => {
                write_file(&rev.join(".git/HEAD"), "ref: refs/heads/main\n");
                write_file(&rev.join(".git/refs/heads/main"), [0xff, 0xfe]);
            }
            "ref_missing" => write_file(&rev.join(".git/HEAD"), "ref: refs/heads/missing\n"),
            "vcs_short_sha" => {
                write_file(
                    &rev.join(".cargo-vcs-info.json"),
                    "{\"git\":{\"sha1\":\"short\"}}",
                );
            }
            "vcs_bad_utf8" => write_file(&rev.join(".cargo-vcs-info.json"), [0xff, 0xfe]),
            _ => unreachable!(),
        }
        let rep = resolve_one(&repo, &ch, "gpkg", None, None).unwrap();
        assert_eq!(rep.matches[0].status, ResolutionStatus::Unresolved, "{tag}");
    }
}

#[test]
fn enforces_git_metadata_budgets_and_propagates_verified_checkout_errors() {
    let sha = "0123456789abcdef0123456789abcdef01234567";
    let short = &sha[..7];
    let src = format!("git+https://github.com/org/myrepo.git#{sha}");

    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    write_file(
        &repo.join("Cargo.lock"),
        make_lock("gpkg", "1.0.0", Some(&src)),
    );

    for tag in [
        "gitfile_big",
        "config_big",
        "head_big",
        "ref_big",
        "vcs_big",
        "verified_scan_budget",
    ] {
        let ch = tmp.path().join(format!("ch_{tag}"));
        let rev = ch.join(format!("git/checkouts/myrepo-1/{short}"));
        fs::create_dir_all(&rev).unwrap();
        match tag {
            "gitfile_big" => write_file(&rev.join(".git"), "a".repeat(5000)),
            "config_big" => write_file(&rev.join(".git/config"), "a".repeat(260 * 1024)),
            "head_big" => write_file(&rev.join(".git/HEAD"), "a".repeat(5000)),
            "ref_big" => {
                write_file(&rev.join(".git/HEAD"), "ref: refs/heads/main\n");
                write_file(&rev.join(".git/refs/heads/main"), "a".repeat(5000));
            }
            "vcs_big" => write_file(&rev.join(".cargo-vcs-info.json"), "a".repeat(260 * 1024)),
            "verified_scan_budget" => {
                write_file(&rev.join(".git/HEAD"), format!("{sha}\n"));
                write_file(
                    &rev.join(".git/config"),
                    "[remote \"origin\"]\n\turl = https://github.com/org/myrepo.git\n",
                );
                for i in 0..515 {
                    write_file(&rev.join(format!("f{i:04}")), "");
                }
            }
            _ => unreachable!(),
        }
        let rep = resolve_one(&repo, &ch, "gpkg", None, None).unwrap();
        assert_eq!(
            rep.matches[0].status,
            ResolutionStatus::BudgetExhausted,
            "{tag}"
        );
    }

    let ch_ws_err = tmp.path().join("ch_ws_err");
    let rev_ws_err = ch_ws_err.join(format!("git/checkouts/myrepo-1/{short}"));
    write_file(&rev_ws_err.join(".git/HEAD"), format!("{sha}\n"));
    write_file(
        &rev_ws_err.join(".git/config"),
        "[remote \"origin\"]\n\turl = https://github.com/org/myrepo.git\n",
    );
    write_file(&rev_ws_err.join("Cargo.toml"), "[workspace]\nmembers = [\n");
    write_file(
        &rev_ws_err.join("sub/Cargo.toml"),
        "[package]\nname = \"gpkg\"\nversion.workspace = true\n",
    );
    let rep_ws_err = resolve_one(&repo, &ch_ws_err, "gpkg", None, None).unwrap();
    assert_eq!(rep_ws_err.matches[0].status, ResolutionStatus::Unresolved);
}

#[test]
fn rejects_invalid_registry_urls_and_handles_crates_io_variants() {
    let tmp = tempfile::tempdir().unwrap();
    let ch_empty = tmp.path().join("ch_empty");
    fs::create_dir_all(&ch_empty).unwrap();

    for (idx, bad_url) in [
        "registry+https://.evil.com/index",
        "registry+https://a..b.com/index",
        "registry+https://user@example.com/index",
        "registry+https:///index",
        "registry+https://[::1]bad/index",
        "registry+https://ex[ample.com/index",
        "registry+https://example.com:/index",
        "registry+https://example.com:abc/index",
        "registry+https://example.com:99999/index",
        "registry+https://example.com:0/index",
        "registry+ftp://example.com/index",
    ]
    .iter()
    .enumerate()
    {
        let r = tmp.path().join(format!("bad_reg_{idx}"));
        write_file(
            &r.join("Cargo.lock"),
            make_lock("rpkg", "1.0.0", Some(bad_url)),
        );
        let rep = resolve_one(&r, &ch_empty, "rpkg", None, None).unwrap();
        assert_eq!(
            rep.matches[0].status,
            ResolutionStatus::Unresolved,
            "url={bad_url}"
        );
    }

    let crates_io = "registry+https://github.com/rust-lang/crates.io-index";
    let r_cio = tmp.path().join("r_cio");
    write_file(
        &r_cio.join("Cargo.lock"),
        make_lock("rpkg", "1.0.0", Some(crates_io)),
    );
    assert_eq!(
        resolve_one(&r_cio, &ch_empty, "rpkg", None, None)
            .unwrap()
            .matches[0]
            .status,
        ResolutionStatus::NotCached
    );

    let ch_cio = tmp.path().join("ch_cio");
    write_file(&ch_cio.join("registry/src/.keep"), "");
    write_file(
        &ch_cio.join("registry/src/index.crates.io-1/rpkg-1.0.0"),
        "not a dir",
    );
    write_file(
        &ch_cio.join("registry/src/other.example.com-deadbeef/rpkg-1.0.0/Cargo.toml"),
        "[package]\nname = \"rpkg\"\nversion = \"1.0.0\"\n",
    );
    assert_eq!(
        resolve_one(&r_cio, &ch_cio, "rpkg", None, None)
            .unwrap()
            .matches[0]
            .status,
        ResolutionStatus::NotCached
    );

    write_file(
        &ch_cio.join("registry/src/github.com-1ecc6299db9ec823/rpkg-1.0.0/Cargo.toml"),
        "[package]\nname = \"rpkg\"\nversion = \"1.0.0\"\n",
    );
    assert_eq!(
        resolve_one(&r_cio, &ch_cio, "rpkg", None, None)
            .unwrap()
            .matches[0]
            .status,
        ResolutionStatus::Found
    );
}

#[test]
fn normalises_custom_registry_urls_and_fails_closed_on_index_config_errors() {
    let tmp = tempfile::tempdir().unwrap();

    for (tag, locked, origin) in [
        (
            "ipv6_port",
            "registry+https://[::1]:8443/index",
            "https://[0:0:0:0:0:0:0:1]:8443/index.git",
        ),
        (
            "https_443",
            "registry+https://example.com:443/index",
            "https://EXAMPLE.COM/index/",
        ),
        (
            "http_80",
            "registry+http://example.com:80/index",
            "http://example.com/index",
        ),
        (
            "pathless",
            "registry+https://example.com",
            "https://example.com/",
        ),
    ] {
        let r = tmp.path().join(format!("r_{tag}"));
        let ch = tmp.path().join(format!("ch_{tag}"));
        write_file(
            &r.join("Cargo.lock"),
            make_lock("rpkg", "1.0.0", Some(locked)),
        );
        write_file(
            &ch.join("registry/src/custom-1/rpkg-1.0.0/Cargo.toml"),
            "[package]\nname = \"rpkg\"\nversion = \"1.0.0\"\n",
        );
        write_file(
            &ch.join("registry/index/custom-1/.git/config"),
            format!("[remote \"origin\"]\n\turl = {origin}\n"),
        );
        let rep = resolve_one(&r, &ch, "rpkg", None, None).unwrap();
        assert_eq!(rep.matches[0].status, ResolutionStatus::Found, "tag={tag}");
    }

    let custom_url = "registry+https://pkgs.example.com/index";
    let r_cust = tmp.path().join("r_cust");
    write_file(
        &r_cust.join("Cargo.lock"),
        make_lock("rpkg", "1.0.0", Some(custom_url)),
    );

    for (tag, cfg_bytes, expect_status) in [
        (
            "bad_origin_url",
            b"[remote \"origin\"]\n\turl = ftp://pkgs.example.com/index\n".to_vec(),
            ResolutionStatus::Unresolved,
        ),
        (
            "no_origin_url",
            b"[core]\n\tbare = true\n".to_vec(),
            ResolutionStatus::Unresolved,
        ),
        (
            "bad_utf8_cfg",
            vec![0xff, 0xfe, 0x80],
            ResolutionStatus::Unresolved,
        ),
        (
            "huge_cfg",
            vec![b'a'; 260 * 1024],
            ResolutionStatus::BudgetExhausted,
        ),
    ] {
        let ch = tmp.path().join(format!("ch_cust_{tag}"));
        write_file(
            &ch.join("registry/src/custom-1/rpkg-1.0.0/Cargo.toml"),
            "[package]\nname = \"rpkg\"\nversion = \"1.0.0\"\n",
        );
        write_file(&ch.join("registry/index/custom-1/.git/config"), cfg_bytes);
        let rep = resolve_one(&r_cust, &ch, "rpkg", None, None).unwrap();
        assert_eq!(rep.matches[0].status, expect_status, "tag={tag}");
    }

    let r_cio = tmp.path().join("r_cio_ws");
    write_file(
        &r_cio.join("Cargo.lock"),
        make_lock(
            "rpkg",
            "1.0.0",
            Some("registry+https://github.com/rust-lang/crates.io-index"),
        ),
    );
    let ch_reg_ws = tmp.path().join("ch_reg_ws");
    write_file(
        &ch_reg_ws.join("registry/src/index.crates.io-1/Cargo.toml"),
        "[workspace]\nmembers = [\n",
    );
    write_file(
        &ch_reg_ws.join("registry/src/index.crates.io-1/rpkg-1.0.0/Cargo.toml"),
        "[package]\nname = \"rpkg\"\nversion.workspace = true\n",
    );
    let rep_reg_ws = resolve_one(&r_cio, &ch_reg_ws, "rpkg", None, None).unwrap();
    assert_eq!(rep_reg_ws.matches[0].status, ResolutionStatus::Unresolved);
}
