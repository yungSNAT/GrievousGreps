//! Additional hardening regressions covering registry full-URL verification,
//! multiline manifest strings, git origin preservation across SHA fallback,
//! quoted lockfile keys, partial-scan budget exhaustion, FIFO rejection and
//! lexical cargo-home normalisation.

use std::fs;
use std::path::Path;

use serde_json::Value;
use snapbox::cmd::{Command, cargo_bin};
use tempfile::tempdir;

#[test]
fn registry_requires_verified_full_url_and_rejects_same_host_different_path_or_malformed_url() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let ch = tmp.path().join("cargo");
    fs::create_dir_all(&repo).unwrap();

    // Custom registry cache for team-b/index, queried as team-a/index (same host, different path)
    let src_dir = ch.join("registry/src/reg.example.com-abc/priv-1.0.0");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        src_dir.join("Cargo.toml"),
        "[package]\nname = \"priv\"\nversion = \"1.0.0\"\n",
    )
    .unwrap();
    let idx_git = ch.join("registry/index/reg.example.com-abc/.git");
    fs::create_dir_all(&idx_git).unwrap();
    fs::write(
        idx_git.join("config"),
        "[remote \"origin\"]\n\turl = https://reg.example.com/team-b/index\n",
    )
    .unwrap();

    // Another custom registry dir WITHOUT registry/index/<dir>/.git/config (unverifiable)
    let unv_dir = ch.join("registry/src/reg.example.com-unv/unv-1.0.0");
    fs::create_dir_all(&unv_dir).unwrap();
    fs::write(
        unv_dir.join("Cargo.toml"),
        "[package]\nname = \"unv\"\nversion = \"1.0.0\"\n",
    )
    .unwrap();

    fs::write(
        repo.join("Cargo.lock"),
        r#"version = 4
[[package]]
name = "priv"
version = "1.0.0"
source = "registry+https://reg.example.com/team-a/index"

[[package]]
name = "unv"
version = "1.0.0"
source = "registry+https://reg.example.com/team-a/index"

[[package]]
name = "badurl"
version = "1.0.0"
source = "registry+not-a-url"
"#,
    )
    .unwrap();

    // team-a vs team-b mismatch -> not_cached (never found)
    let mm = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "priv"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(&ch)
        .arg("--json")
        .output()
        .unwrap();
    assert!(!mm.status.success());
    let mm_json: Value = serde_json::from_slice(&mm.stdout).unwrap();
    assert_eq!(mm_json["matches"][0]["status"], "not_cached");
    assert!(mm_json["matches"][0].get("path").is_none());

    // Unverifiable custom registry dir -> unresolved (never found)
    let unv = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "unv"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(&ch)
        .arg("--json")
        .output()
        .unwrap();
    assert!(!unv.status.success());
    let unv_json: Value = serde_json::from_slice(&unv.stdout).unwrap();
    assert_eq!(unv_json["matches"][0]["status"], "unresolved");
    assert!(unv_json["matches"][0].get("path").is_none());

    // Malformed registry URL -> unresolved with no path
    let bad = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "badurl"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(&ch)
        .arg("--json")
        .output()
        .unwrap();
    assert!(!bad.status.success());
    let bad_json: Value = serde_json::from_slice(&bad.stdout).unwrap();
    assert_eq!(bad_json["matches"][0]["status"], "unresolved");
    assert!(bad_json["matches"][0].get("path").is_none());

    // Now update index config to matching team-a/index -> verified found!
    fs::write(
        idx_git.join("config"),
        "[remote \"origin\"]\n\turl = https://reg.example.com/team-a/index.git\n",
    )
    .unwrap();
    let ok = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "priv"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(&ch)
        .arg("--json")
        .output()
        .unwrap();
    assert!(
        ok.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&ok.stderr)
    );
    let ok_json: Value = serde_json::from_slice(&ok.stdout).unwrap();
    assert_eq!(ok_json["matches"][0]["status"], "found");
}

#[test]
fn manifest_multiline_strings_quoted_keys_and_git_origin_preservation() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let ch = tmp.path().join("cargo");
    fs::create_dir_all(repo.join("crates/tricky")).unwrap();
    // Multiline description contains fake `version = "1.0.0"` whilst real version is 9.9.9
    fs::write(
        repo.join("crates/tricky/Cargo.toml"),
        "[package]\nname = \"tricky\"\nversion = \"9.9.9\"\ndescription = \"\"\"\nversion = \"1.0.0\"\n[other]\n\"\"\"\n",
    )
    .unwrap();

    // Git checkout with conflicting .git/config origin, broken HEAD, and matching .cargo-vcs-info.json
    let git_dir = ch.join("git/checkouts/same-slug-999/abcdef1");
    fs::create_dir_all(git_dir.join(".git")).unwrap();
    fs::write(
        git_dir.join(".git/config"),
        "[remote \"origin\"]\n\turl = https://evil.example.com/same-slug\n",
    )
    .unwrap();
    fs::write(git_dir.join(".git/HEAD"), "ref: refs/heads/missing\n").unwrap();
    fs::write(
        git_dir.join(".cargo-vcs-info.json"),
        "{\"git\":{\"sha1\":\"abcdef1234567890abcdef1234567890abcdef12\"}}",
    )
    .unwrap();
    fs::write(
        git_dir.join("Cargo.toml"),
        "[package]\nname = \"conflict-git\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();

    fs::write(
        repo.join("Cargo.lock"),
        r#"version = 4
[[package]]
name = "tricky"
version = "1.0.0"

[[package]]
name = "conflict-git"
version = "0.1.0"
source = "git+https://trusted.example.com/same-slug#abcdef1234567890abcdef1234567890abcdef12"
"#,
    )
    .unwrap();

    // Multiline string inside manifest must NOT spoof version 1.0.0
    let tr = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "tricky"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(&ch)
        .arg("--json")
        .output()
        .unwrap();
    assert!(!tr.status.success());
    let tr_json: Value = serde_json::from_slice(&tr.stdout).unwrap();
    assert_eq!(tr_json["matches"][0]["status"], "not_cached");

    // Conflicting .git/config origin MUST be retained across .cargo-vcs-info.json fallback
    let cg = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "conflict-git"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(&ch)
        .arg("--json")
        .output()
        .unwrap();
    assert!(!cg.status.success());
    let cg_json: Value = serde_json::from_slice(&cg.stdout).unwrap();
    assert_eq!(cg_json["matches"][0]["status"], "not_cached");

    // Quoted "source" = 42 in Cargo.lock must be decoded and rejected fail-closed
    let qrepo = tmp.path().join("quoted-key");
    fs::create_dir_all(&qrepo).unwrap();
    fs::write(
        qrepo.join("Cargo.lock"),
        "[[package]]\nname = \"a\"\nversion = \"1.0.0\"\n\"source\" = 42\n",
    )
    .unwrap();
    let qout = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "a"])
        .arg(&qrepo)
        .output()
        .unwrap();
    assert!(!qout.status.success());
}

#[test]
fn budget_exhausted_oversized_manifest_partial_lockfile_scan_and_lexical_cargo_home() {
    let tmp = tempdir().unwrap();

    // 1. Oversized manifest (>256 KiB) propagates budget_exhausted (not not_cached)
    let repo = tmp.path().join("big-manifest");
    let ch = tmp.path().join("cargo");
    let pkg_dir = ch.join("registry/src/index.crates.io-111/huge-1.0.0");
    fs::create_dir_all(&pkg_dir).unwrap();
    let pad = "#".repeat(270 * 1024);
    fs::write(
        pkg_dir.join("Cargo.toml"),
        format!("[package]\nname = \"huge\"\nversion = \"1.0.0\"\n{pad}\n"),
    )
    .unwrap();
    fs::create_dir_all(&repo).unwrap();
    fs::write(
        repo.join("Cargo.lock"),
        "version = 4\n[[package]]\nname = \"huge\"\nversion = \"1.0.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n",
    )
    .unwrap();

    // Also verify lexical normalisation of ./cargo and cache/../cargo
    let out = Command::new(cargo_bin!("gg-query"))
        .current_dir(tmp.path())
        .args(["crate-source", "huge"])
        .arg(&repo)
        .args(["--cargo-home", "cache/.././cargo", "--json"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    let json: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(json["matches"][0]["status"], "budget_exhausted");
    let expected_home = tmp.path().join("cargo");
    assert_eq!(
        Path::new(json["cargoHome"].as_str().unwrap()),
        expected_home
    );

    // 2. Partial lockfile scan exceeding >16 Cargo.lock files fails with budget error
    let many_locks = tmp.path().join("many-locks");
    for i in 0..18 {
        let sub = many_locks.join(format!("p{i:02}"));
        fs::create_dir_all(&sub).unwrap();
        fs::write(
            sub.join("Cargo.lock"),
            "version = 4\n[[package]]\nname = \"a\"\nversion = \"1.0.0\"\n",
        )
        .unwrap();
    }
    let ml = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "a"])
        .arg(&many_locks)
        .output()
        .unwrap();
    assert!(!ml.status.success());
    assert!(String::from_utf8_lossy(&ml.stderr).contains("budget exceeded"));
}

#[cfg(unix)]
#[test]
fn non_regular_fifo_manifest_fails_without_blocking() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path().join("fifo-repo");
    let crate_dir = repo.join("crates/fifo-pkg");
    fs::create_dir_all(&crate_dir).unwrap();
    fs::write(
        repo.join("Cargo.lock"),
        "version = 4\n[[package]]\nname = \"fifo-pkg\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    let fifo_path = crate_dir.join("Cargo.toml");
    let status = std::process::Command::new("mkfifo")
        .arg(&fifo_path)
        .status()
        .expect("mkfifo");
    assert!(status.success());

    let out = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "fifo-pkg"])
        .arg(&repo)
        .arg("--json")
        .output()
        .unwrap();
    assert!(!out.status.success());
    let json: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(json["matches"][0]["status"], "not_cached");
}

#[test]
fn exhausted_unverified_git_search_returns_budget_exhausted() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let ch = tmp.path().join("cargo");
    fs::create_dir_all(&repo).unwrap();
    let rev_dir = ch.join("git/checkouts/big-unv-1/1234567");
    fs::create_dir_all(&rev_dir).unwrap();
    for i in 0..520 {
        fs::create_dir_all(rev_dir.join(format!("d{i:03}"))).unwrap();
    }
    fs::write(
        repo.join("Cargo.lock"),
        "version = 4\n[[package]]\nname = \"big-unv\"\nversion = \"0.1.0\"\nsource = \"git+https://example.com/big-unv#1234567890abcdef1234567890abcdef12345678\"\n",
    )
    .unwrap();
    let out = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "big-unv"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(&ch)
        .arg("--json")
        .output()
        .unwrap();
    assert!(!out.status.success());
    let json: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(json["matches"][0]["status"], "budget_exhausted");
}
