//! Regex-literal and JSX tag boundary scanning for source evidence lines.

use super::Syntax;

const BEFORE_REGEX: &[&str] = &[
    "return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw",
    "yield", "await",
];

pub(super) fn step_escape(text: &str, backslash_at: usize) -> usize {
    let after = backslash_at + 1;
    let extra = text[after..].chars().next().map_or(0, char::len_utf8);
    after + extra
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

pub(super) fn regex_end(text: &str, i: usize, syntax: Syntax) -> Option<usize> {
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
