//! Manifest TOML syntax validation regressions: distinct `[table]` vs
//! `[[array]]` headers, strict array/inline-table/duplicate-key rejection and
//! nesting depth boundary (256 valid vs 257 `budget_exhausted`).

use std::fs;
use std::path::Path;

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

#[test]
fn array_of_tables_headers_never_spoof_package_or_workspace_identity_whilst_bin_and_example_work() {
    let tmp = tempdir().unwrap();
    let ch = tmp.path().join("cargo");

    // Negative: [[package]] must NOT match [package] identity
    let repo_arr_pkg = tmp.path().join("arr-pkg");
    fs::create_dir_all(repo_arr_pkg.join("crates/fake")).unwrap();
    fs::write(
        repo_arr_pkg.join("crates/fake/Cargo.toml"),
        "[[package]]\nname = \"fake\"\nversion = \"1.0.0\"\n",
    )
    .unwrap();
    fs::write(
        repo_arr_pkg.join("Cargo.lock"),
        "version = 4\n[[package]]\nname = \"fake\"\nversion = \"1.0.0\"\n",
    )
    .unwrap();
    let (ok1, j1) = run_crate_source_json("fake", &repo_arr_pkg, &ch);
    assert!(!ok1);
    assert_eq!(j1["matches"][0]["status"], "not_cached");

    // Negative: [[workspace.package]] must NOT supply [workspace.package].version
    let repo_arr_ws = tmp.path().join("arr-ws");
    fs::create_dir_all(repo_arr_ws.join("crates/wsfake")).unwrap();
    fs::write(
        repo_arr_ws.join("Cargo.toml"),
        "[workspace]\nmembers = [\"crates/wsfake\"]\n[[workspace.package]]\nversion = \"2.0.0\"\n",
    )
    .unwrap();
    fs::write(
        repo_arr_ws.join("crates/wsfake/Cargo.toml"),
        "[package]\nname = \"wsfake\"\nversion.workspace = true\n",
    )
    .unwrap();
    fs::write(
        repo_arr_ws.join("Cargo.lock"),
        "version = 4\n[[package]]\nname = \"wsfake\"\nversion = \"2.0.0\"\n",
    )
    .unwrap();
    let (ok2, j2) = run_crate_source_json("wsfake", &repo_arr_ws, &ch);
    assert!(!ok2);
    assert_eq!(j2["matches"][0]["status"], "not_cached");

    // Positive: legitimate [[bin]] and [[example]] tables alongside [package] & [workspace.package]
    let repo_ok = tmp.path().join("valid-bin-example");
    fs::create_dir_all(repo_ok.join("crates/real")).unwrap();
    fs::write(
        repo_ok.join("Cargo.toml"),
        "[workspace]\nmembers = [\"crates/real\"]\n[workspace.package]\nversion = \"3.1.0\"\n",
    )
    .unwrap();
    fs::write(
        repo_ok.join("crates/real/Cargo.toml"),
        "[package]\nname = \"real\"\nversion.workspace = true\n\n[[bin]]\nname = \"real-cli\"\npath = \"src/main.rs\"\n\n[[example]]\nname = \"demo\"\npath = \"examples/demo.rs\"\n",
    )
    .unwrap();
    fs::write(
        repo_ok.join("Cargo.lock"),
        "version = 4\n[[package]]\nname = \"real\"\nversion = \"3.1.0\"\n",
    )
    .unwrap();
    let (ok3, j3) = run_crate_source_json("real", &repo_ok, &ch);
    assert!(ok3);
    assert_eq!(j3["matches"][0]["status"], "found");
}

#[test]
fn manifest_nesting_depth_256_valid_and_257_returns_budget_exhausted_even_with_second_candidate() {
    let tmp = tempdir().unwrap();
    let ch = tmp.path().join("cargo");

    // Depth 256 is valid -> found
    let repo_256 = tmp.path().join("depth-256");
    fs::create_dir_all(repo_256.join("crates/deep")).unwrap();
    let arr_256 = format!("{}1{}", "[".repeat(256), "]".repeat(256));
    fs::write(
        repo_256.join("crates/deep/Cargo.toml"),
        format!(
            "[package]\nname = \"deep\"\nversion = \"1.0.0\"\n[package.metadata]\nx = {arr_256}\n"
        ),
    )
    .unwrap();
    fs::write(
        repo_256.join("Cargo.lock"),
        "version = 4\n[[package]]\nname = \"deep\"\nversion = \"1.0.0\"\n",
    )
    .unwrap();
    let (ok_256, j_256) = run_crate_source_json("deep", &repo_256, &ch);
    assert!(ok_256);
    assert_eq!(j_256["matches"][0]["status"], "found");

    // Depth 257 (single candidate) -> budget_exhausted with no path
    let repo_257 = tmp.path().join("depth-257");
    fs::create_dir_all(repo_257.join("crates/deep")).unwrap();
    let arr_257 = format!("{}1{}", "[".repeat(257), "]".repeat(257));
    fs::write(
        repo_257.join("crates/deep/Cargo.toml"),
        format!(
            "[package]\nname = \"deep\"\nversion = \"1.0.0\"\n[package.metadata]\nx = {arr_257}\n"
        ),
    )
    .unwrap();
    fs::write(
        repo_257.join("Cargo.lock"),
        "version = 4\n[[package]]\nname = \"deep\"\nversion = \"1.0.0\"\n",
    )
    .unwrap();
    let (ok_257, j_257) = run_crate_source_json("deep", &repo_257, &ch);
    assert!(!ok_257);
    assert_eq!(j_257["matches"][0]["status"], "budget_exhausted");
    assert!(j_257["matches"][0].get("path").is_none());

    // Depth 257 with a second valid candidate -> still budget_exhausted with no path
    fs::create_dir_all(repo_257.join("crates/aaa-valid")).unwrap();
    fs::write(
        repo_257.join("crates/aaa-valid/Cargo.toml"),
        "[package]\nname = \"deep\"\nversion = \"1.0.0\"\n",
    )
    .unwrap();
    let (ok_two, j_two) = run_crate_source_json("deep", &repo_257, &ch);
    assert!(!ok_two);
    assert_eq!(j_two["matches"][0]["status"], "budget_exhausted");
    assert!(j_two["matches"][0].get("path").is_none());
}

#[test]
fn duplicate_keys_invalid_escapes_and_bad_inline_tables_in_nearer_workspace_fail_closed() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let ch = tmp.path().join("cargo");
    let member = repo.join("sub/crates/ws-member");
    fs::create_dir_all(&member).unwrap();

    fs::write(
        repo.join("Cargo.toml"),
        "[workspace]\nmembers = [\"sub/crates/ws-member\"]\n[workspace.package]\nversion = \"2.3.4\"\n",
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

    for bad_ws in [
        "[workspace]\nresolver = \"2\"\nresolver = \"3\"\n",
        "[workspace]\ndesc = \"bad \\q escape\"\n",
        "[workspace]\nmeta = { a = 1, }\n",
        "[workspace]\nmeta = { a = 1\nb = 2 }\n",
        "[workspace]\nmembers = [\"a\" \"b\"]\n",
    ] {
        fs::write(repo.join("sub/Cargo.toml"), bad_ws).unwrap();
        let (ok, json) = run_crate_source_json("ws-member", &repo, &ch);
        assert!(!ok, "malformed workspace must fail closed: {bad_ws}");
        assert_eq!(json["matches"][0]["status"], "unresolved");
        assert!(json["matches"][0].get("path").is_none());
    }
}
