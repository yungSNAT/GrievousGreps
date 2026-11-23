//! Indexed SQLite graph store (`<outDir>/.graph/wiring.sqlite`) backed by `rusqlite`.
//!
//! Lazily syncs from `<outDir>/.graph/wiring.json` whenever the JSON file's size
//! or mtime changes, then serves `status`, `callers`, and `blast` directly from
//! indexed SQLite tables without parsing the full graph JSON on every query.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{Connection, OptionalExtension, params};

use crate::graph::{
    Direction, EdgeHit, GraphV1, NodeV1, Savings, UnresolvedCall, is_walk_relation,
    looks_like_filename, normalize_path_prefix, path_under_prefix, symbol_matches_node,
};

pub const GRAPH_DIR: &str = ".graph";
pub const GRAPH_JSON: &str = "wiring.json";
pub const GRAPH_SQLITE: &str = "wiring.sqlite";
const SCHEMA_VERSION: &str = "1";

pub fn wiring_json_path(context_dir: &Path) -> PathBuf {
    context_dir.join(GRAPH_DIR).join(GRAPH_JSON)
}

pub fn wiring_sqlite_path(context_dir: &Path) -> PathBuf {
    context_dir.join(GRAPH_DIR).join(GRAPH_SQLITE)
}

pub struct GraphStore {
    conn: Connection,
}

#[derive(Debug, Clone, Copy)]
struct FileStamp {
    size: u64,
    mtime_ns: u128,
}

fn file_stamp(path: &Path) -> io::Result<FileStamp> {
    let meta = fs::metadata(path)?;
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    Ok(FileStamp {
        size: meta.len(),
        mtime_ns,
    })
}

fn sql_err(err: rusqlite::Error) -> io::Error {
    io::Error::other(format!("sqlite: {err}"))
}

impl GraphStore {
    /// Open `<outDir>/.graph/wiring.sqlite`, syncing from `wiring.json` only when stale.
    pub fn open_or_sync(context_dir: &Path) -> io::Result<Option<Self>> {
        let json_path = wiring_json_path(context_dir);
        if !json_path.is_file() {
            return Ok(None);
        }
        let stamp = file_stamp(&json_path)?;
        let db_path = wiring_sqlite_path(context_dir);
        let mut conn = Connection::open(&db_path).map_err(sql_err)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(sql_err)?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(sql_err)?;
        Self::init_schema(&conn)?;

        let current_ver: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_err)?;
        let current_size: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'source_size'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_err)?;
        let current_mtime: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'source_mtime_ns'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_err)?;

        let up_to_date = current_ver.as_deref() == Some(SCHEMA_VERSION)
            && current_size.as_deref() == Some(stamp.size.to_string().as_str())
            && current_mtime.as_deref() == Some(stamp.mtime_ns.to_string().as_str());

        if !up_to_date {
            Self::rebuild_from_json(&mut conn, &json_path, stamp)?;
        }
        Ok(Some(Self { conn }))
    }

    /// Force a full rebuild of `wiring.sqlite` from `wiring.json`, returning node and edge counts.
    pub fn force_sync(context_dir: &Path) -> io::Result<(usize, usize)> {
        let json_path = wiring_json_path(context_dir);
        let stamp = file_stamp(&json_path)?;
        let db_path = wiring_sqlite_path(context_dir);
        let mut conn = Connection::open(&db_path).map_err(sql_err)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(sql_err)?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(sql_err)?;
        Self::init_schema(&conn)?;
        Self::rebuild_from_json(&mut conn, &json_path, stamp)
    }

    fn init_schema(conn: &Connection) -> io::Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS nodes (
                seq INTEGER PRIMARY KEY,
                id TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                name_lower TEXT NOT NULL,
                kind TEXT NOT NULL,
                owner TEXT,
                path TEXT NOT NULL,
                path_lower TEXT NOT NULL,
                span TEXT NOT NULL,
                signature TEXT,
                exported INTEGER NOT NULL,
                origin TEXT NOT NULL,
                body_hash TEXT NOT NULL,
                chars INTEGER
            );
            CREATE TABLE IF NOT EXISTS edges (
                seq INTEGER PRIMARY KEY,
                source TEXT NOT NULL,
                target TEXT NOT NULL,
                relation TEXT NOT NULL,
                confidence TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS unresolved_calls (
                seq INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                source TEXT NOT NULL,
                through TEXT,
                file TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_nodes_name_lower ON nodes(name_lower);
            CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(path);
            CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
            CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
            CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
            CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_calls(name);",
        )
        .map_err(sql_err)
    }

    fn rebuild_from_json(
        conn: &mut Connection,
        json_path: &Path,
        stamp: FileStamp,
    ) -> io::Result<(usize, usize)> {
        let raw = fs::read_to_string(json_path)?;
        let graph: GraphV1 = serde_json::from_str(&raw)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("wiring.json: {e}")))?;

        let tx = conn.transaction().map_err(sql_err)?;
        tx.execute("DELETE FROM meta", []).map_err(sql_err)?;
        tx.execute("DELETE FROM nodes", []).map_err(sql_err)?;
        tx.execute("DELETE FROM edges", []).map_err(sql_err)?;
        tx.execute("DELETE FROM unresolved_calls", [])
            .map_err(sql_err)?;

        Self::insert_nodes(&tx, &graph.nodes)?;
        Self::insert_edges(&tx, &graph.edges)?;
        Self::insert_unresolved(&tx, &graph.unresolved_calls)?;

        let node_count = if graph.meta.node_count > 0 {
            graph.meta.node_count
        } else {
            graph.nodes.len()
        };
        let edge_count = if graph.meta.edge_count > 0 {
            graph.meta.edge_count
        } else {
            graph.edges.len()
        };
        for (k, v) in [
            ("schema_version", SCHEMA_VERSION.to_string()),
            ("source_size", stamp.size.to_string()),
            ("source_mtime_ns", stamp.mtime_ns.to_string()),
            ("node_count", node_count.to_string()),
            ("edge_count", edge_count.to_string()),
        ] {
            tx.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                params![k, v],
            )
            .map_err(sql_err)?;
        }
        tx.commit().map_err(sql_err)?;
        Ok((node_count, edge_count))
    }

    fn insert_nodes(tx: &rusqlite::Transaction<'_>, nodes: &[NodeV1]) -> io::Result<()> {
        let mut stmt = tx
            .prepare(
                "INSERT INTO nodes (seq, id, name, name_lower, kind, owner, path, path_lower, span, signature, exported, origin, body_hash, chars)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            )
            .map_err(sql_err)?;
        for (seq, n) in nodes.iter().enumerate() {
            stmt.execute(params![
                seq as i64,
                &n.id,
                &n.name,
                n.name.to_lowercase(),
                &n.kind,
                &n.owner,
                &n.path,
                n.path.to_lowercase(),
                &n.span,
                &n.signature,
                i64::from(n.exported),
                &n.origin,
                &n.body_hash,
                n.chars.map(|c| c as i64),
            ])
            .map_err(sql_err)?;
        }
        Ok(())
    }

    fn insert_edges(
        tx: &rusqlite::Transaction<'_>,
        edges: &[crate::graph::EdgeV1],
    ) -> io::Result<()> {
        let mut stmt = tx
            .prepare(
                "INSERT INTO edges (seq, source, target, relation, confidence)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(sql_err)?;
        for (seq, e) in edges.iter().enumerate() {
            stmt.execute(params![
                seq as i64,
                &e.source,
                &e.target,
                &e.relation,
                &e.confidence,
            ])
            .map_err(sql_err)?;
        }
        Ok(())
    }

    fn insert_unresolved(
        tx: &rusqlite::Transaction<'_>,
        calls: &[UnresolvedCall],
    ) -> io::Result<()> {
        let mut stmt = tx
            .prepare(
                "INSERT INTO unresolved_calls (seq, name, source, through, file)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(sql_err)?;
        for (seq, u) in calls.iter().enumerate() {
            stmt.execute(params![seq as i64, &u.name, &u.source, &u.through, &u.file,])
                .map_err(sql_err)?;
        }
        Ok(())
    }

    pub fn node_count(&self) -> io::Result<usize> {
        let val: String = self
            .conn
            .query_row("SELECT value FROM meta WHERE key = 'node_count'", [], |r| {
                r.get(0)
            })
            .map_err(sql_err)?;
        Ok(val.parse().unwrap_or(0))
    }

    fn row_to_node(r: &rusqlite::Row<'_>) -> rusqlite::Result<NodeV1> {
        let chars: Option<i64> = r.get(10)?;
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
            chars: chars.map(|c| c as usize),
        })
    }

    pub fn node_by_id(&self, id: &str) -> io::Result<Option<NodeV1>> {
        self.conn
            .query_row(
                "SELECT id, name, kind, owner, path, span, signature, exported, origin, body_hash, chars
                 FROM nodes WHERE id = ?1",
                params![id],
                Self::row_to_node,
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
            .query_map(params![path], Self::row_to_node)
            .map_err(sql_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sql_err)
    }

    /// Resolve a symbol query via indexed SQLite queries, matching `src/graph/traverse.ts::resolveSymbol`.
    pub fn resolve_symbol(&self, query: &str, in_prefix: Option<&str>) -> io::Result<Vec<NodeV1>> {
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
                .query_map(params![lower_last], Self::row_to_node)
                .map_err(sql_err)?;
            matches = rows.collect::<Result<Vec<_>, _>>().map_err(sql_err)?;
        }

        if matches.is_empty() && looks_like_filename(query) {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT id, name, kind, owner, path, span, signature, exported, origin, body_hash, chars
                     FROM nodes WHERE kind = 'file' AND (name_lower = ?1 OR path_lower = ?1 OR path_lower LIKE ?2)
                     ORDER BY seq ASC",
                )
                .map_err(sql_err)?;
            let suffix = format!("%/{lower_query}");
            let rows = stmt
                .query_map(params![lower_query, suffix], Self::row_to_node)
                .map_err(sql_err)?;
            matches = rows.collect::<Result<Vec<_>, _>>().map_err(sql_err)?;
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

    fn has_indexed_prefix(&self, prefix: &str) -> io::Result<bool> {
        let like = format!("{prefix}/%");
        let found: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 FROM nodes WHERE path = ?1 OR path LIKE ?2 LIMIT 1",
                params![prefix, like],
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
            stmt.query_map(params![lower_query], Self::row_to_node)
                .map_err(sql_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sql_err)?
        } else {
            stmt.query_map([], Self::row_to_node)
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
        self.impact_of_many(&seeds, max_depth, direction)
    }

    pub fn impact_of_many(
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
                baseline_chars += c as usize;
                files += 1;
            }
        }
        Ok((files > 0).then_some(Savings {
            files,
            baseline_chars,
        }))
    }
}
