//! Regression tests for Alcuin Pro findings S1-S6:
//! - S1: SQLite read-snapshot isolation across concurrent rebuilds
//! - S2: Multi-byte UTF-8 boundary stepping in `reference_line`
//! - S3: `git diff --name-only -z` for non-ASCII paths with `core.quotePath=true`
//! - S4: Empty vocabulary and `usize::MAX` vocab-id / shape overflow rejection
//! - S5: Non-finite F16 rejection in model/vectors and CLI dimension mismatch error
//! - S6: Checked `chars` import and savings addition overflow rejection

use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;

use gg_query::embed::{MODEL_ID, SafetensorsEmbedder};
use gg_query::graph::{Direction, reference_line};
use gg_query::store::GraphStore;
use gg_query::vectors::{CACHE_DIR, VECTORS_FILE, read_vectors};
use snapbox::cmd::{Command, cargo_bin};
use tempfile::tempdir;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn model_dir() -> PathBuf {
    repo_root().join("models").join("potion-code-16M-v2")
}

fn write_graph(ctx: &Path, json: &serde_json::Value) {
    let dir = ctx.join(".graph");
    fs::create_dir_all(&dir).expect("mkdir .graph");
    fs::write(dir.join("wiring.json"), json.to_string()).expect("write wiring.json");
}

#[test]
fn s1_read_snapshot_isolates_concurrent_rebuild() {
    let tmp = tempdir().expect("tempdir");
    let ctx = tmp.path().join("graft");
    let gen1 = serde_json::json!({
        "meta": { "nodeCount": 2, "edgeCount": 1 },
        "nodes": [
            {"id":"a.ts#a","name":"a","kind":"function","path":"a.ts","span":"L1-L2","signature":null,"exported":true,"origin":"ast","body_hash":"1"},
            {"id":"b.ts#b","name":"b","kind":"function","path":"b.ts","span":"L1-L2","signature":null,"exported":true,"origin":"ast","body_hash":"2"}
        ],
        "edges": [{"source":"b.ts#b","target":"a.ts#a","relation":"calls","confidence":"extracted"}],
        "unresolvedCalls": []
    });
    write_graph(&ctx, &gen1);

    let store = GraphStore::open_or_sync(&ctx)
        .expect("open")
        .expect("store");
    let gen2 = serde_json::json!({
        "meta": { "nodeCount": 2, "edgeCount": 1 },
        "nodes": [
            {"id":"a.ts#a","name":"a","kind":"function","path":"a.ts","span":"L1-L2","signature":null,"exported":true,"origin":"ast","body_hash":"1"},
            {"id":"c.ts#c","name":"c","kind":"function","path":"c.ts","span":"L1-L2","signature":null,"exported":true,"origin":"ast","body_hash":"3"}
        ],
        "edges": [{"source":"c.ts#c","target":"a.ts#a","relation":"calls","confidence":"extracted"}],
        "unresolvedCalls": []
    });

    let (first_callers, second_callers) = store
        .with_read_snapshot(|s| {
            let sym = s.resolve_symbol("a", None)?.pop().expect("a");
            let before = s.edge_walk(&sym, Direction::In, 1)?;
            // Commit a completely new graph generation on another connection mid-snapshot.
            write_graph(&ctx, &gen2);
            GraphStore::force_sync(&ctx)?;
            let after = s.edge_walk(&sym, Direction::In, 1)?;
            Ok((before, after))
        })
        .expect("snapshot");

    assert_eq!(first_callers.len(), 1);
    assert_eq!(first_callers[0].id, "b.ts#b");
    assert_eq!(second_callers.len(), 1);
    assert_eq!(second_callers[0].id, "b.ts#b");
}

#[test]
fn s2_reference_line_handles_multibyte_utf8_without_panic() {
    let tmp = tempdir().expect("tempdir");
    fs::write(tmp.path().join("u.ts"), "éx(); é();\n").expect("write u.ts");
    let mut cache = HashMap::new();
    let quote = reference_line(tmp.path(), "u.ts", "L1-L1", "é", &mut cache).expect("found");
    assert_eq!(quote.n, 1);
    assert_eq!(quote.text, "éx(); é();");
}

#[test]
fn s3_blast_handles_non_ascii_path_with_quote_path_enabled() {
    let tmp = tempdir().expect("tempdir");
    let src = tmp.path().join("src");
    fs::create_dir_all(&src).expect("mkdir src");
    fs::write(src.join("café.ts"), "export const x = 1;\n").expect("write café.ts");
    fs::write(src.join("use.ts"), "import './café';\n").expect("write use.ts");

    let run_git = |args: &[&str]| {
        let status = StdCommand::new("git")
            .args(args)
            .current_dir(tmp.path())
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?} failed");
    };
    run_git(&["init", "-q", "-b", "main"]);
    run_git(&["config", "user.name", "Test"]);
    run_git(&["config", "user.email", "test@example.com"]);
    run_git(&["config", "core.quotePath", "true"]);
    run_git(&["add", "src"]);
    run_git(&["commit", "-q", "-m", "init"]);

    let graph = serde_json::json!({
        "meta": { "nodeCount": 2, "edgeCount": 1 },
        "nodes": [
            {"id":"src/café.ts","name":"café.ts","kind":"file","path":"src/café.ts","span":"L1-L1","signature":null,"exported":false,"origin":"ast","body_hash":"1","chars":20},
            {"id":"src/use.ts","name":"use.ts","kind":"file","path":"src/use.ts","span":"L1-L1","signature":null,"exported":false,"origin":"ast","body_hash":"2","chars":18}
        ],
        "edges": [{"source":"src/use.ts","target":"src/café.ts","relation":"imports","confidence":"extracted"}],
        "unresolvedCalls": []
    });
    write_graph(&tmp.path().join("graft"), &graph);

    fs::write(src.join("café.ts"), "export const x = 2;\n").expect("modify café.ts");
    let out = Command::new(cargo_bin!("gg-query"))
        .args(["blast", "--format", "json"])
        .arg(tmp.path())
        .output()
        .expect("run blast");
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let parsed: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json");
    assert_eq!(parsed["seeds"][0]["id"], "src/café.ts");
    assert_eq!(parsed["impacted"][0]["id"], "src/use.ts");
}

#[test]
fn s4_embedder_rejects_empty_vocab_and_max_vocab_id() {
    let unk_key = ["unk", "token"].join("_");
    // Case 1: empty vocab + huge dim shape [0, usize::MAX]
    let d1 = tempdir().expect("tempdir");
    let tok_empty = serde_json::json!({
        "model": {
            "type": "WordPiece",
            "continuing_subword_prefix": "##",
            unk_key.clone(): "[UNK]",
            "max_input_chars_per_word": 100,
            "vocab": {}
        }
    });
    fs::write(d1.path().join("tokenizer.json"), tok_empty.to_string()).expect("write tok");
    let hdr = serde_json::json!({"embeddings": {"dtype":"F16","shape":[0, usize::MAX],"data_offsets":[0,0]}}).to_string();
    let mut st = Vec::new();
    st.extend_from_slice(&(hdr.len() as u64).to_le_bytes());
    st.extend_from_slice(hdr.as_bytes());
    fs::write(d1.path().join("model.safetensors"), &st).expect("write st");
    for whole in [false, true] {
        let err = SafetensorsEmbedder::open(d1.path(), whole)
            .err()
            .expect("fail");
        assert_eq!(err.kind(), ErrorKind::InvalidData);
    }

    // Case 2: vocab id = usize::MAX
    let d2 = tempdir().expect("tempdir");
    let tok_max = serde_json::json!({
        "model": {
            "type": "WordPiece",
            "continuing_subword_prefix": "##",
            unk_key: "[UNK]",
            "max_input_chars_per_word": 100,
            "vocab": { "[UNK]": 0, "hello": usize::MAX }
        }
    });
    fs::write(d2.path().join("tokenizer.json"), tok_max.to_string()).expect("write tok");
    fs::write(d2.path().join("model.safetensors"), &st).expect("write st");
    for whole in [false, true] {
        let err = SafetensorsEmbedder::open(d2.path(), whole)
            .err()
            .expect("fail");
        assert_eq!(err.kind(), ErrorKind::InvalidData);
    }
}

#[test]
fn s5_rejects_non_finite_f16_and_dimension_mismatch() {
    let unk_key = ["unk", "token"].join("_");
    // Inject 0x7c00 (+Inf) into model.safetensors
    let d_model = tempdir().expect("tempdir");
    let tok = serde_json::json!({
        "model": {
            "type": "WordPiece",
            "continuing_subword_prefix": "##",
            unk_key: "[UNK]",
            "max_input_chars_per_word": 100,
            "vocab": { "[UNK]": 0, "hello": 1 }
        }
    });
    fs::write(d_model.path().join("tokenizer.json"), tok.to_string()).expect("write tok");
    let hdr = serde_json::json!({"embeddings": {"dtype":"F16","shape":[2,2],"data_offsets":[0,8]}})
        .to_string();
    let mut st = Vec::new();
    st.extend_from_slice(&(hdr.len() as u64).to_le_bytes());
    st.extend_from_slice(hdr.as_bytes());
    for bits in [0x3c00_u16, 0x3c00, 0x7c00, 0x3c00] {
        st.extend_from_slice(&bits.to_le_bytes());
    }
    fs::write(d_model.path().join("model.safetensors"), &st).expect("write st");

    let err_whole = SafetensorsEmbedder::open(d_model.path(), true)
        .err()
        .expect("whole rejects +Inf");
    assert_eq!(err_whole.kind(), ErrorKind::InvalidData);
    let mut emb = SafetensorsEmbedder::open(d_model.path(), false).expect("open on-demand");
    let err_row = emb.embed("hello").expect_err("on-demand rejects +Inf");
    assert_eq!(err_row.kind(), ErrorKind::InvalidData);

    // Inject 0x7c00 (+Inf) into ask-vectors.bin
    let d_vec = tempdir().expect("tempdir");
    let cache = d_vec.path().join("graft").join(CACHE_DIR);
    fs::create_dir_all(&cache).expect("mkdir");
    let v_hdr = serde_json::json!({
        "version": 1, "model": MODEL_ID, "chunk": 750, "dim": 2,
        "files": [{"path": "src/a.ts", "hash": "h", "lines": [1, 2]}]
    })
    .to_string();
    let mut vb = Vec::new();
    vb.extend_from_slice(&(v_hdr.len() as u64).to_le_bytes());
    vb.extend_from_slice(v_hdr.as_bytes());
    vb.extend_from_slice(&0x7c00_u16.to_le_bytes());
    vb.extend_from_slice(&0x3c00_u16.to_le_bytes());
    fs::write(cache.join(VECTORS_FILE), &vb).expect("write vectors");
    let err_vec =
        read_vectors(&d_vec.path().join("graft")).expect_err("reject +Inf in ask-vectors.bin");
    assert_eq!(err_vec.kind(), ErrorKind::InvalidData);

    // Mismatched dimension (dim=2 finite cache vs 256-dim shipped model) fails explicitly at CLI
    let mut vb_ok = Vec::new();
    vb_ok.extend_from_slice(&(v_hdr.len() as u64).to_le_bytes());
    vb_ok.extend_from_slice(v_hdr.as_bytes());
    vb_ok.extend_from_slice(&0x3c00_u16.to_le_bytes());
    vb_ok.extend_from_slice(&0x3c00_u16.to_le_bytes());
    fs::write(cache.join(VECTORS_FILE), &vb_ok).expect("write finite dim=2 vectors");

    let out = Command::new(cargo_bin!("gg-query"))
        .args(["ask-dense", "hello", "--model"])
        .arg(model_dir())
        .arg(d_vec.path())
        .output()
        .expect("run ask-dense");
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("dimension (2) does not match model dimension (256)"),
        "unexpected stderr: {stderr}"
    );
}

#[test]
fn s6_rejects_overflowing_chars_on_import_and_savings() {
    // u64::MAX chars rejected on import
    let d1 = tempdir().expect("tempdir");
    let ctx1 = d1.path().join("graft");
    let g_max = serde_json::json!({
        "meta": { "nodeCount": 1, "edgeCount": 0 },
        "nodes": [{
            "id": "a.ts", "name": "a.ts", "kind": "file", "path": "a.ts",
            "span": "L1-L1", "signature": null, "exported": false,
            "origin": "ast", "body_hash": "h", "chars": u64::MAX
        }],
        "edges": [],
        "unresolvedCalls": []
    });
    write_graph(&ctx1, &g_max);
    let err1 = GraphStore::open_or_sync(&ctx1)
        .err()
        .expect("reject u64::MAX");
    assert_eq!(err1.kind(), ErrorKind::InvalidData);

    // 3 files each with i64::MAX chars overflow usize baseline_chars in savings_for_paths
    let d2 = tempdir().expect("tempdir");
    let ctx2 = d2.path().join("graft");
    let big = i64::MAX as u64;
    let g_sum = serde_json::json!({
        "meta": { "nodeCount": 3, "edgeCount": 0 },
        "nodes": [
            {"id":"a.ts","name":"a.ts","kind":"file","path":"a.ts","span":"L1-L1","signature":null,"exported":false,"origin":"ast","body_hash":"1","chars":big},
            {"id":"b.ts","name":"b.ts","kind":"file","path":"b.ts","span":"L1-L1","signature":null,"exported":false,"origin":"ast","body_hash":"2","chars":big},
            {"id":"c.ts","name":"c.ts","kind":"file","path":"c.ts","span":"L1-L1","signature":null,"exported":false,"origin":"ast","body_hash":"3","chars":big}
        ],
        "edges": [],
        "unresolvedCalls": []
    });
    write_graph(&ctx2, &g_sum);
    let store = GraphStore::open_or_sync(&ctx2)
        .expect("open")
        .expect("store");
    let err2 = store
        .savings_for_paths(["a.ts", "b.ts", "c.ts"])
        .expect_err("reject sum overflow");
    assert_eq!(err2.kind(), ErrorKind::InvalidData);
}
