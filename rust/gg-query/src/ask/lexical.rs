//! Lexical, BM25, PPR graph-rank, bounded file ranking, and multi-scope fusion for `ask`.
//!
//! Mirrors `lexical()` and concept loading in `src/ask/ask.ts`.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::Path;

use crate::ask::{AskHit, AskMode, AskResult, AskScopes, ScopeMiss};
use crate::file_rank::{
    FileRankCandidate, RankedFile, ScopeRankCandidate, ScopedDoc, combine_comparable_scopes,
    file_first_round_robin, rank_files_bounded, round_robin_queues,
};
use crate::graph::{
    NodeV1, ScopeV1, is_test_path, js_locale_cmp, path_under_prefix, scope_of, scopes_here_clause,
    span_range,
};
use crate::graphrank::{DEFAULT_ALPHA, DEFAULT_ITERS, PageRankTopology};
use crate::query::{NodeLite, PostingRow};
use crate::store::GraphStore;
use crate::tokenize::{counts, tokenize, unique_terms_ordered};

const TEST_RANK_PENALTY: f64 = 0.35;
const GRAPH_WEIGHT: f64 = 0.5;
const RESCUE_FLOOR: f64 = 0.15;

#[derive(Debug, Clone)]
pub struct ConceptDoc {
    pub slug: String,
    pub name: String,
    pub sources: Vec<String>,
    pub related: Vec<String>,
    pub snippet: String,
    pub name_bag: HashMap<String, usize>,
    pub body_bag: HashMap<String, usize>,
}

#[derive(Default)]
struct NodeBag {
    name: HashMap<String, usize>,
    path: HashMap<String, usize>,
    body: HashMap<String, usize>,
}

struct HitEntry {
    hit: AskHit,
    group_key: String,
    coverage: f64,
    coverage_strong: f64,
}

fn wants_tests(query: &str) -> bool {
    let lower = query.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            let word = &lower[start..i];
            if matches!(
                word,
                "test"
                    | "tests"
                    | "spec"
                    | "specs"
                    | "coverage"
                    | "assert"
                    | "asserts"
                    | "assertion"
                    | "assertions"
                    | "fixture"
                    | "fixtures"
                    | "mock"
                    | "mocks"
            ) {
                return true;
            }
        } else {
            i += 1;
        }
    }
    false
}

fn test_factor(path: &str, query_wants_tests: bool) -> f64 {
    if !query_wants_tests && is_test_path(path) {
        TEST_RANK_PENALTY
    } else {
        1.0
    }
}

fn first_prose(body: &str) -> String {
    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty()
            || line.starts_with('#')
            || line.starts_with("<!--")
            || line.starts_with('-')
        {
            continue;
        }
        return line.to_string();
    }
    String::new()
}

fn strip_quotes(val: &str) -> String {
    let t = val.trim();
    if (t.starts_with('"') && t.ends_with('"') && t.len() >= 2)
        || (t.starts_with('\'') && t.ends_with('\'') && t.len() >= 2)
    {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

/// Minimal, anchor-refusing YAML frontmatter reader for concept markdown files.
fn parse_concept_markdown(text: &str, default_slug: &str) -> ConceptDoc {
    let mut slug = default_slug.to_string();
    let mut name = String::new();
    let mut sources = Vec::new();
    let mut related = Vec::new();
    let mut body = text;

    let norm = text.replace("\r\n", "\n");
    if let Some(rest) = norm.strip_prefix("---\n")
        && let Some(end_idx) = rest.find("\n---")
    {
        let fm = &rest[..end_idx];
        let after = &rest[end_idx + 4..];
        body = after.strip_prefix('\n').unwrap_or(after);

        let has_anchor_or_alias = fm.lines().any(|l| {
            let trimmed = l.trim();
            !trimmed.starts_with('#') && (trimmed.contains(" &") || trimmed.contains(" *"))
        });
        if !has_anchor_or_alias {
            let mut section = "";
            for line in fm.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                if !line.starts_with(' ') && !line.starts_with('\t') {
                    section = "";
                    if let Some((k, v)) = trimmed.split_once(':') {
                        let key = k.trim();
                        let val = strip_quotes(v);
                        match key {
                            "slug" if !val.is_empty() => slug = val,
                            "name" => name = val,
                            "sources" => section = "sources",
                            "links" => section = "links",
                            _ => {}
                        }
                    }
                } else if section == "sources" {
                    let item = trimmed.strip_prefix('-').map_or(trimmed, str::trim);
                    if let Some((_, v)) = item.split_once("path:") {
                        let p = strip_quotes(v);
                        if !p.is_empty() {
                            sources.push(p);
                        }
                    }
                } else if section == "links" {
                    let item = trimmed.strip_prefix('-').map_or(trimmed, str::trim);
                    if let Some((_, v)) = item.split_once("to:") {
                        let to = strip_quotes(v);
                        if !to.is_empty() {
                            related.push(to);
                        }
                    }
                }
            }
        }
    }

    let snippet = first_prose(body);
    let combined = format!("{name} {snippet} {}", sources.join(" "));
    ConceptDoc {
        slug,
        name_bag: counts(&tokenize(&name)),
        body_bag: counts(&tokenize(&combined)),
        name,
        sources,
        related,
        snippet,
    }
}

pub fn load_concepts(out_dir: &Path, in_prefix: Option<&str>) -> io::Result<Vec<ConceptDoc>> {
    if !out_dir.is_dir() {
        return Ok(Vec::new());
    }
    let meta = fs::symlink_metadata(out_dir)?;
    if meta.file_type().is_symlink() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<String> = Vec::new();
    for entry in fs::read_dir(out_dir)? {
        let entry = entry?;
        let fname = entry.file_name().to_string_lossy().to_string();
        if !fname.ends_with(".md") || fname == "INDEX.md" {
            continue;
        }
        if entry.file_type()?.is_symlink() || !entry.file_type()?.is_file() {
            continue;
        }
        entries.push(fname);
    }
    entries.sort();

    let mut out = Vec::new();
    for fname in entries {
        let Ok(text) = fs::read_to_string(out_dir.join(&fname)) else {
            continue;
        };
        let default_slug = fname.strip_suffix(".md").unwrap_or(&fname);
        let doc = parse_concept_markdown(&text, default_slug);
        if let Some(prefix) = in_prefix
            && !doc.sources.iter().any(|p| path_under_prefix(p, prefix))
        {
            continue;
        }
        out.push(doc);
    }
    Ok(out)
}

fn has_term(bag: &HashMap<String, usize>, term: &str) -> bool {
    if bag.contains_key(term) {
        return true;
    }
    let plural = format!("{term}s");
    if bag.contains_key(&plural) {
        return true;
    }
    if let Some(singular) = term.strip_suffix('s')
        && bag.contains_key(singular)
    {
        return true;
    }
    false
}

fn score_bag(q_terms: &[String], bag: &HashMap<String, usize>, idf: &HashMap<String, f64>) -> f64 {
    let mut s = 0.0;
    for t in q_terms {
        if let Some(&dn) = bag.get(t) {
            s += (dn as f64) * idf.get(t).copied().unwrap_or(1.0);
        }
    }
    s
}

fn bm25(
    q_terms: &[String],
    bag: &HashMap<String, usize>,
    idf: &HashMap<String, f64>,
    dl: usize,
    avgdl: f64,
) -> f64 {
    const K1: f64 = 1.2;
    const B: f64 = 0.75;
    let denom = if avgdl == 0.0 { 1.0 } else { avgdl };
    let norm = K1 * (1.0 - B + (B * (dl as f64)) / denom);
    let mut s = 0.0;
    for t in q_terms {
        if let Some(&tf) = bag.get(t) {
            let tf_f = tf as f64;
            s += idf.get(t).copied().unwrap_or(1.0) * ((tf_f * (K1 + 1.0)) / (tf_f + norm));
        }
    }
    s
}

fn matched_idf_share(
    q_terms: &[String],
    fields: &[&HashMap<String, usize>],
    idf: &HashMap<String, f64>,
    dflt_idf: f64,
) -> f64 {
    let mut matched = 0.0;
    let mut total = 0.0;
    for t in q_terms {
        let w = idf.get(t).copied().unwrap_or(dflt_idf);
        total += w;
        if fields.iter().any(|f| has_term(f, t)) {
            matched += w;
        }
    }
    if total > 0.0 { matched / total } else { 0.0 }
}

fn normalized_query_weights(
    q_terms: &[String],
    idf: &HashMap<String, f64>,
    dflt_idf: f64,
) -> HashMap<String, f64> {
    let total: f64 = q_terms
        .iter()
        .map(|t| idf.get(t).copied().unwrap_or(dflt_idf))
        .sum();
    if total <= 0.0 {
        return HashMap::new();
    }
    q_terms
        .iter()
        .map(|t| (t.clone(), idf.get(t).copied().unwrap_or(dflt_idf) / total))
        .collect()
}

fn lookup_terms(q_terms: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for t in q_terms {
        for cand in [
            Some(t.clone()),
            Some(format!("{t}s")),
            t.strip_suffix('s').map(str::to_string),
        ]
        .into_iter()
        .flatten()
        {
            if seen.insert(cand.clone()) {
                out.push(cand);
            }
        }
    }
    out
}

struct CorpusStats {
    idf: HashMap<String, f64>,
    dflt_idf: f64,
    avg_body_len: f64,
    bags_by_seq: HashMap<usize, NodeBag>,
}

fn build_corpus_stats(
    store: &GraphStore,
    q_terms: &[String],
    concepts: &[ConceptDoc],
    nodes_lite: &[NodeLite],
    in_prefix: Option<&str>,
) -> io::Result<CorpusStats> {
    let looked = lookup_terms(q_terms);
    let postings: Vec<PostingRow> = if looked.is_empty() {
        Vec::new()
    } else {
        store.ask_postings_for_tokens(&looked)?
    };
    let mut bags_by_seq: HashMap<usize, NodeBag> = HashMap::new();
    for p in postings {
        if let Some(prefix) = in_prefix
            && !nodes_lite
                .get(p.node_seq)
                .is_some_and(|n| path_under_prefix(&n.path, prefix))
        {
            continue;
        }
        let bag = bags_by_seq.entry(p.node_seq).or_default();
        if p.name_tf > 0 {
            bag.name.insert(p.token.clone(), p.name_tf);
        }
        if p.path_tf > 0 {
            bag.path.insert(p.token.clone(), p.path_tf);
        }
        if p.body_tf > 0 {
            bag.body.insert(p.token, p.body_tf);
        }
    }

    let (mut df_map, n_docs, avg_body_len) = if let Some(prefix) = in_prefix {
        let mut count = 0_usize;
        let mut body_sum = 0_usize;
        for n in nodes_lite {
            if path_under_prefix(&n.path, prefix) {
                count += 1;
                body_sum += n.body_len;
            }
        }
        let mut df: HashMap<String, usize> = HashMap::new();
        for bag in bags_by_seq.values() {
            for t in q_terms {
                if bag.name.contains_key(t) || bag.path.contains_key(t) || bag.body.contains_key(t)
                {
                    *df.entry(t.clone()).or_insert(0) += 1;
                }
            }
        }
        let avg = if count > 0 {
            body_sum as f64 / count as f64
        } else {
            0.0
        };
        (df, count + concepts.len(), avg)
    } else {
        let (doc_count, avg) = store.ask_meta()?;
        let df = if q_terms.is_empty() {
            HashMap::new()
        } else {
            store.ask_df_for_tokens(q_terms)?
        };
        (df, doc_count + concepts.len(), avg)
    };

    for c in concepts {
        for t in q_terms {
            if c.name_bag.contains_key(t) || c.body_bag.contains_key(t) {
                *df_map.entry(t.clone()).or_insert(0) += 1;
            }
        }
    }

    let mut idf = HashMap::new();
    for (t, d) in df_map {
        idf.insert(t, (1.0 + (n_docs as f64) / (1.0 + (d as f64))).ln());
    }
    let dflt_idf = (1.0 + (n_docs as f64)).ln();
    Ok(CorpusStats {
        idf,
        dflt_idf,
        avg_body_len,
        bags_by_seq,
    })
}

fn score_concepts(
    q_terms: &[String],
    concepts: &[ConceptDoc],
    idf: &HashMap<String, f64>,
    dflt_idf: f64,
) -> Vec<HitEntry> {
    let mut hits = Vec::new();
    let mut max_c = 0.0_f64;
    for c in concepts {
        let total =
            score_bag(q_terms, &c.name_bag, idf) * 3.0 + score_bag(q_terms, &c.body_bag, idf);
        if total > 0.0 {
            max_c = max_c.max(total);
            let cov = matched_idf_share(q_terms, &[&c.name_bag, &c.body_bag], idf, dflt_idf);
            let strong = matched_idf_share(q_terms, &[&c.name_bag], idf, dflt_idf);
            let group_key = format!("concept:{}:{}", c.slug, hits.len());
            let title = if c.name.is_empty() {
                c.slug.clone()
            } else {
                c.name.clone()
            };
            let pointer = if c.sources.is_empty() {
                c.slug.clone()
            } else {
                c.sources.join(", ")
            };
            hits.push(HitEntry {
                hit: AskHit {
                    kind: "concept".to_string(),
                    title,
                    pointer,
                    snippet: c.snippet.clone(),
                    relation: None,
                    related: Some(c.related.clone()),
                    score: total,
                    code: None,
                    scope: None,
                },
                group_key,
                coverage: cov,
                coverage_strong: strong,
            });
        }
    }
    for entry in &mut hits {
        entry.hit.score = if max_c > 0.0 {
            entry.hit.score / max_c
        } else {
            0.0
        };
    }
    hits
}

fn make_symbol_hit(
    node: &NodeV1,
    score: f64,
    scope: Option<String>,
    bag: Option<&NodeBag>,
    q_terms: &[String],
    idf: &HashMap<String, f64>,
    dflt_idf: f64,
) -> HitEntry {
    let pointer = if node.kind == "file" {
        node.path.clone()
    } else {
        format!("{}:{}", node.path, node.span)
    };
    let snippet = node
        .summary
        .as_deref()
        .and_then(|s| s.lines().next())
        .map(|l| l.trim().to_string())
        .or_else(|| node.signature.clone())
        .unwrap_or_default();
    let (cov, strong) = match bag {
        Some(b) => {
            let c = matched_idf_share(q_terms, &[&b.name, &b.path, &b.body], idf, dflt_idf);
            let s = if node.kind == "file" {
                0.0
            } else {
                matched_idf_share(q_terms, &[&b.name], idf, dflt_idf)
            };
            (c, s)
        }
        None => (0.0, 0.0),
    };
    HitEntry {
        hit: AskHit {
            kind: "symbol".to_string(),
            title: format!("{} · {}", node.name, node.kind),
            pointer,
            snippet,
            relation: None,
            related: None,
            score,
            code: None,
            scope,
        },
        group_key: format!("file:{}", node.path),
        coverage: cov,
        coverage_strong: strong,
    }
}

fn hit_entry_cmp(a: &HitEntry, b: &HitEntry) -> Ordering {
    b.hit
        .score
        .total_cmp(&a.hit.score)
        .then_with(|| js_locale_cmp(&a.hit.title, &b.hit.title))
}

fn same_hit(a: &AskHit, b: &AskHit) -> bool {
    a.kind == b.kind && a.pointer == b.pointer && a.title == b.title
}

#[allow(clippy::too_many_arguments)]
fn build_file_candidate(
    seq: usize,
    node: &NodeV1,
    raw_lexical: f64,
    lexical: f64,
    graph: f64,
    rank_factor: f64,
    baseline_score: f64,
    bag: Option<&NodeBag>,
    q_terms: &[String],
) -> FileRankCandidate {
    let mut matched_terms = Vec::new();
    let mut matched_strong_terms = Vec::new();
    if let Some(b) = bag {
        for t in q_terms {
            if b.name.contains_key(t) || b.path.contains_key(t) || b.body.contains_key(t) {
                matched_terms.push(t.clone());
            }
            if node.kind != "file" && has_term(&b.name, t) {
                matched_strong_terms.push(t.clone());
            }
        }
    }
    FileRankCandidate {
        seq,
        id: node.id.clone(),
        file: node.path.clone(),
        is_file_node: node.kind == "file",
        raw_lexical,
        lexical,
        graph,
        rank_factor,
        baseline_score,
        baseline_tie_key: format!("{} · {}", node.name, node.kind),
        matched_terms,
        matched_strong_terms,
        eligible: node.kind != "file" && raw_lexical > 0.0,
        span_start: span_range(&node.span).map_or(usize::MAX, |(s, _)| s),
    }
}

struct SymbolRankOutput {
    file_groups: Vec<(String, Vec<HitEntry>)>,
    baseline_entries: Vec<HitEntry>,
    raw_entries: Vec<HitEntry>,
    scope_meta: Option<AskScopes>,
}

struct SingleScopeSeeds {
    lex_by_seq: HashMap<usize, f64>,
    max_lex: f64,
    pr: HashMap<usize, f64>,
    cand_seqs: Vec<usize>,
}

fn single_scope_seeds_and_pr(
    store: &GraphStore,
    q_terms: &[String],
    stats: &CorpusStats,
    nodes_lite: &[NodeLite],
    graph_rank: bool,
    in_prefix: Option<&str>,
    query_wants_tests: bool,
) -> io::Result<SingleScopeSeeds> {
    let mut lex_by_seq: HashMap<usize, f64> = HashMap::new();
    let mut lex_ordered: Vec<(usize, f64)> = Vec::new();
    let mut max_lex = 0.0_f64;

    for n in nodes_lite {
        if let Some(prefix) = in_prefix
            && !path_under_prefix(&n.path, prefix)
        {
            continue;
        }
        let Some(bag) = stats.bags_by_seq.get(&n.seq) else {
            continue;
        };
        let factor = test_factor(&n.path, query_wants_tests);
        let total = (score_bag(q_terms, &bag.name, &stats.idf) * 3.0
            + score_bag(q_terms, &bag.path, &stats.idf) * 2.0
            + bm25(
                q_terms,
                &bag.body,
                &stats.idf,
                n.body_len,
                stats.avg_body_len,
            ))
            * factor;
        if total > 0.0 {
            lex_by_seq.insert(n.seq, total);
            lex_ordered.push((n.seq, total));
            max_lex = max_lex.max(total);
        }
    }

    let pr = if graph_rank && !lex_ordered.is_empty() {
        let allowed: Vec<bool> = nodes_lite
            .iter()
            .map(|n| in_prefix.is_none_or(|p| path_under_prefix(&n.path, p)))
            .collect();
        let edges = store.all_walk_edge_seqs()?;
        let topo = PageRankTopology::build(nodes_lite.len(), allowed, &edges);
        topo.run(&lex_ordered, DEFAULT_ALPHA, DEFAULT_ITERS)
    } else {
        HashMap::new()
    };

    let mut cand_seqs: Vec<usize> = lex_ordered.iter().map(|&(s, _)| s).collect();
    let mut seen: HashSet<usize> = cand_seqs.iter().copied().collect();
    let mut pr_rescues: Vec<usize> = pr
        .iter()
        .filter(|&(_, &p)| p >= RESCUE_FLOOR)
        .map(|(&s, _)| s)
        .collect();
    pr_rescues.sort_unstable();
    for s in pr_rescues {
        if seen.insert(s) {
            cand_seqs.push(s);
        }
    }
    Ok(SingleScopeSeeds {
        lex_by_seq,
        max_lex,
        pr,
        cand_seqs,
    })
}

#[allow(clippy::too_many_arguments)]
fn rank_single_scope(
    store: &GraphStore,
    q_terms: &[String],
    stats: &CorpusStats,
    nodes_lite: &[NodeLite],
    graph_rank: bool,
    in_prefix: Option<&str>,
    query_wants_tests: bool,
    file_first: bool,
    query_weights: &HashMap<String, f64>,
) -> io::Result<SymbolRankOutput> {
    let SingleScopeSeeds {
        lex_by_seq,
        max_lex,
        pr,
        cand_seqs,
    } = single_scope_seeds_and_pr(
        store,
        q_terms,
        stats,
        nodes_lite,
        graph_rank,
        in_prefix,
        query_wants_tests,
    )?;

    let nodes_map = store.nodes_by_seqs(&cand_seqs)?;
    let mut file_cands = Vec::new();
    let mut baseline_entries = Vec::new();

    for &seq in &cand_seqs {
        let Some(node) = nodes_map.get(&seq) else {
            continue;
        };
        let raw_lex = lex_by_seq.get(&seq).copied().unwrap_or(0.0);
        let lexical = if max_lex > 0.0 {
            raw_lex / max_lex
        } else {
            0.0
        };
        let graph_s = pr.get(&seq).copied().unwrap_or(0.0);
        let rf = test_factor(&node.path, query_wants_tests);
        let baseline = (lexical + GRAPH_WEIGHT * graph_s) * rf;
        if baseline <= 0.0 {
            continue;
        }
        let bag = stats.bags_by_seq.get(&seq);
        baseline_entries.push(make_symbol_hit(
            node,
            baseline,
            None,
            bag,
            q_terms,
            &stats.idf,
            stats.dflt_idf,
        ));
        if file_first {
            file_cands.push(build_file_candidate(
                seq, node, raw_lex, lexical, graph_s, rf, baseline, bag, q_terms,
            ));
        }
    }

    if !file_first {
        return Ok(SymbolRankOutput {
            file_groups: Vec::new(),
            baseline_entries: Vec::new(),
            raw_entries: baseline_entries,
            scope_meta: None,
        });
    }

    let ranked_files = rank_files_bounded(&file_cands, query_weights);
    let file_groups = materialize_single_groups(&ranked_files, &nodes_map, stats, q_terms);
    Ok(SymbolRankOutput {
        file_groups,
        baseline_entries,
        raw_entries: Vec::new(),
        scope_meta: None,
    })
}

fn materialize_single_groups(
    ranked_files: &[RankedFile],
    nodes_map: &HashMap<usize, NodeV1>,
    stats: &CorpusStats,
    q_terms: &[String],
) -> Vec<(String, Vec<HitEntry>)> {
    let mut groups = Vec::with_capacity(ranked_files.len());
    for rf in ranked_files {
        let mut q_hits = Vec::with_capacity(rf.queue.len());
        for (idx, member) in rf.queue.iter().enumerate() {
            let Some(node) = nodes_map.get(&member.seq) else {
                continue;
            };
            let sc = if idx == 0 {
                rf.score
            } else {
                member.baseline_score
            };
            q_hits.push(make_symbol_hit(
                node,
                sc,
                None,
                stats.bags_by_seq.get(&member.seq),
                q_terms,
                &stats.idf,
                stats.dflt_idf,
            ));
        }
        if !q_hits.is_empty() {
            groups.push((format!("file:{}", rf.file), q_hits));
        }
    }
    groups
}

struct MultiScopeLex {
    scope_names: Vec<String>,
    part_of: Vec<Option<usize>>,
    lex_by_scope: HashMap<usize, Vec<(usize, f64)>>,
    raw_lex_all: HashMap<usize, f64>,
    surviving: Vec<usize>,
    suppressed: Vec<ScopeMiss>,
    global_max_lex: f64,
}

fn score_scopes_for_multi(
    scopes: &[ScopeV1],
    q_terms: &[String],
    stats: &CorpusStats,
    nodes_lite: &[NodeLite],
    in_prefix: Option<&str>,
    query_wants_tests: bool,
) -> MultiScopeLex {
    let mut scope_names: Vec<String> = Vec::new();
    let mut scope_idx_map: HashMap<String, usize> = HashMap::new();
    let mut by_scope: Vec<Vec<usize>> = Vec::new();
    let mut part_of: Vec<Option<usize>> = vec![None; nodes_lite.len()];

    for n in nodes_lite {
        if let Some(prefix) = in_prefix
            && !path_under_prefix(&n.path, prefix)
        {
            continue;
        }
        let s = scope_of(&n.path, scopes).to_string();
        let idx = *scope_idx_map.entry(s.clone()).or_insert_with(|| {
            let i = scope_names.len();
            scope_names.push(s);
            by_scope.push(Vec::new());
            i
        });
        by_scope[idx].push(n.seq);
        part_of[n.seq] = Some(idx);
    }

    let mut scope_order: Vec<usize> = (0..scope_names.len()).collect();
    scope_order.sort_by(|&a, &b| scope_names[a].cmp(&scope_names[b]));

    let mut lex_by_scope: HashMap<usize, Vec<(usize, f64)>> = HashMap::new();
    let mut raw_lex_all: HashMap<usize, f64> = HashMap::new();
    let mut scope_best: HashMap<usize, (f64, String)> = HashMap::new();
    let mut has_id_match: HashMap<usize, bool> = HashMap::new();

    for &si in &scope_order {
        let mut lex_vec = Vec::new();
        let mut max_s = 0.0_f64;
        let mut best_id = String::new();
        let mut id_ok = false;
        for &seq in &by_scope[si] {
            let n = &nodes_lite[seq];
            let Some(bag) = stats.bags_by_seq.get(&seq) else {
                continue;
            };
            if !id_ok
                && q_terms
                    .iter()
                    .any(|t| has_term(&bag.name, t) || has_term(&bag.path, t))
            {
                id_ok = true;
            }
            let total = (score_bag(q_terms, &bag.name, &stats.idf) * 3.0
                + score_bag(q_terms, &bag.path, &stats.idf) * 2.0
                + bm25(
                    q_terms,
                    &bag.body,
                    &stats.idf,
                    n.body_len,
                    stats.avg_body_len,
                ))
                * test_factor(&n.path, query_wants_tests);
            if total > 0.0 {
                lex_vec.push((seq, total));
                raw_lex_all.insert(seq, total);
                if total > max_s || (total == max_s && n.id < best_id) {
                    max_s = total;
                    best_id = n.id.clone();
                }
            }
        }
        if max_s > 0.0 {
            lex_by_scope.insert(si, lex_vec);
            scope_best.insert(si, (max_s, best_id));
            has_id_match.insert(si, id_ok);
        }
    }

    let any_named = has_id_match.values().any(|&ok| ok);
    let mut suppressed = Vec::new();
    let mut surviving = Vec::new();
    for &si in &scope_order {
        if !lex_by_scope.contains_key(&si) {
            continue;
        }
        if any_named && !has_id_match.get(&si).copied().unwrap_or(false) {
            suppressed.push(ScopeMiss {
                scope: scope_names[si].clone(),
                best_id: scope_best[&si].1.clone(),
            });
        } else {
            surviving.push(si);
        }
    }

    let global_max_lex = surviving
        .iter()
        .map(|si| scope_best[si].0)
        .fold(0.0_f64, f64::max);

    MultiScopeLex {
        scope_names,
        part_of,
        lex_by_scope,
        raw_lex_all,
        surviving,
        suppressed,
        global_max_lex,
    }
}

fn collect_multi_scope_candidates(
    store: &GraphStore,
    ms: &MultiScopeLex,
    nodes_lite: &[NodeLite],
    graph_rank: bool,
    query_wants_tests: bool,
) -> io::Result<(Vec<ScopeRankCandidate>, Vec<usize>)> {
    let topos = if graph_rank && !ms.surviving.is_empty() {
        let edges = store.all_walk_edge_seqs()?;
        Some(PageRankTopology::build_partitions(
            &ms.part_of,
            ms.scope_names.len(),
            &edges,
        ))
    } else {
        None
    };

    let mut comp_cands = Vec::new();
    let mut cand_seqs = Vec::new();
    let mut seen_seq = HashSet::new();

    for &si in &ms.surviving {
        let seeds = &ms.lex_by_scope[&si];
        let pr = match &topos {
            Some(t) => t[si].run(seeds, DEFAULT_ALPHA, DEFAULT_ITERS),
            None => HashMap::new(),
        };
        let mut s_cands: Vec<usize> = seeds.iter().map(|&(s, _)| s).collect();
        let mut s_seen: HashSet<usize> = s_cands.iter().copied().collect();
        let mut rescues: Vec<usize> = pr
            .iter()
            .filter(|&(_, &p)| p >= RESCUE_FLOOR)
            .map(|(&s, _)| s)
            .collect();
        rescues.sort_unstable();
        for s in rescues {
            if s_seen.insert(s) {
                s_cands.push(s);
            }
        }
        for seq in s_cands {
            let n = &nodes_lite[seq];
            let lex_n = if ms.global_max_lex > 0.0 {
                ms.raw_lex_all.get(&seq).copied().unwrap_or(0.0) / ms.global_max_lex
            } else {
                0.0
            };
            let g_score = pr.get(&seq).copied().unwrap_or(0.0);
            let rf = test_factor(&n.path, query_wants_tests);
            let blended = (lex_n + GRAPH_WEIGHT * g_score) * rf;
            if blended > 0.0 {
                if seen_seq.insert(seq) {
                    cand_seqs.push(seq);
                }
                comp_cands.push(ScopeRankCandidate {
                    seq,
                    id: n.id.clone(),
                    scope: ms.scope_names[si].clone(),
                    score: blended,
                    lexical: lex_n,
                    graph: g_score,
                    rank_factor: rf,
                });
            }
        }
    }
    Ok((comp_cands, cand_seqs))
}

#[allow(clippy::too_many_arguments)]
fn rank_multi_scope(
    store: &GraphStore,
    scopes: &[ScopeV1],
    q_terms: &[String],
    stats: &CorpusStats,
    nodes_lite: &[NodeLite],
    graph_rank: bool,
    in_prefix: Option<&str>,
    query_wants_tests: bool,
    file_first: bool,
    query_weights: &HashMap<String, f64>,
) -> io::Result<SymbolRankOutput> {
    let ms = score_scopes_for_multi(
        scopes,
        q_terms,
        stats,
        nodes_lite,
        in_prefix,
        query_wants_tests,
    );
    let (comp_cands, cand_seqs) =
        collect_multi_scope_candidates(store, &ms, nodes_lite, graph_rank, query_wants_tests)?;
    let nodes_map = store.nodes_by_seqs(&cand_seqs)?;

    if !file_first {
        let docs: Vec<ScopedDoc> = comp_cands
            .iter()
            .map(|c| ScopedDoc {
                seq: c.seq,
                id: c.id.clone(),
                scope: c.scope.clone(),
                score: c.score,
            })
            .collect();
        let fused = combine_comparable_scopes(&docs);
        let raw_entries: Vec<HitEntry> = fused
            .ranked
            .iter()
            .filter_map(|r| {
                nodes_map.get(&r.seq).map(|n| {
                    make_symbol_hit(
                        n,
                        r.score,
                        Some(r.scope.clone()),
                        stats.bags_by_seq.get(&r.seq),
                        q_terms,
                        &stats.idf,
                        stats.dflt_idf,
                    )
                })
            })
            .collect();
        let scope_meta = build_scope_meta(&fused.federated, &ms.suppressed, &fused.also_matched);
        return Ok(SymbolRankOutput {
            file_groups: Vec::new(),
            baseline_entries: Vec::new(),
            raw_entries,
            scope_meta,
        });
    }

    Ok(collapse_multi_scope_files(
        &comp_cands,
        &ms,
        &nodes_map,
        stats,
        q_terms,
        query_weights,
    ))
}

fn materialize_multi_scope_groups(
    fusion: &crate::file_rank::FusionResult,
    file_by_rep: &HashMap<&str, &RankedFile>,
    comp_by_id: &HashMap<&str, &ScopeRankCandidate>,
    baseline_score_by_id: &HashMap<&str, f64>,
    nodes_map: &HashMap<usize, NodeV1>,
    stats: &CorpusStats,
    q_terms: &[String],
) -> Vec<(String, Vec<HitEntry>)> {
    let mut file_groups = Vec::new();
    for ranked in &fusion.ranked {
        let Some(&rf) = file_by_rep.get(ranked.id.as_str()) else {
            continue;
        };
        let mut q_hits = Vec::with_capacity(rf.queue.len());
        for (idx, member) in rf.queue.iter().enumerate() {
            let Some(node) = nodes_map.get(&member.seq) else {
                continue;
            };
            let sc = if idx == 0 {
                ranked.score
            } else {
                baseline_score_by_id
                    .get(member.id.as_str())
                    .copied()
                    .unwrap_or(member.baseline_score)
            };
            let scope = comp_by_id
                .get(member.id.as_str())
                .map_or_else(|| ranked.scope.clone(), |c| c.scope.clone());
            q_hits.push(make_symbol_hit(
                node,
                sc,
                Some(scope),
                stats.bags_by_seq.get(&member.seq),
                q_terms,
                &stats.idf,
                stats.dflt_idf,
            ));
        }
        if !q_hits.is_empty() {
            file_groups.push((format!("file:{}", rf.file), q_hits));
        }
    }
    file_groups
}

fn collapse_multi_scope_files(
    comp_cands: &[ScopeRankCandidate],
    ms: &MultiScopeLex,
    nodes_map: &HashMap<usize, NodeV1>,
    stats: &CorpusStats,
    q_terms: &[String],
    query_weights: &HashMap<String, f64>,
) -> SymbolRankOutput {
    let comp_by_id: HashMap<&str, &ScopeRankCandidate> =
        comp_cands.iter().map(|c| (c.id.as_str(), c)).collect();
    let file_cands: Vec<FileRankCandidate> = comp_cands
        .iter()
        .filter_map(|c| {
            let node = nodes_map.get(&c.seq)?;
            let raw_lex = ms.raw_lex_all.get(&c.seq).copied().unwrap_or(0.0);
            Some(build_file_candidate(
                c.seq,
                node,
                raw_lex,
                c.lexical,
                c.graph,
                c.rank_factor,
                c.score,
                stats.bags_by_seq.get(&c.seq),
                q_terms,
            ))
        })
        .collect();
    let ranked_files = rank_files_bounded(&file_cands, query_weights);
    let file_by_rep: HashMap<&str, &RankedFile> = ranked_files
        .iter()
        .map(|f| (f.representative.id.as_str(), f))
        .collect();
    let collapsed: Vec<ScopedDoc> = ranked_files
        .iter()
        .filter_map(|f| {
            let comp = comp_by_id.get(f.representative.id.as_str())?;
            Some(ScopedDoc {
                seq: f.representative.seq,
                id: f.representative.id.clone(),
                scope: comp.scope.clone(),
                score: f.score,
            })
        })
        .collect();
    let fusion = combine_comparable_scopes(&collapsed);

    let baseline_docs: Vec<ScopedDoc> = comp_cands
        .iter()
        .map(|c| ScopedDoc {
            seq: c.seq,
            id: c.id.clone(),
            scope: c.scope.clone(),
            score: c.score,
        })
        .collect();
    let baseline_fusion = combine_comparable_scopes(&baseline_docs);
    let baseline_score_by_id: HashMap<&str, f64> = baseline_fusion
        .ranked
        .iter()
        .map(|r| (r.id.as_str(), r.score))
        .collect();
    let baseline_entries: Vec<HitEntry> = baseline_fusion
        .ranked
        .iter()
        .filter_map(|r| {
            nodes_map.get(&r.seq).map(|n| {
                make_symbol_hit(
                    n,
                    r.score,
                    Some(r.scope.clone()),
                    stats.bags_by_seq.get(&r.seq),
                    q_terms,
                    &stats.idf,
                    stats.dflt_idf,
                )
            })
        })
        .collect();

    let file_groups = materialize_multi_scope_groups(
        &fusion,
        &file_by_rep,
        &comp_by_id,
        &baseline_score_by_id,
        nodes_map,
        stats,
        q_terms,
    );
    let scope_meta = build_scope_meta(&fusion.federated, &ms.suppressed, &fusion.also_matched);
    SymbolRankOutput {
        file_groups,
        baseline_entries,
        raw_entries: Vec::new(),
        scope_meta,
    }
}

fn build_scope_meta(
    federated: &[String],
    suppressed: &[ScopeMiss],
    also_from_gate: &[crate::file_rank::AlsoMatchedScope],
) -> Option<AskScopes> {
    let mut also_matched = suppressed.to_vec();
    for m in also_from_gate {
        also_matched.push(ScopeMiss {
            scope: m.scope.clone(),
            best_id: m.best_id.clone(),
        });
    }
    if federated.len() > 1 || !also_matched.is_empty() {
        Some(AskScopes {
            federated: federated.to_vec(),
            also_matched,
        })
    } else {
        None
    }
}

fn concept_only_stats(q_terms: &[String], concepts: &[ConceptDoc]) -> CorpusStats {
    let mut df = HashMap::new();
    for c in concepts {
        for t in q_terms {
            if c.name_bag.contains_key(t) || c.body_bag.contains_key(t) {
                *df.entry(t.clone()).or_insert(0) += 1;
            }
        }
    }
    let n_docs = concepts.len();
    let idf = df
        .into_iter()
        .map(|(t, d)| (t, (1.0 + (n_docs as f64) / (1.0 + (d as f64))).ln()))
        .collect();
    CorpusStats {
        idf,
        dflt_idf: (1.0 + (n_docs as f64)).ln(),
        avg_body_len: 0.0,
        bags_by_seq: HashMap::new(),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn run_lexical(
    query: &str,
    out_dir: &Path,
    store: Option<&GraphStore>,
    limit: usize,
    graph_rank: bool,
    in_prefix: Option<&str>,
    file_first: bool,
) -> io::Result<AskResult> {
    let q_terms = unique_terms_ordered(query);
    let query_wants_tests = wants_tests(query);
    let concepts = load_concepts(out_dir, in_prefix)?;

    let (scopes, nodes_lite) = match store {
        Some(s) => (s.scopes()?, s.all_nodes_lite()?),
        None => (Vec::new(), Vec::new()),
    };

    let stats = match store {
        Some(s) => build_corpus_stats(s, &q_terms, &concepts, &nodes_lite, in_prefix)?,
        None => concept_only_stats(&q_terms, &concepts),
    };

    let concept_entries = score_concepts(&q_terms, &concepts, &stats.idf, stats.dflt_idf);
    let query_weights = if file_first {
        normalized_query_weights(&q_terms, &stats.idf, stats.dflt_idf)
    } else {
        HashMap::new()
    };

    let sym_out = match store {
        Some(s) if scopes.len() > 1 => rank_multi_scope(
            s,
            &scopes,
            &q_terms,
            &stats,
            &nodes_lite,
            graph_rank,
            in_prefix,
            query_wants_tests,
            file_first,
            &query_weights,
        )?,
        Some(s) => rank_single_scope(
            s,
            &q_terms,
            &stats,
            &nodes_lite,
            graph_rank,
            in_prefix,
            query_wants_tests,
            file_first,
            &query_weights,
        )?,
        None => SymbolRankOutput {
            file_groups: Vec::new(),
            baseline_entries: Vec::new(),
            raw_entries: Vec::new(),
            scope_meta: None,
        },
    };

    let mut scope_meta = sym_out.scope_meta;
    let selected: Vec<HitEntry> = if file_first {
        project_file_first_top_locked(
            concept_entries,
            sym_out.file_groups,
            sym_out.baseline_entries,
            limit,
            &mut scope_meta,
        )
    } else {
        let mut all = concept_entries;
        all.extend(sym_out.raw_entries);
        all.sort_by(hit_entry_cmp);
        all.truncate(limit);
        all
    };

    let is_empty = selected.is_empty();
    let (coverage, coverage_strong) = if !is_empty && !q_terms.is_empty() {
        (
            Some(selected[0].coverage),
            Some(selected[0].coverage_strong),
        )
    } else {
        (None, None)
    };
    let note = is_empty.then(|| {
        format!(
            "no matching nodes — try different words, or `trail build` if the code map is empty{}",
            scopes_here_clause(&scopes)
        )
    });

    Ok(AskResult {
        query: query.to_string(),
        mode: if is_empty {
            AskMode::Empty
        } else {
            AskMode::Lexical
        },
        subject: None,
        hits: selected.into_iter().map(|e| e.hit).collect(),
        note,
        saved: None,
        coverage,
        coverage_strong,
        scopes: scope_meta,
    })
}

fn project_file_first_top_locked(
    concept_entries: Vec<HitEntry>,
    file_groups: Vec<(String, Vec<HitEntry>)>,
    baseline_sym_entries: Vec<HitEntry>,
    limit: usize,
    scope_meta: &mut Option<AskScopes>,
) -> Vec<HitEntry> {
    let mut baseline_all: Vec<HitEntry> =
        Vec::with_capacity(concept_entries.len() + baseline_sym_entries.len());
    for c in &concept_entries {
        baseline_all.push(HitEntry {
            hit: c.hit.clone(),
            group_key: c.group_key.clone(),
            coverage: c.coverage,
            coverage_strong: c.coverage_strong,
        });
    }
    baseline_all.extend(baseline_sym_entries);
    baseline_all.sort_by(hit_entry_cmp);

    let mut unlocked: Vec<(String, Vec<HitEntry>)> = concept_entries
        .into_iter()
        .map(|c| (c.group_key.clone(), vec![c]))
        .collect();
    unlocked.extend(file_groups);
    unlocked.sort_by(|a, b| hit_entry_cmp(&a.1[0], &b.1[0]));

    let projected: Vec<Vec<HitEntry>> = if let Some(baseline_top) = baseline_all.first() {
        let locked_key = baseline_top.group_key.clone();
        let mut locked_queue = vec![HitEntry {
            hit: baseline_top.hit.clone(),
            group_key: baseline_top.group_key.clone(),
            coverage: baseline_top.coverage,
            coverage_strong: baseline_top.coverage_strong,
        }];
        for b in baseline_all.iter().skip(1) {
            if b.group_key == locked_key && !same_hit(&b.hit, &baseline_top.hit) {
                locked_queue.push(HitEntry {
                    hit: b.hit.clone(),
                    group_key: b.group_key.clone(),
                    coverage: b.coverage,
                    coverage_strong: b.coverage_strong,
                });
            }
        }
        let mut queues = Vec::with_capacity(unlocked.len() + 1);
        queues.push(locked_queue);
        for (k, q) in unlocked {
            if k != locked_key {
                queues.push(q);
            }
        }
        queues
    } else {
        unlocked.into_iter().map(|(_, q)| q).collect()
    };

    let selected = if projected.is_empty() {
        let pairs: Vec<(String, HitEntry)> = baseline_all
            .into_iter()
            .map(|e| (e.group_key.clone(), e))
            .collect();
        file_first_round_robin(&pairs, limit)
    } else {
        round_robin_queues(&projected, limit)
    };

    if let Some(top) = selected.first()
        && let Some(top_scope) = &top.hit.scope
        && !top_scope.is_empty()
        && let Some(meta) = scope_meta.as_mut()
    {
        if !meta.federated.contains(top_scope) {
            meta.federated.insert(0, top_scope.clone());
        }
        meta.also_matched.retain(|m| &m.scope != top_scope);
    }
    selected
}

impl Clone for HitEntry {
    fn clone(&self) -> Self {
        Self {
            hit: self.hit.clone(),
            group_key: self.group_key.clone(),
            coverage: self.coverage,
            coverage_strong: self.coverage_strong,
        }
    }
}
