//! Comment, string, regex and JSX attribute blanking for source evidence lines.
//!
//! Mirrors `src/blast/evidence.ts` (`codeOf`, `syntaxOf`, `opensQuote`) and
//! `src/blast/blast.ts` (`codeLines`).

mod regex_scan;

use regex_scan::{regex_end, step_escape};

#[derive(Debug, Clone, Copy)]
pub struct Syntax {
    pub slash: bool,
    pub dash: bool,
    pub hash: bool,
    pub rust: bool,
    pub go: bool,
    pub js: bool,
    pub jsx: bool,
    pub ts: bool,
}

pub fn syntax_of(path: &str) -> Syntax {
    let ext = path
        .rsplit_once('.')
        .map_or(path, |(_, e)| e)
        .to_ascii_lowercase();
    let hash = matches!(
        ext.as_str(),
        "py" | "pyi"
            | "rb"
            | "sh"
            | "bash"
            | "zsh"
            | "pl"
            | "pm"
            | "r"
            | "ex"
            | "exs"
            | "jl"
            | "nim"
            | "cr"
            | "coffee"
            | "tcl"
            | "ps1"
            | "php"
    );
    let dash = matches!(
        ext.as_str(),
        "lua" | "sql" | "hs" | "elm" | "ada" | "adb" | "ads"
    );
    let js = matches!(
        ext.as_str(),
        "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts"
    );
    Syntax {
        slash: ext == "php" || (!hash && !dash),
        dash,
        hash,
        rust: ext == "rs",
        go: ext == "go",
        js,
        jsx: ext == "jsx" || ext == "tsx",
        ts: matches!(ext.as_str(), "ts" | "mts" | "cts"),
    }
}

pub fn opens_quote(text: &str, i: usize, rust: bool) -> bool {
    let Some(ch) = text[i..].chars().next() else {
        return false;
    };
    if ch == '"' || ch == '`' {
        return true;
    }
    if ch != '\'' {
        return false;
    }
    let prev_digit = text[..i]
        .chars()
        .next_back()
        .is_some_and(|c| c.is_ascii_digit());
    let next_digit = text[i + 1..]
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_digit());
    if prev_digit && next_digit {
        return false;
    }
    if !rust {
        return true;
    }
    is_rust_char_literal(&text[i..])
}

fn is_rust_char_literal(slice: &str) -> bool {
    let mut chars = slice.chars();
    if chars.next() != Some('\'') {
        return false;
    }
    match chars.next() {
        None | Some('\'') => false,
        Some('\\') => {
            let mut count = 0;
            for c in chars {
                if c == '\'' {
                    return (1..=9).contains(&count);
                }
                count += 1;
                if count > 9 {
                    return false;
                }
            }
            false
        }
        Some(_) => chars.next() == Some('\''),
    }
}

fn close_of(text: &str, i: usize, open: &str) -> Option<usize> {
    if open == "*/" || open.starts_with('r') {
        let close = if open == "*/" { open } else { &open[1..] };
        return text[i..].find(close).map(|pos| i + pos + close.len());
    }
    let mut j = i;
    while j < text.len() {
        if text[j..].starts_with(open) {
            return Some(j + open.len());
        }
        let ch = text[j..].chars().next()?;
        j = if ch == '\\' {
            step_escape(text, j)
        } else {
            j + ch.len_utf8()
        };
    }
    None
}

fn match_rust_raw(text: &str, i: usize) -> Option<(String, usize)> {
    let prev_word = text[..i]
        .bytes()
        .next_back()
        .is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_');
    if prev_word {
        return None;
    }
    let bytes = text.as_bytes();
    let mut at = i;
    if matches!(bytes.get(at), Some(b'b' | b'c')) {
        at += 1;
    }
    if bytes.get(at) != Some(&b'r') {
        return None;
    }
    at += 1;
    let hash_start = at;
    while bytes.get(at) == Some(&b'#') {
        at += 1;
    }
    if bytes.get(at) != Some(&b'"') {
        return None;
    }
    let hashes = &text[hash_start..at];
    Some((format!("r\"{hashes}"), at + 1))
}

/// Blank every string literal, regex literal and comment to a single space, returning
/// `(blanked_code, open_delimiter_at_eol)`.
pub fn code_of(text: &str, syntax: Syntax, mut open: Option<String>) -> (String, Option<String>) {
    let mut code = String::new();
    let mut i = 0;
    if let Some(ref open_delim) = open {
        let Some(end) = close_of(text, 0, open_delim) else {
            return (code, open);
        };
        code.push(' ');
        i = end;
        open = None;
    }

    let bytes = text.as_bytes();
    while i < text.len() {
        let rest = &text[i..];
        let ch = rest.chars().next().unwrap();
        let mut from = i + ch.len_utf8();
        let raw = if syntax.rust {
            match_rust_raw(text, i)
        } else {
            None
        };
        let regex = if syntax.js && ch == '/' {
            regex_end(text, i, syntax)
        } else {
            None
        };
        let escaped_slash = i > 0 && bytes[i - 1] == b'\\';
        let hash_boundary = i == 0
            || text[..i]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace);

        if syntax.slash && rest.starts_with("/*") && !escaped_slash {
            open = Some("*/".to_string());
            from = i + 2;
        } else if (syntax.slash && rest.starts_with("//"))
            || (syntax.dash && rest.starts_with("--"))
            || (syntax.hash && ch == '#' && hash_boundary)
        {
            break;
        } else if let Some(regex_end_pos) = regex {
            code.push(' ');
            i = regex_end_pos;
            continue;
        } else if rest.starts_with("\"\"\"") || rest.starts_with("'''") {
            open = Some(rest[..3].to_string());
            from = i + 3;
        } else if let Some((delim, raw_from)) = raw {
            open = Some(delim);
            from = raw_from;
        } else if syntax.go && ch == '`' {
            open = Some("r`".to_string());
        } else if opens_quote(text, i, syntax.rust) {
            open = Some(ch.to_string());
        } else {
            code.push(ch);
        }

        if let Some(ref open_delim) = open {
            match close_of(text, from, open_delim) {
                None => {
                    let keep = if open_delim == "'" || (open_delim == "\"" && !syntax.rust) {
                        None
                    } else {
                        open
                    };
                    return (code, keep);
                }
                Some(end) => {
                    code.push(' ');
                    i = end;
                    open = None;
                }
            }
        } else {
            i = from;
        }
    }
    (code, None)
}

/// Blank comments in lines `from..=to` (1-based) preserving column positions,
/// matching `src/blast/blast.ts::codeLines` for call-site detection.
pub fn blank_comment_lines(lines: &[String], from: usize, to: usize, path: &str) -> Vec<String> {
    let syntax = syntax_of(path);
    let mut out = vec![String::new(); lines.len()];
    let mut block = false;
    let hi = to.min(lines.len());
    for n in from.max(1)..=hi {
        let text = &lines[n - 1];
        let bytes = text.as_bytes();
        let mut line_out = String::with_capacity(text.len());
        let mut quote: Option<char> = None;
        let mut i = 0;
        while i < text.len() {
            let rest = &text[i..];
            let ch = rest.chars().next().unwrap();
            if block {
                if rest.starts_with("*/") {
                    block = false;
                    line_out.push_str("  ");
                    i += 2;
                } else {
                    line_out.push(' ');
                    i += ch.len_utf8();
                }
                continue;
            }
            if let Some(q) = quote {
                if ch == q {
                    quote = None;
                    line_out.push(ch);
                    i += ch.len_utf8();
                } else if ch == '\\' {
                    let end = step_escape(text, i);
                    line_out.push_str(&text[i..end]);
                    i = end;
                } else {
                    line_out.push(ch);
                    i += ch.len_utf8();
                }
                continue;
            }
            let escaped = i > 0 && bytes[i - 1] == b'\\';
            if syntax.slash && rest.starts_with("/*") && !escaped {
                block = true;
                line_out.push_str("  ");
                i += 2;
                continue;
            }
            let hash_ws = i == 0
                || text[..i]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace);
            if (syntax.slash && rest.starts_with("//"))
                || (syntax.dash && rest.starts_with("--"))
                || (syntax.hash && ch == '#' && hash_ws)
            {
                for _ in text[i..].chars() {
                    line_out.push(' ');
                }
                break;
            }
            if opens_quote(text, i, syntax.rust) {
                quote = Some(ch);
            }
            line_out.push(ch);
            i += ch.len_utf8();
        }
        out[n - 1] = line_out;
    }
    out
}
