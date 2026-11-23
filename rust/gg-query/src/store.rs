//! Indexed SQLite graph store (`<outDir>/.graph/wiring.sqlite`) backed by `rusqlite`.
//!
//! Lazily syncs from `<outDir>/.graph/wiring.json` (and optional `.cache/ask-index.json`)
//! inside an `IMMEDIATE` transaction whenever either source's size or mtime changes,
//! using a 5 s `busy_timeout` and busy-retry loop so concurrent `gg-query` calls
//! coordinate cleanly on both Linux and Windows.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use rusqlite::{
    Connection, ErrorCode, OptionalExtension, Transaction, TransactionBehavior, params,
};

use crate::graph::{EdgeV1, GraphV1, NodeV1, UnresolvedCall, scopes_of_meta};
use crate::tokenize::{AskIndex, AskIndexDoc, ask_index_path, counts, read_ask_index, tokenize};

pub const GRAPH_DIR: &str = ".graph";
pub const GRAPH_JSON: &str = "wiring.json";
pub const GRAPH_SQLITE: &str = "wiring.sqlite";
const SCHEMA_VERSION: &str = "3";
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

#[derive(Debug, Clone, Copy)]
struct SyncStamps {
    wiring: FileStamp,
    ask_index: Option<FileStamp>,
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

fn optional_file_stamp(path: &Path) -> Option<FileStamp> {
    let meta = fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() || !meta.file_type().is_file() {
        return None;
    }
    file_stamp(path).ok()
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

fn is_stamp_current(conn: &Connection, stamps: SyncStamps) -> rusqlite::Result<bool> {
    let ver = meta_value(conn, "schema_version")?;
    let size = meta_value(conn, "source_size")?;
    let mtime = meta_value(conn, "source_mtime_ns")?;
    let idx_size = meta_value(conn, "ask_index_size")?;
    let idx_mtime = meta_value(conn, "ask_index_mtime_ns")?;
    let (exp_idx_size, exp_idx_mtime) = match stamps.ask_index {
        Some(s) => (s.size.to_string(), s.mtime_ns.to_string()),
        None => ("none".to_string(), "none".to_string()),
    };
    Ok(ver.as_deref() == Some(SCHEMA_VERSION)
        && size.as_deref() == Some(stamps.wiring.size.to_string().as_str())
        && mtime.as_deref() == Some(stamps.wiring.mtime_ns.to_string().as_str())
        && idx_size.as_deref() == Some(exp_idx_size.as_str())
        && idx_mtime.as_deref() == Some(exp_idx_mtime.as_str()))
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
        chars INTEGER,
        summary TEXT,
        body_text TEXT,
        crux_code TEXT,
        body_len INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS edges (
        seq INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        source_seq INTEGER,
        target_seq INTEGER,
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
    CREATE TABLE IF NOT EXISTS ask_df (
        token TEXT PRIMARY KEY,
        df INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS ask_postings (
        token TEXT NOT NULL,
        node_seq INTEGER NOT NULL,
        name_tf INTEGER NOT NULL,
        path_tf INTEGER NOT NULL,
        body_tf INTEGER NOT NULL,
        PRIMARY KEY (token, node_seq)
    ) WITHOUT ROWID;
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
        let stamps = SyncStamps {
            wiring: file_stamp(&json_path)?,
            ask_index: optional_file_stamp(&ask_index_path(context_dir)),
        };
        let db_path = wiring_sqlite_path(context_dir);
        let mut conn = open_connection(&db_path)?;
        let current = retry_busy(|| match is_stamp_current(&conn, stamps) {
            Ok(v) => Ok(v),
            Err(_) => Ok(false),
        })?;

        if !current {
            Self::sync_in_immediate_tx(&mut conn, context_dir, &json_path, stamps, false)?;
        }
        Ok(Some(Self { conn }))
    }

    /// Force a full rebuild of `wiring.sqlite` from `wiring.json`, returning node and edge counts.
    pub fn force_sync(context_dir: &Path) -> io::Result<(usize, usize)> {
        let json_path = wiring_json_path(context_dir);
        let stamps = SyncStamps {
            wiring: file_stamp(&json_path)?,
            ask_index: optional_file_stamp(&ask_index_path(context_dir)),
        };
        let db_path = wiring_sqlite_path(context_dir);
        let mut conn = open_connection(&db_path)?;
        Self::sync_in_immediate_tx(&mut conn, context_dir, &json_path, stamps, true)
    }

    fn sync_in_immediate_tx(
        conn: &mut Connection,
        context_dir: &Path,
        json_path: &Path,
        stamps: SyncStamps,
        force: bool,
    ) -> io::Result<(usize, usize)> {
        let deadline = Instant::now() + BUSY_TIMEOUT;
        let mut delay = Duration::from_millis(5);
        loop {
            match conn.transaction_with_behavior(TransactionBehavior::Immediate) {
                Ok(tx) => {
                    tx.execute_batch(SCHEMA_SQL).map_err(sql_err)?;
                    let counts = if !force && is_stamp_current(&tx, stamps).unwrap_or(false) {
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
                        Self::rebuild_in_tx(&tx, context_dir, json_path, stamps)?
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

    fn reset_tables(tx: &Transaction<'_>) -> io::Result<()> {
        let ver = meta_value(tx, "schema_version").unwrap_or(None);
        if ver.as_deref() != Some(SCHEMA_VERSION) {
            tx.execute_batch(
                "DROP TABLE IF EXISTS nodes;
                 DROP TABLE IF EXISTS edges;
                 DROP TABLE IF EXISTS unresolved_calls;
                 DROP TABLE IF EXISTS ask_df;
                 DROP TABLE IF EXISTS ask_postings;
                 DROP TABLE IF EXISTS meta;",
            )
            .map_err(sql_err)?;
            tx.execute_batch(SCHEMA_SQL).map_err(sql_err)?;
        } else {
            for tbl in [
                "meta",
                "nodes",
                "edges",
                "unresolved_calls",
                "ask_df",
                "ask_postings",
            ] {
                tx.execute(&format!("DELETE FROM {tbl}"), [])
                    .map_err(sql_err)?;
            }
        }
        Ok(())
    }

    fn rebuild_in_tx(
        tx: &Transaction<'_>,
        context_dir: &Path,
        json_path: &Path,
        stamps: SyncStamps,
    ) -> io::Result<(usize, usize)> {
        let raw = fs::read_to_string(json_path)?;
        let graph: GraphV1 = serde_json::from_str(&raw)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("wiring.json: {e}")))?;

        Self::reset_tables(tx)?;
        let ask_idx = read_ask_index(context_dir)?;
        let (body_lens, doc_count, avg_body_len) =
            Self::insert_ask_index(tx, &graph.nodes, &ask_idx)?;
        let id_to_seq = Self::insert_nodes(tx, &graph.nodes, &body_lens)?;
        Self::insert_edges(tx, &graph.edges, &id_to_seq)?;
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
        let scopes_json = serde_json::to_string(&scopes_of_meta(&graph.meta))
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let (idx_size, idx_mtime) = match stamps.ask_index {
            Some(s) => (s.size.to_string(), s.mtime_ns.to_string()),
            None => ("none".to_string(), "none".to_string()),
        };
        for (k, v) in [
            ("schema_version", SCHEMA_VERSION.to_string()),
            ("source_size", stamps.wiring.size.to_string()),
            ("source_mtime_ns", stamps.wiring.mtime_ns.to_string()),
            ("ask_index_size", idx_size),
            ("ask_index_mtime_ns", idx_mtime),
            ("node_count", node_count.to_string()),
            ("edge_count", edge_count.to_string()),
            ("scopes_json", scopes_json),
            ("ask_doc_count", doc_count.to_string()),
            ("ask_avg_body_len_bits", avg_body_len.to_bits().to_string()),
        ] {
            tx.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                params![k, v],
            )
            .map_err(sql_err)?;
        }
        Ok((node_count, edge_count))
    }

    fn insert_ask_index(
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

            let mut doc_tokens: HashSet<&str> = HashSet::new();
            let mut merged: HashMap<&str, (usize, usize, usize)> = HashMap::new();
            for (t, &c) in &name_c {
                doc_tokens.insert(t.as_str());
                merged.entry(t.as_str()).or_default().0 = c;
            }
            for (t, &c) in &path_c {
                doc_tokens.insert(t.as_str());
                merged.entry(t.as_str()).or_default().1 = c;
            }
            for (t, &c) in &body_c {
                doc_tokens.insert(t.as_str());
                merged.entry(t.as_str()).or_default().2 = c;
            }
            for (tok, (ntf, ptf, btf)) in merged {
                posting_stmt
                    .execute(params![tok, seq as i64, ntf as i64, ptf as i64, btf as i64])
                    .map_err(sql_err)?;
            }
            for tok in doc_tokens {
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

    fn insert_nodes(
        tx: &Transaction<'_>,
        nodes: &[NodeV1],
        body_lens: &[usize],
    ) -> io::Result<HashMap<String, i64>> {
        let mut stmt = tx
            .prepare(
                "INSERT INTO nodes (
                    seq, id, name, name_lower, kind, owner, path, span, signature,
                    exported, origin, body_hash, chars, summary, body_text, crux_code, body_len
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            )
            .map_err(sql_err)?;
        let mut id_to_seq = HashMap::with_capacity(nodes.len());
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
            let seq_i64 = seq as i64;
            id_to_seq.insert(n.id.clone(), seq_i64);
            let crux_code = n.crux.as_ref().map(|c| c.code.as_str());
            stmt.execute(params![
                seq_i64,
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
                &n.summary,
                &n.body_text,
                crux_code,
                body_lens[seq] as i64,
            ])
            .map_err(sql_err)?;
        }
        Ok(id_to_seq)
    }

    fn insert_edges(
        tx: &Transaction<'_>,
        edges: &[EdgeV1],
        id_to_seq: &HashMap<String, i64>,
    ) -> io::Result<()> {
        let mut stmt = tx
            .prepare(
                "INSERT INTO edges (seq, source, target, source_seq, target_seq, relation, confidence)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(sql_err)?;
        for (seq, e) in edges.iter().enumerate() {
            let s_seq = id_to_seq.get(&e.source).copied();
            let t_seq = id_to_seq.get(&e.target).copied();
            stmt.execute(params![
                seq as i64,
                &e.source,
                &e.target,
                s_seq,
                t_seq,
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
            stmt.execute(params![seq as i64, &u.name, &u.source, &u.through, &u.file])
                .map_err(sql_err)?;
        }
        Ok(())
    }
}
