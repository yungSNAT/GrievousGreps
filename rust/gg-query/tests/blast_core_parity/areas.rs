//! Concepts, seeding, multi-file hit merging, module grouping, area coarsening,
//! unresolved calls, test reach and error propagation tests for `blast::mod` & `blast::areas`.

use gg_query::blast::types::{LabelSource, TestSignal};
use gg_query::blast::{BlastOptions, compute_blast_report};
use rusqlite::Connection;
use serde_json::{Value, json};

use crate::helpers::{build_store, deleted, edge, file_node, modified, run_blast, sym_node};

fn concepts_and_seeding_graph() -> Value {
    json!({
        "meta": { "nodeCount": 0, "edgeCount": 0 },
        "nodes": [
            file_node("src/a.ts", "L1-L8"), file_node("src/c.ts", "L1-L3"),
            file_node("src/d.ts", "L1-L2"), file_node("pkg/x.ts", "L1-L3"),
            file_node("pkg/y.ts", "L1-L3"), file_node("deploy/Dockerfile", "L1-L2"),
            sym_node("foo", "foo", "function", "src/a.ts", "L1-L3", Some("function foo()")),
            sym_node("bad_span", "badSpan", "function", "src/a.ts", "not-a-span", None),
            sym_node("cls", "Cls", "class", "src/a.ts", "L4-L8", None),
            sym_node("method", "run", "method", "src/a.ts", "L5-L7", Some("run()")),
            sym_node("dep_c", "depC", "function", "src/c.ts", "L1-L3", None),
            sym_node("px", "px", "function", "pkg/x.ts", "L1-L3", None),
            sym_node("py", "py", "function", "pkg/y.ts", "L1-L3", None),
            sym_node("df", "stage", "resource", "deploy/Dockerfile", "L1-L2", None),
        ],
        "edges": [edge("dep_c", "foo", "calls", "extracted")],
        "unresolvedCalls": []
    })
}

const CONCEPT_DOCS: [(&str, &str); 5] = [
    (
        "00-empty.md",
        "---\nname: \"\"\nsources:\n  - path: src/a.ts\n---\nignored\n",
    ),
    (
        "01-broad.md",
        "---\nname: Broad Platform\nsources:\n  - path: src/a.ts\n  - path: src/c.ts\n  - path: src/d.ts\n---\nbroad\n",
    ),
    (
        "02-narrow.md",
        "---\nname: \"Concept: Core Engine via Incremental Cache\"\nsources:\n  - path: src/c.ts\n---\nnarrow\n",
    ),
    (
        "03-wider.md",
        "---\nname: Whole Repo\nsources:\n  - path: src/a.ts\n  - path: src/c.ts\n  - path: src/d.ts\n  - path: pkg/x.ts\n---\nwider\n",
    ),
    (
        "04-pkg-x.md",
        "---\nname: Pkg X Only\nsources:\n  - path: pkg/x.ts\n---\npartial\n",
    ),
];

const SEEDING_FILES: [(&str, &str); 2] = [
    (
        "src/a.ts",
        "export function foo() {\n  return 1;\n}\nexport class Cls {\n  run() {\n    return 2;\n  }\n}\n",
    ),
    ("deploy/Dockerfile", "FROM alpine\nUSER nobody\n"),
];

#[test]
fn blast_concepts_smallest_wins_and_seeding_rules() {
    let (tmp, store) = build_store(&SEEDING_FILES, &CONCEPT_DOCS, &concepts_and_seeding_graph());
    let changed = vec![
        modified("src/a.ts", &[(1, 1), (2, 2), (6, 6)], Vec::new()),
        modified("src/d.ts", &[], Vec::new()),
        modified("pkg/x.ts", &[(1, 1)], Vec::new()),
        modified("pkg/y.ts", &[(1, 1)], Vec::new()),
        modified("deploy/Dockerfile", &[(1, 1)], Vec::new()),
        deleted("src/deleted.ts"),
        modified("docs/unindexed.md", &[(1, 1)], Vec::new()),
    ];
    let r = run_blast(&store, tmp.path(), changed, 2, false, false);
    assert_eq!(r.deleted, vec!["src/deleted.ts"]);
    assert_eq!(r.unindexed, vec!["docs/unindexed.md"]);
    let ids: Vec<&str> = r.seeds.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids.iter().filter(|&&id| id == "foo").count(), 1);
    assert!(ids.contains(&"method") && !ids.contains(&"cls"));
    assert!(r.seeds.iter().any(|s| s.id == "f:src/d.ts" && s.whole_file));
    assert!(
        r.seeds
            .iter()
            .any(|s| s.id == "df" && s.declaration_changed)
    );
    assert_eq!(r.modules.len(), 1);
    assert_eq!(r.modules[0].label, "Core Engine");
    assert_eq!(r.modules[0].label_source, LabelSource::Concept);
    let src_area = r.areas.iter().find(|a| a.key == "src/").unwrap();
    assert_eq!(src_area.label, "Broad Platform");
    assert_eq!(src_area.label_source, LabelSource::Concept);
    let pkg_area = r.areas.iter().find(|a| a.key == "pkg/").unwrap();
    assert_eq!(pkg_area.label_source, LabelSource::Symbol);
}

fn multi_file_merge_graph() -> Value {
    json!({
        "meta": { "nodeCount": 0, "edgeCount": 0 },
        "nodes": [
            file_node("src/a.ts", "L1-L3"), file_node("src/b.ts", "L1-L3"),
            file_node("src/c.ts", "L1-L5"), file_node("mod1/u.ts", "L1-L4"),
            file_node("mod2/v.ts", "L1-L4"), file_node("test/a.test.ts", "L1-L3"),
            file_node("test/b.test.ts", "L1-L3"), file_node("test/c.test.ts", "L1-L3"),
            sym_node("foo", "foo", "function", "src/a.ts", "L1-L3", None),
            sym_node("bar", "bar", "function", "src/b.ts", "L1-L3", None),
            sym_node("mid", "mid", "function", "src/c.ts", "L1-L2", None),
            sym_node("dep_depth", "depDepth", "function", "src/c.ts", "L3-L5", None),
            sym_node("dep_conf", "depConf", "function", "mod1/u.ts", "L1-L2", None),
            sym_node("dep_keep", "depKeep", "function", "mod1/u.ts", "L3-L4", None),
            sym_node("dep_extra", "depExtra", "function", "mod1/u.ts", "L5-L6", None),
            sym_node("dep_tie", "depTie", "function", "mod2/v.ts", "L1-L2", None),
            sym_node("dep_tie2", "depTie2", "function", "mod2/v.ts", "L3-L4", None),
            sym_node("ta", "testA", "function", "test/a.test.ts", "L1-L3", None),
            sym_node("tb", "testB", "function", "test/b.test.ts", "L1-L3", None),
            sym_node("tc", "testC", "function", "test/c.test.ts", "L1-L3", None),
        ],
        "edges": [
            edge("ghost", "foo", "calls", "extracted"),
            edge("mid", "foo", "calls", "extracted"),
            edge("dep_depth", "mid", "calls", "extracted"),
            edge("dep_depth", "bar", "calls", "extracted"),
            edge("dep_conf", "foo", "calls", "inferred"),
            edge("dep_conf", "bar", "calls", "extracted"),
            edge("dep_keep", "foo", "calls", "extracted"),
            edge("dep_keep", "bar", "calls", "inferred"),
            edge("dep_extra", "foo", "calls", "extracted"),
            edge("dep_tie", "foo", "calls", "extracted"),
            edge("dep_tie2", "bar", "calls", "extracted"),
            edge("bar", "foo", "calls", "extracted"),
            edge("ta", "foo", "calls", "extracted"),
            edge("tb", "bar", "calls", "inferred"),
            edge("tc", "foo", "calls", "extracted"),
        ],
        "unresolvedCalls": [
            { "name": "foo", "source": "s1" }, { "name": "unrelated", "source": "s2" },
            { "name": "bar", "source": "s3" }, { "name": "foo", "source": "s4" }
        ]
    })
}

#[test]
fn blast_multi_file_merge_modules_and_unresolved() {
    let (tmp, store) = build_store(&[], &[], &multi_file_merge_graph());
    let changed = vec![
        modified("src/a.ts", &[(1, 1)], Vec::new()),
        modified("src/b.ts", &[(1, 1)], Vec::new()),
        modified("test/a.test.ts", &[(1, 1)], Vec::new()),
    ];
    let r = run_blast(&store, tmp.path(), changed, 2, false, false);

    assert!(!r.impacted.iter().any(|i| i.id == "ghost"));
    assert_eq!(
        r.impacted
            .iter()
            .find(|i| i.id == "dep_depth")
            .unwrap()
            .depth,
        1
    );
    assert!(
        !r.impacted
            .iter()
            .find(|i| i.id == "dep_conf")
            .unwrap()
            .inferred
    );
    let keep = r.impacted.iter().find(|i| i.id == "dep_keep").unwrap();
    assert_eq!((keep.depth, keep.inferred), (1, false));

    assert!(
        !r.modules
            .iter()
            .any(|m| m.files.iter().any(|f| f == "src/b.ts"))
    );
    let labels: Vec<&str> = r.modules.iter().map(|m| m.label.as_str()).collect();
    assert_eq!(labels, vec!["depConf", "depTie", "mid"]);
    assert_eq!(r.modules[0].from, vec!["src/a.ts", "src/b.ts"]);
    assert_eq!(
        r.test_modules[0].files,
        vec!["test/b.test.ts", "test/c.test.ts"]
    );

    let unres: Vec<(&str, usize)> = r
        .unresolved
        .iter()
        .map(|u| (u.name.as_str(), u.calls))
        .collect();
    assert_eq!(unres, vec![("foo", 2), ("bar", 1)]);
}

fn coarsen_existing_parent_graph() -> Value {
    json!({
        "meta": { "nodeCount": 0, "edgeCount": 0 },
        "nodes": [
            file_node("src/a/x.ts", "L1-L3"), file_node("src/a/deep/y.ts", "L1-L3"),
            file_node("src/b/x.ts", "L1-L3"), file_node("src/c/x.ts", "L1-L3"),
            file_node("src/d/x.ts", "L1-L3"), file_node("src/e/x.ts", "L1-L3"),
            file_node("m1/u.ts", "L1-L3"), file_node("m2/v.ts", "L1-L3"),
            file_node("test/a.test.ts", "L1-L3"), file_node("test/b.test.ts", "L1-L3"),
            sym_node("fa", "fa", "function", "src/a/x.ts", "L1-L3", None),
            sym_node("fdeep", "fdeep", "function", "src/a/deep/y.ts", "L1-L3", None),
            sym_node("fb", "fb", "function", "src/b/x.ts", "L1-L3", None),
            sym_node("fc", "fc", "function", "src/c/x.ts", "L1-L3", None),
            sym_node("mu", "mu", "function", "m1/u.ts", "L1-L3", None),
            sym_node("mv", "mv", "function", "m2/v.ts", "L1-L3", None),
            sym_node("ta", "ta", "function", "test/a.test.ts", "L1-L3", None),
            sym_node("tb", "tb", "function", "test/b.test.ts", "L1-L3", None),
        ],
        "edges": [
            edge("mu", "fb", "calls", "extracted"), edge("mv", "fb", "calls", "extracted"),
            edge("mu", "fa", "calls", "extracted"), edge("ta", "fa", "calls", "extracted"),
            edge("tb", "fb", "calls", "extracted"),
        ],
        "unresolvedCalls": []
    })
}

#[test]
fn blast_areas_coarsen_existing_parent_sort_and_signals() {
    let concepts = [(
        "a-area.md",
        "---\nname: Billing Core\nsources:\n  - path: src/a/x.ts\n  - path: src/a/deep/y.ts\n---\nbody\n",
    )];
    let (tmp, store) = build_store(&[], &concepts, &coarsen_existing_parent_graph());
    let changed = vec![
        modified("src/a/x.ts", &[(1, 1)], Vec::new()),
        modified("src/a/x.ts", &[(1, 1)], Vec::new()),
        modified("src/a/deep/y.ts", &[(1, 1)], Vec::new()),
        modified("src/b/x.ts", &[(1, 1)], Vec::new()),
        modified("src/c/x.ts", &[(1, 1)], Vec::new()),
        modified("src/d/x.ts", &[], Vec::new()),
        modified("src/e/x.ts", &[], Vec::new()),
        modified("test/a.test.ts", &[(1, 1)], Vec::new()),
    ];
    let r = run_blast(&store, tmp.path(), changed, 1, false, false);

    assert_eq!(r.areas.len(), 5);
    assert_eq!(
        (r.areas[0].key.as_str(), r.areas[0].tests),
        ("src/b/", TestSignal::Stale)
    );
    assert_eq!(r.areas[1].key, "src/a/");
    assert_eq!(
        (r.areas[1].label.as_str(), r.areas[1].label_source),
        ("Billing Core", LabelSource::Concept)
    );
    assert_eq!(r.areas[1].files, vec!["src/a/deep/y.ts", "src/a/x.ts"]);
    assert_eq!(r.areas[1].tests, TestSignal::Changed);
    assert_eq!(r.areas[1].changed_test_files, vec!["test/a.test.ts"]);
    assert_eq!(
        (r.areas[2].key.as_str(), r.areas[2].tests),
        ("src/c/", TestSignal::None)
    );
    assert_eq!(
        (r.areas[3].tests, r.areas[4].tests),
        (TestSignal::Na, TestSignal::Na)
    );
}

#[test]
fn blast_areas_coarsen_new_parent_and_top_level_stop() {
    let dirs = ["a", "b", "c", "d", "e", "f", "g"];
    let nodes: Vec<Value> = dirs
        .iter()
        .map(|d| file_node(&format!("lib/{d}/x.ts"), "L1-L2"))
        .collect();
    let (tmp, store) = build_store(
        &[],
        &[],
        &json!({ "meta": { "nodeCount": 0, "edgeCount": 0 }, "nodes": nodes, "edges": [] }),
    );
    let changed = dirs
        .iter()
        .map(|d| modified(&format!("lib/{d}/x.ts"), &[], Vec::new()))
        .collect();
    let r = run_blast(&store, tmp.path(), changed, 1, false, false);
    assert_eq!(r.areas.len(), 5);
    assert_eq!(r.areas.iter().map(|a| a.files.len()).sum::<usize>(), 7);
    assert_eq!(
        (r.areas[0].key.as_str(), r.areas[0].files.len()),
        ("lib/", 3)
    );

    let top = ["a", "b", "c", "d", "e", "f"];
    let top_nodes: Vec<Value> = top
        .iter()
        .map(|d| file_node(&format!("{d}/x.ts"), "L1-L2"))
        .collect();
    let (tmp2, store2) = build_store(
        &[],
        &[],
        &json!({ "meta": { "nodeCount": 0, "edgeCount": 0 }, "nodes": top_nodes, "edges": [] }),
    );
    let changed2 = top
        .iter()
        .map(|d| modified(&format!("{d}/x.ts"), &[], Vec::new()))
        .collect();
    let r2 = run_blast(&store2, tmp2.path(), changed2, 1, false, false);
    assert_eq!(r2.areas.len(), 6);
}

fn tests_reached_graph() -> Value {
    json!({
        "meta": { "nodeCount": 0, "edgeCount": 0 },
        "nodes": [
            file_node("src/a.ts", "L1-L3"), file_node("src/mid.ts", "L1-L3"),
            file_node("test/edited.test.ts", "L1-L3"), file_node("test/direct.test.ts", "L1-L8"),
            file_node("test/importer.test.ts", "L1-L3"), file_node("test/deep.test.ts", "L1-L3"),
            sym_node("a", "a", "function", "src/a.ts", "L1-L3", None),
            sym_node("mid", "mid", "function", "src/mid.ts", "L1-L3", None),
            sym_node("t_dup1", "check", "function", "test/direct.test.ts", "L1-L2", None),
            sym_node("t_dup2", "check", "function", "test/direct.test.ts", "L3-L4", None),
            sym_node("t_alpha", "alpha", "function", "test/direct.test.ts", "L5-L6", None),
            sym_node("t_deep", "deepCheck", "function", "test/deep.test.ts", "L1-L3", None),
        ],
        "edges": [
            edge("ghost", "a", "calls", "extracted"), edge("t_dup1", "a", "calls", "inferred"),
            edge("t_dup2", "a", "calls", "extracted"), edge("t_alpha", "a", "calls", "extracted"),
            edge("f:test/importer.test.ts", "a", "imports", "extracted"),
            edge("mid", "a", "calls", "extracted"), edge("t_deep", "mid", "calls", "inferred"),
        ],
        "unresolvedCalls": []
    })
}

#[test]
fn blast_tests_reached_full_closure_dedup_file_hits_and_empty_seeds() {
    let (tmp, store) = build_store(&[], &[], &tests_reached_graph());
    let changed = vec![
        modified("src/a.ts", &[(1, 1)], Vec::new()),
        modified("test/edited.test.ts", &[(1, 1)], Vec::new()),
        deleted("test/deleted.test.ts"),
        modified("test/unindexed.test.ts", &[(1, 1)], Vec::new()),
    ];
    let r = run_blast(&store, tmp.path(), changed, 1, true, false);
    let tests = r.tests.expect("tests present");
    let summary: Vec<(&str, usize, bool, bool, Vec<&str>)> = tests
        .iter()
        .map(|t| {
            let syms = t.symbols.iter().map(String::as_str).collect();
            (t.path.as_str(), t.depth, t.changed, t.inferred, syms)
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            ("test/edited.test.ts", 0, true, false, vec![]),
            (
                "test/direct.test.ts",
                1,
                false,
                false,
                vec!["alpha", "check"]
            ),
            ("test/importer.test.ts", 1, false, false, vec![]),
            ("test/deep.test.ts", 2, false, true, vec!["deepCheck"]),
        ]
    );
    let empty = run_blast(
        &store,
        tmp.path(),
        vec![modified("docs/only.md", &[(1, 1)], Vec::new())],
        1,
        true,
        false,
    );
    assert!(empty.tests.unwrap().is_empty());
}

#[test]
fn blast_compute_propagates_store_error() {
    let graph = json!({
        "meta": { "nodeCount": 1, "edgeCount": 0 },
        "nodes": [file_node("src/a.ts", "L1-L1")],
        "edges": [], "unresolvedCalls": []
    });
    let (tmp, store) = build_store(&[], &[], &graph);
    let conn =
        Connection::open(tmp.path().join("graft/.graph/wiring.sqlite")).expect("open sqlite");
    conn.execute("DROP TABLE unresolved_calls", [])
        .expect("drop table");
    drop(conn);

    let err = compute_blast_report(
        &store,
        tmp.path(),
        &tmp.path().join("graft"),
        vec![modified("src/a.ts", &[(1, 1)], Vec::new())],
        "b".to_string(),
        &BlastOptions {
            depth: 1,
            tests: false,
            seed_all_on_empty_ranges: false,
        },
    )
    .expect_err("expected sqlite error");
    assert!(err.contains("unresolved_calls"), "unexpected error: {err}");
}
