//! Stage 3B1 discovery against goldens recorded from the TypeScript.
//!
//! `tests/fixtures/discovery/` holds `supportedExtensions()` and, for each name in
//! `classify-input.txt` (NUL-separated), whether a parser claims it and its
//! `deployFormatOf`. Regenerate with
//! `npx tsx rust/gg-index/parity/discovery-parity.ts --record rust/gg-index/tests/fixtures/discovery`.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/discovery")
        .join(name);
    fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn run(args: &[&str], input: &[u8]) -> Vec<u8> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_gg-index"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn gg-index");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(input)
        .expect("write stdin");
    let out = child.wait_with_output().expect("wait");
    assert!(
        out.status.success(),
        "gg-index {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    out.stdout
}

#[test]
fn supported_extensions_match_typescript() {
    assert_eq!(
        String::from_utf8(run(&["extensions"], b"")).unwrap(),
        String::from_utf8(fixture("extensions.json")).unwrap()
    );
}

#[test]
fn classification_matches_typescript() {
    assert_eq!(
        String::from_utf8(run(&["classify"], &fixture("classify-input.txt"))).unwrap(),
        String::from_utf8(fixture("classify.json")).unwrap()
    );
}
