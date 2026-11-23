//! Structural intent detection and edge-walk routing for `ask`.
//!
//! Mirrors `structural()`, `findSubjectNodes()` and `subjectWords()` in `src/ask/ask.ts`.

use std::collections::HashSet;
use std::io;

use unicode_general_category::{GeneralCategory, get_general_category};

use crate::ask::{AskHit, AskMode, AskResult};
use crate::graph::{NodeV1, path_under_prefix};
use crate::store::GraphStore;

pub enum StructuralOutcome {
    Result(AskResult),
    Fallthrough(String),
    None,
}

fn is_ascii_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn ascii_words(s: &str) -> Vec<&str> {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if is_ascii_word(bytes[i]) {
            let start = i;
            while i < bytes.len() && is_ascii_word(bytes[i]) {
                i += 1;
            }
            out.push(&s[start..i]);
        } else {
            i += 1;
        }
    }
    out
}

fn has_word_seq(words: &[&str], pat: &[&str]) -> bool {
    words.windows(pat.len()).any(|w| w == pat)
}

/// Mirrors `/\b(caller|callers|calls?\s+into|who\s+calls|what\s+calls|called\s+by|used\s+by|uses)\b/`.
pub fn wants_incoming(query: &str) -> bool {
    let w = ascii_words(query);
    w.iter()
        .any(|&x| matches!(x, "caller" | "callers" | "uses"))
        || has_word_seq(&w, &["call", "into"])
        || has_word_seq(&w, &["calls", "into"])
        || has_word_seq(&w, &["who", "calls"])
        || has_word_seq(&w, &["what", "calls"])
        || has_word_seq(&w, &["called", "by"])
        || has_word_seq(&w, &["used", "by"])
}

/// Mirrors `/\b(callee|callees|what\s+does\s+\w+\s+call|calls\s+what|imports?|depends\s+on)\b/`.
pub fn wants_outgoing(query: &str) -> bool {
    let w = ascii_words(query);
    if w.iter()
        .any(|&x| matches!(x, "callee" | "callees" | "import" | "imports"))
        || has_word_seq(&w, &["calls", "what"])
        || has_word_seq(&w, &["depends", "on"])
    {
        return true;
    }
    w.windows(4)
        .any(|win| win[0] == "what" && win[1] == "does" && win[3] == "call")
}

fn is_subject_char(ch: char) -> bool {
    ch == '.'
        || ch == '_'
        || matches!(
            get_general_category(ch),
            GeneralCategory::UppercaseLetter
                | GeneralCategory::LowercaseLetter
                | GeneralCategory::TitlecaseLetter
                | GeneralCategory::ModifierLetter
                | GeneralCategory::OtherLetter
                | GeneralCategory::DecimalNumber
                | GeneralCategory::LetterNumber
                | GeneralCategory::OtherNumber
        )
}

fn subject_words(query: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in query.chars() {
        if is_subject_char(ch) {
            cur.push(ch);
        } else if !cur.is_empty() {
            let word = std::mem::take(&mut cur);
            if seen.insert(word.clone()) {
                out.push(word);
            }
        }
    }
    if !cur.is_empty() && seen.insert(cur.clone()) {
        out.push(cur);
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.encode_utf16().count()));
    out
}

fn find_subject_nodes(
    query: &str,
    store: &GraphStore,
    in_prefix: Option<&str>,
) -> io::Result<(Vec<NodeV1>, String)> {
    let words = subject_words(query);
    for w in &words {
        let mut nodes = store.resolve_symbol(w, None)?;
        if let Some(prefix) = in_prefix {
            nodes.retain(|n| path_under_prefix(&n.path, prefix));
        }
        if !nodes.is_empty() {
            return Ok((nodes, w.clone()));
        }
    }
    let tried = words.first().cloned().unwrap_or_else(|| query.to_string());
    Ok((Vec::new(), tried))
}

fn fallthrough_note_for(subject: &str) -> String {
    format!(
        "structural index: no entries for '{subject}' — showing lexical matches; \
         for precise edges try trail callers '{subject}', or trail grep '{subject}' \
         for every reference (loosen the pattern if it returns nothing)"
    )
}

pub fn run_structural(
    query: &str,
    store: &GraphStore,
    limit: usize,
    in_prefix: Option<&str>,
) -> io::Result<StructuralOutcome> {
    let wants_in = wants_incoming(query);
    let wants_out = wants_outgoing(query);
    if !wants_in && !wants_out {
        return Ok(StructuralOutcome::None);
    }

    let (subjects, tried) = find_subject_nodes(query, store, in_prefix)?;
    if subjects.is_empty() {
        return Ok(StructuralOutcome::Fallthrough(fallthrough_note_for(&tried)));
    }

    let ids: HashSet<String> = subjects.iter().map(|n| n.id.clone()).collect();
    let outgoing = wants_out && !wants_in;
    let (matched_any, rows) = store.structural_hits_bounded(&ids, outgoing, limit)?;
    if !matched_any {
        return Ok(StructuralOutcome::Fallthrough(fallthrough_note_for(
            &subjects[0].name,
        )));
    }

    let kind = if outgoing { "callee" } else { "caller" };
    let mut hits = Vec::with_capacity(rows.len());
    for r in rows {
        let (title, pointer, snippet) = match (r.name, r.path, r.span) {
            (Some(name), Some(path), Some(span)) => {
                let snip = r
                    .summary
                    .as_deref()
                    .and_then(|s| s.lines().next())
                    .map(|l| l.trim().to_string())
                    .or(r.signature)
                    .unwrap_or_default();
                (name, format!("{path}:{span}"), snip)
            }
            _ => (r.other_id.clone(), r.other_id, String::new()),
        };
        hits.push(AskHit {
            kind: kind.to_string(),
            title,
            pointer,
            snippet,
            relation: Some(r.relation),
            related: None,
            score: 1.0,
            code: None,
            scope: None,
        });
    }

    let subject_name = subjects[0].name.clone();
    let note = if outgoing {
        format!("outgoing edges from {subject_name}")
    } else {
        format!("callers / references of {subject_name}")
    };
    Ok(StructuralOutcome::Result(AskResult {
        query: query.to_string(),
        mode: AskMode::Structural,
        subject: Some(subject_name),
        hits,
        note: Some(note),
        saved: None,
        coverage: None,
        coverage_strong: None,
        scopes: None,
    }))
}
