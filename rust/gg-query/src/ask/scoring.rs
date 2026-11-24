//! Term scoring, BM25, IDF coverage, and corpus statistics for lexical `ask`.

use std::collections::{HashMap, HashSet};
use std::io;

use crate::ask::concepts::ConceptDoc;
use crate::graph::{is_test_path, path_under_prefix};
use crate::query_ask::{NodeLite, PostingRow};
use crate::store::GraphStore;

const TEST_RANK_PENALTY: f64 = 0.35;

#[derive(Default)]
pub(crate) struct NodeBag {
    pub(crate) name: HashMap<String, usize>,
    pub(crate) path: HashMap<String, usize>,
    pub(crate) body: HashMap<String, usize>,
}

pub(crate) struct CorpusStats {
    pub(crate) idf: HashMap<String, f64>,
    pub(crate) dflt_idf: f64,
    pub(crate) avg_body_len: f64,
    pub(crate) bags_by_seq: HashMap<usize, NodeBag>,
}

pub(crate) fn wants_tests(query: &str) -> bool {
    let lower = query.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            if matches!(
                &lower[start..i],
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

pub(crate) fn test_factor(path: &str, query_wants_tests: bool) -> f64 {
    if !query_wants_tests && is_test_path(path) {
        TEST_RANK_PENALTY
    } else {
        1.0
    }
}

pub(crate) fn has_term(bag: &HashMap<String, usize>, term: &str) -> bool {
    if bag.contains_key(term) {
        return true;
    }
    if bag.contains_key(&format!("{term}s")) {
        return true;
    }
    term.strip_suffix('s')
        .is_some_and(|singular| bag.contains_key(singular))
}

pub(crate) fn score_bag(
    q_terms: &[String],
    bag: &HashMap<String, usize>,
    idf: &HashMap<String, f64>,
) -> f64 {
    let mut s = 0.0;
    for t in q_terms {
        if let Some(&dn) = bag.get(t) {
            s += (dn as f64) * idf.get(t).copied().unwrap_or(1.0);
        }
    }
    s
}

pub(crate) fn bm25(
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

pub(crate) fn matched_idf_share(
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

pub(crate) fn normalized_query_weights(
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

pub(crate) fn build_corpus_stats(
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
        store.ask_postings_for_terms(&looked)?
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
            bag.name.insert(p.term.clone(), p.name_tf);
        }
        if p.path_tf > 0 {
            bag.path.insert(p.term.clone(), p.path_tf);
        }
        if p.body_tf > 0 {
            bag.body.insert(p.term, p.body_tf);
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
            store.ask_df_for_terms(q_terms)?
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

    let idf = df_map
        .into_iter()
        .map(|(t, d)| (t, (1.0 + (n_docs as f64) / (1.0 + (d as f64))).ln()))
        .collect();
    let dflt_idf = (1.0 + (n_docs as f64)).ln();
    Ok(CorpusStats {
        idf,
        dflt_idf,
        avg_body_len,
        bags_by_seq,
    })
}

pub(crate) fn concept_only_stats(q_terms: &[String], concepts: &[ConceptDoc]) -> CorpusStats {
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
