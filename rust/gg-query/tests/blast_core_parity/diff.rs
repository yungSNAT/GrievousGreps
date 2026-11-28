//! Git diff extraction and hunk-cap parity tests for `blast::diff`.

use std::fs;
use std::path::Path;

use gg_query::blast::diff::{ChangeStatus, DiffLine, LineRange, changed_files, ref_exists};
use tempfile::tempdir;

use crate::helpers::{commit_all, git_out, init_git, write_file};

fn setup_diverged_repo(repo: &Path) {
    init_git(repo);
    write_file(repo, "value.ts", "export const value = 1;\n");
    commit_all(repo, "common ancestor");
    git_out(repo, &["tag", "-a", "fork-point", "-m", "ancestor"]);
    let blob = git_out(repo, &["rev-parse", "HEAD:value.ts"]);
    git_out(repo, &["tag", "blob-only", &blob]);

    git_out(repo, &["checkout", "-q", "-b", "feature"]);
    write_file(repo, "value.ts", "export const value = 2;\n");
    commit_all(repo, "feature changes value");

    git_out(repo, &["checkout", "-q", "main"]);
    write_file(repo, "base-only.ts", "export const baseOnly = true;\n");
    commit_all(repo, "main advances");

    git_out(repo, &["checkout", "-q", "feature"]);
    write_file(repo, "value.ts", "export const value = 3;\n");
}

#[test]
fn blast_diff_ref_exists_and_explicit_base_comparison() {
    let tmp = tempdir().expect("tempdir");
    let repo = tmp.path();
    init_git(repo);
    assert!(!ref_exists(repo, "HEAD"));
    assert!(changed_files(repo, None).is_none());
    assert!(changed_files(&repo.join("absent"), None).is_none());

    let tmp2 = tempdir().expect("tempdir");
    let diverged = tmp2.path();
    setup_diverged_repo(diverged);

    assert!(ref_exists(diverged, "main"));
    assert!(ref_exists(diverged, "fork-point"));
    assert!(!ref_exists(diverged, "blob-only"));
    assert!(!ref_exists(diverged, "missing-base"));
    for bad in ["", "-", "--all", "-n1"] {
        assert!(!ref_exists(diverged, bad), "{bad:?}");
    }

    let res = changed_files(diverged, Some("main")).expect("base diff");
    assert_eq!(res.basis, "main...HEAD");
    assert_eq!(res.files.len(), 1);
    assert_eq!(res.files[0].path, "value.ts");
    assert_eq!(res.files[0].status, ChangeStatus::Modified);
    assert_eq!(res.files[0].ranges, vec![LineRange { start: 1, end: 1 }]);
    assert_eq!(
        res.files[0].hunks[0].lines,
        vec![
            DiffLine {
                n: None,
                sign: "-",
                text: "export const value = 1;".to_string(),
            },
            DiffLine {
                n: Some(1),
                sign: "+",
                text: "export const value = 2;".to_string(),
            },
        ]
    );
    let same = changed_files(diverged, Some("HEAD")).expect("HEAD...HEAD");
    assert_eq!((same.basis.as_str(), same.files.len()), ("HEAD...HEAD", 0));
    assert!(changed_files(diverged, Some("missing-base")).is_none());
}

#[test]
fn blast_diff_clean_root_and_head_minus_one_fallback() {
    let tmp = tempdir().expect("tempdir");
    let repo = tmp.path();
    init_git(repo);
    write_file(repo, "story.txt", "first line\n");
    commit_all(repo, "root commit");

    // Clean root commit (no HEAD~1): untracked file stays out, falls back to empty diff.
    write_file(repo, "scratch.txt", "untracked\n");
    let root_clean = changed_files(repo, None).expect("clean root");
    assert_eq!(root_clean.basis, "working tree vs HEAD");
    assert!(root_clean.files.is_empty());
    fs::remove_file(repo.join("scratch.txt")).expect("rm scratch");

    // Second commit then clean tree: reports HEAD~1...HEAD.
    write_file(repo, "story.txt", "first line\nsecond line\n");
    commit_all(repo, "second commit");
    let last = changed_files(repo, None).expect("HEAD~1...HEAD");
    assert_eq!(last.basis, "HEAD~1...HEAD");
    assert_eq!(last.files.len(), 1);
    assert_eq!(last.files[0].ranges, vec![LineRange { start: 2, end: 2 }]);
    assert_eq!(last.files[0].hunks[0].lines[0].text, "second line");
}

#[test]
fn blast_diff_statuses_pure_deletions_renames_binary_and_sql() {
    let tmp = tempdir().expect("tempdir");
    let repo = tmp.path();
    init_git(repo);
    write_file(
        repo,
        "guide.txt",
        "obsolete heading\nkept title\nkept intro\nobsolete sentence\nkept footer\n",
    );
    write_file(repo, "retired.txt", "no longer needed\n");
    write_file(repo, "old.ts", "export const k = 1;\nexport const m = 2;\n");
    fs::write(repo.join("image.bin"), [0_u8, 1, 2]).expect("write bin");
    commit_all(repo, "initial");

    write_file(repo, "guide.txt", "kept title\nkept intro\nkept footer\n");
    fs::remove_file(repo.join("retired.txt")).expect("rm retired");
    fs::write(repo.join("image.bin"), [0_u8, 3, 4]).expect("edit bin");
    write_file(repo, "notes.txt", "no final newline");
    write_file(repo, "query.sql", "-- report\n");
    git_out(repo, &["mv", "old.ts", "moved.ts"]);
    git_out(repo, &["add", "notes.txt", "query.sql"]);

    let wt = changed_files(repo, None).expect("working tree");
    let by_path = |p: &str| wt.files.iter().find(|f| f.path == p).expect(p);

    let guide = by_path("guide.txt");
    assert_eq!(
        guide.ranges,
        vec![
            LineRange { start: 0, end: 0 },
            LineRange { start: 2, end: 2 }
        ]
    );
    assert_eq!(guide.hunks[0].lines[0].text, "obsolete heading");
    assert_eq!(guide.hunks[1].lines[0].text, "obsolete sentence");

    let retired = by_path("retired.txt");
    assert_eq!(retired.status, ChangeStatus::Deleted);
    assert!(retired.ranges.is_empty() && retired.hunks.is_empty());

    let moved = by_path("moved.ts");
    assert_eq!(moved.status, ChangeStatus::Renamed);
    assert_eq!(moved.old_path.as_deref(), Some("old.ts"));

    let notes = by_path("notes.txt");
    assert_eq!(notes.status, ChangeStatus::Added);
    assert_eq!(notes.hunks[0].lines[0].text, "no final newline");
    assert!(by_path("image.bin").ranges.is_empty());
    assert_eq!(by_path("query.sql").hunks[0].lines[0].text, "-- report");
}

fn build_cap_fixture(repo: &Path) -> Vec<LineRange> {
    let (mut old_lines, mut new_lines, mut ranges) = (Vec::new(), Vec::new(), Vec::new());
    for (block, size) in [15_usize, 12, 12, 12, 12, 12, 12, 12, 3, 1]
        .into_iter()
        .enumerate()
    {
        let start = new_lines.len() + 1;
        ranges.push(LineRange {
            start,
            end: start + size - 1,
        });
        for line in 1..=size {
            old_lines.push(format!("old block {block} line {line}"));
            new_lines.push(format!("new block {block} line {line}"));
        }
        old_lines.extend([format!("stable sep {block}"), format!("stable end {block}")]);
        new_lines.extend([format!("stable sep {block}"), format!("stable end {block}")]);
    }
    write_file(
        repo,
        "generated.txt",
        &format!("{}\n", old_lines.join("\n")),
    );
    write_file(repo, "summary.txt", "old summary\n");
    commit_all(repo, "initial");
    write_file(
        repo,
        "generated.txt",
        &format!("{}\n", new_lines.join("\n")),
    );
    write_file(repo, "summary.txt", "new summary\n");
    ranges
}

#[test]
fn blast_diff_hunk_and_file_caps_preserve_ranges_and_reset_next_file() {
    let tmp = tempdir().expect("tempdir");
    init_git(tmp.path());
    let expected_ranges = build_cap_fixture(tmp.path());

    let res = changed_files(tmp.path(), None).expect("capped diff");
    let generated = res
        .files
        .iter()
        .find(|f| f.path == "generated.txt")
        .unwrap();
    assert_eq!(generated.ranges, expected_ranges);
    let kept: Vec<usize> = generated.hunks.iter().map(|h| h.lines.len()).collect();
    let dropped: Vec<usize> = generated.hunks.iter().map(|h| h.dropped).collect();
    assert_eq!(kept, vec![24, 24, 24, 24, 24, 24, 24, 24, 2, 0]);
    assert_eq!(dropped, vec![6, 0, 0, 0, 0, 0, 0, 0, 4, 2]);
    assert_eq!(generated.hunks[8].lines[0].text, "old block 8 line 1");
    assert_eq!(generated.hunks[8].lines[1].text, "old block 8 line 2");

    let summary = res.files.iter().find(|f| f.path == "summary.txt").unwrap();
    assert_eq!(
        (summary.hunks[0].lines.len(), summary.hunks[0].dropped),
        (2, 0)
    );
}

#[test]
fn blast_diff_failing_textconv_keeps_name_status_result() {
    let tmp = tempdir().expect("tempdir");
    let repo = tmp.path();
    init_git(repo);
    write_file(repo, ".gitattributes", "report.dat diff=report\n");
    write_file(repo, "report.dat", "previous report\n");
    commit_all(repo, "initial");

    git_out(repo, &["config", "diff.report.textconv", "git cat-file"]);
    write_file(repo, "report.dat", "updated report\n");
    let degraded = changed_files(repo, None).expect("degraded diff");
    let dat = degraded
        .files
        .iter()
        .find(|f| f.path == "report.dat")
        .unwrap();
    assert_eq!(dat.status, ChangeStatus::Modified);
    assert!(dat.ranges.is_empty() && dat.hunks.is_empty());

    git_out(repo, &["config", "--unset", "diff.report.textconv"]);
    let ok = changed_files(repo, None).expect("recovered diff");
    let dat_ok = ok.files.iter().find(|f| f.path == "report.dat").unwrap();
    assert_eq!(dat_ok.ranges, vec![LineRange { start: 1, end: 1 }]);
    assert_eq!(dat_ok.hunks[0].lines.len(), 2);
}
