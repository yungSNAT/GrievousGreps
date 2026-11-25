//! Zero-dependency TOML 1.0 recursive-descent parser for `Cargo.toml`
//! manifests. Validates full document syntax, nesting depth and retained-memory
//! budgets fail-closed, retaining only identity-relevant entries.

use std::collections::BTreeMap;

use super::manifest::ReadFileError;
use super::toml_scalars::{
    EntryKind, HeaderKind, MAX_NESTING_DEPTH, MAX_RETAINED_BYTES, MemoryBudget, budget_depth_err,
    current_table_mut, insert_dotted_key, is_valid_date, is_valid_datetime, is_valid_number,
    open_table_path, syntax_err,
};
use super::toml_strings::{
    consume_newline_at, parse_basic_string, parse_literal_string, parse_ml_basic_string,
    parse_ml_literal_string, parse_simple_toml_key, skip_toml_comment,
};

#[derive(Debug, Clone)]
pub(super) enum TomlValue {
    Str(String),
    Bool(bool),
    Scalar,
    Array,
    InlineTable(Vec<(Vec<String>, TomlValue)>),
}

pub(super) struct ParsedEntry {
    pub header_kind: HeaderKind,
    pub full_path: Vec<String>,
    pub value: TomlValue,
}

fn is_identity_assignment(
    in_array_table: bool,
    active_ptr: &[(String, Option<usize>)],
    key_path: &[String],
) -> bool {
    if in_array_table {
        return false;
    }
    let total_len = active_ptr.len() + key_path.len();
    if total_len == 0 || total_len > 3 {
        return false;
    }
    let seg = |i: usize| -> &str {
        if i < active_ptr.len() {
            active_ptr[i].0.as_str()
        } else {
            key_path[i - active_ptr.len()].as_str()
        }
    };
    match seg(0) {
        "package" => match total_len {
            1 => true,
            2 => matches!(seg(1), "name" | "version"),
            3 => seg(1) == "version" && seg(2) == "workspace",
            _ => false,
        },
        "workspace" => match total_len {
            1 => true,
            2 => seg(1) == "package",
            3 => seg(1) == "package" && seg(2) == "version",
            _ => false,
        },
        _ => false,
    }
}

struct Parser<'a> {
    src: &'a str,
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(src: &'a str) -> Self {
        Self {
            src,
            bytes: src.as_bytes(),
            pos: 0,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn starts_with(&self, pat: &[u8]) -> bool {
        self.bytes[self.pos..].starts_with(pat)
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t')) {
            self.pos += 1;
        }
    }

    fn consume_newline(&mut self) -> Result<bool, ReadFileError> {
        consume_newline_at(self.bytes, &mut self.pos)
    }

    fn skip_comment(&mut self) -> Result<bool, ReadFileError> {
        skip_toml_comment(self.src, &mut self.pos)
    }

    fn skip_ws_newlines_comments(&mut self) -> Result<(), ReadFileError> {
        loop {
            self.skip_ws();
            if self.skip_comment()? || self.consume_newline()? {
                continue;
            }
            break;
        }
        Ok(())
    }

    fn expect_eol_or_eof(&mut self) -> Result<(), ReadFileError> {
        self.skip_ws();
        self.skip_comment()?;
        if self.pos >= self.bytes.len() || self.consume_newline()? {
            return Ok(());
        }
        Err(syntax_err("unexpected trailing token in Cargo.toml"))
    }

    fn parse_simple_key(&mut self) -> Result<String, ReadFileError> {
        parse_simple_toml_key(self.src, &mut self.pos)
    }

    fn parse_dotted_key(&mut self, max_segments: usize) -> Result<Vec<String>, ReadFileError> {
        if max_segments == 0 {
            return Err(budget_depth_err());
        }
        let mut parts = vec![self.parse_simple_key()?];
        loop {
            self.skip_ws();
            if self.peek() != Some(b'.') {
                break;
            }
            if parts.len() >= max_segments {
                return Err(budget_depth_err());
            }
            self.pos += 1;
            self.skip_ws();
            parts.push(self.parse_simple_key()?);
        }
        Ok(parts)
    }

    fn parse_array(
        &mut self,
        depth: usize,
        budget: &mut MemoryBudget,
    ) -> Result<TomlValue, ReadFileError> {
        if depth >= MAX_NESTING_DEPTH {
            return Err(budget_depth_err());
        }
        self.pos += 1;
        loop {
            self.skip_ws_newlines_comments()?;
            if self.peek() == Some(b']') {
                self.pos += 1;
                return Ok(TomlValue::Array);
            }
            let _ = self.parse_value(depth + 1, false, budget)?;
            self.skip_ws_newlines_comments()?;
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    return Ok(TomlValue::Array);
                }
                _ => return Err(syntax_err("expected ',' or ']' in TOML array")),
            }
        }
    }

    fn parse_inline_table(
        &mut self,
        depth: usize,
        retain: bool,
        budget: &mut MemoryBudget,
    ) -> Result<TomlValue, ReadFileError> {
        if depth >= MAX_NESTING_DEPTH {
            return Err(budget_depth_err());
        }
        self.pos += 1;
        self.skip_ws();
        let mut pairs = Vec::new();
        let mut seen: BTreeMap<String, EntryKind> = BTreeMap::new();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(TomlValue::InlineTable(pairs));
        }
        let max_key_segs = MAX_NESTING_DEPTH - depth;
        loop {
            self.skip_ws();
            let key = self.parse_dotted_key(max_key_segs)?;
            self.skip_ws();
            if self.peek() != Some(b'=') {
                return Err(syntax_err("expected '=' in inline table"));
            }
            self.pos += 1;
            self.skip_ws();
            let val = self.parse_value(depth + key.len(), retain, budget)?;
            insert_dotted_key(
                &mut seen,
                &key,
                matches!(val, TomlValue::InlineTable(_)),
                budget,
            )?;
            if retain {
                let key_bytes: usize = key.iter().map(|s| s.len() + 16).sum();
                budget.charge(key_bytes)?;
                pairs.push((key, val));
            }
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                    self.skip_ws();
                    if self.peek() == Some(b'}') {
                        return Err(syntax_err(
                            "trailing comma not allowed in TOML inline table",
                        ));
                    }
                }
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(TomlValue::InlineTable(pairs));
                }
                _ => return Err(syntax_err("expected ',' or '}' in TOML inline table")),
            }
        }
    }

    fn parse_bare_value(&mut self) -> Result<TomlValue, ReadFileError> {
        let start = self.pos;
        while let Some(b) = self.peek() {
            if matches!(b, b' ' | b'\t' | b'\n' | b'\r' | b',' | b']' | b'}' | b'#') {
                break;
            }
            self.pos += 1;
        }
        if is_valid_date(&self.src[start..self.pos])
            && self.peek() == Some(b' ')
            && self.bytes.get(self.pos + 1).is_some_and(u8::is_ascii_digit)
        {
            self.pos += 1;
            while let Some(b) = self.peek() {
                if matches!(b, b' ' | b'\t' | b'\n' | b'\r' | b',' | b']' | b'}' | b'#') {
                    break;
                }
                self.pos += 1;
            }
        }
        let tok = &self.src[start..self.pos];
        if tok == "true" {
            return Ok(TomlValue::Bool(true));
        }
        if tok == "false" {
            return Ok(TomlValue::Bool(false));
        }
        if is_valid_number(tok) || is_valid_datetime(tok) {
            return Ok(TomlValue::Scalar);
        }
        Err(syntax_err(format!(
            "invalid TOML value \"{tok}\" in Cargo.toml"
        )))
    }

    fn parse_value(
        &mut self,
        depth: usize,
        retain: bool,
        budget: &mut MemoryBudget,
    ) -> Result<TomlValue, ReadFileError> {
        let str_val = if self.starts_with(b"\"\"\"") {
            Some(parse_ml_basic_string(self.src, &mut self.pos, retain)?)
        } else if self.starts_with(b"'''") {
            Some(parse_ml_literal_string(self.src, &mut self.pos, retain)?)
        } else if self.peek() == Some(b'"') {
            Some(parse_basic_string(self.src, &mut self.pos, retain)?)
        } else if self.peek() == Some(b'\'') {
            Some(parse_literal_string(self.src, &mut self.pos, retain)?)
        } else {
            None
        };
        if let Some(s) = str_val {
            if retain {
                budget.charge(s.len() + 16)?;
                return Ok(TomlValue::Str(s));
            }
            return Ok(TomlValue::Scalar);
        }
        match self.peek() {
            Some(b'[') => self.parse_array(depth, budget),
            Some(b'{') => self.parse_inline_table(depth, retain, budget),
            Some(_) => self.parse_bare_value(),
            None => Err(syntax_err("unexpected end of file expecting TOML value")),
        }
    }

    fn parse_header(&mut self) -> Result<(HeaderKind, Vec<String>), ReadFileError> {
        let kind = if self.starts_with(b"[[") {
            self.pos += 2;
            HeaderKind::ArrayTable
        } else {
            self.pos += 1;
            HeaderKind::Table
        };
        self.skip_ws();
        let path = self.parse_dotted_key(MAX_NESTING_DEPTH)?;
        self.skip_ws();
        match kind {
            HeaderKind::ArrayTable => {
                if !self.starts_with(b"]]") {
                    return Err(syntax_err("expected ']]' closing array-of-tables header"));
                }
                self.pos += 2;
            }
            HeaderKind::Table => {
                if self.peek() != Some(b']') {
                    return Err(syntax_err("expected ']' closing table header"));
                }
                self.pos += 1;
            }
        }
        self.expect_eol_or_eof()?;
        Ok((kind, path))
    }
}

pub(super) fn parse_toml_document(text: &str) -> Result<Vec<ParsedEntry>, ReadFileError> {
    let mut parser = Parser::new(text);
    let mut budget = MemoryBudget::new(MAX_RETAINED_BYTES);
    let mut root: BTreeMap<String, EntryKind> = BTreeMap::new();
    let mut active_ptr: Vec<(String, Option<usize>)> = Vec::new();
    let mut entries = Vec::new();

    loop {
        parser.skip_ws_newlines_comments()?;
        if parser.pos >= parser.bytes.len() {
            break;
        }
        if parser.peek() == Some(b'[') {
            let (kind, path) = parser.parse_header()?;
            active_ptr = open_table_path(&mut root, path, &kind, &mut budget)?;
            continue;
        }
        let max_key_segs = MAX_NESTING_DEPTH.saturating_sub(active_ptr.len());
        let key_path = parser.parse_dotted_key(max_key_segs)?;
        parser.skip_ws();
        if parser.peek() != Some(b'=') {
            return Err(syntax_err("expected '=' after TOML key in Cargo.toml"));
        }
        parser.pos += 1;
        parser.skip_ws();

        let in_array_table = active_ptr.iter().any(|(_, idx)| idx.is_some());
        let retain = is_identity_assignment(in_array_table, &active_ptr, &key_path);
        let value = parser.parse_value(0, retain, &mut budget)?;
        parser.expect_eol_or_eof()?;

        let is_inline = matches!(value, TomlValue::InlineTable(_));
        let cur_tbl = current_table_mut(&mut root, &active_ptr)?;
        insert_dotted_key(cur_tbl, &key_path, is_inline, &mut budget)?;

        if retain {
            let mut full_path: Vec<String> = active_ptr.iter().map(|(s, _)| s.clone()).collect();
            full_path.extend(key_path);
            let retained_bytes: usize = full_path.iter().map(|s| s.len() + 16).sum();
            budget.charge(retained_bytes)?;
            entries.push(ParsedEntry {
                header_kind: HeaderKind::Table,
                full_path,
                value,
            });
        }
    }

    Ok(entries)
}
