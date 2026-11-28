//! Left-behind caller detection parity tests (`blast::left_behind`).

use serde_json::{Value, json};

use crate::helpers::{build_store, edge, file_node, method_node, modified, run_blast, sym_node};

fn call_shapes_graph() -> Value {
    json!({
        "meta": { "nodeCount": 0, "edgeCount": 0 },
        "nodes": [
            file_node("src/def.ts", "L1-L3"),
            sym_node("alpha", "alpha", "function", "src/def.ts", "L1-L1", Some("function alpha(a: number, b: number)")),
            sym_node("widget", "Widget", "function", "src/def.ts", "L2-L2", Some("function Widget(p: number)")),
            sym_node("empty_name", "", "function", "src/def.ts", "L3-L3", None),
            file_node("src/callers.ts", "L1-L22"),
            sym_node("shapes", "shapes", "function", "src/callers.ts", "L1-L5", None),
            sym_node("non_calls", "nonCallsAndTwoCalls", "function", "src/callers.ts", "L6-L13", None),
            sym_node("m_unedited", "mentionUnedited", "function", "src/callers.ts", "L14-L16", None),
            sym_node("m_edited", "mentionEdited", "function", "src/callers.ts", "L17-L19", None),
            sym_node("alias_c", "aliasCaller", "function", "src/callers.ts", "L20-L22", None),
            sym_node("bad_caller", "badCaller", "function", "src/callers.ts", "bad-span", None),
            file_node("src/short.ts", "L1-L1"),
            sym_node("short_c", "shortCaller", "function", "src/short.ts", "L5-L8", None),
            file_node("src/missing_caller.ts", "L1-L3"),
            sym_node("miss_edited", "missEdited", "function", "src/missing_caller.ts", "L1-L3", None),
        ],
        "edges": [
            edge("shapes", "alpha", "calls", "extracted"),
            edge("non_calls", "alpha", "calls", "extracted"),
            edge("m_unedited", "widget", "calls", "extracted"),
            edge("m_edited", "widget", "calls", "extracted"),
            edge("alias_c", "alpha", "calls", "extracted"),
            edge("alias_c", "empty_name", "calls", "extracted"),
            edge("bad_caller", "alpha", "calls", "extracted"),
            edge("short_c", "alpha", "calls", "extracted"),
            edge("miss_edited", "alpha", "calls", "extracted"),
        ],
        "unresolvedCalls": []
    })
}

const CALL_SHAPES_FILES: [(&str, &str); 3] = [
    (
        "src/def.ts",
        concat!(
            "export function alpha(a: number, b: number) { return a + b; }\n",
            "export function Widget(p: number) { return p; }\n",
            "export function blank() {}\n",
        ),
    ),
    (
        "src/callers.ts",
        concat!(
            "export function shapes() {\n",
            "  alpha!(1, 2);\n",
            "  alpha?.(1, 2);\n",
            "  alpha<Array<number>>(1, 2);\n",
            "}\n",
            "export function nonCallsAndTwoCalls() {\n",
            "  const bad = my_alpha(1) && alpha < (1) > (2) && alpha < 9;\n",
            "  alpha(\n    f(1),\n    2,\n  );\n",
            "  return alpha<string>(3);\n",
            "}\n",
            "export function mentionUnedited() {\n",
            "  return [re_Widget, Widget];\n",
            "}\n",
            "export function mentionEdited() {\n",
            "  return Widget;\n",
            "}\n",
            "export function aliasCaller() {\n",
            "  return runRef();\n",
            "}\n",
        ),
    ),
    ("src/short.ts", "const onlyOneLine = 1;\n"),
];

#[test]
fn blast_left_behind_call_shapes_mentions_and_fallbacks() {
    let (tmp, store) = build_store(&CALL_SHAPES_FILES, &[], &call_shapes_graph());
    let changed = vec![
        modified("src/def.ts", &[(1, 3)], Vec::new()),
        modified("src/callers.ts", &[(2, 4), (10, 10), (18, 18)], Vec::new()),
        modified("src/missing_caller.ts", &[(2, 2)], Vec::new()),
    ];
    let r = run_blast(&store, tmp.path(), changed, 1, false, false);
    let got: Vec<(&str, Option<usize>, &str, &str)> = r
        .left_behind
        .iter()
        .map(|l| {
            (
                l.path.as_str(),
                l.line,
                l.name.as_str(),
                l.seed.name.as_str(),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            ("src/callers.ts", None, "aliasCaller", ""),
            ("src/callers.ts", None, "aliasCaller", "alpha"),
            ("src/callers.ts", None, "badCaller", "alpha"),
            ("src/callers.ts", Some(12), "nonCallsAndTwoCalls", "alpha"),
            ("src/callers.ts", Some(15), "mentionUnedited", "Widget"),
            ("src/short.ts", None, "shortCaller", "alpha"),
        ]
    );
}

fn constructors_and_sort_graph() -> Value {
    json!({
        "meta": { "nodeCount": 0, "edgeCount": 0 },
        "nodes": [
            file_node("src/def.ts", "L1-L7"),
            sym_node("alpha", "alpha", "function", "src/def.ts", "L1-L1", Some("function alpha(a: number)")),
            sym_node("zeta", "zeta", "function", "src/def.ts", "L2-L2", Some("function zeta(x: number)")),
            sym_node("box_cls", "Box", "class", "src/def.ts", "L3-L7", None),
            method_node("box_ctor", "constructor", Some("Box"), "src/def.ts", "L4-L4", Some("constructor(v: number)")),
            method_node("orphan_ctor", "constructor", None, "src/def.ts", "L5-L5", None),
            method_node("unmatched_ctor", "constructor", Some("MissingClass"), "src/def.ts", "L6-L6", None),
            file_node("src/shop.py", "L1-L3"),
            sym_node("cart_cls", "Cart", "class", "src/shop.py", "L1-L3", None),
            method_node("cart_init", "__init__", Some("Cart"), "src/shop.py", "L2-L3", Some("def __init__(self, items)")),
            file_node("src/callers.ts", "L1-L9"),
            sym_node("dup_c", "dupCaller", "function", "src/callers.ts", "L1-L3", None),
            sym_node("both_c", "bothOnOneLine", "function", "src/callers.ts", "L4-L6", None),
            sym_node("same_c", "zSameLine", "function", "src/callers.ts", "L4-L6", None),
            sym_node("box_c", "buildBox", "function", "src/callers.ts", "L7-L9", None),
            file_node("src/use.py", "L1-L2"),
            sym_node("make", "make", "function", "src/use.py", "L1-L2", None),
        ],
        "edges": [
            edge("alpha", "alpha", "calls", "extracted"),
            edge("dup_c", "alpha", "references", "extracted"),
            edge("dangling_src", "alpha", "calls", "extracted"),
            edge("dup_c", "alpha", "calls", "inferred"),
            edge("dup_c", "alpha", "calls", "extracted"),
            edge("dup_c", "alpha", "calls", "inferred"),
            edge("both_c", "zeta", "calls", "extracted"),
            edge("both_c", "alpha", "calls", "extracted"),
            edge("same_c", "alpha", "calls", "extracted"),
            edge("box_c", "box_cls", "calls", "extracted"),
            edge("make", "cart_cls", "calls", "extracted"),
        ],
        "unresolvedCalls": []
    })
}

const CTOR_FILES: [(&str, &str); 4] = [
    (
        "src/def.ts",
        concat!(
            "export function alpha(a: number) { return a; }\n",
            "export function zeta(x: number) { return x; }\n",
            "export class Box {\n  constructor(v: number) {}\n  // orphan\n  // unmatched\n}\n",
        ),
    ),
    (
        "src/shop.py",
        "class Cart:\n    def __init__(self, items):\n        self.items = items\n",
    ),
    (
        "src/callers.ts",
        concat!(
            "export function dupCaller() {\n  return alpha(1);\n}\n",
            "export function bothOnOneLine() {\n  return zeta(1) + alpha(1);\n}\n",
            "export function buildBox() {\n  return new Box(1);\n}\n",
        ),
    ),
    ("src/use.py", "def make():\n    return Cart()\n"),
];

#[test]
fn blast_left_behind_constructors_dedup_and_sort_order() {
    let (tmp, store) = build_store(&CTOR_FILES, &[], &constructors_and_sort_graph());
    let changed = vec![
        modified("src/def.ts", &[(1, 6)], Vec::new()),
        modified("src/shop.py", &[(2, 2)], Vec::new()),
    ];
    let r = run_blast(&store, tmp.path(), changed, 1, false, false);
    let got: Vec<(&str, Option<usize>, &str, &str, bool)> = r
        .left_behind
        .iter()
        .map(|l| {
            (
                l.path.as_str(),
                l.line,
                l.name.as_str(),
                l.seed.name.as_str(),
                l.inferred,
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            ("src/callers.ts", Some(2), "dupCaller", "alpha", false),
            ("src/callers.ts", Some(5), "bothOnOneLine", "alpha", false),
            ("src/callers.ts", Some(5), "bothOnOneLine", "zeta", false),
            ("src/callers.ts", Some(5), "zSameLine", "alpha", false),
            ("src/callers.ts", Some(8), "buildBox", "constructor", false),
            ("src/use.py", Some(2), "make", "__init__", false),
        ]
    );
}
