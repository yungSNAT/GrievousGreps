//! Edge-case regressions for `crate-source`: strict registry URL syntax and
//! case-sensitive `.git` suffix stripping, fail-closed nearer workspace manifest
//! parse errors, git metadata cap+1 budget propagation and O(N) multiline quote
//! run validation.

use std::fs;
use std::path::Path;
use std::time::Instant;

use serde_json::Value;
use snapbox::cmd::{Command, cargo_bin};
use tempfile::tempdir;

fn run_crate_source_json(crate_name: &str, repo: &Path, cargo_home: &Path) -> (bool, Value) {
    let out = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", crate_name])
        .arg(repo)
        .args(["--cargo-home"])
        .arg(cargo_home)
        .arg("--json")
        .output()
        .unwrap();
    let json: Value = serde_json::from_slice(&out.stdout).unwrap();
    (out.status.success(), json)
}

fn seed_registry_cache(cargo_home: &Path, dir_tag: &str, pkg_name: &str, origin_url: &str) {
    let src_dir = cargo_home
        .join("registry/src")
        .join(dir_tag)
        .join(format!("{pkg_name}-1.0.0"));
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        src_dir.join("Cargo.toml"),
        format!("[package]\nname = \"{pkg_name}\"\nversion = \"1.0.0\"\n"),
    )
    .unwrap();
    let idx_git = cargo_home.join("registry/index").join(dir_tag).join(".git");
    fs::create_dir_all(&idx_git).unwrap();
    fs::write(
        idx_git.join("config"),
        format!("[remote \"origin\"]\n\turl = {origin_url}\n"),
    )
    .unwrap();
}

#[test]
fn malformed_registry_authorities_and_uppercase_git_suffix_rejected() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let ch_present = tmp.path().join("cargo-present");
    let ch_absent = tmp.path().join("cargo-absent");
    fs::create_dir_all(&repo).unwrap();

    for (dir_tag, pkg_name, url) in [
        ("bad-empty-host-1", "emptyhost", "https://:443/index"),
        ("bad-space-host-1", "spacehost", "https://bad host/index"),
        ("bad-ipv6-host-1", "badipv6", "https://[:::]/index"),
        (
            "reg.example.com-case",
            "casepkg",
            "https://reg.example.com/team-a/index.GIT",
        ),
        (
            "reg.example.com-dot",
            "dotpkg",
            "https://reg.example.com/index",
        ),
    ] {
        seed_registry_cache(&ch_present, dir_tag, pkg_name, url);
    }
    let case_git = ch_present.join("registry/index/reg.example.com-case/.git");

    fs::write(
        repo.join("Cargo.lock"),
        r#"version = 4
[[package]]
name = "emptyhost"
version = "1.0.0"
source = "registry+https://:443/index"

[[package]]
name = "spacehost"
version = "1.0.0"
source = "registry+https://bad host/index"

[[package]]
name = "badipv6"
version = "1.0.0"
source = "registry+https://[:::]/index"

[[package]]
name = "casepkg"
version = "1.0.0"
source = "registry+https://reg.example.com/team-a/index"

[[package]]
name = "dotpkg"
version = "1.0.0"
source = "registry+https://reg.example.com/team/../index"
"#,
    )
    .unwrap();

    // Malformed authorities (including invalid IPv6 [:::]) must return unresolved with no path
    for ch in [&ch_present, &ch_absent] {
        for name in ["emptyhost", "spacehost", "badipv6"] {
            let (ok, json) = run_crate_source_json(name, &repo, ch);
            assert!(!ok);
            assert_eq!(json["matches"][0]["status"], "unresolved");
            assert!(json["matches"][0].get("path").is_none());
        }
    }

    // Raw path comparison: /team/../index != /index
    let (dot_ok, dot_json) = run_crate_source_json("dotpkg", &repo, &ch_present);
    assert!(!dot_ok);
    assert_eq!(dot_json["matches"][0]["status"], "not_cached");

    // Uppercase .GIT suffix is NOT stripped -> mismatch -> not_cached
    let (upper_ok, upper_json) = run_crate_source_json("casepkg", &repo, &ch_present);
    assert!(!upper_ok);
    assert_eq!(upper_json["matches"][0]["status"], "not_cached");

    // Lowercase .git suffix IS stripped -> found
    fs::write(
        case_git.join("config"),
        "[remote \"origin\"]\n\turl = https://reg.example.com/team-a/index.git\n",
    )
    .unwrap();
    let (lower_ok, lower_json) = run_crate_source_json("casepkg", &repo, &ch_present);
    assert!(lower_ok);
    assert_eq!(lower_json["matches"][0]["status"], "found");
}

#[test]
fn nearer_unparseable_workspace_manifest_blocks_farther_workspace_version() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let ch = tmp.path().join("cargo");
    let member = repo.join("sub/crates/ws-member");
    fs::create_dir_all(&member).unwrap();

    // Valid farther ancestor workspace Cargo.toml
    fs::write(
        repo.join("Cargo.toml"),
        "[workspace]\nmembers = [\"sub/crates/ws-member\"]\n[workspace.package]\nversion = \"2.3.4\"\n",
    )
    .unwrap();
    // Nearer malformed / unterminated workspace Cargo.toml
    fs::write(
        repo.join("sub/Cargo.toml"),
        "[workspace]\ndescription = \"\"\"\nunterminated multiline\n",
    )
    .unwrap();
    fs::write(
        member.join("Cargo.toml"),
        "[package]\nname = \"ws-member\"\nversion.workspace = true\n",
    )
    .unwrap();
    fs::write(
        repo.join("Cargo.lock"),
        "version = 4\n[[package]]\nname = \"ws-member\"\nversion = \"2.3.4\"\n",
    )
    .unwrap();

    let (ok, json) = run_crate_source_json("ws-member", &repo, &ch);
    assert!(!ok);
    assert_eq!(json["matches"][0]["status"], "unresolved");
    assert!(json["matches"][0].get("path").is_none());

    // Also reject a nearer workspace Cargo.toml with an illegal 6-quote multiline run
    fs::write(
        repo.join("sub/Cargo.toml"),
        "[workspace]\ndescription = \"\"\"bad\"\"\"\"\"\"\n",
    )
    .unwrap();
    let (ok2, json2) = run_crate_source_json("ws-member", &repo, &ch);
    assert!(!ok2);
    assert_eq!(json2["matches"][0]["status"], "unresolved");
    assert!(json2["matches"][0].get("path").is_none());

    // Also reject a nearer workspace Cargo.toml with unterminated array syntax (`members = [`)
    fs::write(repo.join("sub/Cargo.toml"), "[workspace]\nmembers = [\n").unwrap();
    let (ok3, json3) = run_crate_source_json("ws-member", &repo, &ch);
    assert!(!ok3);
    assert_eq!(json3["matches"][0]["status"], "unresolved");
    assert!(json3["matches"][0].get("path").is_none());

    // Also reject balanced malformed array syntax (missing comma between elements)
    fs::write(
        repo.join("sub/Cargo.toml"),
        "[workspace]\nmembers = [\"crates/ws-member\" \"other\"]\n",
    )
    .unwrap();
    let (ok_comma, json_comma) = run_crate_source_json("ws-member", &repo, &ch);
    assert!(!ok_comma);
    assert_eq!(json_comma["matches"][0]["status"], "unresolved");
    assert!(json_comma["matches"][0].get("path").is_none());

    // Also reject a dangling symlink at nearer sub/Cargo.toml (never walk past to farther ancestor)
    #[cfg(unix)]
    {
        fs::remove_file(repo.join("sub/Cargo.toml")).unwrap();
        std::os::unix::fs::symlink(
            repo.join("sub/does-not-exist.toml"),
            repo.join("sub/Cargo.toml"),
        )
        .unwrap();
        let (ok4, json4) = run_crate_source_json("ws-member", &repo, &ch);
        assert!(!ok4);
        assert_eq!(json4["matches"][0]["status"], "unresolved");
        assert!(json4["matches"][0].get("path").is_none());
    }
}

#[test]
fn unverified_git_checkout_workspace_parse_error_does_not_fall_through_to_other_checkout() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let ch = tmp.path().join("cargo");
    let sha = "abcdef1234567890abcdef1234567890abcdef12";
    fs::create_dir_all(&repo).unwrap();
    fs::write(
        repo.join("Cargo.lock"),
        format!(
            "version = 4\n[[package]]\nname = \"mix-git\"\nversion = \"0.1.0\"\nsource = \"git+https://example.com/mix-git#{sha}\"\n"
        ),
    )
    .unwrap();

    // First checkout (sorted first): unverified (no .git/HEAD) with broken workspace Cargo.toml
    let bad_rev = ch.join("git/checkouts/mix-git-aaa/abcdef1");
    fs::create_dir_all(bad_rev.join("crates/mix-git")).unwrap();
    fs::write(bad_rev.join("Cargo.toml"), "[workspace]\nmembers = [\n").unwrap();
    fs::write(
        bad_rev.join("crates/mix-git/Cargo.toml"),
        "[package]\nname = \"mix-git\"\nversion.workspace = true\n",
    )
    .unwrap();

    // Second checkout (sorted second): fully valid verified checkout
    let good_rev = ch.join("git/checkouts/mix-git-bbb/abcdef1");
    fs::create_dir_all(good_rev.join(".git")).unwrap();
    fs::write(good_rev.join(".git/HEAD"), format!("{sha}\n")).unwrap();
    fs::write(
        good_rev.join(".git/config"),
        "[remote \"origin\"]\n\turl = https://example.com/mix-git\n",
    )
    .unwrap();
    fs::write(
        good_rev.join("Cargo.toml"),
        "[package]\nname = \"mix-git\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();

    let (ok, json) = run_crate_source_json("mix-git", &repo, &ch);
    assert!(!ok);
    assert_eq!(json["matches"][0]["status"], "unresolved");
    assert!(json["matches"][0].get("path").is_none());
}

#[test]
fn git_metadata_cap_plus_one_returns_budget_exhausted_even_with_vcs_info() {
    let sha = "abcdef1234567890abcdef1234567890abcdef12";
    let vcs_json = format!("{{\"git\":{{\"sha1\":\"{sha}\"}}}}");
    let big = "a".repeat(4097);

    for case in ["git_pointer", "git_head", "loose_ref"] {
        let tmp = tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let ch = tmp.path().join("cargo");
        fs::create_dir_all(&repo).unwrap();
        fs::write(
            repo.join("Cargo.lock"),
            format!(
                "version = 4\n[[package]]\nname = \"cap-git\"\nversion = \"0.1.0\"\nsource = \"git+https://example.com/cap-git#{sha}\"\n"
            ),
        )
        .unwrap();

        let rev_dir = ch.join("git/checkouts/cap-git-111/abcdef1");
        fs::create_dir_all(&rev_dir).unwrap();
        fs::write(
            rev_dir.join("Cargo.toml"),
            "[package]\nname = \"cap-git\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        fs::write(rev_dir.join(".cargo-vcs-info.json"), &vcs_json).unwrap();

        match case {
            "git_pointer" => {
                fs::write(rev_dir.join(".git"), format!("gitdir: {big}")).unwrap();
            }
            "git_head" => {
                fs::create_dir_all(rev_dir.join(".git")).unwrap();
                fs::write(rev_dir.join(".git/HEAD"), &big).unwrap();
            }
            "loose_ref" => {
                fs::create_dir_all(rev_dir.join(".git/refs/heads")).unwrap();
                fs::write(rev_dir.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
                fs::write(rev_dir.join(".git/refs/heads/main"), &big).unwrap();
            }
            _ => unreachable!(),
        }

        let (ok, json) = run_crate_source_json("cap-git", &repo, &ch);
        assert!(!ok, "case {case} should fail");
        assert_eq!(
            json["matches"][0]["status"], "budget_exhausted",
            "case {case} must propagate budget_exhausted instead of falling back"
        );
    }
}

#[test]
fn multiline_quote_runs_accept_3_4_5_and_reject_6_plus_in_linear_time() {
    let tmp = tempdir().unwrap();
    let ch = tmp.path().join("cargo");

    // Valid 3, 4 and 5 quote endings for both """ and '''
    for (idx, desc) in [
        ("\"\"\"ok\"\"\"", 0),
        ("\"\"\"ok\"\"\"\"", 1),
        ("\"\"\"ok\"\"\"\"\"", 2),
        ("'''ok'''", 3),
        ("'''ok''''", 4),
        ("'''ok'''''", 5),
    ] {
        let repo = tmp.path().join(format!("valid-{desc}"));
        let crate_dir = repo.join("crates/qok");
        fs::create_dir_all(&crate_dir).unwrap();
        fs::write(
            crate_dir.join("Cargo.toml"),
            format!("[package]\nname = \"qok\"\ndescription = {idx}\nversion = \"1.0.0\"\n"),
        )
        .unwrap();
        fs::write(
            repo.join("Cargo.lock"),
            "version = 4\n[[package]]\nname = \"qok\"\nversion = \"1.0.0\"\n",
        )
        .unwrap();
        let (ok, json) = run_crate_source_json("qok", &repo, &ch);
        assert!(ok, "valid ending {desc} should resolve found");
        assert_eq!(json["matches"][0]["status"], "found");
    }

    // Rejected 6-quote runs and large 200 KiB quote runs for both """ and ''' (O(N) bounded time)
    let big_double = format!("\"\"\"{}\"\"\"", "\"".repeat(200 * 1024));
    let big_single = format!("'''{}'''", "'".repeat(200 * 1024));
    for (label, desc) in [
        ("six-double", "\"\"\"bad\"\"\"\"\"\"".to_string()),
        ("six-single", "'''bad''''''".to_string()),
        ("big-double", big_double),
        ("big-single", big_single),
    ] {
        let repo = tmp.path().join(format!("bad-{label}"));
        let crate_dir = repo.join("crates/qbad");
        fs::create_dir_all(&crate_dir).unwrap();
        fs::write(
            crate_dir.join("Cargo.toml"),
            format!("[package]\nname = \"qbad\"\ndescription = {desc}\nversion = \"1.0.0\"\n"),
        )
        .unwrap();
        fs::write(
            repo.join("Cargo.lock"),
            "version = 4\n[[package]]\nname = \"qbad\"\nversion = \"1.0.0\"\n",
        )
        .unwrap();
        let start = Instant::now();
        let (ok, json) = run_crate_source_json("qbad", &repo, &ch);
        assert!(
            start.elapsed().as_secs() < 5,
            "{label} took too long: {:?}",
            start.elapsed()
        );
        assert!(!ok, "{label} must fail closed");
        assert_eq!(json["matches"][0]["status"], "not_cached");
    }
}
