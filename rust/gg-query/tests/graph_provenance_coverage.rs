//! Focused edge-case coverage for `graph.rs`, `provenance.rs`, and `graphrank.rs`.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;

use gg_query::format::SymbolResult;
use gg_query::graph::{
    Direction, EdgeHit, NodeV1, Savings, ScopeV1, UnresolvedCall, call_reference_line,
    is_test_path, js_locale_cmp, looks_like_filename, normalize_path_prefix, parse_depth,
    reference_line_any, scope_label, scopes_here_clause, serialize_opt_js_f64, strip_ordinals,
    symbol_matches_node, with_savings,
};
use gg_query::graphrank::{DEFAULT_ALPHA, DEFAULT_ITERS, PageRankTopology};
use gg_query::provenance::{
    Confidence, format_callers_provenance_json, format_callers_provenance_text,
};
use serde::Serialize;
use serde_json::Value;
use tempfile::tempdir;

fn mk_node(id: &str, name: &str, kind: &str, path: &str) -> NodeV1 {
    NodeV1 {
        id: id.into(),
        name: name.into(),
        kind: kind.into(),
        owner: None,
        path: path.into(),
        span: "L1-L5".into(),
        signature: None,
        exported: true,
        origin: "ast".into(),
        body_hash: "h".into(),
        chars: None,
        summary: None,
        body_text: None,
        crux: None,
    }
}

#[derive(Serialize)]
struct OptNum {
    #[serde(serialize_with = "serialize_opt_js_f64")]
    val: Option<f64>,
}

#[test]
fn direction_depth_scopes_ordinals_and_prefix_helpers() {
    let err = Direction::parse(Some("sideways")).expect_err("invalid direction");
    assert!(err.contains("sideways"));
    assert_eq!(parse_depth(Some("all"), 1).expect("all"), usize::MAX);
    assert_eq!(parse_depth(Some("FULL"), 1).expect("full"), usize::MAX);
    assert_eq!(parse_depth(Some("max"), 1).expect("max"), usize::MAX);
    assert!(parse_depth(Some("0"), 1).is_err());
    assert!(parse_depth(Some("NaN"), 1).is_err());
    assert!(parse_depth(Some("nope"), 1).is_err());

    assert_eq!(scope_label(""), "(root)");
    assert_eq!(scope_label("pkg/a"), "pkg/a/");
    let scopes = vec![
        ScopeV1 {
            prefix: String::new(),
            label: String::new(),
            markers: Vec::new(),
        },
        ScopeV1 {
            prefix: "packages/web".into(),
            label: "web".into(),
            markers: Vec::new(),
        },
    ];
    assert_eq!(
        scopes_here_clause(&scopes),
        " — scopes here: (root) · packages/web/"
    );

    assert_eq!(strip_ordinals("foo~2.bar~3"), "foo.bar");
    assert_eq!(strip_ordinals("foo~bar"), "foo~bar");
    assert_eq!(strip_ordinals("foo~2x"), "foo~2x");
    assert_eq!(normalize_path_prefix("././src/a///"), "src/a");
}

#[test]
fn filename_symbol_match_test_path_savings_locale_and_opt_f64() {
    assert!(looks_like_filename("src/a.ts"));
    assert!(looks_like_filename("foo.ts"));
    assert!(!looks_like_filename("foo.toolong"));
    assert!(!looks_like_filename("foo#bar"));
    assert!(!looks_like_filename("bare"));

    let file_node = mk_node("src/a.rs", "a.rs", "file", "src/a.rs");
    assert!(!symbol_matches_node(&file_node, "a.rs"));
    let hashless = mk_node("mod.helper", "other", "function", "src/a.rs");
    assert!(symbol_matches_node(&hashless, "helper"));
    assert!(!symbol_matches_node(&hashless, "missing"));

    assert!(is_test_path("src/foo_test.rs"));
    assert!(is_test_path("src/foo.test.ts"));
    assert!(is_test_path("src/foo.spec.js"));
    assert!(!is_test_path("src/normal.rs"));

    let zero_saved = Savings {
        files: 1,
        baseline_chars: 0,
    };
    assert_eq!(with_savings("body", Some(&zero_saved)), "body");

    assert_eq!(js_locale_cmp("K", "\u{212A}"), Ordering::Less);
    assert_eq!(js_locale_cmp("\u{212A}", "K"), Ordering::Greater);

    assert_eq!(
        serde_json::to_string(&OptNum { val: Some(2.0) }).expect("int"),
        r#"{"val":2}"#
    );
    assert_eq!(
        serde_json::to_string(&OptNum { val: Some(2.5) }).expect("frac"),
        r#"{"val":2.5}"#
    );
    assert_eq!(
        serde_json::to_string(&OptNum { val: None }).expect("none"),
        r#"{"val":null}"#
    );
}

#[test]
fn call_reference_line_handles_deploy_empty_and_import_comment_edges() {
    let tmp = tempdir().expect("tmp");
    fs::create_dir_all(tmp.path().join("src")).expect("mkdir");
    let src = concat!(
        "import { foo as bar, foo as bar } from \"a\\\"b\";\n",
        "import { foo asBar, foo as\n",
        "  other } from './c';\n",
        "import { foo as baz /* unclosed\n",
        "*/ } from './d';\n",
        "bar();\n",
    );
    fs::write(tmp.path().join("src/caller.ts"), src).expect("write");
    let mut cache = HashMap::new();

    assert!(reference_line_any(tmp.path(), "src/caller.ts", "L1-L6", &[""], &mut cache).is_none());
    assert!(call_reference_line(tmp.path(), "deploy.yaml", "L1-L2", "foo", &mut cache).is_none());
    assert!(call_reference_line(tmp.path(), "src/caller.ts", "L1-L6", "", &mut cache).is_none());

    let quote = call_reference_line(tmp.path(), "src/caller.ts", "L1-L6", "foo", &mut cache)
        .expect("should quote bar() call line");
    assert_eq!(quote.n, 6);
    assert_eq!(quote.text.trim(), "bar();");
}

#[test]
fn provenance_confidence_and_empty_callers_text() {
    assert_eq!(Confidence::parse("lsp_dispatch"), Confidence::LspDispatch);
    assert_eq!(Confidence::LspDispatch.rank(), 3);
    assert_eq!(Confidence::LspDispatch.as_str(), "lsp_dispatch");

    let sym = mk_node("src/a.ts#target", "target", "function", "src/a.ts");
    let empty_res = vec![SymbolResult {
        symbol: sym,
        hits: Vec::new(),
    }];
    let mut unresolved = HashMap::new();
    unresolved.insert(
        "target".to_string(),
        vec![UnresolvedCall {
            name: "target".into(),
            source: "src/b.ts#caller".into(),
            through: Some("obj".into()),
            file: Some("src/b.ts".into()),
        }],
    );

    let tmp = tempdir().expect("tmp");
    let out_txt = format_callers_provenance_text(
        tmp.path(),
        Direction::Out,
        false,
        &empty_res,
        &unresolved,
        None,
    );
    assert!(out_txt.contains("no indexed callees for target"));

    let in_txt = format_callers_provenance_text(
        tmp.path(),
        Direction::In,
        false,
        &empty_res,
        &unresolved,
        None,
    );
    assert!(in_txt.contains("no indexed callers for target"));
    assert!(in_txt.contains("src/b.ts#caller (through obj, in src/b.ts, which is not indexed)"));
}

#[test]
fn provenance_deep_unresolved_text_and_out_json() {
    let sym = mk_node("src/a.ts#target", "target", "function", "src/a.ts");
    let unresolved = HashMap::from([(
        "target".to_string(),
        vec![UnresolvedCall {
            name: "target".into(),
            source: "src/b.ts#caller".into(),
            through: None,
            file: Some("src/b.ts".into()),
        }],
    )]);
    let deep_unresolved = vec![SymbolResult {
        symbol: sym,
        hits: vec![EdgeHit {
            node: None,
            id: "ext/pkg".into(),
            relation: "imports".into(),
            depth: 2,
            inferred: false,
            confidence: Confidence::Extracted,
            weakest_hop: None,
        }],
    }];
    let tmp = tempdir().expect("tmp");
    let hit_txt = format_callers_provenance_text(
        tmp.path(),
        Direction::Out,
        true,
        &deep_unresolved,
        &unresolved,
        None,
    );
    assert!(hit_txt.contains("(unresolved import) [depth 2] [EXTRACTED · weakest: extracted]"));

    let out_json: Value = serde_json::from_str(&format_callers_provenance_json(
        "target",
        Direction::Out,
        &deep_unresolved,
        &unresolved,
        None,
    ))
    .expect("json");
    assert!(out_json["matches"][0].get("unresolvedCalls").is_none());
}

#[test]
fn graphrank_partitions_filter_edges_and_handle_invalid_or_infinite_seeds() {
    let partitions = [Some(0), Some(0), Some(1), Some(1), None];
    let edges = [(0, 1), (1, 2), (2, 3), (3, 4), (99, 0)];
    let topos = PageRankTopology::build_partitions(&partitions, 2, &edges);
    assert_eq!(topos.len(), 2);
    assert_eq!(topos[0].adjacency[0], vec![1]);
    assert_eq!(topos[0].adjacency[1], vec![0]);
    assert!(topos[0].adjacency[2].is_empty());
    assert_eq!(topos[1].adjacency[2], vec![3]);
    assert!(topos[1].adjacency[4].is_empty());

    let scores = topos[0].run(
        &[(99, 1.0), (2, 1.0), (0, 0.0), (1, -2.0), (0, 1.0)],
        DEFAULT_ALPHA,
        DEFAULT_ITERS,
    );
    assert!((scores[&0] - 1.0).abs() < 1e-12);
    assert!(scores[&1] > 0.0);
    assert!(!scores.contains_key(&2));

    let non_finite = topos[0].run(&[(0, f64::INFINITY)], DEFAULT_ALPHA, DEFAULT_ITERS);
    assert!(non_finite.is_empty());
}
