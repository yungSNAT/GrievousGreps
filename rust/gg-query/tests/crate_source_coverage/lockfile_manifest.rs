//! Lockfile discovery, lockfile TOML syntax and manifest workspace-version tests.

use std::fs;
use std::path::Path;

use gg_query::crate_source::ResolutionStatus;

#[cfg(unix)]
use crate::ModeGuard;
use crate::{make_lock, resolve_one, status_of, write_file};

#[test]
fn discovers_explicit_lockfiles_and_rejects_escaped_or_directory_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let ch = tmp.path().join("cargo_home");
    fs::create_dir_all(&ch).unwrap();

    let repo = tmp.path().join("repo");
    let sub_lock = repo.join("sub/Cargo.lock");
    write_file(&sub_lock, make_lock("demo", "1.0.0", None));
    write_file(
        &repo.join("sub/Cargo.toml"),
        "[package]\nname = \"demo\"\nversion = \"1.0.0\"\n",
    );

    let r_rel = resolve_one(&repo, &ch, "demo", None, Some(Path::new("sub/Cargo.lock"))).unwrap();
    assert_eq!(r_rel.matches[0].status, ResolutionStatus::Found);
    assert_eq!(r_rel.matches[0].lockfile, "sub/Cargo.lock");

    let abs_lock = fs::canonicalize(&sub_lock).unwrap();
    let r_abs = resolve_one(&repo, &ch, "demo", None, Some(&abs_lock)).unwrap();
    assert_eq!(r_abs.matches[0].status, ResolutionStatus::Found);

    let esc = resolve_one(&repo, &ch, "demo", None, Some(Path::new("../outside.lock")));
    assert!(esc.unwrap_err().contains("missing or escapes"));
    let dir = resolve_one(&repo, &ch, "demo", None, Some(Path::new("sub")));
    assert!(dir.unwrap_err().contains("not a regular file"));
}

#[test]
fn auto_scans_lockfiles_enforcing_skip_dirs_depth_and_symlinks() {
    let tmp = tempfile::tempdir().unwrap();
    let ch = tmp.path().join("cargo_home");
    fs::create_dir_all(&ch).unwrap();

    let repo = tmp.path().join("repo");
    write_file(
        &repo.join("sub/Cargo.lock"),
        make_lock("demo", "1.0.0", None),
    );
    write_file(
        &repo.join("sub/Cargo.toml"),
        "[package]\nname = \"demo\"\nversion = \"1.0.0\"\n",
    );
    write_file(&repo.join("README.md"), "hi\n");
    write_file(
        &repo.join("target/Cargo.lock"),
        make_lock("skip", "1.0.0", None),
    );
    write_file(
        &repo.join("a/b/c/Cargo.lock"),
        make_lock("deep", "1.0.0", None),
    );
    #[cfg(unix)]
    let _guard = {
        use std::os::unix::fs::{PermissionsExt, symlink};
        symlink(repo.join("target"), repo.join("sym_sub")).unwrap();
        let blocked = repo.join("unreadable");
        fs::create_dir(&blocked).unwrap();
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o000)).unwrap();
        ModeGuard {
            path: blocked,
            mode: 0o755,
        }
    };

    let r_scan = resolve_one(&repo, &ch, "demo", None, None).unwrap();
    assert_eq!(r_scan.matches.len(), 1);
    assert_eq!(r_scan.matches[0].status, ResolutionStatus::Found);
    assert!(
        resolve_one(&repo, &ch, "skip", None, None)
            .unwrap_err()
            .contains("not found")
    );
    assert!(
        resolve_one(&repo, &ch, "deep", None, None)
            .unwrap_err()
            .contains("not found")
    );
}

#[test]
fn rejects_empty_repo_and_oversized_lockfile_scan() {
    let tmp = tempfile::tempdir().unwrap();
    let ch = tmp.path().join("cargo_home");
    fs::create_dir_all(&ch).unwrap();

    let empty = tmp.path().join("empty");
    fs::create_dir_all(&empty).unwrap();
    let err_empty = resolve_one(&empty, &ch, "demo", None, None).unwrap_err();
    assert!(err_empty.contains("no Cargo.lock found"));

    let big = tmp.path().join("big");
    fs::create_dir_all(&big).unwrap();
    for i in 0..515 {
        write_file(&big.join(format!("f{i:04}")), "");
    }
    let err_big = resolve_one(&big, &ch, "demo", None, None).unwrap_err();
    assert!(err_big.contains("lockfile scan budget exceeded"));
}

#[test]
fn parses_lockfile_literal_strings_arrays_metadata_headers_and_bad_keys() {
    let tmp = tempfile::tempdir().unwrap();
    let ch = tmp.path().join("cargo_home");
    fs::create_dir_all(&ch).unwrap();

    let repo = tmp.path().join("syntax_repo");
    write_file(
        &repo.join("Cargo.lock"),
        concat!(
            "version = 3\n\n[[package]]\n",
            "name = 'litpkg' # literal string comment\n",
            "version = '1.2.3'\n",
            "dependencies = [\n  \"quoted \\\"[nested]\\\"\",\n  'single [bracket]',\n]\n",
            "bare_line_without_equals\n\n",
            "[metadata]\n\"checksum litpkg 1.2.3\" = \"abc\"\n",
        ),
    );
    let rep = resolve_one(&repo, &ch, "litpkg", None, None).unwrap();
    assert_eq!(rep.matches[0].version, "1.2.3");

    let bad_empty = tmp.path().join("bad_empty");
    write_file(&bad_empty.join("Cargo.lock"), "[[package]]\n= \"val\"\n");
    assert!(
        resolve_one(&bad_empty, &ch, "demo", None, None)
            .unwrap_err()
            .contains("empty key")
    );

    let bad_trail = tmp.path().join("bad_trail");
    write_file(
        &bad_trail.join("Cargo.lock"),
        "[[package]]\nname extra = \"val\"\n",
    );
    assert!(
        resolve_one(&bad_trail, &ch, "demo", None, None)
            .unwrap_err()
            .contains("invalid TOML key")
    );
}

#[test]
fn resolves_inline_workspace_version_and_ignores_malformed_sibling_manifests() {
    let tmp = tempfile::tempdir().unwrap();
    let ch = tmp.path().join("cargo_home");
    fs::create_dir_all(&ch).unwrap();

    let repo = tmp.path().join("repo");
    let lock = "version = 4\n\n[[package]]\nname = \"mem\"\nversion = \"1.2.3\"\n\n[[package]]\nname = \"123\"\nversion = \"1.2.3\"\n";
    write_file(&repo.join("Cargo.lock"), lock);
    write_file(
        &repo.join("Cargo.toml"),
        "workspace = { package = { version = \"1.2.3\" } }\n",
    );
    write_file(
        &repo.join("crates/mem/Cargo.toml"),
        "[package]\nname = \"mem\"\nversion = { workspace = true }\n",
    );
    for (dir, body) in [
        ("bad1", "[package]\nname = 123\nversion = \"1.2.3\"\n"),
        (
            "bad2",
            "[package]\nname = \"mem\"\nversion = { workspace = false }\n",
        ),
        ("bad3", "[package]\nname = \"mem\"\nversion = 42\n"),
        (
            "bad4",
            "[package]\nname = \"mem\"\nversion.workspace = false\n",
        ),
        ("bad5", "[package]\nname = \"mem\"\n"),
    ] {
        write_file(&repo.join(format!("crates/{dir}/Cargo.toml")), body);
    }
    #[cfg(unix)]
    let _guard = {
        use std::os::unix::fs::PermissionsExt;
        let blocked = repo.join("crates/unreadable_dir");
        fs::create_dir_all(&blocked).unwrap();
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o000)).unwrap();
        ModeGuard {
            path: blocked,
            mode: 0o755,
        }
    };

    assert_eq!(status_of(&repo, &ch, "mem"), ResolutionStatus::Found);
    assert_eq!(status_of(&repo, &ch, "123"), ResolutionStatus::NotCached);
}

#[test]
fn handles_missing_inline_workspace_version_and_oversized_workspace_manifest() {
    let tmp = tempfile::tempdir().unwrap();
    let ch = tmp.path().join("cargo_home");
    fs::create_dir_all(&ch).unwrap();

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
    assert_eq!(
        status_of(&repo_no_ver, &ch, "mem"),
        ResolutionStatus::NotCached
    );

    let repo_huge = tmp.path().join("repo_huge");
    write_file(
        &repo_huge.join("crates/mem/Cargo.lock"),
        make_lock("mem", "1.2.3", None),
    );
    write_file(&repo_huge.join("Cargo.toml"), "a".repeat(260 * 1024));
    write_file(
        &repo_huge.join("crates/mem/Cargo.toml"),
        "[package]\nname = \"mem\"\nversion.workspace = true\n",
    );
    let rep = resolve_one(
        &repo_huge,
        &ch,
        "mem",
        None,
        Some(Path::new("crates/mem/Cargo.lock")),
    )
    .unwrap();
    assert_eq!(rep.matches[0].status, ResolutionStatus::BudgetExhausted);
}
