//! CLI subcommand runners for `gg-query`.

use std::collections::HashMap;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use gg_query::ask::{
    AskOptions, format_ask, format_skeleton, parse_max_tokens, run_ask, run_ask_with_budget,
    run_skeleton,
};
use gg_query::blast::diff::{ChangeStatus, ChangedFile, changed_files, ref_exists};
use gg_query::blast::owners::{attach_owners, diff_authors, local_identity, now_ms};
use gg_query::blast::render::{markdown_report, mermaid_diagram, text_report};
use gg_query::blast::{BlastOptions, compute_blast_report};
use gg_query::brand::cmd;
use gg_query::crate_source::{
    CrateSourceArgs, ResolutionStatus, format_crate_source_json, format_crate_source_text,
    resolve_crate_source,
};
use gg_query::embed::SafetensorsEmbedder;
use gg_query::format::{SymbolResult, format_callers_json, format_callers_text};
use gg_query::freshness::{
    IndexState, check_status_in_sync, emit_stale_notice, format_query_json, probe_query_index,
};
use gg_query::graph::{
    Direction, UnresolvedCall, group_digits, normalize_path_prefix, parse_depth, path_under_prefix,
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
    pub no_refresh: bool,
}

pub struct BlastCmdArgs<'a> {
    pub repo: &'a Path,
    pub override_dir: Option<&'a Path>,
    pub base: Option<&'a str>,
    pub changed_arg: &'a [String],
    pub depth: Option<&'a str>,
    pub format: &'a str,
    pub no_owners: bool,
    pub pr_author: &'a [String],
    pub tests: bool,
    pub no_refresh: bool,
}

pub struct AskCmdArgs<'a> {
    pub query: &'a str,
    pub repo: &'a Path,
    pub override_dir: Option<&'a Path>,
    pub limit: usize,
    pub source: bool,
    pub full: bool,
    pub max_tokens: Option<&'a str>,
    pub in_prefix: Option<&'a str>,
    pub json: bool,
    pub no_graph_rank: bool,
    pub model: Option<&'a Path>,
    pub no_semantic: bool,
    pub no_refresh: bool,
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

fn with_optional_index(json_str: String, index: Option<&IndexState>) -> Result<String, String> {
    let Some(idx) = index else {
        return Ok(json_str);
    };
    let mut val: serde_json::Value = serde_json::from_str(&json_str).map_err(|e| e.to_string())?;
    if let Some(obj) = val.as_object_mut() {
        obj.insert(
            "index".to_string(),
            serde_json::to_value(idx).map_err(|e| e.to_string())?,
        );
    }
    serde_json::to_string_pretty(&val).map_err(|e| e.to_string())
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

pub fn run_status(
    repo: &Path,
    override_dir: Option<&Path>,
    json: bool,
    no_refresh: bool,
) -> Result<(), String> {
    let ctx = context_dir_for(repo, override_dir);
    let store = GraphStore::open_or_sync(&ctx).map_err(|e| e.to_string())?;
    let nodes = match store {
        Some(ref s) => Some(s.node_count().map_err(|e| e.to_string())?),
        None => None,
    };
    let in_sync = nodes
        .is_some()
        .then(|| check_status_in_sync(repo, &ctx, no_refresh));
    if json {
        let code_map = match (nodes, in_sync) {
            (Some(n), Some(sync)) => serde_json::json!({ "nodes": n, "inSync": sync }),
            _ => serde_json::Value::Null,
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
    match (nodes, in_sync) {
        (None, _) => println!(
            "{:<11} ✗ not built · run {}",
            "code map",
            cmd("graft build")
        ),
        (Some(n), Some(false)) => println!(
            "{:<11} ⚠ {} nodes · behind the code, refreshed on the next query",
            "code map",
            group_digits(n)
        ),
        (Some(n), _) => println!(
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
    let index = probe_query_index(args.repo, &ctx, args.no_refresh);
    emit_stale_notice(index.as_ref());

    let Some(store) = GraphStore::open_or_sync(&ctx).map_err(|e| e.to_string())? else {
        return Err(format!(
            "no graph found at {} — run `{}` first",
            ctx.display(),
            cmd("graft build")
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
                let hits = s.edge_walk_with_provenance(&m, dir, max_depth, args.provenance)?;
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
            "no symbol \"{}\" in the graph — check spelling or run {}",
            args.symbol,
            cmd("graft build")
        ));
    }
    if args.provenance {
        if args.json {
            let body = format_callers_provenance_json(
                args.symbol,
                dir,
                &results,
                &unresolved_by_name,
                saved.as_ref(),
            );
            println!("{}", with_optional_index(body, index.as_ref())?);
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
        let body = format_callers_json(
            args.symbol,
            dir,
            &results,
            &unresolved_by_name,
            saved.as_ref(),
        );
        println!("{}", with_optional_index(body, index.as_ref())?);
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

pub fn run_blast(args: &BlastCmdArgs<'_>) -> Result<(), String> {
    if !matches!(args.format, "text" | "markdown" | "mermaid" | "json") {
        return Err(format!(
            "--format must be text, markdown, mermaid or json, got \"{}\"",
            args.format
        ));
    }
    let max_depth = parse_depth(args.depth, 2)?;
    let ctx = context_dir_for(args.repo, args.override_dir);
    let index = probe_query_index(args.repo, &ctx, args.no_refresh);
    emit_stale_notice(index.as_ref());

    let Some(store) = GraphStore::open_or_sync(&ctx).map_err(|e| e.to_string())? else {
        return Err(format!(
            "no graph found at {} — run `{}` first",
            ctx.display(),
            cmd("graft build")
        ));
    };

    let (diff_files, basis, seed_all) = if args.changed_arg.is_empty() {
        if let Some(b) = args.base
            && !ref_exists(args.repo, b)
        {
            return Err(format!(
                "base ref \"{b}\" is not in this checkout.\n  \
                 In CI, fetch enough history for the merge base: actions/checkout with `fetch-depth: 0`."
            ));
        }
        let Some(diff) = changed_files(args.repo, args.base) else {
            return Err(format!(
                "could not read a diff in {} — is this a git repository?",
                args.repo.display()
            ));
        };
        (diff.files, diff.basis, false)
    } else {
        let synthetic = args
            .changed_arg
            .iter()
            .map(|p| ChangedFile {
                path: normalize_path_prefix(p),
                status: ChangeStatus::Modified,
                old_path: None,
                ranges: Vec::new(),
                hunks: Vec::new(),
            })
            .collect();
        (synthetic, "working tree vs HEAD".to_string(), true)
    };

    let mut report = compute_blast_report(
        &store,
        args.repo,
        &ctx,
        diff_files,
        basis,
        &BlastOptions {
            depth: max_depth,
            tests: args.tests,
            seed_all_on_empty_ranges: seed_all,
        },
    )?;

    if !args.no_owners {
        let mut exclude = match args.base {
            None => local_identity(args.repo),
            Some(b) => diff_authors(args.repo, b),
        };
        exclude.extend(args.pr_author.iter().cloned());
        attach_owners(args.repo, &mut report, &exclude, now_ms());
    }

    match args.format {
        "json" => println!("{}", format_query_json(&report, index.as_ref())?),
        "mermaid" => println!(
            "{}",
            mermaid_diagram(&report).unwrap_or_else(|| "%% no dependents to draw".to_string())
        ),
        "markdown" => print!("{}", markdown_report(&report, Some(args.repo))),
        _ => print!("{}", text_report(&report)),
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
    let max_tokens = match args.max_tokens {
        Some(raw) => Some(parse_max_tokens(raw).map_err(|msg| format!("--{msg}"))?),
        None => None,
    };

    let ctx = context_dir_for(args.repo, args.override_dir);
    let index = probe_query_index(args.repo, &ctx, args.no_refresh);
    emit_stale_notice(index.as_ref());

    let opts = AskOptions {
        limit: args.limit,
        source: args.source || max_tokens.is_some(),
        full: args.full || max_tokens.is_some(),
        graph_rank: !args.no_graph_rank,
        in_prefix: args.in_prefix,
        model_dir: args.model,
        semantic: !args.no_semantic,
    };

    if let Some(limit_tok) = max_tokens {
        let (result, text) = run_ask_with_budget(args.repo, &ctx, &query, &opts, limit_tok)?;
        if args.json {
            println!("{}", format_query_json(&result, index.as_ref())?);
        } else {
            print!("{text}");
        }
        return Ok(());
    }

    let result = run_ask(args.repo, &ctx, &query, &opts)?;
    if args.json {
        println!("{}", format_query_json(&result, index.as_ref())?);
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
    no_refresh: bool,
) -> Result<(), String> {
    let ctx = context_dir_for(repo, override_dir);
    let index = probe_query_index(repo, &ctx, no_refresh);
    emit_stale_notice(index.as_ref());

    let store = GraphStore::open_or_sync(&ctx).map_err(|e| e.to_string())?;
    let result = run_skeleton(store.as_ref(), file).map_err(|e| e.to_string())?;
    if json {
        println!("{}", format_query_json(&result, index.as_ref())?);
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
    no_refresh: bool,
) -> Result<(), String> {
    let parsed_limit = parse_hub_limit(limit)?;
    let ctx = context_dir_for(repo, override_dir);
    let index = probe_query_index(repo, &ctx, no_refresh);
    emit_stale_notice(index.as_ref());

    let Some(store) = GraphStore::open_or_sync(&ctx).map_err(|e| e.to_string())? else {
        return Err(format!(
            "no graph found at {}: run `{}` first",
            ctx.display(),
            cmd("graft build")
        ));
    };
    let report = compute_hubs(&store, parsed_limit, in_prefix).map_err(|e| e.to_string())?;
    if json {
        let body = format_hubs_json(&report)?;
        println!("{}", with_optional_index(body, index.as_ref())?);
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
    let any_hard_err = report.matches.iter().any(|m| {
        matches!(
            m.status,
            ResolutionStatus::Ambiguous
                | ResolutionStatus::Unresolved
                | ResolutionStatus::BudgetExhausted
        )
    });
    if any_hard_err
        || report
            .matches
            .iter()
            .all(|m| m.status != ResolutionStatus::Found)
    {
        return Err(format!(
            "crate \"{}\" could not be verified locally under {}",
            report.query, report.cargo_home
        ));
    }
    Ok(())
}
