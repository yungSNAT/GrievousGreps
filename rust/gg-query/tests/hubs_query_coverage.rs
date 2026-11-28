//! Behaviour tests for `hubs` (`compute_hubs`, `format_hubs_text`) and `query`
//! (`row_to_node`, `resolve_symbol`, `edge_walk`, `impact_of_many`, `savings_for_paths`).

use std::fs;
use std::io::ErrorKind;

use gg_query::graph::{Direction, Savings};
use gg_query::hubs::{HubEntry, HubsReport, HubsTotals, compute_hubs, format_hubs_text};
use gg_query::store::GraphStore;
use rusqlite::Connection;
use serde_json::json;
use tempfile::tempdir;

fn open_graph(graph: serde_json::Value) -> (tempfile::TempDir, GraphStore) {
    let tmp = tempdir().unwrap();
    let ctx = tmp.path().join("graft");
    fs::create_dir_all(ctx.join(".graph")).unwrap();
    fs::write(
        ctx.join(".graph").join("wiring.json"),
        serde_json::to_string(&graph).unwrap(),
    )
    .unwrap();
    let store = GraphStore::open_or_sync(&ctx).unwrap().unwrap();
    (tmp, store)
}

fn sym(id: &str, name: &str, path: &str) -> serde_json::Value {
    json!({
        "id": id, "name": name, "kind": "function", "path": path,
        "span": "L1-L5", "signature": format!("fn {name}()"),
        "exported": true, "origin": "ast"
    })
}

fn file_node(path: &str, chars: Option<u64>) -> serde_json::Value {
    let mut v = json!({
        "id": format!("file:{path}"), "name": path.rsplit('/').next().unwrap(),
        "kind": "file", "path": path, "span": "L1-L20",
        "signature": path, "exported": false, "origin": "ast"
    });
    if let Some(c) = chars {
        v["chars"] = json!(c);
    }
    v
}

#[test]
fn compute_hubs_handles_ties_missing_sources_non_walk_edges_and_bad_prefix() {
    let (_tmp, store) = open_graph(json!({
        "meta": { "nodeCount": 7, "edgeCount": 5 },
        "nodes": [
            file_node("src/a.ts", None),
            file_node("src/b.ts", Some(120)),
            sym("src/a.ts#z", "dup", "src/a.ts"),
            sym("src/a.ts#a", "dup", "src/a.ts"),
            sym("src/b.ts#x", "dup", "src/b.ts"),
            sym("src/b.ts#y", "alpha", "src/b.ts"),
        ],
        "edges": [
            { "source": "file:src/a.ts", "target": "src/a.ts#z", "relation": "contains", "confidence": "extracted" },
            { "source": "missing#ext", "target": "src/a.ts#z", "relation": "calls", "confidence": "inferred" },
            { "source": "missing#ext", "target": "src/a.ts#a", "relation": "calls", "confidence": "inferred" },
            { "source": "missing#ext", "target": "src/b.ts#x", "relation": "calls", "confidence": "inferred" },
            { "source": "missing#ext", "target": "src/b.ts#y", "relation": "calls", "confidence": "inferred" }
        ]
    }));

    let err = compute_hubs(&store, 10, Some("missing_prefix")).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidInput);

    let rep = compute_hubs(&store, 10, None).unwrap();
    let ids: Vec<&str> = rep.hubs.iter().map(|h| h.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["src/b.ts#y", "src/a.ts#a", "src/a.ts#z", "src/b.ts#x"]
    );
}

#[test]
fn format_hubs_text_renders_empty_and_truncated_scoped_reports() {
    let empty = HubsReport {
        prefix: None,
        totals: HubsTotals {
            total_symbols: 3,
            connected_symbols: 0,
            walk_edges: 0,
            shown: 0,
            truncated: 0,
        },
        hubs: Vec::new(),
        saved: None,
    };
    let empty_txt = format_hubs_text(&empty);
    assert!(empty_txt.contains("no connected symbols in graph"));

    let full = HubsReport {
        prefix: Some("src".to_string()),
        totals: HubsTotals {
            total_symbols: 10,
            connected_symbols: 3,
            walk_edges: 5,
            shown: 1,
            truncated: 2,
        },
        hubs: vec![HubEntry {
            id: "src/a.ts#main".to_string(),
            name: "main".to_string(),
            kind: "function".to_string(),
            path: "src/a.ts".to_string(),
            span: "L1-L5".to_string(),
            pagerank: 0.75,
            in_degree: 2,
            out_degree: 1,
            total_degree: 3,
            extracted_edges: 2,
            inferred_edges: 1,
        }],
        saved: Some(Savings {
            files: 2,
            baseline_chars: 400,
        }),
    };
    let full_txt = format_hubs_text(&full);
    assert!(full_txt.contains("hubs under src/"));
    assert!(full_txt.contains("1. main (function)"));
    assert!(full_txt.contains("and 2 more connected symbol(s)"));
}

#[test]
fn resolve_symbol_covers_dot_fallback_filename_fallback_id_variants_and_bad_prefix() {
    let (_tmp, store) = open_graph(json!({
        "meta": { "nodeCount": 5, "edgeCount": 0 },
        "nodes": [
            file_node("src/util.ts", Some(100)),
            file_node("pkg/sub/deep.ts", Some(100)),
            sym("src/util.ts#helper", "helper", "src/util.ts"),
            sym("bare_no_hash", "hash#name", "src/util.ts"),
            {
                "id": "res:plain", "name": "plain", "kind": "resource",
                "path": "src/util.ts", "span": "L1-L1", "signature": "res",
                "exported": false, "origin": "deploy"
            }
        ],
        "edges": []
    }));

    assert_eq!(
        store.resolve_symbol("Unknown.helper", None).unwrap().len(),
        1
    );
    assert!(store.resolve_symbol("Unknown.", None).unwrap().is_empty());
    assert_eq!(store.resolve_symbol("util.ts", None).unwrap().len(), 1);
    assert_eq!(store.resolve_symbol("src/util.ts", None).unwrap().len(), 1);
    assert_eq!(store.resolve_symbol("sub/deep.ts", None).unwrap().len(), 1);
    assert_eq!(
        store.resolve_symbol("hash#name", None).unwrap()[0].id,
        "bare_no_hash"
    );
    assert!(store.resolve_symbol("no#match", None).unwrap().is_empty());

    let err = store
        .resolve_symbol("helper", Some("no_such_dir"))
        .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidInput);
}

#[test]
fn edge_walk_and_impact_cover_file_seeds_out_direction_dup_seeds_and_confidence_tie() {
    let (_tmp, store) = open_graph(json!({
        "meta": { "nodeCount": 6, "edgeCount": 5 },
        "nodes": [
            file_node("src/a.ts", Some(50)),
            sym("src/a.ts#s1", "s1", "src/a.ts"),
            sym("src/a.ts#s2", "s2", "src/a.ts"),
            {
                "id": "src/a.ts#res", "name": "res", "kind": "resource",
                "path": "src/a.ts", "span": "L1-L1", "signature": "res",
                "exported": false, "origin": "deploy"
            },
            sym("src/b.ts#t_keep", "t_keep", "src/b.ts"),
            sym("src/b.ts#t_upgrade", "t_upgrade", "src/b.ts"),
        ],
        "edges": [
            { "source": "src/a.ts#s1", "target": "src/b.ts#t_keep", "relation": "calls", "confidence": "inferred" },
            { "source": "src/a.ts#s2", "target": "src/b.ts#t_keep", "relation": "calls", "confidence": "inferred" },
            { "source": "src/a.ts#s1", "target": "src/b.ts#t_upgrade", "relation": "calls", "confidence": "inferred" },
            { "source": "src/a.ts#s2", "target": "src/b.ts#t_upgrade", "relation": "calls", "confidence": "extracted" },
            { "source": "src/b.ts#t_keep", "target": "src/a.ts#s1", "relation": "calls", "confidence": "extracted" }
        ]
    }));

    let fnode = store.node_by_id("file:src/a.ts").unwrap().unwrap();
    let file_hits = store.edge_walk(&fnode, Direction::In, 2).unwrap();
    assert!(file_hits.iter().any(|h| h.id == "src/b.ts#t_keep"));

    let seeds = vec![
        "src/a.ts#s1".to_string(),
        "src/a.ts#s1".to_string(),
        "src/a.ts#s2".to_string(),
    ];
    let out_hits = store.impact_of_many(&seeds, 2, Direction::Out).unwrap();
    let kept = out_hits.iter().find(|h| h.id == "src/b.ts#t_keep").unwrap();
    assert!(kept.inferred);
    let up = out_hits
        .iter()
        .find(|h| h.id == "src/b.ts#t_upgrade")
        .unwrap();
    assert!(!up.inferred);
}

#[test]
fn rejects_negative_chars_in_sqlite_node_and_savings_queries() {
    let (tmp, store) = open_graph(json!({
        "meta": { "nodeCount": 1, "edgeCount": 0 },
        "nodes": [file_node("src/neg.ts", Some(10))],
        "edges": []
    }));
    let db = tmp.path().join("graft/.graph/wiring.sqlite");
    let conn = Connection::open(&db).unwrap();
    conn.execute("UPDATE nodes SET chars = -5 WHERE path = 'src/neg.ts'", [])
        .unwrap();
    drop(conn);

    assert!(store.node_by_id("file:src/neg.ts").is_err());
    let err = store.savings_for_paths(["src/neg.ts"]).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidData);
}
