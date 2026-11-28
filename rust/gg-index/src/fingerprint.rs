//! Fingerprint sidecar (`<out_dir>/.cache/fingerprint.<stamp>.json`), ported from
//! `src/graph/fingerprint.ts`.
//!
//! Projects each extraction cache entry to `[size, mtimeMs, hash]` in compact UTF-8 JSON
//! (matching `writeJsonAtomic(..., true)`), with optional `onlyDirs` and `extensions`, and
//! prunes older `fingerprint.*.json` sidecars to `KEEP_SIDECARS`. An empty extractor falls
//! back to `"nostamp"`. All file operations stay confined to `dirname(out_dir)` through
//! `safe_write`.

use std::ffi::OsStr;
use std::path::Path;

use crate::extract_cache::{KEEP_SIDECARS, MAX_CACHE_BYTES};
use crate::json::{self, Json, utf16};
use crate::safe_write;

/// On-disk schema version (`FINGERPRINT_VERSION`).
pub const FINGERPRINT_VERSION: u32 = 1;

/// Filename prefix for fingerprint sidecars (`FINGERPRINT_PREFIX`).
pub const FINGERPRINT_PREFIX: &str = "fingerprint";

fn effective_stamp(extractor: &str) -> &str {
    if extractor.is_empty() {
        "nostamp"
    } else {
        extractor
    }
}

/// Write `<out_dir>/.cache/fingerprint.<stamp>.json` atomically inside `dirname(out_dir)`
/// and prune older `fingerprint.*.json` sidecars. Best-effort: returns `false` on failure.
#[must_use]
pub fn write_fingerprint(
    out_dir: &Path,
    extractor: &str,
    entries: &Json,
    only_dirs: &[String],
    extensions: &[String],
) -> bool {
    let Json::Obj(members) = entries else {
        return false;
    };
    let stamp = effective_stamp(extractor);
    let files = json::js_key_order(members)
        .into_iter()
        .map(|(rel, e)| {
            let size = e.get("size").cloned().unwrap_or(Json::Null);
            let mtime = e.get("mtimeMs").cloned().unwrap_or(Json::Null);
            let hash = e.get("hash").cloned().unwrap_or(Json::Null);
            (rel.clone(), Json::Arr(vec![size, mtime, hash]))
        })
        .collect();
    let mut record = vec![
        (utf16("version"), Json::Num(f64::from(FINGERPRINT_VERSION))),
        (utf16("extractor"), Json::Str(utf16(stamp))),
        (utf16("files"), Json::Obj(files)),
    ];
    if !only_dirs.is_empty() {
        record.push((
            utf16("onlyDirs"),
            Json::Arr(only_dirs.iter().map(|s| Json::Str(utf16(s))).collect()),
        ));
    }
    if !extensions.is_empty() {
        record.push((
            utf16("extensions"),
            Json::Arr(extensions.iter().map(|s| Json::Str(utf16(s))).collect()),
        ));
    }
    let text = json::stringify_compact(&Json::Obj(record));
    let leaf = format!("{FINGERPRINT_PREFIX}.{stamp}.json");
    let ok = safe_write::write_in_cache(out_dir, OsStr::new(&leaf), text.as_bytes()).is_ok();
    if ok {
        safe_write::prune_cache(out_dir, FINGERPRINT_PREFIX, KEEP_SIDECARS);
    }
    ok
}

/// Read `<out_dir>/.cache/fingerprint.<stamp>.json` inside `dirname(out_dir)`, returning
/// `None` when absent, unreadable, invalid or written for another extractor.
#[must_use]
pub fn read_fingerprint(out_dir: &Path, extractor: &str) -> Option<Json> {
    let stamp = effective_stamp(extractor);
    let leaf = format!("{FINGERPRINT_PREFIX}.{stamp}.json");
    let bytes = safe_write::read_in_cache(out_dir, OsStr::new(&leaf), MAX_CACHE_BYTES).ok()??;
    let text = String::from_utf8(bytes).ok()?;
    let f = json::parse(&text).ok()?;
    let valid = f.get("version") == Some(&Json::Num(f64::from(FINGERPRINT_VERSION)))
        && f.get("extractor") == Some(&Json::Str(utf16(stamp)))
        && matches!(f.get("files"), Some(Json::Obj(_)));
    valid.then_some(f)
}
