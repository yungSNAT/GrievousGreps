//! Lexical, BM25, PPR graph-rank, and bounded file ranking for `ask`.
//!
//! Mirrors `lexical()` in `src/ask/ask.ts`; term scoring lives in `scoring.rs`,
//! concept loading in `concepts.rs`, and multi-scope ranking in `multi_scope.rs`.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::Path;

use crate::ask::concepts::{load_concepts, score_concepts};
use crate::ask::multi_scope::rank_multi_scope;
use crate::ask::scoring::{
    CorpusStats, NodeBag, bm25, build_corpus_stats, concept_only_stats, has_term,
    matched_idf_share, normalized_query_weights, score_bag, test_factor, wants_tests,
};
use crate::ask::{AskHit, AskMode, AskResult, AskScopes};
use crate::file_rank::{
    FileRankCandidate, RankedFile, file_first_round_robin, rank_files_bounded, round_robin_queues,
};
use crate::graph::{NodeV1, js_locale_cmp, path_under_prefix, scopes_here_clause, span_range};
use crate::graphrank::{DEFAULT_ALPHA, DEFAULT_ITERS, PageRankTopology};
use crate::query_ask::NodeLite;
use crate::store::GraphStore;
use crate::tokenize::unique_terms_ordered;

pub(crate) const GRAPH_WEIGHT: f64 = 0.5;
pub(crate) const RESCUE_FLOOR: f64 = 0.15;

#[derive(Clone)]
pub(crate) struct HitEntry {
    pub(crate) hit: AskHit,
    pub(crate) group_key: String,
    pub(crate) coverage: f64,
    pub(crate) coverage_strong: f64,
}

pub(crate) struct SymbolRankOutput {
    pub(crate) file_groups: Vec<(String, Vec<HitEntry>)>,
    pub(crate) baseline_entries: Vec<HitEntry>,
    pub(crate) raw_entries: Vec<HitEntry>,
    pub(crate) scope_meta: Option<AskScopes>,
}

pub(crate) struct RankContext<'a> {
    pub(crate) store: &'a GraphStore,
    pub(crate) q_terms: &'a [String],
    pub(crate) stats: &'a CorpusStats,
    pub(crate) nodes_lite: &'a [NodeLite],
    pub(crate) graph_rank: bool,
    pub(crate) in_prefix: Option<&'a str>,
    pub(crate) query_wants_tests: bool,
    pub(crate) file_first: bool,
    pub(crate) query_weights: &'a HashMap<String, f64>,
}

pub(crate) struct CandidateInputs {
    pub(crate) seq: usize,
    pub(crate) raw_lexical: f64,
    pub(crate) lexical: f64,
    pub(crate) graph: f64,
    pub(crate) rank_factor: f64,
    pub(crate) baseline_score: f64,
}

pub(crate) fn make_symbol_hit(
    node: &NodeV1,
    score: f64,
    scope: Option<String>,
    bag: Option<&NodeBag>,
    q_terms: &[String],
    stats: &CorpusStats,
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
            let c = matched_idf_share(
                q_terms,
                &[&b.name, &b.path, &b.body],
                &stats.idf,
                stats.dflt_idf,
            );
            let s = if node.kind == "file" {
                0.0
            } else {
                matched_idf_share(q_terms, &[&b.name], &stats.idf, stats.dflt_idf)
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

pub(crate) fn build_file_candidate(
    node: &NodeV1,
    scores: &CandidateInputs,
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
        seq: scores.seq,
        id: node.id.clone(),
        file: node.path.clone(),
        is_file_node: node.kind == "file",
        raw_lexical: scores.raw_lexical,
        lexical: scores.lexical,
        graph: scores.graph,
        rank_factor: scores.rank_factor,
        baseline_score: scores.baseline_score,
        baseline_tie_key: format!("{} · {}", node.name, node.kind),
        matched_terms,
        matched_strong_terms,
        eligible: node.kind != "file" && scores.raw_lexical > 0.0,
        span_start: span_range(&node.span).map_or(usize::MAX, |(s, _)| s),
    }
}

struct SingleScopeSeeds {
    lex_by_seq: HashMap<usize, f64>,
    max_lex: f64,
    pr: HashMap<usize, f64>,
    cand_seqs: Vec<usize>,
}

fn single_scope_seeds_and_pr(ctx: &RankContext<'_>) -> io::Result<SingleScopeSeeds> {
    let mut lex_by_seq: HashMap<usize, f64> = HashMap::new();
    let mut lex_ordered: Vec<(usize, f64)> = Vec::new();
    let mut max_lex = 0.0_f64;

    for n in ctx.nodes_lite {
        if let Some(prefix) = ctx.in_prefix
            && !path_under_prefix(&n.path, prefix)
        {
            continue;
        }
        let Some(bag) = ctx.stats.bags_by_seq.get(&n.seq) else {
            continue;
        };
        let factor = test_factor(&n.path, ctx.query_wants_tests);
        let total = (score_bag(ctx.q_terms, &bag.name, &ctx.stats.idf) * 3.0
            + score_bag(ctx.q_terms, &bag.path, &ctx.stats.idf) * 2.0
            + bm25(
                ctx.q_terms,
                &bag.body,
                &ctx.stats.idf,
                n.body_len,
                ctx.stats.avg_body_len,
            ))
            * factor;
        if total > 0.0 {
            lex_by_seq.insert(n.seq, total);
            lex_ordered.push((n.seq, total));
            max_lex = max_lex.max(total);
        }
    }

    let pr = if ctx.graph_rank && !lex_ordered.is_empty() {
        let allowed: Vec<bool> = ctx
            .nodes_lite
            .iter()
            .map(|n| ctx.in_prefix.is_none_or(|p| path_under_prefix(&n.path, p)))
            .collect();
        let edges = ctx.store.all_walk_edge_seqs()?;
        let topo = PageRankTopology::build(ctx.nodes_lite.len(), allowed, &edges);
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
                stats,
            ));
        }
        if !q_hits.is_empty() {
            groups.push((format!("file:{}", rf.file), q_hits));
        }
    }
    groups
}

fn rank_single_scope(ctx: &RankContext<'_>) -> io::Result<SymbolRankOutput> {
    let seeds = single_scope_seeds_and_pr(ctx)?;
    let nodes_map = ctx.store.nodes_by_seqs(&seeds.cand_seqs)?;
    let mut file_cands = Vec::new();
    let mut baseline_entries = Vec::new();

    for &seq in &seeds.cand_seqs {
        let Some(node) = nodes_map.get(&seq) else {
            continue;
        };
        let raw_lex = seeds.lex_by_seq.get(&seq).copied().unwrap_or(0.0);
        let lexical = if seeds.max_lex > 0.0 {
            raw_lex / seeds.max_lex
        } else {
            0.0
        };
        let graph_s = seeds.pr.get(&seq).copied().unwrap_or(0.0);
        let rf = test_factor(&node.path, ctx.query_wants_tests);
        let baseline = (lexical + GRAPH_WEIGHT * graph_s) * rf;
        if baseline <= 0.0 {
            continue;
        }
        let bag = ctx.stats.bags_by_seq.get(&seq);
        baseline_entries.push(make_symbol_hit(
            node,
            baseline,
            None,
            bag,
            ctx.q_terms,
            ctx.stats,
        ));
        if ctx.file_first {
            let inputs = CandidateInputs {
                seq,
                raw_lexical: raw_lex,
                lexical,
                graph: graph_s,
                rank_factor: rf,
                baseline_score: baseline,
            };
            file_cands.push(build_file_candidate(node, &inputs, bag, ctx.q_terms));
        }
    }

    if !ctx.file_first {
        return Ok(SymbolRankOutput {
            file_groups: Vec::new(),
            baseline_entries: Vec::new(),
            raw_entries: baseline_entries,
            scope_meta: None,
        });
    }

    let ranked_files = rank_files_bounded(&file_cands, ctx.query_weights);
    let file_groups = materialize_single_groups(&ranked_files, &nodes_map, ctx.stats, ctx.q_terms);
    Ok(SymbolRankOutput {
        file_groups,
        baseline_entries,
        raw_entries: Vec::new(),
        scope_meta: None,
    })
}

fn project_file_first_top_locked(
    concept_entries: Vec<HitEntry>,
    file_groups: Vec<(String, Vec<HitEntry>)>,
    baseline_sym_entries: Vec<HitEntry>,
    limit: usize,
    scope_meta: &mut Option<AskScopes>,
) -> Vec<HitEntry> {
    let mut baseline_all = concept_entries.clone();
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
        let mut locked_queue = vec![baseline_top.clone()];
        for b in baseline_all.iter().skip(1) {
            if b.group_key == locked_key && !same_hit(&b.hit, &baseline_top.hit) {
                locked_queue.push(b.clone());
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
        Some(s) => {
            let ctx = RankContext {
                store: s,
                q_terms: &q_terms,
                stats: &stats,
                nodes_lite: &nodes_lite,
                graph_rank,
                in_prefix,
                query_wants_tests,
                file_first,
                query_weights: &query_weights,
            };
            if scopes.len() > 1 {
                rank_multi_scope(&ctx, &scopes)?
            } else {
                rank_single_scope(&ctx)?
            }
        }
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
