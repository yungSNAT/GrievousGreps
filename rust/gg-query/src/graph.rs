//! Graph data types, symbol resolution, formatting and savings calculations.
//!
//! Mirrors `src/graph/types.ts`, `src/graph/traverse.ts`,
//! `src/graph/traverse-cli.ts` and `src/context/savings.ts`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const WALK_RELATIONS: &[&str] = &["calls", "references", "imports", "implements", "extends"];
pub const INFERRED_MARK: &str = " [inferred]";
const QUIET_SHOWN: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    In,
    Out,
}

impl Direction {
    pub fn arrow(self) -> &'static str {
        match self {
            Self::In => "←",
            Self::Out => "→",
        }
    }

    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw {
            None | Some("in") => Ok(Self::In),
            Some("out") => Ok(Self::Out),
            Some(other) => Err(format!(
                "--direction must be \"in\" or \"out\", got \"{other}\""
            )),
        }
    }
}

pub fn parse_depth(raw: Option<&str>, default_depth: usize) -> Result<usize, String> {
    let Some(s) = raw else {
        return Ok(default_depth);
    };
    if s.eq_ignore_ascii_case("all")
        || s.eq_ignore_ascii_case("full")
        || s.eq_ignore_ascii_case("max")
    {
        return Ok(usize::MAX);
    }
    let parsed: f64 = s.parse().unwrap_or(f64::NAN);
    if !parsed.is_finite() || parsed < 1.0 {
        return Err(format!(
            "--depth must be a positive number or \"all\", got \"{s}\""
        ));
    }
    Ok(parsed.floor() as usize)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GraphMeta {
    #[serde(rename = "nodeCount", default)]
    pub node_count: usize,
    #[serde(rename = "edgeCount", default)]
    pub edge_count: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NodeV1 {
    pub id: String,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub owner: Option<String>,
    pub path: String,
    pub span: String,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default)]
    pub exported: bool,
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub body_hash: String,
    #[serde(default)]
    pub chars: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EdgeV1 {
    pub source: String,
    pub target: String,
    pub relation: String,
    #[serde(default)]
    pub confidence: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UnresolvedCall {
    pub name: String,
    pub source: String,
    #[serde(default)]
    pub through: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GraphV1 {
    pub meta: GraphMeta,
    pub nodes: Vec<NodeV1>,
    pub edges: Vec<EdgeV1>,
    #[serde(rename = "unresolvedCalls", default)]
    pub unresolved_calls: Vec<UnresolvedCall>,
}

#[derive(Debug, Clone)]
pub struct EdgeHit {
    pub node: Option<NodeV1>,
    pub id: String,
    pub relation: String,
    pub depth: usize,
    pub inferred: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Savings {
    pub files: usize,
    #[serde(rename = "baselineChars")]
    pub baseline_chars: usize,
}

pub fn is_walk_relation(rel: &str) -> bool {
    WALK_RELATIONS.contains(&rel)
}

/// Strip mint-time disambiguation ordinals (`~2`, `~3`, ...) at segment ends.
pub fn strip_ordinals(id_tail: &str) -> String {
    let bytes = id_tail.as_bytes();
    let mut out = String::with_capacity(id_tail.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'~' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 1 && (j == bytes.len() || bytes[j] == b'.') {
                i = j;
                continue;
            }
        }
        let ch = id_tail[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

pub fn normalize_path_prefix(p: &str) -> String {
    let mut s = p.replace('\\', "/");
    while let Some(rest) = s.strip_prefix("./") {
        s = rest.to_string();
    }
    while s.ends_with('/') {
        s.pop();
    }
    s
}

pub fn path_under_prefix(path: &str, prefix: &str) -> bool {
    prefix.is_empty()
        || path == prefix
        || (path.starts_with(prefix) && path.as_bytes().get(prefix.len()) == Some(&b'/'))
}

pub fn looks_like_filename(query: &str) -> bool {
    if query.contains('#') {
        return false;
    }
    if query.contains('/') {
        return true;
    }
    let Some((_, ext)) = query.rsplit_once('.') else {
        return false;
    };
    !ext.is_empty() && ext.len() <= 5 && ext.bytes().all(|b| b.is_ascii_alphanumeric())
}

pub fn symbol_matches_node(node: &NodeV1, lower_query: &str) -> bool {
    if node.kind == "file" {
        return false;
    }
    if node.name.to_lowercase() == lower_query {
        return true;
    }
    let lower_id = node.id.to_lowercase();
    let candidate = if let Some(hash_idx) = lower_id.find('#') {
        format!(
            "{}{}",
            &lower_id[..=hash_idx],
            strip_ordinals(&lower_id[hash_idx + 1..])
        )
    } else {
        lower_id
    };
    let suffix_hash = format!("#{lower_query}");
    let suffix_dot = format!(".{lower_query}");
    candidate.ends_with(&suffix_hash) || candidate.ends_with(&suffix_dot)
}

pub fn is_test_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    for seg in ["test/", "tests/", "__tests__/", "spec/"] {
        if lower.starts_with(seg) || lower.contains(&format!("/{seg}")) {
            return true;
        }
    }
    if let Some((stem, ext)) = lower.rsplit_once('.')
        && !ext.is_empty()
        && ext.bytes().all(|b| b.is_ascii_alphabetic())
        && (stem.ends_with("_test") || stem.ends_with(".test") || stem.ends_with(".spec"))
    {
        return true;
    }
    let base = lower.rsplit('/').next().unwrap_or(&lower);
    base == "conftest.py" || (base.starts_with("test_") && base.ends_with(".py"))
}

pub fn span_range(span: &str) -> Option<(usize, usize)> {
    let rest = span.strip_prefix('L')?;
    if let Some((a, b)) = rest.split_once("-L") {
        let start = a.parse().ok()?;
        let end = b.parse().ok()?;
        Some((start, end))
    } else {
        let start = rest.parse().ok()?;
        Some((start, start))
    }
}

fn is_word_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn contains_word(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let h = haystack.as_bytes();
    let n = needle.as_bytes();
    let mut start = 0;
    while let Some(pos) = haystack[start..].find(needle) {
        let abs = start + pos;
        let left_ok = abs == 0 || !is_word_char(h[abs - 1]);
        let right_idx = abs + n.len();
        let right_ok = right_idx == h.len() || !is_word_char(h[right_idx]);
        if left_ok && right_ok {
            return true;
        }
        start = abs + 1;
    }
    false
}

pub struct Quote {
    pub n: usize,
    pub text: String,
}

pub fn reference_line(
    root: &Path,
    path: &str,
    span: &str,
    symbol_name: &str,
    cache: &mut HashMap<String, Option<Vec<String>>>,
) -> Option<Quote> {
    let (start, end) = span_range(span)?;
    let lines = cache
        .entry(path.to_string())
        .or_insert_with(|| {
            let full = root.join(path);
            std::fs::read_to_string(full)
                .ok()
                .map(|s| s.lines().map(String::from).collect())
        })
        .as_ref()?;
    let lo = start.saturating_sub(1);
    let hi = end.min(lines.len());
    for (idx, line) in lines.iter().enumerate().take(hi).skip(lo) {
        if contains_word(line, symbol_name) {
            return Some(Quote {
                n: idx + 1,
                text: line.clone(),
            });
        }
    }
    None
}

pub fn group_digits(n: usize) -> String {
    let s = n.to_string();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, &b) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(b as char);
    }
    out
}

pub fn to_tokens(chars: usize) -> usize {
    ((chars as f64) / 4.0).round() as usize
}

pub fn with_savings(body: &str, saved: Option<&Savings>) -> String {
    let Some(s) = saved else {
        return body.to_string();
    };
    if s.baseline_chars == 0 {
        return body.to_string();
    }
    let body_len = body.encode_utf16().count();
    let pack = to_tokens(body_len);
    let base = to_tokens(s.baseline_chars);
    if base <= pack {
        return body.to_string();
    }
    let delta = base - pack;
    let pct = ((delta as f64 / base as f64) * 100.0).round() as usize;
    format!(
        "[trail] tokens saved ≈ {} ({pct}%) at most, against reading the {} file(s) whole\n\n{body}",
        group_digits(delta),
        s.files
    )
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
    let label = match &hit.node {
        Some(n) => format!("{} ({}:{})", n.name, n.path, n.span),
        None => format!("{} (unresolved import)", hit.id),
    };
    let mark = if hit.inferred { INFERRED_MARK } else { "" };
    format!("  {} {arrow} {label}{depth_tag}{mark}", hit.relation)
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
        "  no indexed {label} — the graph has no {dir} call/reference edges for this symbol as written.{ambiguity} Check the name (try the bare symbol, or \"Type.method\"), or find its uses with trail grep \"{name}\". Fall back to raw grep -rn only for unindexed files"
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
    let mut group_idx: HashMap<(String, String, bool), usize> = HashMap::new();
    let mut groups: Vec<HitGroup> = Vec::new();
    let mut order: Vec<GroupEntry> = Vec::new();

    for h in hits {
        let Some(ref node) = h.node else {
            order.push(GroupEntry::Raw(hit_line(direction, h, show_depth)));
            continue;
        };
        let quote = if h.depth <= 1 && !is_test_path(&node.path) {
            reference_line(root, &node.path, &node.span, symbol_name, file_cache)
        } else {
            None
        };
        let key = (h.relation.clone(), node.path.clone(), h.inferred);
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
                mark: if h.inferred { INFERRED_MARK } else { "" },
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

pub struct SymbolResult {
    pub symbol: NodeV1,
    pub hits: Vec<EdgeHit>,
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
        let mut q_lines: Vec<String> = quiet
            .iter()
            .take(QUIET_SHOWN)
            .map(|n| header_of(n))
            .collect();
        if quiet.len() > QUIET_SHOWN {
            q_lines.push(format!(
                "  … and {} more with no indexed edges",
                quiet.len() - QUIET_SHOWN
            ));
        }
        q_lines.push(loose_note_for(direction, &quiet[0].name, results.len()));
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
    #[serde(rename = "unresolvedCalls", skip_serializing_if = "Option::is_none")]
    unresolved_calls: Option<&'a [UnresolvedCall]>,
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
                    name: h.node.as_ref().map(|n| n.name.as_str()),
                    kind: h.node.as_ref().map(|n| n.kind.as_str()),
                    path: h.node.as_ref().map(|n| n.path.as_str()),
                    span: h.node.as_ref().map(|n| n.span.as_str()),
                })
                .collect();
            let note = r.hits.is_empty().then(|| {
                loose_note_for(direction, &r.symbol.name, results.len())
                    .trim()
                    .to_string()
            });
            let unresolved_calls = if direction == Direction::In {
                unresolved_by_name
                    .get(&r.symbol.name)
                    .filter(|v| !v.is_empty())
                    .map(Vec::as_slice)
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
                unresolved_calls,
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
