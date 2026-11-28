//! Scalar validation (numbers, Gregorian dates, times, control chars),
//! cumulative retained-memory budgeting and table-tree duplicate/conflict
//! tracking for zero-dependency TOML 1.0 manifest parsing.

use std::collections::BTreeMap;

use super::manifest::{MAX_MANIFEST_BYTES, ReadFileError};

pub(super) const MAX_NESTING_DEPTH: usize = 256;
pub(super) const MAX_RETAINED_BYTES: usize = 2 * (MAX_MANIFEST_BYTES as usize);
const KEY_ENTRY_OVERHEAD: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum HeaderKind {
    Table,
    ArrayTable,
}

pub(super) struct MemoryBudget {
    used: usize,
    limit: usize,
}

impl MemoryBudget {
    pub(super) fn new(limit: usize) -> Self {
        Self { used: 0, limit }
    }

    pub(super) fn charge(&mut self, bytes: usize) -> Result<(), ReadFileError> {
        self.used = self.used.saturating_add(bytes);
        if self.used > self.limit {
            return Err(ReadFileError::BudgetExhausted(format!(
                "Cargo.toml retained memory exceeds {} byte safety cap",
                self.limit
            )));
        }
        Ok(())
    }
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

pub(super) fn budget_depth_err() -> ReadFileError {
    ReadFileError::BudgetExhausted(format!(
        "Cargo.toml nesting depth exceeds {MAX_NESTING_DEPTH}"
    ))
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
    let mut code = 0u32;
    for _ in 0..hex_len {
        let Some(digit) = bytes.get(*pos).and_then(|&b| (b as char).to_digit(16)) else {
            return Err(syntax_err(
                "invalid or truncated unicode escape in Cargo.toml",
            ));
        };
        code = (code << 4) | digit;
        *pos += 1;
    }
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

fn is_gregorian_leap_year(year: u16) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

pub(super) fn is_valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let (Some(y_hi), Some(y_lo), Some(m), Some(d)) = (
        parse_two_digits(&b[0..2]),
        parse_two_digits(&b[2..4]),
        parse_two_digits(&b[5..7]),
        parse_two_digits(&b[8..10]),
    ) else {
        return false;
    };
    let year = u16::from(y_hi) * 100 + u16::from(y_lo);
    let max_day = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_gregorian_leap_year(year) {
                29
            } else {
                28
            }
        }
        _ => return false,
    };
    (1..=max_day).contains(&d)
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
    path: Vec<String>,
    kind: &HeaderKind,
    budget: &mut MemoryBudget,
) -> Result<Vec<(String, Option<usize>)>, ReadFileError> {
    if path.len() > MAX_NESTING_DEPTH {
        return Err(budget_depth_err());
    }
    let mut cur = root;
    let mut ptr = Vec::with_capacity(path.len());
    let last_idx = path.len() - 1;
    for (idx, seg) in path.into_iter().enumerate() {
        if idx < last_idx {
            if !cur.contains_key(seg.as_str()) {
                budget.charge(seg.len() + KEY_ENTRY_OVERHEAD)?;
                cur.insert(seg.clone(), EntryKind::ImplicitTable(BTreeMap::new()));
            }
            match cur.get_mut(seg.as_str()) {
                Some(
                    EntryKind::ImplicitTable(m)
                    | EntryKind::ExplicitTable(m)
                    | EntryKind::DottedTable(m),
                ) => {
                    ptr.push((seg, None));
                    cur = m;
                }
                Some(EntryKind::ArrayOfTables(arr)) => {
                    let arr_i = arr.len().checked_sub(1).ok_or_else(|| {
                        syntax_err(format!("empty array table \"{seg}\" in Cargo.toml"))
                    })?;
                    ptr.push((seg, Some(arr_i)));
                    cur = &mut arr[arr_i];
                }
                _ => {
                    return Err(syntax_err(format!(
                        "cannot extend non-table key \"{seg}\" in Cargo.toml"
                    )));
                }
            }
            continue;
        }
        match kind {
            HeaderKind::Table => match cur.remove(seg.as_str()) {
                None => {
                    budget.charge(seg.len() + KEY_ENTRY_OVERHEAD)?;
                    cur.insert(seg.clone(), EntryKind::ExplicitTable(BTreeMap::new()));
                    ptr.push((seg, None));
                }
                Some(EntryKind::ImplicitTable(m)) => {
                    cur.insert(seg.clone(), EntryKind::ExplicitTable(m));
                    ptr.push((seg, None));
                }
                Some(_) => {
                    return Err(syntax_err(format!(
                        "duplicate or conflicting table [{seg}] in Cargo.toml"
                    )));
                }
            },
            HeaderKind::ArrayTable => match cur.get_mut(seg.as_str()) {
                None => {
                    budget.charge(seg.len() + KEY_ENTRY_OVERHEAD)?;
                    cur.insert(seg.clone(), EntryKind::ArrayOfTables(vec![BTreeMap::new()]));
                    ptr.push((seg, Some(0)));
                }
                Some(EntryKind::ArrayOfTables(arr)) => {
                    budget.charge(KEY_ENTRY_OVERHEAD)?;
                    arr.push(BTreeMap::new());
                    ptr.push((seg, Some(arr.len() - 1)));
                }
                Some(_) => {
                    return Err(syntax_err(format!(
                        "conflicting array-of-tables [[{seg}]] in Cargo.toml"
                    )));
                }
            },
        }
    }
    Ok(ptr)
}

pub(super) fn current_table_mut<'a>(
    mut cur: &'a mut BTreeMap<String, EntryKind>,
    ptr: &[(String, Option<usize>)],
) -> Result<&'a mut BTreeMap<String, EntryKind>, ReadFileError> {
    for (seg, arr_idx) in ptr {
        match cur.get_mut(seg.as_str()) {
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
    budget: &mut MemoryBudget,
) -> Result<(), ReadFileError> {
    for seg in &key_path[..key_path.len() - 1] {
        if let Some(entry) = cur.get_mut(seg.as_str()) {
            if let EntryKind::ImplicitTable(m) = entry {
                let taken = std::mem::take(m);
                *entry = EntryKind::DottedTable(taken);
            }
        } else {
            budget.charge(seg.len() + KEY_ENTRY_OVERHEAD)?;
            cur.insert(seg.clone(), EntryKind::DottedTable(BTreeMap::new()));
        }
        match cur.get_mut(seg.as_str()) {
            Some(EntryKind::DottedTable(m)) => cur = m,
            _ => {
                return Err(syntax_err(format!(
                    "key \"{seg}\" conflicts with existing key or table in Cargo.toml"
                )));
            }
        }
    }
    let last = key_path.last().unwrap();
    if cur.contains_key(last.as_str()) {
        return Err(syntax_err(format!(
            "duplicate key \"{last}\" in Cargo.toml"
        )));
    }
    budget.charge(last.len() + KEY_ENTRY_OVERHEAD)?;
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
