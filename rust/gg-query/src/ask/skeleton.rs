//! Signatures-only file API view (`skeleton`), mirroring `src/ask/ask.ts::skeleton`.

use std::io;

use serde::Serialize;

use crate::brand::cmd;
use crate::graph::{Savings, span_range, with_savings};
use crate::store::GraphStore;

#[derive(Debug, Clone, Serialize)]
pub struct SkeletonEntry {
    pub name: String,
    pub kind: String,
    pub span: String,
    pub signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkeletonResult {
    pub file: String,
    pub entries: Vec<SkeletonEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved: Option<Savings>,
}

/// Build a signatures-only view of `file` (exact repo-relative path or unique basename).
pub fn run_skeleton(store: Option<&GraphStore>, file: &str) -> io::Result<SkeletonResult> {
    let Some(store) = store else {
        return Ok(SkeletonResult {
            file: file.to_string(),
            entries: Vec::new(),
            note: Some(format!(
                "no wiring graph — run `{}` first",
                cmd("graft build")
            )),
            saved: None,
        });
    };

    store.with_read_snapshot(|s| {
        let mut defs: Vec<_> = s
            .nodes_by_path(file)?
            .into_iter()
            .filter(|n| n.kind != "file")
            .collect();

        if defs.is_empty() {
            let mut matches = s.find_matching_paths(file)?;
            matches.sort();
            if matches.len() > 1 {
                return Ok(SkeletonResult {
                    file: file.to_string(),
                    entries: Vec::new(),
                    note: Some(format!("ambiguous — matches: {}", matches.join(", "))),
                    saved: None,
                });
            }
            if let Some(resolved) = matches.first() {
                defs = s
                    .nodes_by_path(resolved)?
                    .into_iter()
                    .filter(|n| n.kind != "file")
                    .collect();
            }
        }

        if defs.is_empty() {
            return Ok(SkeletonResult {
                file: file.to_string(),
                entries: Vec::new(),
                note: Some("no definitions indexed for this file".to_string()),
                saved: None,
            });
        }

        defs.sort_by_key(|n| span_range(&n.span).map_or(0, |(start, _)| start));
        let resolved_file = defs[0].path.clone();
        let saved = s.savings_for_paths([resolved_file.as_str()])?;
        let entries = defs
            .into_iter()
            .map(|n| {
                let summary = n
                    .summary
                    .as_deref()
                    .and_then(|s| s.lines().next())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                SkeletonEntry {
                    name: n.name,
                    kind: n.kind,
                    span: n.span,
                    signature: n.signature,
                    summary,
                }
            })
            .collect();

        Ok(SkeletonResult {
            file: resolved_file,
            entries,
            note: None,
            saved,
        })
    })
}

/// Render a `SkeletonResult` as compact markdown matching `trail skeleton` / `graft skeleton`.
pub fn format_skeleton(r: &SkeletonResult) -> String {
    let head = format!("{} — {}", cmd("graft skeleton"), r.file);
    if r.entries.is_empty() {
        let msg = r.note.as_deref().unwrap_or("no definitions.");
        return format!("{head}\n\n{msg}\n");
    }
    let mut lines = Vec::with_capacity(r.entries.len() + 1);
    lines.push(head);
    for e in &r.entries {
        let sig = match &e.signature {
            Some(s) if !s.is_empty() => format!("  {s}"),
            _ => String::new(),
        };
        let sum = match &e.summary {
            Some(s) if !s.is_empty() => format!(" — {s}"),
            _ => String::new(),
        };
        lines.push(format!("- {}  {} {}{sig}{sum}", e.span, e.kind, e.name));
    }
    let body = lines.join("\n");
    format!("{}\n", with_savings(&body, r.saved.as_ref()))
}
