//! Behaviour tests for `format` (`format_callers_text`, `format_callers_json`,
//! `unresolved_note_for` and `format_blast_json`).

use std::collections::HashMap;
use std::path::Path;

use gg_query::format::{
    SymbolResult, format_blast_json, format_callers_json, format_callers_text, unresolved_note_for,
};
use gg_query::graph::{Direction, EdgeHit, NodeV1, UnresolvedCall};
use gg_query::provenance::Confidence;

fn node(id: &str, name: &str, path: &str, span: &str) -> NodeV1 {
    NodeV1 {
        id: id.to_string(),
        name: name.to_string(),
        kind: "function".to_string(),
        owner: None,
        path: path.to_string(),
        span: span.to_string(),
        signature: Some(format!("fn {name}()")),
        exported: true,
        origin: "ast".to_string(),
        body_hash: String::new(),
        chars: None,
        summary: None,
        body_text: None,
        crux: None,
    }
}

fn edge(id: &str, relation: &str, depth: usize, n: Option<NodeV1>, conf: Confidence) -> EdgeHit {
    EdgeHit {
        node: n,
        id: id.to_string(),
        relation: relation.to_string(),
        depth,
        inferred: conf != Confidence::Extracted,
        confidence: conf,
        weakest_hop: None,
    }
}

fn ucall(source: &str, through: Option<&str>, file: Option<&str>) -> UnresolvedCall {
    UnresolvedCall {
        name: "target".to_string(),
        source: source.to_string(),
        through: through.map(String::from),
        file: file.map(String::from),
    }
}

#[test]
fn formats_unresolved_notes_and_unresolved_import_hits_with_and_without_depth() {
    let calls = vec![
        ucall("a.ts:1", Some("imp"), Some("ext.ts")),
        ucall("b.ts:2", Some("mod"), None),
        ucall("c.ts:3", None, None),
        ucall("d.ts:4", None, None),
        ucall("e.ts:5", None, None),
        ucall("f.ts:6", None, None),
    ];
    let note = unresolved_note_for(&calls, Direction::In, "target").unwrap();
    assert!(note.contains("through imp, in ext.ts, which is not indexed"));
    assert!(note.contains("through mod)"));
    assert!(note.contains("more than one target"));
    assert!(note.contains("and 1 more"));
    assert!(unresolved_note_for(&calls, Direction::Out, "target").is_none());

    let sym = node("src/a.ts#target", "target", "src/a.ts", "L1-L5");
    let hits = vec![
        edge("ext#missing", "calls", 2, None, Confidence::Inferred),
        edge(
            "src/b.ts#caller",
            "references",
            1,
            Some(node(
                "src/b.ts#caller",
                "caller, [x]",
                "src/b: 1.ts",
                "L1-L2",
            )),
            Confidence::Extracted,
        ),
    ];
    let unres = HashMap::from([("target".to_string(), vec![ucall("z.ts:1", None, None)])]);
    let res = vec![SymbolResult { symbol: sym, hits }];

    let with_depth = format_callers_text(Path::new("."), Direction::In, true, &res, &unres, None);
    assert!(with_depth.contains("ext#missing (unresolved import) [depth 2] [inferred]"));
    assert!(with_depth.contains("references ← \"src/b: 1.ts\""));
    assert!(with_depth.contains("\"caller, [x]\" L1 [depth 1]"));
    assert!(with_depth.contains("may be incomplete"));

    let no_depth = format_callers_text(Path::new("."), Direction::Out, false, &res, &unres, None);
    assert!(no_depth.contains("calls → ext#missing (unresolved import) [inferred]"));
    assert!(!no_depth.contains("[depth"));
}

#[test]
fn formats_single_empty_result_with_loose_note() {
    let empty_one = vec![SymbolResult {
        symbol: node("src/a.ts#solo", "solo", "src/a.ts", "L1-L2"),
        hits: Vec::new(),
    }];
    let txt_one = format_callers_text(
        Path::new("."),
        Direction::In,
        false,
        &empty_one,
        &HashMap::new(),
        None,
    );
    assert!(txt_one.contains("no indexed callers"));
}

#[test]
fn formats_multi_quiet_blocks_in_text_and_json() {
    let quiet_many: Vec<SymbolResult> = [
        ("a#1", "alpha", "f1.ts"),
        ("a#2", "beta", "f2.ts"),
        ("a#3", "alpha", "f3.ts"),
        ("a#4", "alpha", "f4.ts"),
        ("a#5", "beta", "f5.ts"),
    ]
    .into_iter()
    .map(|(id, name, p)| SymbolResult {
        symbol: node(id, name, p, "L1-L2"),
        hits: Vec::new(),
    })
    .collect();
    let unres = HashMap::from([("alpha".to_string(), vec![ucall("q.ts:1", None, None)])]);

    let txt_out = format_callers_text(
        Path::new("."),
        Direction::Out,
        false,
        &quiet_many,
        &unres,
        None,
    );
    assert!(txt_out.contains("… and 2 more in 2 file(s)"));
    assert!(
        txt_out.contains(
            "no indexed callees for any of the 5 definitions named \"alpha\" or \"beta\""
        )
    );

    let txt_in = format_callers_text(
        Path::new("."),
        Direction::In,
        false,
        &quiet_many,
        &unres,
        None,
    );
    assert!(txt_in.contains("may be incomplete"));

    let json = format_callers_json("alpha", Direction::In, &quiet_many[..2], &unres, None);
    assert!(json.contains("2 definitions share the name"));
}

#[test]
fn formats_blast_json_with_resolved_and_unresolved_impacts() {
    let seed = node("src/a.ts#foo", "foo", "src/a.ts", "L1-L4");
    let impacted = vec![
        edge(
            "src/b.ts#bar",
            "calls",
            1,
            Some(node("src/b.ts#bar", "bar", "src/b.ts", "L10-L15")),
            Confidence::Extracted,
        ),
        edge("ext#dep", "imports", 2, None, Confidence::Inferred),
    ];
    let raw = format_blast_json(2, &["src/a.ts".to_string()], &[seed], &impacted).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed["depth"], 2);
    assert_eq!(parsed["seeds"][0]["name"], "foo");
    assert_eq!(parsed["impacted"][0]["name"], "bar");
    assert!(parsed["impacted"][1]["name"].is_null());
}
