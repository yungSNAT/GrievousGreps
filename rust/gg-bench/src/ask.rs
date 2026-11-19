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

use serde::{Deserialize, Serialize};
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

/// One repository's answers in question order (`null` for a failed one), with what they were
/// asked with, kept in `<work>/answers/<repo>.json`.
#[derive(Deserialize, Serialize)]
struct Kept {
    tool: String,
    revision: String,
    benchmark_root: Option<String>,
    questions: Vec<String>,
    answers: Vec<Value>,
}

impl Kept {
    fn new(tool: &str, repo: &SetRepo, tasks: &[Task]) -> Self {
        Kept {
            tool: tool.to_owned(),
            revision: repo.revision.clone(),
            benchmark_root: repo.benchmark_root.clone(),
            questions: tasks.iter().map(|t| t.query.clone()).collect(),
            answers: Vec::new(),
        }
    }
}

fn kept_file(work: &Path, name: &str) -> PathBuf {
    work.join("answers").join(format!("{name}.json"))
}

fn keep(work: &Path, name: &str, kept: &Kept) -> Result<(), String> {
    let file = kept_file(work, name);
    let text = serde_json::to_string_pretty(kept).map_err(|e| e.to_string())?;
    fs::create_dir_all(work.join("answers"))
        .and_then(|()| fs::write(&file, text + "\n"))
        .map_err(|e| format!("cannot write {}: {e}", file.display()))
}

/// The answers an earlier run in this work folder kept for the repository, when it asked the same
/// questions in the same order with the same known tool version at the same revision and folder,
/// so a stopped run resumes where it stopped. Any other kept file is asked again.
fn kept(work: &Path, name: &str, now: &Kept) -> Option<Vec<Value>> {
    let text = fs::read_to_string(kept_file(work, name)).ok()?;
    let old: Kept = serde_json::from_str(&text).ok()?;
    let same = now.tool != "unknown"
        && old.tool == now.tool
        && old.revision == now.revision
        && old.benchmark_root == now.benchmark_root
        && old.questions == now.questions
        && old.answers.len() == old.questions.len();
    same.then_some(old.answers)
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
fn ask_repo(
    opts: &AskOptions,
    repo: &SetRepo,
    tasks: &[Task],
    mut kept: Kept,
) -> Result<Vec<Graded>, String> {
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
        kept.answers.push(answer.unwrap_or(Value::Null));
    }
    remove(&root.join("graft"))?;
    keep(&opts.work, &repo.name, &kept)?;
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
    let tool = tool_version(&opts.node, &opts.tool, &opts.work);
    let mut graded = Vec::new();
    for repo in &opts.repos {
        let tasks = tasks_of(opts, repo)?;
        if tasks.is_empty() {
            continue;
        }
        let now = Kept::new(&tool, repo, &tasks);
        graded.extend(match kept(&opts.work, &repo.name, &now) {
            Some(answers) => tasks
                .iter()
                .zip(&answers)
                .map(|(t, a)| graded_answer(repo, t, Some(a).filter(|a| !a.is_null())))
                .collect(),
            None => ask_repo(opts, repo, &tasks, now)?,
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
        tool,
        opts.set.display(),
        graded.len(),
        table(&graded),
        misses(&graded)
    ))
}

#[cfg(test)]
mod tests;
