//! Comment, string, regex and JSX attribute blanking for source evidence lines.
//!
//! Mirrors `src/blast/evidence.ts` (`codeOf`, `syntaxOf`, `opensQuote`) and
//! `src/blast/blast.ts` (`codeLines`).

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

const BEFORE_REGEX: &[&str] = &[
    "return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw",
    "yield", "await",
];

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

fn step_escape(text: &str, backslash_at: usize) -> usize {
    let after = backslash_at + 1;
    let extra = text[after..].chars().next().map_or(0, char::len_utf8);
    after + extra
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

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

fn is_before_regex_word(word: &str) -> bool {
    BEFORE_REGEX.contains(&word)
}

fn open_paren(text: &str, k: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0_usize;
    let mut o = k;
    loop {
        match bytes[o] {
            b')' => depth += 1,
            b'(' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(o);
                }
            }
            _ => {}
        }
        if o == 0 {
            return None;
        }
        o -= 1;
    }
}

fn ends_with_keyword(s: &str, kws: &[&str]) -> Option<usize> {
    for kw in kws {
        if let Some(prefix) = s.strip_suffix(kw) {
            let word_boundary = prefix
                .as_bytes()
                .last()
                .is_none_or(|b| !b.is_ascii_alphanumeric() && *b != b'_');
            if word_boundary {
                return Some(prefix.len());
            }
        }
    }
    None
}

fn has_open_jsx_before_brace(before: &str) -> bool {
    let bytes = before.as_bytes();
    let Some(gt) = bytes.iter().rposition(|&b| b == b'>' || b == b'<') else {
        return false;
    };
    if bytes[gt] != b'>' {
        return false;
    }
    let before_gt = &bytes[..gt];
    let Some(lt) = before_gt.iter().rposition(|&b| b == b'<' || b == b'>') else {
        return false;
    };
    bytes[lt] == b'<' && bytes.get(lt + 1).is_some_and(u8::is_ascii_alphabetic)
}

fn ends_block(text: &str, k: usize, tags: bool) -> bool {
    let bytes = text.as_bytes();
    let mut depth = 0_usize;
    let mut o = k;
    loop {
        if bytes[o] == b'}' {
            depth += 1;
        } else if bytes[o] == b'{' {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                let before = text[..o].trim_end();
                if tags && has_open_jsx_before_brace(before) {
                    return false;
                }
                if let Some(paren_idx) = before.len().checked_sub(1)
                    && before.as_bytes()[paren_idx] == b')'
                {
                    let Some(open) = open_paren(before, paren_idx) else {
                        return false;
                    };
                    let head = before[..open].trim_end();
                    return ends_with_keyword(
                        head,
                        &["if", "for", "while", "switch", "catch", "with"],
                    )
                    .is_some();
                }
                let Some(kw_start) = ends_with_keyword(before, &["else", "do", "try", "finally"])
                else {
                    return false;
                };
                let pre_kw = before[..kw_start].trim_end();
                return pre_kw.is_empty()
                    || matches!(pre_kw.as_bytes().last(), Some(b'{' | b'}' | b';'));
            }
        }
        if o == 0 {
            return false;
        }
        o -= 1;
    }
}

fn strip_inner_braces(prefix: &str) -> String {
    let mut cur = prefix.to_string();
    loop {
        let mut next = String::with_capacity(cur.len());
        let bytes = cur.as_bytes();
        let mut i = 0;
        let mut changed = false;
        while i < bytes.len() {
            if bytes[i] == b'{'
                && let Some(rel_end) = cur[i + 1..].find(['{', '}'])
                && bytes[i + 1 + rel_end] == b'}'
            {
                i += rel_end + 2;
                changed = true;
                continue;
            }
            let ch = cur[i..].chars().next().unwrap();
            next.push(ch);
            i += ch.len_utf8();
        }
        if !changed {
            return next;
        }
        cur = next;
    }
}

fn in_tag(prefix: &str) -> bool {
    let p = strip_inner_braces(prefix);
    let Some(lt) = p.rfind(['<', '>']) else {
        return false;
    };
    if p.as_bytes()[lt] != b'<' {
        return false;
    }
    let after = &p[lt + 1..];
    let mut bytes = after.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() && first != b'_' && first != b'$' {
        return false;
    }
    let mut tag_len = 1;
    while tag_len < after.len() {
        let b = after.as_bytes()[tag_len];
        if is_ident_byte(b) || b == b'.' || b == b':' || b == b'-' {
            tag_len += 1;
        } else {
            break;
        }
    }
    let rest = &after[tag_len..];
    if !rest.chars().next().is_some_and(char::is_whitespace) {
        return false;
    }
    let before = p[..lt].trim_end();
    let Some(&last) = before.as_bytes().last() else {
        return true;
    };
    if !is_ident_byte(last) && last != b')' && last != b']' {
        return true;
    }
    let mut s = before.len() - 1;
    while s > 0 && is_ident_byte(before.as_bytes()[s - 1]) {
        s -= 1;
    }
    is_before_regex_word(&before[s..])
}

fn regex_end(text: &str, i: usize, syntax: Syntax) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut k_opt = i.checked_sub(1);
    while let Some(k) = k_opt {
        if bytes[k] == b' ' || bytes[k] == b'\t' {
            k_opt = k.checked_sub(1);
        } else {
            break;
        }
    }
    let self_closing = bytes.get(i + 1) == Some(&b'>');
    if self_closing && (syntax.jsx || k_opt.is_none()) {
        return None;
    }
    if let Some(k) = k_opt {
        let b = bytes[k];
        if b == b'<' {
            return None;
        }
        if b == b'}' {
            if !ends_block(text, k, !syntax.ts) {
                return None;
            }
        } else if is_ident_byte(b) || matches!(b, b')' | b']' | b'\'' | b'"' | b'`') {
            let mut s = k;
            while s > 0 && is_ident_byte(bytes[s - 1]) {
                s -= 1;
            }
            if !is_before_regex_word(&text[s..=k]) {
                return None;
            }
            if self_closing && !syntax.ts && in_tag(&text[..s]) {
                return None;
            }
        }
    }
    let mut in_class = false;
    let mut j = i + 1;
    while j < text.len() {
        let ch = text[j..].chars().next()?;
        if ch == '\\' {
            j = step_escape(text, j);
            continue;
        }
        match ch {
            '[' => in_class = true,
            ']' => in_class = false,
            '/' if !in_class => {
                j += 1;
                while j < bytes.len() && bytes[j].is_ascii_alphabetic() {
                    j += 1;
                }
                return Some(j);
            }
            _ => {}
        }
        j += ch.len_utf8();
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
