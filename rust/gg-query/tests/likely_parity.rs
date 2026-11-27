//! The `likely` edge grade, byte for byte against the Node `trail` CLI.
//!
//! `tests/fixtures/parity/likely-repo/` holds one caller of each grade: a typed call whose
//! type the file imports (`likely`), one typed by a platform global the repository reuses
//! (`inferred`) and one in the same file (`extracted`). Its graph and the goldens
//! `callers-save*.stdout` were written by the Node CLI.

use std::fs;
use std::path::{Path, PathBuf};

use gg_query::provenance::{Confidence, EdgeProvenance};
use snapbox::cmd::{Command, cargo_bin};
use tempfile::tempdir;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("parity")
}

fn copy_dir(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).unwrap();
    for entry in fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let to = dst.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &to);
        } else {
            fs::copy(entry.path(), &to).unwrap();
        }
    }
}

fn golden(name: &str) -> String {
    fs::read_to_string(fixtures_dir().join("golden").join(name))
        .unwrap()
        .replace("\r\n", "\n")
}

#[test]
fn likely_parses_ranks_between_extracted_and_inferred_and_counts_as_inferred() {
    assert_eq!(Confidence::parse("likely"), Confidence::Likely);
    assert_eq!(Confidence::parse("probable"), Confidence::Inferred);
    assert_eq!(Confidence::Likely.as_str(), "likely");
    assert!(Confidence::Extracted.rank() > Confidence::Likely.rank());
    assert!(Confidence::Likely.rank() > Confidence::Inferred.rank());
    assert_eq!(
        Confidence::Extracted.weakest(Confidence::Likely),
        Confidence::Likely
    );
    assert_eq!(
        Confidence::Likely.weakest(Confidence::Inferred),
        Confidence::Inferred
    );
    assert_eq!(Confidence::Likely.provenance(), EdgeProvenance::Inferred);
    assert_eq!(Confidence::Likely.mark(), " [likely]");
    assert_eq!(Confidence::Inferred.mark(), " [inferred]");
    assert_eq!(Confidence::Extracted.mark(), "");
}

#[test]
fn callers_marks_likely_and_reports_confidence_as_node_does() {
    let tmp = tempdir().unwrap();
    copy_dir(&fixtures_dir().join("likely-repo"), tmp.path());
    for (args, name) in [
        (&["callers", "save"][..], "callers-save.stdout"),
        (
            &["callers", "save", "--json"][..],
            "callers-save-json.stdout",
        ),
        (
            &["callers", "save", "--provenance"][..],
            "callers-save-provenance.stdout",
        ),
    ] {
        Command::new(cargo_bin!("gg-query"))
            .args(args)
            .arg(tmp.path())
            .assert()
            .success()
            .stdout_eq(golden(name))
            .stderr_eq("");
    }
}

/// `tests/fixtures/parity/scope-repo/` has one caller in `src/` and one in `test/`: the report
/// lists the internal one first, each under a `[scope: count]` line, and `--json` gives each
/// hit its `scope`. Graph and goldens `callers-total-scope*.stdout` were written by the Node CLI.
#[test]
fn callers_groups_internal_then_test_callers_as_node_does() {
    let tmp = tempdir().unwrap();
    copy_dir(&fixtures_dir().join("scope-repo"), tmp.path());
    for (args, name) in [
        (&["callers", "total"][..], "callers-total-scope.stdout"),
        (
            &["callers", "total", "--json"][..],
            "callers-total-scope-json.stdout",
        ),
    ] {
        Command::new(cargo_bin!("gg-query"))
            .args(args)
            .arg(tmp.path())
            .assert()
            .success()
            .stdout_eq(golden(name))
            .stderr_eq("");
    }
}
