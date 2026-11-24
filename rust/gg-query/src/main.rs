#![forbid(unsafe_code)]

mod commands;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use commands::{
    AskCmdArgs, AskDenseCmdArgs, CallersCmdArgs, run_ask_cmd, run_ask_dense, run_blast,
    run_callers, run_crate_source, run_embed, run_hubs, run_skeleton_cmd, run_status, run_sync,
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
        /// Explicit repo-relative changed file paths (defaults to `git diff --name-only HEAD`)
        #[arg(long = "changed")]
        changed: Vec<String>,
        #[arg(short, long)]
        depth: Option<String>,
        #[arg(long, default_value = "text")]
        format: String,
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
    },
    /// Signatures-only API view of one indexed file
    Skeleton {
        file: String,
        #[arg(default_value = ".")]
        repo: PathBuf,
        #[arg(long)]
        json: bool,
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

fn dispatch(command: Cmd, dir: Option<&std::path::Path>) -> Result<(), String> {
    match command {
        Cmd::Sync { repo } => run_sync(&repo, dir),
        Cmd::Status { repo, json } => run_status(&repo, dir, json),
        Cmd::Callers {
            symbol,
            repo,
            direction,
            depth,
            in_prefix,
            json,
            provenance,
        } => run_callers(&CallersCmdArgs {
            symbol: &symbol,
            repo: &repo,
            override_dir: dir,
            direction: direction.as_deref(),
            depth: depth.as_deref(),
            in_prefix: in_prefix.as_deref(),
            json,
            provenance,
        }),
        Cmd::Hubs {
            repo,
            limit,
            in_prefix,
            json,
        } => run_hubs(&repo, dir, limit, in_prefix.as_deref(), json),
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
        Cmd::Blast {
            repo,
            changed,
            depth,
            format,
        } => run_blast(&repo, dir, &changed, depth.as_deref(), &format),
        Cmd::Ask {
            query,
            repo,
            limit,
            source,
            full,
            in_prefix,
            json,
            no_graph_rank,
            model,
            no_semantic,
        } => run_ask_cmd(&AskCmdArgs {
            query: &query,
            repo: &repo,
            override_dir: dir,
            limit,
            source,
            full,
            in_prefix: in_prefix.as_deref(),
            json,
            no_graph_rank,
            model: model.as_deref(),
            no_semantic,
        }),
        Cmd::Skeleton { file, repo, json } => run_skeleton_cmd(&file, &repo, dir, json),
        Cmd::Embed {
            text,
            model,
            whole,
            json,
        } => run_embed(&text, &model, whole, json),
        Cmd::AskDense {
            query,
            repo,
            model,
            limit,
            in_prefix,
            json,
        } => run_ask_dense(&AskDenseCmdArgs {
            query: &query,
            repo: &repo,
            override_dir: dir,
            model: &model,
            limit,
            in_prefix: in_prefix.as_deref(),
            json,
        }),
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
