//! Builds a graph of each pinned repository with the given tool, asks it for the callers of each
//! symbol and scores the answers against benchmark/truth. It only builds and queries: never run
//! the tool's own test suite from here.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{fs, path};

use serde_json::Value;

use crate::process::{self, Output, command};
use crate::score::{
    Entry, Repo, Summaries, Summary, SymbolScore, detail_table, overall_line, recall_table,
    score_symbol, summarise,
};

const MINUTE: Duration = Duration::from_secs(60);

pub struct Options {
    /// The benchmark folder: repos.json and truth/.
    pub bench: PathBuf,
    pub node: OsString,
    pub tool: PathBuf,
    pub baseline: Option<PathBuf>,
    pub repos: Vec<Repo>,
    pub work: PathBuf,
    pub verbose: bool,
}

/// An absolute path as given; any other made absolute against the working folder, with `.` and
/// `..` resolved by name, as Node's `path.resolve` does. run.mjs did the same, and printed it.
pub fn absolute(path: &Path) -> io::Result<PathBuf> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    let mut out = PathBuf::new();
    for part in path::absolute(path)?.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    Ok(out)
}

/// The pinned repositories, or the named ones in repos.json's order.
pub fn select_repos(bench: &Path, wanted: Option<&str>) -> Result<Vec<Repo>, String> {
    let all: Vec<Repo> = read_json(&bench.join("repos.json"))?;
    let Some(wanted) = wanted else { return Ok(all) };
    let wanted: Vec<&str> = wanted.split(',').collect();
    let unknown: Vec<&str> = wanted
        .iter()
        .copied()
        .filter(|name| !all.iter().any(|repo| repo.name == *name))
        .collect();
    if !unknown.is_empty() {
        return Err(format!("unknown repositories: {}", unknown.join(", ")));
    }
    Ok(all
        .into_iter()
        .filter(|repo| wanted.contains(&repo.name.as_str()))
        .collect())
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let text =
        fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("cannot read {}: {e}", path.display()))
}

/// The truth for one repository, symbols in file order.
pub fn read_truth(bench: &Path, repo: &str) -> Result<Vec<(String, Entry)>, String> {
    let path = bench.join("truth").join(format!("{repo}.json"));
    let symbols: serde_json::Map<String, Value> = read_json(&path)?;
    symbols
        .into_iter()
        .map(|(name, entry)| {
            serde_json::from_value(entry)
                .map(|entry| (name, entry))
                .map_err(|e| format!("{}: {e}", path.display()))
        })
        .collect()
}

fn git(args: &[&str], cwd: &Path) -> Result<String, String> {
    let failed = |why: String| format!("git {} failed: {why}", args.join(" "));
    let out = command("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| failed(e.to_string()))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(failed(if stderr.is_empty() {
            out.status.to_string()
        } else {
            stderr.into_owned()
        }));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

fn remove(path: &Path) -> Result<(), String> {
    match fs::remove_dir_all(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => {
            Err(format!("cannot remove {}: {e}", path.display()))
        }
        _ => Ok(()),
    }
}

/// One shallow fetch of the pinned commit. Line endings stay as committed, so the truth's line
/// numbers and the checkout agree on every platform.
fn fetch_repo(repo: &Repo, work: &Path) -> Result<PathBuf, String> {
    let dir = work.join("repos").join(&repo.name);
    if !dir.join(".git").exists() {
        remove(&dir)?;
        fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        git(&["init", "--quiet"], &dir)?;
        git(&["config", "core.autocrlf", "false"], &dir)?;
        git(&["config", "core.longpaths", "true"], &dir)?;
        git(
            &[
                "fetch",
                "--quiet",
                "--depth",
                "1",
                &format!("https://github.com/{}", repo.repository),
                &repo.sha,
            ],
            &dir,
        )?;
        git(&["checkout", "--quiet", "--detach", "FETCH_HEAD"], &dir)?;
    }
    let head = git(&["rev-parse", "HEAD"], &dir)?;
    if head != repo.sha {
        return Err(format!(
            "{} is at {head}, expected {}. Delete {} and rerun.",
            repo.name,
            repo.sha,
            dir.display()
        ));
    }
    Ok(dir)
}

/// Copies a folder, keeping each symbolic link as the link it is, with its target as written.
pub fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let (source, target) = (entry.path(), to.join(entry.file_name()));
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            link(&fs::read_link(&source)?, &source, &target)?;
        } else if kind.is_dir() {
            copy_tree(&source, &target)?;
        } else {
            fs::copy(&source, &target)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn link(points_to: &Path, _source: &Path, target: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(points_to, target)
}

/// Windows needs to know whether the link names a folder; one whose target is missing is a file link.
#[cfg(windows)]
fn link(points_to: &Path, source: &Path, target: &Path) -> io::Result<()> {
    if fs::metadata(source).is_ok_and(|meta| meta.is_dir()) {
        std::os::windows::fs::symlink_dir(points_to, target)
    } else {
        std::os::windows::fs::symlink_file(points_to, target)
    }
}

/// Runs `node <tool> <args>` with the scratch environment.
pub fn run_tool(
    node: &OsStr,
    tool: &Path,
    args: &[&OsStr],
    env: &[(&str, PathBuf)],
    cwd: &Path,
    timeout: Duration,
) -> Result<Output, String> {
    let what = args
        .iter()
        .map(|arg| arg.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ");
    let mut child = command(node);
    child
        .arg(tool)
        .args(args)
        .envs(env.iter().map(|(key, value)| (key, value.as_os_str())))
        .envs(FIXED_ENV)
        .current_dir(cwd);
    process::output(&mut child, timeout).map_err(|e| format!("{what}: {e}"))
}

/// What the scratch environment sets regardless of where it lives.
const FIXED_ENV: [(&str, &str); 5] = [
    ("DO_NOT_TRACK", "1"),
    ("TRAIL_CLOUD", "0"),
    ("GRAFT_NO_GITIGNORE", "1"),
    ("GRAFT_NO_IGNORE", "1"),
    ("GRAFT_NO_TRAIL_SWITCH", "1"),
];

/// The answer's JSON, from the first `{` to the end of the output.
pub fn parse_result(stdout: &str) -> Option<Value> {
    serde_json::from_str(&stdout[stdout.find('{')?..]).ok()
}

/// The scratch home keeps the run away from your graphs, agent settings and hooks whatever the
/// tool does, and the dotenv path keeps it away from any .env file.
fn scratch_env(work: &Path, label: &str) -> Result<Vec<(&'static str, PathBuf)>, String> {
    let home = work.join("home").join(label);
    let trail = home.join(".trail");
    fs::create_dir_all(&trail).map_err(|e| format!("cannot create {}: {e}", trail.display()))?;
    Ok(vec![
        ("TRAIL_HOME", trail),
        ("HOME", home.clone()),
        ("USERPROFILE", home.clone()),
        ("CLAUDE_CONFIG_DIR", home.join(".claude")),
        ("CODEX_HOME", home.join(".codex")),
        ("DOTENV_CONFIG_PATH", work.join("no-such.env")),
    ])
}

fn exit_text(status: ExitStatus) -> String {
    status
        .code()
        .map_or_else(|| "null".to_owned(), |code| code.to_string())
}

/// One build of one repository: its copy, its scratch environment and its label in messages.
struct Build<'a> {
    opts: &'a Options,
    repo: &'a Repo,
    tool: &'a Path,
    label: &'a str,
    copy: PathBuf,
    env: Vec<(&'static str, PathBuf)>,
}

impl<'a> Build<'a> {
    /// Copies the checkout and builds the copy's graph with the tool.
    fn start(
        opts: &'a Options,
        repo: &'a Repo,
        source: &Path,
        tool: &'a Path,
        label: &'a str,
    ) -> Result<Self, String> {
        let copy = opts.work.join("run").join(label).join(&repo.name);
        remove(&copy)?;
        copy_tree(source, &copy).map_err(|e| {
            format!(
                "cannot copy {} to {}: {e}",
                source.display(),
                copy.display()
            )
        })?;
        let build = Build {
            opts,
            repo,
            tool,
            label,
            env: scratch_env(&opts.work, label)?,
            copy,
        };
        let args = [
            OsStr::new("build"),
            build.copy.as_os_str(),
            OsStr::new("--no-gitignore"),
            OsStr::new("--no-ignore"),
        ];
        let built = build.call(&args, 45 * MINUTE)?;
        if !built.status.success() {
            return Err(format!(
                "{label} could not build {}:\n{}\n{}",
                repo.name, built.stdout, built.stderr
            ));
        }
        Ok(build)
    }

    fn call(&self, args: &[&OsStr], timeout: Duration) -> Result<Output, String> {
        run_tool(
            &self.opts.node,
            self.tool,
            args,
            &self.env,
            &self.opts.work,
            timeout,
        )
    }

    /// One symbol's answer, scored, and whether it held any JSON.
    fn ask(&self, symbol: &str, entry: &Entry) -> Result<(SymbolScore, bool), String> {
        let (label, name) = (self.label, &self.repo.name);
        let args = [
            OsStr::new("callers"),
            OsStr::new(symbol),
            self.copy.as_os_str(),
            OsStr::new("--json"),
        ];
        let answer = self.call(&args, 10 * MINUTE)?;
        let result = parse_result(&answer.stdout);
        if result.is_none() {
            eprintln!(
                "benchmark: {label} {name} {symbol}: no JSON in the output (exit {})",
                exit_text(answer.status)
            );
        }
        let none = Value::Object(serde_json::Map::new());
        let score = score_symbol(entry, result.as_ref().unwrap_or(&none), self.repo.rules)
            .map_err(|e| format!("{label} {name} {symbol}: {e}"))?;
        if self.opts.verbose {
            let misses: Vec<String> = score
                .missed
                .iter()
                .take(10)
                .map(|row| format!("{}:{}", row.file, row.chain))
                .collect();
            eprintln!(
                "{label} {name} {symbol}: {}/{} {} {}",
                score.found,
                score.required,
                score.undercount,
                misses.join(" ")
            );
        }
        Ok((score, result.is_some()))
    }
}

/// One build under `label`, scored: 'ambitious but rubbish' is the result this table exists to catch.
fn score_repo(
    opts: &Options,
    repo: &Repo,
    source: &Path,
    tool: &Path,
    label: &str,
) -> Result<Summary, String> {
    let truth = read_truth(&opts.bench, &repo.name)?;
    let build = Build::start(opts, repo, source, tool, label)?;
    let (mut scores, mut unreadable) = (Vec::new(), 0);
    for (symbol, entry) in &truth {
        let (score, readable) = build.ask(symbol, entry)?;
        unreadable += usize::from(!readable);
        scores.push(score);
    }
    // A broken tool must not pass as a recall of 0.00.
    if unreadable == scores.len() {
        return Err(format!(
            "{label} returned no readable answer for any symbol in {}.",
            repo.name
        ));
    }
    remove(&build.copy)?;
    Ok(summarise(&scores))
}

/// The last line `--version` prints, or 'unknown'. It runs in the caller's own environment.
fn tool_version(node: &OsStr, tool: &Path, work: &Path) -> String {
    let out = command(node)
        .arg(tool)
        .arg("--version")
        .current_dir(work)
        .stdin(Stdio::piped())
        .output();
    let stdout = out
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
        .unwrap_or_default();
    match stdout.trim().split('\n').next_back() {
        Some(line) if !line.is_empty() => line.to_owned(),
        _ => "unknown".to_owned(),
    }
}

pub fn node_version(node: &OsStr) -> Result<String, String> {
    let out = command(node)
        .arg("--version")
        .stdin(Stdio::piped())
        .output()
        .map_err(|e| format!("cannot run {}: {e}", node.to_string_lossy()))?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// Today's date in UTC, as YYYY-MM-DD.
pub fn utc_date(now: SystemTime) -> String {
    let days = now
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs() / 86_400);
    let (year, month, day) = civil_from_days(days.try_into().unwrap_or(i64::MAX));
    format!("{year:04}-{month:02}-{day:02}")
}

/// Howard Hinnant's days-to-civil conversion for the proleptic Gregorian calendar.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// Fetches and scores every repository, then returns the report the README carries.
pub fn run(opts: &Options) -> Result<String, String> {
    let node = node_version(&opts.node)?;
    let mut upstream = opts.baseline.as_ref().map(|_| Summaries::new());
    let mut patched = HashMap::new();
    for repo in &opts.repos {
        let source = fetch_repo(repo, &opts.work)?;
        if let (Some(baseline), Some(upstream)) = (&opts.baseline, upstream.as_mut()) {
            upstream.insert(
                repo.name.clone(),
                score_repo(opts, repo, &source, baseline, "upstream")?,
            );
        }
        patched.insert(
            repo.name.clone(),
            score_repo(opts, repo, &source, &opts.tool, "patched")?,
        );
    }
    Ok(report(opts, &node, upstream.as_ref(), &patched))
}

fn report(opts: &Options, node: &str, upstream: Option<&Summaries>, patched: &Summaries) -> String {
    let in_order = |summaries: &'_ Summaries| {
        opts.repos
            .iter()
            .map(|repo| summaries[&repo.name].clone())
            .collect::<Vec<_>>()
    };
    let mut out = format!("Node {node}, {} UTC\n", utc_date(SystemTime::now()));
    if let Some(baseline) = &opts.baseline {
        out += &format!(
            "Upstream: {} ({})\n",
            baseline.display(),
            tool_version(&opts.node, baseline, &opts.work)
        );
    }
    out += &format!(
        "Patched: {} ({})\n\n",
        opts.tool.display(),
        tool_version(&opts.node, &opts.tool, &opts.work)
    );
    let (upstream_list, patched_list) = (upstream.map(in_order), in_order(patched));
    out += &overall_line(upstream_list.as_deref(), &patched_list);
    out += &format!("\n\n{}\n\n", recall_table(&opts.repos, upstream, patched));
    if let Some(upstream) = upstream {
        out += &format!("{}\n\n", detail_table(&opts.repos, "Upstream", upstream));
    }
    out += &detail_table(&opts.repos, "Patched", patched);
    out.push('\n');
    out
}
