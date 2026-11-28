//! Behaviour tests for `file_rank` (`rank_files_bounded`, `round_robin_queues`,
//! `file_first_round_robin` and `combine_comparable_scopes`).

use std::collections::HashMap;

use gg_query::file_rank::{
    FileRankCandidate, ScopedDoc, combine_comparable_scopes, file_first_round_robin,
    rank_files_bounded, round_robin_queues,
};

fn cand(id: &str, file: &str, raw_lex: f64, lex: f64, base: f64) -> FileRankCandidate {
    FileRankCandidate {
        seq: 0,
        id: id.to_string(),
        file: file.to_string(),
        is_file_node: false,
        raw_lexical: raw_lex,
        lexical: lex,
        graph: 0.0,
        rank_factor: 1.0,
        baseline_score: base,
        baseline_tie_key: id.to_string(),
        matched_terms: Vec::new(),
        matched_strong_terms: Vec::new(),
        eligible: true,
        span_start: 10,
    }
}

fn sdoc(id: &str, scope: &str, score: f64) -> ScopedDoc {
    ScopedDoc {
        seq: 0,
        id: id.to_string(),
        scope: scope.to_string(),
        score,
    }
}

#[test]
fn rank_files_bounded_skips_invalid_and_promotes_pooled_anchor() {
    let weights = HashMap::from([
        ("alpha".to_string(), 0.5),
        ("beta".to_string(), 0.5),
        ("zero".to_string(), 0.0),
    ]);
    let mut a = cand("f#a", "src/pool.rs", 2.0, 0.4, 0.4);
    a.matched_terms = vec!["alpha".into(), "missing".into(), "zero".into()];
    a.matched_strong_terms = vec!["alpha".into()];
    let mut b = cand("f#b", "src/pool.rs", 1.0, 0.2, 0.3);
    b.matched_terms = vec!["beta".into()];
    let empty_file = cand("x#1", "", 1.0, 0.5, 0.5);
    let zero_base = cand("x#2", "src/drop.rs", 1.0, 0.5, 0.0);
    let nan_base = cand("x#3", "src/drop.rs", 1.0, 0.5, f64::NAN);

    let out = rank_files_bounded(&[empty_file, zero_base, nan_base, b, a], &weights);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].representative.id, "f#a");
    assert!((out[0].score - 0.55).abs() < 1e-9);
    assert!((out[0].union_coverage - 1.0).abs() < 1e-9);
    assert!((out[0].union_strong_coverage - 0.5).abs() < 1e-9);
}

#[test]
fn rank_files_bounded_breaks_anchor_and_file_ties_and_handles_zero_union_cov() {
    let weights = HashMap::from([("hi".to_string(), 0.8), ("lo".to_string(), 0.2)]);
    let mut d1 = cand("z#1", "src/tie.rs", 2.0, 0.5, 0.6);
    d1.matched_terms = vec!["lo".into()];
    let mut d2 = cand("b#2", "src/tie.rs", 2.0, 0.5, 0.6);
    d2.matched_terms = vec!["hi".into()];
    d2.span_start = 20;
    let mut d3 = cand("a#3", "src/tie.rs", 2.0, 0.5, 0.6);
    d3.matched_terms = vec!["hi".into()];
    d3.span_start = 10;
    let mut d4 = cand("a#0", "src/tie.rs", 2.0, 0.5, 0.6);
    d4.matched_terms = vec!["hi".into()];
    d4.span_start = 10;

    let res = rank_files_bounded(&[d1, d2, d3, d4], &weights);
    assert_eq!(res[0].representative.id, "a#0");

    let mut u1 = cand("same", "b.rs", 1.0, 0.5, 0.8);
    u1.matched_terms = vec!["unweighted".into()];
    let mut u2 = cand("same", "a.rs", 1.0, 0.5, 0.8);
    u2.matched_terms = vec!["unweighted".into()];
    let tied = rank_files_bounded(&[u1, u2], &weights);
    assert_eq!(tied[0].file, "a.rs");
    assert_eq!(tied[1].file, "b.rs");
    assert_eq!(tied[0].union_coverage, 0.0);
}

#[test]
fn round_robin_and_file_first_project_in_group_order() {
    assert!(round_robin_queues(&[vec![1, 2]], 0).is_empty());
    assert!(file_first_round_robin(&[("a".to_string(), 1)], 0).is_empty());

    let items = vec![
        ("a".to_string(), 1),
        ("a".to_string(), 2),
        ("b".to_string(), 3),
        ("a".to_string(), 4),
    ];
    assert_eq!(file_first_round_robin(&items, 3), vec![1, 3, 2]);
}

#[test]
fn combine_comparable_scopes_handles_empty_single_and_multi_scope_fusion() {
    let empty = combine_comparable_scopes(&[sdoc("a", "s1", 0.0), sdoc("b", "s1", -1.0)]);
    assert!(empty.ranked.is_empty());
    assert!(empty.federated.is_empty());

    let single = combine_comparable_scopes(&[sdoc("b", "s1", 2.0), sdoc("a", "s1", 2.0)]);
    assert_eq!(single.federated, vec!["s1"]);
    assert_eq!(single.ranked[0].id, "a");

    let multi = combine_comparable_scopes(&[
        sdoc("top_b", "s1", 4.0),
        sdoc("top_a", "s1", 4.0),
        sdoc("shared_keep", "s1", 3.0),
        sdoc("shared_replace", "s1", 1.0),
        sdoc("shared_keep", "s2", 2.0),
        sdoc("shared_replace", "s2", 2.0),
        sdoc("tie_id", "s2", 4.0),
        sdoc("weak", "s3", 0.5),
    ]);
    assert_eq!(multi.federated, vec!["s1", "s2"]);
    assert_eq!(multi.also_matched.len(), 1);
    assert_eq!(multi.also_matched[0].scope, "s3");
    assert_eq!(multi.also_matched[0].best_id, "weak");
    assert_eq!(multi.ranked[0].id, "top_a");
    assert_eq!(multi.ranked[0].score, 1.0);
    assert_eq!(multi.ranked[1].id, "top_b");
    assert_eq!(multi.ranked[2].id, "tie_id");
    let replaced = multi
        .ranked
        .iter()
        .find(|d| d.id == "shared_replace")
        .unwrap();
    assert_eq!(replaced.scope, "s2");
    assert!((replaced.score - 0.5).abs() < 1e-9);
}
