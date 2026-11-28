//! CLI integration tests for `gg-query` subcommand branches (`commands/mod.rs` and
//! `commands/query_cmds.rs`).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use gg_query::embed::MODEL_ID;
use gg_query::vectors::{CACHE_DIR, VECTORS_FILE};
use serde_json::json;
use tempfile::tempdir;

fn model_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("models")
        .join("potion-code-16M-v2")
}

fn write_wiring(ctx: &Path, graph: serde_json::Value) {
    fs::create_dir_all(ctx.join(".graph")).unwrap();
    fs::write(
        ctx.join(".graph").join("wiring.json"),
        serde_json::to_string(&graph).unwrap(),
    )
    .unwrap();
}

fn sample_graph() -> serde_json::Value {
    json!({
        "meta": { "nodeCount": 4, "edgeCount": 2 },
        "nodes": [
            { "id": "file:src/a.ts", "name": "a.ts", "kind": "file", "path": "src/a.ts", "span": "L1-L5", "signature": "a.ts", "exported": false, "origin": "ast", "chars": 40 },
            { "id": "src/a.ts#dup", "name": "dup", "kind": "function", "path": "src/a.ts", "span": "L1-L2", "signature": "function dup()", "exported": true, "origin": "ast" },
            { "id": "src/b.ts#dup", "name": "dup", "kind": "function", "path": "src/b.ts", "span": "L1-L2", "signature": "function dup()", "exported": true, "origin": "ast" },
            { "id": "src/b.ts#caller", "name": "caller", "kind": "function", "path": "src/b.ts", "span": "L3-L5", "signature": "function caller()", "exported": true, "origin": "ast" }
        ],
        "edges": [
            { "source": "src/b.ts#caller", "target": "src/a.ts#dup", "relation": "calls", "confidence": "extracted" },
            { "source": "ext#ghost", "target": "src/a.ts#dup", "relation": "calls", "confidence": "inferred" }
        ]
    })
}

fn two_node_graph() -> serde_json::Value {
    json!({
        "meta": { "nodeCount": 2, "edgeCount": 0 },
        "nodes": [
            { "id": "file:src/only.ts", "name": "only.ts", "kind": "file", "path": "src/only.ts", "span": "L1-L2", "signature": "only.ts", "exported": false, "origin": "ast", "chars": 20 },
            { "id": "src/only.ts#solo", "name": "solo", "kind": "function", "path": "src/only.ts", "span": "L1-L2", "signature": "function solo()", "exported": true, "origin": "ast" }
        ],
        "edges": []
    })
}

fn run_gg(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_gg-query"))
        .env_remove("GRAFT_NO_REFRESH")
        .args(args)
        .output()
        .expect("spawn gg-query")
}

#[test]
fn sync_status_and_context_dir_variants() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();

    // Missing graph: status text + status --json.
    let st_empty = run_gg(&["status", repo.to_str().unwrap()]);
    assert!(st_empty.status.success());
    assert!(String::from_utf8_lossy(&st_empty.stdout).contains("not built"));
    let st_empty_json = run_gg(&["status", "--json", repo.to_str().unwrap()]);
    assert!(st_empty_json.status.success());
    assert!(String::from_utf8_lossy(&st_empty_json.stdout).contains("\"codeMap\": null"));

    // `.trail/cache` auto-discovery + `sync` + stale text status.
    write_wiring(&repo.join(".trail/cache"), sample_graph());
    let synced = run_gg(&["sync", repo.to_str().unwrap()]);
    assert!(synced.status.success());
    assert!(String::from_utf8_lossy(&synced.stdout).contains("synced 4 nodes, 2 edges"));
    let st_stale = run_gg(&["status", "--no-refresh", repo.to_str().unwrap()]);
    assert!(st_stale.status.success());
    assert!(String::from_utf8_lossy(&st_stale.stdout).contains("behind the code"));
    let st_ok = run_gg(&["status", repo.to_str().unwrap()]);
    assert!(st_ok.status.success());
    assert!(String::from_utf8_lossy(&st_ok.stdout).contains("in sync with the code"));

    // Explicit `--dir` override loads `custom_ctx` (2 nodes) instead of `.trail/cache` (4 nodes).
    let custom = tmp.path().join("custom_ctx");
    write_wiring(&custom, two_node_graph());
    let st_dir = run_gg(&[
        "--dir",
        custom.to_str().unwrap(),
        "status",
        repo.to_str().unwrap(),
    ]);
    assert!(st_dir.status.success());
    assert!(String::from_utf8_lossy(&st_dir.stdout).contains("2 nodes"));
}

#[test]
fn embed_and_ask_dense_text_json_and_missing_vectors() {
    let model = model_dir();
    let m = model.to_str().unwrap();

    let emb_txt = run_gg(&["embed", "hello world", "--model", m]);
    assert!(emb_txt.status.success());
    assert!(String::from_utf8_lossy(&emb_txt.stdout).contains("dim=256"));

    let emb_json = run_gg(&["embed", "hello world", "--model", m, "--json"]);
    assert!(emb_json.status.success());
    let vec_vals: Vec<f32> = serde_json::from_slice(&emb_json.stdout).unwrap();
    assert_eq!(vec_vals.len(), 256);

    let tmp = tempdir().unwrap();
    let repo = tmp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    let r = repo.to_str().unwrap();
    let miss = run_gg(&["ask-dense", "hello", r, "--model", m]);
    assert!(!miss.status.success());
    assert!(String::from_utf8_lossy(&miss.stderr).contains("no valid ask-vectors.bin"));

    let cache = repo.join("graft").join(CACHE_DIR);
    fs::create_dir_all(&cache).unwrap();
    let hdr = json!({
        "version": 1, "model": MODEL_ID, "chunk": 750, "dim": 256,
        "files": [{"path": "src/a.ts", "hash": "h1", "lines": [1, 5]}]
    })
    .to_string();
    let mut vb = Vec::new();
    vb.extend_from_slice(&(hdr.len() as u64).to_le_bytes());
    vb.extend_from_slice(hdr.as_bytes());
    for _ in 0..256 {
        vb.extend_from_slice(&0x3c00_u16.to_le_bytes());
    }
    fs::write(cache.join(VECTORS_FILE), vb).unwrap();

    let dense_txt = run_gg(&["ask-dense", "hello", r, "--model", m, "--in", "src"]);
    assert!(dense_txt.status.success());
    assert!(String::from_utf8_lossy(&dense_txt.stdout).contains("src/a.ts:L1-L5"));
}

#[test]
fn ask_hubs_and_crate_source_text_and_error_paths() {
    let tmp = tempdir().unwrap();
    let empty = tmp.path().join("empty");
    fs::create_dir_all(&empty).unwrap();
    let e = empty.to_str().unwrap();

    let hubs_err = run_gg(&["hubs", e]);
    assert!(!hubs_err.status.success());
    assert!(String::from_utf8_lossy(&hubs_err.stderr).contains("no graph found"));

    let repo = tmp.path().join("repo");
    write_wiring(&repo.join("graft"), sample_graph());
    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(repo.join("src/a.ts"), "export function dup() {}\n").unwrap();
    let r = repo.to_str().unwrap();

    let ask_tok_json = run_gg(&[
        "ask",
        "dup",
        r,
        "--max-tokens",
        "200",
        "--no-semantic",
        "--json",
    ]);
    assert!(ask_tok_json.status.success());
    assert!(String::from_utf8_lossy(&ask_tok_json.stdout).contains("\"budget\""));

    let hubs_txt = run_gg(&["hubs", r]);
    assert!(hubs_txt.status.success());
    assert!(String::from_utf8_lossy(&hubs_txt.stdout).contains("hubs"));

    fs::write(
        repo.join("Cargo.lock"),
        "version = 4\n\n[[package]]\nname = \"demo\"\nversion = \"1.0.0\"\n",
    )
    .unwrap();
    fs::write(
        repo.join("Cargo.toml"),
        "[package]\nname = \"demo\"\nversion = \"1.0.0\"\n",
    )
    .unwrap();
    let cs_txt = run_gg(&["crate-source", "demo", r, "--cargo-home", e]);
    assert!(cs_txt.status.success());
    assert!(String::from_utf8_lossy(&cs_txt.stdout).contains("demo 1.0.0 (path, Cargo.lock)"));
}

#[test]
fn callers_and_blast_command_errors_and_formats() {
    let tmp = tempdir().unwrap();
    let empty = tmp.path().join("empty");
    fs::create_dir_all(&empty).unwrap();
    let e = empty.to_str().unwrap();

    let callers_missing = run_gg(&["callers", "dup", e]);
    assert!(!callers_missing.status.success());
    assert!(String::from_utf8_lossy(&callers_missing.stderr).contains("no graph found at"));
    let blast_missing = run_gg(&["blast", e]);
    assert!(!blast_missing.status.success());
    assert!(String::from_utf8_lossy(&blast_missing.stderr).contains("no graph found at"));
    let blast_bad_fmt = run_gg(&["blast", e, "--format", "bogus"]);
    assert!(!blast_bad_fmt.status.success());
    assert!(
        String::from_utf8_lossy(&blast_bad_fmt.stderr)
            .contains("--format must be text, markdown, mermaid or json")
    );

    let repo = tmp.path().join("repo");
    write_wiring(&repo.join("graft"), sample_graph());
    let r = repo.to_str().unwrap();

    // Two matches sharing name `dup` + unresolved import hit (`ext#ghost`) + invalid `--in` prefix.
    let callers_ok = run_gg(&["callers", "dup", r]);
    assert!(callers_ok.status.success());
    let callers_stdout = String::from_utf8_lossy(&callers_ok.stdout);
    assert!(callers_stdout.contains("src/a.ts"));
    assert!(callers_stdout.contains("ext#ghost (unresolved import)"));
    let callers_bad_in = run_gg(&["callers", "dup", r, "--in", "nope"]);
    assert!(!callers_bad_in.status.success());
    assert!(
        String::from_utf8_lossy(&callers_bad_in.stderr).contains("nothing indexed under \"nope\"")
    );
}

#[test]
fn blast_command_errors_and_mermaid_markdown_formats() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path().join("repo");
    write_wiring(&repo.join("graft"), sample_graph());
    let r = repo.to_str().unwrap();

    // Non-git repo without `--changed` hits diff error.
    let no_git = run_gg(&["blast", r, "--no-owners"]);
    assert!(!no_git.status.success());
    assert!(String::from_utf8_lossy(&no_git.stderr).contains("is this a git repository"));

    // `--format mermaid` (with and without dependents) and `--format markdown`.
    let mmd = run_gg(&[
        "blast",
        r,
        "--changed",
        "src/a.ts",
        "--no-owners",
        "--format",
        "mermaid",
    ]);
    assert!(mmd.status.success());
    assert!(String::from_utf8_lossy(&mmd.stdout).contains("flowchart"));
    let mmd_empty = run_gg(&[
        "blast",
        r,
        "--changed",
        "src/b.ts",
        "--no-owners",
        "--format",
        "mermaid",
    ]);
    assert!(mmd_empty.status.success());
    assert!(String::from_utf8_lossy(&mmd_empty.stdout).contains("no dependents"));
    let md = run_gg(&[
        "blast",
        r,
        "--changed",
        "src/a.ts",
        "--no-owners",
        "--format",
        "markdown",
    ]);
    assert!(md.status.success());
    assert!(String::from_utf8_lossy(&md.stdout).contains("##"));
}

#[test]
fn ask_stdin_rejects_invalid_utf8() {
    use std::io::Write;
    use std::process::Stdio;

    let tmp = tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_gg-query"))
        .args(["ask", "-", tmp.path().to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn gg-query");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&[0xff, 0xfe])
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("failed to read query from stdin"));
}
