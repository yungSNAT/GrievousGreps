use super::*;
use serde_json::json;

fn task(relevant: &[&str], secondary: &[&str]) -> Task {
    serde_json::from_value(json!({
        "query": "q", "category": "semantic", "relevant": relevant, "secondary": secondary
    }))
    .unwrap()
}

fn files(names: &[&str]) -> Vec<String> {
    names.iter().map(|n| (*n).to_owned()).collect()
}

#[test]
fn ndcg_is_1_when_the_relevant_files_come_first() {
    assert!((ndcg_at_k(&[1, 2], 2, TOP_K) - 1.0).abs() < 1e-12);
    assert_eq!(ndcg_at_k(&[], 2, TOP_K), 0.0);
    assert_eq!(ndcg_at_k(&[1], 0, TOP_K), 0.0);
    // One relevant file at rank 3: 1 / log2(4).
    assert!((ndcg_at_k(&[3], 1, TOP_K) - 0.5).abs() < 1e-12);
    // A rank past k counts for nothing.
    assert_eq!(ndcg_at_k(&[11], 1, TOP_K), 0.0);
}

#[test]
fn a_path_matches_its_suffix_after_a_slash_either_way() {
    assert!(path_matches("src/flask/ctx.py", "src/flask/ctx.py"));
    assert!(path_matches("ctx.py", "src/flask/ctx.py"));
    assert!(path_matches("repo/src/flask/ctx.py", "src/flask/ctx.py"));
    assert!(path_matches(r"src\flask\ctx.py", "src/flask/ctx.py"));
    assert!(!path_matches("src/flask/myctx.py", "ctx.py"));
}

#[test]
fn an_answer_gives_its_first_10_distinct_files_in_rank_order() {
    let mut hits = vec![
        json!({ "pointer": "b.py:L3" }),
        json!({ "id": "no pointer" }),
        json!({ "pointer": "a.py:L1-L9" }),
        json!({ "pointer": "b.py:L40" }),
        json!({ "pointer": "dir:Lx/c.py" }),
    ];
    hits.extend((0..12).map(|i| json!({ "pointer": format!("f{i}.py:L1") })));
    let got = answer_files(&json!({ "hits": hits }));
    // Only a trailing line suffix is cut.
    assert_eq!(got[..3], files(&["b.py", "a.py", "dir:Lx/c.py"]));
    assert_eq!(got.len(), TOP_K);
    assert!(answer_files(&json!({ "error": "x" })).is_empty());
}

#[test]
fn a_file_is_matched_under_the_benchmark_root_as_a_full_path() {
    let repo = |root: Option<&str>| SetRepo {
        name: "r".into(),
        language: "python".into(),
        url: String::new(),
        revision: String::new(),
        benchmark_root: root.map(str::to_owned),
    };
    let t = task(&["pkg/openapi/utils.py"], &[]);
    let answer =
        json!({ "hits": [{ "pointer": "utils.py:L1" }, { "pointer": "openapi/utils.py:L1" }] });
    let g = graded_answer(&repo(Some("pkg")), &t, Some(&answer));
    assert_eq!(g.first, Some(2));
    assert_eq!(g.files, files(&["utils.py", "openapi/utils.py"]));
    let t = task(&["openapi/utils.py"], &[]);
    assert_eq!(graded_answer(&repo(None), &t, Some(&answer)).first, Some(2));
}

#[test]
fn hit_ranks_count_relevant_files_and_ndcg_counts_secondary_ones_too() {
    let t = task(&["src/a.py"], &["src/b.py"]);
    let (ndcg, first) = grade(&t, &files(&["b.py", "c.py", "a.py"]));
    assert_eq!(first, Some(3));
    let ideal = 1.0 + 1.0 / 3f64.log2();
    assert!((ndcg - (1.0 + 0.5) / ideal).abs() < 1e-12);
    let (_, first) = grade(&t, &files(&["b.py"]));
    assert_eq!(first, None);
}

#[test]
fn a_target_is_a_path_or_an_object_with_one() {
    let t: Task = serde_json::from_value(json!({
        "query": "q", "category": "symbol", "relevant": [{ "path": "x.rs", "symbol": "f" }, "y.rs"], "seed": 1
    }))
    .unwrap();
    let paths: Vec<&str> = t.relevant.iter().map(Target::path).collect();
    assert_eq!(paths, ["x.rs", "y.rs"]);
    assert!(t.secondary.is_empty());
}

fn graded(first: Option<usize>, failed: bool) -> Graded {
    Graded {
        repo: "r".into(),
        language: "python".into(),
        category: "semantic".into(),
        query: "a | b".into(),
        relevant: vec!["x.py".into()],
        files: files(&["p.py", "q.py", "s.py", "x.py"]),
        ndcg: 0.5,
        first,
        failed,
    }
}

#[test]
fn the_misses_list_each_question_with_no_relevant_file_in_the_first_3() {
    let all = [
        graded(Some(1), false),
        graded(Some(4), false),
        graded(None, true),
    ];
    let out = misses(&all);
    let rows: Vec<&str> = out.lines().skip(2).collect();
    assert_eq!(
        rows,
        [
            r"| r | semantic | a \| b | 4 | x.py | p.py, q.py, s.py |",
            r"| r | semantic | a \| b | failed | x.py | p.py, q.py, s.py |",
        ]
    );
}

#[test]
fn the_table_pools_all_then_each_category_and_language() {
    let mut other = graded(Some(1), false);
    other.category = "architecture".into();
    other.ndcg = 1.0;
    let out = table(&[graded(Some(4), false), other]);
    let rows: Vec<&str> = out.lines().skip(2).collect();
    assert_eq!(
        rows,
        [
            "| All | 2 | 0.750 | 0.500 | 0.500 | 1.000 |",
            "| architecture | 1 | 1.000 | 1.000 | 1.000 | 1.000 |",
            "| semantic | 1 | 0.500 | 0.000 | 0.000 | 1.000 |",
            "| python | 2 | 0.750 | 0.500 | 0.500 | 1.000 |",
        ]
    );
}
