//! Integration and unit tests for Stage 2 security hardening,
//! `--no-refresh`/`index`, `callers`, `hubs`, and `code_of`.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::Command as StdCommand;

use gg_query::ask::budget::fold_code;
use gg_query::blast::owners::parse_iso_ms;
use gg_query::evidence::{code_of, syntax_of};
use gg_query::freshness::sha256_hex;
use gg_query::graph::{is_deploy_file, reference_line};
use gg_query::program::locate_program;
use snapbox::cmd::{Command, cargo_bin};
use tempfile::tempdir;

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
    assert!(reference_line(&root, "../secret.ts", "L1-L1", "targetSymbol", &mut cache).is_none());
    assert!(reference_line(&root, "main.tf", "L1-L1", "targetSymbol", &mut cache).is_none());
    assert!(reference_line(&root, "Kustomization", "L1-L1", "targetSymbol", &mut cache).is_none());

    let q = reference_line(&root, "src/test.jsx", "L1-L11", "targetSymbol", &mut cache)
        .expect("should match code mention");
    assert_eq!(q.n, 11);
    let q_div = reference_line(&root, "src/test.jsx", "L10-L10", "divRight", &mut cache)
        .expect("division right of <Fade in /> stays code");
    assert_eq!(q_div.n, 10);

    fs::write(
        root.join("src/lib.rs"),
        "fn f<'a>() {\n  let s = r#\"targetSymbol\"#;\n  let ch = 'x'; // targetSymbol\n  targetSymbol();\n}\n",
    )
    .expect("write rs");
    let q_rs = reference_line(&root, "src/lib.rs", "L1-L5", "targetSymbol", &mut cache)
        .expect("rust real call");
    assert_eq!(q_rs.n, 4);

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

    assert!(locate_program("./git", &repo).is_err());
    assert!(locate_program(rogue.to_str().unwrap(), &repo).is_err());

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
fn parse_iso_ms_rejects_non_ascii_and_freshness_refuses_symlink_dir() {
    assert!(parse_iso_ms("2026-01-01T00:00:a🦀").is_none());
    assert!(parse_iso_ms("2026-01-01T00:00:00+aéb").is_none());
    assert!(parse_iso_ms("2026-01-01T00:00:00Z").is_some());

    #[cfg(unix)]
    {
        use gg_query::freshness::probe_drift;
        use std::os::unix::fs::symlink;

        let tmp = tempdir().expect("tempdir");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        let leaked = outside.join("secret.ts");
        fs::write(&leaked, "export const s = 1;\n").unwrap();

        let repo = tmp.path().join("repo");
        fs::create_dir_all(repo.join("src")).unwrap();
        let a_ts = repo.join("src/a.ts");
        fs::write(&a_ts, "export const a = 1;\n").unwrap();
        symlink(&outside, repo.join("src/link_dir")).unwrap();
        assert!(
            StdCommand::new("git")
                .args(["init", "-q", "-b", "main"])
                .current_dir(&repo)
                .status()
                .unwrap()
                .success()
        );
        let ctx = repo.join("graft");
        write_graph(&ctx, &serde_json::json!({"nodes":[],"edges":[]}));
        write_fingerprint(&ctx, &[("src/a.ts", &a_ts)]);
        let drift = probe_drift(&repo, &ctx).expect("drift");
        assert!(drift.added.is_empty(), "added={:?}", drift.added);
    }
    let _ = StdCommand::new("git").arg("--version");
}
