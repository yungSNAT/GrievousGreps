#![forbid(unsafe_code)]

mod commands;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use commands::{
    AskCmdArgs, AskDenseCmdArgs, BlastCmdArgs, CallersCmdArgs, run_ask_cmd, run_ask_dense,
    run_blast, run_callers, run_crate_source, run_embed, run_hubs, run_skeleton_cmd, run_status,
    run_sync,
};
use gg_query::crate_source::CrateSourceArgs;

#[derive(Parser)]
#[command(
    name = "gg-query",
    about = "Native Rust query engine for GrievousGreps (SQLite graph + hybrid ask + F16 Model2Vec)"
)]
struct Cli {
    /// Context directory override (default: <repo>/.trail/cache or <repo>/graft)
    #[arg(long, global = true)]
    dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Build or refresh <outDir>/.graph/wiring.sqlite from wiring.json
    Sync {
        #[arg(default_value = ".")]
        repo: PathBuf,
    },
    /// Show code map status from the SQLite graph store
    Status {
        #[arg(default_value = ".")]
        repo: PathBuf,
        #[arg(long)]
        json: bool,
        #[arg(long = "no-refresh")]
        no_refresh: bool,
    },
    /// Trace callers or callees of a symbol from the SQLite graph store
    Callers {
        symbol: String,
        #[arg(default_value = ".")]
        repo: PathBuf,
        #[arg(long)]
        direction: Option<String>,
        #[arg(short, long)]
        depth: Option<String>,
        #[arg(long = "in")]
        in_prefix: Option<String>,
        #[arg(long)]
        json: bool,
        #[arg(long)]
        provenance: bool,
        #[arg(long = "no-refresh")]
        no_refresh: bool,
    },
    /// Surface top hub symbols by PageRank and edge connectivity
    Hubs {
        #[arg(default_value = ".")]
        repo: PathBuf,
        #[arg(short = 'n', long)]
        limit: Option<usize>,
        #[arg(long = "in")]
        in_prefix: Option<String>,
        #[arg(long)]
        json: bool,
        #[arg(long = "no-refresh")]
        no_refresh: bool,
    },
    /// Resolve a Cargo.lock dependency to its exact local source path
    CrateSource {
        crate_name: String,
        #[arg(default_value = ".")]
        repo: PathBuf,
        #[arg(long)]
        version: Option<String>,
        #[arg(long = "cargo-home")]
        cargo_home: Option<PathBuf>,
        #[arg(long)]
        lockfile: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    /// Compute blast radius from changed files over the SQLite graph store
    Blast {
        #[arg(default_value = ".")]
        repo: PathBuf,
        /// Base ref to diff against (`origin/main`); default: working tree vs HEAD
        #[arg(long)]
        base: Option<String>,
        /// Explicit repo-relative changed file paths (legacy test override)
        #[arg(long = "changed")]
        changed: Vec<String>,
        #[arg(short, long)]
        depth: Option<String>,
        #[arg(long, default_value = "text")]
        format: String,
        /// Do not suggest reviewers from git history
        #[arg(long = "no-owners")]
        no_owners: bool,
        /// PR author names/logins/emails to exclude from reviewer suggestions
        #[arg(long = "pr-author")]
        pr_author: Vec<String>,
        /// Also list test files reaching this change over full closure
        #[arg(long)]
        tests: bool,
        #[arg(long = "no-refresh")]
        no_refresh: bool,
    },
    /// Query the graph: structural, lexical BM25+PPR, and F16 Model2Vec hybrid RRF
    Ask {
        /// Plain-words query (`-` reads from stdin)
        query: String,
        #[arg(default_value = ".")]
        repo: PathBuf,
        #[arg(short = 'n', long, default_value_t = 8)]
        limit: usize,
        #[arg(long)]
        source: bool,
        #[arg(long)]
        full: bool,
        #[arg(long = "max-tokens")]
        max_tokens: Option<String>,
        #[arg(long = "in")]
        in_prefix: Option<String>,
        #[arg(long)]
        json: bool,
        #[arg(long = "no-graph-rank")]
        no_graph_rank: bool,
        #[arg(long)]
        model: Option<PathBuf>,
        #[arg(long = "no-semantic")]
        no_semantic: bool,
        #[arg(long = "no-refresh")]
        no_refresh: bool,
    },
    /// Signatures-only API view of one indexed file
    Skeleton {
        file: String,
        #[arg(default_value = ".")]
        repo: PathBuf,
        #[arg(long)]
        json: bool,
        #[arg(long = "no-refresh")]
        no_refresh: bool,
    },
    /// Embed text using the shipped F16 Model2Vec safetensors model
    Embed {
        text: String,
        #[arg(long)]
        model: PathBuf,
        #[arg(long)]
        whole: bool,
        #[arg(long)]
        json: bool,
    },
    /// Run dense semantic cosine search over ask-vectors.bin using F16 Model2Vec
    AskDense {
        query: String,
        #[arg(default_value = ".")]
        repo: PathBuf,
        #[arg(long)]
        model: PathBuf,
        #[arg(short = 'n', long, default_value_t = 10)]
        limit: usize,
        #[arg(long = "in")]
        in_prefix: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

fn resolve_repo(repo: PathBuf) -> PathBuf {
    use std::path::Component;
    let abs = if repo.is_absolute() {
        repo
    } else if let Ok(cwd) = std::env::current_dir() {
        cwd.join(repo)
    } else {
        return repo;
    };
    let mut out = PathBuf::new();
    for comp in abs.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c.as_os_str()),
        }
    }
    out
}

fn dispatch(command: Cmd, dir: Option<&std::path::Path>) -> Result<(), String> {
    match command {
        Cmd::Sync { repo } => run_sync(&resolve_repo(repo), dir),
        Cmd::Status {
            repo,
            json,
            no_refresh,
        } => run_status(&resolve_repo(repo), dir, json, no_refresh),
        Cmd::Callers {
            symbol,
            repo,
            direction,
            depth,
            in_prefix,
            json,
            provenance,
            no_refresh,
        } => run_callers(&CallersCmdArgs {
            symbol: &symbol,
            repo: &resolve_repo(repo),
            override_dir: dir,
            direction: direction.as_deref(),
            depth: depth.as_deref(),
            in_prefix: in_prefix.as_deref(),
            json,
            provenance,
            no_refresh,
        }),
        Cmd::Hubs {
            repo,
            limit,
            in_prefix,
            json,
            no_refresh,
        } => run_hubs(
            &resolve_repo(repo),
            dir,
            limit,
            in_prefix.as_deref(),
            json,
            no_refresh,
        ),
        Cmd::CrateSource {
            crate_name,
            repo,
            version,
            cargo_home,
            lockfile,
            json,
        } => run_crate_source(
            &CrateSourceArgs {
                crate_name: &crate_name,
                repo: &repo,
                version: version.as_deref(),
                cargo_home: cargo_home.as_deref(),
                lockfile: lockfile.as_deref(),
            },
            json,
        ),
        Cmd::Skeleton {
            file,
            repo,
            json,
            no_refresh,
        } => run_skeleton_cmd(&file, &resolve_repo(repo), dir, json, no_refresh),
        Cmd::Embed {
            text,
            model,
            whole,
            json,
        } => run_embed(&text, &model, whole, json),
        other => dispatch_analysis(other, dir),
    }
}

fn dispatch_analysis(command: Cmd, dir: Option<&std::path::Path>) -> Result<(), String> {
    match command {
        Cmd::Blast {
            repo,
            base,
            changed,
            depth,
            format,
            no_owners,
            pr_author,
            tests,
            no_refresh,
        } => run_blast(&BlastCmdArgs {
            repo: &resolve_repo(repo),
            override_dir: dir,
            base: base.as_deref(),
            changed_arg: &changed,
            depth: depth.as_deref(),
            format: &format,
            no_owners,
            pr_author: &pr_author,
            tests,
            no_refresh,
        }),
        Cmd::Ask {
            query,
            repo,
            limit,
            source,
            full,
            max_tokens,
            in_prefix,
            json,
            no_graph_rank,
            model,
            no_semantic,
            no_refresh,
        } => run_ask_cmd(&AskCmdArgs {
            query: &query,
            repo: &resolve_repo(repo),
            override_dir: dir,
            limit,
            source,
            full,
            max_tokens: max_tokens.as_deref(),
            in_prefix: in_prefix.as_deref(),
            json,
            no_graph_rank,
            model: model.as_deref(),
            no_semantic,
            no_refresh,
        }),
        Cmd::AskDense {
            query,
            repo,
            model,
            limit,
            in_prefix,
            json,
        } => run_ask_dense(&AskDenseCmdArgs {
            query: &query,
            repo: &resolve_repo(repo),
            override_dir: dir,
            model: &model,
            limit,
            in_prefix: in_prefix.as_deref(),
            json,
        }),
        _ => unreachable!("handled in dispatch"),
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match dispatch(cli.command, cli.dir.as_deref()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("✗ {msg}");
            ExitCode::FAILURE
        }
    }
}
