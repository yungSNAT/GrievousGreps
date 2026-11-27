//! `parse_toml_document` against `smol-toml`, the parser the TypeScript reads `Cargo.toml` with.
//!
//! `tests/fixtures/toml/table.json` holds documents, whether `smol-toml` accepts each and the string
//! `package.name` it reads, recorded by `parity/toml-parity.ts`. To add a row, put the document in the
//! file with `null` answers and rerun that script; it rewrites every answer.
//!
//! [`KEPT`] lists the rows where the Rust parser follows the TOML spec and `smol-toml` does not, with
//! the answer Rust must give instead.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use super::toml_scalars::HeaderKind;
use super::toml_syntax::{ParsedEntry, TomlValue, parse_toml_document};

/// `(document, Rust accepts, Rust's package.name)` where the answer differs from `smol-toml`'s on purpose.
const KEPT: &[(&str, bool, Option<&str>)] = &[
    // No such day: TOML dates are RFC 3339 full-dates; smol-toml checks only the ranges.
    ("x = 1979-02-29\n", false, None),
    ("x = 1900-02-29\n", false, None),
    ("x = 1979-04-31\n", false, None),
    // TOML integers are 64-bit; smol-toml refuses those past 2^53 unless asked for BigInt.
    ("x = 9223372036854775807\n", true, None),
    // RFC 3339 allows a leap second; smol-toml refuses second 60.
    ("x = 07:32:60\n", true, None),
    // The spec lets a parser normalise a newline in a multi-line string; Rust gives `\n`.
    ("[package]\nname = \"\"\"a\r\nb\"\"\"\n", true, Some("a\nb")),
    ("[package]\nname = '''a\r\nb'''\n", true, Some("a\nb")),
];

fn package_name(entries: &[ParsedEntry]) -> Option<String> {
    entries.iter().find_map(|e| {
        if e.header_kind != HeaderKind::Table {
            return None;
        }
        match (e.full_path.as_slice(), &e.value) {
            ([p, n], TomlValue::Str(s)) if p == "package" && n == "name" => Some(s.clone()),
            ([p], TomlValue::InlineTable(pairs)) if p == "package" => {
                pairs.iter().find_map(|(k, v)| match (k.as_slice(), v) {
                    ([n], TomlValue::Str(s)) if n == "name" => Some(s.clone()),
                    _ => None,
                })
            }
            _ => None,
        }
    })
}

#[test]
fn parse_toml_document_accepts_what_smol_toml_accepts() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/toml/table.json");
    let table: Value =
        serde_json::from_str(&fs::read_to_string(path).expect("read table")).expect("parse table");
    let docs = table["docs"].as_array().expect("docs");
    assert!(docs.len() > 100, "the table holds its documents");
    let mut wrong = Vec::new();
    let mut kept = 0;
    for row in docs {
        let doc = row[0].as_str().expect("document");
        let mut accepted = row[1].as_bool().expect("recorded verdict");
        let mut name = row[2].as_str().map(str::to_string);
        if let Some(&(_, ok, n)) = KEPT.iter().find(|k| k.0 == doc) {
            let rust = (ok, n.map(str::to_string));
            assert_ne!(
                (accepted, name),
                rust,
                "{doc:?}: smol-toml now agrees; drop it from KEPT"
            );
            (accepted, name) = rust;
            kept += 1;
        }
        let got = parse_toml_document(doc);
        let got_name = got.as_ref().ok().and_then(|e| package_name(e));
        if got.is_ok() != accepted || got_name != name {
            let err = got.err().map(super::manifest::ReadFileError::into_string);
            wrong.push(format!(
                "{doc:?}: smol-toml {accepted} {name:?}, Rust {err:?} {got_name:?}"
            ));
        }
    }
    assert_eq!(kept, KEPT.len(), "every KEPT document is in the table");
    assert!(
        wrong.is_empty(),
        "{} rows differ:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
}
