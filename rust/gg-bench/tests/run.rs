//! The runner against a fake tool on a local repository, so nothing here reaches the network.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use gg_bench::run::{
    Options, absolute, copy_tree, parse_result, run, run_tool, select_repos, utc_date,
};
use serde_json::{Value, json};

mod common;
use common::git;

/// Records each call beside itself, then answers as `graft` would: build, callers --json and --version.
const FAKE_TOOL: &str = r#"
const fs = require('node:fs');
const path = require('node:path');
const [cmd, ...rest] = process.argv.slice(2);
const env = process.env;
const call = { args: process.argv.slice(2), cwd: process.cwd(), home: env.HOME, trail: env.TRAIL_HOME, track: env.DO_NOT_TRACK, stdin: fs.readFileSync(0, 'utf8') };
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(call) + '\n');
if (cmd === '--version') console.log('fake\n1.2.3');
else if (cmd === 'sleep') setTimeout(() => {}, 20000);
else if (cmd === 'build') process.exit(fs.existsSync(path.join(rest[0], 'lib.py')) ? 0 : 3);
else if (rest[0] === 'quiet') { console.log('nothing to say'); process.exit(2); }
else {
  console.log('[graft] a log line first');
  console.log(JSON.stringify({ matches: [{ symbol: { path: 'lib.py', span: 'L1-L2' }, hits: [{ id: 'main.py#run', path: 'main.py', span: 'L3-L5' }] }] }));
}
"#;

struct Fixture {
    _tmp: tempfile::TempDir,
    bench: PathBuf,
    tool: PathBuf,
    work: PathBuf,
    sha: String,
}

/// A benchmark folder with one repository, already fetched into the work folder at its pinned commit.
fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let (bench, work) = (tmp.path().join("bench"), tmp.path().join("work"));
    let checkout = work.join("repos").join("demo");
    fs::create_dir_all(&checkout).unwrap();
    fs::write(checkout.join("lib.py"), "def run():\n    pass\n").unwrap();
    fs::write(
        checkout.join("main.py"),
        "import lib\n\ndef main():\n    lib.run()\n",
    )
    .unwrap();
    git(&checkout, &["init", "--quiet"]);
    git(&checkout, &["add", "."]);
    git(&checkout, &["commit", "--quiet", "-m", "demo"]);
    let sha = git(&checkout, &["rev-parse", "HEAD"]);
    fs::create_dir_all(bench.join("truth")).unwrap();
    let repos = json!([{ "name": "demo", "repository": "o/demo", "sha": sha, "language": "Python", "rules": "span" }]);
    fs::write(bench.join("repos.json"), repos.to_string()).unwrap();
    let truth = json!({
        "run": { "target": "lib.py", "target_lines": [1], "required": [{ "file": "main.py", "chain": "main", "lines": [4] }] },
        "quiet": { "target": "lib.py", "target_lines": [1], "required": [{ "file": "main.py", "chain": "<file>", "lines": [1] }] },
    });
    fs::write(bench.join("truth").join("demo.json"), truth.to_string()).unwrap();
    let tool = tmp.path().join("tool").join("fake.js");
    fs::create_dir_all(tool.parent().unwrap()).unwrap();
    fs::write(&tool, FAKE_TOOL).unwrap();
    Fixture {
        _tmp: tmp,
        bench,
        tool,
        work,
        sha,
    }
}

fn calls(tool: &Path) -> Vec<Value> {
    fs::read_to_string(tool.with_file_name("calls.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

impl Fixture {
    fn options(&self, baseline: bool) -> Options {
        Options {
            bench: self.bench.clone(),
            node: OsString::from("node"),
            tool: self.tool.clone(),
            baseline: baseline.then(|| self.tool.clone()),
            repos: select_repos(&self.bench, None).unwrap(),
            work: self.work.clone(),
            verbose: true,
        }
    }

    /// What the JavaScript runner printed for this fixture, after its first line.
    fn report(&self) -> String {
        let (tool, short) = (self.tool.display(), &self.sha[..7]);
        let detail = |label: &str| {
            format!(
                "{label}:\n| Repository | Recall | Macro recall | Precision | Silent | Stated | Perfect |\n| --- | --- | --- | --- | --- | --- | --- |\n| demo | 1/2 = 0.50 | 0.50 | 1/1 = 1.00 | 1 | 0 | 1/2 |"
            )
        };
        format!(
            "Upstream: {tool} (1.2.3)\nPatched: {tool} (1.2.3)\n\n**Overall, upstream to patched:** recall 0.50 to 0.50 (1 repositories and 1 of 2 calls on the patched build), precision 1.00 to 1.00, silent undercounts 1 to 1.\n\n| Repository | Language | Calls in truth | Upstream | Patched |\n| --- | --- | --- | --- | --- |\n| o/demo @ {short} | Python | 2 | 0.50 | 0.50 |\n\n{}\n\n{}\n",
            detail("Upstream"),
            detail("Patched"),
        )
    }
}

#[test]
fn a_run_scores_both_builds_and_prints_the_readme_report() {
    let f = fixture();
    let report = run(&f.options(true)).unwrap();
    let (first, rest) = report.split_once('\n').unwrap();
    assert!(
        first.starts_with("Node v") && first.ends_with(" UTC"),
        "{first}"
    );
    assert_eq!(rest, f.report());
}

#[test]
fn the_tool_runs_in_a_scratch_home_with_an_empty_input() {
    let f = fixture();
    run(&f.options(false)).unwrap();
    let calls = calls(&f.tool);
    let copy = f.work.join("run").join("patched").join("demo");
    let copy = copy.to_str().unwrap();
    let home = f.work.join("home").join("patched");
    assert_eq!(
        calls[0]["args"],
        json!(["build", copy, "--no-gitignore", "--no-ignore"])
    );
    assert_eq!(calls[0]["cwd"], json!(f.work.to_str().unwrap()));
    assert_eq!(calls[0]["home"], json!(home.to_str().unwrap()));
    assert_eq!(
        calls[0]["trail"],
        json!(home.join(".trail").to_str().unwrap())
    );
    assert_eq!(
        (&calls[0]["track"], &calls[0]["stdin"]),
        (&json!("1"), &json!(""))
    );
    assert_eq!(calls[1]["args"], json!(["callers", "run", copy, "--json"]));
    assert_eq!(
        calls[2]["args"],
        json!(["callers", "quiet", copy, "--json"])
    );
    // --version runs in the caller's own environment, not the scratch home.
    assert_eq!(calls[3]["args"], json!(["--version"]));
    assert_ne!(calls[3]["home"], json!(home.to_str().unwrap()));
    assert!(!Path::new(copy).exists(), "the scored copy is removed");
}

#[test]
fn paths_under_a_work_folder_with_dots_read_as_nodes_join_gave_them() {
    let f = fixture();
    fs::create_dir_all(f.work.join("x")).unwrap();
    let mut options = f.options(false);
    options.work = f.work.join("x").join("..");
    run(&options).unwrap();
    let calls = calls(&f.tool);
    let copy = f.work.join("run").join("patched").join("demo");
    let home = f.work.join("home").join("patched");
    assert_eq!(calls[0]["args"][1], json!(copy.to_str().unwrap()));
    assert_eq!(calls[0]["home"], json!(home.to_str().unwrap()));
    assert_eq!(
        calls[0]["trail"],
        json!(home.join(".trail").to_str().unwrap())
    );
}

#[test]
fn each_builds_answers_are_kept_for_scoring_again() {
    let f = fixture();
    run(&f.options(true)).unwrap();
    for label in ["upstream", "patched"] {
        let file = f.work.join("answers").join(label).join("demo.json");
        let kept: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(
            kept["run"]["matches"][0]["hits"][0]["id"],
            json!("main.py#run")
        );
        assert_eq!(
            kept["quiet"],
            Value::Null,
            "an answer with no JSON is kept as null"
        );
    }
}

#[test]
fn a_build_that_fails_stops_the_run_with_its_output() {
    let f = fixture();
    fs::write(
        &f.tool,
        FAKE_TOOL.replace("fs.existsSync(path.join(rest[0], 'lib.py'))", "false"),
    )
    .unwrap();
    assert_eq!(
        run(&f.options(false)).unwrap_err(),
        "patched could not build demo:\n\n"
    );
}

#[test]
fn a_tool_with_no_readable_answer_is_broken_not_a_recall_of_zero() {
    let f = fixture();
    fs::write(&f.tool, FAKE_TOOL.replace("rest[0] === 'quiet'", "true")).unwrap();
    assert_eq!(
        run(&f.options(false)).unwrap_err(),
        "patched returned no readable answer for any symbol in demo."
    );
}

#[test]
fn a_checkout_at_another_commit_is_refused() {
    let f = fixture();
    let checkout = f.work.join("repos").join("demo");
    fs::write(checkout.join("lib.py"), "def run():\n    return 1\n").unwrap();
    git(&checkout, &["commit", "--quiet", "-am", "moved"]);
    let head = git(&checkout, &["rev-parse", "HEAD"]);
    let expected = format!(
        "demo is at {head}, expected {}. Delete {} and rerun.",
        f.sha,
        checkout.display()
    );
    assert_eq!(run(&f.options(false)).unwrap_err(), expected);
}

#[test]
fn unknown_repositories_are_named() {
    let f = fixture();
    assert_eq!(
        select_repos(&f.bench, Some("demo,nope,gone")).unwrap_err(),
        "unknown repositories: nope, gone"
    );
    assert_eq!(select_repos(&f.bench, Some("demo")).unwrap().len(), 1);
}

#[test]
fn a_tool_past_its_time_is_stopped() {
    let f = fixture();
    let err = run_tool(
        OsStr::new("node"),
        &f.tool,
        &[OsStr::new("sleep")],
        &[],
        &f.work,
        Duration::from_millis(500),
    )
    .err()
    .unwrap();
    assert_eq!(err, "sleep: spawnSync node ETIMEDOUT");
}

#[test]
fn the_answer_is_the_json_from_the_first_brace_to_the_end() {
    assert_eq!(
        parse_result("[graft] building\n{\"matches\": []}\n"),
        Some(json!({ "matches": [] }))
    );
    assert_eq!(parse_result("no answer"), None);
    assert_eq!(parse_result("{\"matches\": []}\ntrailing words"), None);
    assert_eq!(
        parse_result("{\"a\": {\"b\": 1}}"),
        Some(json!({ "a": { "b": 1 } }))
    );
}

#[test]
fn a_copy_keeps_links_as_links_and_its_read_only_files_can_be_removed() {
    let tmp = tempfile::tempdir().unwrap();
    let (from, to) = (tmp.path().join("from"), tmp.path().join("deep").join("to"));
    fs::create_dir_all(from.join("sub")).unwrap();
    fs::write(from.join("sub").join("f.txt"), "f").unwrap();
    let locked = from.join("locked.txt");
    fs::write(&locked, "x").unwrap();
    let mut read_only = fs::metadata(&locked).unwrap().permissions();
    read_only.set_readonly(true);
    fs::set_permissions(&locked, read_only).unwrap();
    let linked = link(Path::new("sub/f.txt"), &from.join("link")).is_ok();
    copy_tree(&from, &to).unwrap();
    assert_eq!(
        fs::read_to_string(to.join("sub").join("f.txt")).unwrap(),
        "f"
    );
    if linked {
        assert_eq!(
            fs::read_link(to.join("link")).unwrap(),
            Path::new("sub/f.txt")
        );
    }
    fs::remove_dir_all(&to).unwrap();
    assert!(!to.exists());
}

#[cfg(unix)]
fn link(points_to: &Path, at: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(points_to, at)
}

/// Windows lets only some accounts make links; where it refuses, the copy is checked without one.
#[cfg(windows)]
fn link(points_to: &Path, at: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(points_to, at)
}

#[test]
fn the_date_is_utc() {
    assert_eq!(utc_date(UNIX_EPOCH), "1970-01-01");
    assert_eq!(
        utc_date(UNIX_EPOCH + Duration::from_secs(951_782_400)),
        "2000-02-29"
    );
    assert_eq!(
        utc_date(UNIX_EPOCH + Duration::from_secs(1_000_000_000)),
        "2001-09-09"
    );
}

#[test]
fn a_path_resolves_dots_by_name() {
    let cwd = std::env::current_dir().unwrap();
    assert_eq!(
        absolute(Path::new("a/../b/./c")).unwrap(),
        cwd.join("b").join("c")
    );
}

#[test]
fn an_absolute_path_is_kept_as_given() {
    let given = std::env::current_dir()
        .unwrap()
        .join("a")
        .join("..")
        .join("b");
    assert_eq!(absolute(&given).unwrap(), given);
}
