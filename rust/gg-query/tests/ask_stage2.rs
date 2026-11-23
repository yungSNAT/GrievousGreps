//! Stage 2 unit and integration tests for `gg-query` (`ask`, `skeleton`, tokenizer,
//! SQLite v3 inverted index, multi-scope fusion, concepts, and security boundaries).

use std::fs;
use std::path::Path;

use gg_query::ask::{AskMode, AskOptions, format_ask, format_skeleton, run_ask, run_skeleton};
use gg_query::store::GraphStore;
use gg_query::tokenize::tokenize;
use snapbox::cmd::{Command, cargo_bin};
use tempfile::tempdir;

fn write_wiring(ctx: &Path, graph: &serde_json::Value) {
    let dir = ctx.join(".graph");
    fs::create_dir_all(&dir).expect("mkdir .graph");
    fs::write(dir.join("wiring.json"), graph.to_string()).expect("write wiring.json");
}

#[test]
fn tokenizer_matches_ts_camel_nfc_stop_and_cjk_bigrams() {
    // CamelCase + stop-word removal + single-char drop.
    assert_eq!(
        tokenize("get computeTotal for a user2Id"),
        vec!["compute", "total", "user2", "id"]
    );
    // Cyrillic camelCase splitting.
    assert_eq!(
        tokenize("перевіритиОрендаря"),
        vec!["перевірити", "орендаря"]
    );
    // NFC normalization: decomposed e + combining acute matches precomposed é.
    assert_eq!(tokenize("cafe\u{0301}"), tokenize("café"));
    // CJK bigrams: 4-char word emits whole word + 3 bigrams; 2-char word emits once.
    assert_eq!(
        tokenize("中文检索"),
        vec!["中文检索", "中文", "文检", "检索"]
    );
    assert_eq!(tokenize("中文"), vec!["中文"]);
}

#[test]
fn ask_index_sidecar_restores_stripped_body_tokens_and_auto_resyncs() {
    let tmp = tempdir().expect("tempdir");
    let ctx = tmp.path().join("graft");
    let graph = serde_json::json!({
        "meta": { "nodeCount": 2, "edgeCount": 0 },
        "nodes": [
            {
                "id": "src/a.ts#alpha",
                "name": "alpha",
                "kind": "function",
                "path": "src/a.ts",
                "span": "L1-L4",
                "signature": "function alpha()",
                "exported": true,
                "origin": "ast",
                "body_hash": "h1"
            },
            {
                "id": "src/b.ts#beta",
                "name": "beta",
                "kind": "function",
                "path": "src/b.ts",
                "span": "L1-L4",
                "signature": "function beta()",
                "exported": true,
                "origin": "ast",
                "body_hash": "h2"
            }
        ],
        "edges": [],
        "unresolvedCalls": []
    });
    write_wiring(&ctx, &graph);

    let opts = AskOptions {
        limit: 8,
        source: false,
        full: false,
        graph_rank: true,
        in_prefix: None,
        model_dir: None,
        semantic: false,
    };

    // Without ask-index.json, a body-only token ("quasar") has zero hits.
    let before = run_ask(tmp.path(), &ctx, "quasar", &opts).expect("ask before sidecar");
    assert_eq!(before.mode, AskMode::Empty);
    assert!(before.hits.is_empty());

    // Add ask-index.json with body token "quasar" on beta; GraphStore must auto-resync.
    let cache = ctx.join(".cache");
    fs::create_dir_all(&cache).expect("mkdir .cache");
    let sidecar = serde_json::json!({
        "version": 2,
        "avgBodyLen": 2.0,
        "df": [["alpha", 1], ["beta", 1], ["quasar", 1], ["src", 2], ["ts", 2]],
        "docCount": 2,
        "docs": [
            {"id": "src/a.ts#alpha", "name": [["alpha", 1]], "path": [["src", 1], ["ts", 1]], "body": [["alpha", 1]]},
            {"id": "src/b.ts#beta", "name": [["beta", 1]], "path": [["src", 1], ["ts", 1]], "body": [["beta", 1], ["quasar", 2]]}
        ]
    });
    fs::write(cache.join("ask-index.json"), sidecar.to_string()).expect("write ask-index.json");

    let after = run_ask(tmp.path(), &ctx, "quasar", &opts).expect("ask after sidecar");
    assert_eq!(after.mode, AskMode::Lexical);
    assert_eq!(after.hits.len(), 1);
    assert_eq!(after.hits[0].pointer, "src/b.ts:L1-L4");
}

#[test]
fn multi_scope_suppresses_body_only_scope_and_renders_footer() {
    let tmp = tempdir().expect("tempdir");
    let ctx = tmp.path().join("graft");
    let graph = serde_json::json!({
        "meta": {
            "nodeCount": 2,
            "edgeCount": 0,
            "scopes": [
                { "prefix": "backend", "label": "backend", "markers": ["Cargo.toml"] },
                { "prefix": "docs", "label": "docs", "markers": ["package.json"] }
            ]
        },
        "nodes": [
            {
                "id": "backend/gateway.ts#GatewayTimeout",
                "name": "GatewayTimeout",
                "kind": "class",
                "path": "backend/gateway.ts",
                "span": "L1-L10",
                "signature": "class GatewayTimeout",
                "exported": true,
                "origin": "ast",
                "body_hash": "h1"
            },
            {
                "id": "docs/guide.ts#renderBanner",
                "name": "renderBanner",
                "kind": "function",
                "path": "docs/guide.ts",
                "span": "L1-L10",
                "signature": "function renderBanner()",
                "body_text": "gateway gateway gateway gateway",
                "exported": true,
                "origin": "ast",
                "body_hash": "h2"
            }
        ],
        "edges": [],
        "unresolvedCalls": []
    });
    write_wiring(&ctx, &graph);

    let opts = AskOptions {
        limit: 8,
        source: false,
        full: false,
        graph_rank: true,
        in_prefix: None,
        model_dir: None,
        semantic: false,
    };
    let res = run_ask(tmp.path(), &ctx, "gateway", &opts).expect("multi-scope ask");
    assert_eq!(res.mode, AskMode::Lexical);
    assert_eq!(res.hits.len(), 1);
    assert_eq!(res.hits[0].pointer, "backend/gateway.ts:L1-L10");
    let scopes = res.scopes.as_ref().expect("scopes metadata");
    assert_eq!(scopes.federated, vec!["backend"]);
    assert_eq!(scopes.also_matched.len(), 1);
    assert_eq!(scopes.also_matched[0].scope, "docs");

    let md = format_ask(&res);
    assert!(md.contains("[backend/] GatewayTimeout · class"));
    assert!(md.contains("matched in: backend/ (1)"));
    assert!(md.contains("also matched: docs/ — narrow with --in docs/"));
}

#[test]
fn test_path_deranking_is_query_aware() {
    let tmp = tempdir().expect("tempdir");
    let ctx = tmp.path().join("graft");
    let graph = serde_json::json!({
        "meta": { "nodeCount": 2, "edgeCount": 0 },
        "nodes": [
            {
                "id": "tests/billing.test.ts#billingInvoice",
                "name": "billingInvoice",
                "kind": "function",
                "path": "tests/billing.test.ts",
                "span": "L1-L5",
                "signature": "function billingInvoice()",
                "exported": true,
                "origin": "ast",
                "body_hash": "h1"
            },
            {
                "id": "src/billing.ts#billingInvoice",
                "name": "billingInvoice",
                "kind": "function",
                "path": "src/billing.ts",
                "span": "L1-L5",
                "signature": "function billingInvoice()",
                "exported": true,
                "origin": "ast",
                "body_hash": "h2"
            }
        ],
        "edges": [],
        "unresolvedCalls": []
    });
    write_wiring(&ctx, &graph);

    let opts = AskOptions {
        limit: 8,
        source: false,
        full: false,
        graph_rank: false,
        in_prefix: None,
        model_dir: None,
        semantic: false,
    };
    let prod = run_ask(tmp.path(), &ctx, "billing invoice", &opts).expect("prod ask");
    assert_eq!(prod.hits[0].pointer, "src/billing.ts:L1-L5");
    assert!(prod.hits[0].score > prod.hits[1].score);

    let test_q = run_ask(tmp.path(), &ctx, "billing invoice tests", &opts).expect("test ask");
    assert_eq!(test_q.hits[0].pointer, "tests/billing.test.ts:L1-L5");
}

fn write_source_inlining_fixture(root: &Path, ctx: &Path) {
    fs::create_dir_all(root.join("src")).expect("mkdir src");
    fs::write(
        root.join("src/pay.ts"),
        "export function chargeCard() {\n  return 42;\n}\n",
    )
    .expect("write pay.ts");
    fs::write(root.join("secrets.yaml"), "apiKey: super-secret\n").expect("write yaml");

    let graph = serde_json::json!({
        "meta": { "nodeCount": 4, "edgeCount": 0 },
        "nodes": [
            {
                "id": "src/pay.ts",
                "name": "pay.ts",
                "kind": "file",
                "path": "src/pay.ts",
                "span": "L1-L3",
                "signature": null,
                "exported": true,
                "origin": "ast",
                "body_hash": "f1",
                "chars": 4000
            },
            {
                "id": "src/pay.ts#chargeCard",
                "name": "chargeCard",
                "kind": "function",
                "path": "src/pay.ts",
                "span": "L1-L3",
                "signature": "function chargeCard()",
                "exported": true,
                "origin": "ast",
                "body_hash": "h1",
                "crux": { "code": "return 42;" }
            },
            {
                "id": "secrets.yaml#chargeCard",
                "name": "chargeCard",
                "kind": "resource",
                "path": "secrets.yaml",
                "span": "L1-L1",
                "signature": "Secret chargeCard",
                "exported": true,
                "origin": "deploy",
                "body_hash": "h2"
            },
            {
                "id": "../escape.ts#chargeCard",
                "name": "chargeCard",
                "kind": "function",
                "path": "../escape.ts",
                "span": "L1-L1",
                "signature": "function chargeCard()",
                "exported": true,
                "origin": "ast",
                "body_hash": "h3"
            }
        ],
        "edges": [],
        "unresolvedCalls": []
    });
    write_wiring(ctx, &graph);
}

#[test]
fn source_inlining_skips_deploy_files_and_path_traversal_and_uses_crux() {
    let tmp = tempdir().expect("tempdir");
    let ctx = tmp.path().join("graft");
    write_source_inlining_fixture(tmp.path(), &ctx);

    let crux_opts = AskOptions {
        limit: 8,
        source: true,
        full: false,
        graph_rank: false,
        in_prefix: None,
        model_dir: None,
        semantic: false,
    };
    let res = run_ask(tmp.path(), &ctx, "chargeCard", &crux_opts).expect("ask crux");
    let pay_hit = res
        .hits
        .iter()
        .find(|h| h.pointer == "src/pay.ts:L1-L3")
        .expect("pay hit");
    assert!(
        pay_hit
            .code
            .as_deref()
            .is_some_and(|c| c.contains("return 42;") && c.contains("rerun with --full"))
    );
    let yaml_hit = res
        .hits
        .iter()
        .find(|h| h.pointer == "secrets.yaml:L1-L1")
        .expect("yaml hit");
    assert!(
        yaml_hit.code.is_none(),
        "deploy file must never inline source"
    );
    let escape_hit = res
        .hits
        .iter()
        .find(|h| h.pointer == "../escape.ts:L1-L1")
        .expect("escape hit");
    assert!(
        escape_hit.code.is_none(),
        "traversal path must never inline"
    );

    let full_opts = AskOptions {
        full: true,
        ..crux_opts
    };
    let full_res = run_ask(tmp.path(), &ctx, "chargeCard", &full_opts).expect("ask full");
    let full_pay = full_res
        .hits
        .iter()
        .find(|h| h.pointer == "src/pay.ts:L1-L3")
        .expect("full pay");
    assert_eq!(
        full_pay.code.as_deref(),
        Some("export function chargeCard() {\n  return 42;\n}")
    );
}

fn write_concepts_and_dup_fixture(ctx: &Path) {
    fs::create_dir_all(ctx).expect("mkdir graft");
    fs::write(
        ctx.join("billing-arch.md"),
        "---\nslug: billing-arch\nname: Billing Architecture\nsources:\n  - path: src/a.ts\nlinks:\n  - to: tax-engine\n---\n\n# Billing\n\nHandles invoice totals and settlement.\n",
    )
    .expect("write concept");
    fs::write(
        ctx.join("bad-anchor.md"),
        "---\nname: &a Bomb\nalias: *a\n---\n\nPlain fallback prose.\n",
    )
    .expect("write anchor concept");

    let graph = serde_json::json!({
        "meta": { "nodeCount": 2, "edgeCount": 0 },
        "nodes": [
            {
                "id": "a/dup.ts#fnA",
                "name": "fnA",
                "kind": "function",
                "path": "a/dup.ts",
                "span": "L1-L2",
                "signature": "function fnA()",
                "exported": true,
                "origin": "ast",
                "body_hash": "1"
            },
            {
                "id": "b/dup.ts#fnB",
                "name": "fnB",
                "kind": "function",
                "path": "b/dup.ts",
                "span": "L1-L2",
                "signature": "function fnB()",
                "exported": true,
                "origin": "ast",
                "body_hash": "2"
            }
        ],
        "edges": [],
        "unresolvedCalls": []
    });
    write_wiring(ctx, &graph);
}

#[test]
fn concepts_and_structural_fallthrough_and_stdin_and_skeleton_errors() {
    let tmp = tempdir().expect("tempdir");
    let ctx = tmp.path().join("graft");
    write_concepts_and_dup_fixture(&ctx);

    let opts = AskOptions {
        limit: 8,
        source: false,
        full: false,
        graph_rank: true,
        in_prefix: None,
        model_dir: None,
        semantic: false,
    };
    let concept_res = run_ask(tmp.path(), &ctx, "billing settlement", &opts).expect("concept ask");
    assert_eq!(concept_res.mode, AskMode::Lexical);
    assert_eq!(concept_res.hits[0].kind, "concept");
    assert_eq!(concept_res.hits[0].title, "Billing Architecture");
    assert_eq!(
        concept_res.hits[0].related.as_deref(),
        Some(&["tax-engine".to_string()][..])
    );

    let fallthrough =
        run_ask(tmp.path(), &ctx, "who calls nonexistentBilling", &opts).expect("fallthrough");
    assert!(
        fallthrough
            .note
            .as_deref()
            .is_some_and(|n| n.starts_with("structural index: no entries for"))
    );
    assert!(format_ask(&fallthrough).contains("⚠ structural index:"));

    let store = GraphStore::open_or_sync(&ctx)
        .expect("open")
        .expect("store");
    let skel = run_skeleton(Some(&store), "dup.ts").expect("skeleton");
    assert!(skel.entries.is_empty());
    assert_eq!(
        skel.note.as_deref(),
        Some("ambiguous — matches: a/dup.ts, b/dup.ts")
    );
    assert!(format_skeleton(&skel).contains("ambiguous — matches: a/dup.ts, b/dup.ts"));

    Command::new(cargo_bin!("gg-query"))
        .args(["ask", "-", "--no-semantic", "--json"])
        .arg(tmp.path())
        .stdin("billing settlement\n")
        .assert()
        .success();

    Command::new(cargo_bin!("gg-query"))
        .args(["ask", "fnA", "--in", "nonexistent", "--no-semantic"])
        .arg(tmp.path())
        .assert()
        .code(1)
        .stderr_eq("✗ nothing indexed under \"nonexistent/\" (or any path prefix)\n");
}
