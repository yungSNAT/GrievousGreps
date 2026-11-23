//! Native reader and cosine search for `<outDir>/.cache/ask-vectors.bin`.
//!
//! Matches `src/ask/vectors.ts`: binary sidecar format (8-byte LE header length,
//! JSON header, raw LE float16 chunk vectors), top-50 dense cosine ranking and
//! reciprocal rank fusion (`RRF_K = 60`).

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::embed::{MODEL_ID, f16_table};

pub const VECTORS_FILE: &str = "ask-vectors.bin";
pub const CACHE_DIR: &str = ".cache";
const CHUNK_CHARS: usize = 750;
const DENSE_FILES: usize = 50;
const RRF_K: f64 = 60.0;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VectorFile {
    pub path: String,
    pub hash: String,
    pub lines: Vec<usize>,
}

#[derive(Debug, Clone)]
pub struct VectorIndex {
    pub model: String,
    pub dim: usize,
    pub files: Vec<VectorFile>,
    pub data: Vec<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DenseFile {
    pub path: String,
    pub score: f64,
    pub start: usize,
    pub end: usize,
}

#[derive(Deserialize)]
struct RawHeader {
    version: u32,
    model: String,
    chunk: usize,
    dim: usize,
    files: Vec<VectorFile>,
}

pub fn vectors_path(out_dir: &Path) -> PathBuf {
    out_dir.join(CACHE_DIR).join(VECTORS_FILE)
}

pub fn read_vectors(out_dir: &Path) -> io::Result<Option<VectorIndex>> {
    let path = vectors_path(out_dir);
    let mut file = match File::open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    if buf.len() < 8 {
        return Ok(None);
    }
    let Ok(header_len) = usize::try_from(u64::from_le_bytes(buf[0..8].try_into().unwrap())) else {
        return Ok(None);
    };
    if header_len > buf.len() - 8 {
        return Ok(None);
    }
    let Ok(head) = serde_json::from_slice::<RawHeader>(&buf[8..8 + header_len]) else {
        return Ok(None);
    };
    if head.version != 1
        || head.model != MODEL_ID
        || head.chunk != CHUNK_CHARS
        || head.dim == 0
        || head.files.iter().any(|f| !f.lines.len().is_multiple_of(2))
    {
        return Ok(None);
    }
    let mut chunks: usize = 0;
    for f in &head.files {
        let Some(next) = chunks.checked_add(f.lines.len() / 2) else {
            return Ok(None);
        };
        chunks = next;
    }
    let Some(expected_bytes) = chunks.checked_mul(head.dim).and_then(|n| n.checked_mul(2)) else {
        return Ok(None);
    };
    let payload = &buf[8 + header_len..];
    if payload.len() != expected_bytes {
        return Ok(None);
    }
    let data = payload
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&c| u16::from_le_bytes(c))
        .collect();
    Ok(Some(VectorIndex {
        model: head.model,
        dim: head.dim,
        files: head.files,
        data,
    }))
}

/// Rank files by their best chunk's cosine similarity with `query` (exact parity with `denseFiles`).
pub fn dense_files<F>(index: &VectorIndex, query: &[f32], mut keep: F) -> Vec<DenseFile>
where
    F: FnMut(&str) -> bool,
{
    let dim = index.dim;
    if query.len() != dim
        || !query.iter().all(|x| x.is_finite())
        || !query.iter().any(|&x| x != 0.0)
    {
        return Vec::new();
    }
    let f16 = f16_table();
    let mut best = Vec::new();
    let mut at = 0_usize;
    for f in &index.files {
        let n = f.lines.len() / 2;
        if !keep(&f.path) {
            at += n * dim;
            continue;
        }
        let mut top: Option<DenseFile> = None;
        for c in 0..n {
            let mut dot = 0.0_f64;
            for (i, &q) in query.iter().enumerate() {
                dot += f64::from(q) * f64::from(f16[index.data[at + i] as usize]);
            }
            at += dim;
            if dot != 0.0 && dot.is_finite() && top.as_ref().is_none_or(|t| dot > t.score) {
                top = Some(DenseFile {
                    path: f.path.clone(),
                    score: dot,
                    start: f.lines[2 * c],
                    end: f.lines[2 * c + 1],
                });
            }
        }
        if let Some(t) = top {
            best.push(t);
        }
    }
    best.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.path.cmp(&b.path))
    });
    best.truncate(DENSE_FILES);
    best
}

/// Strip trailing `:L<n>` or `:L<n>-L<m>` from a hit pointer.
pub fn pointer_file(pointer: &str) -> &str {
    let Some(colon) = pointer.rfind(":L") else {
        return pointer;
    };
    let tail = &pointer[colon + 2..];
    if let Some((a, b)) = tail.split_once("-L") {
        if !a.is_empty()
            && !b.is_empty()
            && a.bytes().all(|c| c.is_ascii_digit())
            && b.bytes().all(|c| c.is_ascii_digit())
        {
            return &pointer[..colon];
        }
    } else if !tail.is_empty() && tail.bytes().all(|c| c.is_ascii_digit()) {
        return &pointer[..colon];
    }
    pointer
}

/// Trait for lexical hits fused by `fuse_by_file`.
pub trait FuseHit: Clone {
    fn pointer(&self) -> &str;
    fn is_concept(&self) -> bool;
}

/// Reciprocal rank fusion over files, matching `src/ask/vectors.ts::fuseByFile`.
pub fn fuse_by_file<H, F>(hits: &[H], dense: &[DenseFile], limit: usize, mut dense_hit: F) -> Vec<H>
where
    H: FuseHit,
    F: FnMut(&DenseFile) -> H,
{
    let mut first_hit: HashMap<&str, usize> = HashMap::new();
    let mut lex_files: Vec<&str> = Vec::new();
    for (idx, h) in hits.iter().enumerate() {
        if h.is_concept() {
            continue;
        }
        let file = pointer_file(h.pointer());
        if let std::collections::hash_map::Entry::Vacant(e) = first_hit.entry(file) {
            e.insert(idx);
            lex_files.push(file);
        }
    }
    let lex_rank: HashMap<&str, usize> =
        lex_files.iter().enumerate().map(|(i, &f)| (f, i)).collect();
    let mut score: HashMap<&str, f64> = HashMap::new();
    for (i, &f) in lex_files.iter().enumerate() {
        *score.entry(f).or_insert(0.0) += 1.0 / (RRF_K + (i as f64) + 1.0);
    }
    for (i, d) in dense.iter().enumerate() {
        *score.entry(d.path.as_str()).or_insert(0.0) += 1.0 / (RRF_K + (i as f64) + 1.0);
    }
    let mut order: Vec<(&str, f64)> = score.into_iter().collect();
    order.sort_by(|a, b| {
        b.1.total_cmp(&a.1)
            .then_with(|| {
                lex_rank
                    .get(a.0)
                    .copied()
                    .unwrap_or(usize::MAX)
                    .cmp(&lex_rank.get(b.0).copied().unwrap_or(usize::MAX))
            })
            .then_with(|| a.0.cmp(b.0))
    });
    let dense_at: HashMap<&str, &DenseFile> = dense.iter().map(|d| (d.path.as_str(), d)).collect();
    let mut fused = Vec::new();
    let mut used: HashSet<usize> = HashSet::new();
    for (f, _) in order {
        if let Some(&idx) = first_hit.get(f) {
            used.insert(idx);
            fused.push(hits[idx].clone());
        } else if let Some(&d) = dense_at.get(f) {
            fused.push(dense_hit(d));
        }
    }
    for (idx, h) in hits.iter().enumerate() {
        if !used.contains(&idx) && !h.is_concept() {
            fused.push(h.clone());
        }
    }
    for (idx, h) in hits.iter().enumerate() {
        if h.is_concept() {
            let pos = idx.min(fused.len());
            fused.insert(pos, h.clone());
        }
    }
    fused.truncate(limit);
    fused
}
