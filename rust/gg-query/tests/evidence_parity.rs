//! `gg_query::evidence` against the TypeScript it ports, row by row.
//!
//! `tests/fixtures/evidence/table.json` holds inputs and the answers `src/blast/evidence.ts`
//! (`syntaxOf`, `opensQuote`, `codeOf`) and `src/blast/blast.ts` (`codeLines`) give for them,
//! recorded by `parity/evidence-parity.ts`. To add a row, put it in the file with a `null`
//! answer and rerun that script; it rewrites every answer.
//!
//! Parity holds for these rows, which are ASCII or BMP letters. It does not hold beyond them:
//! TypeScript counts UTF-16 units where Rust counts chars or bytes (a quoted astral character,
//! the width of a blanked comment, and the `opens` offsets, which are bytes here), and `\s`
//! and `char::is_whitespace` differ on U+FEFF and U+0085 before a `#`.

use std::fs;
use std::path::PathBuf;

use gg_query::evidence::{Syntax, blank_comment_lines, code_of, opens_quote, syntax_of};
use serde_json::Value;

fn table() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/evidence/table.json");
    serde_json::from_str(&fs::read_to_string(path).expect("read table")).expect("parse table")
}

fn rows<'a>(table: &'a Value, key: &str) -> &'a [Value] {
    let rows = table[key].as_array().expect("rows");
    assert!(!rows.is_empty(), "no {key} rows");
    rows
}

fn text(v: &Value) -> &str {
    v.as_str().expect("string")
}

fn lines(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("lines")
        .iter()
        .map(|l| text(l).to_string())
        .collect()
}

fn index(v: &Value) -> usize {
    usize::try_from(v.as_u64().expect("index")).expect("index fits")
}

fn syntax_json(s: Syntax) -> Value {
    serde_json::json!({
        "slash": s.slash, "dash": s.dash, "hash": s.hash, "rust": s.rust,
        "go": s.go, "js": s.js, "jsx": s.jsx, "ts": s.ts,
    })
}

#[test]
fn syntax_of_matches_typescript() {
    let table = table();
    for row in rows(&table, "syntax") {
        let path = text(&row[0]);
        assert_eq!(syntax_json(syntax_of(path)), row[1], "syntax_of({path:?})");
    }
}

#[test]
fn opens_quote_matches_typescript() {
    let table = table();
    for row in rows(&table, "opens") {
        let (line, i, rust) = (
            text(&row[0]),
            index(&row[1]),
            row[2].as_bool().expect("rust"),
        );
        let want = row[3].as_bool().expect("answer");
        assert_eq!(
            opens_quote(line, i, rust),
            want,
            "opens_quote({line:?}, {i}, {rust})"
        );
    }
}

#[test]
fn code_of_matches_typescript_line_by_line() {
    let table = table();
    for row in rows(&table, "code") {
        let path = text(&row[0]);
        let syntax = syntax_of(path);
        let mut open = row[1].as_str().map(str::to_string);
        let answers = row[3].as_array().expect("answers");
        let input = lines(&row[2]);
        assert_eq!(input.len(), answers.len(), "{path}: one answer per line");
        for (line, want) in input.iter().zip(answers) {
            let (code, next) = code_of(line, syntax, open.clone());
            let got = serde_json::json!([code, next]);
            assert_eq!(&got, want, "code_of({line:?}) in {path}, open {open:?}");
            open = next;
        }
    }
}

#[test]
fn blank_comment_lines_matches_typescript_code_lines() {
    let table = table();
    for row in rows(&table, "blank") {
        let path = text(&row[0]);
        let input = lines(&row[1]);
        let (from, to) = (index(&row[2]), index(&row[3]));
        let got = blank_comment_lines(&input, from, to, path);
        assert_eq!(got.len(), input.len(), "{path}: indexed as the lines are");
        assert_eq!(
            serde_json::json!(&got[from - 1..to]),
            row[4],
            "{path} lines {from}-{to}"
        );
        assert!(
            got[..from - 1]
                .iter()
                .chain(&got[to..])
                .all(String::is_empty),
            "{path}: lines outside {from}-{to} stay empty"
        );
    }
}

/// TypeScript's `codeLines` is only called with lines inside the file; the Rust port clamps a
/// range that starts at 0 or runs past the end instead of panicking.
#[test]
fn blank_comment_lines_clamps_a_range_outside_the_file() {
    let input = vec!["a // b".to_string(), "c".to_string()];
    assert_eq!(
        blank_comment_lines(&input, 0, 9, "x.js"),
        vec!["a     ".to_string(), "c".to_string()]
    );
    assert_eq!(
        blank_comment_lines(&input, 3, 9, "x.js"),
        vec![String::new(); 2]
    );
}
