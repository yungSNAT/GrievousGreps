//! Per-file extraction memo (`<out_dir>/.cache/extract.<stamp>.json`), ported from
//! `src/graph/extract-cache.ts`.
//!
//! Safety properties:
//! - Containment: reads, writes and sidecar pruning stay inside `dirname(out_dir)` via
//!   `safe_write` (refusing symlinked/junctioned `out_dir` or `.cache`, never reading
//!   through a symlink leaf, and replacing a symlink leaf atomically on write).
//! - Streaming ASCII write: entries stream one at a time through a 1 MiB buffer with
//!   every UTF-16 code unit from U+007F up escaped (`asciiJson`), matching
//!   `writeCacheAtomic`.
//! - Trust boundary (`ownParse`): on read, an entry is kept only when `nodes` and
//!   `rawEdges` are arrays and every node's `path` equals the entry's key. Malformed
//!   entries, forged paths and `__proto__` payloads are dropped.
//! - Bounded reads: files over [`MAX_CACHE_BYTES`] are refused and treated as absent.
//! - Empty extractor: returns `false` on write and an empty cache on read, matching a
//!   `null` `extractorStamp()`.

use std::ffi::OsStr;
use std::io::{BufWriter, Write};
use std::path::Path;

use crate::json::{self, Json, utf16};
use crate::safe_write;

/// On-disk schema version (`CACHE_VERSION`).
pub const CACHE_VERSION: u32 = 1;

/// Filename prefix for extraction cache sidecars (`EXTRACT_CACHE_PREFIX`).
pub const EXTRACT_CACHE_PREFIX: &str = "extract";

/// Number of newest sidecars kept by `pruneSidecars`.
pub const KEEP_SIDECARS: usize = 2;

/// Maximum sidecar size read back into memory (matches the parity harness `maxBuffer`).
pub const MAX_CACHE_BYTES: u64 = 256 << 20;

/// `{ version: 1, extractor, files: {} }`.
#[must_use]
pub fn empty_cache(extractor: &str) -> Json {
    Json::Obj(vec![
        (utf16("version"), Json::Num(f64::from(CACHE_VERSION))),
        (utf16("extractor"), Json::Str(utf16(extractor))),
        (utf16("files"), Json::Obj(Vec::new())),
    ])
}

/// Write `cache` atomically to `<out_dir>/.cache/extract.<extractor>.json` as compact
/// ASCII JSON, then prune older `extract.*.json` sidecars to [`KEEP_SIDECARS`].
/// Best-effort: returns `false` without panicking on any invalid input or I/O failure.
#[must_use]
pub fn write_extract_cache(out_dir: &Path, extractor: &str, cache: &Json) -> bool {
    if extractor.is_empty() {
        return false;
    }
    let Json::Obj(members) = cache else {
        return false;
    };
    let files_key = utf16("files");
    let mut head = Vec::new();
    let mut files = None;
    for (k, v) in members {
        if *k == files_key {
            files = Some(v);
        } else {
            head.push((k.clone(), v.clone()));
        }
    }
    let Some(Json::Obj(entries)) = files else {
        return false;
    };
    let header = cache_header(head);
    let leaf = format!("{EXTRACT_CACHE_PREFIX}.{extractor}.json");
    let ok = safe_write::stream_in_cache(out_dir, OsStr::new(&leaf), |file| {
        let mut w = BufWriter::with_capacity(1 << 20, file);
        w.write_all(header.as_bytes())?;
        let mut buf = String::new();
        for (i, (rel, entry)) in json::js_key_order(entries).into_iter().enumerate() {
            buf.clear();
            if i > 0 {
                buf.push(',');
            }
            json::write_str_ascii(rel, &mut buf);
            buf.push(':');
            json::write_compact_ascii(entry, &mut buf);
            w.write_all(buf.as_bytes())?;
        }
        w.write_all(b"}}")?;
        w.flush()
    })
    .is_ok();
    if ok {
        safe_write::prune_cache(out_dir, EXTRACT_CACHE_PREFIX, KEEP_SIDECARS);
    }
    ok
}

fn cache_header(head: Vec<(Vec<u16>, Json)>) -> String {
    let mut out = String::new();
    json::write_compact_ascii(&Json::Obj(head), &mut out);
    out.pop();
    if out.len() > 1 {
        out.push(',');
    }
    out.push_str("\"files\":{");
    out
}

/// Read `<out_dir>/.cache/extract.<extractor>.json`, filtering `files` through
/// `ownParse`, or return an empty cache when absent, unreadable or invalid.
#[must_use]
pub fn read_extract_cache(out_dir: &Path, extractor: &str) -> Json {
    if extractor.is_empty() {
        return empty_cache("");
    }
    let leaf = format!("{EXTRACT_CACHE_PREFIX}.{extractor}.json");
    let Ok(Some(bytes)) = safe_write::read_in_cache(out_dir, OsStr::new(&leaf), MAX_CACHE_BYTES)
    else {
        return empty_cache(extractor);
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return empty_cache(extractor);
    };
    let Ok(c) = json::parse(&text) else {
        return empty_cache(extractor);
    };
    let valid = c.get("version") == Some(&Json::Num(f64::from(CACHE_VERSION)))
        && c.get("extractor") == Some(&Json::Str(utf16(extractor)));
    if !valid {
        return empty_cache(extractor);
    }
    let files = match c.get("files") {
        Some(Json::Obj(members)) => json::js_key_order(members)
            .into_iter()
            .filter(|(rel, e)| own_parse(rel, e))
            .map(|(rel, e)| (rel.clone(), e.clone()))
            .collect(),
        Some(Json::Null) => Vec::new(),
        _ => return empty_cache(extractor),
    };
    Json::Obj(vec![
        (utf16("version"), Json::Num(f64::from(CACHE_VERSION))),
        (utf16("extractor"), Json::Str(utf16(extractor))),
        (utf16("files"), Json::Obj(files)),
    ])
}

/// `ownParse`: an entry speaks for its own file alone.
fn own_parse(rel: &[u16], e: &Json) -> bool {
    let Some(Json::Arr(nodes)) = e.get("nodes") else {
        return false;
    };
    if !matches!(e.get("rawEdges"), Some(Json::Arr(_))) {
        return false;
    }
    nodes
        .iter()
        .all(|n| matches!(n.get("path"), Some(Json::Str(p)) if p == rel))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join("gg-index-extract-cache")
            .join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn empty_header_writes_valid_json() {
        let base = scratch("empty-head");
        let out = base.join("graft");
        let stamp = "0123456789abcdef";
        let payload = json::parse(r#"{"files":{}}"#).unwrap();
        assert!(write_extract_cache(&out, stamp, &payload));
        let path = out.join(".cache").join(format!("extract.{stamp}.json"));
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text, r#"{"files":{}}"#);
        assert!(json::parse(&text).is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn non_ascii_header_is_escaped_to_ascii() {
        let base = scratch("non-ascii-head");
        let out = base.join("graft");
        let stamp = "0123456789abcdef";
        let payload = json::parse(r#"{"version":1,"extractor":"café","files":{}}"#).unwrap();
        assert!(write_extract_cache(&out, stamp, &payload));
        let path = out.join(".cache").join(format!("extract.{stamp}.json"));
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.iter().all(|&b| b < 0x80));
        assert_eq!(
            bytes,
            br#"{"version":1,"extractor":"caf\u00e9","files":{}}"#
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
