//! Zero-dependency TOML 1.0 recursive-descent parser for `Cargo.toml`
//! manifests. Validates full document syntax fail-closed before returning
//! extracted entries.

use std::collections::BTreeMap;

use super::manifest::ReadFileError;
use super::toml_scalars::{
    EntryKind, HeaderKind, current_table_mut, insert_dotted_key, is_bare_key_byte,
    is_disallowed_control, is_valid_date, is_valid_datetime, is_valid_number, open_table_path,
    parse_escape_at, syntax_err,
};

pub(super) const MAX_NESTING_DEPTH: usize = 256;

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
        match self.peek() {
            Some(b'\n') => {
                self.pos += 1;
                Ok(true)
            }
            Some(b'\r') => {
                if self.bytes.get(self.pos + 1) != Some(&b'\n') {
                    return Err(syntax_err("bare carriage return in Cargo.toml"));
                }
                self.pos += 2;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    fn skip_comment(&mut self) -> Result<bool, ReadFileError> {
        if self.peek() != Some(b'#') {
            return Ok(false);
        }
        self.pos += 1;
        while let Some(ch) = self.src[self.pos..].chars().next() {
            if ch == '\n' || ch == '\r' {
                break;
            }
            if is_disallowed_control(ch, false) {
                return Err(syntax_err("invalid control character in comment"));
            }
            self.pos += ch.len_utf8();
        }
        Ok(true)
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

    fn parse_basic_string(&mut self) -> Result<String, ReadFileError> {
        self.pos += 1;
        let mut out = String::new();
        while let Some(ch) = self.src[self.pos..].chars().next() {
            if ch == '"' {
                self.pos += 1;
                return Ok(out);
            }
            if ch == '\\' {
                self.pos += 1;
                out.push(parse_escape_at(self.src, &mut self.pos)?);
                continue;
            }
            if ch == '\n' || ch == '\r' || is_disallowed_control(ch, false) {
                return Err(syntax_err("invalid control or newline in basic string"));
            }
            out.push(ch);
            self.pos += ch.len_utf8();
        }
        Err(syntax_err("unterminated basic string in Cargo.toml"))
    }

    fn parse_literal_string(&mut self) -> Result<String, ReadFileError> {
        self.pos += 1;
        let start = self.pos;
        while let Some(ch) = self.src[self.pos..].chars().next() {
            if ch == '\'' {
                let s = self.src[start..self.pos].to_string();
                self.pos += 1;
                return Ok(s);
            }
            if ch == '\n' || ch == '\r' || is_disallowed_control(ch, false) {
                return Err(syntax_err("invalid control or newline in literal string"));
            }
            self.pos += ch.len_utf8();
        }
        Err(syntax_err("unterminated literal string in Cargo.toml"))
    }

    fn consume_ml_quote_run(&mut self, quote: u8, out: &mut String) -> Result<bool, ReadFileError> {
        let mut run = 0;
        while self.pos + run < self.bytes.len() && self.bytes[self.pos + run] == quote {
            run += 1;
        }
        if run >= 6 {
            return Err(syntax_err(
                "invalid run of 6 or more quotes in multiline string",
            ));
        }
        self.pos += run;
        let keep = if run >= 3 { run - 3 } else { run };
        for _ in 0..keep {
            out.push(quote as char);
        }
        Ok(run >= 3)
    }

    fn parse_ml_basic_string(&mut self) -> Result<String, ReadFileError> {
        self.pos += 3;
        let _ = self.consume_newline()?;
        let mut out = String::new();
        while self.pos < self.bytes.len() {
            match self.bytes[self.pos] {
                b'"' => {
                    if self.consume_ml_quote_run(b'"', &mut out)? {
                        return Ok(out);
                    }
                }
                b'\\' => {
                    self.pos += 1;
                    let saved = self.pos;
                    self.skip_ws();
                    if self.consume_newline()? {
                        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
                            if matches!(self.peek(), Some(b'\n' | b'\r')) {
                                self.consume_newline()?;
                            } else {
                                self.pos += 1;
                            }
                        }
                    } else {
                        self.pos = saved;
                        out.push(parse_escape_at(self.src, &mut self.pos)?);
                    }
                }
                b'\r' => {
                    self.consume_newline()?;
                    out.push('\n');
                }
                _ => {
                    let ch = self.src[self.pos..].chars().next().unwrap();
                    if is_disallowed_control(ch, true) {
                        return Err(syntax_err("invalid control char in multiline basic string"));
                    }
                    out.push(ch);
                    self.pos += ch.len_utf8();
                }
            }
        }
        Err(syntax_err(
            "unterminated multiline basic string in Cargo.toml",
        ))
    }

    fn parse_ml_literal_string(&mut self) -> Result<String, ReadFileError> {
        self.pos += 3;
        let _ = self.consume_newline()?;
        let mut out = String::new();
        while self.pos < self.bytes.len() {
            match self.bytes[self.pos] {
                b'\'' => {
                    if self.consume_ml_quote_run(b'\'', &mut out)? {
                        return Ok(out);
                    }
                }
                b'\r' => {
                    self.consume_newline()?;
                    out.push('\n');
                }
                _ => {
                    let ch = self.src[self.pos..].chars().next().unwrap();
                    if is_disallowed_control(ch, true) {
                        return Err(syntax_err(
                            "invalid control char in multiline literal string",
                        ));
                    }
                    out.push(ch);
                    self.pos += ch.len_utf8();
                }
            }
        }
        Err(syntax_err(
            "unterminated multiline literal string in Cargo.toml",
        ))
    }

    fn parse_simple_key(&mut self) -> Result<String, ReadFileError> {
        if self.starts_with(b"\"\"\"") || self.starts_with(b"'''") {
            return Err(syntax_err("multiline string cannot be used as a TOML key"));
        }
        match self.peek() {
            Some(b'"') => self.parse_basic_string(),
            Some(b'\'') => self.parse_literal_string(),
            Some(b) if is_bare_key_byte(b) => {
                let start = self.pos;
                while self.peek().is_some_and(is_bare_key_byte) {
                    self.pos += 1;
                }
                Ok(self.src[start..self.pos].to_string())
            }
            _ => Err(syntax_err("expected TOML key in Cargo.toml")),
        }
    }

    fn parse_dotted_key(&mut self) -> Result<Vec<String>, ReadFileError> {
        let mut parts = vec![self.parse_simple_key()?];
        loop {
            self.skip_ws();
            if self.peek() != Some(b'.') {
                break;
            }
            self.pos += 1;
            self.skip_ws();
            parts.push(self.parse_simple_key()?);
        }
        Ok(parts)
    }

    fn parse_array(&mut self, depth: usize) -> Result<TomlValue, ReadFileError> {
        if depth >= MAX_NESTING_DEPTH {
            return Err(ReadFileError::BudgetExhausted(format!(
                "Cargo.toml nesting depth exceeds {MAX_NESTING_DEPTH}"
            )));
        }
        self.pos += 1;
        loop {
            self.skip_ws_newlines_comments()?;
            if self.peek() == Some(b']') {
                self.pos += 1;
                return Ok(TomlValue::Array);
            }
            let _ = self.parse_value(depth + 1)?;
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

    fn parse_inline_table(&mut self, depth: usize) -> Result<TomlValue, ReadFileError> {
        if depth >= MAX_NESTING_DEPTH {
            return Err(ReadFileError::BudgetExhausted(format!(
                "Cargo.toml nesting depth exceeds {MAX_NESTING_DEPTH}"
            )));
        }
        self.pos += 1;
        self.skip_ws();
        let mut pairs = Vec::new();
        let mut seen: BTreeMap<String, EntryKind> = BTreeMap::new();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(TomlValue::InlineTable(pairs));
        }
        loop {
            self.skip_ws();
            let key = self.parse_dotted_key()?;
            self.skip_ws();
            if self.peek() != Some(b'=') {
                return Err(syntax_err("expected '=' in inline table"));
            }
            self.pos += 1;
            self.skip_ws();
            let val = self.parse_value(depth + 1)?;
            insert_dotted_key(&mut seen, &key, matches!(val, TomlValue::InlineTable(_)))?;
            pairs.push((key, val));
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

    fn parse_value(&mut self, depth: usize) -> Result<TomlValue, ReadFileError> {
        if self.starts_with(b"\"\"\"") {
            return self.parse_ml_basic_string().map(TomlValue::Str);
        }
        if self.starts_with(b"'''") {
            return self.parse_ml_literal_string().map(TomlValue::Str);
        }
        match self.peek() {
            Some(b'"') => self.parse_basic_string().map(TomlValue::Str),
            Some(b'\'') => self.parse_literal_string().map(TomlValue::Str),
            Some(b'[') => self.parse_array(depth),
            Some(b'{') => self.parse_inline_table(depth),
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
        let path = self.parse_dotted_key()?;
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
    let mut root: BTreeMap<String, EntryKind> = BTreeMap::new();
    let mut active_ptr: Vec<(String, Option<usize>)> = Vec::new();
    let mut active_kind = HeaderKind::Table;
    let mut active_path: Vec<String> = Vec::new();
    let mut entries = Vec::new();

    loop {
        parser.skip_ws_newlines_comments()?;
        if parser.pos >= parser.bytes.len() {
            break;
        }
        if parser.peek() == Some(b'[') {
            let (kind, path) = parser.parse_header()?;
            active_ptr = open_table_path(&mut root, &path, &kind)?;
            active_kind = kind;
            active_path = path;
            continue;
        }
        let key_path = parser.parse_dotted_key()?;
        parser.skip_ws();
        if parser.peek() != Some(b'=') {
            return Err(syntax_err("expected '=' after TOML key in Cargo.toml"));
        }
        parser.pos += 1;
        parser.skip_ws();
        let value = parser.parse_value(0)?;
        parser.expect_eol_or_eof()?;

        let is_inline = matches!(value, TomlValue::InlineTable(_));
        let cur_tbl = current_table_mut(&mut root, &active_ptr)?;
        insert_dotted_key(cur_tbl, &key_path, is_inline)?;

        let mut full_path = active_path.clone();
        full_path.extend(key_path);
        entries.push(ParsedEntry {
            header_kind: active_kind.clone(),
            full_path,
            value,
        });
    }

    Ok(entries)
}
