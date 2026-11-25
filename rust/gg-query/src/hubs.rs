//! God-node / hub summary for cold-start repository orientation.
//!
//! Ranks connected symbols by global uniform-seed PageRank (reusing
//! `graphrank::PageRankTopology`) alongside directed walk-edge degrees and
//! `EXTRACTED` vs `INFERRED` edge counts in compact, bounded output.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::io;

use serde::Serialize;

use crate::graph::{
    NodeV1, Savings, group_digits, is_walk_relation, js_locale_cmp, normalize_path_prefix,
    path_under_prefix, with_savings,
};
use crate::graphrank::{DEFAULT_ALPHA, DEFAULT_ITERS, PageRankTopology};
use crate::provenance::{Confidence, EdgeProvenance};
use crate::query::{NODE_SELECT, row_to_node};
use crate::store::{GraphStore, sql_err};

pub const DEFAULT_HUB_LIMIT: usize = 15;
pub const MAX_HUB_LIMIT: usize = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubEntry {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub path: String,
    pub span: String,
    #[serde(serialize_with = "crate::graph::serialize_js_f64")]
    pub pagerank: f64,
    pub in_degree: usize,
    pub out_degree: usize,
    pub total_degree: usize,
    pub extracted_edges: usize,
    pub inferred_edges: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubsTotals {
    pub total_symbols: usize,
    pub connected_symbols: usize,
    pub walk_edges: usize,
    pub shown: usize,
    pub truncated: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubsReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    pub totals: HubsTotals,
    pub hubs: Vec<HubEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved: Option<Savings>,
}

struct WalkEdgeRow {
    source: String,
    target: String,
    confidence: Confidence,
}

#[derive(Default, Clone, Copy)]
struct DegreeCounts {
    in_deg: usize,
    out_deg: usize,
    extracted: usize,
    inferred: usize,
}

pub fn parse_hub_limit(raw: Option<usize>) -> Result<usize, String> {
    let limit = raw.unwrap_or(DEFAULT_HUB_LIMIT);
    if limit == 0 || limit > MAX_HUB_LIMIT {
        return Err(format!(
            "--limit must be an integer between 1 and {MAX_HUB_LIMIT}, got {limit}"
        ));
    }
    Ok(limit)
}

fn load_symbol_nodes(store: &GraphStore) -> io::Result<(Vec<NodeV1>, HashMap<String, usize>)> {
    let sql = format!("{NODE_SELECT} ORDER BY seq ASC");
    let mut stmt = store.conn.prepare(&sql).map_err(sql_err)?;
    let rows = stmt.query_map([], row_to_node).map_err(sql_err)?;
    let mut symbols = Vec::new();
    let mut file_chars: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let node = row.map_err(sql_err)?;
        if node.kind == "file" {
            if let Some(c) = node.chars {
                file_chars.insert(node.path, c as usize);
            }
            continue;
        }
        if node.kind == "resource" {
            continue;
        }
        symbols.push(node);
    }
    Ok((symbols, file_chars))
}

fn load_walk_edges(store: &GraphStore) -> io::Result<Vec<WalkEdgeRow>> {
    let mut stmt = store
        .conn
        .prepare("SELECT source, target, relation, confidence FROM edges ORDER BY seq ASC")
        .map_err(sql_err)?;
    let rows = stmt
        .query_map([], |r| {
            let source: String = r.get(0)?;
            let target: String = r.get(1)?;
            let relation: String = r.get(2)?;
            let confidence: String = r.get(3)?;
            Ok((source, target, relation, confidence))
        })
        .map_err(sql_err)?;
    let mut out = Vec::new();
    for row in rows {
        let (source, target, relation, confidence) = row.map_err(sql_err)?;
        if is_walk_relation(&relation) {
            out.push(WalkEdgeRow {
                source,
                target,
                confidence: Confidence::parse(&confidence),
            });
        }
    }
    Ok(out)
}

fn round6(v: f64) -> f64 {
    (v * 1_000_000.0).round() / 1_000_000.0
}

fn compare_hubs(a: &HubEntry, b: &HubEntry) -> Ordering {
    b.pagerank
        .partial_cmp(&a.pagerank)
        .unwrap_or(Ordering::Equal)
        .then_with(|| b.in_degree.cmp(&a.in_degree))
        .then_with(|| b.total_degree.cmp(&a.total_degree))
        .then_with(|| js_locale_cmp(&a.name, &b.name))
        .then_with(|| a.path.cmp(&b.path))
        .then_with(|| a.id.cmp(&b.id))
}

/// Compute top architectural hub symbols from the SQLite graph store.
pub fn compute_hubs(
    store: &GraphStore,
    limit: usize,
    in_prefix: Option<&str>,
) -> io::Result<HubsReport> {
    store.with_read_snapshot(|s| compute_hubs_inner(s, limit, in_prefix))
}

fn compute_degrees_and_pagerank(
    all_symbols: &[NodeV1],
    walk_edges: &[WalkEdgeRow],
) -> (Vec<DegreeCounts>, HashMap<usize, f64>, usize) {
    let id_to_idx: HashMap<&str, usize> = all_symbols
        .iter()
        .enumerate()
        .map(|(idx, sym)| (sym.id.as_str(), idx))
        .collect();
    let mut counts = vec![DegreeCounts::default(); all_symbols.len()];
    let mut pr_edges: Vec<(usize, usize)> = Vec::new();
    let mut walk_edge_count = 0_usize;

    for edge in walk_edges {
        let src_idx = id_to_idx.get(edge.source.as_str()).copied();
        let dst_idx = id_to_idx.get(edge.target.as_str()).copied();
        let is_inferred = edge.confidence.provenance() == EdgeProvenance::Inferred;
        if let Some(si) = src_idx {
            counts[si].out_deg += 1;
            if is_inferred {
                counts[si].inferred += 1;
            } else {
                counts[si].extracted += 1;
            }
        }
        if let Some(di) = dst_idx {
            counts[di].in_deg += 1;
            if is_inferred {
                counts[di].inferred += 1;
            } else {
                counts[di].extracted += 1;
            }
        }
        if let (Some(si), Some(di)) = (src_idx, dst_idx)
            && si != di
        {
            pr_edges.push((si, di));
            walk_edge_count += 1;
        }
    }

    let topo = PageRankTopology::build(all_symbols.len(), vec![true; all_symbols.len()], &pr_edges);
    let seeds: Vec<(usize, f64)> = counts
        .iter()
        .enumerate()
        .filter(|(_, c)| c.in_deg + c.out_deg > 0)
        .map(|(i, _)| (i, 1.0))
        .collect();
    let pr_scores = topo.run(&seeds, DEFAULT_ALPHA, DEFAULT_ITERS);
    (counts, pr_scores, walk_edge_count)
}

fn compute_hubs_inner(
    store: &GraphStore,
    limit: usize,
    in_prefix: Option<&str>,
) -> io::Result<HubsReport> {
    let prefix = match in_prefix {
        Some(raw) => {
            let p = normalize_path_prefix(raw);
            if !p.is_empty() && !store.has_indexed_prefix(&p)? {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("nothing indexed under \"{p}\""),
                ));
            }
            Some(p)
        }
        None => None,
    };

    let (all_symbols, file_chars) = load_symbol_nodes(store)?;
    let walk_edges = load_walk_edges(store)?;
    let (counts, pr_scores, walk_edge_count) =
        compute_degrees_and_pagerank(&all_symbols, &walk_edges);

    let mut entries: Vec<HubEntry> = Vec::new();
    let mut total_symbols = 0_usize;
    let mut seen_paths: HashSet<&str> = HashSet::new();

    for (idx, sym) in all_symbols.iter().enumerate() {
        if let Some(ref p) = prefix
            && !path_under_prefix(&sym.path, p)
        {
            continue;
        }
        total_symbols += 1;
        seen_paths.insert(sym.path.as_str());
        let c = counts[idx];
        let total_degree = c.in_deg + c.out_deg;
        if total_degree == 0 {
            continue;
        }
        entries.push(HubEntry {
            id: sym.id.clone(),
            name: sym.name.clone(),
            kind: sym.kind.clone(),
            path: sym.path.clone(),
            span: sym.span.clone(),
            pagerank: round6(pr_scores.get(&idx).copied().unwrap_or(0.0)),
            in_degree: c.in_deg,
            out_degree: c.out_deg,
            total_degree,
            extracted_edges: c.extracted,
            inferred_edges: c.inferred,
        });
    }

    entries.sort_by(compare_hubs);
    let connected_symbols = entries.len();
    let shown = connected_symbols.min(limit);
    let truncated = connected_symbols.saturating_sub(shown);
    entries.truncate(shown);

    let baseline_chars: usize = seen_paths
        .iter()
        .filter_map(|p| file_chars.get(*p))
        .copied()
        .sum();
    let saved = (baseline_chars > 0).then_some(Savings {
        files: seen_paths.len(),
        baseline_chars,
    });

    Ok(HubsReport {
        prefix,
        totals: HubsTotals {
            total_symbols,
            connected_symbols,
            walk_edges: walk_edge_count,
            shown,
            truncated,
        },
        hubs: entries,
        saved,
    })
}

pub fn format_hubs_text(report: &HubsReport) -> String {
    let scope = match &report.prefix {
        Some(p) => format!(" under {p}/"),
        None => String::new(),
    };
    let mut lines = vec![format!(
        "hubs{scope} · {} of {} connected symbols ({} total symbols, {} walk edges)",
        group_digits(report.totals.shown),
        group_digits(report.totals.connected_symbols),
        group_digits(report.totals.total_symbols),
        group_digits(report.totals.walk_edges),
    )];
    if report.hubs.is_empty() {
        lines.push("  no connected symbols in graph".to_string());
    } else {
        for (i, hub) in report.hubs.iter().enumerate() {
            lines.push(format!(
                "  {}. {} ({}) · {}:{} · pr {:.2} · deg {} (in {}, out {} · {} EXTRACTED, {} INFERRED)",
                i + 1,
                hub.name,
                hub.kind,
                hub.path,
                hub.span,
                hub.pagerank,
                hub.total_degree,
                hub.in_degree,
                hub.out_degree,
                hub.extracted_edges,
                hub.inferred_edges,
            ));
        }
        if report.totals.truncated > 0 {
            lines.push(format!(
                "  … and {} more connected symbol(s) (pass --limit <n> to show more)",
                group_digits(report.totals.truncated)
            ));
        }
    }
    let body = format!("{}\n", lines.join("\n"));
    with_savings(&body, report.saved.as_ref())
}

pub fn format_hubs_json(report: &HubsReport) -> Result<String, String> {
    serde_json::to_string_pretty(report).map_err(|e| e.to_string())
}
