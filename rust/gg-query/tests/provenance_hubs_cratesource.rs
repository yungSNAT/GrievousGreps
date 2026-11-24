//! Integration tests for edge provenance + weakest-hop confidence, god-node `hubs`,
//! and `Cargo.lock`-anchored `crate-source` lookup in `gg-query`.

use std::fs;
use std::path::Path;

use serde_json::Value;
use snapbox::cmd::{Command, cargo_bin};
use tempfile::tempdir;

fn write_fixture_graph(repo: &Path, graph_json: &str) {
    let gdir = repo.join("graft").join(".graph");
    fs::create_dir_all(&gdir).expect("create graph dir");
    fs::write(gdir.join("wiring.json"), graph_json).expect("write wiring.json");
}

fn provenance_graph_json() -> &'static str {
    r#"{
  "meta": { "version": 1, "nodeCount": 6, "edgeCount": 6, "languages": ["typescript"] },
  "nodes": [
    { "id": "src/a.ts", "name": "a.ts", "kind": "file", "path": "src/a.ts", "span": "L1-L20", "exported": false, "origin": "ast", "body_hash": "h0", "chars": 400 },
    { "id": "src/a.ts#core", "name": "core", "kind": "function", "path": "src/a.ts", "span": "L1-L3", "exported": true, "origin": "ast", "body_hash": "h1" },
    { "id": "src/a.ts#midExtracted", "name": "midExtracted", "kind": "function", "path": "src/a.ts", "span": "L5-L7", "exported": true, "origin": "ast", "body_hash": "h2" },
    { "id": "src/a.ts#midInferred", "name": "midInferred", "kind": "function", "path": "src/a.ts", "span": "L9-L11", "exported": true, "origin": "ast", "body_hash": "h3" },
    { "id": "src/a.ts#leafWeak", "name": "leafWeak", "kind": "function", "path": "src/a.ts", "span": "L13-L15", "exported": true, "origin": "ast", "body_hash": "h4" },
    { "id": "src/a.ts#diamond", "name": "diamond", "kind": "function", "path": "src/a.ts", "span": "L17-L19", "exported": true, "origin": "ast", "body_hash": "h5" }
  ],
  "edges": [
    { "source": "src/a.ts#midExtracted", "target": "src/a.ts#core", "relation": "calls", "confidence": "lsp_resolved" },
    { "source": "src/a.ts#midInferred", "target": "src/a.ts#core", "relation": "calls", "confidence": "inferred" },
    { "source": "src/a.ts#leafWeak", "target": "src/a.ts#midExtracted", "relation": "calls", "confidence": "inferred" },
    { "source": "src/a.ts#diamond", "target": "src/a.ts#midInferred", "relation": "calls", "confidence": "extracted" },
    { "source": "src/a.ts#diamond", "target": "src/a.ts#midExtracted", "relation": "calls", "confidence": "extracted" },
    { "source": "src/a.ts#midInferred", "target": "src/a.ts#leafWeak", "relation": "references", "confidence": "extracted" }
  ],
  "unresolvedCalls": []
}"#
}

#[test]
fn callers_provenance_rates_direct_and_weakest_hop_paths() {
    let tmp = tempdir().expect("tempdir");
    write_fixture_graph(tmp.path(), provenance_graph_json());

    let out = Command::new(cargo_bin!("gg-query"))
        .args(["callers", "core", "--depth", "2", "--provenance", "--json"])
        .arg(tmp.path())
        .output()
        .expect("run gg-query");
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let json: Value = serde_json::from_slice(&out.stdout).expect("parse json");
    let m = &json["matches"][0];
    let summary = &m["provenanceSummary"];
    assert_eq!(summary["extracted"], 2);
    assert_eq!(summary["inferred"], 2);
    assert_eq!(summary["weakestConfidence"], "inferred");
    assert_eq!(summary["weakestProvenance"], "INFERRED");

    let hits = m["hits"].as_array().expect("hits array");
    let find = |id: &str| hits.iter().find(|h| h["id"] == id).expect("hit");

    let mid_ext = find("src/a.ts#midExtracted");
    assert_eq!(mid_ext["provenance"], "EXTRACTED");
    assert_eq!(mid_ext["weakestConfidence"], "lsp_resolved");
    assert_eq!(mid_ext["weakestHop"]["depth"], 1);

    let mid_inf = find("src/a.ts#midInferred");
    assert_eq!(mid_inf["provenance"], "INFERRED");
    assert_eq!(mid_inf["weakestConfidence"], "inferred");
    assert_eq!(mid_inf["weakestHop"]["depth"], 1);

    // Hop 1 is lsp_resolved, hop 2 is inferred -> path weakest is inferred @ hop 2
    let leaf = find("src/a.ts#leafWeak");
    assert_eq!(leaf["depth"], 2);
    assert_eq!(leaf["provenance"], "INFERRED");
    assert_eq!(leaf["weakestConfidence"], "inferred");
    assert_eq!(leaf["weakestHop"]["depth"], 2);

    // Diamond reached via both midInferred (inferred) and midExtracted (lsp_resolved -> extracted)
    // Strongest same-depth path wins: weakest hop is extracted @ hop 2!
    let diamond = find("src/a.ts#diamond");
    assert_eq!(diamond["depth"], 2);
    assert_eq!(diamond["provenance"], "EXTRACTED");
    assert_eq!(diamond["weakestConfidence"], "extracted");
    assert_eq!(diamond["weakestHop"]["depth"], 2);

    // Text output surfaces explicit EXTRACTED / INFERRED tags and weakest-hop summary
    let txt_out = Command::new(cargo_bin!("gg-query"))
        .args(["callers", "core", "--depth", "2", "--provenance"])
        .arg(tmp.path())
        .output()
        .expect("run text");
    assert!(txt_out.status.success());
    let txt = String::from_utf8(txt_out.stdout).expect("utf8");
    assert!(txt.contains("provenance: 2 EXTRACTED, 2 INFERRED"));
    assert!(txt.contains("[EXTRACTED · lsp_resolved]"));
    assert!(txt.contains("[INFERRED · weakest: inferred @ hop 2]"));
    assert!(txt.contains("[EXTRACTED · weakest: extracted @ hop 2]"));
}

#[test]
fn hubs_ranks_connected_symbols_and_respects_bounds_and_prefix() {
    let tmp = tempdir().expect("tempdir");
    let graph = r#"{
  "meta": { "version": 1, "nodeCount": 6, "edgeCount": 4, "languages": ["typescript"] },
  "nodes": [
    { "id": "src/core.ts", "name": "core.ts", "kind": "file", "path": "src/core.ts", "span": "L1-L30", "exported": false, "origin": "ast", "body_hash": "f1", "chars": 600 },
    { "id": "src/core.ts#hub", "name": "hub", "kind": "function", "path": "src/core.ts", "span": "L1-L5", "exported": true, "origin": "ast", "body_hash": "n1" },
    { "id": "src/core.ts#a", "name": "a", "kind": "function", "path": "src/core.ts", "span": "L7-L10", "exported": true, "origin": "ast", "body_hash": "n2" },
    { "id": "src/sub/b.ts#b", "name": "b", "kind": "function", "path": "src/sub/b.ts", "span": "L1-L5", "exported": true, "origin": "ast", "body_hash": "n3" },
    { "id": "src/sub/b.ts#c", "name": "c", "kind": "function", "path": "src/sub/b.ts", "span": "L7-L10", "exported": true, "origin": "ast", "body_hash": "n4" },
    { "id": "src/core.ts#isolated", "name": "isolated", "kind": "function", "path": "src/core.ts", "span": "L12-L15", "exported": true, "origin": "ast", "body_hash": "n5" }
  ],
  "edges": [
    { "source": "src/core.ts#a", "target": "src/core.ts#hub", "relation": "calls", "confidence": "extracted" },
    { "source": "src/sub/b.ts#b", "target": "src/core.ts#hub", "relation": "calls", "confidence": "extracted" },
    { "source": "src/sub/b.ts#c", "target": "src/core.ts#hub", "relation": "calls", "confidence": "inferred" },
    { "source": "src/sub/b.ts#b", "target": "src/sub/b.ts#c", "relation": "references", "confidence": "extracted" }
  ],
  "unresolvedCalls": []
}"#;
    write_fixture_graph(tmp.path(), graph);

    let out = Command::new(cargo_bin!("gg-query"))
        .args(["hubs", "--limit", "2", "--json"])
        .arg(tmp.path())
        .output()
        .expect("run hubs");
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let json: Value = serde_json::from_slice(&out.stdout).expect("parse json");
    assert_eq!(json["totals"]["totalSymbols"], 5);
    assert_eq!(json["totals"]["connectedSymbols"], 4);
    assert_eq!(json["totals"]["shown"], 2);
    assert_eq!(json["totals"]["truncated"], 2);
    assert_eq!(json["hubs"][0]["name"], "hub");
    assert_eq!(json["hubs"][0]["inDegree"], 3);
    assert_eq!(json["hubs"][0]["extractedEdges"], 2);
    assert_eq!(json["hubs"][0]["inferredEdges"], 1);

    // Prefix filter narrows to src/sub
    let sub_out = Command::new(cargo_bin!("gg-query"))
        .args(["hubs", "--in", "src/sub", "--json"])
        .arg(tmp.path())
        .output()
        .expect("run hubs --in");
    assert!(sub_out.status.success());
    let sub_json: Value = serde_json::from_slice(&sub_out.stdout).expect("parse json");
    assert_eq!(sub_json["prefix"], "src/sub");
    assert_eq!(sub_json["totals"]["connectedSymbols"], 2);

    // Invalid limit fails closed
    let bad = Command::new(cargo_bin!("gg-query"))
        .args(["hubs", "--limit", "0"])
        .arg(tmp.path())
        .output()
        .expect("bad limit");
    assert!(!bad.status.success());
}

fn setup_crate_source_fixture(base: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let repo = base.join("workspace");
    let cargo_home = base.join("cargo-home");
    fs::create_dir_all(repo.join("crates/my-local/src")).unwrap();
    fs::write(
        repo.join("crates/my-local/Cargo.toml"),
        "[package]\nname = \"my-local\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();

    // Populate registry with BOTH exact version and stale version
    let reg_idx = cargo_home.join("registry/src/index.crates.io-6f17d22bba15001f");
    fs::create_dir_all(reg_idx.join("serde-1.0.229/src")).unwrap();
    fs::write(
        reg_idx.join("serde-1.0.229/Cargo.toml"),
        "[package]\nname = \"serde\"\nversion = \"1.0.229\"\n",
    )
    .unwrap();
    fs::create_dir_all(reg_idx.join("serde-1.0.100/src")).unwrap();
    fs::write(
        reg_idx.join("serde-1.0.100/Cargo.toml"),
        "[package]\nname = \"serde\"\nversion = \"1.0.100\"\n",
    )
    .unwrap();
    fs::create_dir_all(reg_idx.join("hashbrown-0.17.2/src")).unwrap();
    fs::write(
        reg_idx.join("hashbrown-0.17.2/Cargo.toml"),
        "[package]\nname = \"hashbrown\"\nversion = \"0.17.2\"\n",
    )
    .unwrap();

    // Populate git checkout with verifiable full commit SHA and origin URL
    let git_dir = cargo_home.join("git/checkouts/cool-repo-9999/abcdef1");
    fs::create_dir_all(git_dir.join("src")).unwrap();
    fs::create_dir_all(git_dir.join(".git")).unwrap();
    fs::write(
        git_dir.join(".git/HEAD"),
        "abcdef1234567890abcdef1234567890abcdef12\n",
    )
    .unwrap();
    fs::write(
        git_dir.join(".git/config"),
        "[remote \"origin\"]\n\turl = https://example.com/cool-repo\n",
    )
    .unwrap();
    fs::write(
        git_dir.join("Cargo.toml"),
        "[package]\nname = \"cool-git\"\nversion = \"0.2.0\"\n",
    )
    .unwrap();

    fs::write(
        repo.join("Cargo.lock"),
        r#"version = 4

[[package]]
name = "my-local"
version = "0.1.0"

[[package]]
name = "serde"
version = "1.0.229"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "hashbrown"
version = "0.14.5"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "hashbrown"
version = "0.17.2"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "cool-git"
version = "0.2.0"
source = "git+https://example.com/cool-repo?rev=abcdef1#abcdef1234567890abcdef1234567890abcdef12"

[[package]]
name = "uncached-crate"
version = "9.9.9"
source = "registry+https://github.com/rust-lang/crates.io-index"
"#,
    )
    .unwrap();

    (repo, cargo_home)
}

#[test]
fn crate_source_resolves_exact_registry_git_and_path_and_fails_closed() {
    let tmp = tempdir().expect("tempdir");
    let (repo, cargo_home) = setup_crate_source_fixture(tmp.path());

    // 1. Exact registry version (never stale 1.0.100)
    let out = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "serde"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(&cargo_home)
        .arg("--json")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let json: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(json["matches"].as_array().unwrap().len(), 1);
    assert_eq!(json["matches"][0]["version"], "1.0.229");
    assert_eq!(json["matches"][0]["status"], "found");
    assert!(
        json["matches"][0]["path"]
            .as_str()
            .unwrap()
            .ends_with("serde-1.0.229")
    );

    // 2. Multi-version pinned with --version
    let mv = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "hashbrown"])
        .arg(&repo)
        .args(["--version", "0.17.2", "--cargo-home"])
        .arg(&cargo_home)
        .arg("--json")
        .output()
        .unwrap();
    assert!(mv.status.success());
    let mv_json: Value = serde_json::from_slice(&mv.stdout).unwrap();
    assert_eq!(mv_json["matches"].as_array().unwrap().len(), 1);
    assert_eq!(mv_json["matches"][0]["version"], "0.17.2");
    assert_eq!(mv_json["matches"][0]["status"], "found");

    // 3. Git checkout with canonical underscore lookup
    let git_out = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "cool_git"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(&cargo_home)
        .arg("--json")
        .output()
        .unwrap();
    assert!(git_out.status.success());
    let git_json: Value = serde_json::from_slice(&git_out.stdout).unwrap();
    assert_eq!(git_json["matches"][0]["name"], "cool-git");
    assert_eq!(git_json["matches"][0]["kind"], "git");
    assert_eq!(git_json["matches"][0]["status"], "found");

    // 4. Local workspace path crate
    let path_out = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "my-local"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(&cargo_home)
        .arg("--json")
        .output()
        .unwrap();
    assert!(path_out.status.success());
    let path_json: Value = serde_json::from_slice(&path_out.stdout).unwrap();
    assert_eq!(path_json["matches"][0]["kind"], "path");
    assert_eq!(path_json["matches"][0]["status"], "found");

    // 5. Uncached crate fails closed (exit 1) with structured not_cached status
    let uncached = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "uncached-crate"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(&cargo_home)
        .arg("--json")
        .output()
        .unwrap();
    assert!(!uncached.status.success());
    let unc_json: Value = serde_json::from_slice(&uncached.stdout).unwrap();
    assert_eq!(unc_json["matches"][0]["status"], "not_cached");

    // 6. Path traversal crate name rejected fail-closed
    let traversal = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "../serde"])
        .arg(&repo)
        .output()
        .unwrap();
    assert!(!traversal.status.success());
}

#[test]
fn crate_source_rejects_crafted_lockfile_version_and_matches_uppercase_git_rev() {
    let tmp = tempdir().expect("tempdir");
    let repo = tmp.path().join("ws");
    let cargo_home = tmp.path().join("cargo");
    fs::create_dir_all(&repo).unwrap();

    // Lowercase git checkout directory matched by uppercase hex rev in Cargo.lock
    let git_dir = cargo_home.join("git/checkouts/upper-repo-1/abcdef1");
    fs::create_dir_all(git_dir.join("src")).unwrap();
    fs::create_dir_all(git_dir.join(".git")).unwrap();
    fs::write(
        git_dir.join(".git/HEAD"),
        "abcdef1234567890abcdef1234567890abcdef12\n",
    )
    .unwrap();
    fs::write(
        git_dir.join(".git/config"),
        "[remote \"origin\"]\n\turl = https://example.com/upper-repo\n",
    )
    .unwrap();
    fs::write(
        git_dir.join("Cargo.toml"),
        "[package]\nname = \"upper-git\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();

    // Sibling registry index dir that a crafted version tries to escape into
    let evil_dir = cargo_home.join("registry/src/other-index/evil-1.0.0");
    fs::create_dir_all(evil_dir.join("src")).unwrap();
    fs::write(
        evil_dir.join("Cargo.toml"),
        "[package]\nname = \"evil\"\nversion = \"1.0.0\"\n",
    )
    .unwrap();
    fs::create_dir_all(cargo_home.join("registry/src/index-a")).unwrap();

    fs::write(
        repo.join("Cargo.lock"),
        r#"version = 4

[[package]]
name = "upper-git"
version = "0.1.0"
source = "git+https://example.com/upper-repo#ABCDEF1234567890ABCDEF1234567890ABCDEF12"

[[package]]
name = "evil"
version = "../other-index/evil-1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
"#,
    )
    .unwrap();

    let up = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "upper-git"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(&cargo_home)
        .arg("--json")
        .output()
        .unwrap();
    assert!(
        up.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&up.stderr)
    );
    let up_json: Value = serde_json::from_slice(&up.stdout).unwrap();
    assert_eq!(up_json["matches"][0]["status"], "found");

    let evil = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "evil"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(&cargo_home)
        .output()
        .unwrap();
    assert!(!evil.status.success());
    assert!(String::from_utf8_lossy(&evil.stderr).contains("invalid version"));
}
