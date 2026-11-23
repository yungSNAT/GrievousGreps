//! Multi-scope comparable ranking, body-only suppression, and bounded file collapse for `ask`.
//!
//! Mirrors the multi-scope branch of `lexical()` in `src/ask/ask.ts` and `rankScopesAndFuse()`
//! in `src/ask/fuse.ts`.

use std::collections::{HashMap, HashSet};
use std::io;

use crate::ask::lexical::{
    CandidateInputs, GRAPH_WEIGHT, HitEntry, RESCUE_FLOOR, RankContext, SymbolRankOutput,
    build_file_candidate, make_symbol_hit,
};
use crate::ask::scoring::{bm25, has_term, score_bag, test_factor};
use crate::ask::{AskScopes, ScopeMiss};
use crate::file_rank::{
    AlsoMatchedScope, FileRankCandidate, FusionResult, RankedFile, ScopeRankCandidate, ScopedDoc,
    combine_comparable_scopes, rank_files_bounded,
};
use crate::graph::{NodeV1, ScopeV1, path_under_prefix, scope_of};
use crate::graphrank::{DEFAULT_ALPHA, DEFAULT_ITERS, PageRankTopology};

struct MultiScopeLex {
    scope_names: Vec<String>,
    part_of: Vec<Option<usize>>,
    lex_by_scope: HashMap<usize, Vec<(usize, f64)>>,
    raw_lex_all: HashMap<usize, f64>,
    surviving: Vec<usize>,
    suppressed: Vec<ScopeMiss>,
    global_max_lex: f64,
}

fn score_scopes_for_multi(ctx: &RankContext<'_>, scopes: &[ScopeV1]) -> MultiScopeLex {
    let mut scope_names: Vec<String> = Vec::new();
    let mut scope_idx_map: HashMap<String, usize> = HashMap::new();
    let mut by_scope: Vec<Vec<usize>> = Vec::new();
    let mut part_of: Vec<Option<usize>> = vec![None; ctx.nodes_lite.len()];

    for n in ctx.nodes_lite {
        if let Some(prefix) = ctx.in_prefix
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
            let n = &ctx.nodes_lite[seq];
            let Some(bag) = ctx.stats.bags_by_seq.get(&seq) else {
                continue;
            };
            if !id_ok
                && ctx
                    .q_terms
                    .iter()
                    .any(|t| has_term(&bag.name, t) || has_term(&bag.path, t))
            {
                id_ok = true;
            }
            let total = (score_bag(ctx.q_terms, &bag.name, &ctx.stats.idf) * 3.0
                + score_bag(ctx.q_terms, &bag.path, &ctx.stats.idf) * 2.0
                + bm25(
                    ctx.q_terms,
                    &bag.body,
                    &ctx.stats.idf,
                    n.body_len,
                    ctx.stats.avg_body_len,
                ))
                * test_factor(&n.path, ctx.query_wants_tests);
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
    ctx: &RankContext<'_>,
    ms: &MultiScopeLex,
) -> io::Result<(Vec<ScopeRankCandidate>, Vec<usize>)> {
    let topos = if ctx.graph_rank && !ms.surviving.is_empty() {
        let edges = ctx.store.all_walk_edge_seqs()?;
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
            let n = &ctx.nodes_lite[seq];
            let lex_n = if ms.global_max_lex > 0.0 {
                ms.raw_lex_all.get(&seq).copied().unwrap_or(0.0) / ms.global_max_lex
            } else {
                0.0
            };
            let g_score = pr.get(&seq).copied().unwrap_or(0.0);
            let rf = test_factor(&n.path, ctx.query_wants_tests);
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

fn build_scope_meta(
    federated: &[String],
    suppressed: &[ScopeMiss],
    also_from_gate: &[AlsoMatchedScope],
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

fn materialize_multi_scope_groups(
    ctx: &RankContext<'_>,
    fusion: &FusionResult,
    file_by_rep: &HashMap<&str, &RankedFile>,
    comp_by_id: &HashMap<&str, &ScopeRankCandidate>,
    baseline_score_by_id: &HashMap<&str, f64>,
    nodes_map: &HashMap<usize, NodeV1>,
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
                ctx.stats.bags_by_seq.get(&member.seq),
                ctx.q_terms,
                ctx.stats,
            ));
        }
        if !q_hits.is_empty() {
            file_groups.push((format!("file:{}", rf.file), q_hits));
        }
    }
    file_groups
}

fn collapse_multi_scope_files(
    ctx: &RankContext<'_>,
    comp_cands: &[ScopeRankCandidate],
    ms: &MultiScopeLex,
    nodes_map: &HashMap<usize, NodeV1>,
) -> SymbolRankOutput {
    let comp_by_id: HashMap<&str, &ScopeRankCandidate> =
        comp_cands.iter().map(|c| (c.id.as_str(), c)).collect();
    let file_cands: Vec<FileRankCandidate> = comp_cands
        .iter()
        .filter_map(|c| {
            let node = nodes_map.get(&c.seq)?;
            let scores = CandidateInputs {
                seq: c.seq,
                raw_lexical: ms.raw_lex_all.get(&c.seq).copied().unwrap_or(0.0),
                lexical: c.lexical,
                graph: c.graph,
                rank_factor: c.rank_factor,
                baseline_score: c.score,
            };
            Some(build_file_candidate(
                node,
                &scores,
                ctx.stats.bags_by_seq.get(&c.seq),
                ctx.q_terms,
            ))
        })
        .collect();
    let ranked_files = rank_files_bounded(&file_cands, ctx.query_weights);
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
                    ctx.stats.bags_by_seq.get(&r.seq),
                    ctx.q_terms,
                    ctx.stats,
                )
            })
        })
        .collect();

    let file_groups = materialize_multi_scope_groups(
        ctx,
        &fusion,
        &file_by_rep,
        &comp_by_id,
        &baseline_score_by_id,
        nodes_map,
    );
    let scope_meta = build_scope_meta(&fusion.federated, &ms.suppressed, &fusion.also_matched);
    SymbolRankOutput {
        file_groups,
        baseline_entries,
        raw_entries: Vec::new(),
        scope_meta,
    }
}

pub(crate) fn rank_multi_scope(
    ctx: &RankContext<'_>,
    scopes: &[ScopeV1],
) -> io::Result<SymbolRankOutput> {
    let ms = score_scopes_for_multi(ctx, scopes);
    let (comp_cands, cand_seqs) = collect_multi_scope_candidates(ctx, &ms)?;
    let nodes_map = ctx.store.nodes_by_seqs(&cand_seqs)?;

    if !ctx.file_first {
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
                        ctx.stats.bags_by_seq.get(&r.seq),
                        ctx.q_terms,
                        ctx.stats,
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
        ctx,
        &comp_cands,
        &ms,
        &nodes_map,
    ))
}
