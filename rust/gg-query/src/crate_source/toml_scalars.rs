//! Scalar validation (numbers, dates, times, control chars) and table-tree
//! duplicate/conflict tracking for zero-dependency TOML 1.0 manifest parsing.

use std::collections::BTreeMap;

use super::manifest::ReadFileError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum HeaderKind {
    Table,
    ArrayTable,
}

pub(super) enum EntryKind {
    Value,
    InlineTable,
    ImplicitTable(BTreeMap<String, EntryKind>),
    ExplicitTable(BTreeMap<String, EntryKind>),
    DottedTable(BTreeMap<String, EntryKind>),
    ArrayOfTables(Vec<BTreeMap<String, EntryKind>>),
}

pub(super) fn syntax_err(msg: impl Into<String>) -> ReadFileError {
    ReadFileError::Other(msg.into())
}

pub(super) fn is_disallowed_control(c: char, allow_newline: bool) -> bool {
    let u = c as u32;
    if u == 0x09 {
        return false;
    }
    if allow_newline && (u == 0x0A || u == 0x0D) {
        return false;
    }
    u <= 0x1F || u == 0x7F
}

pub(super) fn parse_escape_at(src: &str, pos: &mut usize) -> Result<char, ReadFileError> {
    let bytes = src.as_bytes();
    let Some(&esc) = bytes.get(*pos) else {
        return Err(syntax_err("truncated escape sequence in Cargo.toml"));
    };
    *pos += 1;
    let hex_len = match esc {
        b'b' => return Ok('\u{0008}'),
        b't' => return Ok('\t'),
        b'n' => return Ok('\n'),
        b'f' => return Ok('\u{000C}'),
        b'r' => return Ok('\r'),
        b'"' => return Ok('"'),
        b'\\' => return Ok('\\'),
        b'u' => 4,
        b'U' => 8,
        _ => {
            return Err(syntax_err(format!(
                "invalid escape \\{} in Cargo.toml",
                esc as char
            )));
        }
    };
    let end = *pos + hex_len;
    if end > bytes.len() || !bytes[*pos..end].iter().all(u8::is_ascii_hexdigit) {
        return Err(syntax_err(
            "invalid or truncated unicode escape in Cargo.toml",
        ));
    }
    let hex = &src[*pos..end];
    *pos = end;
    let code = u32::from_str_radix(hex, 16)
        .map_err(|_| syntax_err("invalid unicode escape in Cargo.toml"))?;
    char::from_u32(code).ok_or_else(|| syntax_err("invalid unicode scalar in Cargo.toml"))
}

pub(super) fn is_bare_key_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

fn valid_digits_with_underscores(s: &str, pred: fn(u8) -> bool) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes[0] == b'_' || *bytes.last().unwrap() == b'_' {
        return false;
    }
    let mut prev_underscore = false;
    for &b in bytes {
        if b == b'_' {
            if prev_underscore {
                return false;
            }
            prev_underscore = true;
        } else if pred(b) {
            prev_underscore = false;
        } else {
            return false;
        }
    }
    true
}

fn valid_unsigned_dec_int(s: &str) -> bool {
    if !valid_digits_with_underscores(s, |b| b.is_ascii_digit()) {
        return false;
    }
    let bytes = s.as_bytes();
    !(bytes.len() > 1 && bytes[0] == b'0')
}

pub(super) fn is_valid_number(tok: &str) -> bool {
    if tok.is_empty() {
        return false;
    }
    let (signed, rest) = if let Some(r) = tok.strip_prefix('+').or_else(|| tok.strip_prefix('-')) {
        (true, r)
    } else {
        (false, tok)
    };
    if rest == "inf" || rest == "nan" {
        return true;
    }
    if !signed {
        if let Some(hex) = rest.strip_prefix("0x") {
            return valid_digits_with_underscores(hex, |b| b.is_ascii_hexdigit());
        }
        if let Some(oct) = rest.strip_prefix("0o") {
            return valid_digits_with_underscores(oct, |b| (b'0'..=b'7').contains(&b));
        }
        if let Some(bin) = rest.strip_prefix("0b") {
            return valid_digits_with_underscores(bin, |b| b == b'0' || b == b'1');
        }
    }
    let (mantissa, exp_opt) = match rest.find(['e', 'E']) {
        Some(idx) => (&rest[..idx], Some(&rest[idx + 1..])),
        None => (rest, None),
    };
    if let Some(exp) = exp_opt {
        let exp_digits = exp
            .strip_prefix('+')
            .or_else(|| exp.strip_prefix('-'))
            .unwrap_or(exp);
        if !valid_digits_with_underscores(exp_digits, |b| b.is_ascii_digit()) {
            return false;
        }
    }
    match mantissa.split_once('.') {
        Some((int_part, frac_part)) => {
            valid_unsigned_dec_int(int_part)
                && valid_digits_with_underscores(frac_part, |b| b.is_ascii_digit())
        }
        None => valid_unsigned_dec_int(mantissa),
    }
}

fn parse_two_digits(b: &[u8]) -> Option<u8> {
    if b.len() == 2 && b[0].is_ascii_digit() && b[1].is_ascii_digit() {
        Some((b[0] - b'0') * 10 + (b[1] - b'0'))
    } else {
        None
    }
}

pub(super) fn is_valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' || !b[..4].iter().all(u8::is_ascii_digit) {
        return false;
    }
    let (Some(m), Some(d)) = (parse_two_digits(&b[5..7]), parse_two_digits(&b[8..10])) else {
        return false;
    };
    (1..=12).contains(&m) && (1..=31).contains(&d)
}

fn is_valid_time(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 8 || b[2] != b':' || b[5] != b':' {
        return false;
    }
    let (Some(hh), Some(mm), Some(ss)) = (
        parse_two_digits(&b[0..2]),
        parse_two_digits(&b[3..5]),
        parse_two_digits(&b[6..8]),
    ) else {
        return false;
    };
    if hh > 23 || mm > 59 || ss > 60 {
        return false;
    }
    if b.len() == 8 {
        return true;
    }
    b[8] == b'.' && b.len() > 9 && b[9..].iter().all(u8::is_ascii_digit)
}

fn is_valid_offset(s: &str) -> bool {
    if s == "Z" || s == "z" {
        return true;
    }
    let b = s.as_bytes();
    if b.len() != 6 || (b[0] != b'+' && b[0] != b'-') || b[3] != b':' {
        return false;
    }
    let (Some(hh), Some(mm)) = (parse_two_digits(&b[1..3]), parse_two_digits(&b[4..6])) else {
        return false;
    };
    hh <= 23 && mm <= 59
}

pub(super) fn is_valid_datetime(tok: &str) -> bool {
    if !tok.is_ascii() {
        return false;
    }
    if is_valid_date(tok) || is_valid_time(tok) {
        return true;
    }
    if tok.len() < 19 || !is_valid_date(&tok[..10]) {
        return false;
    }
    let sep = tok.as_bytes()[10];
    if !matches!(sep, b'T' | b't' | b' ') {
        return false;
    }
    let rest = &tok[11..];
    if let Some(t) = rest.strip_suffix('Z').or_else(|| rest.strip_suffix('z')) {
        return is_valid_time(t);
    }
    if let Some(pos) = rest.rfind(['+', '-']) {
        return is_valid_time(&rest[..pos]) && is_valid_offset(&rest[pos..]);
    }
    is_valid_time(rest)
}

pub(super) fn open_table_path(
    root: &mut BTreeMap<String, EntryKind>,
    path: &[String],
    kind: &HeaderKind,
) -> Result<Vec<(String, Option<usize>)>, ReadFileError> {
    let mut cur = root;
    let mut ptr = Vec::with_capacity(path.len());
    for seg in &path[..path.len() - 1] {
        let entry = cur
            .entry(seg.clone())
            .or_insert_with(|| EntryKind::ImplicitTable(BTreeMap::new()));
        match entry {
            EntryKind::ImplicitTable(m)
            | EntryKind::ExplicitTable(m)
            | EntryKind::DottedTable(m) => {
                ptr.push((seg.clone(), None));
                cur = m;
            }
            EntryKind::ArrayOfTables(arr) => {
                let idx = arr.len().checked_sub(1).ok_or_else(|| {
                    syntax_err(format!("empty array table \"{seg}\" in Cargo.toml"))
                })?;
                ptr.push((seg.clone(), Some(idx)));
                cur = &mut arr[idx];
            }
            EntryKind::Value | EntryKind::InlineTable => {
                return Err(syntax_err(format!(
                    "cannot extend non-table key \"{seg}\" in Cargo.toml"
                )));
            }
        }
    }
    let last = path.last().unwrap();
    match kind {
        HeaderKind::Table => match cur.remove(last) {
            None => {
                cur.insert(last.clone(), EntryKind::ExplicitTable(BTreeMap::new()));
                ptr.push((last.clone(), None));
            }
            Some(EntryKind::ImplicitTable(m)) => {
                cur.insert(last.clone(), EntryKind::ExplicitTable(m));
                ptr.push((last.clone(), None));
            }
            Some(_) => {
                return Err(syntax_err(format!(
                    "duplicate or conflicting table [{last}] in Cargo.toml"
                )));
            }
        },
        HeaderKind::ArrayTable => match cur.get_mut(last) {
            None => {
                cur.insert(
                    last.clone(),
                    EntryKind::ArrayOfTables(vec![BTreeMap::new()]),
                );
                ptr.push((last.clone(), Some(0)));
            }
            Some(EntryKind::ArrayOfTables(arr)) => {
                arr.push(BTreeMap::new());
                ptr.push((last.clone(), Some(arr.len() - 1)));
            }
            Some(_) => {
                return Err(syntax_err(format!(
                    "conflicting array-of-tables [[{last}]] in Cargo.toml"
                )));
            }
        },
    }
    Ok(ptr)
}

pub(super) fn current_table_mut<'a>(
    mut cur: &'a mut BTreeMap<String, EntryKind>,
    ptr: &[(String, Option<usize>)],
) -> Result<&'a mut BTreeMap<String, EntryKind>, ReadFileError> {
    for (seg, arr_idx) in ptr {
        match cur.get_mut(seg) {
            Some(
                EntryKind::ImplicitTable(m)
                | EntryKind::ExplicitTable(m)
                | EntryKind::DottedTable(m),
            ) if arr_idx.is_none() => {
                cur = m;
            }
            Some(EntryKind::ArrayOfTables(arr)) if arr_idx.is_some() => {
                cur = &mut arr[arr_idx.unwrap()];
            }
            _ => return Err(syntax_err("invalid active table state in Cargo.toml")),
        }
    }
    Ok(cur)
}

pub(super) fn insert_dotted_key(
    mut cur: &mut BTreeMap<String, EntryKind>,
    key_path: &[String],
    is_inline_table: bool,
) -> Result<(), ReadFileError> {
    for seg in &key_path[..key_path.len() - 1] {
        let entry = cur
            .entry(seg.clone())
            .or_insert_with(|| EntryKind::DottedTable(BTreeMap::new()));
        match entry {
            EntryKind::DottedTable(m) | EntryKind::ImplicitTable(m) => cur = m,
            _ => {
                return Err(syntax_err(format!(
                    "key \"{seg}\" conflicts with existing key or table in Cargo.toml"
                )));
            }
        }
    }
    let last = key_path.last().unwrap();
    if cur.contains_key(last) {
        return Err(syntax_err(format!(
            "duplicate key \"{last}\" in Cargo.toml"
        )));
    }
    cur.insert(
        last.clone(),
        if is_inline_table {
            EntryKind::InlineTable
        } else {
            EntryKind::Value
        },
    );
    Ok(())
}
