//! `ask` against a fake tool on a local repository, so nothing here reaches the network.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use gg_bench::ask::{AskOptions, run, select};
use serde_json::{Value, json};

/// Records each call beside itself. `build` makes a graft/ folder in the folder it is given;
/// `ask` answers 'where is a' with a.py first, 'broken' with an error, and anything else with
/// b.py first and a.py fourth.
const FAKE_TOOL: &str = r#"
const fs = require('node:fs');
const path = require('node:path');
const [cmd, ...rest] = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME }) + '\n');
const hit = (file) => ({ pointer: `${file}:L1`, kind: 'symbol' });
if (cmd === '--version') console.log('fake\n1.2.3');
else if (cmd === 'build') { fs.mkdirSync(path.join(rest[0], 'graft'), { recursive: true }); }
else if (rest[0] === 'broken') process.exit(1);
else {
  console.log('[trail] a log line first');
  // 'twice' finds a.py when first asked and z.py after.
  const asked = fs.readFileSync(path.join(__dirname, 'calls.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"twice"')).length;
  const files = rest[0] === 'where is a' ? ['a.py', 'b.py'] : rest[0] === 'twice' ? [asked === 1 ? 'a.py' : 'z.py'] : ['b.py', 'b.py', 'c.py', 'd.py', 'a.py'];
  console.log(JSON.stringify({ hits: files.map(hit) }));
}
"#;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

struct Fixture {
    _tmp: tempfile::TempDir,
    set: PathBuf,
    tool: PathBuf,
    work: PathBuf,
}

/// A set of one repository, already fetched into the work folder, asked in its `src` folder.
fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let (set, work) = (tmp.path().join("set"), tmp.path().join("work"));
    let checkout = work.join("repos").join("demo");
    fs::create_dir_all(checkout.join("src")).unwrap();
    fs::write(checkout.join("src").join("a.py"), "def a():\n    pass\n").unwrap();
    git(&checkout, &["init", "--quiet"]);
    git(&checkout, &["add", "."]);
    git(&checkout, &["commit", "--quiet", "-m", "demo"]);
    let sha = git(&checkout, &["rev-parse", "HEAD"]);
    fs::create_dir_all(set.join("annotations")).unwrap();
    let repos = json!([{ "name": "demo", "language": "python", "url": "https://example.invalid/demo.git", "revision": sha, "benchmark_root": "src" }]);
    fs::write(set.join("repos.json"), repos.to_string()).unwrap();
    let tasks = json!([
        { "query": "where is a", "category": "symbol", "relevant": ["src/a.py"], "secondary": [] },
        { "query": "how does a work", "category": "semantic", "relevant": ["src/a.py"], "secondary": ["src/b.py"] },
        { "query": "broken", "category": "semantic", "relevant": ["src/a.py"] },
    ]);
    fs::write(set.join("annotations").join("demo.json"), tasks.to_string()).unwrap();
    let tool = tmp.path().join("tool").join("fake.js");
    fs::create_dir_all(tool.parent().unwrap()).unwrap();
    fs::write(&tool, FAKE_TOOL).unwrap();
    Fixture {
        _tmp: tmp,
        set,
        tool,
        work,
    }
}

impl Fixture {
    fn options(&self, category: Option<&str>) -> AskOptions {
        AskOptions {
            set: self.set.clone(),
            node: OsString::from("node"),
            tool: self.tool.clone(),
            repos: select(&self.set, None).unwrap(),
            category: category.map(str::to_owned),
            work: self.work.clone(),
        }
    }
}

fn calls(tool: &Path) -> Vec<Value> {
    fs::read_to_string(tool.with_file_name("calls.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn a_run_scores_each_question_and_lists_the_misses_at_3() {
    let f = fixture();
    let report = run(&f.options(None)).unwrap();
    let (first, rest) = report.split_once('\n').unwrap();
    assert!(
        first.starts_with("Node v") && first.ends_with(" UTC"),
        "{first}"
    );
    // how does a work: b.py (secondary) at 1 and a.py at 4 of 4 distinct files.
    let ideal = 1.0 + 1.0 / 3f64.log2();
    let semantic = (1.0 + 1.0 / 5f64.log2()) / ideal;
    let expected = format!(
        "Tool: {} (1.2.3)\nSet: {}, 3 questions in 1 repositories; 1 failed\n\n\
| Set | Queries | NDCG@10 | hit@1 | hit@3 | hit@10 |\n| --- | --- | --- | --- | --- | --- |\n\
| All | 3 | {:.3} | 0.333 | 0.333 | 0.667 |\n\
| semantic | 2 | {:.3} | 0.000 | 0.000 | 0.500 |\n\
| symbol | 1 | 1.000 | 1.000 | 1.000 | 1.000 |\n\
| python | 3 | {:.3} | 0.333 | 0.333 | 0.667 |\n\n\
Misses at 3 (no relevant file among the first 3):\n\n\
| Repository | Category | Query | First relevant | Relevant | First 3 returned |\n| --- | --- | --- | --- | --- | --- |\n\
| demo | semantic | how does a work | 4 | src/a.py | b.py, c.py, d.py |\n\
| demo | semantic | broken | failed | src/a.py |  |\n",
        f.tool.display(),
        f.set.display(),
        (1.0 + semantic) / 3.0,
        semantic / 2.0,
        (1.0 + semantic) / 3.0,
    );
    assert_eq!(rest, expected);
}

#[test]
fn the_tool_builds_and_is_asked_in_the_benchmark_root_and_its_graph_is_removed() {
    let f = fixture();
    run(&f.options(None)).unwrap();
    let root = f.work.join("repos").join("demo").join("src");
    let root = root.to_str().unwrap();
    // The tool's version is asked first, for the kept answers.
    let calls = calls(&f.tool);
    assert_eq!(calls[0]["args"], json!(["--version"]));
    let calls = &calls[1..];
    assert_eq!(
        calls[0]["args"],
        json!(["build", root, "--no-gitignore", "--no-ignore"])
    );
    assert_eq!(
        calls[1]["args"],
        json!(["ask", "where is a", root, "--json", "-n", "10"])
    );
    let home = f.work.join("home").join("ask");
    assert_eq!(calls[0]["home"], json!(home.to_str().unwrap()));
    assert!(
        !Path::new(root).join("graft").exists(),
        "the graph is removed"
    );
    let kept: Value = serde_json::from_str(
        &fs::read_to_string(f.work.join("answers").join("demo.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(kept["tool"], json!("1.2.3"));
    assert_eq!(kept["benchmark_root"], json!("src"));
    assert_eq!(
        kept["questions"],
        json!(["where is a", "how does a work", "broken"])
    );
    assert_eq!(kept["answers"][0]["hits"][0]["pointer"], json!("a.py:L1"));
    assert_eq!(kept["answers"][2], Value::Null);
}

#[test]
fn a_category_asks_only_its_questions() {
    let f = fixture();
    let report = run(&f.options(Some("symbol"))).unwrap();
    assert!(
        report.contains(", 1 questions in 1 repositories, category symbol; 0 failed\n"),
        "{report}"
    );
    let asks = calls(&f.tool)
        .iter()
        .filter(|c| c["args"][0] == "ask")
        .count();
    assert_eq!(asks, 1);
}

#[test]
fn a_rerun_grades_kept_answers_that_cover_every_question_without_asking() {
    let f = fixture();
    let asked = || {
        calls(&f.tool)
            .iter()
            .filter(|c| c["args"][0] != "--version")
            .count()
    };
    run(&f.options(Some("symbol"))).unwrap();
    assert_eq!(asked(), 2);
    // The kept answers miss 2 of the 3 questions, so the repository is asked again.
    let first = run(&f.options(None)).unwrap();
    assert_eq!(asked(), 6);
    let again = run(&f.options(None)).unwrap();
    assert_eq!(asked(), 6);
    assert_eq!(
        again.split_once('\n').unwrap().1,
        first.split_once('\n').unwrap().1
    );
    // Another build of the tool asks again.
    let tool = fs::read_to_string(&f.tool).unwrap();
    fs::write(&f.tool, tool.replace("1.2.3", "1.2.4")).unwrap();
    run(&f.options(None)).unwrap();
    assert_eq!(asked(), 10);
}

#[test]
fn a_question_set_twice_keeps_both_answers_for_a_rerun() {
    let f = fixture();
    let twice = json!({ "query": "twice", "category": "symbol", "relevant": ["src/a.py"] });
    fs::write(
        f.set.join("annotations").join("demo.json"),
        json!([twice, twice]).to_string(),
    )
    .unwrap();
    let first = run(&f.options(None)).unwrap();
    assert!(first.contains("| All | 2 | 0.500 | 0.500 |"), "{first}");
    let again = run(&f.options(None)).unwrap();
    assert_eq!(
        again.split_once('\n').unwrap().1,
        first.split_once('\n').unwrap().1
    );
}

#[test]
fn an_unknown_repository_is_refused() {
    let f = fixture();
    assert_eq!(
        select(&f.set, Some("demo,nope")).unwrap_err(),
        "unknown repository: nope"
    );
}
