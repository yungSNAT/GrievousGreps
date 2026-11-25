//! Semantic RRF hybrid fusion for `ask` using F16 Model2Vec embeddings and `ask-vectors.bin`.
//!
//! Mirrors `withSemantic()` in `src/ask/ask.ts`.

use std::collections::HashSet;
use std::path::Path;

use crate::ask::{AskHit, AskMode, AskResult};
use crate::brand::cmd;
use crate::embed::SafetensorsEmbedder;
use crate::graph::{NodeV1, ScopeV1, path_under_prefix, scope_of, span_range};
use crate::store::GraphStore;
use crate::vectors::{DenseFile, dense_files, fuse_by_file, read_vectors};

pub fn with_semantic(
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
                format!("no vectors yet — run `{}`", cmd("graft build")),
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

fn build_dense_hit(store: &GraphStore, d: &DenseFile, scopes: &[ScopeV1], scoped: bool) -> AskHit {
    let best = store.nodes_by_path(&d.path).ok().and_then(|nodes| {
        let mut chosen: Option<(NodeV1, usize)> = None;
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
                score_first: false,
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
            score_first: false,
        },
    }
}
