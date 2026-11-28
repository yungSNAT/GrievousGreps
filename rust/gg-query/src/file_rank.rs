//! Pure bounded file ranking, file-first round-robin selection, and comparable-scope fusion.
//!
//! Mirrors `src/ask/file-rank.ts`, `src/ask/file-selection.ts`, and `src/ask/fuse.ts`.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use crate::graph::js_locale_cmp;

pub const PARTICIPATION_RATIO: f64 = 0.25;

#[derive(Debug, Clone)]
pub struct FileRankCandidate {
    pub seq: usize,
    pub id: String,
    pub file: String,
    pub is_file_node: bool,
    pub raw_lexical: f64,
    pub lexical: f64,
    pub graph: f64,
    pub rank_factor: f64,
    pub baseline_score: f64,
    pub baseline_tie_key: String,
    pub matched_terms: Vec<String>,
    pub matched_strong_terms: Vec<String>,
    pub eligible: bool,
    pub span_start: usize,
}

#[derive(Debug, Clone)]
pub struct RankedFile {
    pub file: String,
    pub representative: FileRankCandidate,
    pub queue: Vec<FileRankCandidate>,
    pub union_coverage: f64,
    pub union_strong_coverage: f64,
    pub score: f64,
}

fn finite_positive(v: f64) -> bool {
    v.is_finite() && v > 0.0
}

fn clamp01(v: f64) -> f64 {
    if !v.is_finite() || v <= 0.0 {
        0.0
    } else {
        v.min(1.0)
    }
}

fn candidate_coverage(terms: &[String], query_weights: &HashMap<String, f64>) -> f64 {
    let mut share = 0.0;
    for t in terms {
        if let Some(&w) = query_weights.get(t)
            && finite_positive(w)
        {
            share += w;
        }
    }
    clamp01(share)
}

fn baseline_order(a: &FileRankCandidate, b: &FileRankCandidate) -> Ordering {
    b.baseline_score
        .total_cmp(&a.baseline_score)
        .then_with(|| js_locale_cmp(&a.baseline_tie_key, &b.baseline_tie_key))
        .then_with(|| b.raw_lexical.total_cmp(&a.raw_lexical))
        .then_with(|| a.span_start.cmp(&b.span_start))
        .then_with(|| js_locale_cmp(&a.id, &b.id))
}

fn lexical_anchor_order(
    a: &FileRankCandidate,
    b: &FileRankCandidate,
    query_weights: &HashMap<String, f64>,
) -> Ordering {
    b.raw_lexical
        .total_cmp(&a.raw_lexical)
        .then_with(|| {
            candidate_coverage(&b.matched_terms, query_weights)
                .total_cmp(&candidate_coverage(&a.matched_terms, query_weights))
        })
        .then_with(|| a.span_start.cmp(&b.span_start))
        .then_with(|| js_locale_cmp(&a.id, &b.id))
}

/// Bounded file ranking mirroring `src/ask/file-rank.ts::rankFilesBounded`.
pub fn rank_files_bounded(
    candidates: &[FileRankCandidate],
    query_weights: &HashMap<String, f64>,
) -> Vec<RankedFile> {
    let mut groups: HashMap<&str, Vec<FileRankCandidate>> = HashMap::new();
    let mut file_order: Vec<&str> = Vec::new();
    for c in candidates {
        if c.file.is_empty() || !finite_positive(c.baseline_score) {
            continue;
        }
        let entry = groups.entry(c.file.as_str()).or_insert_with(|| {
            file_order.push(c.file.as_str());
            Vec::new()
        });
        entry.push(c.clone());
    }

    let mut ranked = Vec::with_capacity(file_order.len());
    for file in file_order {
        let members = groups.remove(file).unwrap_or_default();
        let mut donors: Vec<&FileRankCandidate> = members
            .iter()
            .filter(|c| {
                !c.is_file_node
                    && c.eligible
                    && finite_positive(c.raw_lexical)
                    && finite_positive(c.lexical)
            })
            .collect();
        donors.sort_by(|a, b| lexical_anchor_order(a, b, query_weights));
        let anchor = donors.first().copied();

        let (union_cov, union_strong_cov, pooled_lex) =
            compute_pooled_lexical(&donors, anchor, query_weights);

        let mut ordered = members.clone();
        ordered.sort_by(baseline_order);
        let baseline_rep = ordered[0].clone();
        let pooled_score = anchor.map_or(0.0, |a| {
            clamp01(a.rank_factor) * (pooled_lex + 0.5 * clamp01(a.graph))
        });

        let pooled_wins = anchor.is_some() && pooled_score > baseline_rep.baseline_score;
        let representative = if pooled_wins {
            anchor.unwrap().clone()
        } else {
            baseline_rep
        };
        let score = if pooled_wins {
            pooled_score
        } else {
            representative.baseline_score
        };

        let mut queue = Vec::with_capacity(ordered.len());
        queue.push(representative.clone());
        for m in ordered {
            if m.id != representative.id {
                queue.push(m);
            }
        }
        ranked.push(RankedFile {
            file: file.to_string(),
            representative,
            queue,
            union_coverage: union_cov,
            union_strong_coverage: union_strong_cov,
            score,
        });
    }

    ranked.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| baseline_order(&a.representative, &b.representative))
            .then_with(|| js_locale_cmp(&a.file, &b.file))
    });
    ranked
}

fn compute_pooled_lexical(
    donors: &[&FileRankCandidate],
    anchor: Option<&FileRankCandidate>,
    query_weights: &HashMap<String, f64>,
) -> (f64, f64, f64) {
    let Some(anchor) = anchor else {
        return (0.0, 0.0, 0.0);
    };
    let mut union_seen = HashSet::new();
    let mut union_cov = 0.0;
    for d in donors {
        for t in &d.matched_terms {
            if union_seen.insert(t.as_str())
                && let Some(&w) = query_weights.get(t)
                && finite_positive(w)
            {
                union_cov += w;
            }
        }
    }
    union_cov = clamp01(union_cov);

    let mut strong_seen = HashSet::new();
    let mut union_strong_cov = 0.0;
    for d in donors {
        for t in &d.matched_strong_terms {
            if strong_seen.insert(t.as_str())
                && let Some(&w) = query_weights.get(t)
                && finite_positive(w)
            {
                union_strong_cov += w;
            }
        }
    }
    union_strong_cov = clamp01(union_strong_cov);

    let anchor_cov = candidate_coverage(&anchor.matched_terms, query_weights);
    let bounded_residual = if union_cov > 0.0 {
        clamp01(anchor_cov * (union_cov - anchor_cov).max(0.0) / union_cov)
    } else {
        0.0
    };
    let pooled_lex = clamp01(anchor.lexical + (1.0 - clamp01(anchor.lexical)) * bounded_residual);
    (union_cov, union_strong_cov, pooled_lex)
}

/// Round-robin projection over already-grouped queues.
pub fn round_robin_queues<T: Clone>(queues: &[Vec<T>], limit: usize) -> Vec<T> {
    if limit == 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut depth = 0_usize;
    while out.len() < limit {
        let mut added = false;
        for q in queues {
            if depth < q.len() {
                out.push(q[depth].clone());
                added = true;
                if out.len() >= limit {
                    break;
                }
            }
        }
        if !added {
            break;
        }
        depth += 1;
    }
    out
}

/// File-first round-robin projection preserving first-occurrence group order.
pub fn file_first_round_robin<T: Clone>(ranked: &[(String, T)], limit: usize) -> Vec<T> {
    if limit == 0 {
        return Vec::new();
    }
    let mut order: Vec<String> = Vec::new();
    let mut grouped: HashMap<String, Vec<T>> = HashMap::new();
    for (g, v) in ranked {
        let entry = grouped.entry(g.clone()).or_insert_with(|| {
            order.push(g.clone());
            Vec::new()
        });
        entry.push(v.clone());
    }
    let queues: Vec<Vec<T>> = order
        .into_iter()
        .filter_map(|g| grouped.remove(&g))
        .collect();
    round_robin_queues(&queues, limit)
}

#[derive(Debug, Clone)]
pub struct ScopedDoc {
    pub seq: usize,
    pub id: String,
    pub scope: String,
    pub score: f64,
}

#[derive(Debug, Clone)]
pub struct ScopeRankCandidate {
    pub seq: usize,
    pub id: String,
    pub scope: String,
    pub score: f64,
    pub lexical: f64,
    pub graph: f64,
    pub rank_factor: f64,
}

#[derive(Debug, Clone)]
pub struct AlsoMatchedScope {
    pub scope: String,
    pub best_id: String,
}

#[derive(Debug, Clone)]
pub struct FusionResult {
    pub ranked: Vec<ScopedDoc>,
    pub federated: Vec<String>,
    pub also_matched: Vec<AlsoMatchedScope>,
}

fn by_scoped_score(a: &ScopedDoc, b: &ScopedDoc) -> Ordering {
    b.score
        .total_cmp(&a.score)
        .then_with(|| js_locale_cmp(&a.id, &b.id))
}

/// Combine scopes whose scores share corpus statistics and normalization denominator.
pub fn combine_comparable_scopes(docs: &[ScopedDoc]) -> FusionResult {
    let mut by_scope: HashMap<String, Vec<ScopedDoc>> = HashMap::new();
    for d in docs {
        if d.score <= 0.0 {
            continue;
        }
        by_scope.entry(d.scope.clone()).or_default().push(d.clone());
    }
    for list in by_scope.values_mut() {
        list.sort_by(by_scoped_score);
    }
    if by_scope.is_empty() {
        return FusionResult {
            ranked: Vec::new(),
            federated: Vec::new(),
            also_matched: Vec::new(),
        };
    }
    if by_scope.len() == 1 {
        let (scope, list) = by_scope.into_iter().next().unwrap();
        return FusionResult {
            ranked: list,
            federated: vec![scope],
            also_matched: Vec::new(),
        };
    }

    let mut scopes_by_best: Vec<(String, Vec<ScopedDoc>)> = by_scope.into_iter().collect();
    scopes_by_best.sort_by(|a, b| {
        b.1[0]
            .score
            .total_cmp(&a.1[0].score)
            .then_with(|| js_locale_cmp(&a.0, &b.0))
    });
    let gate = PARTICIPATION_RATIO * scopes_by_best[0].1[0].score;
    let mut federated = Vec::new();
    let mut also_matched = Vec::new();
    let mut acc: HashMap<String, ScopedDoc> = HashMap::new();

    for (scope, list) in scopes_by_best {
        if list[0].score >= gate {
            federated.push(scope);
            for d in list {
                match acc.get(&d.id) {
                    Some(prev) if prev.score >= d.score => {}
                    _ => {
                        acc.insert(d.id.clone(), d);
                    }
                }
            }
        } else {
            also_matched.push(AlsoMatchedScope {
                scope,
                best_id: list[0].id.clone(),
            });
        }
    }

    let max_score = acc.values().map(|d| d.score).fold(0.0_f64, f64::max);
    let mut ranked: Vec<ScopedDoc> = acc
        .into_values()
        .map(|mut d| {
            d.score /= max_score;
            d
        })
        .collect();
    ranked.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| js_locale_cmp(&a.scope, &b.scope))
            .then_with(|| js_locale_cmp(&a.id, &b.id))
    });
    FusionResult {
        ranked,
        federated,
        also_matched,
    }
}
