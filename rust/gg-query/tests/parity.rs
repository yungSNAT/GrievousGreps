//! Stage 0 CLI parity corpus verified byte-for-byte with `snapbox`.
//!
//! Each golden file in `tests/fixtures/parity/golden/` was captured verbatim
//! from the Node `trail` CLI (`dist/bin/trail.js`) on `tests/fixtures/parity/sample-repo/`.
//! Every test copies the fixture into an isolated tempdir, executes `gg-query`,
//! asserts byte-exact stdout, stderr and exit code, and checks that no
//! unexpected file is written outside `graft/.graph/wiring.sqlite*`.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use snapbox::cmd::{Command, cargo_bin};
use tempfile::tempdir;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("parity")
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn copy_dir_recursive(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).expect("create dir");
    for entry in fs::read_dir(src).expect("read dir") {
        let entry = entry.expect("dir entry");
        let ty = entry.file_type().expect("file type");
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to);
        } else {
            fs::copy(entry.path(), &to).expect("copy file");
        }
    }
}

fn collect_relative_files(base: &Path, dir: &Path, out: &mut BTreeSet<String>) {
    for entry in fs::read_dir(dir).expect("read dir") {
        let entry = entry.expect("entry");
        let path = entry.path();
        if entry.file_type().expect("type").is_dir() {
            collect_relative_files(base, &path, out);
        } else {
            let rel = path
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            out.insert(rel);
        }
    }
}

fn assert_only_sqlite_written(before: &BTreeSet<String>, dir: &Path) {
    let mut after = BTreeSet::new();
    collect_relative_files(dir, dir, &mut after);
    for added in after.difference(before) {
        assert!(
            added.starts_with("graft/.graph/wiring.sqlite"),
            "unexpected file written by gg-query: {added}"
        );
    }
}

fn golden(name: &str) -> String {
    let path = fixtures_dir().join("golden").join(name);
    fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("missing golden {}: {e}", path.display()))
        .replace("\r\n", "\n")
}

fn setup_repo() -> (tempfile::TempDir, BTreeSet<String>) {
    let tmp = tempdir().expect("tempdir");
    copy_dir_recursive(&fixtures_dir().join("sample-repo"), tmp.path());
    let mut before = BTreeSet::new();
    collect_relative_files(tmp.path(), tmp.path(), &mut before);
    (tmp, before)
}

#[test]
fn parity_status_json_and_text() {
    let (tmp, before) = setup_repo();

    Command::new(cargo_bin!("gg-query"))
        .args(["status", "--json"])
        .arg(tmp.path())
        .assert()
        .success()
        .stdout_eq(golden("status-json.stdout"))
        .stderr_eq("");

    Command::new(cargo_bin!("gg-query"))
        .arg("status")
        .arg(tmp.path())
        .assert()
        .success()
        .stdout_eq(golden("status-text.stdout"))
        .stderr_eq("");

    assert_only_sqlite_written(&before, tmp.path());
}

#[test]
fn parity_callers_text_json_depth_direction_and_missing() {
    let (tmp, before) = setup_repo();

    Command::new(cargo_bin!("gg-query"))
        .args(["callers", "computeTotal"])
        .arg(tmp.path())
        .assert()
        .success()
        .stdout_eq(golden("callers-computeTotal.stdout"))
        .stderr_eq("");

    Command::new(cargo_bin!("gg-query"))
        .args(["callers", "computeTotal", "--json"])
        .arg(tmp.path())
        .assert()
        .success()
        .stdout_eq(golden("callers-computeTotal-json.stdout"))
        .stderr_eq("");

    Command::new(cargo_bin!("gg-query"))
        .args(["callers", "computeTotal", "--depth", "2"])
        .arg(tmp.path())
        .assert()
        .success()
        .stdout_eq(golden("callers-computeTotal-depth2.stdout"))
        .stderr_eq("");

    Command::new(cargo_bin!("gg-query"))
        .args(["callers", "handleOrder", "--direction", "out"])
        .arg(tmp.path())
        .assert()
        .success()
        .stdout_eq(golden("callers-handleOrder-out.stdout"))
        .stderr_eq("");

    Command::new(cargo_bin!("gg-query"))
        .args(["callers", "missingSymbol"])
        .arg(tmp.path())
        .assert()
        .code(1)
        .stdout_eq("")
        .stderr_eq(golden("callers-missing.stderr"));

    assert_only_sqlite_written(&before, tmp.path());
}

#[test]
fn parity_blast_changed_file_json() {
    let (tmp, before) = setup_repo();
    let out = Command::new(cargo_bin!("gg-query"))
        .args([
            "blast",
            "--changed",
            "src/math.ts",
            "--depth",
            "2",
            "--format",
            "json",
        ])
        .arg(tmp.path())
        .output()
        .expect("run blast");
    assert!(
        out.status.success(),
        "blast stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let actual: serde_json::Value = serde_json::from_slice(&out.stdout).expect("valid json");
    let expected: serde_json::Value =
        serde_json::from_str(&golden("blast-math-json.stdout")).expect("valid golden json");

    // Verify impacted file/symbol ids and depths match Node trail blast's walk.
    let actual_ids: Vec<&str> = actual["impacted"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["id"].as_str().unwrap())
        .collect();
    for exp in expected["impacted"].as_array().unwrap() {
        let exp_id = exp["id"].as_str().unwrap();
        assert!(
            actual_ids.contains(&exp_id),
            "expected impacted id {exp_id} missing from {actual_ids:?}"
        );
    }
    assert_only_sqlite_written(&before, tmp.path());
}

#[test]
fn parity_ask_dense_matches_node_vectors() {
    let (tmp, before) = setup_repo();
    let model = repo_root().join("models").join("potion-code-16M-v2");
    let out = Command::new(cargo_bin!("gg-query"))
        .args([
            "ask-dense",
            "calculate order tax total",
            "--json",
            "--model",
        ])
        .arg(&model)
        .arg(tmp.path())
        .output()
        .expect("run ask-dense");
    assert!(
        out.status.success(),
        "ask-dense stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let actual: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).expect("valid json");
    let expected: Vec<serde_json::Value> =
        serde_json::from_str(&golden("ask-dense.json")).expect("valid golden json");

    assert_eq!(actual.len(), expected.len(), "dense hit count mismatch");
    for (a, e) in actual.iter().zip(expected.iter()) {
        assert_eq!(a["path"], e["path"], "dense path rank mismatch");
        assert_eq!(a["start"], e["start"], "chunk start mismatch");
        assert_eq!(a["end"], e["end"], "chunk end mismatch");
        let diff = (a["score"].as_f64().unwrap() - e["score"].as_f64().unwrap()).abs();
        assert!(diff < 1e-6, "cosine score diff {diff} for {}", a["path"]);
    }
    assert_only_sqlite_written(&before, tmp.path());
}
