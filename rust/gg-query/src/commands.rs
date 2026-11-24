//! CLI subcommand runners for `gg-query`.

use std::collections::HashMap;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Command;

use gg_query::ask::{AskOptions, format_ask, format_skeleton, run_ask, run_skeleton};
use gg_query::crate_source::{
    CrateSourceArgs, ResolutionStatus, format_crate_source_json, format_crate_source_text,
    resolve_crate_source,
};
use gg_query::embed::SafetensorsEmbedder;
use gg_query::format::{SymbolResult, format_blast_json, format_callers_json, format_callers_text};
use gg_query::graph::{
    Direction, EdgeHit, NodeV1, UnresolvedCall, group_digits, normalize_path_prefix, parse_depth,
    path_under_prefix,
};
use gg_query::hubs::{compute_hubs, format_hubs_json, format_hubs_text, parse_hub_limit};
use gg_query::provenance::{format_callers_provenance_json, format_callers_provenance_text};
use gg_query::store::GraphStore;
use gg_query::vectors::{dense_files, read_vectors};

pub struct CallersCmdArgs<'a> {
    pub symbol: &'a str,
    pub repo: &'a Path,
    pub override_dir: Option<&'a Path>,
    pub direction: Option<&'a str>,
    pub depth: Option<&'a str>,
    pub in_prefix: Option<&'a str>,
    pub json: bool,
    pub provenance: bool,
}

pub struct AskCmdArgs<'a> {
    pub query: &'a str,
    pub repo: &'a Path,
    pub override_dir: Option<&'a Path>,
    pub limit: usize,
    pub source: bool,
    pub full: bool,
    pub in_prefix: Option<&'a str>,
    pub json: bool,
    pub no_graph_rank: bool,
    pub model: Option<&'a Path>,
    pub no_semantic: bool,
}

pub struct AskDenseCmdArgs<'a> {
    pub query: &'a str,
    pub repo: &'a Path,
    pub override_dir: Option<&'a Path>,
    pub model: &'a Path,
    pub limit: usize,
    pub in_prefix: Option<&'a str>,
    pub json: bool,
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

pub fn run_sync(repo: &Path, override_dir: Option<&Path>) -> Result<(), String> {
    let ctx = context_dir_for(repo, override_dir);
    let (nodes, edges) = GraphStore::force_sync(&ctx).map_err(|e| e.to_string())?;
    println!(
        "synced {nodes} nodes, {edges} edges → {}",
        ctx.join(".graph/wiring.sqlite").display()
    );
    Ok(())
}

pub fn run_status(repo: &Path, override_dir: Option<&Path>, json: bool) -> Result<(), String> {
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

pub fn run_callers(args: &CallersCmdArgs<'_>) -> Result<(), String> {
    let ctx = context_dir_for(args.repo, args.override_dir);
    let Some(store) = GraphStore::open_or_sync(&ctx).map_err(|e| e.to_string())? else {
        return Err(format!(
            "no graph found at {} — run `trail build` first",
            ctx.display()
        ));
    };
    let dir = Direction::parse(args.direction)?;
    let max_depth = parse_depth(args.depth, 1)?;
    let (results, unresolved_by_name, saved) = store
        .with_read_snapshot(|s| {
            let matches = s.resolve_symbol(args.symbol, args.in_prefix)?;
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
            "no symbol \"{}\" in the graph — check spelling or run trail build",
            args.symbol
        ));
    }
    if args.provenance {
        if args.json {
            println!(
                "{}",
                format_callers_provenance_json(
                    args.symbol,
                    dir,
                    &results,
                    &unresolved_by_name,
                    saved.as_ref()
                )
            );
        } else {
            print!(
                "{}",
                format_callers_provenance_text(
                    args.repo,
                    dir,
                    max_depth > 1,
                    &results,
                    &unresolved_by_name,
                    saved.as_ref()
                )
            );
        }
    } else if args.json {
        println!(
            "{}",
            format_callers_json(
                args.symbol,
                dir,
                &results,
                &unresolved_by_name,
                saved.as_ref()
            )
        );
    } else {
        print!(
            "{}",
            format_callers_text(
                args.repo,
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

pub fn run_blast(
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

pub fn run_ask_cmd(args: &AskCmdArgs<'_>) -> Result<(), String> {
    let query = if args.query == "-" {
        let mut buf = String::new();
        io::stdin()
            .read_to_string(&mut buf)
            .map_err(|e| format!("failed to read query from stdin: {e}"))?;
        buf.trim().to_string()
    } else {
        args.query.to_string()
    };
    let ctx = context_dir_for(args.repo, args.override_dir);
    let opts = AskOptions {
        limit: args.limit,
        source: args.source,
        full: args.full,
        graph_rank: !args.no_graph_rank,
        in_prefix: args.in_prefix,
        model_dir: args.model,
        semantic: !args.no_semantic,
    };
    let result = run_ask(args.repo, &ctx, &query, &opts)?;
    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?
        );
    } else {
        print!("{}", format_ask(&result));
    }
    Ok(())
}

pub fn run_skeleton_cmd(
    file: &str,
    repo: &Path,
    override_dir: Option<&Path>,
    json: bool,
) -> Result<(), String> {
    let ctx = context_dir_for(repo, override_dir);
    let store = GraphStore::open_or_sync(&ctx).map_err(|e| e.to_string())?;
    let result = run_skeleton(store.as_ref(), file).map_err(|e| e.to_string())?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?
        );
    } else {
        print!("{}", format_skeleton(&result));
    }
    Ok(())
}

pub fn run_embed(text: &str, model: &Path, whole: bool, json: bool) -> Result<(), String> {
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

pub fn run_ask_dense(args: &AskDenseCmdArgs<'_>) -> Result<(), String> {
    let ctx = context_dir_for(args.repo, args.override_dir);
    let Some(index) = read_vectors(&ctx).map_err(|e| e.to_string())? else {
        return Err(format!(
            "no valid ask-vectors.bin found under {}",
            ctx.display()
        ));
    };
    let mut emb = SafetensorsEmbedder::open(args.model, false).map_err(|e| e.to_string())?;
    if index.dim != emb.dim() {
        return Err(format!(
            "ask-vectors.bin dimension ({}) does not match model dimension ({})",
            index.dim,
            emb.dim()
        ));
    }
    let qvec = emb.embed(args.query).map_err(|e| e.to_string())?;
    let prefix = args.in_prefix.map(normalize_path_prefix);
    let mut hits = dense_files(&index, &qvec, |path| match &prefix {
        Some(p) => path_under_prefix(path, p),
        None => true,
    });
    hits.truncate(args.limit);
    if args.json {
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

pub fn run_hubs(
    repo: &Path,
    override_dir: Option<&Path>,
    limit: Option<usize>,
    in_prefix: Option<&str>,
    json: bool,
) -> Result<(), String> {
    let parsed_limit = parse_hub_limit(limit)?;
    let ctx = context_dir_for(repo, override_dir);
    let Some(store) = GraphStore::open_or_sync(&ctx).map_err(|e| e.to_string())? else {
        return Err(format!(
            "no graph found at {} — run `trail build` first",
            ctx.display()
        ));
    };
    let report = compute_hubs(&store, parsed_limit, in_prefix).map_err(|e| e.to_string())?;
    if json {
        println!("{}", format_hubs_json(&report)?);
    } else {
        print!("{}", format_hubs_text(&report));
    }
    Ok(())
}

pub fn run_crate_source(args: &CrateSourceArgs<'_>, json: bool) -> Result<(), String> {
    let report = resolve_crate_source(args)?;
    if json {
        println!("{}", format_crate_source_json(&report)?);
    } else {
        print!("{}", format_crate_source_text(&report));
    }
    if report
        .matches
        .iter()
        .all(|m| m.status != ResolutionStatus::Found)
    {
        return Err(format!(
            "crate \"{}\" is locked in Cargo.lock but not cached locally under {}",
            report.query, report.cargo_home
        ));
    }
    Ok(())
}
