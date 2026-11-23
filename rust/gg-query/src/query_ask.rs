//! SQLite query helpers for `ask` (inverted index, walk edges, scopes) and `skeleton`.

use std::collections::{HashMap, HashSet};
use std::io;

use rusqlite::{OptionalExtension, params};

use crate::graph::{NodeV1, ScopeV1, canonical_root_scopes};
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
pub struct StructuralEdgeRow {
    pub other: String,
    pub relation: String,
}

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

    pub fn structural_edges(
        &self,
        subject_ids: &HashSet<String>,
        outgoing: bool,
    ) -> io::Result<Vec<StructuralEdgeRow>> {
        let allowed: &[&str] = if outgoing {
            &["calls", "references", "imports", "implements", "extends"]
        } else {
            &["calls", "references", "implements", "extends"]
        };
        let mut stmt = self
            .conn
            .prepare("SELECT source, target, relation FROM edges ORDER BY seq ASC")
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(sql_err)?;
        let mut out = Vec::new();
        let mut seen: HashSet<(String, String)> = HashSet::new();
        for row in rows {
            let (source, target, relation) = row.map_err(sql_err)?;
            if !allowed.contains(&relation.as_str()) {
                continue;
            }
            let (anchor, other) = if outgoing {
                (source, target)
            } else {
                (target, source)
            };
            if subject_ids.contains(&anchor) && seen.insert((other.clone(), relation.clone())) {
                out.push(StructuralEdgeRow { other, relation });
            }
        }
        Ok(out)
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
