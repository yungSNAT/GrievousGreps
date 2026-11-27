//! Owner and reviewer inference (`blast::owners`) against `src/blast/owners.ts`.
//!
//! `tests/fixtures/owners/table.json` holds the TypeScript answers of `githubHandle`,
//! `sinceLabel` and `Date.parse` (what `ownersFor` reads `%aI` with), recorded by
//! `parity/owners-parity.ts --record`. The git cases follow `ownersFor`, `diffAuthors`
//! and `attachOwners` on real repositories.

use std::fs;
use std::path::Path;
use std::process::Command;

use gg_query::blast::owners::{
    attach_owners, diff_authors, github_handle, local_identity, now_ms, owners_for, parse_iso_ms,
    since_label,
};
use gg_query::blast::types::{BlastReport, ChangedArea, ImpactedModule, LabelSource, TestSignal};
use serde_json::Value;
use tempfile::tempdir;

const DAY_MS: f64 = 86_400_000.0;

fn table() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/owners/table.json");
    serde_json::from_str(&fs::read_to_string(path).expect("read table")).expect("parse table")
}

#[test]
fn github_handle_matches_typescript() {
    for row in table()["handles"].as_array().unwrap() {
        let email = row[0].as_str().unwrap();
        assert_eq!(
            github_handle(email).as_deref(),
            row[1].as_str(),
            "githubHandle({email:?})"
        );
    }
}

#[test]
fn since_label_matches_typescript() {
    for row in table()["since"].as_array().unwrap() {
        let (last, now) = (row[0].as_f64().unwrap(), row[1].as_f64().unwrap());
        assert_eq!(
            since_label(last, now),
            row[2].as_str().unwrap(),
            "sinceLabel({last}, {now})"
        );
    }
}

#[test]
fn parse_iso_ms_matches_date_parse() {
    for row in table()["iso"].as_array().unwrap() {
        let raw = row[0].as_str().unwrap();
        assert_eq!(parse_iso_ms(raw), row[1].as_f64(), "Date.parse({raw:?})");
    }
}

fn git(repo: &Path, args: &[&str], env: &[(&str, &str)]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .envs(env.iter().copied())
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn init(repo: &Path) {
    git(repo, &["init", "-q", "-b", "main"], &[]);
    git(repo, &["config", "user.name", "Setup"], &[]);
    git(repo, &["config", "user.email", "setup@example.com"], &[]);
    git(repo, &["config", "commit.gpgsign", "false"], &[]);
}

/// Commit `files` (each rewritten with `tag`) as `name <email>` at `date`.
fn commit_as(repo: &Path, files: &[&str], tag: &str, name: &str, email: &str, date: &str) {
    for f in files {
        let path = repo.join(f);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("{tag}\n")).unwrap();
        git(repo, &["add", f], &[]);
    }
    let env = [
        ("GIT_AUTHOR_NAME", name),
        ("GIT_AUTHOR_EMAIL", email),
        ("GIT_AUTHOR_DATE", date),
    ];
    git(repo, &["commit", "-q", "-m", tag], &env);
}

fn days_ago(n: f64) -> String {
    format!("@{} +0000", ((now_ms() - n * DAY_MS) / 1000.0) as i64)
}

const ALICE: &str = "101+alice@users.noreply.github.com";

#[test]
fn owners_rank_people_and_drop_bots_and_undated_commits() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init(repo);
    let d = days_ago(2.0);
    for i in 0..3 {
        commit_as(
            repo,
            &["src/a.ts"],
            &format!("alice {i}"),
            "Alice",
            ALICE,
            &d,
        );
    }
    commit_as(repo, &["src/a.ts"], "bob", "Bob", "bob@example.com", &d);
    commit_as(
        repo,
        &["src/a.ts", "src/b.ts"],
        "carol",
        "Carol",
        "carol@example.com",
        &d,
    );
    commit_as(
        repo,
        &["src/a.ts"],
        "dep",
        "dependabot[bot]",
        "49699333+dependabot[bot]@users.noreply.github.com",
        &d,
    );
    commit_as(
        repo,
        &["src/a.ts"],
        "gha",
        "github-actions",
        "actions@example.com",
        &d,
    );
    commit_as(
        repo,
        &["src/a.ts"],
        "ren",
        "Renovate",
        "renovate@example.com",
        &d,
    );
    commit_as(
        repo,
        &["src/a.ts"],
        "bot",
        "Helper",
        "helper[bot]@example.com",
        &d,
    );
    // Year 10000: `%aI` prints a five-digit year, which neither side can read, so the
    // commit is skipped rather than credited.
    commit_as(
        repo,
        &["src/a.ts"],
        "far",
        "Zed",
        "zed@example.com",
        "@253402300800 +0000",
    );

    let now = now_ms();
    let files = vec!["src/a.ts".to_string(), "src/b.ts".to_string()];
    let owners = owners_for(repo, &files, &[], now);
    let names: Vec<(&str, Option<&str>, usize)> = owners
        .iter()
        .map(|o| (o.name.as_str(), o.handle.as_deref(), o.commits))
        .collect();
    // Bob and Carol tie on score and commits; the name decides, and the area keeps 2.
    assert_eq!(names, [("Alice", Some("alice"), 3), ("Bob", None, 1)]);
    assert!((owners[1].last - (now - 2.0 * DAY_MS)).abs() < 2_000.0);

    // Carol touched both files in one commit: one commit, not two.
    let carol = owners_for(repo, &["src/b.ts".to_string()], &[], now);
    assert_eq!(carol.len(), 1);
    assert_eq!((carol[0].name.as_str(), carol[0].commits), ("Carol", 1));

    // Exclusion by email key, by name and by handle, each case-insensitive.
    for exclude in [
        ALICE.to_uppercase(),
        "alice".to_string(),
        " ALICE ".to_string(),
    ] {
        let rest = owners_for(repo, &files, &[exclude.clone(), String::new()], now);
        let rest: Vec<&str> = rest.iter().map(|o| o.name.as_str()).collect();
        assert_eq!(rest, ["Bob", "Carol"], "exclude {exclude:?}");
    }
    let by_name = owners_for(repo, &files, &["bob".to_string()], now);
    assert_eq!(by_name[1].name, "Carol");

    assert!(owners_for(repo, &[], &[], now).is_empty());
    assert!(owners_for(&repo.join("missing"), &files, &[], now).is_empty());
}

#[test]
fn owners_drop_people_under_the_share_floor() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init(repo);
    let d = days_ago(1.0);
    for i in 0..7 {
        commit_as(repo, &["a.ts"], &format!("a{i}"), "Alice", ALICE, &d);
    }
    commit_as(repo, &["a.ts"], "b", "Bob", "bob@example.com", &d);
    // Bob holds 1 of 8 equal shares, under the 15% floor.
    let owners = owners_for(repo, &["a.ts".to_string()], &[], now_ms());
    assert_eq!(owners.len(), 1);
    assert_eq!(owners[0].name, "Alice");
}

fn area(label: &str, files: &[&str]) -> ChangedArea {
    ChangedArea {
        label: label.to_string(),
        label_source: LabelSource::Concept,
        key: label.to_string(),
        files: files.iter().map(|f| (*f).to_string()).collect(),
        seeds: 1,
        tests: TestSignal::None,
        test_files: Vec::new(),
        changed_test_files: Vec::new(),
        reached: 0,
        behavioural: 0,
        unreached: Vec::new(),
        seed_names: Vec::new(),
        owners: None,
    }
}

fn module(label: &str, files: &[&str]) -> ImpactedModule {
    ImpactedModule {
        label: label.to_string(),
        label_source: LabelSource::Symbol,
        key: label.to_string(),
        files: files.iter().map(|f| (*f).to_string()).collect(),
        symbols: Vec::new(),
        from: Vec::new(),
        owners: None,
    }
}

#[test]
fn attach_owners_merges_a_person_across_areas_and_ranks_reviewers() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init(repo);
    // 'bob' without a handle keys on his name, which is the handle of his noreply address.
    commit_as(
        repo,
        &["x.ts"],
        "x",
        "bob",
        "bob@example.com",
        &days_ago(9.0),
    );
    commit_as(
        repo,
        &["y.ts"],
        "y",
        "Robert",
        "7+bob@users.noreply.github.com",
        &days_ago(3.0),
    );
    let d1 = days_ago(1.0);
    for i in 0..2 {
        commit_as(repo, &["z.ts"], &format!("z{i}"), "Alice", ALICE, &d1);
    }
    commit_as(repo, &["w.ts"], "w", "Carol", "carol@example.com", &d1);
    commit_as(repo, &["v.ts"], "v", "Dee", "dee@example.com", &d1);

    let mut report = BlastReport {
        basis: "HEAD".to_string(),
        depth: 1,
        changed: Vec::new(),
        unindexed: Vec::new(),
        deleted: Vec::new(),
        seeds: Vec::new(),
        impacted: Vec::new(),
        modules: vec![
            module("Y", &["y.ts"]),
            module("W", &["w.ts"]),
            module("V", &["v.ts"]),
        ],
        test_modules: Vec::new(),
        areas: vec![area("X", &["x.ts"]), area("Z", &["z.ts"])],
        unresolved: Vec::new(),
        left_behind: Vec::new(),
        tests: None,
        reviewers: None,
    };
    let now = now_ms();
    attach_owners(repo, &mut report, &[], now);

    assert_eq!(report.areas[0].owners.as_ref().unwrap()[0].name, "bob");
    let reviewers = report.reviewers.expect("reviewers");
    let ranked: Vec<(&str, Option<&str>, usize, Vec<&str>)> = reviewers
        .iter()
        .map(|r| {
            (
                r.name.as_str(),
                r.handle.as_deref(),
                r.commits,
                r.areas.iter().map(String::as_str).collect(),
            )
        })
        .collect();
    // Alice: 2 changed-area commits; bob: one changed area plus one affected area;
    // Carol and Dee tie on one affected area each and Carol wins on name; 3 are kept.
    assert_eq!(
        ranked,
        [
            ("Alice", Some("alice"), 2, vec!["Z"]),
            ("bob", Some("bob"), 2, vec!["X", "Y"]),
            ("Carol", None, 1, vec!["W"]),
        ]
    );
    assert!((reviewers[1].last - (now - 3.0 * DAY_MS)).abs() < 2_000.0);
}

#[test]
fn diff_authors_reads_names_emails_and_co_author_trailers() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init(repo);
    commit_as(
        repo,
        &["a.ts"],
        "base",
        "Base",
        "base@example.com",
        &days_ago(5.0),
    );
    git(repo, &["checkout", "-q", "-b", "feat"], &[]);
    fs::write(repo.join("a.ts"), "one\n").unwrap();
    git(repo, &["add", "a.ts"], &[]);
    let message = "change\n\n\
        Co-authored-by: Carol Coder <carol@example.com>\n\
        Co-authored-by: Weird <a<b>c> <d@example.com>\n\
        Co-authored-by: <only@example.com>\n\
        Co-authored-by: Nobody <>\n\
        Co-authored-by: just text\n\
        Co-authored-by: Bob <bob@example.com>\n";
    let env = [
        ("GIT_AUTHOR_NAME", "Bob"),
        ("GIT_AUTHOR_EMAIL", "bob@example.com"),
    ];
    git(repo, &["commit", "-q", "-m", message], &env);
    // A second commit by the same author repeats both lines, which are listed once.
    fs::write(
        repo.join("a.ts"),
        "two
",
    )
    .unwrap();
    git(repo, &["commit", "-q", "-am", "again"], &env);

    assert_eq!(
        diff_authors(repo, "main"),
        [
            "Bob",
            "bob@example.com",
            "Carol Coder",
            "carol@example.com",
            "Weird <a<b>c>",
            "d@example.com",
            "only@example.com",
            "Nobody <>",
            "just text",
        ]
    );
    assert!(diff_authors(repo, "no-such-branch").is_empty());
    assert!(diff_authors(repo, "--all").is_empty());
    assert!(diff_authors(repo, "").is_empty());
}

#[test]
fn local_identity_skips_an_empty_name() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init(repo);
    git(repo, &["config", "user.name", ""], &[]);
    assert_eq!(local_identity(repo), ["setup@example.com"]);
}

#[test]
fn owners_keep_the_newest_author_date_whatever_the_commit_order() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init(repo);
    let (recent, older) = (days_ago(1.0), days_ago(6.0));
    commit_as(repo, &["a.ts"], "first", "Alice", ALICE, &recent);
    // Committed later but authored earlier: `git log` lists it first.
    commit_as(repo, &["a.ts"], "second", "Alice", ALICE, &older);
    let now = now_ms();
    let owners = owners_for(repo, &["a.ts".to_string()], &[], now);
    assert_eq!(owners[0].commits, 2);
    assert!((owners[0].last - (now - DAY_MS)).abs() < 2_000.0);
}
