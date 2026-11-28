//! Focused edge-case coverage for `store.rs`, `store_ask.rs`, `query_ask.rs`,
//! `tokenize.rs`, `safe_io.rs`, `brand.rs`, and `main.rs`.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use gg_query::brand;
use gg_query::safe_io::{anchor_dir_no_follow, anchor_root, read_contained_to_string};
use gg_query::store::{GraphStore, wiring_json_path, wiring_sqlite_path};
use gg_query::tokenize::{ask_index_path, read_ask_index, tokenize, unique_terms_ordered};
use rusqlite::Connection;
use tempfile::tempdir;

fn write_graph(ctx: &Path, json: &str) {
    fs::create_dir_all(ctx.join(".graph")).expect("mkdir .graph");
    fs::write(wiring_json_path(ctx), json).expect("write wiring.json");
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

#[test]
fn store_open_sync_handles_missing_corrupt_empty_and_dir_sidecar() {
    let tmp = tempdir().expect("tmp");
    let ctx = tmp.path().join("graft");
    assert!(GraphStore::open_or_sync(&ctx).expect("absent").is_none());

    write_graph(&ctx, "{bad-json");
    let err = GraphStore::force_sync(&ctx).expect_err("malformed json");
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(err.to_string().contains("wiring.json:"));

    fs::create_dir_all(ask_index_path(&ctx)).expect("dir at ask-index.json");
    write_graph(
        &ctx,
        r#"{"meta":{"nodeCount":0,"edgeCount":0,"languages":[]},"nodes":[],"edges":[],"unresolvedCalls":[]}"#,
    );
    let (n, e) = GraphStore::force_sync(&ctx).expect("empty graph");
    assert_eq!((n, e), (0, 0));
    let store = GraphStore::open_or_sync(&ctx)
        .expect("reopen")
        .expect("present");
    assert_eq!(store.ask_meta().expect("meta"), (0, 0.0));
    drop(store);

    fs::write(wiring_sqlite_path(&ctx), b"not a sqlite database").expect("corrupt db");
    let db_err = GraphStore::open_or_sync(&ctx).err().expect("corrupt db");
    assert!(db_err.to_string().contains("sqlite:"));
}

const STRUCTURAL_GRAPH_JSON: &str = r#"{
  "meta": { "nodeCount": 4, "edgeCount": 3, "languages": ["rust"] },
  "nodes": [
    { "id": "src/s.rs#s", "name": "s", "kind": "function", "path": "src/s.rs", "span": "L1-L2", "exported": true, "origin": "ast", "body_hash": "h0" },
    { "id": "src/c.rs#c", "name": "c", "kind": "function", "path": "src/c.rs", "span": "L1-L2", "exported": true, "origin": "ast", "body_hash": "h1" },
    { "id": "src/b.rs#b", "name": "b", "kind": "function", "path": "src/b.rs", "span": "L1-L2", "exported": true, "origin": "ast", "body_hash": "h2" },
    { "id": "src/a.rs#a", "name": "a", "kind": "function", "path": "src/a.rs", "span": "L1-L2", "exported": true, "origin": "ast", "body_hash": "h3" }
  ],
  "edges": [
    { "source": "src/s.rs#s", "target": "src/c.rs#c", "relation": "calls", "confidence": "extracted" },
    { "source": "src/s.rs#s", "target": "src/b.rs#b", "relation": "calls", "confidence": "extracted" },
    { "source": "src/s.rs#s", "target": "src/a.rs#a", "relation": "calls", "confidence": "extracted" }
  ],
  "unresolvedCalls": []
}"#;

#[test]
fn query_ask_scopes_nodes_by_seqs_and_structural_heap_eviction() {
    let tmp = tempdir().expect("tmp");
    let ctx = tmp.path().join("graft");
    write_graph(&ctx, STRUCTURAL_GRAPH_JSON);
    let store = GraphStore::open_or_sync(&ctx)
        .expect("sync")
        .expect("store");

    let by_seq = store.nodes_by_seqs(&[0, 0, 999]).expect("nodes_by_seqs");
    assert_eq!(by_seq.len(), 1);
    assert_eq!(by_seq[&0].id, "src/s.rs#s");

    let (any_empty, rows_empty) = store
        .structural_hits_bounded(&HashSet::new(), true, 5)
        .expect("empty subjects");
    assert!(!any_empty && rows_empty.is_empty());

    let subjects: HashSet<String> = ["src/s.rs#s".to_string()].into_iter().collect();
    let (matched, top) = store
        .structural_hits_bounded(&subjects, true, 2)
        .expect("bounded");
    assert!(matched);
    let ids: Vec<&str> = top.iter().map(|r| r.other_id.as_str()).collect();
    assert_eq!(ids, vec!["src/a.rs#a", "src/b.rs#b"]);

    let raw = Connection::open(wiring_sqlite_path(&ctx)).expect("raw conn");
    raw.execute("UPDATE meta SET value = '[]' WHERE key = 'scopes_json'", [])
        .expect("empty scopes");
    assert_eq!(store.scopes().expect("empty->root").len(), 1);

    raw.execute("DELETE FROM meta WHERE key = 'scopes_json'", [])
        .expect("delete scopes");
    assert_eq!(store.scopes().expect("missing->root").len(), 1);

    raw.execute(
        "INSERT INTO meta (key, value) VALUES ('scopes_json', '{bad')",
        [],
    )
    .expect("bad scopes");
    let err = store.scopes().expect_err("invalid scopes json");
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
}

#[test]
fn tokenize_cjk_duplicates_and_read_ask_index_edge_cases() {
    let toks = tokenize("a中b 中文 中文字");
    assert!(toks.contains(&"a中b".to_string()));
    assert!(toks.contains(&"中文".to_string()));
    assert!(toks.contains(&"文字".to_string()));
    assert_eq!(
        unique_terms_ordered("alpha beta alpha"),
        vec!["alpha".to_string(), "beta".to_string()]
    );

    let tmp = tempdir().expect("tmp");
    let out_dir = tmp.path().join("ws").join("graft");
    fs::create_dir_all(ask_index_path(&out_dir)).expect("dir at index");
    assert!(read_ask_index(&out_dir).expect("dir skipped").is_none());
    fs::remove_dir(ask_index_path(&out_dir)).expect("rm dir");

    fs::write(ask_index_path(&out_dir), [0xff_u8, 0xfe, 0xfd]).expect("bad utf8");
    assert!(read_ask_index(&out_dir).expect("bad utf8").is_none());

    fs::write(ask_index_path(&out_dir), "{not json").expect("bad json");
    assert!(read_ask_index(&out_dir).expect("bad json").is_none());

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let blocked = tmp.path().join("blocked");
        fs::create_dir_all(&blocked).expect("blocked");
        fs::write(blocked.join(".cache"), b"file").expect("file");
        assert!(read_ask_index(&blocked).is_err());

        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).expect("outside");
        fs::write(outside.join("ask-index.json"), "{}").expect("outside idx");
        let escaped = tmp.path().join("inside").join("graft");
        fs::create_dir_all(&escaped).expect("inside");
        symlink(&outside, escaped.join(".cache")).expect("symlink cache");
        assert!(read_ask_index(&escaped).expect("escaped").is_none());
    }
}

#[test]
fn safe_io_anchor_id_curdir_empty_and_os_error() {
    let tmp = tempdir().expect("tmp");
    let r1 = tmp.path().join("r1");
    let r2 = tmp.path().join("r2");
    fs::create_dir_all(r1.join("src")).expect("r1");
    fs::create_dir_all(&r2).expect("r2");
    fs::write(r1.join("src/a.ts"), "ok\n").expect("write");

    let (a1, _) = anchor_root(&r1).expect("a1");
    let (a1b, _) = anchor_root(&r1).expect("a1b");
    let (a2, _) = anchor_root(&r2).expect("a2");
    assert_eq!(a1.id(), a1b.id());
    assert_ne!(a1.id(), a2.id());

    assert_eq!(
        read_contained_to_string(&r1, "./src/a.ts", None).as_deref(),
        Some("ok\n")
    );
    assert!(read_contained_to_string(&r1, ".", None).is_none());
    assert!(
        anchor_dir_no_follow(Path::new(""))
            .expect("empty")
            .is_none()
    );

    #[cfg(unix)]
    {
        let too_long = tmp.path().join("a".repeat(300));
        assert!(anchor_dir_no_follow(&too_long).is_err());
    }
}

fn spawn_with_argv0(
    bin: &Path,
    argv0: &str,
    args: &[&str],
    env_val: Option<&str>,
) -> std::process::Output {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new(bin);
        cmd.arg0(argv0).args(args);
        match env_val {
            Some(v) => cmd.env("TRAIL_INVOKED_AS", v),
            None => cmd.env_remove("TRAIL_INVOKED_AS"),
        };
        cmd.output().expect("spawn unix")
    }
    #[cfg(not(unix))]
    {
        let tmp = tempdir().expect("tmp");
        let name = format!("{argv0}{}", std::env::consts::EXE_SUFFIX);
        let target = tmp.path().join(name);
        if fs::hard_link(bin, &target).is_err() {
            fs::copy(bin, &target).expect("copy bin");
        }
        let mut cmd = Command::new(&target);
        cmd.args(args);
        match env_val {
            Some(v) => cmd.env("TRAIL_INVOKED_AS", v),
            None => cmd.env_remove("TRAIL_INVOKED_AS"),
        };
        cmd.output().expect("spawn non-unix")
    }
}

#[test]
fn brand_cmd_env_and_argv0_variants() {
    assert_eq!(brand::cmd("graft check"), "trail build --check");
    assert_eq!(brand::cmd("graft stats"), "trail status");
    assert_eq!(brand::cmd("graft"), "trail");
    assert_eq!(brand::cmd("custom cmd"), "custom cmd");

    let bin = Path::new(env!("CARGO_BIN_EXE_gg-query"));
    let empty = tempdir().expect("empty");
    let empty_s = empty.path().to_str().expect("utf8");

    for val in ["trail", "other"] {
        let out = Command::new(bin)
            .env("TRAIL_INVOKED_AS", val)
            .args(["status", empty_s])
            .output()
            .expect("status");
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(combined.contains("trail build"), "got: {combined}");
    }

    let graft_out = spawn_with_argv0(bin, "graft", &["status", empty_s], None);
    let graft_txt = format!(
        "{}{}",
        String::from_utf8_lossy(&graft_out.stdout),
        String::from_utf8_lossy(&graft_out.stderr)
    );
    assert!(graft_txt.contains("graft build"), "got: {graft_txt}");
    let trail_out = spawn_with_argv0(bin, "trail", &["status", empty_s], None);
    let trail_txt = format!(
        "{}{}",
        String::from_utf8_lossy(&trail_out.stdout),
        String::from_utf8_lossy(&trail_out.stderr)
    );
    assert!(trail_txt.contains("trail build"), "got: {trail_txt}");
    #[cfg(unix)]
    {
        let blank_out = spawn_with_argv0(bin, "", &["status", empty_s], None);
        let blank_txt = format!(
            "{}{}",
            String::from_utf8_lossy(&blank_out.stdout),
            String::from_utf8_lossy(&blank_out.stderr)
        );
        assert!(blank_txt.contains("trail build"), "got: {blank_txt}");
    }
}

const SINGLE_NODE_GRAPH_JSON: &str = r#"{
  "meta": { "nodeCount": 1, "edgeCount": 0, "languages": ["rust"] },
  "nodes": [{ "id": "src/a.rs#f", "name": "f", "kind": "function", "path": "src/a.rs", "span": "L1-L2", "exported": true, "origin": "ast", "body_hash": "h1" }],
  "edges": [],
  "unresolvedCalls": []
}"#;

#[test]
fn cli_relative_repo_sync_and_blast_graft_brand() {
    let bin = Path::new(env!("CARGO_BIN_EXE_gg-query"));
    let repo = tempdir().expect("repo");
    fs::create_dir_all(repo.path().join("sub")).expect("sub");
    write_graph(&repo.path().join("graft"), SINGLE_NODE_GRAPH_JSON);
    let sync_out = Command::new(bin)
        .current_dir(repo.path())
        .args(["sync", "./sub/.."])
        .output()
        .expect("sync");
    assert!(
        sync_out.status.success(),
        "{}",
        String::from_utf8_lossy(&sync_out.stderr)
    );

    let blast_out = Command::new(bin)
        .env("TRAIL_INVOKED_AS", "graft")
        .args([
            "blast",
            repo.path().to_str().expect("utf8"),
            "--changed",
            "src/a.rs",
            "--format",
            "markdown",
            "--no-owners",
            "--no-refresh",
        ])
        .output()
        .expect("blast");
    assert!(blast_out.status.success());
    assert!(String::from_utf8_lossy(&blast_out.stdout).contains("graft blast radius"));
}

#[test]
fn cli_embed_outputs_json_vector() {
    let bin = Path::new(env!("CARGO_BIN_EXE_gg-query"));
    let model = repo_root().join("models").join("potion-code-16M-v2");
    let emb_out = Command::new(bin)
        .args([
            "embed",
            "hello",
            "--model",
            model.to_str().expect("utf8"),
            "--json",
        ])
        .output()
        .expect("embed");
    assert!(
        emb_out.status.success(),
        "{}",
        String::from_utf8_lossy(&emb_out.stderr)
    );
    let vec: Vec<f32> = serde_json::from_slice(&emb_out.stdout).expect("json float vec");
    assert!(!vec.is_empty());
    assert!(vec.iter().all(|v| v.is_finite()));
}
