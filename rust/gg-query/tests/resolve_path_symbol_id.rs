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
        node("pkg.v2/mod.py#run", "run"),
        node("pkg/a.py#Cls~2.get~3", "get"),
        node("docs/c#/x.cs#Foo", "Foo"),
        node("Ünï/Модуль.py#Функция~2.Ζ~3", "Ζ"),
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
    // A tail starts at a path segment, never after a dot inside one.
    assert!(ids("py#helper", None).is_empty());
    assert!(ids("v2/mod.py#run", None).is_empty());
    assert_eq!(ids("pkg.v2/mod.py#run", None), ["pkg.v2/mod.py#run"]);
    // Every ordinal or none: a partly numbered id finds nothing.
    assert_eq!(ids("pkg/a.py#Cls~2.get~3", None), ["pkg/a.py#Cls~2.get~3"]);
    assert_eq!(ids("pkg/a.py#Cls.get", None), ["pkg/a.py#Cls~2.get~3"]);
    assert!(ids("pkg/a.py#Cls~2.get", None).is_empty());
    // A path pasted with Windows separators.
    assert_eq!(
        ids("pkg\\util.py#helper", None),
        ["pkg/util.py#helper", "pkg/util.py#helper~2"]
    );
    assert!(ids("pkg\\nope.py#get", None).is_empty());
    // A path holding `#`, pasted either way, and a tail of it.
    assert_eq!(ids("docs\\c#\\x.cs#Foo", None), ["docs/c#/x.cs#Foo"]);
    assert_eq!(ids("c#/x.cs#foo", None), ["docs/c#/x.cs#Foo"]);
    // Non-ASCII case folding, with ordinals on 2 segments.
    assert_eq!(
        ids("ÜNÏ/модуль.py#ФУНКЦИЯ.ζ", None),
        ["Ünï/Модуль.py#Функция~2.Ζ~3"]
    );
    assert_eq!(
        ids("ünï/модуль.py#функция~2.ζ~3", None),
        ["Ünï/Модуль.py#Функция~2.Ζ~3"]
    );
    assert!(ids("pkg/util.py#helper", Some("other")).is_empty());
}
