//! String literal parsers (single-line and multiline, basic and literal) for
//! zero-dependency TOML 1.0 manifest validation.

use super::manifest::ReadFileError;
use super::toml_scalars::{is_disallowed_control, parse_escape_at, syntax_err};

pub(super) fn consume_newline_at(bytes: &[u8], pos: &mut usize) -> Result<bool, ReadFileError> {
    match bytes.get(*pos) {
        Some(b'\n') => {
            *pos += 1;
            Ok(true)
        }
        Some(b'\r') => {
            if bytes.get(*pos + 1) != Some(&b'\n') {
                return Err(syntax_err("bare carriage return in Cargo.toml"));
            }
            *pos += 2;
            Ok(true)
        }
        _ => Ok(false),
    }
}

pub(super) fn parse_basic_string(
    src: &str,
    pos: &mut usize,
    retain: bool,
) -> Result<String, ReadFileError> {
    *pos += 1;
    let mut out = String::new();
    while let Some(ch) = src[*pos..].chars().next() {
        if ch == '"' {
            *pos += 1;
            return Ok(out);
        }
        if ch == '\\' {
            *pos += 1;
            let esc = parse_escape_at(src, pos)?;
            if retain {
                out.push(esc);
            }
            continue;
        }
        if ch == '\n' || ch == '\r' || is_disallowed_control(ch, false) {
            return Err(syntax_err("invalid control or newline in basic string"));
        }
        if retain {
            out.push(ch);
        }
        *pos += ch.len_utf8();
    }
    Err(syntax_err("unterminated basic string in Cargo.toml"))
}

pub(super) fn parse_literal_string(
    src: &str,
    pos: &mut usize,
    retain: bool,
) -> Result<String, ReadFileError> {
    *pos += 1;
    let start = *pos;
    while let Some(ch) = src[*pos..].chars().next() {
        if ch == '\'' {
            let s = if retain {
                src[start..*pos].to_string()
            } else {
                String::new()
            };
            *pos += 1;
            return Ok(s);
        }
        if ch == '\n' || ch == '\r' || is_disallowed_control(ch, false) {
            return Err(syntax_err("invalid control or newline in literal string"));
        }
        *pos += ch.len_utf8();
    }
    Err(syntax_err("unterminated literal string in Cargo.toml"))
}

fn consume_ml_quote_run(
    bytes: &[u8],
    pos: &mut usize,
    quote: u8,
    out: &mut String,
    retain: bool,
) -> Result<bool, ReadFileError> {
    let mut run = 0;
    while *pos + run < bytes.len() && bytes[*pos + run] == quote {
        run += 1;
    }
    if run >= 6 {
        return Err(syntax_err(
            "invalid run of 6 or more quotes in multiline string",
        ));
    }
    *pos += run;
    if retain {
        let keep = if run >= 3 { run - 3 } else { run };
        for _ in 0..keep {
            out.push(quote as char);
        }
    }
    Ok(run >= 3)
}

pub(super) fn parse_ml_basic_string(
    src: &str,
    pos: &mut usize,
    retain: bool,
) -> Result<String, ReadFileError> {
    let bytes = src.as_bytes();
    *pos += 3;
    let _ = consume_newline_at(bytes, pos)?;
    let mut out = String::new();
    while *pos < bytes.len() {
        match bytes[*pos] {
            b'"' => {
                if consume_ml_quote_run(bytes, pos, b'"', &mut out, retain)? {
                    return Ok(out);
                }
            }
            b'\\' => {
                *pos += 1;
                let saved = *pos;
                while matches!(bytes.get(*pos), Some(b' ' | b'\t')) {
                    *pos += 1;
                }
                if consume_newline_at(bytes, pos)? {
                    while matches!(bytes.get(*pos), Some(b' ' | b'\t' | b'\n' | b'\r')) {
                        if matches!(bytes.get(*pos), Some(b'\n' | b'\r')) {
                            consume_newline_at(bytes, pos)?;
                        } else {
                            *pos += 1;
                        }
                    }
                } else {
                    *pos = saved;
                    let esc = parse_escape_at(src, pos)?;
                    if retain {
                        out.push(esc);
                    }
                }
            }
            b'\r' => {
                consume_newline_at(bytes, pos)?;
                if retain {
                    out.push('\n');
                }
            }
            _ => {
                let ch = src[*pos..].chars().next().unwrap();
                if is_disallowed_control(ch, true) {
                    return Err(syntax_err("invalid control char in multiline basic string"));
                }
                if retain {
                    out.push(ch);
                }
                *pos += ch.len_utf8();
            }
        }
    }
    Err(syntax_err(
        "unterminated multiline basic string in Cargo.toml",
    ))
}

pub(super) fn parse_ml_literal_string(
    src: &str,
    pos: &mut usize,
    retain: bool,
) -> Result<String, ReadFileError> {
    let bytes = src.as_bytes();
    *pos += 3;
    let _ = consume_newline_at(bytes, pos)?;
    let mut out = String::new();
    while *pos < bytes.len() {
        match bytes[*pos] {
            b'\'' => {
                if consume_ml_quote_run(bytes, pos, b'\'', &mut out, retain)? {
                    return Ok(out);
                }
            }
            b'\r' => {
                consume_newline_at(bytes, pos)?;
                if retain {
                    out.push('\n');
                }
            }
            _ => {
                let ch = src[*pos..].chars().next().unwrap();
                if is_disallowed_control(ch, true) {
                    return Err(syntax_err(
                        "invalid control char in multiline literal string",
                    ));
                }
                if retain {
                    out.push(ch);
                }
                *pos += ch.len_utf8();
            }
        }
    }
    Err(syntax_err(
        "unterminated multiline literal string in Cargo.toml",
    ))
}
