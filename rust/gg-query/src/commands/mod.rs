//! CLI subcommand runners for `gg-query`.

mod query_cmds;

use std::io::{self, Read};
use std::path::{Path, PathBuf};

use gg_query::ask::{
    AskOptions, format_ask, format_skeleton, parse_max_tokens, run_ask, run_ask_with_budget,
    run_skeleton,
};
use gg_query::brand::cmd;
use gg_query::crate_source::{
    CrateSourceArgs, ResolutionStatus, format_crate_source_json, format_crate_source_text,
    resolve_crate_source,
};
use gg_query::embed::SafetensorsEmbedder;
use gg_query::freshness::{
    IndexState, check_status_in_sync, emit_stale_notice, format_query_json, probe_query_index,
};
use gg_query::graph::{group_digits, normalize_path_prefix, path_under_prefix};
use gg_query::hubs::{compute_hubs, format_hubs_json, format_hubs_text, parse_hub_limit};
use gg_query::store::GraphStore;
use gg_query::vectors::{dense_files, read_vectors};

pub use query_cmds::{BlastCmdArgs, CallersCmdArgs, run_blast, run_callers};

pub struct AskCmdArgs<'a> {
    pub query: &'a str,
    pub repo: &'a Path,
    pub override_dir: Option<&'a Path>,
    pub limit: usize,
    pub source: bool,
    pub full: bool,
    pub token_cap: Option<&'a str>,
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

pub(super) fn context_dir_for(repo: &Path, override_dir: Option<&Path>) -> PathBuf {
    if let Some(d) = override_dir {
        return d.to_path_buf();
    }
    let trail_cache = repo.join(".trail").join("cache");
    if trail_cache.join(".graph").join("wiring.json").is_file() {
        return trail_cache;
    }
    repo.join("graft")
}

pub(super) fn with_optional_index(
    json_str: String,
    index: Option<&IndexState>,
) -> Result<String, String> {
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
    let token_limit = match args.token_cap {
        Some(raw) => Some(parse_max_tokens(raw).map_err(|msg| format!("--{msg}"))?),
        None => None,
    };

    let ctx = context_dir_for(args.repo, args.override_dir);
    let index = probe_query_index(args.repo, &ctx, args.no_refresh);
    emit_stale_notice(index.as_ref());

    let opts = AskOptions {
        limit: args.limit,
        source: args.source || token_limit.is_some(),
        full: args.full || token_limit.is_some(),
        graph_rank: !args.no_graph_rank,
        in_prefix: args.in_prefix,
        model_dir: args.model,
        semantic: !args.no_semantic,
    };

    if let Some(limit_tok) = token_limit {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_optional_index_leaves_non_object_json_unchanged() {
        let idx = IndexState {
            state: "fresh",
            changed: None,
            reason: None,
        };
        let out = with_optional_index("[1]".to_string(), Some(&idx)).unwrap();
        assert_eq!(out, "[\n  1\n]");
    }
}
