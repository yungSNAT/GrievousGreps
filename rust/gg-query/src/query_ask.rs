//! SQLite query helpers for `ask` (inverted index, walk edges, scopes) and `skeleton`.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::io;

use rusqlite::{OptionalExtension, params};

use crate::graph::{NodeV1, ScopeV1, canonical_root_scopes, js_locale_cmp};
use crate::query::{NODE_SELECT, row_to_node};
use crate::store::{GraphStore, sql_err};

#[derive(Debug, Clone)]
pub struct NodeLite {
    pub seq: usize,
    pub id: String,
    pub kind: String,
    pub path: String,
    pub body_len: usize,
}

#[derive(Debug, Clone)]
pub struct PostingRow {
    pub term: String,
    pub node_seq: usize,
    pub name_tf: usize,
    pub path_tf: usize,
    pub body_tf: usize,
}

#[derive(Debug, Clone)]
pub struct StructuralHitRow {
    pub other_id: String,
    pub relation: String,
    pub name: Option<String>,
    pub path: Option<String>,
    pub span: Option<String>,
    pub summary: Option<String>,
    pub signature: Option<String>,
}

struct RankedStructuralRow {
    pointer: String,
    min_seq: i64,
    row: StructuralHitRow,
}

impl PartialEq for RankedStructuralRow {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for RankedStructuralRow {}

impl PartialOrd for RankedStructuralRow {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for RankedStructuralRow {
    fn cmp(&self, other: &Self) -> Ordering {
        js_locale_cmp(&self.pointer, &other.pointer)
            .then_with(|| self.min_seq.cmp(&other.min_seq))
            .then_with(|| self.row.other_id.cmp(&other.row.other_id))
            .then_with(|| self.row.relation.cmp(&other.row.relation))
    }
}

const STRUCTURAL_OUTGOING_SQL: &str = "SELECT e.target, e.relation, MIN(e.seq) AS min_seq,
        n.name, n.path, n.span, n.summary, n.signature
     FROM edges e
     LEFT JOIN nodes n ON n.id = e.target
     WHERE e.source IN (SELECT value FROM json_each(?1))
       AND e.relation IN ('calls', 'references', 'imports', 'implements', 'extends')
     GROUP BY e.target, e.relation
     ORDER BY min_seq ASC";

const STRUCTURAL_INCOMING_SQL: &str = "SELECT e.source, e.relation, MIN(e.seq) AS min_seq,
        n.name, n.path, n.span, n.summary, n.signature
     FROM edges e
     LEFT JOIN nodes n ON n.id = e.source
     WHERE e.target IN (SELECT value FROM json_each(?1))
       AND e.relation IN ('calls', 'references', 'implements', 'extends')
     GROUP BY e.source, e.relation
     ORDER BY min_seq ASC";

impl GraphStore {
    pub fn scopes(&self) -> io::Result<Vec<ScopeV1>> {
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'scopes_json'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_err)?;
        let Some(text) = raw else {
            return Ok(canonical_root_scopes());
        };
        let parsed: Vec<ScopeV1> = serde_json::from_str(&text)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        if parsed.is_empty() {
            Ok(canonical_root_scopes())
        } else {
            Ok(parsed)
        }
    }

    pub fn ask_meta(&self) -> io::Result<(usize, f64)> {
        let count_str: String = self
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'ask_doc_count'",
                [],
                |r| r.get(0),
            )
            .map_err(sql_err)?;
        let avg_bits_str: String = self
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'ask_avg_body_len_bits'",
                [],
                |r| r.get(0),
            )
            .map_err(sql_err)?;
        let doc_count = count_str.parse().unwrap_or(0);
        let avg_body_len = avg_bits_str
            .parse::<u64>()
            .map(f64::from_bits)
            .unwrap_or(0.0);
        Ok((doc_count, avg_body_len))
    }

    pub fn nodes_by_seqs(&self, seqs: &[usize]) -> io::Result<HashMap<usize, NodeV1>> {
        let mut out = HashMap::with_capacity(seqs.len());
        let sql = format!("{NODE_SELECT} WHERE seq = ?1");
        let mut stmt = self.conn.prepare(&sql).map_err(sql_err)?;
        for &seq in seqs {
            if out.contains_key(&seq) {
                continue;
            }
            if let Some(node) = stmt
                .query_row(params![seq as i64], row_to_node)
                .optional()
                .map_err(sql_err)?
            {
                out.insert(seq, node);
            }
        }
        Ok(out)
    }

    pub fn all_nodes_lite(&self) -> io::Result<Vec<NodeLite>> {
        let mut stmt = self
            .conn
            .prepare("SELECT seq, id, kind, path, body_len FROM nodes ORDER BY seq ASC")
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(NodeLite {
                    seq: r.get::<_, i64>(0)? as usize,
                    id: r.get(1)?,
                    kind: r.get(2)?,
                    path: r.get(3)?,
                    body_len: r.get::<_, i64>(4)? as usize,
                })
            })
            .map_err(sql_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sql_err)
    }

    pub fn all_walk_edge_seqs(&self) -> io::Result<Vec<(usize, usize)>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT source_seq, target_seq FROM edges
                 WHERE source_seq IS NOT NULL AND target_seq IS NOT NULL
                   AND relation IN ('calls', 'references', 'imports', 'implements', 'extends')
                 ORDER BY seq ASC",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, i64>(0)? as usize, r.get::<_, i64>(1)? as usize))
            })
            .map_err(sql_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sql_err)
    }

    pub fn ask_df_for_terms(&self, terms: &[String]) -> io::Result<HashMap<String, usize>> {
        let mut out = HashMap::new();
        let mut stmt = self
            .conn
            .prepare("SELECT df FROM ask_df WHERE token = ?1")
            .map_err(sql_err)?;
        for term in terms {
            if let Some(df) = stmt
                .query_row(params![term], |r| r.get::<_, i64>(0))
                .optional()
                .map_err(sql_err)?
            {
                out.insert(term.clone(), df as usize);
            }
        }
        Ok(out)
    }

    pub fn ask_postings_for_terms(&self, terms: &[String]) -> io::Result<Vec<PostingRow>> {
        let mut out = Vec::new();
        let mut stmt = self
            .conn
            .prepare(
                "SELECT node_seq, name_tf, path_tf, body_tf
                 FROM ask_postings WHERE token = ?1",
            )
            .map_err(sql_err)?;
        for term in terms {
            let rows = stmt
                .query_map(params![term], |r| {
                    Ok(PostingRow {
                        term: term.clone(),
                        node_seq: r.get::<_, i64>(0)? as usize,
                        name_tf: r.get::<_, i64>(1)? as usize,
                        path_tf: r.get::<_, i64>(2)? as usize,
                        body_tf: r.get::<_, i64>(3)? as usize,
                    })
                })
                .map_err(sql_err)?;
            for row in rows {
                out.push(row.map_err(sql_err)?);
            }
        }
        Ok(out)
    }

    /// Return `(matched_any, top_rows)` via an indexed SQLite `LEFT JOIN` and a
    /// `limit`-bounded heap (no N+1 `node_by_id` queries or unbounded hit vec).
    pub fn structural_hits_bounded(
        &self,
        subject_ids: &HashSet<String>,
        outgoing: bool,
        limit: usize,
    ) -> io::Result<(bool, Vec<StructuralHitRow>)> {
        if subject_ids.is_empty() {
            return Ok((false, Vec::new()));
        }
        let ids: Vec<&str> = subject_ids.iter().map(String::as_str).collect();
        let ids_json = serde_json::to_string(&ids)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let sql = if outgoing {
            STRUCTURAL_OUTGOING_SQL
        } else {
            STRUCTURAL_INCOMING_SQL
        };
        let mut stmt = self.conn.prepare(sql).map_err(sql_err)?;
        let mut rows = stmt.query(params![ids_json]).map_err(sql_err)?;
        let mut matched_any = false;
        let mut heap: BinaryHeap<RankedStructuralRow> = BinaryHeap::with_capacity(limit.min(64));

        while let Some(r) = rows.next().map_err(sql_err)? {
            matched_any = true;
            if limit == 0 {
                break;
            }
            let other_id: String = r.get(0).map_err(sql_err)?;
            let relation: String = r.get(1).map_err(sql_err)?;
            let min_seq: i64 = r.get(2).map_err(sql_err)?;
            let name: Option<String> = r.get(3).map_err(sql_err)?;
            let path: Option<String> = r.get(4).map_err(sql_err)?;
            let span: Option<String> = r.get(5).map_err(sql_err)?;
            let summary: Option<String> = r.get(6).map_err(sql_err)?;
            let signature: Option<String> = r.get(7).map_err(sql_err)?;
            let pointer = match (&path, &span) {
                (Some(p), Some(s)) => format!("{p}:{s}"),
                _ => other_id.clone(),
            };
            let cand = RankedStructuralRow {
                pointer,
                min_seq,
                row: StructuralHitRow {
                    other_id,
                    relation,
                    name,
                    path,
                    span,
                    summary,
                    signature,
                },
            };
            if heap.len() < limit {
                heap.push(cand);
            } else if let Some(worst) = heap.peek()
                && cand < *worst
            {
                heap.pop();
                heap.push(cand);
            }
        }

        let top = heap.into_sorted_vec().into_iter().map(|r| r.row).collect();
        Ok((matched_any, top))
    }

    /// Resolve a file path or unique basename for `skeleton`.
    pub fn find_matching_paths(&self, file: &str) -> io::Result<Vec<String>> {
        let suffix = format!("/{file}");
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT path FROM nodes ORDER BY path ASC")
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(sql_err)?;
        let mut out = Vec::new();
        for row in rows {
            let p = row.map_err(sql_err)?;
            if p == file || p.ends_with(&suffix) {
                out.push(p);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_ranked(pointer: &str, min_seq: i64, other_id: &str, rel: &str) -> RankedStructuralRow {
        RankedStructuralRow {
            pointer: pointer.to_string(),
            min_seq,
            row: StructuralHitRow {
                other_id: other_id.to_string(),
                relation: rel.to_string(),
                name: None,
                path: None,
                span: None,
                summary: None,
                signature: None,
            },
        }
    }

    #[test]
    fn ranked_structural_row_eq_and_tie_breakers() {
        let a = mk_ranked("a.rs:L1", 1, "id_a", "calls");
        let a_dup = mk_ranked("a.rs:L1", 1, "id_a", "calls");
        let b_id = mk_ranked("a.rs:L1", 1, "id_b", "calls");
        let b_rel = mk_ranked("a.rs:L1", 1, "id_a", "references");
        assert!(a == a_dup);
        assert!(a != b_id);
        assert_eq!(a.cmp(&b_id), Ordering::Less);
        assert_eq!(a.cmp(&b_rel), Ordering::Less);
    }
}
