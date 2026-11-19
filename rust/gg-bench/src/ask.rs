//! `ask`: how well `ask` finds the files a question is about, on a set in the format of semble's
//! retrieval benchmark (MinishLab/semble, `benchmarks/`): a `repos.json` of pinned repositories
//! and an `annotations/<repo>.json` of questions, each with its relevant files.
//!
//! Each answer's first 10 distinct files are scored as semble scores a tool by file: NDCG@10
//! against the relevant and secondary files, path matching by suffix (semble's `ndcg_at_k` and
//! `path_matches`). hit@k is whether a relevant file is among the first k.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Deserialize;
use serde_json::Value;

use crate::run::{
    MINUTE, fetch, node_version, parse_result, read_json, remove, run_tool, scratch_env,
    tool_version, utc_date,
};

/// The files of an answer that are scored, as semble scores them.
pub const TOP_K: usize = 10;

/// A pinned repository, as semble's `repos.json` lists it.
#[derive(Clone, Debug, Deserialize)]
pub struct SetRepo {
    pub name: String,
    pub language: String,
    pub url: String,
    pub revision: String,
    /// The folder under the checkout that is indexed and asked; the whole checkout when absent.
    #[serde(default)]
    pub benchmark_root: Option<String>,
}

/// A file named by a question: a path, or an object with one.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum Target {
    Path(String),
    Entry { path: String },
}

impl Target {
    fn path(&self) -> &str {
        match self {
            Target::Path(path) | Target::Entry { path } => path,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
struct Task {
    query: String,
    category: String,
    relevant: Vec<Target>,
    #[serde(default)]
    secondary: Vec<Target>,
}

pub struct AskOptions {
    /// The set: repos.json and annotations/.
    pub set: PathBuf,
    pub node: OsString,
    pub tool: PathBuf,
    pub repos: Vec<SetRepo>,
    /// Ask only the questions of this category.
    pub category: Option<String>,
    pub work: PathBuf,
}

/// One question, answered and scored.
#[derive(Clone, Debug)]
pub struct Graded {
    pub repo: String,
    pub language: String,
    pub category: String,
    pub query: String,
    pub relevant: Vec<String>,
    /// The answer's first 10 distinct files.
    pub files: Vec<String>,
    pub ndcg: f64,
    /// The rank of the first relevant file among `files`, from 1.
    pub first: Option<usize>,
    /// The tool exited with an error, timed out or printed no JSON.
    pub failed: bool,
}

/// The pinned repositories, or the named ones in repos.json's order.
pub fn select(set: &Path, wanted: Option<&str>) -> Result<Vec<SetRepo>, String> {
    let all: Vec<SetRepo> = read_json(&set.join("repos.json"))?;
    let Some(wanted) = wanted else { return Ok(all) };
    let wanted: Vec<&str> = wanted.split(',').collect();
    if let Some(unknown) = wanted.iter().find(|n| !all.iter().any(|r| r.name == **n)) {
        return Err(format!("unknown repository: {unknown}"));
    }
    Ok(all
        .into_iter()
        .filter(|repo| wanted.contains(&repo.name.as_str()))
        .collect())
}

fn dcg(relevances: &[f64]) -> f64 {
    relevances
        .iter()
        .enumerate()
        .map(|(i, rel)| rel / (i as f64 + 2.0).log2())
        .sum()
}

/// NDCG@k with binary relevance: `ranks` are the ranks, from 1, at which relevant files were found.
pub fn ndcg_at_k(ranks: &[usize], relevant: usize, k: usize) -> f64 {
    if relevant == 0 {
        return 0.0;
    }
    let mut relevances = vec![0.0; k];
    for &rank in ranks {
        if (1..=k).contains(&rank) {
            relevances[rank - 1] = 1.0;
        }
    }
    let ideal = dcg(&vec![1.0; k.min(relevant)]);
    dcg(&relevances) / ideal
}

/// Whether a returned file is the target: the same path, or one ends with the other after a `/`.
pub fn path_matches(file: &str, target: &str) -> bool {
    let (f, t) = (file.replace('\\', "/"), target.replace('\\', "/"));
    f == t || f.ends_with(&format!("/{t}")) || t.ends_with(&format!("/{f}"))
}

fn rank_of(files: &[String], target: &str) -> Option<usize> {
    files
        .iter()
        .position(|file| path_matches(file, target))
        .map(|i| i + 1)
}

/// A pointer without its trailing `:L<line>` or `:L<line>-L<line>`.
fn pointer_file(pointer: &str) -> &str {
    let Some((file, lines)) = pointer.rsplit_once(":L") else {
        return pointer;
    };
    let numbered = lines
        .split("-L")
        .all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    if numbered { file } else { pointer }
}

/// The first 10 distinct files of an `ask --json` answer, in rank order: each hit's `pointer`
/// without its line suffix.
pub fn answer_files(answer: &Value) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    for hit in answer["hits"].as_array().into_iter().flatten() {
        let Some(pointer) = hit["pointer"].as_str() else {
            continue;
        };
        let file = pointer_file(pointer);
        if !files.iter().any(|seen| seen == file) {
            files.push(file.to_owned());
        }
    }
    files.truncate(TOP_K);
    files
}

/// NDCG@10 over the relevant and secondary files, and the first relevant file's rank.
fn grade(task: &Task, files: &[String]) -> (f64, Option<usize>) {
    let every: Vec<&str> = task
        .relevant
        .iter()
        .chain(&task.secondary)
        .map(Target::path)
        .collect();
    let ranks: Vec<usize> = every.iter().filter_map(|t| rank_of(files, t)).collect();
    let first = task
        .relevant
        .iter()
        .filter_map(|t| rank_of(files, t.path()))
        .min();
    (ndcg_at_k(&ranks, every.len(), TOP_K), first)
}

/// One question's answer, scored. The tool names files under `benchmark_root`, and semble's file
/// baselines match each one by its full path, so a file is matched as `/<benchmark_root>/<file>`:
/// `utils.py` then matches `pkg/utils.py`, not `pkg/openapi/utils.py`.
fn graded_answer(repo: &SetRepo, task: &Task, answer: Option<&Value>) -> Graded {
    let files = answer.map(answer_files).unwrap_or_default();
    let root = repo.benchmark_root.as_deref().map_or(String::new(), |r| {
        format!("/{}", r.replace('\\', "/").trim_matches('/'))
    });
    let in_checkout: Vec<String> = files.iter().map(|f| format!("{root}/{f}")).collect();
    let (ndcg, first) = grade(task, &in_checkout);
    Graded {
        repo: repo.name.clone(),
        language: repo.language.clone(),
        category: task.category.clone(),
        query: task.query.clone(),
        relevant: task.relevant.iter().map(|t| t.path().to_owned()).collect(),
        files,
        ndcg,
        first,
        failed: answer.is_none(),
    }
}

/// Keeps one repository's answers, keyed by question, in `<work>/answers/<repo>.json`.
fn keep(work: &Path, name: &str, answers: serde_json::Map<String, Value>) -> Result<(), String> {
    let dir = work.join("answers");
    let file = dir.join(format!("{name}.json"));
    fs::create_dir_all(&dir)
        .and_then(|()| fs::write(&file, format!("{:#}\n", Value::Object(answers))))
        .map_err(|e| format!("cannot write {}: {e}", file.display()))
}

/// The answers an earlier run in this work folder kept for the repository, if they answer every
/// question, so a stopped run resumes where it stopped.
fn kept(work: &Path, name: &str, tasks: &[Task]) -> Option<serde_json::Map<String, Value>> {
    let text = fs::read_to_string(work.join("answers").join(format!("{name}.json"))).ok()?;
    let answers: serde_json::Map<String, Value> = serde_json::from_str(&text).ok()?;
    tasks
        .iter()
        .all(|t| answers.contains_key(&t.query))
        .then_some(answers)
}

/// The folder semble names in the fetched checkout, without a graph a stopped run left behind,
/// which the build would read as source.
fn ask_root(opts: &AskOptions, repo: &SetRepo) -> Result<PathBuf, String> {
    let checkout = fetch(&repo.name, &repo.url, &repo.revision, &opts.work)?;
    let root = repo
        .benchmark_root
        .as_deref()
        .map_or_else(|| checkout.clone(), |sub| checkout.join(sub));
    remove(&root.join("graft"))?;
    Ok(root)
}

/// Builds one repository's graph, asks each question once and removes the graph.
fn ask_repo(opts: &AskOptions, repo: &SetRepo, tasks: &[Task]) -> Result<Vec<Graded>, String> {
    let root = ask_root(opts, repo)?;
    let env = scratch_env(&opts.work, "ask")?;
    let call = |args: &[&OsStr], minutes: u32| {
        run_tool(
            &opts.node,
            &opts.tool,
            args,
            &env,
            &opts.work,
            MINUTE * minutes,
        )
    };
    let built = call(
        &[
            OsStr::new("build"),
            root.as_os_str(),
            OsStr::new("--no-gitignore"),
            OsStr::new("--no-ignore"),
        ],
        25,
    )?;
    if !built.status.success() {
        return Err(format!(
            "could not build {}:\n{}\n{}",
            repo.name, built.stdout, built.stderr
        ));
    }
    let top = TOP_K.to_string();
    let mut graded = Vec::new();
    let mut answers = serde_json::Map::new();
    for task in tasks {
        let args = [
            OsStr::new("ask"),
            OsStr::new(&task.query),
            root.as_os_str(),
            OsStr::new("--json"),
            OsStr::new("-n"),
            OsStr::new(&top),
        ];
        let answer = call(&args, 5)
            .ok()
            .filter(|out| out.status.success())
            .and_then(|out| parse_result(&out.stdout));
        graded.push(graded_answer(repo, task, answer.as_ref()));
        answers.insert(task.query.clone(), answer.unwrap_or(Value::Null));
    }
    remove(&root.join("graft"))?;
    keep(&opts.work, &repo.name, answers)?;
    Ok(graded)
}

fn row(name: &str, graded: &[&Graded]) -> String {
    let n = graded.len() as f64;
    let hit = |k: usize| {
        graded
            .iter()
            .filter(|g| g.first.is_some_and(|r| r <= k))
            .count() as f64
            / n
    };
    let ndcg = graded.iter().map(|g| g.ndcg).sum::<f64>() / n;
    format!(
        "| {name} | {} | {ndcg:.3} | {:.3} | {:.3} | {:.3} |\n",
        graded.len(),
        hit(1),
        hit(3),
        hit(TOP_K)
    )
}

/// The table: all questions, then by category, then by language.
pub fn table(graded: &[Graded]) -> String {
    let mut out = "| Set | Queries | NDCG@10 | hit@1 | hit@3 | hit@10 |\n| --- | --- | --- | --- | --- | --- |\n".to_owned();
    out += &row("All", &graded.iter().collect::<Vec<_>>());
    for key in [
        |g: &Graded| g.category.clone(),
        |g: &Graded| g.language.clone(),
    ] {
        let mut groups: BTreeMap<String, Vec<&Graded>> = BTreeMap::new();
        for g in graded {
            groups.entry(key(g)).or_default().push(g);
        }
        for (name, group) in groups {
            out += &row(&name, &group);
        }
    }
    out
}

/// Every question with no relevant file among the first 3, with what came first instead.
pub fn misses(graded: &[Graded]) -> String {
    let mut out = "| Repository | Category | Query | First relevant | Relevant | First 3 returned |\n| --- | --- | --- | --- | --- | --- |\n".to_owned();
    let cell = |text: &str| text.replace('|', "\\|");
    for g in graded.iter().filter(|g| !g.first.is_some_and(|r| r <= 3)) {
        let first = match (g.failed, g.first) {
            (true, _) => "failed".to_owned(),
            (false, Some(rank)) => rank.to_string(),
            (false, None) => "none".to_owned(),
        };
        let top: Vec<&str> = g.files.iter().take(3).map(String::as_str).collect();
        out += &format!(
            "| {} | {} | {} | {first} | {} | {} |\n",
            g.repo,
            g.category,
            cell(&g.query),
            cell(&g.relevant.join(", ")),
            cell(&top.join(", "))
        );
    }
    out
}

fn tasks_of(opts: &AskOptions, repo: &SetRepo) -> Result<Vec<Task>, String> {
    let all: Vec<Task> = read_json(
        &opts
            .set
            .join("annotations")
            .join(format!("{}.json", repo.name)),
    )?;
    Ok(all
        .into_iter()
        .filter(|t| opts.category.as_ref().is_none_or(|c| *c == t.category))
        .collect())
}

/// Asks every selected question and returns the report: the table, then the misses at 3.
pub fn run(opts: &AskOptions) -> Result<String, String> {
    let node = node_version(&opts.node)?;
    let mut graded = Vec::new();
    for repo in &opts.repos {
        let tasks = tasks_of(opts, repo)?;
        if tasks.is_empty() {
            continue;
        }
        graded.extend(match kept(&opts.work, &repo.name, &tasks) {
            Some(answers) => tasks
                .iter()
                .map(|t| graded_answer(repo, t, answers.get(&t.query).filter(|a| !a.is_null())))
                .collect(),
            None => ask_repo(opts, repo, &tasks)?,
        });
    }
    if graded.is_empty() {
        return Err("no questions to ask.".to_owned());
    }
    let failed = graded.iter().filter(|g| g.failed).count();
    let repos = graded
        .iter()
        .map(|g| &g.repo)
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    let category = opts
        .category
        .as_ref()
        .map_or(String::new(), |c| format!(", category {c}"));
    Ok(format!(
        "Node {node}, {} UTC\nTool: {} ({})\nSet: {}, {} questions in {repos} repositories{category}; {failed} failed\n\n{}\nMisses at 3 (no relevant file among the first 3):\n\n{}",
        utc_date(SystemTime::now()),
        opts.tool.display(),
        tool_version(&opts.node, &opts.tool, &opts.work),
        opts.set.display(),
        graded.len(),
        table(&graded),
        misses(&graded)
    ))
}

#[cfg(test)]
mod tests {
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
}
