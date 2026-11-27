//! Module and area labels (`blast` `short_label`, `dir_label`, `parent_dir`, `hub_label`,
//! `is_blast_test_path`) against `src/blast/modules.ts` and `src/blast/blast.ts`.
//!
//! `tests/fixtures/labels/table.json` holds the TypeScript answers of `shortLabel`, `dirLabel`,
//! `parentDir`, `hubLabel` and the `TEST_PATH` rule, recorded by `parity/labels-parity.ts --record`.

use std::fs;
use std::path::Path;

use gg_query::blast::{dir_label, hub_label, is_blast_test_path, parent_dir, short_label};
use serde_json::Value;

fn table() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/labels/table.json");
    serde_json::from_str(&fs::read_to_string(path).expect("read table")).expect("parse table")
}

fn rows(section: &str) -> Vec<Value> {
    let rows = table()[section].as_array().expect(section).clone();
    assert!(!rows.is_empty(), "{section} has no rows");
    rows
}

#[test]
fn short_label_matches_typescript() {
    for row in rows("short") {
        let label = row[0].as_str().unwrap();
        assert_eq!(
            short_label(label),
            row[1].as_str().unwrap(),
            "shortLabel({label:?})"
        );
    }
}

#[test]
fn dir_label_and_parent_dir_match_typescript() {
    for row in rows("dir") {
        let path = row[0].as_str().unwrap();
        assert_eq!(
            dir_label(path),
            row[1].as_str().unwrap(),
            "dirLabel({path:?})"
        );
    }
    for row in rows("parent") {
        let dir = row[0].as_str().unwrap();
        assert_eq!(
            parent_dir(dir),
            row[1].as_str().unwrap(),
            "parentDir({dir:?})"
        );
    }
}

#[test]
fn hub_label_matches_typescript() {
    for row in rows("hub") {
        let names: Vec<String> = row[0]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_str().unwrap().to_string())
            .collect();
        let fallback = row[1].as_str().unwrap();
        assert_eq!(
            hub_label(&names, fallback),
            row[2].as_str().unwrap(),
            "hubLabel({names:?}, {fallback:?})"
        );
    }
}

#[test]
fn test_path_rule_matches_typescript() {
    for row in rows("test_path") {
        let path = row[0].as_str().unwrap();
        assert_eq!(
            is_blast_test_path(path),
            row[1].as_bool().unwrap(),
            "TEST_PATH.test({path:?})"
        );
    }
}
