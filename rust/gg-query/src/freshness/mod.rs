//! Read-only index freshness probe (`--no-refresh`, `index` JSON status,
//! stderr stale notice) matching `src/graph/fingerprint.ts`, `refresh.ts`,
//! `source-files.ts`, and `query-json.ts`.

mod walk;

use std::collections::{BTreeMap, HashSet};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::brand::cmd;
use crate::store::wiring_json_path;

use walk::list_source_files;

const CACHE_DIR: &str = ".cache";
const FINGERPRINT_PREFIX: &str = "fingerprint.";
const FINGERPRINT_VERSION: u32 = 1;
pub(super) const MAX_FILE_BYTES: u64 = 1_000_000;
const MAX_FINGERPRINT_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IndexState {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Drift {
    pub changed: Vec<String>,
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

impl Drift {
    pub fn is_clean(&self) -> bool {
        self.changed.is_empty() && self.added.is_empty() && self.removed.is_empty()
    }

    pub fn count(&self) -> usize {
        self.changed.len() + self.added.len() + self.removed.len()
    }
}

#[derive(Deserialize)]
struct FingerprintRecord {
    version: u32,
    files: BTreeMap<String, (u64, f64, String)>,
    #[serde(rename = "onlyDirs", default)]
    only_dirs: Vec<String>,
    #[serde(default)]
    extensions: Vec<String>,
}

fn env_flag(name: &str) -> bool {
    env::var(name)
        .map(|v| !v.is_empty() && v != "0" && v != "false")
        .unwrap_or(false)
}

pub fn always_hash() -> bool {
    env::var("GRAFT_REFRESH").is_ok_and(|v| v == "hash")
}

/// Pure-Rust FIPS 180-4 SHA-256 hex digest (zero external dependencies).
pub fn sha256_hex(input: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut msg = input.to_vec();
    let bit_len = (input.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for block in msg.as_chunks::<64>().0 {
        let mut w = [0_u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        let next = [a, b, c, d, e, f, g, hh];
        for (slot, delta) in h.iter_mut().zip(next) {
            *slot = slot.wrapping_add(delta);
        }
    }
    let mut out = String::with_capacity(64);
    for word in h {
        use std::fmt::Write;
        let _ = write!(out, "{word:08x}");
    }
    out
}

fn read_source_hash(path: &Path) -> io::Result<Option<String>> {
    let file = fs::File::open(path)?;
    let meta = file.metadata()?;
    if !meta.file_type().is_file() || meta.len() > MAX_FILE_BYTES {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES || bytes.starts_with(&[0xfe, 0xff]) {
        return Ok(None);
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        let units: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        let text = String::from_utf16_lossy(&units);
        return Ok(Some(sha256_hex(text.as_bytes())));
    }
    let text = String::from_utf8_lossy(&bytes);
    Ok(Some(sha256_hex(text.as_bytes())))
}

fn read_bounded_utf8_file(path: &Path, max_bytes: u64) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.file_type().is_file() || meta.len() > max_bytes {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(max_bytes + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > max_bytes {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn read_latest_fingerprint(out_dir: &Path) -> Option<FingerprintRecord> {
    let cache = out_dir.join(CACHE_DIR);
    let cache_meta = fs::symlink_metadata(&cache).ok()?;
    if cache_meta.file_type().is_symlink() || !cache_meta.is_dir() {
        return None;
    }
    let mut candidates = Vec::new();
    for entry in fs::read_dir(&cache).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(FINGERPRINT_PREFIX) || !name.ends_with(".json") {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_file() {
            continue;
        }
        let modified = meta.modified().ok();
        candidates.push((modified, name, path));
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    for (_, _, path) in candidates {
        let Some(raw) = read_bounded_utf8_file(&path, MAX_FINGERPRINT_BYTES) else {
            continue;
        };
        if let Ok(rec) = serde_json::from_str::<FingerprintRecord>(&raw)
            && rec.version == FINGERPRINT_VERSION
        {
            return Some(rec);
        }
    }
    None
}

/// Compare working tree files against the latest build fingerprint.
pub fn probe_drift(root: &Path, out_dir: &Path) -> Option<Drift> {
    let fp = read_latest_fingerprint(out_dir)?;
    let mut drift = Drift::default();
    let mut seen = HashSet::new();
    let force_hash = always_hash();

    for (rel, abs, size, mtime_ms) in
        list_source_files(root, out_dir, &fp.only_dirs, &fp.extensions)
    {
        seen.insert(rel.clone());
        let Some((rec_size, rec_mtime, rec_hash)) = fp.files.get(&rel) else {
            drift.added.push(rel);
            continue;
        };
        if !force_hash
            && !rec_hash.is_empty()
            && size == *rec_size
            && (mtime_ms - *rec_mtime).abs() < 1e-3
        {
            continue;
        }
        match read_source_hash(&abs) {
            Ok(Some(now_hash)) if now_hash != *rec_hash => drift.changed.push(rel),
            Ok(None) if !rec_hash.is_empty() => drift.changed.push(rel),
            _ => {}
        }
    }

    for rel in fp.files.keys() {
        if !seen.contains(rel) {
            drift.removed.push(rel.clone());
        }
    }
    drift.changed.sort();
    drift.added.sort();
    drift.removed.sort();
    Some(drift)
}

/// Evaluate index freshness for CLI query commands (`callers`, `ask`, `blast`,
/// `hubs`, `skeleton`). Emits `None` when `--no-refresh` is off and no build
/// fingerprint exists (legacy Stage 0 fixtures).
pub fn probe_query_index(root: &Path, out_dir: &Path, no_refresh: bool) -> Option<IndexState> {
    if !wiring_json_path(out_dir).is_file() {
        return None;
    }
    let disabled = no_refresh || env_flag("GRAFT_NO_REFRESH");
    if let Some(drift) = probe_drift(root, out_dir) {
        if drift.is_clean() {
            return Some(IndexState {
                state: "fresh",
                changed: None,
                reason: None,
            });
        }
        let reason = if disabled {
            "refresh is off".to_string()
        } else {
            format!(
                "gg-query is read-only; run `{}` to rebuild",
                cmd("graft build")
            )
        };
        return Some(IndexState {
            state: "stale",
            changed: Some(drift.count()),
            reason: Some(reason),
        });
    }
    if disabled {
        return Some(IndexState {
            state: "stale",
            changed: None,
            reason: Some("no build fingerprint, and refresh is off".to_string()),
        });
    }
    None
}

/// Determine `codeMap.inSync` for `status`.
pub fn check_status_in_sync(root: &Path, out_dir: &Path, no_refresh: bool) -> bool {
    match probe_drift(root, out_dir) {
        Some(drift) => drift.is_clean(),
        None => !(no_refresh || env_flag("GRAFT_NO_REFRESH")),
    }
}

pub fn index_line(index: &IndexState) -> String {
    if index.state == "fresh" {
        return "index: fresh".to_string();
    }
    let reason = index.reason.as_deref().unwrap_or("not rebuilt");
    let changed = match index.changed {
        Some(1) => ", 1 file changed since the last build".to_string(),
        Some(n) => format!(", {n} files changed since the last build"),
        None => String::new(),
    };
    format!("index: stale ({reason}{changed}); answers may miss those edits")
}

pub fn emit_stale_notice(index: Option<&IndexState>) {
    if let Some(idx) = index
        && idx.state == "stale"
    {
        eprintln!("{}", index_line(idx));
    }
}

/// Serialize `value` with pretty JSON, appending `"index"` when `Some` just like
/// `src/graph/query-json.ts::queryJson`.
pub fn format_query_json<T: Serialize>(
    value: &T,
    index: Option<&IndexState>,
) -> Result<String, String> {
    let mut val = serde_json::to_value(value).map_err(|e| e.to_string())?;
    if let (Some(idx), Some(obj)) = (index, val.as_object_mut()) {
        let idx_val = serde_json::to_value(idx).map_err(|e| e.to_string())?;
        obj.insert("index".to_string(), idx_val);
    }
    serde_json::to_string_pretty(&val).map_err(|e| e.to_string())
}
