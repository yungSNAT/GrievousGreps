//! Hardening regression tests across `callers`, `hubs`, `provenance` and `crate-source`.

use std::fs;
use std::path::Path;

use serde_json::Value;
use snapbox::cmd::{Command, cargo_bin};
use tempfile::tempdir;

fn write_graph(repo: &Path, json: &str) {
    let gdir = repo.join("graft").join(".graph");
    fs::create_dir_all(&gdir).unwrap();
    fs::write(gdir.join("wiring.json"), json).unwrap();
}

#[test]
fn default_callers_preserves_legacy_first_non_inferred_path_whilst_provenance_upgrades() {
    let tmp = tempdir().unwrap();
    // Mixed-confidence mixed-relation diamond:
    // A <-[references, extracted]- B <-[references, extracted]- D
    // A <-[calls, lsp_resolved]-   C <-[calls, lsp_resolved]-   D
    // Default callers MUST preserve legacy first non-inferred path (`references`).
    // `--provenance` MUST upgrade to the stronger same-depth `lsp_resolved` path (`calls`).
    let graph = r#"{
  "meta": { "version": 1, "nodeCount": 5, "edgeCount": 4, "languages": ["typescript"] },
  "nodes": [
    { "id": "src/a.ts", "name": "a.ts", "kind": "file", "path": "src/a.ts", "span": "L1-L20", "exported": false, "origin": "ast", "body_hash": "f0", "chars": 200 },
    { "id": "src/a.ts#A", "name": "A", "kind": "function", "path": "src/a.ts", "span": "L1-L3", "exported": true, "origin": "ast", "body_hash": "h1" },
    { "id": "src/a.ts#B", "name": "B", "kind": "function", "path": "src/a.ts", "span": "L5-L7", "exported": true, "origin": "ast", "body_hash": "h2" },
    { "id": "src/a.ts#C", "name": "C", "kind": "function", "path": "src/a.ts", "span": "L9-L11", "exported": true, "origin": "ast", "body_hash": "h3" },
    { "id": "src/a.ts#D", "name": "D", "kind": "function", "path": "src/a.ts", "span": "L13-L15", "exported": true, "origin": "ast", "body_hash": "h4" }
  ],
  "edges": [
    { "source": "src/a.ts#B", "target": "src/a.ts#A", "relation": "references", "confidence": "extracted" },
    { "source": "src/a.ts#C", "target": "src/a.ts#A", "relation": "calls", "confidence": "lsp_resolved" },
    { "source": "src/a.ts#D", "target": "src/a.ts#B", "relation": "references", "confidence": "extracted" },
    { "source": "src/a.ts#D", "target": "src/a.ts#C", "relation": "calls", "confidence": "lsp_resolved" }
  ],
  "unresolvedCalls": [
    { "name": "A", "source": "src/other.ts#caller", "through": "./missing", "file": "src/missing.d.ts" }
  ]
}"#;
    write_graph(tmp.path(), graph);

    let legacy = Command::new(cargo_bin!("gg-query"))
        .args(["callers", "A", "--depth", "2", "--json"])
        .arg(tmp.path())
        .output()
        .unwrap();
    assert!(legacy.status.success());
    let ljson: Value = serde_json::from_slice(&legacy.stdout).unwrap();
    let d_legacy = ljson["matches"][0]["hits"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["id"] == "src/a.ts#D")
        .unwrap();
    assert_eq!(d_legacy["relation"], "references");

    let prov = Command::new(cargo_bin!("gg-query"))
        .args(["callers", "A", "--depth", "2", "--provenance", "--json"])
        .arg(tmp.path())
        .output()
        .unwrap();
    assert!(prov.status.success());
    let pjson: Value = serde_json::from_slice(&prov.stdout).unwrap();
    let d_prov = pjson["matches"][0]["hits"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["id"] == "src/a.ts#D")
        .unwrap();
    assert_eq!(d_prov["relation"], "calls");
    assert_eq!(d_prov["weakestConfidence"], "lsp_resolved");
    // Structured unresolvedCalls parity
    assert_eq!(
        pjson["matches"][0]["unresolvedCalls"][0]["source"],
        "src/other.ts#caller"
    );
}

fn setup_identity_fixture(base: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let repo = base.join("repo");
    let ch = base.join("cargo");
    fs::create_dir_all(repo.join("crates/ws-member/src")).unwrap();
    fs::write(
        repo.join("Cargo.toml"),
        "[workspace]\nmembers = [\"crates/ws-member\"]\n[workspace.package]\nversion = \"2.3.4\"\n",
    )
    .unwrap();
    fs::write(
        repo.join("crates/ws-member/Cargo.toml"),
        "[package]\nname = \"ws-member\"\nversion.workspace = true\n",
    )
    .unwrap();

    // Two duplicate local crates with same name and version -> ambiguous
    for sub in ["dup-a", "dup-b"] {
        fs::create_dir_all(repo.join("crates").join(sub)).unwrap();
        fs::write(
            repo.join("crates").join(sub).join("Cargo.toml"),
            "[package]\nname = \"dup-local\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
    }

    // Registry crate with mismatched manifest version (9.9.9 vs locked 1.0.0) -> not_cached
    let idx1 = ch.join("registry/src/index.crates.io-111");
    let idx2 = ch.join("registry/src/index.crates.io-222");
    fs::create_dir_all(idx1.join("spoofed-1.0.0")).unwrap();
    fs::write(
        idx1.join("spoofed-1.0.0/Cargo.toml"),
        "[package]\nname = \"spoofed\"\nversion = \"9.9.9\"\n",
    )
    .unwrap();

    // Registry crate present in 2 matching crates.io index dirs -> ambiguous
    for idx in [&idx1, &idx2] {
        fs::create_dir_all(idx.join("ambig-1.0.0")).unwrap();
        fs::write(
            idx.join("ambig-1.0.0/Cargo.toml"),
            "[package]\nname = \"ambig\"\nversion = \"1.0.0\"\n",
        )
        .unwrap();
    }

    // Unverified git checkout (missing .git/HEAD and .cargo-vcs-info.json) -> unresolved
    let unv = ch.join("git/checkouts/unv-123/1234567");
    fs::create_dir_all(&unv).unwrap();
    fs::write(
        unv.join("Cargo.toml"),
        "[package]\nname = \"unverified-git\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();

    fs::write(
        repo.join("Cargo.lock"),
        r#"version = 4

[[package]] # inline table comment
name = "ws-member"
version = "2.3.4"

[[package]]
name = "dup-local"
version = "0.1.0"

[[package]]
name = "spoofed"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "ambig"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "unverified-git"
version = "0.1.0"
source = "git+https://example.com/unv#1234567890abcdef1234567890abcdef12345678"
"#,
    )
    .unwrap();

    (repo, ch)
}

#[test]
fn crate_source_verifies_identity_ambiguity_and_workspace_version() {
    let tmp = tempdir().unwrap();
    let (repo, ch) = setup_identity_fixture(tmp.path());

    // 1. workspace.package version resolves cleanly (also exercise relative --cargo-home!)
    let rel_ch = Path::new("cargo");
    let ws = Command::new(cargo_bin!("gg-query"))
        .current_dir(tmp.path())
        .args(["crate-source", "ws-member"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(rel_ch)
        .arg("--json")
        .output()
        .unwrap();
    assert!(
        ws.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&ws.stderr)
    );
    let ws_json: Value = serde_json::from_slice(&ws.stdout).unwrap();
    assert_eq!(ws_json["matches"][0]["status"], "found");
    assert!(Path::new(ws_json["cargoHome"].as_str().unwrap()).is_absolute());

    // 2. Duplicate local crates -> ambiguous (exit 1)
    let dup = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "dup-local"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(&ch)
        .arg("--json")
        .output()
        .unwrap();
    assert!(!dup.status.success());
    let dup_json: Value = serde_json::from_slice(&dup.stdout).unwrap();
    assert_eq!(dup_json["matches"][0]["status"], "ambiguous");

    // 3. Spoofed manifest version 9.9.9 vs locked 1.0.0 -> never returns found
    let sp = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "spoofed"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(&ch)
        .arg("--json")
        .output()
        .unwrap();
    assert!(!sp.status.success());
    let sp_json: Value = serde_json::from_slice(&sp.stdout).unwrap();
    assert_eq!(sp_json["matches"][0]["status"], "not_cached");

    // 4. Ambiguous registry dirs -> ambiguous (exit 1)
    let amb = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "ambig"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(&ch)
        .arg("--json")
        .output()
        .unwrap();
    assert!(!amb.status.success());
    let amb_json: Value = serde_json::from_slice(&amb.stdout).unwrap();
    assert_eq!(amb_json["matches"][0]["status"], "ambiguous");

    // 5. Unverified git checkout -> unresolved (exit 1)
    let uv = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "unverified-git"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(&ch)
        .arg("--json")
        .output()
        .unwrap();
    assert!(!uv.status.success());
    let uv_json: Value = serde_json::from_slice(&uv.stdout).unwrap();
    assert_eq!(uv_json["matches"][0]["status"], "unresolved");
}

#[test]
fn crate_source_strict_toml_schemes_and_budget_exhausted() {
    let tmp = tempdir().unwrap();
    let cases = [
        (
            "dup_key",
            "[[package]]\nname = \"a\"\nname = \"b\"\nversion = \"1.0.0\"\n",
        ),
        (
            "trailing",
            "[[package]]\nname = \"a\" junk\nversion = \"1.0.0\"\n",
        ),
        (
            "bad_escape",
            "[[package]]\nname = \"a\\z\"\nversion = \"1.0.0\"\n",
        ),
        (
            "non_str_src",
            "[[package]]\nname = \"a\"\nversion = \"1.0.0\"\nsource = 42\n",
        ),
        (
            "bad_scheme",
            "[[package]]\nname = \"a\"\nversion = \"1.0.0\"\nsource = \"bogus+location\"\n",
        ),
    ];
    for (label, content) in cases {
        let dir = tmp.path().join(label);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("Cargo.lock"), content).unwrap();
        let out = Command::new(cargo_bin!("gg-query"))
            .args(["crate-source", "a"])
            .arg(&dir)
            .output()
            .unwrap();
        assert!(!out.status.success(), "case {label} should fail closed");
    }

    // Multiline dependencies array containing '=' inside query string must parse cleanly
    let ml_dir = tmp.path().join("multiline_deps");
    fs::create_dir_all(ml_dir.join("crates/demo")).unwrap();
    fs::write(
        ml_dir.join("crates/demo/Cargo.toml"),
        "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    fs::write(
        ml_dir.join("Cargo.lock"),
        "version = 4\n[[package]]\nname = \"demo\"\nversion = \"0.1.0\"\ndependencies = [\n \"dep 1.0 (git+https://example.com/r?branch=main#0123456789abcdef0123456789abcdef01234567)\",\n \"dep2 1.0 (git+https://example.com/r2?branch=dev#0123456789abcdef0123456789abcdef01234567)\",\n]\n",
    )
    .unwrap();
    let ml_out = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "demo"])
        .arg(&ml_dir)
        .arg("--json")
        .output()
        .unwrap();
    assert!(
        ml_out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&ml_out.stderr)
    );

    // Registry budget exhaustion (> 64 index dirs) returns distinct budget_exhausted status
    let repo = tmp.path().join("budget-repo");
    let ch = tmp.path().join("budget-cargo");
    fs::create_dir_all(&repo).unwrap();
    for i in 0..66 {
        fs::create_dir_all(ch.join(format!("registry/src/idx-{i:03}"))).unwrap();
    }
    fs::write(
        repo.join("Cargo.lock"),
        "version = 4\n[[package]]\nname = \"serde\"\nversion = \"1.0.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n",
    )
    .unwrap();
    let bud = Command::new(cargo_bin!("gg-query"))
        .args(["crate-source", "serde"])
        .arg(&repo)
        .args(["--cargo-home"])
        .arg(&ch)
        .arg("--json")
        .output()
        .unwrap();
    assert!(!bud.status.success());
    let bud_json: Value = serde_json::from_slice(&bud.stdout).unwrap();
    assert_eq!(bud_json["matches"][0]["status"], "budget_exhausted");
}

#[test]
fn hubs_self_loop_excluded_from_pagerank_whilst_degrees_counted() {
    let tmp = tempdir().unwrap();
    let graph = r#"{
  "meta": { "version": 1, "nodeCount": 3, "edgeCount": 2, "languages": ["typescript"] },
  "nodes": [
    { "id": "src/r.ts", "name": "r.ts", "kind": "file", "path": "src/r.ts", "span": "L1-L10", "exported": false, "origin": "ast", "body_hash": "f0", "chars": 100 },
    { "id": "src/r.ts#A", "name": "A", "kind": "function", "path": "src/r.ts", "span": "L1-L5", "exported": true, "origin": "ast", "body_hash": "h1" },
    { "id": "src/r.ts#B", "name": "B", "kind": "function", "path": "src/r.ts", "span": "L6-L10", "exported": true, "origin": "ast", "body_hash": "h2" }
  ],
  "edges": [
    { "source": "src/r.ts#A", "target": "src/r.ts#A", "relation": "calls", "confidence": "extracted" },
    { "source": "src/r.ts#A", "target": "src/r.ts#B", "relation": "calls", "confidence": "extracted" }
  ],
  "unresolvedCalls": []
}"#;
    write_graph(tmp.path(), graph);
    let out = Command::new(cargo_bin!("gg-query"))
        .args(["hubs", "--json"])
        .arg(tmp.path())
        .output()
        .unwrap();
    assert!(out.status.success());
    let json: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(json["totals"]["walkEdges"], 1);
    assert_eq!(json["hubs"][0]["name"], "A");
    assert_eq!(json["hubs"][0]["pagerank"], 1.0);
    assert_eq!(json["hubs"][1]["name"], "B");
    assert_eq!(json["hubs"][1]["pagerank"], 1.0);
    assert_eq!(json["hubs"][0]["inDegree"], 1);
    assert_eq!(json["hubs"][0]["outDegree"], 2);
}
