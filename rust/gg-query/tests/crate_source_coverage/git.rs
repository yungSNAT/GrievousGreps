//! Git checkout verification, pointer resolution, slug matching and budget tests.

use std::fs;
use std::path::Path;

use gg_query::crate_source::ResolutionStatus;

use crate::{make_lock, resolve_one, status_of, write_file};

const SHA: &str = "0123456789abcdef0123456789abcdef01234567";
const WRONG_SHA: &str = "0123456789abcdef0123456789abcdef99999999";
const SHORT: &str = "0123456";
const GIT_SRC: &str =
    "git+https://github.com/org/myrepo.git#0123456789abcdef0123456789abcdef01234567";
const PKG_TOML: &str = "[package]\nname = \"gpkg\"\nversion = \"1.0.0\"\n";

fn setup_repo(base: &Path, src: &str) -> std::path::PathBuf {
    let repo = base.join("repo");
    write_file(
        &repo.join("Cargo.lock"),
        make_lock("gpkg", "1.0.0", Some(src)),
    );
    repo
}

#[test]
fn rejects_bad_git_urls_missing_checkouts_and_checkout_limit() {
    let tmp = tempfile::tempdir().unwrap();
    let ch_empty = tmp.path().join("ch_empty");
    fs::create_dir_all(&ch_empty).unwrap();

    for (bad_src, expect) in [
        ("git+https://github.com/org/myrepo", "lacks a commit SHA"),
        (
            "git+https://github.com/org/myrepo#abc123",
            "40-char commit SHA",
        ),
    ] {
        let r = tmp.path().join(format!("bad_{}", bad_src.len()));
        write_file(
            &r.join("Cargo.lock"),
            make_lock("gpkg", "1.0.0", Some(bad_src)),
        );
        let rep = resolve_one(&r, &ch_empty, "gpkg", None, None).unwrap();
        assert_eq!(rep.matches[0].status, ResolutionStatus::Unresolved);
        assert!(rep.matches[0].hint.as_deref().unwrap().contains(expect));
    }

    let repo = setup_repo(tmp.path(), GIT_SRC);
    assert_eq!(
        status_of(&repo, &ch_empty, "gpkg"),
        ResolutionStatus::NotCached
    );

    let ch_many = tmp.path().join("ch_many");
    for i in 0..130 {
        write_file(&ch_many.join(format!("git/checkouts/entry-{i:03}")), "");
    }
    assert_eq!(
        status_of(&repo, &ch_many, "gpkg"),
        ResolutionStatus::BudgetExhausted
    );
}

#[test]
fn resolves_git_absolute_and_relative_gitdir_pointers_and_ambiguity() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = setup_repo(tmp.path(), GIT_SRC);
    let ch = tmp.path().join("ch");

    let db_dir = ch.join("git/db/myrepo-db");
    let cfg = "[core]\n\tbare = false\n[remote \"origin\"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\turl = https://github.com/org/myrepo.git\n";
    write_file(&db_dir.join("config"), cfg);
    write_file(&db_dir.join("HEAD"), "ref: refs/heads/main\n");
    write_file(&db_dir.join("refs/heads/main"), format!("{SHA}\n"));

    let rev_abs = ch.join(format!("git/checkouts/myrepo-1111/{SHORT}"));
    write_file(&rev_abs.join("Cargo.toml"), PKG_TOML);
    let abs_db = fs::canonicalize(&db_dir).unwrap();
    write_file(
        &rev_abs.join(".git"),
        format!("gitdir: {}\n", abs_db.display()),
    );

    write_file(&ch.join("git/checkouts/.keep"), "");
    fs::create_dir_all(ch.join("git/checkouts/norev-0000")).unwrap();
    let wrong = ch.join(format!("git/checkouts/wrong-2222/{SHORT}"));
    write_file(&wrong.join(".git/HEAD"), format!("{WRONG_SHA}\n"));
    write_file(&wrong.join("Cargo.toml"), PKG_TOML);
    let unv = ch.join(format!("git/checkouts/other-3333/{SHORT}"));
    write_file(
        &unv.join("Cargo.toml"),
        "[package]\nname = \"unrelated\"\nversion = \"1.0.0\"\n",
    );

    assert_eq!(status_of(&repo, &ch, "gpkg"), ResolutionStatus::Found);

    let rev_rel = ch.join(format!("git/checkouts/myrepo-9999/{SHORT}"));
    write_file(&rev_rel.join("Cargo.toml"), PKG_TOML);
    write_file(&rev_rel.join(".git"), "gitdir: ../../../db/myrepo-db\n");
    assert_eq!(status_of(&repo, &ch, "gpkg"), ResolutionStatus::Ambiguous);

    fs::remove_dir_all(ch.join("git/checkouts/myrepo-1111")).unwrap();
    assert_eq!(status_of(&repo, &ch, "gpkg"), ResolutionStatus::Found);
}

#[test]
fn resolves_git_vcs_info_and_slug_matching() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = setup_repo(tmp.path(), GIT_SRC);
    let ch = tmp.path().join("ch_vcs");
    let vcs = format!("{{\"git\":{{\"sha1\":\"{SHA}\"}}}}");

    let rev_bad = ch.join(format!("git/checkouts/otherrepo-aaaa/{SHORT}"));
    write_file(&rev_bad.join(".git/config"), "[core]\n\tbare = false\n");
    write_file(&rev_bad.join(".cargo-vcs-info.json"), &vcs);
    write_file(&rev_bad.join("Cargo.toml"), PKG_TOML);
    assert_eq!(status_of(&repo, &ch, "gpkg"), ResolutionStatus::NotCached);

    let repo_noslug = tmp.path().join("repo_noslug");
    write_file(
        &repo_noslug.join("Cargo.lock"),
        make_lock("gpkg", "1.0.0", Some(&format!("git+#{SHA}"))),
    );
    assert_eq!(
        status_of(&repo_noslug, &ch, "gpkg"),
        ResolutionStatus::NotCached
    );

    let rev_ok = ch.join(format!("git/checkouts/myrepo-bbbb/{SHORT}"));
    write_file(&rev_ok.join(".cargo-vcs-info.json"), &vcs);
    write_file(&rev_ok.join("Cargo.toml"), PKG_TOML);
    assert_eq!(status_of(&repo, &ch, "gpkg"), ResolutionStatus::Found);
}

fn seed_bad_git_case(tag: &str, rev: &Path, ch: &Path, outside: &Path) {
    match tag {
        "gitfile_bad_utf8" => write_file(&rev.join(".git"), [0xff, 0xfe]),
        "gitfile_no_prefix" => write_file(&rev.join(".git"), "notgitdir\n"),
        "gitfile_escape" => write_file(
            &rev.join(".git"),
            format!("gitdir: {}\n", outside.display()),
        ),
        "gitfile_to_file" => {
            let f = ch.join("git/not_a_dir");
            write_file(&f, "x");
            write_file(&rev.join(".git"), format!("gitdir: {}\n", f.display()));
        }
        "head_bad_utf8" => write_file(&rev.join(".git/HEAD"), [0xff, 0xfe]),
        "head_invalid_text" => write_file(&rev.join(".git/HEAD"), "corrupt-head\n"),
        "ref_short_sha" => {
            write_file(&rev.join(".git/HEAD"), "ref: refs/heads/main\n");
            write_file(&rev.join(".git/refs/heads/main"), "short\n");
        }
        "ref_bad_utf8" => {
            write_file(&rev.join(".git/HEAD"), "ref: refs/heads/main\n");
            write_file(&rev.join(".git/refs/heads/main"), [0xff, 0xfe]);
        }
        "ref_missing" => write_file(&rev.join(".git/HEAD"), "ref: refs/heads/missing\n"),
        "vcs_short_sha" => write_file(
            &rev.join(".cargo-vcs-info.json"),
            "{\"git\":{\"sha1\":\"short\"}}",
        ),
        "vcs_bad_utf8" => write_file(&rev.join(".cargo-vcs-info.json"), [0xff, 0xfe]),
        _ => unreachable!(),
    }
}

#[test]
fn rejects_malformed_git_pointers_refs_head_and_vcs_info() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = setup_repo(tmp.path(), GIT_SRC);
    let outside = tmp.path().join("outside");
    fs::create_dir_all(&outside).unwrap();

    for tag in [
        "gitfile_bad_utf8",
        "gitfile_no_prefix",
        "gitfile_escape",
        "gitfile_to_file",
        "head_bad_utf8",
        "head_invalid_text",
        "ref_short_sha",
        "ref_bad_utf8",
        "ref_missing",
        "vcs_short_sha",
        "vcs_bad_utf8",
    ] {
        let ch = tmp.path().join(format!("ch_{tag}"));
        let rev = ch.join(format!("git/checkouts/myrepo-1/{SHORT}"));
        write_file(&rev.join("Cargo.toml"), PKG_TOML);
        seed_bad_git_case(tag, &rev, &ch, &outside);
        assert_eq!(
            status_of(&repo, &ch, "gpkg"),
            ResolutionStatus::Unresolved,
            "{tag}"
        );
    }
}

fn seed_git_budget_case(tag: &str, rev: &Path) {
    match tag {
        "gitfile_big" => write_file(&rev.join(".git"), "a".repeat(5000)),
        "config_big" => write_file(&rev.join(".git/config"), "a".repeat(260 * 1024)),
        "head_big" => write_file(&rev.join(".git/HEAD"), "a".repeat(5000)),
        "ref_big" => {
            write_file(&rev.join(".git/HEAD"), "ref: refs/heads/main\n");
            write_file(&rev.join(".git/refs/heads/main"), "a".repeat(5000));
        }
        "vcs_big" => write_file(&rev.join(".cargo-vcs-info.json"), "a".repeat(260 * 1024)),
        "verified_scan_budget" => {
            write_file(&rev.join(".git/HEAD"), format!("{SHA}\n"));
            write_file(
                &rev.join(".git/config"),
                "[remote \"origin\"]\n\turl = https://github.com/org/myrepo.git\n",
            );
            for i in 0..515 {
                write_file(&rev.join(format!("f{i:04}")), "");
            }
        }
        _ => unreachable!(),
    }
}

#[test]
fn enforces_git_metadata_budgets_and_verified_workspace_errors() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = setup_repo(tmp.path(), GIT_SRC);

    for tag in [
        "gitfile_big",
        "config_big",
        "head_big",
        "ref_big",
        "vcs_big",
        "verified_scan_budget",
    ] {
        let ch = tmp.path().join(format!("ch_{tag}"));
        let rev = ch.join(format!("git/checkouts/myrepo-1/{SHORT}"));
        fs::create_dir_all(&rev).unwrap();
        seed_git_budget_case(tag, &rev);
        assert_eq!(
            status_of(&repo, &ch, "gpkg"),
            ResolutionStatus::BudgetExhausted,
            "{tag}"
        );
    }

    let ch_ws = tmp.path().join("ch_ws");
    let rev_ws = ch_ws.join(format!("git/checkouts/myrepo-1/{SHORT}"));
    write_file(&rev_ws.join(".git/HEAD"), format!("{SHA}\n"));
    write_file(
        &rev_ws.join(".git/config"),
        "[remote \"origin\"]\n\turl = https://github.com/org/myrepo.git\n",
    );
    write_file(&rev_ws.join("Cargo.toml"), "[workspace]\nmembers = [\n");
    write_file(
        &rev_ws.join("sub/Cargo.toml"),
        "[package]\nname = \"gpkg\"\nversion.workspace = true\n",
    );
    assert_eq!(
        status_of(&repo, &ch_ws, "gpkg"),
        ResolutionStatus::Unresolved
    );
}
