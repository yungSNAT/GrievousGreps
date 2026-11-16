//! The scorer's rules, carried over from benchmark/test/score.test.mjs, and the table bytes and
//! answers the JavaScript scorer gave for the same fixtures.

use std::collections::HashMap;
use std::path::Path;

use gg_bench::run::{read_json, read_truth};
use gg_bench::score::{
    Chain, Entry, Repo, Row, Rules, Summary, SymbolScore, Undercount, detail_table, overall_line,
    pool, recall_table, satisfies, score_symbol, span_contains, summarise, two,
};
use serde_json::{Value, json};

fn row(file: &str, chain: &str, lines: &[i64]) -> Row {
    Row {
        file: file.into(),
        chain: Chain::Text(chain.into()),
        lines: Some(lines.to_vec()),
    }
}

fn names(file: &str, chain: &[&str]) -> Row {
    Row {
        file: file.into(),
        chain: Chain::Names(chain.iter().map(|&name| name.into()).collect()),
        lines: None,
    }
}

fn truth() -> Entry {
    Entry {
        target: "src/a.py".into(),
        target_lines: vec![10],
        required: vec![
            row("src/b.py", "caller", &[5]),
            row("src/c.py", "<file>", &[1]),
        ],
        optional: vec![],
    }
}

fn definition() -> Value {
    json!({ "path": "src/a.py", "span": "L10-L20" })
}

fn in_caller() -> Value {
    json!({ "id": "src/b.py#caller", "path": "src\\b.py", "span": "L4-L6" })
}

fn in_file() -> Value {
    json!({ "id": "src/c.py", "path": "src/c.py" })
}

fn score(result: &Value) -> SymbolScore {
    score_symbol(&truth(), result, Rules::Span).unwrap()
}

#[test]
fn a_span_holds_a_line_only_inside_its_range() {
    assert!(span_contains(Some(&json!("L4-L6")), &[5]));
    assert!(!span_contains(Some(&json!("L4-L6")), &[7]));
    assert!(!span_contains(None, &[5]));
}

#[test]
fn a_hit_needs_the_file_and_the_call_line_or_only_the_file_for_a_module_level_row() {
    let t = truth();
    assert!(satisfies(&in_caller(), &t.required[0], Rules::Span).unwrap());
    let elsewhere = json!({ "id": "src/b.py#caller", "path": "src\\b.py", "span": "L7-L9" });
    assert!(!satisfies(&elsewhere, &t.required[0], Rules::Span).unwrap());
    assert!(satisfies(&in_file(), &t.required[1], Rules::Span).unwrap());
}

#[test]
fn hits_under_another_definition_of_the_name_do_not_count() {
    let result = json!({ "matches": [{ "symbol": { "path": "src/other.py", "span": "L10-L20" }, "hits": [in_caller(), in_file()] }] });
    assert_eq!(score(&result).found, 0);
}

#[test]
fn a_miss_is_stated_only_by_the_targets_own_unresolved_field_or_shared_name_note() {
    let short = |fields: Value| {
        let mut found = json!({ "symbol": definition(), "hits": [in_caller()] });
        found
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        json!({ "matches": [found] })
    };
    assert_eq!(score(&short(json!({}))).undercount, Undercount::Silent);
    assert_eq!(
        score(&short(
            json!({ "unresolved": "⚠ may be incomplete: 1 call(s)" })
        ))
        .undercount,
        Undercount::Stated
    );
    let shared = json!({ "note": "no indexed callers. 2 definitions share the name; so this may undercount." });
    assert_eq!(score(&short(shared)).undercount, Undercount::Stated);
    assert_eq!(
        score(&short(
            json!({ "note": "no indexed callers. Check the name" })
        ))
        .undercount,
        Undercount::Silent
    );
    let homonym = json!({ "symbol": { "path": "src/other.py", "span": "L1-L2" }, "hits": [], "note": "so this may undercount.", "unresolved": "did not resolve" });
    let elsewhere = json!({ "matches": [short(json!({}))["matches"][0].clone(), homonym] });
    assert_eq!(score(&elsewhere).undercount, Undercount::Silent);
    let complete = json!({ "matches": [{ "symbol": definition(), "hits": [in_caller(), in_file()], "unresolved": "did not resolve" }] });
    assert_eq!(score(&complete).undercount, Undercount::None);
    // A null field is still the field.
    assert_eq!(
        score(&short(json!({ "unresolved": null }))).undercount,
        Undercount::Stated
    );
}

#[test]
fn a_reported_caller_outside_the_truth_lowers_precision() {
    let stray = json!({ "id": "src/d.py#other", "path": "src/d.py", "span": "L1-L2" });
    let one = score(
        &json!({ "matches": [{ "symbol": definition(), "hits": [in_caller(), in_file(), stray] }] }),
    );
    let summary = summarise(&[one]);
    assert_eq!(summary.recall, 1.0);
    assert_eq!(summary.precision, Some(2.0 / 3.0));
    assert_eq!(summary.perfect, 0);
}

fn tally(found: usize, required: usize, reported: usize, undercount: Undercount) -> SymbolScore {
    SymbolScore {
        found,
        required,
        reported,
        missed: vec![row("x", "y", &[1])],
        false_positives: vec![],
        undercount,
    }
}

#[test]
fn recall_pools_calls_across_symbols_and_macro_recall_weighs_symbols_equally() {
    let summary = summarise(&[
        tally(9, 10, 9, Undercount::Silent),
        tally(0, 1, 0, Undercount::Stated),
    ]);
    assert_eq!(summary.recall, 9.0 / 11.0);
    assert_eq!(summary.macro_recall, 0.45);
    assert_eq!((summary.silent, summary.stated), (1, 1));
}

fn summary(found: usize, required: usize, good: usize, reported: usize, silent: usize) -> Summary {
    Summary {
        symbols: 10,
        found,
        required,
        recall: found as f64 / required as f64,
        macro_recall: 0.625,
        good,
        reported,
        precision: (reported != 0).then(|| good as f64 / reported as f64),
        silent,
        stated: 2,
        perfect: 7,
    }
}

fn repo(name: &str, repository: &str, sha: &str, language: &str) -> Repo {
    Repo {
        name: name.into(),
        repository: repository.into(),
        sha: sha.into(),
        language: language.into(),
        rules: Rules::Span,
    }
}

#[test]
fn the_table_shows_the_upstream_column_only_when_a_baseline_ran() {
    let repos = [repo("r", "o/r", "abcdef0123", "Rust")];
    let rows = HashMap::from([("r".to_owned(), summary(1, 2, 1, 1, 0))]);
    assert!(recall_table(&repos, Some(&rows), &rows).contains("Upstream"));
    assert!(!recall_table(&repos, None, &rows).contains("Upstream"));
}

#[test]
fn chain_rules_need_every_part_of_the_qualified_name_in_the_chain() {
    let r = names("src/b.py", &["Outer", "inner"]);
    let hit = |id: &str| json!({ "id": id, "path": "src/b.py" });
    assert!(satisfies(&hit("src/b.py#Outer.inner"), &r, Rules::Chain).unwrap());
    assert!(satisfies(&hit("src/b.py#inner"), &r, Rules::Chain).unwrap());
    assert!(!satisfies(&hit("src/b.py#Other.inner"), &r, Rules::Chain).unwrap());
    assert!(!satisfies(&hit("src/b.py"), &r, Rules::Chain).unwrap());
    let import = Row {
        file: "src/b.py".into(),
        chain: Chain::Text("<import>".into()),
        lines: None,
    };
    assert!(satisfies(&hit("src/b.py"), &import, Rules::Chain).unwrap());
    // Overload marks and `::` separate names as `.` does.
    assert!(satisfies(&hit("src/b.py#Outer::inner~2"), &r, Rules::Chain).unwrap());
}

#[test]
fn names_rules_need_any_part_of_the_qualified_name_in_the_row() {
    let r = names("src/b.rs", &["run"]);
    let hit = json!({ "id": "src/b.rs#Flask.run~2", "name": "run", "path": "src/b.rs" });
    assert!(satisfies(&hit, &r, Rules::Names).unwrap());
    let other = json!({ "id": "src/b.rs#other", "name": "other", "path": "src/b.rs" });
    assert!(!satisfies(&other, &r, Rules::Names).unwrap());
    let file_row = Row {
        file: "src/b.rs".into(),
        chain: Chain::Text("<file>".into()),
        lines: None,
    };
    assert!(
        satisfies(
            &json!({ "id": "src/b.rs", "name": "run", "path": "src/b.rs" }),
            &file_row,
            Rules::Names
        )
        .unwrap()
    );
}

#[test]
fn chain_and_names_rules_match_the_target_by_file_alone_and_honour_optional_rows() {
    let entry = Entry {
        target: "src/a.py".into(),
        target_lines: vec![],
        required: vec![names("src/b.py", &["caller"])],
        optional: vec![Row {
            file: "src/c.py".into(),
            chain: Chain::Text("<import>".into()),
            lines: None,
        }],
    };
    let hits = json!([{ "id": "src/b.py#caller", "path": "src/b.py" }, { "id": "src/c.py", "path": "src/c.py" }]);
    let s = score_symbol(
        &entry,
        &json!({ "matches": [{ "symbol": { "path": "src/a.py" }, "hits": hits }] }),
        Rules::Chain,
    )
    .unwrap();
    assert_eq!(s.found, 1);
    assert_eq!(s.false_positives.len(), 0);
}

#[test]
fn the_overall_line_pools_calls_and_carries_both_builds() {
    let a = Summary {
        stated: 0,
        ..summary(1, 4, 1, 2, 1)
    };
    let b = Summary {
        stated: 1,
        ..summary(3, 4, 3, 3, 0)
    };
    assert_eq!(pool(&[a.clone(), b.clone()]).recall, 0.5);
    assert!(overall_line(Some(&[a]), std::slice::from_ref(&b)).contains("recall 0.25 to 0.75"));
    assert!(overall_line(None, &[b]).contains("recall 0.75"));
}

#[test]
fn every_pinned_repository_has_10_symbols_and_well_formed_truth() {
    let bench = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../benchmark");
    let repos: Vec<Repo> = read_json(&bench.join("repos.json")).unwrap();
    assert_eq!(repos.len(), 21);
    for repo in &repos {
        assert!(
            repo.sha.len() == 40
                && repo
                    .sha
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "{}",
            repo.name
        );
        let symbols = read_truth(&bench, &repo.name).unwrap();
        assert_eq!(symbols.len(), 10, "{}", repo.name);
        for (name, entry) in &symbols {
            assert!(!entry.target.is_empty(), "{name}");
            let span = repo.rules == Rules::Span;
            assert!(!span || !entry.target_lines.is_empty(), "{name}");
            assert!(!entry.required.is_empty(), "{name}");
            for row in &entry.required {
                assert!(
                    !row.file.is_empty() && row.chain != Chain::Text(String::new()),
                    "{name}"
                );
                assert!(
                    !span || row.lines.as_ref().is_some_and(|lines| !lines.is_empty()),
                    "{name}"
                );
            }
        }
    }
}

// What benchmark/score.mjs printed for these fixtures, byte for byte.

fn pair() -> (
    [Repo; 2],
    HashMap<String, Summary>,
    HashMap<String, Summary>,
) {
    let repos = [
        repo("a", "o/a", "abcdef0123456789", "Rust"),
        repo("b", "o/b", "0123456789abcdef", "TypeScript"),
    ];
    let upstream = HashMap::from([
        ("a".to_owned(), summary(1, 8, 1, 2, 1)),
        ("b".to_owned(), summary(0, 3, 0, 0, 1)),
    ]);
    let patched = HashMap::from([
        ("a".to_owned(), summary(5, 8, 5, 6, 1)),
        ("b".to_owned(), summary(3, 3, 3, 3, 0)),
    ]);
    (repos, upstream, patched)
}

#[test]
fn the_tables_and_lines_are_the_javascript_scorers_bytes() {
    let (repos, upstream, patched) = pair();
    let list = |map: &HashMap<String, Summary>| vec![map["a"].clone(), map["b"].clone()];
    assert_eq!(
        overall_line(Some(&list(&upstream)), &list(&patched)),
        "**Overall, upstream to patched:** recall 0.09 to 0.73 (2 repositories and 8 of 11 calls on the patched build), precision 0.50 to 0.89, silent undercounts 2 to 1."
    );
    assert_eq!(
        overall_line(None, &list(&patched)),
        "**Overall:** recall 0.73 (2 repositories and 8 of 11 calls), precision 0.89, silent undercounts 1."
    );
    assert_eq!(
        recall_table(&repos, Some(&upstream), &patched),
        "| Repository | Language | Calls in truth | Upstream | Patched |\n| --- | --- | --- | --- | --- |\n| o/a @ abcdef0 | Rust | 8 | 0.13 | 0.63 |\n| o/b @ 0123456 | TypeScript | 3 | 0.00 | 1.00 |"
    );
    assert_eq!(
        recall_table(&repos, None, &patched),
        "| Repository | Language | Calls in truth | Patched |\n| --- | --- | --- | --- |\n| o/a @ abcdef0 | Rust | 8 | 0.63 |\n| o/b @ 0123456 | TypeScript | 3 | 1.00 |"
    );
    assert_eq!(
        detail_table(&repos, "Upstream", &upstream),
        "Upstream:\n| Repository | Recall | Macro recall | Precision | Silent | Stated | Perfect |\n| --- | --- | --- | --- | --- | --- | --- |\n| a | 1/8 = 0.13 | 0.63 | 1/2 = 0.50 | 1 | 2 | 7/10 |\n| b | 0/3 = 0.00 | 0.63 | 0/0 = n/a | 1 | 2 | 7/10 |"
    );
}

#[test]
fn two_decimals_round_an_exact_half_up_as_javascript_does() {
    let fixed: Vec<String> = [
        0.125,
        0.375,
        0.625,
        0.875,
        1.0 / 3.0,
        2.0 / 3.0,
        0.005,
        1.005,
        0.995,
        2.125,
    ]
    .into_iter()
    .map(|x| two(Some(x)))
    .collect();
    assert_eq!(
        fixed,
        [
            "0.13", "0.38", "0.63", "0.88", "0.33", "0.67", "0.01", "1.00", "0.99", "2.13"
        ]
    );
    assert_eq!(two(None), "n/a");
    assert_eq!(two(Some(f64::NAN)), "NaN");
}

#[test]
fn a_repeated_hit_keeps_its_first_place_and_its_last_fields() {
    let entry = Entry {
        target: "src/a.py".into(),
        target_lines: vec![10],
        required: vec![row("src/b.py", "f", &[5])],
        optional: vec![],
    };
    let result = json!({ "matches": [
        { "symbol": definition(), "hits": [{ "id": "src/x.py#one", "path": "src/x.py", "span": "L1-L2" }, { "id": "src/b.py#f", "path": "src/b.py", "span": "L4-L6" }] },
        { "symbol": definition(), "hits": [{ "id": "src/x.py#one", "path": "src/x.py", "span": "L7-L9", "name": "last" }, { "id": "src/y.py#two", "path": "src/y.py", "span": "L1" }] },
    ] });
    let s = score_symbol(&entry, &result, Rules::Span).unwrap();
    assert_eq!(
        (s.found, s.required, s.reported, s.undercount),
        (1, 1, 3, Undercount::None)
    );
    assert_eq!(
        s.false_positives,
        [
            json!({ "id": "src/x.py#one", "path": "src/x.py", "span": "L7-L9", "name": "last" }),
            json!({ "id": "src/y.py#two", "path": "src/y.py", "span": "L1" })
        ]
    );
}

#[test]
fn an_answer_the_scorer_cannot_read_is_an_error_not_a_zero() {
    let pathless =
        json!({ "matches": [{ "symbol": definition(), "hits": [{ "id": "src/b.py#caller" }] }] });
    assert!(
        score_symbol(&truth(), &pathless, Rules::Span)
            .unwrap_err()
            .contains("`path`")
    );
    let symbolless = json!({ "matches": [{ "hits": [] }] });
    assert!(score_symbol(&truth(), &symbolless, Rules::Span).is_err());
    assert!(score_symbol(&truth(), &json!({ "matches": "none" }), Rules::Span).is_err());
    // No matches at all is a readable answer with nothing found.
    assert_eq!(
        score_symbol(&truth(), &json!({ "matches": null }), Rules::Span)
            .unwrap()
            .found,
        0
    );
}
