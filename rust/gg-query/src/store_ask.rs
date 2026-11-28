//! Inverted-index population for `ask_postings` and `ask_df` inside `wiring.sqlite`.

use std::collections::{HashMap, HashSet};
use std::io;

use rusqlite::{Transaction, params};

use crate::graph::NodeV1;
use crate::store::sql_err;
use crate::tokenize::{AskIndex, AskIndexDoc, counts, is_valid_ask_index, tokenize};

fn to_sqlite_i64(val: usize, label: &str) -> io::Result<i64> {
    i64::try_from(val).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("ask index: {label} value {val} exceeds i64::MAX"),
        )
    })
}

fn checked_add_body_len(total: usize, blen: usize) -> io::Result<usize> {
    total.checked_add(blen).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "ask index: aggregate body length overflow",
        )
    })
}

type PostingCounts<'a> = HashMap<&'a str, (i64, i64, i64)>;
type DocPostings<'a> = Vec<(&'a str, i64, i64, i64)>;

fn checked_merge_bag_fields<'a>(doc: &'a AskIndexDoc) -> Option<(usize, PostingCounts<'a>)> {
    let mut blen = 0_usize;
    let mut merged: HashMap<&'a str, (i64, i64, i64)> = HashMap::new();
    for (t, c) in &doc.name {
        let c_i64 = i64::try_from(*c).ok().filter(|&v| v > 0)?;
        let slot = &mut merged.entry(t.as_str()).or_default().0;
        *slot = slot.checked_add(c_i64)?;
    }
    for (t, c) in &doc.path {
        let c_i64 = i64::try_from(*c).ok().filter(|&v| v > 0)?;
        let slot = &mut merged.entry(t.as_str()).or_default().1;
        *slot = slot.checked_add(c_i64)?;
    }
    for (t, c) in &doc.body {
        let c_i64 = i64::try_from(*c).ok().filter(|&v| v > 0)?;
        blen = blen.checked_add(*c)?;
        i64::try_from(blen).ok()?;
        let slot = &mut merged.entry(t.as_str()).or_default().2;
        *slot = slot.checked_add(c_i64)?;
    }
    Some((blen, merged))
}

struct PreparedSidecar<'a> {
    body_lens: Vec<usize>,
    postings: Vec<DocPostings<'a>>,
    df: Vec<(&'a str, i64)>,
    doc_count: usize,
    avg_body_len: f64,
}

fn prepare_sidecar<'a>(
    ask_idx: &'a Option<AskIndex>,
    nodes: &[NodeV1],
) -> Option<PreparedSidecar<'a>> {
    let idx = ask_idx.as_ref()?;
    if !is_valid_ask_index(idx) || idx.docs.len() != nodes.len() {
        return None;
    }
    let by_id: HashMap<&str, &AskIndexDoc> = idx.docs.iter().map(|d| (d.id.as_str(), d)).collect();

    let mut body_lens = Vec::with_capacity(nodes.len());
    let mut postings = Vec::with_capacity(nodes.len());
    for n in nodes {
        let doc = by_id.get(n.id.as_str())?;
        let (blen, merged) = checked_merge_bag_fields(doc)?;
        body_lens.push(blen);
        postings.push(
            merged
                .into_iter()
                .map(|(tok, (ntf, ptf, btf))| (tok, ntf, ptf, btf))
                .collect(),
        );
    }

    let mut df_rows = Vec::with_capacity(idx.df.len());
    for (tok, df) in &idx.df {
        let df_i64 = i64::try_from(*df).ok()?;
        df_rows.push((tok.as_str(), df_i64));
    }

    Some(PreparedSidecar {
        body_lens,
        postings,
        df: df_rows,
        doc_count: idx.doc_count,
        avg_body_len: idx.avg_body_len,
    })
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

    if let Some(sidecar) = prepare_sidecar(ask_idx, nodes) {
        for (seq, doc_postings) in sidecar.postings.into_iter().enumerate() {
            let seq_i64 = to_sqlite_i64(seq, "node_seq")?;
            for (tok, ntf, ptf, btf) in doc_postings {
                posting_stmt
                    .execute(params![tok, seq_i64, ntf, ptf, btf])
                    .map_err(sql_err)?;
            }
        }
        for (tok, df_i64) in sidecar.df {
            df_stmt.execute(params![tok, df_i64]).map_err(sql_err)?;
        }
        return Ok((sidecar.body_lens, sidecar.doc_count, sidecar.avg_body_len));
    }

    let mut body_lens = Vec::with_capacity(nodes.len());
    let mut df_map: HashMap<String, usize> = HashMap::new();
    let mut total_body_len = 0_usize;
    for (seq, n) in nodes.iter().enumerate() {
        let seq_i64 = to_sqlite_i64(seq, "node_seq")?;
        let name_c = counts(&tokenize(&n.name));
        let path_c = counts(&tokenize(&n.path));
        let body_src = format!(
            "{} {} {}",
            n.signature.as_deref().unwrap_or(""),
            n.summary.as_deref().unwrap_or(""),
            n.body_text.as_deref().unwrap_or("")
        );
        let body_c = counts(&tokenize(&body_src));
        let blen: usize = body_c
            .values()
            .copied()
            .try_fold(0_usize, usize::checked_add)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "ask index: body length overflow",
                )
            })?;
        to_sqlite_i64(blen, "body_len")?;
        body_lens.push(blen);
        total_body_len = checked_add_body_len(total_body_len, blen)?;

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
                .execute(params![
                    tok,
                    seq_i64,
                    to_sqlite_i64(ntf, "name_tf")?,
                    to_sqlite_i64(ptf, "path_tf")?,
                    to_sqlite_i64(btf, "body_tf")?,
                ])
                .map_err(sql_err)?;
        }
        for tok in doc_terms {
            *df_map.entry(tok.to_string()).or_insert(0) += 1;
        }
    }
    for (tok, df) in df_map {
        df_stmt
            .execute(params![tok, to_sqlite_i64(df, "df")?])
            .map_err(sql_err)?;
    }
    let avg_body_len = if nodes.is_empty() {
        0.0
    } else {
        total_body_len as f64 / nodes.len() as f64
    };
    Ok((body_lens, nodes.len(), avg_body_len))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_add_body_len_accumulates_and_rejects_overflow() {
        assert_eq!(checked_add_body_len(12, 30).expect("sum fits"), 42);
        let err = checked_add_body_len(usize::MAX, 1).expect_err("overflow must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("aggregate body length overflow"));
    }

    #[test]
    fn to_sqlite_i64_and_prepare_sidecar_reject_invalid_inputs() {
        assert_eq!(to_sqlite_i64(7, "df").expect("fits"), 7);
        let err = to_sqlite_i64(usize::MAX, "body_len").expect_err("overflow");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("body_len"));

        let bad_ver = Some(AskIndex {
            version: 1,
            avg_body_len: 0.0,
            df: Vec::new(),
            doc_count: 0,
            docs: Vec::new(),
        });
        assert!(prepare_sidecar(&bad_ver, &[]).is_none());

        let mismatch = Some(AskIndex {
            version: 2,
            avg_body_len: 1.0,
            df: vec![("alpha".into(), 1)],
            doc_count: 1,
            docs: vec![AskIndexDoc {
                id: "a#f".into(),
                name: vec![("alpha".into(), 1)],
                path: Vec::new(),
                body: Vec::new(),
            }],
        });
        assert!(prepare_sidecar(&mismatch, &[]).is_none());
    }
}
