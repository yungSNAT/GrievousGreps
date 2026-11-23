//! Full native `ask` engine (structural + lexical BM25/PPR + semantic RRF hybrid)
//! and `skeleton` view, matching `src/ask/ask.ts`.

pub mod format;
pub mod lexical;
pub mod skeleton;
pub mod structural;

use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::embed::SafetensorsEmbedder;
use crate::graph::{
    Savings, is_deploy_file, normalize_path_prefix, path_under_prefix, safe_resolve_inside,
    scope_of, scopes_here_clause, serialize_js_f64, serialize_opt_js_f64, span_range,
};
use crate::store::GraphStore;
use crate::vectors::{DenseFile, FuseHit, dense_files, fuse_by_file, read_vectors};

pub use format::format_ask;
pub use skeleton::{SkeletonEntry, SkeletonResult, format_skeleton, run_skeleton};

const SEMANTIC_LEXICAL_DEPTH: usize = 10;
const MAX_SPAN_LINES: usize = 80;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskMode {
    Structural,
    Lexical,
    Empty,
}

impl AskMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Structural => "structural",
            Self::Lexical => "lexical",
            Self::Empty => "empty",
        }
    }
}

impl Serialize for AskMode {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AskHit {
    pub kind: String,
    pub title: String,
    pub pointer: String,
    pub snippet: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related: Option<Vec<String>>,
    #[serde(serialize_with = "serialize_js_f64")]
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

impl FuseHit for AskHit {
    fn pointer(&self) -> &str {
        &self.pointer
    }

    fn is_concept(&self) -> bool {
        self.kind == "concept"
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ScopeMiss {
    pub scope: String,
    #[serde(rename = "bestId")]
    pub best_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AskScopes {
    pub federated: Vec<String>,
    #[serde(rename = "alsoMatched")]
    pub also_matched: Vec<ScopeMiss>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AskResult {
    pub query: String,
    pub mode: AskMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    pub hits: Vec<AskHit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved: Option<Savings>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_opt_js_f64"
    )]
    pub coverage: Option<f64>,
    #[serde(
        rename = "coverageStrong",
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_opt_js_f64"
    )]
    pub coverage_strong: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scopes: Option<AskScopes>,
}

#[derive(Debug, Clone)]
pub struct AskOptions<'a> {
    pub limit: usize,
    pub source: bool,
    pub full: bool,
    pub graph_rank: bool,
    pub in_prefix: Option<&'a str>,
    pub model_dir: Option<&'a Path>,
    pub semantic: bool,
}

fn is_valid_model_dir(dir: &Path) -> bool {
    dir.join("model.safetensors").is_file() && dir.join("tokenizer.json").is_file()
}

/// Locate the shipped Model2Vec directory if `--model` was not passed explicitly.
pub fn discover_model_dir(explicit: Option<&Path>, repo: &Path) -> Option<PathBuf> {
    if let Some(d) = explicit {
        return is_valid_model_dir(d).then(|| d.to_path_buf());
    }
    let rel = Path::new("models").join("potion-code-16M-v2");
    if let Ok(exe) = env::current_exe() {
        for ancestor in exe.ancestors().skip(1).take(6) {
            let cand = ancestor.join(&rel);
            if is_valid_model_dir(&cand) {
                return Some(cand);
            }
        }
    }
    let repo_cand = repo.join(&rel);
    if is_valid_model_dir(&repo_cand) {
        return Some(repo_cand);
    }
    None
}

fn semantic_enabled(explicit_on: bool, model_dir: Option<&Path>) -> bool {
    if !explicit_on || env::var("TRAIL_SEMANTIC").ok().as_deref() == Some("0") {
        return false;
    }
    model_dir.is_some_and(is_valid_model_dir)
}

fn parse_pointer_span(pointer: &str) -> Option<(&str, usize, usize)> {
    let colon = pointer.rfind(":L")?;
    let tail = &pointer[colon + 2..];
    let (a, b) = tail.split_once("-L")?;
    let from = a.parse().ok()?;
    let to = b.parse().ok()?;
    Some((&pointer[..colon], from, to))
}

fn slice_span(root: &Path, rel: &str, from: usize, to: usize) -> Option<String> {
    let abs = safe_resolve_inside(root, rel)?;
    let raw = fs::read_to_string(abs).ok()?.replace("\r\n", "\n");
    let lines: Vec<&str> = raw.split('\n').collect();
    if lines.is_empty() {
        return None;
    }
    let start = from.max(1);
    let end = to.min(lines.len());
    if start > end {
        return None;
    }
    let slice = &lines[start - 1..end];
    if slice.len() > MAX_SPAN_LINES {
        let mut head: Vec<String> = slice[..MAX_SPAN_LINES]
            .iter()
            .map(|l| (*l).to_string())
            .collect();
        head.push(format!(
            "… (+{} more lines; open {rel}:L{start}-L{end})",
            slice.len() - MAX_SPAN_LINES
        ));
        return Some(head.join("\n"));
    }
    Some(slice.join("\n"))
}

fn inline_source(root: &Path, hits: &mut [AskHit], store: Option<&GraphStore>, full: bool) {
    let mut crux_cache: HashMap<String, Option<String>> = HashMap::new();
    for h in hits {
        let Some((path, from, to)) = parse_pointer_span(&h.pointer) else {
            continue;
        };
        if is_deploy_file(path) {
            continue;
        }
        if !full && let Some(s) = store {
            let crux = crux_cache
                .entry(h.pointer.clone())
                .or_insert_with(|| {
                    s.nodes_by_path(path).ok().and_then(|nodes| {
                        nodes
                            .into_iter()
                            .filter(|n| format!("{}:{}", n.path, n.span) == h.pointer)
                            .filter_map(|n| n.crux.map(|c| c.code))
                            .rfind(|code| !code.is_empty())
                    })
                })
                .clone();
            if let Some(code) = crux {
                h.code = Some(format!(
                    "{code}\n… (crux — full definition at {}; rerun with --full)",
                    h.pointer
                ));
                continue;
            }
        }
        if let Some(code) = slice_span(root, path, from, to)
            && !code.is_empty()
        {
            h.code = Some(code);
        }
    }
}

fn hit_files(hits: &[AskHit]) -> Vec<String> {
    let mut files = HashSet::new();
    for h in hits {
        if let Some((path, _, _)) = parse_pointer_span(&h.pointer) {
            files.insert(path.to_string());
            continue;
        }
        for part in h.pointer.split(',').map(str::trim) {
            if !part.is_empty() && !part.contains(' ') {
                files.insert(part.to_string());
            }
        }
    }
    files.into_iter().collect()
}

fn with_semantic(
    mut result: AskResult,
    store: &GraphStore,
    out_dir: &Path,
    query: &str,
    limit: usize,
    in_prefix: Option<&str>,
    model_dir: &Path,
) -> Result<AskResult, String> {
    let skip = |mut res: AskResult, why: String| -> AskResult {
        let line = format!("semantic ranking skipped: {why}");
        res.note = match res.note {
            Some(prev) => Some(format!("{prev}\n{line}")),
            None => Some(line),
        };
        res
    };

    let index = match read_vectors(out_dir) {
        Ok(Some(idx)) => idx,
        Ok(None) => {
            return Ok(skip(
                result,
                "no vectors yet — run `trail build`".to_string(),
            ));
        }
        Err(e) => return Ok(skip(result, e.to_string())),
    };
    let mut emb = match SafetensorsEmbedder::open(model_dir, false) {
        Ok(e) => e,
        Err(e) => return Ok(skip(result, format!("the model is unreadable ({e})"))),
    };
    let qvec = match emb.embed(query) {
        Ok(v) => v,
        Err(e) => return Ok(skip(result, format!("the model is unreadable ({e})"))),
    };

    let scopes = store.scopes().map_err(|e| e.to_string())?;
    let scopes_in_range = if let Some(prefix) = in_prefix {
        let nodes = store.all_nodes_lite().map_err(|e| e.to_string())?;
        let distinct: HashSet<&str> = nodes
            .iter()
            .filter(|n| n.kind == "file" && path_under_prefix(&n.path, prefix))
            .map(|n| scope_of(&n.path, &scopes))
            .collect();
        distinct.len()
    } else {
        scopes.len()
    };

    let mut admitted: HashSet<String> = HashSet::new();
    if let Some(ref sc) = result.scopes {
        for f in &sc.federated {
            admitted.insert(f.clone());
        }
    }
    for h in &result.hits {
        if let Some(ref sc) = h.scope {
            admitted.insert(sc.clone());
        }
    }

    let dense = dense_files(&index, &qvec, |p| {
        let in_r = in_prefix.is_none_or(|pref| path_under_prefix(p, pref));
        in_r && (scopes_in_range < 2 || admitted.contains(scope_of(p, &scopes)))
    });
    if dense.is_empty() {
        return Ok(result);
    }

    let scoped = result.hits.iter().any(|h| h.scope.is_some());
    let hits = fuse_by_file(&result.hits, &dense, limit, |d| {
        build_dense_hit(store, d, &scopes, scoped)
    });

    if result.mode != AskMode::Empty || hits.is_empty() {
        result.hits = hits;
        return Ok(result);
    }
    let cleaned_note = result.note.and_then(|n| {
        let kept: Vec<&str> = n
            .lines()
            .filter(|l| !l.starts_with("no matching nodes"))
            .collect();
        if kept.is_empty() {
            None
        } else {
            Some(kept.join("\n"))
        }
    });
    result.hits = hits;
    result.mode = AskMode::Lexical;
    result.coverage = Some(0.0);
    result.coverage_strong = Some(0.0);
    result.note = cleaned_note;
    Ok(result)
}

fn build_dense_hit(
    store: &GraphStore,
    d: &DenseFile,
    scopes: &[crate::graph::ScopeV1],
    scoped: bool,
) -> AskHit {
    let best = store.nodes_by_path(&d.path).ok().and_then(|nodes| {
        let mut chosen: Option<(crate::graph::NodeV1, usize)> = None;
        for n in nodes {
            if n.kind == "file" {
                continue;
            }
            let Some((start, end)) = span_range(&n.span) else {
                continue;
            };
            if start > d.start || end < d.start {
                continue;
            }
            let size = end - start;
            if chosen.as_ref().is_none_or(|(_, best_sz)| size < *best_sz) {
                chosen = Some((n, size));
            }
        }
        chosen.map(|(n, _)| n)
    });

    let scope = scoped.then(|| scope_of(&d.path, scopes).to_string());
    match best {
        Some(n) => {
            let snippet = n
                .summary
                .as_deref()
                .and_then(|s| s.lines().next())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .or(n.signature)
                .unwrap_or_default();
            AskHit {
                kind: "symbol".to_string(),
                title: format!("{} · {}", n.name, n.kind),
                pointer: format!("{}:{}", n.path, n.span),
                snippet,
                relation: None,
                related: None,
                score: d.score,
                code: None,
                scope,
            }
        }
        None => AskHit {
            kind: "symbol".to_string(),
            title: format!("{} · file", d.path),
            pointer: format!("{}:L{}-L{}", d.path, d.start, d.end),
            snippet: String::new(),
            relation: None,
            related: None,
            score: d.score,
            code: None,
            scope,
        },
    }
}

/// Answer a query from the SQLite graph store and optional semantic vectors.
pub fn run_ask(
    repo: &Path,
    out_dir: &Path,
    query: &str,
    opts: &AskOptions<'_>,
) -> Result<AskResult, String> {
    let store = GraphStore::open_or_sync(out_dir).map_err(|e| e.to_string())?;
    let model_dir = discover_model_dir(opts.model_dir, repo);
    let use_semantic = store.is_some() && semantic_enabled(opts.semantic, model_dir.as_deref());
    let lex_limit = if use_semantic {
        opts.limit.max(SEMANTIC_LEXICAL_DEPTH)
    } else {
        opts.limit
    };
    let in_prefix = opts.in_prefix.map(normalize_path_prefix);
    let in_ref = in_prefix.as_deref().filter(|s| !s.is_empty());

    let mut result = match store.as_ref() {
        Some(s) => s
            .with_read_snapshot(|snap| {
                if let Some(prefix) = in_ref
                    && !snap.has_indexed_prefix(prefix)?
                {
                    let scopes = snap.scopes()?;
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        format!(
                            "nothing indexed under \"{prefix}/\"{} (or any path prefix)",
                            scopes_here_clause(&scopes)
                        ),
                    ));
                }
                match structural::run_structural(query, snap, opts.limit, in_ref)? {
                    structural::StructuralOutcome::Result(res) => Ok(res),
                    structural::StructuralOutcome::Fallthrough(note) => {
                        let mut res = lexical::run_lexical(
                            query,
                            out_dir,
                            Some(snap),
                            lex_limit,
                            opts.graph_rank,
                            in_ref,
                            true,
                        )?;
                        res.note = match res.note {
                            Some(prev) => Some(format!("{note}\n{prev}")),
                            None => Some(note),
                        };
                        Ok(res)
                    }
                    structural::StructuralOutcome::None => lexical::run_lexical(
                        query,
                        out_dir,
                        Some(snap),
                        lex_limit,
                        opts.graph_rank,
                        in_ref,
                        true,
                    ),
                }
            })
            .map_err(|e| e.to_string())?,
        None => lexical::run_lexical(
            query,
            out_dir,
            None,
            lex_limit,
            opts.graph_rank,
            in_ref,
            true,
        )
        .map_err(|e| e.to_string())?,
    };

    if use_semantic
        && result.mode != AskMode::Structural
        && let (Some(s), Some(mdir)) = (store.as_ref(), model_dir.as_deref())
    {
        result = with_semantic(result, s, out_dir, query, opts.limit, in_ref, mdir)?;
    }

    if result.hits.len() > opts.limit {
        result.hits.truncate(opts.limit);
    }

    if opts.source {
        inline_source(repo, &mut result.hits, store.as_ref(), opts.full);
        if let Some(ref s) = store {
            let files = hit_files(&result.hits);
            result.saved = s
                .savings_for_paths(files.iter().map(String::as_str))
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(result)
}
