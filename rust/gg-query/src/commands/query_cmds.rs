//! `callers` and `blast` CLI subcommand runners.

use std::collections::HashMap;
use std::path::Path;

use gg_query::blast::diff::{ChangeStatus, ChangedFile, changed_files, ref_exists};
use gg_query::blast::owners::{attach_owners, diff_authors, local_identity, now_ms};
use gg_query::blast::render::{markdown_report, mermaid_diagram, text_report};
use gg_query::blast::{BlastOptions, compute_blast_report};
use gg_query::brand::cmd;
use gg_query::format::{SymbolResult, format_callers_json, format_callers_text};
use gg_query::freshness::{emit_stale_notice, format_query_json, probe_query_index};
use gg_query::graph::{Direction, UnresolvedCall, normalize_path_prefix, parse_depth};
use gg_query::provenance::{format_callers_provenance_json, format_callers_provenance_text};
use gg_query::store::GraphStore;

use super::{context_dir_for, with_optional_index};

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
