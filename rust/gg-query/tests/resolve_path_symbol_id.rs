//! A `path#symbol` id, or its tail from a path segment, as a symbol query (`resolve_symbol`), matching
//! `src/graph/traverse.ts::resolveSymbol`.

use std::fs;
use std::path::Path;

use gg_query::store::GraphStore;
use tempfile::tempdir;

fn write_graph(ctx: &Path, json: &serde_json::Value) {
    let dir = ctx.join(".graph");
    fs::create_dir_all(&dir).expect("mkdir .graph");
    fs::write(dir.join("wiring.json"), json.to_string()).expect("write wiring.json");
}

fn node(id: &str, name: &str) -> serde_json::Value {
    let path = id.split('#').next().unwrap_or(id);
    serde_json::json!({"id":id,"name":name,"kind":"function","path":path,"span":"L1-L2","signature":null,"exported":true,"origin":"ast","body_hash":id})
}

#[test]
fn path_symbol_id_names_its_nodes_and_takes_no_fallback() {
    let tmp = tempdir().expect("tempdir");
    let ctx = tmp.path().join("graft");
    let nodes = [
        node("pkg/util.py#helper", "helper"),
        node("pkg/util.py#helper~2", "helper"),
        node("other/util.py#helper", "helper"),
        node("pkg/util.py#Cls.get", "get"),
        node("pkg/x.py#get", "get"),
    ];
    write_graph(
        &ctx,
        &serde_json::json!({
            "meta": { "nodeCount": nodes.len(), "edgeCount": 0 },
            "nodes": nodes,
            "edges": [],
            "unresolvedCalls": []
        }),
    );
    let store = GraphStore::open_or_sync(&ctx)
        .expect("open")
        .expect("store");
    let ids = |q: &str, in_prefix: Option<&str>| {
        let mut v: Vec<String> = store
            .resolve_symbol(q, in_prefix)
            .expect("resolve")
            .into_iter()
            .map(|n| n.id)
            .collect();
        v.sort();
        v
    };
    assert_eq!(
        ids("pkg/util.py#helper", None),
        ["pkg/util.py#helper", "pkg/util.py#helper~2"]
    );
    assert_eq!(ids("pkg/util.py#helper~2", None), ["pkg/util.py#helper~2"]);
    assert_eq!(
        ids("PKG/Util.py#HELPER", None),
        ["pkg/util.py#helper", "pkg/util.py#helper~2"]
    );
    assert_eq!(
        ids("util.py#helper", None),
        [
            "other/util.py#helper",
            "pkg/util.py#helper",
            "pkg/util.py#helper~2"
        ]
    );
    assert_eq!(ids("pkg/util.py#Cls.get", None), ["pkg/util.py#Cls.get"]);
    // A stale or partial id finds nothing, never every node sharing its last segment.
    assert!(ids("pkg/nope.py#get", None).is_empty());
    assert!(ids("kg/util.py#helper", None).is_empty());
    assert!(ids("pkg/util.py#helper", Some("other")).is_empty());
}
