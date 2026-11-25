//! `ask --max-tokens <n>` token-budget fitting matching `src/ask/budget.ts`.

use serde::Serialize;

use crate::ask::format::format_ask_with_found;
use crate::ask::{AskHit, AskResult, hit_files};
use crate::store::GraphStore;

const MARGIN: f64 = 0.85;
const FOOTER_TOKENS: isize = 32;

const NOT_CALLS: &[&str] = &[
    "if", "for", "while", "switch", "catch", "return", "function", "elif", "with", "match",
    "sizeof", "typeof", "await", "yield", "new", "fn", "def", "func", "foreach", "until", "unless",
    "when", "and", "or", "not",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AskBudget {
    #[serde(rename = "max_tokens")]
    pub max_limit: usize,
    #[serde(rename = "used_tokens")]
    pub used_count: usize,
    pub folded: usize,
    pub pointer_only: usize,
    pub omitted: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Level {
    Whole,
    Folded,
    Pointer,
}

/// Validate `--max-tokens` (`>= 1` whole integer) matching TS `parseMaxTokens`.
pub fn parse_max_tokens(raw: &str) -> Result<usize, String> {
    let trimmed = raw.trim();
    if !trimmed.is_empty()
        && trimmed.bytes().all(|b| b.is_ascii_digit())
        && let Ok(n) = trimmed.parse::<usize>()
        && n >= 1
    {
        return Ok(n);
    }
    let quoted = serde_json::to_string(raw).unwrap_or_else(|_| format!("\"{raw}\""));
    Err(format!(
        "max-tokens must be a whole number of at least 1, got {quoted}"
    ))
}

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_' || b == b'$'
}

fn is_ident_cont(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

fn skip_generic_args(bytes: &[u8], start: usize) -> Option<usize> {
    let mut p = start;
    if bytes.get(p..p + 2) == Some(b"::") {
        p += 2;
    }
    if bytes.get(p) != Some(&b'<') {
        return None;
    }
    p += 1;
    let mut depth = 1_usize;
    while p < bytes.len() {
        match bytes[p] {
            b'<' => depth += 1,
            b'>' => {
                depth -= 1;
                if depth == 0 {
                    return Some(p + 1);
                }
            }
            b'(' | b')' => return None,
            _ => {}
        }
        p += 1;
    }
    None
}

fn has_call(line: &str) -> bool {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !is_ident_start(bytes[i]) {
            i += 1;
            continue;
        }
        let start = i;
        let mut end = i + 1;
        while end < bytes.len() && is_ident_cont(bytes[end]) {
            end += 1;
        }
        let ident = &line[start..end];
        let mut p = end;
        if bytes.get(p) == Some(&b'!') {
            p += 1;
        }
        if let Some(after_gen) = skip_generic_args(bytes, p) {
            p = after_gen;
        }
        while p < bytes.len() && bytes[p].is_ascii_whitespace() {
            p += 1;
        }
        if bytes.get(p) == Some(&b'(') {
            if !NOT_CALLS.contains(&ident) {
                return true;
            }
            i = p + 1;
        } else {
            i += 1;
        }
    }
    false
}

fn match_regex_lit(slice: &str) -> Option<usize> {
    let bytes = slice.as_bytes();
    if bytes.first() != Some(&b'/') {
        return None;
    }
    let mut i = 1;
    let mut in_class = false;
    while i < bytes.len() {
        let ch = slice[i..].chars().next()?;
        if ch == '\\' {
            let after = i + 1;
            let extra = slice[after..].chars().next().map_or(0, char::len_utf8);
            if extra == 0 {
                return None;
            }
            i = after + extra;
            continue;
        }
        if ch == '[' && !in_class {
            in_class = true;
        } else if ch == ']' && in_class {
            in_class = false;
        } else if ch == '/' && !in_class {
            return (i > 1).then_some(i + 1);
        }
        i += ch.len_utf8();
    }
    None
}

fn match_char_lit(slice: &str) -> Option<usize> {
    let mut chars = slice.chars();
    if chars.next() != Some('\'') {
        return None;
    }
    match chars.next() {
        Some('\\') => {
            let esc = chars.next()?;
            (chars.next() == Some('\'')).then_some(2 + esc.len_utf8() + 1)
        }
        Some(c) if c != '\'' => (chars.next() == Some('\'')).then_some(1 + c.len_utf8() + 1),
        _ => None,
    }
}

fn code_of_single_line(line: &str) -> String {
    let mut out = String::new();
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < line.len() {
        let rest = &line[i..];
        let ch = rest.chars().next().unwrap();
        if let Some(q) = quote {
            if ch == '\\' {
                let after = i + 1;
                let extra = line[after..].chars().next().map_or(0, char::len_utf8);
                i = after + extra;
                continue;
            }
            if ch == q {
                quote = None;
                out.push(ch);
            }
            i += ch.len_utf8();
            continue;
        }
        if rest.starts_with("//") {
            break;
        }
        if ch == '/' {
            let trimmed = out.trim_end();
            let operand_before = trimmed.is_empty()
                || matches!(
                    trimmed.as_bytes().last(),
                    Some(b'=' | b'(' | b',' | b':' | b'!' | b'&' | b'|' | b'?')
                );
            if operand_before && let Some(len) = match_regex_lit(rest) {
                out.push_str("/re/");
                i += len;
                continue;
            }
            out.push('/');
            i += 1;
            continue;
        }
        if ch == '\'' {
            if let Some(len) = match_char_lit(rest) {
                out.push_str("''");
                i += len;
            } else {
                out.push('\'');
                i += 1;
            }
            continue;
        }
        if ch == '"' || ch == '`' {
            quote = Some(ch);
        }
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn ends_body_opener(text: &str) -> bool {
    if text.ends_with(':') || text.ends_with("=>") || text.ends_with('=') {
        return true;
    }
    if let Some(prefix) = text.strip_suffix("do") {
        return prefix
            .as_bytes()
            .last()
            .is_none_or(|b| !b.is_ascii_alphanumeric() && *b != b'_');
    }
    false
}

fn signature_length(lines: &[&str]) -> usize {
    let mut depth = 0_isize;
    let limit = lines.len().min(12);
    for (i, line) in lines.iter().take(limit).enumerate() {
        let stripped = code_of_single_line(line);
        let text = stripped.trim_end();
        let before_brace = text.strip_suffix('{').map(str::trim_end);
        let body = before_brace.is_some_and(|pre| {
            !matches!(
                pre.as_bytes().last(),
                Some(b':' | b'<' | b'(' | b',' | b'|' | b'&')
            )
        });
        let scan = if body { &text[..text.len() - 1] } else { text };
        for ch in scan.chars() {
            match ch {
                '(' | '[' | '{' => depth += 1,
                ')' | ']' | '}' => depth -= 1,
                _ => {}
            }
        }
        if depth <= 0 && (body || ends_body_opener(text)) {
            return i + 1;
        }
    }
    lines.len().min(6)
}

/// Fold a definition: keep signature lines, call lines, and closing line.
pub fn fold_code(code: &str) -> String {
    let lines: Vec<&str> = code.split('\n').collect();
    let head = signature_length(&lines);
    let keep: Vec<bool> = lines
        .iter()
        .enumerate()
        .map(|(i, l)| i < head || i + 1 == lines.len() || has_call(l))
        .collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if keep[i] {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        }
        let mut j = i;
        while j < lines.len() && !keep[j] {
            j += 1;
        }
        let n = j - i;
        if n == 1 {
            out.push(lines[i].to_string());
        } else {
            let ws_len = lines[i]
                .find(|c: char| !c.is_whitespace())
                .unwrap_or(lines[i].len());
            let indent = &lines[i][..ws_len];
            out.push(format!("{indent}⋯ {n} lines"));
        }
        i = j;
    }
    out.join("\n")
}

/// 4 ASCII characters per token, plus 1 token per non-ASCII code point.
pub fn estimate_tokens(text: &str) -> usize {
    let mut ascii = 0_usize;
    let mut other = 0_usize;
    for ch in text.chars() {
        if (ch as u32) < 0x80 {
            ascii += 1;
        } else {
            other += 1;
        }
    }
    ascii.div_ceil(4) + other
}

fn at_level(hit: &AskHit, level: Level, folded: Option<&str>) -> AskHit {
    match level {
        Level::Whole => hit.clone(),
        Level::Folded => AskHit {
            code: folded.map(str::to_string),
            ..hit.clone()
        },
        Level::Pointer => AskHit {
            snippet: String::new(),
            related: None,
            code: None,
            score_first: true,
            ..hit.clone()
        },
    }
}

pub fn format_budget_footer(b: &AskBudget) -> String {
    let mut parts = Vec::new();
    if b.folded > 0 {
        parts.push(format!("{} folded", b.folded));
    }
    if b.pointer_only > 0 {
        parts.push(format!("{} as pointers only", b.pointer_only));
    }
    if b.omitted > 0 {
        parts.push(format!("{} left out", b.omitted));
    }
    let detail = if parts.is_empty() {
        String::new()
    } else {
        format!(", {}", parts.join(", "))
    };
    let how = if b.folded > 0 || b.pointer_only > 0 || b.omitted > 0 {
        "; for whole bodies, rerun with a larger max_tokens or without it, or read a pointer"
    } else {
        ""
    };
    format!(
        "budget: about {} of {} tokens{detail}{how}",
        b.used_count, b.max_limit
    )
}

/// Fit an `AskResult` (fetched with `source: true, full: true`) into `token_cap`.
pub fn budget_ask(
    orig: &AskResult,
    token_cap: usize,
    store: Option<&GraphStore>,
) -> Result<(AskResult, String), String> {
    let cap = ((token_cap as f64) * MARGIN).floor() as isize - FOOTER_TOKENS;
    let mut chosen: Vec<AskHit> = Vec::new();
    let mut levels: Vec<Level> = Vec::new();
    let mut omitted = 0_usize;

    let render = |hits: Vec<AskHit>, saved| -> String {
        let candidate = AskResult {
            hits,
            saved,
            ..orig.clone()
        };
        format_ask_with_found(&candidate, orig)
    };

    for (i, hit) in orig.hits.iter().enumerate() {
        let folded = hit.code.as_deref().map(fold_code);
        let tries: Vec<Level> = if hit.code.is_none() {
            vec![Level::Whole]
        } else if i == 0 {
            vec![Level::Whole, Level::Folded, Level::Pointer]
        } else if folded.as_deref() == hit.code.as_deref() {
            vec![Level::Whole, Level::Pointer]
        } else {
            vec![Level::Folded, Level::Pointer]
        };

        let fit = tries.into_iter().find(|&level| {
            let mut probe = chosen.clone();
            probe.push(at_level(hit, level, folded.as_deref()));
            let text = render(probe, orig.saved.clone());
            (estimate_tokens(&text) as isize) <= cap
        });

        // Matches `src/ask/budget.ts:161-162`: hit 1 always shows as a pointer on tiny caps.
        let Some(level) = fit.or(if i == 0 { Some(Level::Pointer) } else { None }) else {
            omitted = orig.hits.len() - i;
            break;
        };
        chosen.push(at_level(hit, level, folded.as_deref()));
        levels.push(level);
    }

    let non_pointer: Vec<AskHit> = chosen
        .iter()
        .enumerate()
        .filter(|(i, _)| levels[*i] != Level::Pointer)
        .map(|(_, h)| h.clone())
        .collect();
    let saved = match store {
        Some(s) => {
            let files = hit_files(&non_pointer);
            if files.is_empty() {
                None
            } else {
                s.savings_for_paths(files.iter().map(String::as_str))
                    .map_err(|e| e.to_string())?
            }
        }
        None => {
            if omitted > 0 || levels.contains(&Level::Pointer) {
                None
            } else {
                orig.saved.clone()
            }
        }
    };

    let out_text = render(chosen.clone(), saved.clone());
    let folded_count = levels
        .iter()
        .enumerate()
        .filter(|(i, l)| **l == Level::Folded && chosen[*i].code != orig.hits[*i].code)
        .count();
    let pointer_only = levels.iter().filter(|l| **l == Level::Pointer).count();

    let mut budget = AskBudget {
        max_limit: token_cap,
        used_count: 0,
        folded: folded_count,
        pointer_only,
        omitted,
    };
    budget.used_count =
        estimate_tokens(&out_text) + estimate_tokens(&format_budget_footer(&budget)) + 1;
    let full_text = format!("{out_text}{}\n", format_budget_footer(&budget));
    let final_result = AskResult {
        hits: chosen,
        saved,
        budget: Some(budget),
        ..orig.clone()
    };
    Ok((final_result, full_text))
}

#[cfg(test)]
mod tests {
    use super::{AskBudget, format_budget_footer};

    #[test]
    fn format_budget_footer_matches_ts_max_tokens_hint() {
        let footer = format_budget_footer(&AskBudget {
            max_limit: 500,
            used_count: 420,
            folded: 1,
            pointer_only: 2,
            omitted: 3,
        });
        assert_eq!(
            footer,
            "budget: about 420 of 500 tokens, 1 folded, 2 as pointers only, 3 left out; for whole bodies, rerun with a larger max_tokens or without it, or read a pointer"
        );
    }
}
