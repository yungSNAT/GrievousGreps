//! `parse_toml_document` against `smol-toml`, the parser the TypeScript reads `Cargo.toml` with.
//!
//! `tests/fixtures/toml/table.json` holds documents, whether `smol-toml` accepts each and the string
//! `package.name` it reads, recorded by `parity/toml-parity.ts`. To add a row, put the document in the
//! file with `null` answers and rerun that script; it rewrites every answer.
//!
//! [`KEPT`] lists the rows where the Rust parser follows the TOML spec and `smol-toml` does not, with
//! the answer Rust must give instead.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use super::manifest::ReadFileError;
use super::toml_scalars::{
    EntryKind, HeaderKind, MAX_NESTING_DEPTH, MAX_RETAINED_BYTES, MemoryBudget, current_table_mut,
    open_table_path,
};
use super::toml_syntax::{ParsedEntry, TomlValue, parse_toml_document};

/// `(document, Rust accepts, Rust's package.name)` where the answer differs from `smol-toml`'s on purpose.
const KEPT: &[(&str, bool, Option<&str>)] = &[
    // No such day: TOML dates are RFC 3339 full-dates; smol-toml checks only the ranges.
    ("x = 1979-02-29\n", false, None),
    ("x = 1900-02-29\n", false, None),
    ("x = 1979-04-31\n", false, None),
    // TOML integers are 64-bit; smol-toml refuses those past 2^53 unless asked for BigInt.
    ("x = 9223372036854775807\n", true, None),
    // TOML 1.0.0 ABNF (time-second = 2DIGIT ; 00-58, 00-59, 00-60) and toml-test's
    // invalid/datetime/second-over.toml (61) permit second 60; smol-toml refuses it.
    ("x = 07:32:60\n", true, None),
    // TOML 1.0.0 lets a parser normalise newlines in a multi-line basic string; Rust gives `\n`.
    ("[package]\nname = \"\"\"a\r\nb\"\"\"\n", true, Some("a\nb")),
    // Dotted keys may define an implicit super-table created by a sub-table header (also pinned by
    // tests/manifest_toml_validation.rs); smol-toml marks implicit super-tables as explicit.
    ("[a.b.c]\n[a]\nb.d = 1\n", true, None),
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
    assert_eq!(
        docs.len(),
        307,
        "the table holds all 307 recorded documents"
    );
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

#[test]
fn parse_toml_document_retains_only_package_and_workspace_identity_paths() {
    let ws_inline = parse_toml_document("workspace = { package = { version = '1.0.0' } }\n")
        .expect("workspace inline table");
    assert_eq!(ws_inline.len(), 1);
    assert_eq!(ws_inline[0].full_path, ["workspace"]);
    assert!(matches!(ws_inline[0].value, TomlValue::InlineTable(_)));

    let ws_pkg_inline = parse_toml_document("[workspace]\npackage = { version = '2.0.0' }\n")
        .expect("workspace.package inline table");
    assert_eq!(ws_pkg_inline.len(), 1);
    assert_eq!(ws_pkg_inline[0].full_path, ["workspace", "package"]);
    assert!(matches!(ws_pkg_inline[0].value, TomlValue::InlineTable(_)));

    let ws_pkg_ver = parse_toml_document("[workspace.package]\nversion = '3.0.0'\n")
        .expect("workspace.package.version");
    assert_eq!(ws_pkg_ver.len(), 1);
    assert_eq!(ws_pkg_ver[0].full_path, ["workspace", "package", "version"]);
    assert!(matches!(&ws_pkg_ver[0].value, TomlValue::Str(s) if s == "3.0.0"));

    let pkg_ver_ws = parse_toml_document("[package]\nversion.workspace = true\n")
        .expect("package.version.workspace");
    assert_eq!(pkg_ver_ws.len(), 1);
    assert_eq!(pkg_ver_ws[0].full_path, ["package", "version", "workspace"]);
    assert!(matches!(pkg_ver_ws[0].value, TomlValue::Bool(true)));

    let non_identity =
        parse_toml_document("[package.metadata.a]\nb = 1\n[workspace.metadata]\nv = '1'\n")
            .expect("non-identity entries");
    assert!(non_identity.is_empty());
}

#[test]
fn nesting_depth_budget_rejects_excess_header_key_and_inline_table_depth() {
    let header_256 = format!("[{}]\n", vec!["a"; MAX_NESTING_DEPTH].join("."));
    assert!(
        parse_toml_document(&header_256).is_ok(),
        "header at MAX_NESTING_DEPTH segments succeeds"
    );

    let header_256_with_key = format!("{header_256}x = 1\n");
    assert!(
        matches!(
            parse_toml_document(&header_256_with_key),
            Err(ReadFileError::BudgetExhausted(_))
        ),
        "assignment under a MAX_NESTING_DEPTH header leaves 0 key segments"
    );

    let header_257 = format!("[{}]\n", vec!["a"; MAX_NESTING_DEPTH + 1].join("."));
    assert!(
        matches!(
            parse_toml_document(&header_257),
            Err(ReadFileError::BudgetExhausted(_))
        ),
        "header above MAX_NESTING_DEPTH fails closed"
    );

    let inline_255 = format!(
        "x = {}{{}}{}\n",
        "{a=".repeat(MAX_NESTING_DEPTH - 1),
        "}".repeat(MAX_NESTING_DEPTH - 1)
    );
    assert!(
        parse_toml_document(&inline_255).is_ok(),
        "inline table at depth MAX_NESTING_DEPTH - 1 succeeds"
    );

    let inline_256 = format!(
        "x = {}{{}}{}\n",
        "{a=".repeat(MAX_NESTING_DEPTH),
        "}".repeat(MAX_NESTING_DEPTH)
    );
    assert!(
        matches!(
            parse_toml_document(&inline_256),
            Err(ReadFileError::BudgetExhausted(_))
        ),
        "inline table at depth MAX_NESTING_DEPTH fails closed"
    );

    let array_256 = format!(
        "x = {}{}\n",
        "[".repeat(MAX_NESTING_DEPTH),
        "]".repeat(MAX_NESTING_DEPTH)
    );
    assert!(
        parse_toml_document(&array_256).is_ok(),
        "array at depth MAX_NESTING_DEPTH - 1 succeeds"
    );

    let array_257 = format!(
        "x = {}{}\n",
        "[".repeat(MAX_NESTING_DEPTH + 1),
        "]".repeat(MAX_NESTING_DEPTH + 1)
    );
    assert!(
        matches!(
            parse_toml_document(&array_257),
            Err(ReadFileError::BudgetExhausted(_))
        ),
        "array at depth MAX_NESTING_DEPTH fails closed"
    );
}

#[test]
fn table_tree_guards_fail_closed_on_invalid_internal_state() {
    let mut root = BTreeMap::new();
    let mut budget = MemoryBudget::new(MAX_RETAINED_BYTES);
    let too_deep = vec!["a".to_string(); MAX_NESTING_DEPTH + 1];
    assert!(
        matches!(
            open_table_path(&mut root, too_deep, &HeaderKind::Table, &mut budget),
            Err(ReadFileError::BudgetExhausted(_))
        ),
        "open_table_path enforces MAX_NESTING_DEPTH independently"
    );

    root.insert("arr".to_string(), EntryKind::ArrayOfTables(Vec::new()));
    assert!(
        matches!(
            open_table_path(
                &mut root,
                vec!["arr".to_string(), "sub".to_string()],
                &HeaderKind::Table,
                &mut budget
            ),
            Err(ReadFileError::Other(_))
        ),
        "open_table_path rejects an empty array-of-tables entry without panicking"
    );

    assert!(
        matches!(
            current_table_mut(&mut root, &[("missing".to_string(), None)]),
            Err(ReadFileError::Other(_))
        ),
        "current_table_mut fails closed on a missing table segment"
    );
    assert!(
        matches!(
            current_table_mut(&mut root, &[("arr".to_string(), None)]),
            Err(ReadFileError::Other(_))
        ),
        "current_table_mut fails closed on a table/array-index mismatch"
    );
}
