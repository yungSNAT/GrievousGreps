//! Left-behind caller detection for declaration changes in `blast`.

use std::collections::HashMap;
use std::path::Path;

use crate::evidence::blank_comment_lines;
use crate::graph::{EdgeV1, NodeV1, js_locale_cmp, span_range};

use super::declaration::{call_end, touches};
use super::diff::ChangedFile;
use super::{LeftBehind, LeftBehindSeed, read_lines_safe};

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn matches_call_tail(after: &str) -> bool {
    let mut s = after.trim_start();
    if let Some(rest) = s.strip_prefix('!').or_else(|| s.strip_prefix("?.")) {
        s = rest.trim_start();
    }
    if let Some(rest) = s.strip_prefix('<') {
        let mut depth = 1_usize;
        let mut cut = None;
        for (i, ch) in rest.char_indices() {
            match ch {
                '(' | ')' => return false,
                '<' => depth += 1,
                '>' => {
                    depth -= 1;
                    if depth == 0 {
                        cut = Some(i + 1);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(end) = cut else {
            return false;
        };
        s = rest[end..].trim_start();
    }
    s.starts_with('(')
}

fn contains_word_ascii(line: &str, name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let bytes = line.as_bytes();
    let mut from = 0;
    while let Some(rel) = line[from..].find(name) {
        let at = from + rel;
        let end = at + name.len();
        let left_ok = at == 0 || !is_word_byte(bytes[at - 1]);
        let right_ok = end == bytes.len() || !is_word_byte(bytes[end]);
        if left_ok && right_ok {
            return true;
        }
        let step = line[at..].chars().next().map_or(1, char::len_utf8);
        from = at + step;
    }
    false
}

fn call_columns(code: &str, name: &str) -> Vec<usize> {
    if name.is_empty() {
        return Vec::new();
    }
    let bytes = code.as_bytes();
    let mut cols = Vec::new();
    let mut from = 0;
    while let Some(rel) = code[from..].find(name) {
        let at = from + rel;
        let end = at + name.len();
        let left_ok = at == 0 || !is_word_byte(bytes[at - 1]);
        let right_ok = end == bytes.len() || !is_word_byte(bytes[end]);
        if left_ok && right_ok && matches_call_tail(&code[end..]) {
            cols.push(at);
        }
        let step = code[at..].chars().next().map_or(1, char::len_utf8);
        from = at + step;
    }
    cols
}

enum CallSiteResult {
    Edited,
    Line(usize),
    None,
}

fn call_site(
    caller: &NodeV1,
    target_name: &str,
    file: Option<&ChangedFile>,
    root: &Path,
    cache: &mut HashMap<String, Option<Vec<String>>>,
) -> CallSiteResult {
    let Some((start, end)) = span_range(&caller.span) else {
        return CallSiteResult::None;
    };
    if let Some(lines) = read_lines_safe(root, &caller.path, cache) {
        let last = end.min(lines.len());
        if start >= 1 && start <= last {
            let code = blank_comment_lines(&lines, start, last, &caller.path);
            let mut calls = 0_usize;
            let mut mentions = Vec::new();
            for n in start..=last {
                let found = call_columns(&code[n - 1], target_name);
                for at in &found {
                    calls += 1;
                    if !touches(file, n, call_end(&code, n, *at, last)) {
                        return CallSiteResult::Line(n);
                    }
                }
                if found.is_empty() && contains_word_ascii(&code[n - 1], target_name) {
                    mentions.push(n);
                }
            }
            if calls > 0 {
                return CallSiteResult::Edited;
            }
            if !mentions.is_empty() {
                if mentions.iter().any(|&n| touches(file, n, n)) {
                    return CallSiteResult::Edited;
                }
                return CallSiteResult::Line(mentions[0]);
            }
        }
    }
    if touches(file, start, end) {
        CallSiteResult::Edited
    } else {
        CallSiteResult::None
    }
}

pub(super) fn callers_left_behind(
    nodes: &[NodeV1],
    edges: &[EdgeV1],
    declared: &[NodeV1],
    changed: &[ChangedFile],
    root: &Path,
    cache: &mut HashMap<String, Option<Vec<String>>>,
) -> Vec<LeftBehind> {
    if declared.is_empty() {
        return Vec::new();
    }
    let by_id: HashMap<&str, &NodeV1> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut watched: HashMap<String, NodeV1> =
        declared.iter().map(|n| (n.id.clone(), n.clone())).collect();

    for seed in declared {
        if seed.kind != "method"
            || !matches!(seed.name.as_str(), "constructor" | "__init__")
            || seed.owner.is_none()
        {
            continue;
        }
        let seed_span = span_range(&seed.span);
        let owner_name = seed.owner.as_deref().unwrap_or("");
        if let Some(owner) = nodes.iter().find(|n| {
            n.kind == "class"
                && n.path == seed.path
                && n.name == owner_name
                && matches!((span_range(&n.span), seed_span), (Some(b), Some(s)) if b.0 <= s.0 && b.1 >= s.1)
        }) {
            watched.entry(owner.id.clone()).or_insert_with(|| seed.clone());
        }
    }

    let file_of: HashMap<&str, &ChangedFile> =
        changed.iter().map(|f| (f.path.as_str(), f)).collect();
    let mut found: HashMap<String, LeftBehind> = HashMap::new();

    for e in edges {
        if e.relation != "calls" || e.source == e.target {
            continue;
        }
        let Some(seed) = watched.get(&e.target) else {
            continue;
        };
        let Some(&target) = by_id.get(e.target.as_str()) else {
            continue;
        };
        let Some(&caller) = by_id.get(e.source.as_str()) else {
            continue;
        };
        let key = format!("{}\0{}", seed.id, caller.id);
        let is_inferred = e.confidence == "inferred" || e.confidence == "likely";
        if let Some(prev) = found.get_mut(&key) {
            if !is_inferred {
                prev.inferred = false;
            }
            continue;
        }
        let line = match call_site(
            caller,
            &target.name,
            file_of.get(caller.path.as_str()).copied(),
            root,
            cache,
        ) {
            CallSiteResult::Edited => continue,
            CallSiteResult::Line(n) => Some(n),
            CallSiteResult::None => None,
        };
        found.insert(
            key,
            LeftBehind {
                seed: LeftBehindSeed {
                    id: seed.id.clone(),
                    name: seed.name.clone(),
                },
                id: caller.id.clone(),
                name: caller.name.clone(),
                kind: caller.kind.clone(),
                path: caller.path.clone(),
                span: caller.span.clone(),
                line,
                inferred: is_inferred,
            },
        );
    }

    let mut out: Vec<LeftBehind> = found.into_values().collect();
    out.sort_by(|a, b| {
        js_locale_cmp(&a.path, &b.path)
            .then_with(|| a.line.unwrap_or(0).cmp(&b.line.unwrap_or(0)))
            .then_with(|| js_locale_cmp(&a.name, &b.name))
            .then_with(|| js_locale_cmp(&a.seed.name, &b.seed.name))
    });
    out
}
