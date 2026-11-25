//! Integration and unit tests for Stage 2 parity, security hardening,
//! `--no-refresh`/`index`, `ask --max-tokens`, `blast`, `brand()`, and `code_of`.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::Command as StdCommand;

use gg_query::ask::budget::fold_code;
use gg_query::blast::diff::changed_files;
use gg_query::blast::owners::diff_authors;
use gg_query::evidence::{code_of, syntax_of};
use gg_query::freshness::sha256_hex;
use gg_query::graph::{is_deploy_file, reference_line};
use gg_query::program::locate_program;
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

#[test]
fn deploy_files_cover_terraform_kustomize_and_exclude_tf_json_and_dockerignore() {
    assert!(is_deploy_file("infra/main.tf"));
    assert!(is_deploy_file("envs\\prod\\vars.tf"));
    assert!(!is_deploy_file("infra/vars.tf.json"));
    assert!(is_deploy_file("Kustomization"));
    assert!(is_deploy_file("overlays/prod/Kustomization"));
    assert!(is_deploy_file("base/kustomization.yaml"));
    assert!(is_deploy_file("base/kustomization.yml"));
    assert!(!is_deploy_file("kustomization"));
    assert!(!is_deploy_file(".dockerignore"));
    assert!(is_deploy_file("Dockerfile.prod"));
    assert!(is_deploy_file("app.dockerfile"));
}

#[test]
fn reference_line_rejects_traversal_symlinks_deploy_and_blanks_non_code() {
    let outer = tempdir().expect("outer");
    let root = outer.path().join("repo");
    fs::create_dir_all(root.join("src")).expect("mkdir src");
    fs::write(outer.path().join("secret.ts"), "targetSymbol();\n").expect("write outer");
    fs::write(root.join("main.tf"), "resource \"x\" \"targetSymbol\" {}\n").expect("write tf");
    fs::write(root.join("Kustomization"), "namePrefix: targetSymbol\n").expect("write kust");

    let code_file = [
        "const a = 'targetSymbol';",
        "const b = \"targetSymbol\";",
        "const c = `multi targetSymbol",
        "  still in template targetSymbol`;",
        "/* block comment",
        "   targetSymbol inside comment */",
        "// line comment targetSymbol",
        "const re = /targetSymbol/g;",
        "if (ok) { x(); } /targetSymbol/i;",
        "const ok = <Fade in /> / divRight;",
        "const num = 1'000; targetSymbol();",
    ]
    .join("\n");
    fs::write(root.join("src/test.jsx"), code_file).expect("write jsx");

    let mut cache = HashMap::new();
    // Traversal outside root refused
    assert!(reference_line(&root, "../secret.ts", "L1-L1", "targetSymbol", &mut cache).is_none());
    // Deploy files never quoted
    assert!(reference_line(&root, "main.tf", "L1-L1", "targetSymbol", &mut cache).is_none());
    assert!(reference_line(&root, "Kustomization", "L1-L1", "targetSymbol", &mut cache).is_none());

    // Lines 1..=9 blank out strings, templates, block/line comments, regexes and JSX; line 11 hits
    let q = reference_line(&root, "src/test.jsx", "L1-L11", "targetSymbol", &mut cache)
        .expect("should match code mention");
    assert_eq!(q.n, 11);
    let q_div = reference_line(&root, "src/test.jsx", "L10-L10", "divRight", &mut cache)
        .expect("division right of <Fade in /> stays code");
    assert_eq!(q_div.n, 10);

    // Rust raw strings, char literals, and multi-line comments
    fs::write(
        root.join("src/lib.rs"),
        "fn f<'a>() {\n  let s = r#\"targetSymbol\"#;\n  let ch = 'x'; // targetSymbol\n  targetSymbol();\n}\n",
    )
    .expect("write rs");
    let q_rs = reference_line(&root, "src/lib.rs", "L1-L5", "targetSymbol", &mut cache)
        .expect("rust real call");
    assert_eq!(q_rs.n, 4);

    // Multi-line open quote carries across lines in JSX and blanking ignores JSX boolean `in`
    let (blanked, open) = code_of("<Fade in />", syntax_of("a.jsx"), None);
    assert!(open.is_none());
    assert_eq!(blanked, "<Fade in />");

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(outer.path().join("secret.ts"), root.join("src/leak.ts")).expect("symlink");
        assert!(
            reference_line(&root, "src/leak.ts", "L1-L1", "targetSymbol", &mut cache).is_none()
        );
    }
}

#[test]
fn program_lookup_refuses_repo_local_rogue_git_and_relative_path() {
    let tmp = tempdir().expect("tempdir");
    let repo = tmp.path().join("repo");
    let nm_bin = repo.join("node_modules").join(".bin");
    fs::create_dir_all(&nm_bin).expect("mkdir nm bin");

    let rogue = if cfg!(windows) {
        repo.join("git.exe")
    } else {
        repo.join("git")
    };
    fs::write(&rogue, b"#!/bin/sh\nexit 99\n").expect("write rogue git");
    let nm_rogue = if cfg!(windows) {
        nm_bin.join("git.exe")
    } else {
        nm_bin.join("git")
    };
    fs::write(&nm_rogue, b"#!/bin/sh\nexit 99\n").expect("write nm rogue");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for p in [&rogue, &nm_rogue] {
            let mut perms = fs::metadata(p).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(p, perms).unwrap();
        }
    }

    // Direct relative or repo-local path rejected
    assert!(locate_program("./git", &repo).is_err());
    assert!(locate_program(rogue.to_str().unwrap(), &repo).is_err());

    // Real locate_program("git", &repo) resolves to system git outside repo (never rogue inside repo)
    if let Ok(resolved) = locate_program("git", &repo) {
        assert!(
            !resolved.starts_with(&repo),
            "resolved inside repo: {resolved:?}"
        );
    }
}

#[test]
fn sha256_matches_nist_vectors_and_fold_code_elides_body() {
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );

    let body = [
        "function demo(a: number, b: number): number {",
        "  const x = a + 1;",
        "  const y = b + 2;",
        "  const z = x + y;",
        "  helperCall(z);",
        "  return z;",
        "}",
    ]
    .join("\n");
    let folded = fold_code(&body);
    assert!(folded.contains("  ⋯ 3 lines"), "folded={folded}");
    assert!(folded.contains("helperCall(z);"));
}

#[test]
fn no_refresh_and_index_freshness_across_commands() {
    let tmp = tempdir().expect("tempdir");
    let repo = tmp.path();
    fs::create_dir_all(repo.join("src")).expect("mkdir src");
    let src_file = repo.join("src/a.ts");
    fs::write(&src_file, "export function alpha() { return 1; }\n").expect("write a.ts");
    let graph = serde_json::json!({
        "meta": { "nodeCount": 2, "edgeCount": 0 },
        "nodes": [
            {"id":"src/a.ts","name":"a.ts","kind":"file","path":"src/a.ts","span":"L1-L1","signature":null,"exported":false,"origin":"ast","body_hash":"1","chars":42},
            {"id":"src/a.ts#alpha","name":"alpha","kind":"function","path":"src/a.ts","span":"L1-L1","signature":"function alpha()","exported":true,"origin":"ast","body_hash":"2"}
        ],
        "edges": [],
        "unresolvedCalls": []
    });
    let ctx = repo.join("graft");
    write_graph(&ctx, &graph);

    // 1. Without fingerprint: `--no-refresh` reports stale reason
    let out = Command::new(cargo_bin!("gg-query"))
        .args(["callers", "alpha", "--json", "--no-refresh"])
        .arg(repo)
        .output()
        .expect("callers");
    assert!(out.status.success());
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json");
    assert_eq!(json["index"]["state"], "stale");
    assert_eq!(
        json["index"]["reason"],
        "no build fingerprint, and refresh is off"
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains(
        "index: stale (no build fingerprint, and refresh is off); answers may miss those edits"
    ));

    // 2. With clean fingerprint: fresh & clean stderr across status/ask/callers/skeleton/hubs
    write_fingerprint(&ctx, &[("src/a.ts", &src_file)]);
    for args in [
        vec!["ask", "alpha", "--json", "--no-refresh", "--no-semantic"],
        vec!["skeleton", "src/a.ts", "--json", "--no-refresh"],
        vec!["callers", "alpha", "--json", "--no-refresh"],
        vec!["hubs", "--json", "--no-refresh"],
    ] {
        let out = Command::new(cargo_bin!("gg-query"))
            .args(&args)
            .arg(repo)
            .output()
            .expect("query");
        assert!(out.status.success(), "{args:?}");
        assert!(String::from_utf8_lossy(&out.stderr).is_empty(), "{args:?}");
        let j: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json");
        assert_eq!(j["index"]["state"], "fresh", "{args:?}");
    }
    let st = Command::new(cargo_bin!("gg-query"))
        .args(["status", "--json"])
        .arg(repo)
        .output()
        .expect("status");
    let st_json: serde_json::Value = serde_json::from_slice(&st.stdout).expect("json");
    assert_eq!(st_json["codeMap"]["inSync"], true);

    // 3. Edit src/a.ts -> drift detected -> stale changed: 1 & status inSync: false
    fs::write(&src_file, "export function alpha() { return 2; }\n").expect("edit a.ts");
    let st_dirty = Command::new(cargo_bin!("gg-query"))
        .args(["status", "--json"])
        .arg(repo)
        .output()
        .expect("status dirty");
    let st_dirty_json: serde_json::Value = serde_json::from_slice(&st_dirty.stdout).expect("json");
    assert_eq!(st_dirty_json["codeMap"]["inSync"], false);

    let ask_dirty = Command::new(cargo_bin!("gg-query"))
        .args(["ask", "alpha", "--json", "--no-refresh", "--no-semantic"])
        .arg(repo)
        .output()
        .expect("ask dirty");
    let ask_dirty_json: serde_json::Value =
        serde_json::from_slice(&ask_dirty.stdout).expect("json");
    assert_eq!(ask_dirty_json["index"]["state"], "stale");
    assert_eq!(ask_dirty_json["index"]["changed"], 1);
    assert_eq!(ask_dirty_json["index"]["reason"], "refresh is off");
    assert!(
        String::from_utf8_lossy(&ask_dirty.stderr)
            .contains("index: stale (refresh is off, 1 file changed since the last build)")
    );
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

    // Second author commits caller.ts + test/caller.test.ts so reviewers suggest @bob
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

    // Alice changes compute's declaration without editing useIt()'s call
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

    // Ensure LF on src/math.ts so working tree diff mirrors canonical git checkout
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
fn callers_dot_suffix_and_hubs_integer_pagerank_parity() {
    let tmp = tempdir().expect("tempdir");
    let repo = tmp.path();
    let graph = serde_json::json!({
        "meta": { "nodeCount": 3, "edgeCount": 1 },
        "nodes": [
            {"id":"src/a.ts","name":"a.ts","kind":"file","path":"src/a.ts","span":"L1-L2","exported":false,"origin":"ast","body_hash":"f0","chars":40},
            {"id":"src/a.ts#helper","name":"helper","kind":"function","path":"src/a.ts","span":"L1-L2","exported":true,"origin":"ast","body_hash":"n1"},
            {"id":"main.tf#aws_s3_bucket.helper","name":"aws_s3_bucket.helper","kind":"resource","path":"main.tf","span":"L1-L1","exported":true,"origin":"ast","body_hash":"n2"}
        ],
        "edges": [
            {"source":"src/a.ts#helper","target":"main.tf#aws_s3_bucket.helper","relation":"calls","confidence":"extracted"}
        ],
        "unresolvedCalls": []
    });
    write_graph(&repo.join("graft"), &graph);

    let callers = Command::new(cargo_bin!("gg-query"))
        .args(["callers", "helper"])
        .arg(repo)
        .output()
        .expect("callers helper");
    assert!(callers.status.success());
    let callers_stdout = String::from_utf8_lossy(&callers.stdout);
    assert!(callers_stdout.contains("aws_s3_bucket.helper · resource · main.tf:L1-L1"));
    assert!(callers_stdout.contains("helper · function · src/a.ts:L1-L2"));

    let callers_json = Command::new(cargo_bin!("gg-query"))
        .args([
            "callers",
            "aws_s3_bucket.helper",
            "--direction",
            "out",
            "--json",
        ])
        .arg(repo)
        .output()
        .expect("callers json");
    assert!(callers_json.status.success());
    let cjson: serde_json::Value = serde_json::from_slice(&callers_json.stdout).expect("json");
    assert!(
        cjson["matches"][0]["note"]
            .as_str()
            .is_some_and(|s| s.starts_with("  no indexed callees"))
    );

    let hubs = Command::new(cargo_bin!("gg-query"))
        .args(["hubs", "--json"])
        .arg(repo)
        .output()
        .expect("hubs json");
    assert!(hubs.status.success());
    let hubs_stdout = String::from_utf8_lossy(&hubs.stdout);
    assert!(
        hubs_stdout.contains("\"pagerank\": 1,\n"),
        "expected JS-exact integer pagerank JSON: {hubs_stdout}"
    );
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
