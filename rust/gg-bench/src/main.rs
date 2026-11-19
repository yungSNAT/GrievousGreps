use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};
use gg_bench::ask::AskOptions;
use gg_bench::lsp::{Ask, LspOptions};
use gg_bench::run::{self, Options};
use gg_bench::score::{Repo, score_symbol, summarise};
use gg_bench::truth::TruthOptions;
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
    /// Start a language server in a copy of each pinned repository of one language, ask it for
    /// the callers of each truth symbol and print recall. Install each checkout's dependencies
    /// first where the server reads them. The answers are kept under the work folder's `lsp/`.
    Lsp(LspArgs),
    /// Derive one repository's truth from a language server's references and write
    /// truth/<repo>.json, as tsc-truth.mjs does with the TypeScript compiler. With `--pick` it
    /// first chooses the symbols by a fixed rule, for a repository that has no truth yet.
    LspTruth(LspTruthArgs),
    /// Ask a tool each question of a file-retrieval set in semble's format and print NDCG@10,
    /// hit@1, hit@3 and hit@10, then every question with no relevant file among the first 3.
    /// The answers are kept under the work folder's `answers/`.
    Ask(AskArgs),
}

/// The retrieval set beside this crate: semble's, as vendored in benchmark/ask/semble.
const ASK_SET: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../benchmark/ask/semble");

#[derive(Args)]
struct AskArgs {
    /// The build to measure: dist/bin/graft.js.
    #[arg(long)]
    tool: PathBuf,
    /// The set: repos.json and annotations/.
    #[arg(long, default_value = ASK_SET)]
    set: PathBuf,
    /// Comma-separated repository names; all of them by default.
    #[arg(long)]
    repos: Option<String>,
    /// Ask only the questions of this category, such as `symbol`.
    #[arg(long)]
    category: Option<String>,
    /// Scratch folder for checkouts, answers and the tool's home [default: grievousgreps-benchmark
    /// in the temporary folder].
    #[arg(long)]
    work: Option<PathBuf>,
    /// The Node that runs the tool.
    #[arg(long, default_value = "node")]
    node: OsString,
}

#[derive(Args)]
struct LspTruthArgs {
    /// The repository, as repos.json names it.
    #[arg(long)]
    repo: String,
    /// Choose this many functions and methods from the repository's non-test source files, in an
    /// order the seed fixes, keeping those with 3 to 300 calls.
    #[arg(long)]
    pick: Option<usize>,
    /// The seed for `--pick`.
    #[arg(long, default_value_t = 0)]
    seed: u64,
    /// Scratch folder for the checkout [default: grievousgreps-benchmark in the temporary folder].
    #[arg(long)]
    work: Option<PathBuf>,
    /// The server and its arguments, after `--`.
    #[arg(last = true, required = true)]
    server: Vec<OsString>,
}

#[derive(Args)]
struct LspArgs {
    /// The language whose repositories the server reads: Python, TypeScript or Rust.
    #[arg(long)]
    language: String,
    /// What to ask the server.
    #[arg(long, value_enum, default_value = "calls")]
    ask: Ask,
    /// Comma-separated repository names; all of the language's by default.
    #[arg(long)]
    repos: Option<String>,
    /// Scratch folder for checkouts and answers [default: grievousgreps-benchmark in the
    /// temporary folder].
    #[arg(long)]
    work: Option<PathBuf>,
    /// Print each symbol's score and its first 10 misses on stderr.
    #[arg(long)]
    verbose: bool,
    /// The server and its arguments, after `--`: `-- pyright-langserver --stdio`.
    #[arg(last = true, required = true)]
    server: Vec<OsString>,
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

fn work_folder(work: Option<PathBuf>) -> Result<PathBuf, String> {
    let work = absolute(
        &work
            // nosemgrep: rust.lang.security.temp-dir.temp-dir -- a scratch folder for clones, as run.mjs used
            .unwrap_or_else(|| std::env::temp_dir().join("grievousgreps-benchmark")),
    )?;
    fs::create_dir_all(&work).map_err(|e| format!("cannot create {}: {e}", work.display()))?;
    Ok(work)
}

fn lsp_command(bench: PathBuf, args: LspArgs) -> Result<String, String> {
    let repos: Vec<Repo> = run::select_repos(&bench, args.repos.as_deref())?
        .into_iter()
        .filter(|repo| repo.language == args.language)
        .collect();
    if repos.is_empty() {
        return Err(format!("no {} repositories to ask.", args.language));
    }
    let work = work_folder(args.work)?;
    gg_bench::process::lower_priority();
    gg_bench::lsp::run(&LspOptions {
        bench,
        repos,
        work,
        server: args.server,
        ask: args.ask,
        verbose: args.verbose,
    })
}

fn lsp_truth_command(bench: PathBuf, args: LspTruthArgs) -> Result<String, String> {
    let [repo]: [Repo; 1] = run::select_repos(&bench, Some(&args.repo))?
        .try_into()
        .map_err(|_| "--repo takes one repository.")?;
    let work = work_folder(args.work)?;
    gg_bench::process::lower_priority();
    gg_bench::truth::run(&TruthOptions {
        bench,
        repo,
        work,
        server: args.server,
        pick: args.pick,
        seed: args.seed,
    })
}

fn ask_command(args: AskArgs) -> Result<String, String> {
    let tool = absolute(&args.tool)?;
    if !tool.exists() {
        return Err(format!("{} does not exist.", tool.display()));
    }
    let set = absolute(&args.set)?;
    let repos = gg_bench::ask::select(&set, args.repos.as_deref())?;
    let work = work_folder(args.work)?;
    gg_bench::process::lower_priority();
    gg_bench::ask::run(&AskOptions {
        set,
        node: args.node,
        tool,
        repos,
        category: args.category,
        work,
    })
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
    let work = work_folder(args.work)?;
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
        Command::Lsp(args) => lsp_command(cli.bench, args),
        Command::LspTruth(args) => lsp_truth_command(cli.bench, args),
        Command::Ask(args) => ask_command(args),
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
