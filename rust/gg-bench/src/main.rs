use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};
use gg_bench::run::{self, Options};
use gg_bench::score::{Repo, score_symbol, summarise};
use serde_json::{Map, Value, json};

/// The benchmark folder beside this crate: repos.json and truth/.
const BENCH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../benchmark");

/// The caller benchmark: how many real calls `callers` finds on 21 pinned public repositories.
#[derive(Parser)]
#[command(version)]
struct Cli {
    /// The benchmark folder, with repos.json and truth/.
    #[arg(long, global = true, default_value = BENCH)]
    bench: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Build each pinned repository with a tool, ask it for the callers of each truth symbol and
    /// print recall. It only builds and queries; it never runs the tool's own tests.
    Run(RunArgs),
    /// Score another tool's answers for one repository: a JSON object of `callers --json`-shaped
    /// answers keyed by symbol. Prints each symbol's score and the summary as JSON.
    Score {
        /// The repository, as repos.json names it.
        #[arg(long)]
        repo: String,
        /// The answers file.
        #[arg(long)]
        answers: PathBuf,
    },
}

#[derive(Args)]
struct RunArgs {
    /// The build to measure: dist/bin/graft.js.
    #[arg(long)]
    tool: Option<PathBuf>,
    /// An upstream build to measure beside it.
    #[arg(long)]
    baseline: Option<PathBuf>,
    /// Comma-separated repository names; all of them by default.
    #[arg(long)]
    repos: Option<String>,
    /// Scratch folder for checkouts, copies and the tool's home [default: grievousgreps-benchmark
    /// in the temporary folder].
    #[arg(long)]
    work: Option<PathBuf>,
    /// Print each symbol's score and its first 10 misses on stderr.
    #[arg(long)]
    verbose: bool,
    /// The Node that runs the tool.
    #[arg(long, default_value = "node")]
    node: OsString,
}

fn absolute(path: &Path) -> Result<PathBuf, String> {
    run::absolute(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn run_command(bench: PathBuf, args: RunArgs) -> Result<String, String> {
    let tool = absolute(
        &args
            .tool
            .ok_or("--tool <path to dist/bin/graft.js> is required.")?,
    )?;
    let baseline = args.baseline.as_deref().map(absolute).transpose()?;
    if let Some(missing) = std::iter::once(&tool)
        .chain(&baseline)
        .find(|path| !path.exists())
    {
        return Err(format!("{} does not exist.", missing.display()));
    }
    let repos = run::select_repos(&bench, args.repos.as_deref())?;
    let work = absolute(
        &args
            .work
            .unwrap_or_else(|| std::env::temp_dir().join("grievousgreps-benchmark")),
    )?;
    fs::create_dir_all(&work).map_err(|e| format!("cannot create {}: {e}", work.display()))?;
    gg_bench::process::lower_priority();
    run::run(&Options {
        bench,
        node: args.node,
        tool,
        baseline,
        repos,
        work,
        verbose: args.verbose,
    })
}

fn score_command(bench: &Path, name: &str, answers_path: &Path) -> Result<String, String> {
    let [repo]: [Repo; 1] = run::select_repos(bench, Some(name))?
        .try_into()
        .map_err(|_| "--repo takes one repository.")?;
    let truth = run::read_truth(bench, &repo.name)?;
    let answers: Map<String, Value> = run::read_json(answers_path)?;
    let (mut symbols, mut scores, none) = (Map::new(), Vec::new(), json!({}));
    for (symbol, entry) in &truth {
        let answer = answers.get(symbol).unwrap_or_else(|| {
            eprintln!(
                "benchmark: {} {symbol}: no answer in {}",
                repo.name,
                answers_path.display()
            );
            &none
        });
        let score = score_symbol(entry, answer, repo.rules)
            .map_err(|e| format!("{} {symbol}: {e}", repo.name))?;
        symbols.insert(
            symbol.clone(),
            serde_json::to_value(&score).map_err(|e| e.to_string())?,
        );
        scores.push(score);
    }
    for extra in answers
        .keys()
        .filter(|key| !truth.iter().any(|(symbol, _)| symbol == *key))
    {
        eprintln!(
            "benchmark: {} {extra}: not a truth symbol, so not scored",
            repo.name
        );
    }
    let report = json!({ "symbols": symbols, "summary": summarise(&scores) });
    Ok(format!("{report:#}\n"))
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Run(args) => run_command(cli.bench, args),
        Command::Score { repo, answers } => score_command(&cli.bench, &repo, &answers),
    };
    match result {
        Ok(out) => {
            print!("{out}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("benchmark: {e}");
            ExitCode::FAILURE
        }
    }
}
