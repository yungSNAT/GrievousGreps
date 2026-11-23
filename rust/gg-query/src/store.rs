//! Indexed SQLite graph store (`<outDir>/.graph/wiring.sqlite`) backed by `rusqlite`.
//!
//! Lazily syncs from `<outDir>/.graph/wiring.json` inside an `IMMEDIATE`
//! transaction whenever the JSON file's size or mtime changes, using a 5 s
//! `busy_timeout` and busy-retry loop so concurrent `gg-query` calls coordinate
//! cleanly on both Linux and Windows.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use rusqlite::{
    Connection, ErrorCode, OptionalExtension, Transaction, TransactionBehavior, params,
};

use crate::graph::{EdgeV1, GraphV1, NodeV1, UnresolvedCall};

pub const GRAPH_DIR: &str = ".graph";
pub const GRAPH_JSON: &str = "wiring.json";
pub const GRAPH_SQLITE: &str = "wiring.sqlite";
const SCHEMA_VERSION: &str = "2";
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub fn wiring_json_path(context_dir: &Path) -> PathBuf {
    context_dir.join(GRAPH_DIR).join(GRAPH_JSON)
}

pub fn wiring_sqlite_path(context_dir: &Path) -> PathBuf {
    context_dir.join(GRAPH_DIR).join(GRAPH_SQLITE)
}

pub struct GraphStore {
    pub(crate) conn: Connection,
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

pub(crate) fn sql_err(err: rusqlite::Error) -> io::Error {
    io::Error::other(format!("sqlite: {err}"))
}

fn is_busy(err: &rusqlite::Error) -> bool {
    matches!(
        err.sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

fn retry_busy<T>(mut op: impl FnMut() -> rusqlite::Result<T>) -> io::Result<T> {
    let deadline = Instant::now() + BUSY_TIMEOUT;
    let mut delay = Duration::from_millis(5);
    loop {
        match op() {
            Ok(val) => return Ok(val),
            Err(err) if is_busy(&err) && Instant::now() < deadline => {
                thread::sleep(delay);
                delay = (delay * 2).min(Duration::from_millis(50));
            }
            Err(err) => return Err(sql_err(err)),
        }
    }
}

fn open_connection(db_path: &Path) -> io::Result<Connection> {
    let conn = Connection::open(db_path).map_err(sql_err)?;
    conn.busy_timeout(BUSY_TIMEOUT).map_err(sql_err)?;
    retry_busy(|| {
        let mode: String = conn.pragma_query_value(None, "journal_mode", |r| r.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            conn.pragma_update(None, "journal_mode", "WAL")?;
        }
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(())
    })?;
    Ok(conn)
}

fn meta_value(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| {
        r.get(0)
    })
    .optional()
}

fn is_stamp_current(conn: &Connection, stamp: FileStamp) -> rusqlite::Result<bool> {
    let ver = meta_value(conn, "schema_version")?;
    let size = meta_value(conn, "source_size")?;
    let mtime = meta_value(conn, "source_mtime_ns")?;
    Ok(ver.as_deref() == Some(SCHEMA_VERSION)
        && size.as_deref() == Some(stamp.size.to_string().as_str())
        && mtime.as_deref() == Some(stamp.mtime_ns.to_string().as_str()))
}

const SCHEMA_SQL: &str = "CREATE TABLE IF NOT EXISTS meta (
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
    CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_calls(name);";

struct ReadSnapshotGuard<'a> {
    conn: &'a Connection,
    active: bool,
}

impl Drop for ReadSnapshotGuard<'_> {
    fn drop(&mut self) {
        if self.active {
            let _ = self.conn.execute_batch("COMMIT");
        }
    }
}

impl GraphStore {
    /// Execute a multi-query read workload inside a single SQLite read snapshot so
    /// a concurrent rebuild cannot interleave generations between reads.
    pub fn with_read_snapshot<T>(
        &self,
        f: impl FnOnce(&GraphStore) -> io::Result<T>,
    ) -> io::Result<T> {
        let started = self.conn.is_autocommit();
        if started {
            retry_busy(|| self.conn.execute_batch("BEGIN DEFERRED"))?;
        }
        let guard = ReadSnapshotGuard {
            conn: &self.conn,
            active: started,
        };
        let res = f(self);
        drop(guard);
        res
    }

    /// Open `<outDir>/.graph/wiring.sqlite`, syncing from `wiring.json` only when stale.
    pub fn open_or_sync(context_dir: &Path) -> io::Result<Option<Self>> {
        let json_path = wiring_json_path(context_dir);
        if !json_path.is_file() {
            return Ok(None);
        }
        let stamp = file_stamp(&json_path)?;
        let db_path = wiring_sqlite_path(context_dir);
        let mut conn = open_connection(&db_path)?;
        let current = retry_busy(|| match is_stamp_current(&conn, stamp) {
            Ok(v) => Ok(v),
            Err(_) => Ok(false),
        })?;

        if !current {
            Self::sync_in_immediate_tx(&mut conn, &json_path, stamp, false)?;
        }
        Ok(Some(Self { conn }))
    }

    /// Force a full rebuild of `wiring.sqlite` from `wiring.json`, returning node and edge counts.
    pub fn force_sync(context_dir: &Path) -> io::Result<(usize, usize)> {
        let json_path = wiring_json_path(context_dir);
        let stamp = file_stamp(&json_path)?;
        let db_path = wiring_sqlite_path(context_dir);
        let mut conn = open_connection(&db_path)?;
        Self::sync_in_immediate_tx(&mut conn, &json_path, stamp, true)
    }

    fn sync_in_immediate_tx(
        conn: &mut Connection,
        json_path: &Path,
        stamp: FileStamp,
        force: bool,
    ) -> io::Result<(usize, usize)> {
        let deadline = Instant::now() + BUSY_TIMEOUT;
        let mut delay = Duration::from_millis(5);
        loop {
            match conn.transaction_with_behavior(TransactionBehavior::Immediate) {
                Ok(tx) => {
                    tx.execute_batch(SCHEMA_SQL).map_err(sql_err)?;
                    let counts = if !force && is_stamp_current(&tx, stamp).unwrap_or(false) {
                        let n = meta_value(&tx, "node_count")
                            .map_err(sql_err)?
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(0);
                        let e = meta_value(&tx, "edge_count")
                            .map_err(sql_err)?
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(0);
                        (n, e)
                    } else {
                        Self::rebuild_in_tx(&tx, json_path, stamp)?
                    };
                    tx.commit().map_err(sql_err)?;
                    return Ok(counts);
                }
                Err(err) if is_busy(&err) && Instant::now() < deadline => {
                    thread::sleep(delay);
                    delay = (delay * 2).min(Duration::from_millis(50));
                }
                Err(err) => return Err(sql_err(err)),
            }
        }
    }

    fn rebuild_in_tx(
        tx: &Transaction<'_>,
        json_path: &Path,
        stamp: FileStamp,
    ) -> io::Result<(usize, usize)> {
        let raw = fs::read_to_string(json_path)?;
        let graph: GraphV1 = serde_json::from_str(&raw)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("wiring.json: {e}")))?;

        // Re-create nodes table if migrating from schema v1 (which had unused path_lower).
        let ver = meta_value(tx, "schema_version").unwrap_or(None);
        if ver.as_deref() != Some(SCHEMA_VERSION) {
            tx.execute_batch(
                "DROP TABLE IF EXISTS nodes;
                 DROP TABLE IF EXISTS edges;
                 DROP TABLE IF EXISTS unresolved_calls;
                 DROP TABLE IF EXISTS meta;",
            )
            .map_err(sql_err)?;
            tx.execute_batch(SCHEMA_SQL).map_err(sql_err)?;
        } else {
            tx.execute("DELETE FROM meta", []).map_err(sql_err)?;
            tx.execute("DELETE FROM nodes", []).map_err(sql_err)?;
            tx.execute("DELETE FROM edges", []).map_err(sql_err)?;
            tx.execute("DELETE FROM unresolved_calls", [])
                .map_err(sql_err)?;
        }

        Self::insert_nodes(tx, &graph.nodes)?;
        Self::insert_edges(tx, &graph.edges)?;
        Self::insert_unresolved(tx, &graph.unresolved_calls)?;

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
        Ok((node_count, edge_count))
    }

    fn insert_nodes(tx: &Transaction<'_>, nodes: &[NodeV1]) -> io::Result<()> {
        let mut stmt = tx
            .prepare(
                "INSERT INTO nodes (seq, id, name, name_lower, kind, owner, path, span, signature, exported, origin, body_hash, chars)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            )
            .map_err(sql_err)?;
        for (seq, n) in nodes.iter().enumerate() {
            let chars = match n.chars {
                Some(c) => Some(i64::try_from(c).map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("wiring.json: chars value {c} exceeds i64::MAX"),
                    )
                })?),
                None => None,
            };
            stmt.execute(params![
                seq as i64,
                &n.id,
                &n.name,
                n.name.to_lowercase(),
                &n.kind,
                &n.owner,
                &n.path,
                &n.span,
                &n.signature,
                i64::from(n.exported),
                &n.origin,
                &n.body_hash,
                chars,
            ])
            .map_err(sql_err)?;
        }
        Ok(())
    }

    fn insert_edges(tx: &Transaction<'_>, edges: &[EdgeV1]) -> io::Result<()> {
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

    fn insert_unresolved(tx: &Transaction<'_>, calls: &[UnresolvedCall]) -> io::Result<()> {
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
}
