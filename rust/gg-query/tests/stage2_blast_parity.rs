//! Blast, owners, token budget, and brand switching parity tests.

use std::fs;
use std::path::Path;
use std::process::Command as StdCommand;

use gg_query::blast::diff::{ChangeStatus, ChangedFile, changed_files};
use gg_query::blast::owners::diff_authors;
use gg_query::blast::render::markdown_report;
use gg_query::blast::{BlastOptions, compute_blast_report};
use gg_query::freshness::sha256_hex;
use gg_query::store::GraphStore;
use snapbox::cmd::{Command, cargo_bin};
use tempfile::tempdir;

fn run_git(repo: &Path, args: &[&str]) {
    let out = StdCommand::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .expect("git command");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn init_git(repo: &Path) {
    run_git(repo, &["init", "-q", "-b", "main"]);
    run_git(repo, &["config", "user.name", "Alice Author"]);
    run_git(
        repo,
        &["config", "user.email", "111+alice@users.noreply.github.com"],
    );
}

fn write_graph(ctx: &Path, json: &serde_json::Value) {
    let gdir = ctx.join(".graph");
    fs::create_dir_all(&gdir).expect("mkdir .graph");
    fs::write(gdir.join("wiring.json"), json.to_string()).expect("write wiring.json");
}

fn write_fingerprint(ctx: &Path, files: &[(&str, &Path)]) {
    let cache = ctx.join(".cache");
    fs::create_dir_all(&cache).expect("mkdir .cache");
    let mut map = serde_json::Map::new();
    for &(rel, abs) in files {
        let meta = fs::metadata(abs).expect("stat file");
        let dur = meta
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap();
        let mtime_ms = (dur.as_secs() as f64) * 1000.0 + (dur.subsec_nanos() as f64) / 1_000_000.0;
        let bytes = fs::read(abs).expect("read file");
        let hash = sha256_hex(&bytes);
        map.insert(
            rel.to_string(),
            serde_json::json!([meta.len(), mtime_ms, hash]),
        );
    }
    let fp = serde_json::json!({
        "version": 1,
        "extractor": "test",
        "files": map
    });
    fs::write(cache.join("fingerprint.test.json"), fp.to_string()).expect("write fingerprint");
}

fn setup_owners_left_behind_repo() -> tempfile::TempDir {
    let tmp = tempdir().expect("tempdir");
    let repo = tmp.path();
    fs::create_dir_all(repo.join("src")).expect("mkdir src");
    fs::create_dir_all(repo.join("test")).expect("mkdir test");
    fs::write(repo.join(".gitignore"), "graft/\n").expect("write gitignore");

    let math = repo.join("src/math.ts");
    let caller = repo.join("src/caller.ts");
    let test_file = repo.join("test/caller.test.ts");
    fs::write(
        &math,
        "export function compute(x: number): number {\n  return x + 1;\n}\n",
    )
    .unwrap();
    fs::write(
        &caller,
        "import { compute } from './math';\nexport function useIt(): number {\n  return compute(5);\n}\n",
    )
    .unwrap();
    fs::write(
        &test_file,
        "import { useIt } from '../src/caller';\nexport function runTest() { return useIt(); }\n",
    )
    .unwrap();

    init_git(repo);
    run_git(repo, &["add", "."]);
    run_git(repo, &["commit", "-q", "-m", "initial"]);

    run_git(repo, &["config", "user.name", "Bob Reviewer"]);
    run_git(
        repo,
        &["config", "user.email", "222+bob@users.noreply.github.com"],
    );
    fs::write(
        &caller,
        "import { compute } from './math';\nexport function useIt(): number {\n  // keep\n  return compute(5);\n}\n",
    )
    .unwrap();
    run_git(repo, &["add", "src/caller.ts", "test/caller.test.ts"]);
    run_git(repo, &["commit", "-q", "-m", "bob touched caller"]);
    run_git(repo, &["checkout", "-q", "-b", "feat/sig-change"]);

    run_git(repo, &["config", "user.name", "Alice Author"]);
    run_git(
        repo,
        &["config", "user.email", "111+alice@users.noreply.github.com"],
    );
    fs::write(
        &math,
        "export function compute(x: number, y: number): number {\n  return x + y;\n}\n",
    )
    .unwrap();
    run_git(repo, &["add", "src/math.ts"]);
    run_git(
        repo,
        &["commit", "-q", "-m", "alice changed compute signature"],
    );

    let graph = serde_json::json!({
        "meta": { "nodeCount": 6, "edgeCount": 3 },
        "nodes": [
            {"id":"src/math.ts","name":"math.ts","kind":"file","path":"src/math.ts","span":"L1-L3","signature":null,"exported":false,"origin":"ast","body_hash":"1","chars":70},
            {"id":"src/math.ts#compute","name":"compute","kind":"function","path":"src/math.ts","span":"L1-L3","signature":"function compute(x: number, y: number): number","exported":true,"origin":"ast","body_hash":"2"},
            {"id":"src/caller.ts","name":"caller.ts","kind":"file","path":"src/caller.ts","span":"L1-L5","signature":null,"exported":false,"origin":"ast","body_hash":"3","chars":100},
            {"id":"src/caller.ts#useIt","name":"useIt","kind":"function","path":"src/caller.ts","span":"L2-L5","signature":"function useIt(): number","exported":true,"origin":"ast","body_hash":"4"},
            {"id":"test/caller.test.ts","name":"caller.test.ts","kind":"file","path":"test/caller.test.ts","span":"L1-L2","signature":null,"exported":false,"origin":"ast","body_hash":"5","chars":85},
            {"id":"test/caller.test.ts#runTest","name":"runTest","kind":"function","path":"test/caller.test.ts","span":"L2-L2","signature":"function runTest()","exported":true,"origin":"ast","body_hash":"6"}
        ],
        "edges": [
            {"source":"src/caller.ts#useIt","target":"src/math.ts#compute","relation":"calls","confidence":"extracted"},
            {"source":"test/caller.test.ts#runTest","target":"src/caller.ts#useIt","relation":"calls","confidence":"extracted"},
            {"source":"test/caller.test.ts#runTest","target":"src/math.ts#compute","relation":"calls","confidence":"inferred"}
        ],
        "unresolvedCalls": [
            {"name":"compute","source":"src/dyn.ts#dyn","through":"obj","file":null}
        ]
    });
    write_graph(&repo.join("graft"), &graph);
    tmp
}

#[test]
fn brand_switching_and_max_tokens() {
    let tmp = setup_owners_left_behind_repo();
    let repo = tmp.path();

    let graft_ask = Command::new(cargo_bin!("gg-query"))
        .env("TRAIL_INVOKED_AS", "graft")
        .args([
            "ask",
            "compute",
            "--source",
            "--max-tokens",
            "120",
            "--no-semantic",
        ])
        .arg(repo)
        .output()
        .expect("graft ask");
    assert!(graft_ask.status.success());
    let graft_text = String::from_utf8_lossy(&graft_ask.stdout);
    assert!(graft_text.contains("graft ask — \"compute\""));
    assert!(graft_text.contains("budget: about "));

    let bad_tok = Command::new(cargo_bin!("gg-query"))
        .args(["ask", "compute", "--max-tokens", "0"])
        .arg(repo)
        .output()
        .expect("bad max-tokens");
    assert!(!bad_tok.status.success());
    assert!(
        String::from_utf8_lossy(&bad_tok.stderr)
            .contains("--max-tokens must be a whole number of at least 1, got \"0\"")
    );
}

#[test]
fn blast_left_behind_tests_and_owners() {
    let tmp = setup_owners_left_behind_repo();
    let repo = tmp.path();

    let blast_json_out = Command::new(cargo_bin!("gg-query"))
        .args([
            "blast", "--base", "main", "--tests", "--depth", "1", "--format", "json",
        ])
        .arg(repo)
        .output()
        .expect("blast");
    assert!(
        blast_json_out.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&blast_json_out.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&blast_json_out.stdout).expect("json");
    assert_eq!(report["basis"], "main...HEAD");
    assert_eq!(report["seeds"][0]["declarationChanged"], true);
    assert_eq!(report["unresolved"][0]["name"], "compute");
    assert_eq!(report["unresolved"][0]["calls"], 1);
    assert_eq!(report["leftBehind"][0]["name"], "useIt");
    assert_eq!(report["leftBehind"][0]["line"], 4);
    assert!(
        report["tests"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["path"] == "test/caller.test.ts")
    );
    assert!(
        report["reviewers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["handle"] == "bob")
    );

    let blast_no_owners = Command::new(cargo_bin!("gg-query"))
        .args(["blast", "--base", "main", "--no-owners", "--format", "json"])
        .arg(repo)
        .output()
        .expect("blast --no-owners");
    let no_own_json: serde_json::Value =
        serde_json::from_slice(&blast_no_owners.stdout).expect("json");
    assert!(no_own_json.get("reviewers").is_none());
    assert!(no_own_json["modules"][0].get("owners").is_none());

    let bad_base = Command::new(cargo_bin!("gg-query"))
        .args(["blast", "--base", "nonexistent/branch"])
        .arg(repo)
        .output()
        .expect("bad base");
    assert!(!bad_base.status.success());
    assert!(String::from_utf8_lossy(&bad_base.stderr).contains("fetch-depth: 0"));
}

fn copy_dir(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).expect("mkdir");
    for entry in fs::read_dir(src).expect("read_dir") {
        let entry = entry.expect("entry");
        let to = dst.join(entry.file_name());
        if entry.file_type().expect("type").is_dir() {
            copy_dir(&entry.path(), &to);
        } else {
            fs::copy(entry.path(), &to).expect("copy");
        }
    }
}

#[test]
fn blast_math_git_diff_matches_updated_ca19897_goldens() {
    let parity_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("parity");
    let tmp = tempdir().expect("tempdir");
    let repo = tmp.path();
    copy_dir(&parity_dir.join("sample-repo"), repo);

    let math_path = repo.join("src/math.ts");
    let mut math_orig = fs::read_to_string(&math_path)
        .unwrap()
        .replace("\r\n", "\n");
    if !math_orig.ends_with('\n') {
        math_orig.push('\n');
    }
    fs::write(&math_path, &math_orig).unwrap();
    init_git(repo);
    run_git(repo, &["add", "."]);
    run_git(repo, &["commit", "-q", "-m", "baseline"]);

    let fp_files = [
        ("src/checkout.ts", repo.join("src/checkout.ts")),
        ("src/math.ts", repo.join("src/math.ts")),
        ("src/order.ts", repo.join("src/order.ts")),
        ("src/report.py", repo.join("src/report.py")),
    ];
    let refs: Vec<(&str, &Path)> = fp_files.iter().map(|(k, v)| (*k, v.as_path())).collect();
    write_fingerprint(&repo.join("graft"), &refs);
    fs::write(
        repo.join(".gitignore"),
        "graft/.cache/fingerprint.*\ngraft/.graph/wiring.sqlite*\n",
    )
    .unwrap();
    run_git(repo, &["add", ".gitignore"]);
    run_git(repo, &["commit", "-q", "-m", "ignore local caches"]);

    let appended = format!("{math_orig}\nexport function zeroTax() {{ return 0; }}\n");
    fs::write(&math_path, appended).unwrap();

    let golden_json = fs::read_to_string(parity_dir.join("golden/blast-math-json.stdout"))
        .unwrap()
        .replace("\r\n", "\n");
    let golden_text = fs::read_to_string(parity_dir.join("golden/blast-math-text.stdout"))
        .unwrap()
        .replace("\r\n", "\n");

    Command::new(cargo_bin!("gg-query"))
        .args(["blast", "--depth", "2", "--format", "json", "--no-owners", "--no-refresh"])
        .arg(repo)
        .assert()
        .success()
        .stdout_eq(golden_json)
        .stderr_eq("index: stale (refresh is off, 1 file changed since the last build); answers may miss those edits\n");

    Command::new(cargo_bin!("gg-query"))
        .args(["blast", "--depth", "2", "--no-owners", "--no-refresh"])
        .arg(repo)
        .assert()
        .success()
        .stdout_eq(golden_text)
        .stderr_eq("index: stale (refresh is off, 1 file changed since the last build); answers may miss those edits\n");
}

#[test]
fn blast_rejects_option_like_base_refs() {
    let tmp = tempdir().expect("tempdir");
    let repo = tmp.path();
    init_git(repo);
    fs::write(repo.join("a.txt"), "one\n").unwrap();
    run_git(repo, &["add", "."]);
    run_git(repo, &["commit", "-q", "-m", "init"]);

    for bad in ["", "-", "--upload-pack=evil", "-n1"] {
        assert!(changed_files(repo, Some(bad)).is_none(), "{bad:?}");
        assert!(diff_authors(repo, bad).is_empty(), "{bad:?}");
    }
}

#[test]
fn blast_handles_l0_span_determinism_and_earliest_evidence_line() {
    let tmp = tempdir().expect("tempdir");
    let repo = tmp.path();
    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(
        repo.join("src/a.ts"),
        "export function x() {}\nexport function veryLongSeed() {}\n",
    )
    .unwrap();
    fs::write(
        repo.join("src/use.ts"),
        "export function caller() {\n  x();\n  veryLongSeed();\n}\n",
    )
    .unwrap();
    let graph = serde_json::json!({
        "meta": { "nodeCount": 5, "edgeCount": 1 },
        "nodes": [
            {"id":"src/a.ts","name":"a.ts","kind":"file","path":"src/a.ts","span":"L0-L2","exported":false,"origin":"ast","body_hash":"f0","chars":50},
            {"id":"src/a.ts#x","name":"x","kind":"function","path":"src/a.ts","span":"L0-L1","signature":"function x()","exported":true,"origin":"ast","body_hash":"1"},
            {"id":"src/a.ts#veryLongSeed","name":"veryLongSeed","kind":"function","path":"src/a.ts","span":"L2-L2","signature":"function veryLongSeed()","exported":true,"origin":"ast","body_hash":"2"},
            {"id":"src/use.ts","name":"use.ts","kind":"file","path":"src/use.ts","span":"L1-L4","exported":false,"origin":"ast","body_hash":"u0","chars":60},
            {"id":"src/use.ts#caller","name":"caller","kind":"function","path":"src/use.ts","span":"L1-L4","signature":"function caller()","exported":true,"origin":"ast","body_hash":"u1"}
        ],
        "edges": [
            {"source":"src/use.ts#caller","target":"src/a.ts#x","relation":"calls","confidence":"extracted"}
        ],
        "unresolvedCalls": []
    });
    let ctx = repo.join("graft");
    write_graph(&ctx, &graph);
    let store = GraphStore::open_or_sync(&ctx).unwrap().unwrap();
    let opts = BlastOptions {
        depth: 1,
        tests: false,
        seed_all_on_empty_ranges: true,
    };
    let changed = vec![ChangedFile {
        path: "src/a.ts".to_string(),
        status: ChangeStatus::Modified,
        old_path: None,
        ranges: Vec::new(),
        hunks: Vec::new(),
    }];
    let r1 =
        compute_blast_report(&store, repo, &ctx, changed.clone(), "diff".into(), &opts).unwrap();
    let r2 = compute_blast_report(&store, repo, &ctx, changed, "diff".into(), &opts).unwrap();
    assert_eq!(r1.areas[0].unreached, r2.areas[0].unreached);
    let md = markdown_report(&r1, Some(repo));
    assert!(
        md.contains("```2: x();```"),
        "expected earliest line 2 in:\n{md}"
    );
}
