//! Declaration-change detection and line-range touch helpers for `blast`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::graph::{NodeV1, span_range};

use super::diff::{ChangedFile, Hunk};
use super::read_lines_safe;

const MAX_WRAPPED_LINES: usize = 40;

pub(super) struct Squashed {
    pub(super) text: String,
    starts: HashSet<usize>,
}

fn drop_closing_commas(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b',' {
            let mut j = i + 1;
            while j < text.len() && text[j..].chars().next().is_some_and(char::is_whitespace) {
                j += text[j..].chars().next().unwrap().len_utf8();
            }
            if matches!(bytes.get(j), Some(b')' | b']' | b'}' | b'>')) {
                i += 1;
                continue;
            }
        }
        let ch = text[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn squash(text: &str) -> String {
    drop_closing_commas(text)
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect()
}

pub(super) fn squash_lines(lines: &[String]) -> Squashed {
    let joined = lines.join("\n");
    let cleaned = drop_closing_commas(&joined);
    let mut text = String::new();
    let mut starts = HashSet::new();
    for line in cleaned.split('\n') {
        starts.insert(text.len());
        for ch in line.chars() {
            if !ch.is_whitespace() {
                text.push(ch);
            }
        }
    }
    Squashed { text, starts }
}

fn at_line_start(hay: &Squashed, needle: &str) -> bool {
    if needle.is_empty() {
        return hay.starts.contains(&0);
    }
    let mut from = 0;
    while let Some(rel) = hay.text[from..].find(needle) {
        let abs = from + rel;
        if hay.starts.contains(&abs) {
            return true;
        }
        let step = hay.text[abs..].chars().next().map_or(1, char::len_utf8);
        from = abs + step;
    }
    false
}

fn pure_deletion(h: &Hunk) -> bool {
    h.dropped == 0 && !h.lines.iter().any(|l| l.sign == "+")
}

pub(super) fn touches(file: Option<&ChangedFile>, start: usize, end: usize) -> bool {
    let Some(f) = file else {
        return false;
    };
    if f.hunks.is_empty() {
        return f.ranges.iter().any(|r| r.start <= end && r.end >= start);
    }
    f.hunks.iter().any(|h| {
        if pure_deletion(h) {
            h.start >= start && h.start < end
        } else {
            h.start <= end && h.end >= start
        }
    })
}

fn pre_image(file: &ChangedFile, lines: &[String], start: usize, end: usize) -> Squashed {
    let near: Vec<&Hunk> = file
        .hunks
        .iter()
        .filter(|h| h.start <= end && h.end >= start)
        .collect();
    let mut from = start;
    for h in &near {
        if !pure_deletion(h) && h.start < from {
            from = h.start;
        }
    }
    let mut to = end;
    for h in &near {
        if h.end > to {
            to = h.end;
        }
    }
    let mut old = Vec::new();
    let mut n = from;
    while n <= to {
        if let Some(rew) = near.iter().find(|h| !pure_deletion(h) && h.start == n) {
            for l in &rew.lines {
                if l.sign == "-" {
                    old.push(l.text.clone());
                }
            }
            n = rew.end + 1;
            continue;
        }
        if n >= 1 && n <= lines.len() {
            old.push(lines[n - 1].clone());
        }
        for h in &near {
            if pure_deletion(h) && h.start == n {
                for l in &h.lines {
                    if l.sign == "-" {
                        old.push(l.text.clone());
                    }
                }
            }
        }
        n += 1;
    }
    squash_lines(&old)
}

pub(super) fn call_end(lines: &[String], n: usize, at: usize, last: usize) -> usize {
    let mut depth = 0_usize;
    let limit = last.min(n.saturating_add(MAX_WRAPPED_LINES - 1));
    for (offset, line) in lines
        .iter()
        .enumerate()
        .take(limit)
        .skip(n.saturating_sub(1))
    {
        let slice = if offset + 1 == n {
            &line[at..]
        } else {
            line.as_str()
        };
        for ch in slice.chars() {
            if ch == '(' {
                depth += 1;
            } else if ch == ')' && depth > 0 {
                depth -= 1;
                if depth == 0 {
                    return offset + 1;
                }
            }
        }
        if depth == 0 {
            return n;
        }
    }
    n
}

fn declaration(node: &NodeV1, start: usize, end: usize, lines: &[String]) -> (usize, String) {
    if start == 0 || start > lines.len() {
        return (start, String::new());
    }
    let last = end
        .min(start.saturating_add(MAX_WRAPPED_LINES - 1))
        .min(lines.len());
    let sig = node.signature.as_deref().map(squash).unwrap_or_default();
    if !sig.is_empty() {
        for n in start..=last {
            let text = squash_lines(&lines[start - 1..n]).text;
            if let Some(at) = text.find(&sig) {
                let open_parens = sig.bytes().filter(|&b| b == b'(').count();
                let close_parens = sig.bytes().filter(|&b| b == b')').count();
                if open_parens <= close_parens {
                    let end_byte = at + sig.len();
                    let next_len = text[end_byte..].chars().next().map_or(0, char::len_utf8);
                    return (n, text[..end_byte + next_len].to_string());
                }
                let decl_end = call_end(lines, start, 0, last).max(n);
                return (decl_end, squash_lines(&lines[start - 1..decl_end]).text);
            }
        }
    }
    (
        start,
        squash(lines.get(start - 1).map_or("", String::as_str)),
    )
}

pub(super) fn declaration_changed(
    node: &NodeV1,
    file: &ChangedFile,
    removed: &[Squashed],
    root: &Path,
    cache: &mut HashMap<String, Option<Vec<String>>>,
) -> bool {
    let Some((start, end)) = span_range(&node.span) else {
        return false;
    };
    if start == 0 {
        return false;
    }
    let Some(lines) = read_lines_safe(root, &node.path, cache) else {
        return touches(Some(file), start, start);
    };
    if start > lines.len() {
        return touches(Some(file), start, start);
    }
    let (decl_end, decl_text) = declaration(node, start, end, &lines);
    if !touches(Some(file), start, decl_end) {
        return false;
    }
    if file.hunks.is_empty() {
        return true;
    }
    if at_line_start(&pre_image(file, &lines, start, decl_end), &decl_text) {
        return false;
    }
    !removed.iter().any(|old| at_line_start(old, &decl_text))
}

pub(super) fn build_removed_squashed(changed: &[ChangedFile]) -> Vec<Squashed> {
    changed
        .iter()
        .flat_map(|f| {
            f.hunks.iter().map(|h| {
                let rem: Vec<String> = h
                    .lines
                    .iter()
                    .filter(|l| l.sign == "-")
                    .map(|l| l.text.clone())
                    .collect();
                squash_lines(&rem)
            })
        })
        .collect()
}
