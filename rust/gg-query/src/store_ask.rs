//! Inverted-index population for `ask_postings` and `ask_df` inside `wiring.sqlite`.

use std::collections::{HashMap, HashSet};
use std::io;

use rusqlite::{Transaction, params};

use crate::graph::NodeV1;
use crate::store::sql_err;
use crate::tokenize::{AskIndex, AskIndexDoc, counts, tokenize};

fn usable_ask_index<'a>(
    idx: &'a Option<AskIndex>,
    nodes: &[NodeV1],
) -> Option<(&'a AskIndex, HashMap<&'a str, &'a AskIndexDoc>)> {
    let idx = idx.as_ref()?;
    if idx.docs.len() != nodes.len() {
        return None;
    }
    let map: HashMap<&str, &AskIndexDoc> = idx.docs.iter().map(|d| (d.id.as_str(), d)).collect();
    if nodes.iter().all(|n| map.contains_key(n.id.as_str())) {
        Some((idx, map))
    } else {
        None
    }
}

fn merge_bag_fields(
    name: &[(String, usize)],
    path: &[(String, usize)],
    body: &[(String, usize)],
) -> HashMap<String, (usize, usize, usize)> {
    let mut merged: HashMap<String, (usize, usize, usize)> = HashMap::new();
    for (t, c) in name {
        merged.entry(t.clone()).or_default().0 += *c;
    }
    for (t, c) in path {
        merged.entry(t.clone()).or_default().1 += *c;
    }
    for (t, c) in body {
        merged.entry(t.clone()).or_default().2 += *c;
    }
    merged
}

pub(crate) fn insert_ask_index(
    tx: &Transaction<'_>,
    nodes: &[NodeV1],
    ask_idx: &Option<AskIndex>,
) -> io::Result<(Vec<usize>, usize, f64)> {
    let mut posting_stmt = tx
        .prepare(
            "INSERT INTO ask_postings (token, node_seq, name_tf, path_tf, body_tf)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .map_err(sql_err)?;
    let mut df_stmt = tx
        .prepare("INSERT INTO ask_df (token, df) VALUES (?1, ?2)")
        .map_err(sql_err)?;

    let mut body_lens = Vec::with_capacity(nodes.len());
    if let Some((idx, by_id)) = usable_ask_index(ask_idx, nodes) {
        for (seq, n) in nodes.iter().enumerate() {
            let d = by_id[n.id.as_str()];
            let blen: usize = d.body.iter().map(|(_, c)| *c).sum();
            body_lens.push(blen);
            let merged = merge_bag_fields(&d.name, &d.path, &d.body);
            for (tok, (ntf, ptf, btf)) in merged {
                posting_stmt
                    .execute(params![tok, seq as i64, ntf as i64, ptf as i64, btf as i64])
                    .map_err(sql_err)?;
            }
        }
        for (tok, df) in &idx.df {
            df_stmt.execute(params![tok, *df as i64]).map_err(sql_err)?;
        }
        return Ok((body_lens, idx.doc_count, idx.avg_body_len));
    }

    let mut df_map: HashMap<String, usize> = HashMap::new();
    let mut total_body_len = 0_usize;
    for (seq, n) in nodes.iter().enumerate() {
        let name_c = counts(&tokenize(&n.name));
        let path_c = counts(&tokenize(&n.path));
        let body_src = format!(
            "{} {} {}",
            n.signature.as_deref().unwrap_or(""),
            n.summary.as_deref().unwrap_or(""),
            n.body_text.as_deref().unwrap_or("")
        );
        let body_c = counts(&tokenize(&body_src));
        let blen: usize = body_c.values().sum();
        body_lens.push(blen);
        total_body_len += blen;

        let mut doc_terms: HashSet<&str> = HashSet::new();
        let mut merged: HashMap<&str, (usize, usize, usize)> = HashMap::new();
        for (t, &c) in &name_c {
            doc_terms.insert(t.as_str());
            merged.entry(t.as_str()).or_default().0 = c;
        }
        for (t, &c) in &path_c {
            doc_terms.insert(t.as_str());
            merged.entry(t.as_str()).or_default().1 = c;
        }
        for (t, &c) in &body_c {
            doc_terms.insert(t.as_str());
            merged.entry(t.as_str()).or_default().2 = c;
        }
        for (tok, (ntf, ptf, btf)) in merged {
            posting_stmt
                .execute(params![tok, seq as i64, ntf as i64, ptf as i64, btf as i64])
                .map_err(sql_err)?;
        }
        for tok in doc_terms {
            *df_map.entry(tok.to_string()).or_insert(0) += 1;
        }
    }
    for (tok, df) in df_map {
        df_stmt.execute(params![tok, df as i64]).map_err(sql_err)?;
    }
    let avg_body_len = if nodes.is_empty() {
        0.0
    } else {
        total_body_len as f64 / nodes.len() as f64
    };
    Ok((body_lens, nodes.len(), avg_body_len))
}
