use std::fs;
use std::io;
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::Duration;

use rusqlite::{Connection, ffi};
use tempfile::tempdir;

use super::{
    GraphStore, SCHEMA_SQL, SyncStamps, file_stamp, optional_file_stamp, retry_busy,
    wiring_json_path, wiring_sqlite_path,
};
use crate::graph::NodeV1;
use crate::tokenize::ask_index_path;

fn minimal_graph_json() -> &'static str {
    r#"{
  "meta": { "nodeCount": 1, "edgeCount": 0, "languages": ["rust"] },
  "nodes": [{
    "id": "src/a.rs#f", "name": "f", "kind": "function", "path": "src/a.rs",
    "span": "L1-L2", "exported": true, "origin": "ast", "body_hash": "h1"
  }],
  "edges": [],
  "unresolvedCalls": []
}"#
}

#[test]
fn retry_busy_retries_until_success_and_propagates_other_errors() {
    let mut attempts = 0_usize;
    let val = retry_busy(|| {
        attempts += 1;
        if attempts < 3 {
            Err(rusqlite::Error::SqliteFailure(
                ffi::Error::new(ffi::SQLITE_BUSY),
                None,
            ))
        } else {
            Ok(42)
        }
    })
    .expect("busy should retry and succeed");
    assert_eq!(val, 42);
    assert_eq!(attempts, 3);

    let err = retry_busy::<()>(|| {
        Err(rusqlite::Error::SqliteFailure(
            ffi::Error::new(ffi::SQLITE_CORRUPT),
            None,
        ))
    })
    .expect_err("non-busy sqlite error must fail immediately");
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert!(err.to_string().contains("sqlite:"));
}

#[test]
fn sync_in_immediate_tx_handles_current_stamp_and_non_busy_error() {
    let tmp = tempdir().expect("tmp");
    let ctx = tmp.path().join("graft");
    fs::create_dir_all(ctx.join(".graph")).expect("mkdir");
    let json_path = wiring_json_path(&ctx);
    fs::write(&json_path, minimal_graph_json()).expect("write");

    let (n, e) = GraphStore::force_sync(&ctx).expect("force_sync");
    assert_eq!((n, e), (1, 0));

    let stamps = SyncStamps {
        wiring: file_stamp(&json_path).expect("stamp"),
        ask_index: optional_file_stamp(&ask_index_path(&ctx)),
    };
    let mut conn = Connection::open(wiring_sqlite_path(&ctx)).expect("open");
    let reused = GraphStore::sync_in_immediate_tx(&mut conn, &ctx, &json_path, stamps, false)
        .expect("current stamp fast path");
    assert_eq!(reused, (1, 0));

    conn.execute_batch("BEGIN DEFERRED").expect("nested tx");
    let err = GraphStore::sync_in_immediate_tx(&mut conn, &ctx, &json_path, stamps, true)
        .expect_err("cannot begin immediate inside active tx");
    assert!(err.to_string().contains("sqlite:"));
    let _ = conn.execute_batch("ROLLBACK");
}

#[test]
fn sync_in_immediate_tx_retries_when_writer_holds_lock() {
    let tmp = tempdir().expect("tmp");
    let ctx = tmp.path().join("graft");
    fs::create_dir_all(ctx.join(".graph")).expect("mkdir");
    let json_path = wiring_json_path(&ctx);
    fs::write(&json_path, minimal_graph_json()).expect("write");
    GraphStore::force_sync(&ctx).expect("seed");

    let db_path = wiring_sqlite_path(&ctx);
    let stamps = SyncStamps {
        wiring: file_stamp(&json_path).expect("stamp"),
        ask_index: None,
    };
    let ready = Arc::new(Barrier::new(2));
    let ready_bg = Arc::clone(&ready);
    let db_bg = db_path.clone();
    let handle = thread::spawn(move || {
        let c = Connection::open(&db_bg).expect("bg open");
        c.execute_batch("BEGIN IMMEDIATE").expect("bg lock");
        ready_bg.wait();
        thread::sleep(Duration::from_millis(35));
        c.execute_batch("COMMIT").expect("bg commit");
    });

    ready.wait();
    let mut conn = Connection::open(&db_path).expect("fg open");
    conn.busy_timeout(Duration::from_millis(1))
        .expect("short timeout");
    let res = GraphStore::sync_in_immediate_tx(&mut conn, &ctx, &json_path, stamps, false)
        .expect("retries past busy lock");
    assert_eq!(res, (1, 0));
    handle.join().expect("join");
}

#[test]
fn insert_nodes_rejects_body_len_above_i64_max() {
    let mut conn = Connection::open_in_memory().expect("mem");
    conn.execute_batch(SCHEMA_SQL).expect("schema");
    let tx = conn.transaction().expect("tx");
    let node = NodeV1 {
        id: "src/a.rs#f".into(),
        name: "f".into(),
        kind: "function".into(),
        owner: None,
        path: "src/a.rs".into(),
        span: "L1-L2".into(),
        signature: None,
        exported: true,
        origin: "ast".into(),
        body_hash: "h".into(),
        chars: None,
        summary: None,
        body_text: None,
        crux: None,
    };
    let err = GraphStore::insert_nodes(&tx, &[node], &[usize::MAX])
        .expect_err("body_len overflow must fail");
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(err.to_string().contains("body_len"));
}
