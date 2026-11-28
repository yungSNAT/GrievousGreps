//! Edge provenance (`EXTRACTED` vs `INFERRED`) and weakest-hop confidence rating.
//!
//! Mirrors `src/graph/provenance.ts`: distinguishes AST/compiler-verified links
//! from heuristic/inferred links and rates multi-hop paths by their weakest hop.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::format::{SymbolResult, header_of, unresolved_note_for};
use crate::graph::{
    Direction, EdgeHit, NodeV1, Savings, UnresolvedCall, is_test_path, reference_line, with_savings,
};

/// Canonical edge confidence tier ordered strongest to weakest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    LspResolved,
    LspDispatch,
    Extracted,
    /// A stated type, path, crate or base class picked the target: a lead, but a strong one.
    Likely,
    Inferred,
}

impl Confidence {
    /// Parse a stored confidence string, failing closed to `Inferred` on unknown input.
    pub fn parse(raw: &str) -> Self {
        match raw {
            "lsp_resolved" => Self::LspResolved,
            "lsp_dispatch" => Self::LspDispatch,
            "extracted" => Self::Extracted,
            "likely" => Self::Likely,
            _ => Self::Inferred,
        }
    }

    /// Numeric strength rank: higher is stronger.
    pub fn rank(self) -> u8 {
        match self {
            Self::LspResolved => 4,
            Self::LspDispatch => 3,
            Self::Extracted => 2,
            Self::Likely => 1,
            Self::Inferred => 0,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::LspResolved => "lsp_resolved",
            Self::LspDispatch => "lsp_dispatch",
            Self::Extracted => "extracted",
            Self::Likely => "likely",
            Self::Inferred => "inferred",
        }
    }

    /// Two-bucket provenance label distinguishing verified links from inferred ones.
    pub fn provenance(self) -> EdgeProvenance {
        match self {
            Self::LspResolved | Self::LspDispatch | Self::Extracted => EdgeProvenance::Extracted,
            Self::Likely | Self::Inferred => EdgeProvenance::Inferred,
        }
    }

    /// The text mark for a hit of this confidence: nothing for a definite one.
    pub fn mark(self) -> &'static str {
        match self {
            Self::Likely => crate::graph::LIKELY_MARK,
            Self::Inferred => crate::graph::INFERRED_MARK,
            _ => "",
        }
    }

    /// Return the weaker of two confidence ratings.
    pub fn weakest(self, other: Self) -> Self {
        if self.rank() <= other.rank() {
            self
        } else {
            other
        }
    }
}

/// High-level provenance classification for an edge or multi-hop path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EdgeProvenance {
    Extracted,
    Inferred,
}

impl EdgeProvenance {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Extracted => "EXTRACTED",
            Self::Inferred => "INFERRED",
        }
    }
}

/// The hop that set the weakest-confidence ceiling on a path trace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WeakestHop {
    pub from: String,
    pub to: String,
    pub relation: String,
    pub confidence: Confidence,
    pub provenance: EdgeProvenance,
    pub depth: usize,
}

/// Aggregate provenance counts and weakest rating for a symbol's hits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceSummary {
    pub extracted: usize,
    pub inferred: usize,
    pub weakest_confidence: Option<Confidence>,
    pub weakest_provenance: Option<EdgeProvenance>,
}

pub fn summarise_provenance(hits: &[EdgeHit]) -> ProvenanceSummary {
    let mut extracted = 0_usize;
    let mut inferred = 0_usize;
    let mut weakest: Option<Confidence> = None;
    for h in hits {
        let conf = h.confidence;
        match conf.provenance() {
            EdgeProvenance::Extracted => extracted += 1,
            EdgeProvenance::Inferred => inferred += 1,
        }
        weakest = Some(match weakest {
            Some(prev) => prev.weakest(conf),
            None => conf,
        });
    }
    ProvenanceSummary {
        extracted,
        inferred,
        weakest_confidence: weakest,
        weakest_provenance: weakest.map(Confidence::provenance),
    }
}

fn provenance_tag(hit: &EdgeHit) -> String {
    let prov = hit.confidence.provenance().as_str();
    if hit.depth > 1 {
        if let Some(hop) = &hit.weakest_hop {
            return format!(
                " [{prov} · weakest: {} @ hop {}]",
                hop.confidence.as_str(),
                hop.depth
            );
        }
        return format!(" [{prov} · weakest: {}]", hit.confidence.as_str());
    }
    if matches!(
        hit.confidence,
        Confidence::LspResolved | Confidence::LspDispatch | Confidence::Likely
    ) {
        format!(" [{prov} · {}]", hit.confidence.as_str())
    } else {
        format!(" [{prov}]")
    }
}

fn format_hit_with_provenance(
    direction: Direction,
    hit: &EdgeHit,
    show_depth: bool,
    symbol_name: &str,
    root: &Path,
    cache: &mut HashMap<String, Option<Vec<String>>>,
) -> String {
    let arrow = direction.arrow();
    let depth_tag = if show_depth {
        format!(" [depth {}]", hit.depth)
    } else {
        String::new()
    };
    let tag = provenance_tag(hit);
    let Some(node) = &hit.node else {
        return format!(
            "  {} {arrow} {} (unresolved import){depth_tag}{tag}",
            hit.relation, hit.id
        );
    };
    let quote = if hit.depth == 1 && !is_test_path(&node.path) {
        reference_line(root, &node.path, &node.span, symbol_name, cache)
    } else {
        None
    };
    match quote {
        Some(q) => format!(
            "  {} {arrow} {} ({}:L{}){depth_tag}{tag}: {}",
            hit.relation,
            node.name,
            node.path,
            q.n,
            q.text.trim()
        ),
        None => format!(
            "  {} {arrow} {} ({}:{}){depth_tag}{tag}",
            hit.relation, node.name, node.path, node.span
        ),
    }
}

/// Render callers/callees text report with explicit `EXTRACTED`/`INFERRED` provenance
/// and weakest-hop confidence ratings on every hit.
pub fn format_callers_provenance_text(
    root: &Path,
    direction: Direction,
    show_depth: bool,
    results: &[SymbolResult],
    unresolved_by_name: &HashMap<String, Vec<UnresolvedCall>>,
    saved: Option<&Savings>,
) -> String {
    let mut cache: HashMap<String, Option<Vec<String>>> = HashMap::new();
    let mut blocks: Vec<String> = Vec::with_capacity(results.len());
    for r in results {
        let mut lines = vec![header_of(&r.symbol)];
        let summary = summarise_provenance(&r.hits);
        if let (Some(wp), Some(wc)) = (summary.weakest_provenance, summary.weakest_confidence) {
            let (ex, inf) = (summary.extracted, summary.inferred);
            lines.push(format!(
                "  provenance: {ex} EXTRACTED, {inf} INFERRED · weakest: {} ({})",
                wp.as_str(),
                wc.as_str()
            ));
            for h in &r.hits {
                lines.push(format_hit_with_provenance(
                    direction,
                    h,
                    show_depth,
                    &r.symbol.name,
                    root,
                    &mut cache,
                ));
            }
        } else {
            let label = if direction == Direction::Out {
                "callees"
            } else {
                "callers"
            };
            lines.push(format!("  no indexed {label} for {}", r.symbol.name));
        }
        if let Some(calls) = unresolved_by_name.get(&r.symbol.name)
            && let Some(note) = unresolved_note_for(calls, direction, &r.symbol.name)
        {
            lines.push(note);
        }
        blocks.push(lines.join("\n"));
    }
    let body = format!("{}\n", blocks.join("\n\n"));
    with_savings(&body, saved)
}

#[derive(Serialize)]
struct ProvenanceSymbolJson<'a> {
    id: &'a str,
    name: &'a str,
    kind: &'a str,
    path: &'a str,
    span: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProvenanceHitJson<'a> {
    id: &'a str,
    relation: &'a str,
    depth: usize,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    inferred: bool,
    provenance: EdgeProvenance,
    weakest_confidence: Confidence,
    #[serde(skip_serializing_if = "Option::is_none")]
    weakest_hop: Option<&'a WeakestHop>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    span: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProvenanceMatchJson<'a> {
    symbol: ProvenanceSymbolJson<'a>,
    provenance_summary: ProvenanceSummary,
    hits: Vec<ProvenanceHitJson<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unresolved_calls: Option<&'a [UnresolvedCall]>,
}

#[derive(Serialize)]
struct ProvenancePayloadJson<'a> {
    query: &'a str,
    matches: Vec<ProvenanceMatchJson<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    saved: Option<&'a Savings>,
}

fn node_to_sym(n: &NodeV1) -> ProvenanceSymbolJson<'_> {
    ProvenanceSymbolJson {
        id: &n.id,
        name: &n.name,
        kind: &n.kind,
        path: &n.path,
        span: &n.span,
    }
}

/// Render callers/callees JSON report with provenance and weakest-hop metadata.
pub fn format_callers_provenance_json(
    query: &str,
    direction: Direction,
    results: &[SymbolResult],
    unresolved_by_name: &HashMap<String, Vec<UnresolvedCall>>,
    saved: Option<&Savings>,
) -> String {
    let matches: Vec<ProvenanceMatchJson<'_>> = results
        .iter()
        .map(|r| {
            let provenance_summary = summarise_provenance(&r.hits);
            let hits = r
                .hits
                .iter()
                .map(|h| ProvenanceHitJson {
                    id: &h.id,
                    relation: &h.relation,
                    depth: h.depth,
                    inferred: h.inferred,
                    provenance: h.confidence.provenance(),
                    weakest_confidence: h.confidence,
                    weakest_hop: h.weakest_hop.as_ref(),
                    name: h.node.as_ref().map(|n| n.name.as_str()),
                    kind: h.node.as_ref().map(|n| n.kind.as_str()),
                    path: h.node.as_ref().map(|n| n.path.as_str()),
                    span: h.node.as_ref().map(|n| n.span.as_str()),
                })
                .collect();
            let unresolved_calls = if direction == Direction::In {
                unresolved_by_name
                    .get(&r.symbol.name)
                    .filter(|v| !v.is_empty())
                    .map(Vec::as_slice)
            } else {
                None
            };
            ProvenanceMatchJson {
                symbol: node_to_sym(&r.symbol),
                provenance_summary,
                hits,
                unresolved_calls,
            }
        })
        .collect();
    let payload = ProvenancePayloadJson {
        query,
        matches,
        saved,
    };
    serde_json::to_string_pretty(&payload).unwrap_or_default()
}
