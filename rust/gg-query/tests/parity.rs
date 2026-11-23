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
use std::sync::Arc;
use std::thread;

use gg_query::store::GraphStore;
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
    let expected_node: serde_json::Value =
        serde_json::from_str(&golden("blast-math-json.stdout")).expect("valid golden json");

    // Whole-file `--changed src/math.ts` seeds both the file node (matching Node's file-level
    // blast golden at lines 9-10) and every symbol defined in `src/math.ts`, reaching both the
    // file importers (`order.ts`, `checkout.ts`) and symbol callers (`processOrder`, `handleOrder`)
    // at exact BFS depths with no spurious extras.
    let actual_pairs: Vec<(&str, u64)> = actual["impacted"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| (h["id"].as_str().unwrap(), h["depth"].as_u64().unwrap()))
        .collect();
    assert_eq!(
        actual_pairs,
        vec![
            ("src/order.ts", 1),
            ("src/order.ts#OrderService.processOrder", 1),
            ("src/checkout.ts", 2),
            ("src/order.ts#handleOrder", 2),
        ]
    );

    let node_file_pairs: Vec<(&str, u64)> = expected_node["impacted"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| (h["id"].as_str().unwrap(), h["depth"].as_u64().unwrap()))
        .collect();
    assert_eq!(
        node_file_pairs,
        vec![("src/order.ts", 1), ("src/checkout.ts", 2)]
    );
    for pair in node_file_pairs {
        assert!(actual_pairs.contains(&pair), "missing Node pair {pair:?}");
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

#[test]
fn prefix_check_is_case_sensitive_and_literal_for_underscore() {
    let tmp = tempdir().expect("tempdir");
    let graph_dir = tmp.path().join("graft").join(".graph");
    fs::create_dir_all(&graph_dir).expect("mkdir");
    let graph = serde_json::json!({
        "meta": { "nodeCount": 2, "edgeCount": 0 },
        "nodes": [
            {
                "id": "src/fooXbar/a.ts",
                "name": "a.ts",
                "kind": "file",
                "path": "src/fooXbar/a.ts",
                "span": "L1-L3",
                "signature": null,
                "exported": false,
                "origin": "ast",
                "body_hash": "h1",
                "chars": 40
            },
            {
                "id": "src/fooXbar/a.ts#fnA",
                "name": "fnA",
                "kind": "function",
                "path": "src/fooXbar/a.ts",
                "span": "L1-L3",
                "signature": "fnA()",
                "exported": true,
                "origin": "ast",
                "body_hash": "h2"
            }
        ],
        "edges": [],
        "unresolvedCalls": []
    });
    fs::write(graph_dir.join("wiring.json"), graph.to_string()).expect("write wiring.json");

    let store = GraphStore::open_or_sync(&tmp.path().join("graft"))
        .expect("open")
        .expect("store");
    assert!(store.has_indexed_prefix("src/fooXbar").expect("exact"));
    assert!(
        !store
            .has_indexed_prefix("src/foo_bar")
            .expect("underscore literal")
    );
    assert!(
        !store
            .has_indexed_prefix("src/foo%bar")
            .expect("percent literal")
    );
    assert!(
        !store
            .has_indexed_prefix("SRC/FOOXBAR")
            .expect("case sensitive")
    );
}

#[test]
fn concurrent_open_or_sync_succeeds_without_sqlite_busy() {
    let (tmp, _) = setup_repo();
    let ctx = Arc::new(tmp.path().join("graft"));
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let ctx = Arc::clone(&ctx);
            thread::spawn(move || {
                let store = GraphStore::open_or_sync(&ctx)
                    .expect("concurrent open_or_sync")
                    .expect("store");
                assert_eq!(store.node_count().expect("node_count"), 12);
            })
        })
        .collect();
    for h in handles {
        h.join().expect("thread join");
    }
}
