//! Indexed SQLite graph store (`<outDir>/.graph/wiring.sqlite`) backed by `rusqlite`.
//!
//! Lazily syncs from `<outDir>/.graph/wiring.json` inside an `IMMEDIATE`
//! transaction whenever the JSON file's size or mtime changes, using a 5 s
//! `busy_timeout` so concurrent `gg-query` calls coordinate cleanly.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

use crate::graph::{EdgeV1, GraphV1, NodeV1, UnresolvedCall};

pub const GRAPH_DIR: &str = ".graph";
pub const GRAPH_JSON: &str = "wiring.json";
pub const GRAPH_SQLITE: &str = "wiring.sqlite";
const SCHEMA_VERSION: &str = "1";
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

fn open_connection(db_path: &Path) -> io::Result<Connection> {
    let conn = Connection::open(db_path).map_err(sql_err)?;
    conn.busy_timeout(BUSY_TIMEOUT).map_err(sql_err)?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(sql_err)?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(sql_err)?;
    Ok(conn)
}

fn meta_value(conn: &Connection, key: &str) -> io::Result<Option<String>> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| {
        r.get(0)
    })
    .optional()
    .map_err(sql_err)
}

fn is_stamp_current(conn: &Connection, stamp: FileStamp) -> io::Result<bool> {
    let ver = meta_value(conn, "schema_version")?;
    let size = meta_value(conn, "source_size")?;
    let mtime = meta_value(conn, "source_mtime_ns")?;
    Ok(ver.as_deref() == Some(SCHEMA_VERSION)
        && size.as_deref() == Some(stamp.size.to_string().as_str())
        && mtime.as_deref() == Some(stamp.mtime_ns.to_string().as_str()))
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
        let mut conn = open_connection(&db_path)?;
        Self::init_schema(&conn)?;

        if !is_stamp_current(&conn, stamp)? {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(sql_err)?;
            if !is_stamp_current(&tx, stamp)? {
                Self::rebuild_in_tx(&tx, &json_path, stamp)?;
            }
            tx.commit().map_err(sql_err)?;
        }
        Ok(Some(Self { conn }))
    }

    /// Force a full rebuild of `wiring.sqlite` from `wiring.json`, returning node and edge counts.
    pub fn force_sync(context_dir: &Path) -> io::Result<(usize, usize)> {
        let json_path = wiring_json_path(context_dir);
        let stamp = file_stamp(&json_path)?;
        let db_path = wiring_sqlite_path(context_dir);
        let mut conn = open_connection(&db_path)?;
        Self::init_schema(&conn)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_err)?;
        let counts = Self::rebuild_in_tx(&tx, &json_path, stamp)?;
        tx.commit().map_err(sql_err)?;
        Ok(counts)
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

    fn rebuild_in_tx(
        tx: &Transaction<'_>,
        json_path: &Path,
        stamp: FileStamp,
    ) -> io::Result<(usize, usize)> {
        let raw = fs::read_to_string(json_path)?;
        let graph: GraphV1 = serde_json::from_str(&raw)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("wiring.json: {e}")))?;

        tx.execute("DELETE FROM meta", []).map_err(sql_err)?;
        tx.execute("DELETE FROM nodes", []).map_err(sql_err)?;
        tx.execute("DELETE FROM edges", []).map_err(sql_err)?;
        tx.execute("DELETE FROM unresolved_calls", [])
            .map_err(sql_err)?;

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
