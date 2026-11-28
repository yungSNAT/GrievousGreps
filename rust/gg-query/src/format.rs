//! Text and JSON report formatters for `callers` matching `src/graph/traverse-cli.ts`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::Serialize;

use crate::brand::cmd;
use crate::graph::{
    Direction, EdgeHit, NodeV1, Quote, Savings, UnresolvedCall, call_reference_line, is_test_path,
    with_savings,
};

const QUIET_SHOWN: usize = 3;

pub struct SymbolResult {
    pub symbol: NodeV1,
    pub hits: Vec<EdgeHit>,
}

pub fn header_of(n: &NodeV1) -> String {
    format!("{} · {} · {}:{}", n.name, n.kind, n.path, n.span)
}

fn group_label(text: &str) -> String {
    if text.contains(": ")
        || text.contains(", ")
        || text.contains(" [")
        || text.starts_with('[')
        || text.starts_with('"')
        || text.ends_with(' ')
    {
        serde_json::to_string(text).unwrap_or_else(|_| text.to_string())
    } else {
        text.to_string()
    }
}

fn hit_line(direction: Direction, hit: &EdgeHit, show_depth: bool) -> String {
    let arrow = direction.arrow();
    let depth_tag = if show_depth {
        format!(" [depth {}]", hit.depth)
    } else {
        String::new()
    };
    let mark = hit.confidence.mark();
    format!(
        "  {} {arrow} {} (unresolved import){depth_tag}{mark}",
        hit.relation, hit.id
    )
}

fn grouped_hit(node: &NodeV1, depth: usize, show_depth: bool, quote: Option<&Quote>) -> String {
    let depth_tag = if show_depth {
        format!(" [depth {depth}]")
    } else {
        String::new()
    };
    let name = group_label(&node.name);
    if let Some(q) = quote {
        format!("{name} L{}{depth_tag}: {}", q.n, q.text.trim())
    } else {
        let first_line = node.span.split('-').next().unwrap_or(&node.span);
        format!("{name} {first_line}{depth_tag}")
    }
}

fn loose_note_for(direction: Direction, name: &str, candidate_count: usize) -> String {
    let (label, dir) = match direction {
        Direction::Out => ("callees", "outgoing"),
        Direction::In => ("callers", "incoming"),
    };
    let ambiguity = if candidate_count > 1 {
        format!(
            " {candidate_count} definitions share the name \"{name}\"; a cross-file caller of an ambiguous name is dropped rather than guessed, so this may undercount."
        )
    } else {
        String::new()
    };
    format!(
        "  no indexed {label} — the graph has no {dir} call/reference edges for this symbol as written.{ambiguity} Check the name (try the bare symbol, or \"Type.method\"), or find its uses with {} \"{name}\". Fall back to raw grep -rn only for unindexed files",
        cmd("graft grep")
    )
}

pub fn unresolved_note_for(
    calls: &[UnresolvedCall],
    direction: Direction,
    name: &str,
) -> Option<String> {
    if direction != Direction::In || calls.is_empty() {
        return None;
    }
    let named: Vec<String> = calls
        .iter()
        .take(5)
        .map(|c| match &c.through {
            Some(through) => match &c.file {
                Some(file) => format!(
                    "{} (through {through}, in {file}, which is not indexed)",
                    c.source
                ),
                None => format!("{} (through {through})", c.source),
            },
            None => format!(
                "{} (an assignment or a second import gives it more than one target)",
                c.source
            ),
        })
        .collect();
    let more = if calls.len() > 5 {
        format!(" and {} more", calls.len() - 5)
    } else {
        String::new()
    };
    Some(format!(
        "  ⚠ may be incomplete: {} call(s) to \"{name}\" did not resolve to one definition and are not listed: {}{more}",
        calls.len(),
        named.join(", ")
    ))
}

struct HitGroup {
    lead: String,
    mark: &'static str,
    items: Vec<(NodeV1, usize, Option<Quote>)>,
}

enum GroupEntry {
    Raw(String),
    Group(usize),
}

fn hit_lines(
    root: &Path,
    symbol_name: &str,
    direction: Direction,
    hits: &[EdgeHit],
    show_depth: bool,
    shared: Option<&str>,
    file_cache: &mut HashMap<String, Option<Vec<String>>>,
) -> Vec<String> {
    let mut group_idx: HashMap<(String, String, &'static str), usize> = HashMap::new();
    let mut groups: Vec<HitGroup> = Vec::new();
    let mut order: Vec<GroupEntry> = Vec::new();

    for h in hits {
        let Some(ref node) = h.node else {
            order.push(GroupEntry::Raw(hit_line(direction, h, show_depth)));
            continue;
        };
        let quote = if h.depth <= 1 && !is_test_path(&node.path) {
            call_reference_line(root, &node.path, &node.span, symbol_name, file_cache)
        } else {
            None
        };
        let key = (h.relation.clone(), node.path.clone(), h.confidence.mark());
        let idx = *group_idx.entry(key).or_insert_with(|| {
            let lead = if shared.is_some() {
                format!("  {}", group_label(&node.path))
            } else {
                format!(
                    "  {} {} {}",
                    h.relation,
                    direction.arrow(),
                    group_label(&node.path)
                )
            };
            let idx = groups.len();
            groups.push(HitGroup {
                lead,
                mark: h.confidence.mark(),
                items: Vec::new(),
            });
            order.push(GroupEntry::Group(idx));
            idx
        });
        groups[idx].items.push((node.clone(), h.depth, quote));
    }

    order
        .into_iter()
        .map(|entry| match entry {
            GroupEntry::Raw(s) => s,
            GroupEntry::Group(idx) => {
                let g = &groups[idx];
                if g.items.iter().all(|(_, _, q)| q.is_none()) {
                    let list: Vec<String> = g
                        .items
                        .iter()
                        .map(|(n, d, _)| grouped_hit(n, *d, show_depth, None))
                        .collect();
                    format!("{}{}: {}", g.lead, g.mark, list.join(", "))
                } else {
                    let mut lines = Vec::with_capacity(g.items.len() + 1);
                    lines.push(format!("{}{}", g.lead, g.mark));
                    for (n, d, q) in &g.items {
                        lines.push(format!(
                            "    {}",
                            grouped_hit(n, *d, show_depth, q.as_ref())
                        ));
                    }
                    lines.join("\n")
                }
            }
        })
        .collect()
}

fn quiet_lines(direction: Direction, quiet: &[&NodeV1], total: usize) -> Vec<String> {
    let label = match direction {
        Direction::Out => "callees",
        Direction::In => "callers",
    };
    let mut names: Vec<&str> = Vec::new();
    for n in quiet {
        if !names.contains(&n.name.as_str()) {
            names.push(&n.name);
        }
    }
    let named: String = names
        .iter()
        .map(|n| format!("\"{n}\""))
        .collect::<Vec<_>>()
        .join(" or ");
    let mut lines: Vec<String> = quiet
        .iter()
        .take(QUIET_SHOWN)
        .map(|n| header_of(n))
        .collect();
    if quiet.len() > QUIET_SHOWN {
        let rest = &quiet[QUIET_SHOWN..];
        let rest_files: HashSet<&str> = rest.iter().map(|n| n.path.as_str()).collect();
        lines.push(format!(
            "… and {} more in {} file(s)",
            rest.len(),
            rest_files.len()
        ));
    }
    let which = if quiet.len() == total {
        format!("any of the {total}")
    } else {
        format!("{} of the {total}", quiet.len())
    };
    let grep = if names.len() == 1 {
        format!(", or find its uses with {} {named}", cmd("graft grep"))
    } else {
        String::new()
    };
    lines.push(format!(
        "  no indexed {label} for {which} definitions named {named}; a cross-file caller of a shared name is dropped rather than guessed, so this may undercount. Pick one with --in <path prefix>{grep}"
    ));
    lines
}

pub fn format_callers_text(
    root: &Path,
    direction: Direction,
    show_depth: bool,
    results: &[SymbolResult],
    unresolved_by_name: &HashMap<String, Vec<UnresolvedCall>>,
    saved: Option<&Savings>,
) -> String {
    let mut noted: HashSet<String> = HashSet::new();
    let mut file_cache: HashMap<String, Option<Vec<String>>> = HashMap::new();
    let mut blocks: Vec<String> = Vec::new();
    let quiet: Vec<&NodeV1> = if results.len() > 1 {
        results
            .iter()
            .filter(|r| r.hits.is_empty())
            .map(|r| &r.symbol)
            .collect()
    } else {
        Vec::new()
    };

    for r in results {
        if r.hits.is_empty() && results.len() > 1 {
            continue;
        }
        let mut lines = Vec::new();
        if r.hits.is_empty() {
            lines.push(header_of(&r.symbol));
            lines.push(loose_note_for(direction, &r.symbol.name, 1));
        } else {
            let first_rel = &r.hits[0].relation;
            let shared = r
                .hits
                .iter()
                .all(|h| h.relation == *first_rel)
                .then(|| format!("{first_rel} {}", direction.arrow()));
            let header = match &shared {
                Some(s) => format!("{} · {s}", header_of(&r.symbol)),
                None => header_of(&r.symbol),
            };
            lines.push(header);
            lines.extend(hit_lines(
                root,
                &r.symbol.name,
                direction,
                &r.hits,
                show_depth,
                shared.as_deref(),
                &mut file_cache,
            ));
        }
        if noted.insert(r.symbol.name.clone())
            && let Some(calls) = unresolved_by_name.get(&r.symbol.name)
            && let Some(note) = unresolved_note_for(calls, direction, &r.symbol.name)
        {
            lines.push(note);
        }
        blocks.push(lines.join("\n"));
    }

    if !quiet.is_empty() {
        let mut q_lines = quiet_lines(direction, &quiet, results.len());
        for q in &quiet {
            if noted.insert(q.name.clone())
                && let Some(calls) = unresolved_by_name.get(&q.name)
                && let Some(note) = unresolved_note_for(calls, direction, &q.name)
            {
                q_lines.push(note);
            }
        }
        blocks.push(q_lines.join("\n"));
    }

    let body = format!("{}\n", blocks.join("\n\n"));
    with_savings(&body, saved)
}

#[derive(Serialize)]
struct JsonSymbol<'a> {
    id: &'a str,
    name: &'a str,
    kind: &'a str,
    path: &'a str,
    span: &'a str,
}

#[derive(Serialize)]
struct JsonHit<'a> {
    id: &'a str,
    relation: &'a str,
    depth: usize,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    inferred: bool,
    confidence: &'static str,
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
struct JsonMatch<'a> {
    symbol: JsonSymbol<'a>,
    hits: Vec<JsonHit<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unresolved: Option<String>,
}

#[derive(Serialize)]
struct JsonCallersPayload<'a> {
    query: &'a str,
    matches: Vec<JsonMatch<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    saved: Option<&'a Savings>,
}

pub fn format_callers_json(
    query: &str,
    direction: Direction,
    results: &[SymbolResult],
    unresolved_by_name: &HashMap<String, Vec<UnresolvedCall>>,
    saved: Option<&Savings>,
) -> String {
    let matches: Vec<JsonMatch<'_>> = results
        .iter()
        .map(|r| {
            let hits = r
                .hits
                .iter()
                .map(|h| JsonHit {
                    id: &h.id,
                    relation: &h.relation,
                    depth: h.depth,
                    inferred: h.inferred,
                    confidence: h.confidence.as_str(),
                    name: h.node.as_ref().map(|n| n.name.as_str()),
                    kind: h.node.as_ref().map(|n| n.kind.as_str()),
                    path: h.node.as_ref().map(|n| n.path.as_str()),
                    span: h.node.as_ref().map(|n| n.span.as_str()),
                })
                .collect();
            let note = r
                .hits
                .is_empty()
                .then(|| loose_note_for(direction, &r.symbol.name, results.len()));
            let unresolved = if direction == Direction::In {
                unresolved_by_name
                    .get(&r.symbol.name)
                    .and_then(|c| unresolved_note_for(c, direction, &r.symbol.name))
                    .map(|s| s.trim().to_string())
            } else {
                None
            };
            JsonMatch {
                symbol: JsonSymbol {
                    id: &r.symbol.id,
                    name: &r.symbol.name,
                    kind: &r.symbol.kind,
                    path: &r.symbol.path,
                    span: &r.symbol.span,
                },
                hits,
                note,
                unresolved,
            }
        })
        .collect();
    let payload = JsonCallersPayload {
        query,
        matches,
        saved,
    };
    serde_json::to_string_pretty(&payload).unwrap_or_default()
}

#[derive(Serialize)]
struct BlastSeed<'a> {
    id: &'a str,
    name: &'a str,
    kind: &'a str,
    path: &'a str,
    span: &'a str,
}

#[derive(Serialize)]
struct BlastImpacted<'a> {
    id: &'a str,
    name: Option<&'a str>,
    kind: Option<&'a str>,
    path: Option<&'a str>,
    span: Option<&'a str>,
    relation: &'a str,
    depth: usize,
}

#[derive(Serialize)]
struct BlastJson<'a> {
    depth: usize,
    changed: &'a [String],
    seeds: Vec<BlastSeed<'a>>,
    impacted: Vec<BlastImpacted<'a>>,
}

pub fn format_blast_json(
    depth: usize,
    changed: &[String],
    seeds: &[NodeV1],
    impacted: &[EdgeHit],
) -> Result<String, String> {
    let payload = BlastJson {
        depth,
        changed,
        seeds: seeds
            .iter()
            .map(|s| BlastSeed {
                id: &s.id,
                name: &s.name,
                kind: &s.kind,
                path: &s.path,
                span: &s.span,
            })
            .collect(),
        impacted: impacted
            .iter()
            .map(|h| BlastImpacted {
                id: &h.id,
                name: h.node.as_ref().map(|n| n.name.as_str()),
                kind: h.node.as_ref().map(|n| n.kind.as_str()),
                path: h.node.as_ref().map(|n| n.path.as_str()),
                span: h.node.as_ref().map(|n| n.span.as_str()),
                relation: &h.relation,
                depth: h.depth,
            })
            .collect(),
    };
    serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())
}
