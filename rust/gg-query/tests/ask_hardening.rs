//! Regression tests for Alcuin findings S1 (duplicate/invalid DF sidecar),
//! S2 (negative `avgBodyLen`, term-frequency overflow and `> i64::MAX` values),
//! and S3 (bounded indexed SQLite `LEFT JOIN` structural retrieval).

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use gg_query::ask::{AskMode, AskOptions, run_ask};
use gg_query::store::GraphStore;
use gg_query::tokenize::read_ask_index;
use tempfile::tempdir;

fn write_json(path: &Path, value: &serde_json::Value) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("mkdir parent");
    }
    fs::write(path, value.to_string()).expect("write json");
}

fn minimal_two_node_graph() -> serde_json::Value {
    serde_json::json!({
        "meta": { "nodeCount": 2, "edgeCount": 0 },
        "nodes": [
            {
                "id": "src/a.ts#alpha",
                "name": "alpha",
                "kind": "function",
                "path": "src/a.ts",
                "span": "L1-L4",
                "signature": "function alpha()",
                "exported": true,
                "origin": "ast",
                "body_hash": "h1"
            },
            {
                "id": "src/b.ts#beta",
                "name": "beta",
                "kind": "function",
                "path": "src/b.ts",
                "span": "L1-L4",
                "signature": "function beta()",
                "exported": true,
                "origin": "ast",
                "body_hash": "h2"
            }
        ],
        "edges": [],
        "unresolvedCalls": []
    })
}

fn default_ask_opts(limit: usize) -> AskOptions<'static> {
    AskOptions {
        limit,
        source: false,
        full: false,
        graph_rank: true,
        in_prefix: None,
        model_dir: None,
        semantic: false,
    }
}

#[test]
fn s1_malformed_ask_index_duplicate_and_oob_df_falls_back_cleanly() {
    let cases = [
        serde_json::json!({
            "version": 2,
            "avgBodyLen": 1.0,
            "docCount": 2,
            "df": [["alpha", 1], ["alpha", 1]],
            "docs": [
                { "id": "src/a.ts#alpha", "name": [["alpha", 1]], "path": [], "body": [] },
                { "id": "src/b.ts#beta", "name": [["beta", 1]], "path": [], "body": [] }
            ]
        }),
        serde_json::json!({
            "version": 2,
            "avgBodyLen": 1.0,
            "docCount": 2,
            "df": [["alpha", 9]],
            "docs": [
                { "id": "src/a.ts#alpha", "name": [["alpha", 1]], "path": [], "body": [] },
                { "id": "src/b.ts#beta", "name": [["beta", 1]], "path": [], "body": [] }
            ]
        }),
        serde_json::json!({
            "version": 2,
            "avgBodyLen": 1.0,
            "docCount": 2,
            "df": [["alpha", 0]],
            "docs": [
                { "id": "src/a.ts#alpha", "name": [["alpha", 1]], "path": [], "body": [] },
                { "id": "src/b.ts#beta", "name": [["beta", 1]], "path": [], "body": [] }
            ]
        }),
    ];

    for bad_sidecar in cases {
        let tmp = tempdir().expect("tempdir");
        let ctx = tmp.path().join("graft");
        write_json(&ctx.join(".graph/wiring.json"), &minimal_two_node_graph());
        write_json(&ctx.join(".cache/ask-index.json"), &bad_sidecar);

        assert!(
            read_ask_index(&ctx)
                .expect("read_ask_index should not error")
                .is_none(),
            "malformed DF sidecar must be rejected"
        );
        let store = GraphStore::open_or_sync(&ctx)
            .expect("open_or_sync must fall back instead of aborting")
            .expect("store exists");
        drop(store);

        let res = run_ask(tmp.path(), &ctx, "alpha", &default_ask_opts(5))
            .expect("ask succeeds via graph fallback");
        assert_eq!(res.mode, AskMode::Lexical);
        assert_eq!(res.hits.len(), 1);
        assert_eq!(res.hits[0].pointer, "src/a.ts:L1-L4");
    }
}

#[test]
fn s2_malformed_ask_index_negative_avg_overflow_and_i64_max_falls_back_cleanly() {
    let over_i64 = (i64::MAX as u64) + 1;
    let cases = [
        // Negative avgBodyLen.
        serde_json::json!({
            "version": 2,
            "avgBodyLen": -1.5,
            "docCount": 2,
            "df": [["alpha", 1]],
            "docs": [
                { "id": "src/a.ts#alpha", "name": [["alpha", 1]], "path": [], "body": [] },
                { "id": "src/b.ts#beta", "name": [["beta", 1]], "path": [], "body": [] }
            ]
        }),
        // Single count exceeding i64::MAX.
        serde_json::json!({
            "version": 2,
            "avgBodyLen": 1.0,
            "docCount": 2,
            "df": [["alpha", 1]],
            "docs": [
                { "id": "src/a.ts#alpha", "name": [["alpha", over_i64]], "path": [], "body": [] },
                { "id": "src/b.ts#beta", "name": [["beta", 1]], "path": [], "body": [] }
            ]
        }),
        // Duplicate term frequencies overflowing i64::MAX / usize::MAX when merged.
        serde_json::json!({
            "version": 2,
            "avgBodyLen": 1.0,
            "docCount": 2,
            "df": [["alpha", 1]],
            "docs": [
                {
                    "id": "src/a.ts#alpha",
                    "name": [["alpha", 1]],
                    "path": [],
                    "body": [["alpha", i64::MAX], ["alpha", i64::MAX]]
                },
                { "id": "src/b.ts#beta", "name": [["beta", 1]], "path": [], "body": [] }
            ]
        }),
        // Zero term frequency in cached postings.
        serde_json::json!({
            "version": 2,
            "avgBodyLen": 1.0,
            "docCount": 2,
            "df": [["alpha", 1]],
            "docs": [
                { "id": "src/a.ts#alpha", "name": [["alpha", 0]], "path": [], "body": [] },
                { "id": "src/b.ts#beta", "name": [["beta", 1]], "path": [], "body": [] }
            ]
        }),
    ];

    for bad_sidecar in cases {
        let tmp = tempdir().expect("tempdir");
        let ctx = tmp.path().join("graft");
        write_json(&ctx.join(".graph/wiring.json"), &minimal_two_node_graph());
        write_json(&ctx.join(".cache/ask-index.json"), &bad_sidecar);

        assert!(
            read_ask_index(&ctx)
                .expect("read_ask_index should not error")
                .is_none(),
            "overflowing/negative sidecar must be rejected"
        );
        let res = run_ask(tmp.path(), &ctx, "alpha", &default_ask_opts(5))
            .expect("ask must recover via graph-derived index");
        assert_eq!(res.mode, AskMode::Lexical);
        assert_eq!(res.hits.len(), 1);
        assert_eq!(res.hits[0].pointer, "src/a.ts:L1-L4");
    }
}

fn build_many_callers_graph() -> serde_json::Value {
    let mut nodes = vec![serde_json::json!({
        "id": "src/core.ts#coreFn",
        "name": "coreFn",
        "kind": "function",
        "path": "src/core.ts",
        "span": "L1-L5",
        "signature": "function coreFn()",
        "exported": true,
        "origin": "ast",
        "body_hash": "core"
    })];
    let mut edges = Vec::new();

    // Mixed-case paths to verify JS locale order ('a' < 'A' < 'b') + duplicate edges + multi-relation tie.
    let special = [
        ("src/b.ts#callB", "callB", "src/b.ts", "L1-L2"),
        ("src/A.ts#callUpperA", "callUpperA", "src/A.ts", "L1-L2"),
        ("src/a.ts#callLowerA", "callLowerA", "src/a.ts", "L1-L2"),
    ];
    for (id, name, path, span) in special {
        nodes.push(serde_json::json!({
            "id": id,
            "name": name,
            "kind": "function",
            "path": path,
            "span": span,
            "summary": format!("Summary for {name}\nsecond line ignored"),
            "exported": true,
            "origin": "ast",
            "body_hash": name
        }));
        edges.push(serde_json::json!({
            "source": id,
            "target": "src/core.ts#coreFn",
            "relation": "calls",
            "confidence": "certain"
        }));
    }
    // Duplicate (source, relation) edge should deduplicate cleanly.
    edges.push(serde_json::json!({
        "source": "src/a.ts#callLowerA",
        "target": "src/core.ts#coreFn",
        "relation": "calls",
        "confidence": "certain"
    }));
    // Second distinct relation on src/a.ts#callLowerA must follow 'calls' via MIN(seq).
    edges.push(serde_json::json!({
        "source": "src/a.ts#callLowerA",
        "target": "src/core.ts#coreFn",
        "relation": "references",
        "confidence": "certain"
    }));
    // Dangling edge whose source node is absent from `nodes` (tests LEFT JOIN fallback).
    edges.push(serde_json::json!({
        "source": "a_dangling_caller",
        "target": "src/core.ts#coreFn",
        "relation": "calls",
        "confidence": "certain"
    }));

    // Add 40 additional callers so total matching edges far exceed `limit`.
    for i in 0..40 {
        let id = format!("src/z_{i:02}.ts#caller{i:02}");
        nodes.push(serde_json::json!({
            "id": id,
            "name": format!("caller{i:02}"),
            "kind": "function",
            "path": format!("src/z_{i:02}.ts"),
            "span": "L1-L3",
            "signature": format!("function caller{i:02}()"),
            "exported": true,
            "origin": "ast",
            "body_hash": format!("h{i}")
        }));
        edges.push(serde_json::json!({
            "source": id,
            "target": "src/core.ts#coreFn",
            "relation": "calls",
            "confidence": "certain"
        }));
    }

    serde_json::json!({
        "meta": { "nodeCount": nodes.len(), "edgeCount": edges.len() },
        "nodes": nodes,
        "edges": edges,
        "unresolvedCalls": []
    })
}

#[test]
fn s3_structural_retrieval_is_bounded_joined_and_preserves_locale_and_seq_order() {
    let tmp = tempdir().expect("tempdir");
    let ctx = tmp.path().join("graft");
    write_json(&ctx.join(".graph/wiring.json"), &build_many_callers_graph());

    let store = GraphStore::open_or_sync(&ctx)
        .expect("open store")
        .expect("store exists");
    let mut subject_ids = HashSet::new();
    subject_ids.insert("src/core.ts#coreFn".to_string());

    // Direct store-level bounded check: returns at most `limit` rows with `matched_any = true`.
    let (matched_any, bounded) = store
        .structural_hits_bounded(&subject_ids, false, 5)
        .expect("bounded structural query");
    assert!(matched_any);
    assert_eq!(bounded.len(), 5);

    // Zero-limit check: still reports `matched_any = true` with 0 rows.
    let (matched_zero, empty_rows) = store
        .structural_hits_bounded(&subject_ids, false, 0)
        .expect("zero-limit structural query");
    assert!(matched_zero);
    assert!(empty_rows.is_empty());

    // End-to-end `run_ask` structural ordering check.
    let res = run_ask(tmp.path(), &ctx, "who calls coreFn", &default_ask_opts(5))
        .expect("structural ask");
    assert_eq!(res.mode, AskMode::Structural);
    assert_eq!(res.hits.len(), 5);
    let pairs: Vec<(&str, &str)> = res
        .hits
        .iter()
        .map(|h| (h.pointer.as_str(), h.relation.as_deref().unwrap_or("")))
        .collect();
    assert_eq!(
        pairs,
        vec![
            ("a_dangling_caller", "calls"),
            ("src/a.ts:L1-L2", "calls"),
            ("src/a.ts:L1-L2", "references"),
            ("src/A.ts:L1-L2", "calls"),
            ("src/b.ts:L1-L2", "calls"),
        ]
    );
    assert_eq!(res.hits[0].title, "a_dangling_caller");
    assert_eq!(res.hits[0].snippet, "");
    assert_eq!(res.hits[1].snippet, "Summary for callLowerA");
}
