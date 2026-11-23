//! Indexed SQLite graph queries and BFS walks over `GraphStore`.

use std::collections::{HashMap, HashSet};
use std::io;

use rusqlite::{OptionalExtension, Row, params};

use crate::graph::{
    Direction, EdgeHit, NodeV1, Savings, UnresolvedCall, is_walk_relation, looks_like_filename,
    normalize_path_prefix, path_under_prefix, symbol_matches_node,
};
use crate::store::{GraphStore, sql_err};

fn row_to_node(r: &Row<'_>) -> rusqlite::Result<NodeV1> {
    let chars_raw: Option<i64> = r.get(10)?;
    let chars = match chars_raw {
        Some(c) if c >= 0 => Some(c as u64),
        Some(_) => {
            return Err(rusqlite::Error::IntegralValueOutOfRange(10, -1));
        }
        None => None,
    };
    let exported: i64 = r.get(7)?;
    Ok(NodeV1 {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: r.get(2)?,
        owner: r.get(3)?,
        path: r.get(4)?,
        span: r.get(5)?,
        signature: r.get(6)?,
        exported: exported != 0,
        origin: r.get(8)?,
        body_hash: r.get(9)?,
        chars,
    })
}

impl GraphStore {
    pub fn node_count(&self) -> io::Result<usize> {
        let val: String = self
            .conn
            .query_row("SELECT value FROM meta WHERE key = 'node_count'", [], |r| {
                r.get(0)
            })
            .map_err(sql_err)?;
        Ok(val.parse().unwrap_or(0))
    }

    pub fn node_by_id(&self, id: &str) -> io::Result<Option<NodeV1>> {
        self.conn
            .query_row(
                "SELECT id, name, kind, owner, path, span, signature, exported, origin, body_hash, chars
                 FROM nodes WHERE id = ?1",
                params![id],
                row_to_node,
            )
            .optional()
            .map_err(sql_err)
    }

    pub fn nodes_by_path(&self, path: &str) -> io::Result<Vec<NodeV1>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, name, kind, owner, path, span, signature, exported, origin, body_hash, chars
                 FROM nodes WHERE path = ?1 ORDER BY seq ASC",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![path], row_to_node)
            .map_err(sql_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sql_err)
    }

    /// Resolve a symbol query via indexed SQLite queries, matching `src/graph/traverse.ts::resolveSymbol`.
    pub fn resolve_symbol(&self, query: &str, in_prefix: Option<&str>) -> io::Result<Vec<NodeV1>> {
        self.with_read_snapshot(|s| s.resolve_symbol_inner(query, in_prefix))
    }

    fn resolve_symbol_inner(
        &self,
        query: &str,
        in_prefix: Option<&str>,
    ) -> io::Result<Vec<NodeV1>> {
        let lower_query = query.to_lowercase();
        let mut matches = self.query_symbol_matches(&lower_query)?;

        if matches.is_empty()
            && let Some((_, last_seg)) = query.rsplit_once('.')
            && !last_seg.is_empty()
        {
            let lower_last = last_seg.to_lowercase();
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT id, name, kind, owner, path, span, signature, exported, origin, body_hash, chars
                     FROM nodes WHERE kind != 'file' AND name_lower = ?1 ORDER BY seq ASC",
                )
                .map_err(sql_err)?;
            let rows = stmt
                .query_map(params![lower_last], row_to_node)
                .map_err(sql_err)?;
            matches = rows.collect::<Result<Vec<_>, _>>().map_err(sql_err)?;
        }

        if matches.is_empty() && looks_like_filename(query) {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT id, name, kind, owner, path, span, signature, exported, origin, body_hash, chars
                     FROM nodes WHERE kind = 'file' ORDER BY seq ASC",
                )
                .map_err(sql_err)?;
            let suffix = format!("/{lower_query}");
            let rows = stmt
                .query_map([], row_to_node)
                .map_err(sql_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sql_err)?;
            matches = rows
                .into_iter()
                .filter(|n| {
                    let p_low = n.path.to_lowercase();
                    n.name.to_lowercase() == lower_query
                        || p_low == lower_query
                        || p_low.ends_with(&suffix)
                })
                .collect();
        }

        if let Some(raw_prefix) = in_prefix {
            let prefix = normalize_path_prefix(raw_prefix);
            if !prefix.is_empty() && !self.has_indexed_prefix(&prefix)? {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("nothing indexed under \"{prefix}\""),
                ));
            }
            matches.retain(|n| path_under_prefix(&n.path, &prefix));
        }

        Ok(matches)
    }

    /// Case-sensitive, wildcard-free index range scan on `idx_nodes_path` (`'/'` = 0x2F, `'0'` = 0x30).
    pub fn has_indexed_prefix(&self, prefix: &str) -> io::Result<bool> {
        let lo = format!("{prefix}/");
        let hi = format!("{prefix}0");
        let found: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 FROM nodes WHERE path = ?1 OR (path >= ?2 AND path < ?3) LIMIT 1",
                params![prefix, lo, hi],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_err)?;
        Ok(found.is_some())
    }

    fn query_symbol_matches(&self, lower_query: &str) -> io::Result<Vec<NodeV1>> {
        let simple = !lower_query.contains('.') && !lower_query.contains('#');
        let sql = if simple {
            "SELECT id, name, kind, owner, path, span, signature, exported, origin, body_hash, chars
             FROM nodes WHERE kind != 'file' AND name_lower = ?1 ORDER BY seq ASC"
        } else {
            "SELECT id, name, kind, owner, path, span, signature, exported, origin, body_hash, chars
             FROM nodes WHERE kind != 'file' ORDER BY seq ASC"
        };
        let mut stmt = self.conn.prepare(sql).map_err(sql_err)?;
        let rows = if simple {
            stmt.query_map(params![lower_query], row_to_node)
                .map_err(sql_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sql_err)?
        } else {
            stmt.query_map([], row_to_node)
                .map_err(sql_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sql_err)?
        };
        Ok(rows
            .into_iter()
            .filter(|n| symbol_matches_node(n, lower_query))
            .collect())
    }

    fn direct_neighbours(
        &self,
        id: &str,
        direction: Direction,
    ) -> io::Result<Vec<(String, String, bool)>> {
        let sql = match direction {
            Direction::In => {
                "SELECT source, relation, confidence FROM edges WHERE target = ?1 ORDER BY seq ASC"
            }
            Direction::Out => {
                "SELECT target, relation, confidence FROM edges WHERE source = ?1 ORDER BY seq ASC"
            }
        };
        let mut stmt = self.conn.prepare(sql).map_err(sql_err)?;
        let rows = stmt
            .query_map(params![id], |r| {
                let other: String = r.get(0)?;
                let relation: String = r.get(1)?;
                let confidence: String = r.get(2)?;
                Ok((other, relation, confidence))
            })
            .map_err(sql_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (other, relation, confidence) = row.map_err(sql_err)?;
            if is_walk_relation(&relation) {
                out.push((other, relation, confidence == "inferred"));
            }
        }
        Ok(out)
    }

    pub fn edge_walk(
        &self,
        symbol: &NodeV1,
        direction: Direction,
        max_depth: usize,
    ) -> io::Result<Vec<EdgeHit>> {
        self.with_read_snapshot(|s| s.edge_walk_inner(symbol, direction, max_depth))
    }

    fn edge_walk_inner(
        &self,
        symbol: &NodeV1,
        direction: Direction,
        max_depth: usize,
    ) -> io::Result<Vec<EdgeHit>> {
        if max_depth <= 1 {
            let mut hits = Vec::new();
            for (other, relation, inferred) in self.direct_neighbours(&symbol.id, direction)? {
                let node = self.node_by_id(&other)?;
                hits.push(EdgeHit {
                    node,
                    id: other,
                    relation,
                    depth: 1,
                    inferred,
                });
            }
            return Ok(hits);
        }

        let mut seeds = vec![symbol.id.clone()];
        if symbol.kind == "file" {
            for n in self.nodes_by_path(&symbol.path)? {
                if n.kind != "file" && n.kind != "resource" {
                    seeds.push(n.id);
                }
            }
        }
        self.impact_of_many_inner(&seeds, max_depth, direction)
    }

    pub fn impact_of_many(
        &self,
        seeds: &[String],
        max_depth: usize,
        direction: Direction,
    ) -> io::Result<Vec<EdgeHit>> {
        self.with_read_snapshot(|s| s.impact_of_many_inner(seeds, max_depth, direction))
    }

    fn impact_of_many_inner(
        &self,
        seeds: &[String],
        max_depth: usize,
        direction: Direction,
    ) -> io::Result<Vec<EdgeHit>> {
        let seed_set: HashSet<String> = seeds.iter().cloned().collect();
        let mut order: Vec<String> = Vec::new();
        let mut reached: HashMap<String, EdgeHit> = HashMap::new();
        let mut frontier: Vec<String> = Vec::new();
        let mut seen_seed: HashSet<String> = HashSet::new();
        for s in seeds {
            if seen_seed.insert(s.clone()) {
                frontier.push(s.clone());
            }
        }

        let mut depth = 1_usize;
        while depth <= max_depth && !frontier.is_empty() {
            let mut next = Vec::new();
            for current in &frontier {
                let path_inferred = reached.get(current).is_some_and(|h| h.inferred);
                for (other, relation, inferred) in self.direct_neighbours(current, direction)? {
                    if seed_set.contains(&other) {
                        continue;
                    }
                    let uncertain = path_inferred || inferred;
                    if let Some(prev) = reached.get(&other)
                        && (prev.depth < depth || !prev.inferred || uncertain)
                    {
                        continue;
                    }
                    let is_new = !reached.contains_key(&other);
                    if is_new {
                        next.push(other.clone());
                        order.push(other.clone());
                    }
                    let node = self.node_by_id(&other)?;
                    reached.insert(
                        other.clone(),
                        EdgeHit {
                            node,
                            id: other,
                            relation,
                            depth,
                            inferred: uncertain,
                        },
                    );
                }
            }
            frontier = next;
            depth = depth.saturating_add(1);
        }

        Ok(order
            .into_iter()
            .filter_map(|id| reached.remove(&id))
            .collect())
    }

    pub fn unresolved_calls_for(&self, name: &str) -> io::Result<Vec<UnresolvedCall>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT name, source, through, file FROM unresolved_calls WHERE name = ?1 ORDER BY seq ASC",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![name], |r| {
                Ok(UnresolvedCall {
                    name: r.get(0)?,
                    source: r.get(1)?,
                    through: r.get(2)?,
                    file: r.get(3)?,
                })
            })
            .map_err(sql_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sql_err)
    }

    pub fn savings_for_paths<'a, I>(&self, paths: I) -> io::Result<Option<Savings>>
    where
        I: IntoIterator<Item = &'a str>,
    {
        let unique: HashSet<&str> = paths.into_iter().collect();
        let mut baseline_chars = 0_usize;
        let mut files = 0_usize;
        let mut stmt = self
            .conn
            .prepare("SELECT chars FROM nodes WHERE kind = 'file' AND path = ?1 LIMIT 1")
            .map_err(sql_err)?;
        for p in unique {
            let chars: Option<Option<i64>> = stmt
                .query_row(params![p], |r| r.get(0))
                .optional()
                .map_err(sql_err)?;
            if let Some(Some(c)) = chars {
                let val = usize::try_from(c).map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("wiring.sqlite: invalid chars value {c}"),
                    )
                })?;
                baseline_chars = baseline_chars.checked_add(val).ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "wiring.sqlite: savings baseline_chars overflow",
                    )
                })?;
                files += 1;
            }
        }
        Ok((files > 0).then_some(Savings {
            files,
            baseline_chars,
        }))
    }
}
