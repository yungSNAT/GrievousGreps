use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use clap::{Parser, Subcommand};
use gg_query::embed::SafetensorsEmbedder;
use gg_query::format::{SymbolResult, format_blast_json, format_callers_json, format_callers_text};
use gg_query::graph::{
    Direction, EdgeHit, NodeV1, UnresolvedCall, group_digits, normalize_path_prefix, parse_depth,
    path_under_prefix,
};
use gg_query::store::GraphStore;
use gg_query::vectors::{dense_files, read_vectors};

#[derive(Parser)]
#[command(
    name = "gg-query",
    about = "Native Rust query engine for GrievousGreps (SQLite graph + F16 Model2Vec)"
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

fn context_dir_for(repo: &Path, override_dir: Option<&Path>) -> PathBuf {
    if let Some(d) = override_dir {
        return d.to_path_buf();
    }
    let trail_cache = repo.join(".trail").join("cache");
    if trail_cache.join(".graph").join("wiring.json").is_file() {
        return trail_cache;
    }
    repo.join("graft")
}

fn run_sync(repo: &Path, override_dir: Option<&Path>) -> Result<(), String> {
    let ctx = context_dir_for(repo, override_dir);
    let (nodes, edges) = GraphStore::force_sync(&ctx).map_err(|e| e.to_string())?;
    println!(
        "synced {nodes} nodes, {edges} edges → {}",
        ctx.join(".graph/wiring.sqlite").display()
    );
    Ok(())
}

fn run_status(repo: &Path, override_dir: Option<&Path>, json: bool) -> Result<(), String> {
    let ctx = context_dir_for(repo, override_dir);
    let store = GraphStore::open_or_sync(&ctx).map_err(|e| e.to_string())?;
    let nodes = match store {
        Some(ref s) => Some(s.node_count().map_err(|e| e.to_string())?),
        None => None,
    };
    if json {
        let code_map = match nodes {
            Some(n) => serde_json::json!({ "nodes": n, "inSync": true }),
            None => serde_json::Value::Null,
        };
        let mut week = serde_json::Map::new();
        week.insert(["saved", "Tokens"].concat(), serde_json::json!(0));
        let mut root = serde_json::Map::new();
        root.insert("codeMap".to_string(), code_map);
        root.insert("learnings".to_string(), serde_json::Value::Null);
        root.insert("workspace".to_string(), serde_json::Value::Null);
        root.insert("week".to_string(), serde_json::Value::Object(week));
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::Value::Object(root))
                .map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    match nodes {
        None => println!("{:<11} ✗ not built · run trail build", "code map"),
        Some(n) => println!(
            "{:<11} ✓ {} nodes · in sync with the code",
            "code map",
            group_digits(n)
        ),
    }
    println!("{:<11} nothing saved yet", "this week");
    Ok(())
}

fn run_callers(
    symbol: &str,
    repo: &Path,
    override_dir: Option<&Path>,
    direction: Option<&str>,
    depth: Option<&str>,
    in_prefix: Option<&str>,
    json: bool,
) -> Result<(), String> {
    let ctx = context_dir_for(repo, override_dir);
    let Some(store) = GraphStore::open_or_sync(&ctx).map_err(|e| e.to_string())? else {
        return Err(format!(
            "no graph found at {} — run `trail build` first",
            ctx.display()
        ));
    };
    let dir = Direction::parse(direction)?;
    let max_depth = parse_depth(depth, 1)?;
    let (results, unresolved_by_name, saved) = store
        .with_read_snapshot(|s| {
            let matches = s.resolve_symbol(symbol, in_prefix)?;
            if matches.is_empty() {
                return Ok((Vec::new(), HashMap::new(), None));
            }
            let mut results = Vec::with_capacity(matches.len());
            let mut unresolved_by_name: HashMap<String, Vec<UnresolvedCall>> = HashMap::new();
            let mut paths: Vec<String> = Vec::new();
            for m in matches {
                let hits = s.edge_walk(&m, dir, max_depth)?;
                paths.push(m.path.clone());
                for h in &hits {
                    if let Some(ref n) = h.node {
                        paths.push(n.path.clone());
                    }
                }
                if !unresolved_by_name.contains_key(&m.name) {
                    unresolved_by_name.insert(m.name.clone(), s.unresolved_calls_for(&m.name)?);
                }
                results.push(SymbolResult { symbol: m, hits });
            }
            let saved = s.savings_for_paths(paths.iter().map(String::as_str))?;
            Ok((results, unresolved_by_name, saved))
        })
        .map_err(|e| e.to_string())?;
    if results.is_empty() {
        return Err(format!(
            "no symbol \"{symbol}\" in the graph — check spelling or run trail build"
        ));
    }
    if json {
        println!(
            "{}",
            format_callers_json(symbol, dir, &results, &unresolved_by_name, saved.as_ref())
        );
    } else {
        print!(
            "{}",
            format_callers_text(
                repo,
                dir,
                max_depth > 1,
                &results,
                &unresolved_by_name,
                saved.as_ref()
            )
        );
    }
    Ok(())
}

fn git_changed_files(repo: &Path) -> Result<Vec<String>, String> {
    let out = Command::new("git")
        .args(["diff", "--name-only", "-z", "HEAD"])
        .current_dir(repo)
        .output()
        .map_err(|e| format!("failed to run git diff: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "could not read a diff in {} — is this a git repository?",
            repo.display()
        ));
    }
    let mut files = Vec::new();
    for raw in out.stdout.split(|&b| b == 0) {
        if raw.is_empty() {
            continue;
        }
        let s =
            std::str::from_utf8(raw).map_err(|_| "git diff returned non-UTF-8 path".to_string())?;
        files.push(normalize_path_prefix(s));
    }
    Ok(files)
}

fn run_blast(
    repo: &Path,
    override_dir: Option<&Path>,
    changed_arg: &[String],
    depth: Option<&str>,
    format: &str,
) -> Result<(), String> {
    if format != "text" && format != "json" {
        return Err(format!("--format must be text or json, got \"{format}\""));
    }
    let max_depth = parse_depth(depth, 2)?;
    let ctx = context_dir_for(repo, override_dir);
    let Some(store) = GraphStore::open_or_sync(&ctx).map_err(|e| e.to_string())? else {
        return Err(format!(
            "no graph found at {} — run `trail build` first",
            ctx.display()
        ));
    };
    let changed: Vec<String> = if changed_arg.is_empty() {
        git_changed_files(repo)?
    } else {
        changed_arg
            .iter()
            .map(|p| normalize_path_prefix(p))
            .collect()
    };

    let (seeds, impacted): (Vec<NodeV1>, Vec<EdgeHit>) = store
        .with_read_snapshot(|s| {
            let mut seeds = Vec::new();
            let mut seed_ids = Vec::new();
            for p in &changed {
                for n in s.nodes_by_path(p)? {
                    if n.kind == "file" {
                        seed_ids.push(n.id.clone());
                        seeds.push(n);
                    } else if n.kind != "resource" {
                        seed_ids.push(n.id);
                    }
                }
            }
            let impacted = if seed_ids.is_empty() {
                Vec::new()
            } else {
                s.impact_of_many(&seed_ids, max_depth, Direction::In)?
            };
            Ok((seeds, impacted))
        })
        .map_err(|e| e.to_string())?;

    if format == "json" {
        println!(
            "{}",
            format_blast_json(max_depth, &changed, &seeds, &impacted)?
        );
        return Ok(());
    }

    println!("blast radius — working tree vs HEAD (depth {max_depth})");
    println!(
        "  changed: {} file(s), {} seed(s)",
        changed.len(),
        seeds.len()
    );
    println!("  impacted: {} symbol(s)", impacted.len());
    for h in &impacted {
        match &h.node {
            Some(n) => println!(
                "  {} ← {} ({}:{}) [depth {}]",
                h.relation, n.name, n.path, n.span, h.depth
            ),
            None => println!("  {} ← {} [depth {}]", h.relation, h.id, h.depth),
        }
    }
    Ok(())
}

fn run_embed(text: &str, model: &Path, whole: bool, json: bool) -> Result<(), String> {
    let mut emb = SafetensorsEmbedder::open(model, whole).map_err(|e| e.to_string())?;
    let vec = emb.embed(text).map_err(|e| e.to_string())?;
    if json {
        println!(
            "{}",
            serde_json::to_string(&vec).map_err(|e| e.to_string())?
        );
    } else {
        println!(
            "dim={} norm={:.6}",
            vec.len(),
            vec.iter().map(|v| v * v).sum::<f32>().sqrt()
        );
    }
    Ok(())
}

fn run_ask_dense(
    query: &str,
    repo: &Path,
    override_dir: Option<&Path>,
    model: &Path,
    limit: usize,
    in_prefix: Option<&str>,
    json: bool,
) -> Result<(), String> {
    let ctx = context_dir_for(repo, override_dir);
    let Some(index) = read_vectors(&ctx).map_err(|e| e.to_string())? else {
        return Err(format!(
            "no valid ask-vectors.bin found under {}",
            ctx.display()
        ));
    };
    let mut emb = SafetensorsEmbedder::open(model, false).map_err(|e| e.to_string())?;
    if index.dim != emb.dim() {
        return Err(format!(
            "ask-vectors.bin dimension ({}) does not match model dimension ({})",
            index.dim,
            emb.dim()
        ));
    }
    let qvec = emb.embed(query).map_err(|e| e.to_string())?;
    let prefix = in_prefix.map(normalize_path_prefix);
    let mut hits = dense_files(&index, &qvec, |path| match &prefix {
        Some(p) => path_under_prefix(path, p),
        None => true,
    });
    hits.truncate(limit);
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&hits).map_err(|e| e.to_string())?
        );
    } else {
        for h in &hits {
            println!("{:.6}  {}:L{}-L{}", h.score, h.path, h.start, h.end);
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let res = match cli.command {
        Cmd::Sync { repo } => run_sync(&repo, cli.dir.as_deref()),
        Cmd::Status { repo, json } => run_status(&repo, cli.dir.as_deref(), json),
        Cmd::Callers {
            symbol,
            repo,
            direction,
            depth,
            in_prefix,
            json,
        } => run_callers(
            &symbol,
            &repo,
            cli.dir.as_deref(),
            direction.as_deref(),
            depth.as_deref(),
            in_prefix.as_deref(),
            json,
        ),
        Cmd::Blast {
            repo,
            changed,
            depth,
            format,
        } => run_blast(
            &repo,
            cli.dir.as_deref(),
            &changed,
            depth.as_deref(),
            &format,
        ),
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
        } => run_ask_dense(
            &query,
            &repo,
            cli.dir.as_deref(),
            &model,
            limit,
            in_prefix.as_deref(),
            json,
        ),
    };
    match res {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("✗ {msg}");
            ExitCode::FAILURE
        }
    }
}
