//! Declaration-change detection, pre-image reconstruction and fallback parity tests.

use gg_query::blast::diff::{ChangeStatus, ChangedFile, LineRange};
use gg_query::store::GraphStore;
use serde_json::json;
use tempfile::TempDir;

use crate::helpers::{build_store, file_node, hunk, modified, run_blast, sym_node};

fn reflow_store() -> (TempDir, GraphStore) {
    let files = [
        (
            "src/reflow.ts",
            "export function add(\n  a: number,\n  b: number,\n): number {\n  return a + b;\n}\n",
        ),
        (
            "src/drop_export.ts",
            "function dropExport(a: number): number {\n  return a;\n}\n",
        ),
        (
            "src/del_inside.ts",
            "export function delBlank(\n  a: number,\n): number {\n  return a;\n}\n",
        ),
    ];
    let graph = json!({
        "meta": { "nodeCount": 0, "edgeCount": 0 },
        "nodes": [
            file_node("src/reflow.ts", "L1-L6"),
            sym_node("add", "add", "function", "src/reflow.ts", "L1-L6", Some("function add(a: number, b: number): number")),
            file_node("src/drop_export.ts", "L1-L3"),
            sym_node("drop_exp", "dropExport", "function", "src/drop_export.ts", "L1-L3", Some("function dropExport(a: number): number")),
            file_node("src/del_inside.ts", "L1-L5"),
            sym_node("del_blank", "delBlank", "function", "src/del_inside.ts", "L1-L5", Some("function delBlank(a: number): number")),
        ],
        "edges": [], "unresolvedCalls": []
    });
    build_store(&files, &[], &graph)
}

#[test]
fn blast_declaration_reflow_and_body_deletion_are_not_changes() {
    let (tmp, store) = reflow_store();
    let lines = [
        ("-", "export function add(a: number, b: number): number {"),
        ("+", "export function add("),
        ("+", "  a: number,"),
        ("+", "  b: number,"),
        ("+", "): number {"),
    ];
    let reflow = run_blast(
        &store,
        tmp.path(),
        vec![modified(
            "src/reflow.ts",
            &[(1, 4)],
            vec![hunk(1, 4, &lines)],
        )],
        1,
        false,
        false,
    );
    assert!(!reflow.seeds[0].declaration_changed);

    let body_del = run_blast(
        &store,
        tmp.path(),
        vec![modified(
            "src/reflow.ts",
            &[(4, 4)],
            vec![hunk(4, 4, &[("-", "  const dead = 0;")])],
        )],
        1,
        false,
        false,
    );
    assert!(!body_del.seeds[0].declaration_changed);
}

#[test]
fn blast_declaration_moved_unchanged_is_not_a_change() {
    let (tmp, store) = reflow_store();
    let added_lines = [
        ("+", "export function add("),
        ("+", "  a: number,"),
        ("+", "  b: number,"),
        ("+", "): number {"),
        ("+", "  return a + b;"),
        ("+", "}"),
    ];
    let added = ChangedFile {
        path: "src/reflow.ts".to_string(),
        status: ChangeStatus::Added,
        old_path: None,
        ranges: vec![LineRange { start: 1, end: 6 }],
        hunks: vec![hunk(1, 6, &added_lines)],
    };
    let removed = modified(
        "src/old.ts",
        &[(3, 3)],
        vec![hunk(
            3,
            3,
            &[("-", "export function add(a: number, b: number): number {")],
        )],
    );
    let moved = run_blast(&store, tmp.path(), vec![added, removed], 1, false, false);
    assert!(!moved.seeds[0].declaration_changed);
}

#[test]
fn blast_declaration_dropped_export_keyword_is_a_change() {
    let (tmp, store) = reflow_store();
    let lines = [
        ("-", "export function dropExport(a: number): number {"),
        ("+", "function dropExport(a: number): number {"),
    ];
    let drop_exp = run_blast(
        &store,
        tmp.path(),
        vec![modified(
            "src/drop_export.ts",
            &[(1, 1)],
            vec![hunk(1, 1, &lines)],
        )],
        1,
        false,
        false,
    );
    assert!(drop_exp.seeds[0].declaration_changed);
}

#[test]
fn blast_declaration_pure_deletion_inside_wrapped_signature() {
    let (tmp, store) = reflow_store();
    let del_blank = run_blast(
        &store,
        tmp.path(),
        vec![modified(
            "src/del_inside.ts",
            &[(1, 1)],
            vec![hunk(1, 1, &[("-", "")])],
        )],
        1,
        false,
        false,
    );
    assert!(!del_blank.seeds[0].declaration_changed);

    let del_param = run_blast(
        &store,
        tmp.path(),
        vec![modified(
            "src/del_inside.ts",
            &[(2, 2)],
            vec![hunk(2, 2, &[("-", "  b: number,")])],
        )],
        1,
        false,
        false,
    );
    assert!(del_param.seeds[0].declaration_changed);
}

fn wide_and_fallback_store() -> (TempDir, GraphStore) {
    let files = [
        (
            "src/wide.ts",
            "// banner\nexport function wide(\n  a: number,\n  b: number,\n): number {\n  return a + b;\n}\n",
        ),
        (
            "src/generic.ts",
            "export function make(\n  cb: (x: number) => void,\n  b: number,\n): void {\n  cb(b);\n}\nexport function split\n(\n  a: number,\n) {}\nexport function unclosed(\n  a: number\n",
        ),
        (
            "src/fallbacks.ts",
            "   \nexport function noSig(a: number) { return a; }\n",
        ),
    ];
    let graph = json!({
        "meta": { "nodeCount": 0, "edgeCount": 0 },
        "nodes": [
            file_node("src/wide.ts", "L1-L7"),
            sym_node("wide", "wide", "function", "src/wide.ts", "L2-L7", Some("function wide(a: number, b: number): number")),
            file_node("src/generic.ts", "L1-L12"),
            sym_node("make", "make", "function", "src/generic.ts", "L1-L6", Some("function make(")),
            sym_node("split", "split", "function", "src/generic.ts", "L7-L10", Some("function split(")),
            sym_node("unclosed", "unclosed", "function", "src/generic.ts", "L11-L12", Some("function unclosed(")),
            file_node("src/fallbacks.ts", "L1-L20"),
            sym_node("blank_first", "blankFirst", "function", "src/fallbacks.ts", "L1-L1", None),
            sym_node("no_sig", "noSig", "function", "src/fallbacks.ts", "L2-L2", None),
            sym_node("past_eof", "pastEof", "function", "src/fallbacks.ts", "L10-L12", None),
            sym_node("bad_span", "badSpan", "function", "src/fallbacks.ts", "invalid", None),
            file_node("src/missing.ts", "L1-L3"),
            sym_node("missing_fn", "missingFn", "function", "src/missing.ts", "L1-L3", Some("function missingFn()")),
        ],
        "edges": [], "unresolvedCalls": []
    });
    build_store(&files, &[], &graph)
}

#[test]
fn blast_declaration_wide_hunks_reconstruct_pre_image() {
    let (tmp, store) = wide_and_fallback_store();
    let h1 = hunk(
        1,
        2,
        &[
            ("-", "// old"),
            ("-", "export function wide("),
            ("+", "// banner"),
            ("+", "export function wide("),
        ],
    );
    let h2 = hunk(
        4,
        6,
        &[
            ("-", "  b: number,"),
            ("-", "): number {"),
            ("-", "  return a + b + 0;"),
            ("+", "  b: number,"),
            ("+", "): number {"),
            ("+", "  return a + b;"),
        ],
    );
    let wide = run_blast(
        &store,
        tmp.path(),
        vec![modified("src/wide.ts", &[(1, 2), (4, 6)], vec![h1, h2])],
        1,
        false,
        false,
    );
    assert!(!wide.seeds[0].declaration_changed);
}

#[test]
fn blast_declaration_generic_unclosed_signatures() {
    let (tmp, store) = wide_and_fallback_store();
    let changed = vec![modified(
        "src/generic.ts",
        &[(3, 3), (8, 8), (11, 11)],
        Vec::new(),
    )];
    let generic = run_blast(&store, tmp.path(), changed, 1, false, false);
    for id in ["make", "split", "unclosed"] {
        assert!(
            generic
                .seeds
                .iter()
                .any(|s| s.id == id && s.declaration_changed),
            "{id}"
        );
    }
}

#[test]
fn blast_declaration_fallbacks_blank_no_sig_eof_and_missing() {
    let (tmp, store) = wide_and_fallback_store();
    let h_nosig = hunk(
        2,
        2,
        &[
            ("-", "export function noSig() { return 1; }"),
            ("+", "export function noSig(a: number) { return a; }"),
        ],
    );
    let changed = vec![
        modified(
            "src/fallbacks.ts",
            &[(1, 1), (2, 2), (10, 10)],
            vec![
                hunk(1, 1, &[("-", "  "), ("+", "   ")]),
                h_nosig,
                hunk(10, 10, &[("+", "// tail")]),
            ],
        ),
        modified("src/missing.ts", &[(1, 1)], Vec::new()),
    ];
    let fb = run_blast(&store, tmp.path(), changed, 1, false, false);
    let is_decl = |id: &str| {
        fb.seeds
            .iter()
            .find(|s| s.id == id)
            .unwrap()
            .declaration_changed
    };
    assert!(!is_decl("blank_first"));
    assert!(is_decl("no_sig"));
    assert!(is_decl("past_eof"));
    assert!(is_decl("missing_fn"));
}

#[test]
fn blast_declaration_invalid_span_with_seed_all_is_false() {
    let (tmp, store) = wide_and_fallback_store();
    let bad = run_blast(
        &store,
        tmp.path(),
        vec![modified("src/fallbacks.ts", &[], Vec::new())],
        1,
        false,
        true,
    );
    assert!(
        !bad.seeds
            .iter()
            .find(|s| s.id == "bad_span")
            .unwrap()
            .declaration_changed
    );
}
