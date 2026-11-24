/**
 * Tests for the 4 feature additions:
 * 1. EXTRACTED vs INFERRED edge provenance + weakest-hop path rating (core, CLI, MCP)
 * 2. God-node / hub summary command + MCP mode (`hubs`)
 * 3. `Cargo.lock`-anchored resolved-dependency source lookup (`crate-source`)
 * 4. Polyglot auto-detection audit on `build` and `init`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { resolveCrateSource } from "../src/graph/crate-source.js";
import { computeHubs, formatHubsText, parseHubLimit } from "../src/graph/hubs.js";
import { auditPolyglotRepo, formatPolyglotAuditLines } from "../src/graph/polyglot-audit.js";
import { edgeWalk, resolveSymbol } from "../src/graph/traverse.js";
import { wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";
import type { GraphV1 } from "../src/graph/types.js";
import { callTool } from "../src/mcp/tools.js";

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status ?? 1,
  };
}

function provenanceFixtureGraph(): GraphV1 {
  return {
    meta: { version: 1, nodeCount: 6, edgeCount: 6, languages: ["typescript"] },
    nodes: [
      { id: "src/a.ts", name: "a.ts", kind: "file", path: "src/a.ts", span: "L1-L20", signature: null, exported: false, origin: "ast", body_hash: "h0", chars: 400, summary_state: "pending", summary: null, crux: null },
      { id: "src/a.ts#core", name: "core", kind: "function", path: "src/a.ts", span: "L1-L3", signature: "core()", exported: true, origin: "ast", body_hash: "h1", summary_state: "pending", summary: null, crux: null },
      { id: "src/a.ts#midExtracted", name: "midExtracted", kind: "function", path: "src/a.ts", span: "L5-L7", signature: "midExtracted()", exported: true, origin: "ast", body_hash: "h2", summary_state: "pending", summary: null, crux: null },
      { id: "src/a.ts#midInferred", name: "midInferred", kind: "function", path: "src/a.ts", span: "L9-L11", signature: "midInferred()", exported: true, origin: "ast", body_hash: "h3", summary_state: "pending", summary: null, crux: null },
      { id: "src/a.ts#leafWeak", name: "leafWeak", kind: "function", path: "src/a.ts", span: "L13-L15", signature: "leafWeak()", exported: true, origin: "ast", body_hash: "h4", summary_state: "pending", summary: null, crux: null },
      { id: "src/a.ts#diamond", name: "diamond", kind: "function", path: "src/a.ts", span: "L17-L19", signature: "diamond()", exported: true, origin: "ast", body_hash: "h5", summary_state: "pending", summary: null, crux: null },
    ],
    edges: [
      { source: "src/a.ts#midExtracted", target: "src/a.ts#core", relation: "calls", confidence: "lsp_resolved" },
      { source: "src/a.ts#midInferred", target: "src/a.ts#core", relation: "calls", confidence: "inferred" },
      { source: "src/a.ts#leafWeak", target: "src/a.ts#midExtracted", relation: "calls", confidence: "inferred" },
      { source: "src/a.ts#diamond", target: "src/a.ts#midInferred", relation: "calls", confidence: "extracted" },
      { source: "src/a.ts#diamond", target: "src/a.ts#midExtracted", relation: "calls", confidence: "extracted" },
      { source: "src/a.ts#midInferred", target: "src/a.ts#leafWeak", relation: "references", confidence: "extracted" },
    ],
  };
}

test("provenance: edgeWalk tracks weakest-hop confidence across multi-hop and diamond paths", () => {
  const g = provenanceFixtureGraph();
  const [core] = resolveSymbol(g, "core");
  const hits = edgeWalk(g, core, "in", 2);
  const byId = new Map(hits.map((h) => [h.id, h]));

  assert.equal(byId.get("src/a.ts#midExtracted")?.confidence, "lsp_resolved");
  assert.equal(byId.get("src/a.ts#midExtracted")?.weakestHop?.depth, 1);

  assert.equal(byId.get("src/a.ts#midInferred")?.confidence, "inferred");
  assert.equal(byId.get("src/a.ts#midInferred")?.inferred, true);

  assert.equal(byId.get("src/a.ts#leafWeak")?.confidence, "inferred");
  assert.equal(byId.get("src/a.ts#leafWeak")?.weakestHop?.depth, 2);

  // Stronger same-depth path replaces inferred diamond path
  assert.equal(byId.get("src/a.ts#diamond")?.confidence, "extracted");
  assert.equal(byId.get("src/a.ts#diamond")?.inferred, undefined);
  assert.equal(byId.get("src/a.ts#diamond")?.weakestHop?.depth, 2);
});

test("provenance: CLI callers --provenance and MCP graft_trace_calls provenance:true", async () => {
  const d = mkdtempSync(join(tmpdir(), "gg-prov-"));
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src/a.ts"), "export function core() { return 1; }\n");
  await buildGraph(d);
  const g = provenanceFixtureGraph();
  const ctxDir = contextDirFor(d);
  writeFileSync(wiringPath(ctxDir), JSON.stringify(g));

  const jsonRes = runCli(["callers", "core", d, "--depth", "2", "--provenance", "--json", "--no-refresh"]);
  assert.equal(jsonRes.status, 0, jsonRes.stderr);
  const parsed = JSON.parse(jsonRes.stdout);
  const m = parsed.matches[0];
  assert.equal(m.provenanceSummary.extracted, 2);
  assert.equal(m.provenanceSummary.inferred, 2);
  assert.equal(m.provenanceSummary.weakestProvenance, "INFERRED");

  const txtRes = runCli(["callers", "core", d, "--depth", "2", "--provenance", "--no-refresh"]);
  assert.equal(txtRes.status, 0, txtRes.stderr);
  assert.match(txtRes.stdout, /provenance: 2 EXTRACTED, 2 INFERRED/);
  assert.match(txtRes.stdout, /\[EXTRACTED · lsp_resolved\]/);
  assert.match(txtRes.stdout, /\[INFERRED · weakest: inferred @ hop 2\]/);
  assert.match(txtRes.stdout, /\[EXTRACTED · weakest: extracted @ hop 2\]/);

  const mcpRes = await callTool(d, "graft_trace_calls", { symbol: "core", depth: 2, provenance: true });
  assert.equal(mcpRes.isError, false, mcpRes.text);
  assert.match(mcpRes.text, /provenance: 2 EXTRACTED, 2 INFERRED/);
  assert.match(mcpRes.text, /\[EXTRACTED · weakest: extracted @ hop 2\]/);
});

test("hubs: ranks top PageRank/connectivity hubs via core, CLI and MCP mode:hubs", async () => {
  const d = mkdtempSync(join(tmpdir(), "gg-hubs-"));
  mkdirSync(join(d, "src/sub"), { recursive: true });
  writeFileSync(join(d, "src/core.ts"), "export function hub() { return 1; }\nexport function isolated() { return 0; }\nexport function a() { return hub(); }\n");
  writeFileSync(join(d, "src/sub/b.ts"), "import { hub } from '../core';\nexport function b() { return hub() + c(); }\nexport function c() { return hub(); }\n");

  const build = await buildGraph(d);
  assert.ok(build.nodes > 0);

  const cliJson = runCli(["hubs", d, "--limit", "2", "--json", "--no-refresh"]);
  assert.equal(cliJson.status, 0, cliJson.stderr);
  const parsed = JSON.parse(cliJson.stdout);
  assert.equal(parsed.hubs[0].name, "hub");
  assert.equal(parsed.totals.shown, 2);
  assert.ok(parsed.totals.truncated >= 1);

  const cliText = runCli(["hubs", d, "--limit", "2", "--no-refresh"]);
  assert.equal(cliText.status, 0, cliText.stderr);
  assert.match(cliText.stdout, /hubs · 2 of /);
  assert.match(cliText.stdout, /1\. hub \(function\)/);

  const mcpHubs = await callTool(d, "graft_repo_map", { mode: "hubs", limit: 2 });
  assert.equal(mcpHubs.isError, false);
  assert.match(mcpHubs.text, /1\. hub \(function\)/);

  // Unit check: isolated excluded
  const g = provenanceFixtureGraph();
  const report = computeHubs(g, { limit: 10 });
  assert.ok(report.hubs.length > 0);
  assert.match(formatHubsText(report), /EXTRACTED/);
});

test("crate-source: resolves exact registry, git and path crates and fails closed on uncached/traversal", () => {
  const base = mkdtempSync(join(tmpdir(), "gg-cratesrc-"));
  const repo = join(base, "repo");
  const cargoHome = join(base, "cargo-home");
  mkdirSync(join(repo, "crates/local-one/src"), { recursive: true });
  writeFileSync(join(repo, "crates/local-one/Cargo.toml"), '[package]\nname = "local-one"\nversion = "0.1.0"\n');

  const regIdx = join(cargoHome, "registry/src/index.crates.io-abc");
  mkdirSync(join(regIdx, "serde-1.0.229/src"), { recursive: true });
  writeFileSync(join(regIdx, "serde-1.0.229/Cargo.toml"), '[package]\nname = "serde"\nversion = "1.0.229"\n');
  mkdirSync(join(regIdx, "serde-1.0.100/src"), { recursive: true });
  writeFileSync(join(regIdx, "serde-1.0.100/Cargo.toml"), '[package]\nname = "serde"\nversion = "1.0.100"\n');

  const gitDir = join(cargoHome, "git/checkouts/cool-123/abcdef1");
  mkdirSync(join(gitDir, "src"), { recursive: true });
  writeFileSync(join(gitDir, "Cargo.toml"), '[package]\nname = "cool-git"\nversion = "0.2.0"\n');

  writeFileSync(
    join(repo, "Cargo.lock"),
    [
      "version = 4",
      "",
      "[[package]]",
      'name = "local-one"',
      'version = "0.1.0"',
      "",
      "[[package]]",
      'name = "serde"',
      'version = "1.0.229"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "",
      "[[package]]",
      'name = "cool-git"',
      'version = "0.2.0"',
      'source = "git+https://example.com/cool#abcdef1234567890abcdef1234567890abcdef12"',
      "",
      "[[package]]",
      'name = "missing-cache"',
      'version = "3.0.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
    ].join("\n"),
  );

  const exact = resolveCrateSource({ crateName: "serde", repo, cargoHome });
  assert.equal(exact.matches.length, 1);
  assert.equal(exact.matches[0].version, "1.0.229");
  assert.equal(exact.matches[0].status, "found");
  assert.ok(exact.matches[0].path?.endsWith("serde-1.0.229"));

  const gitMatch = resolveCrateSource({ crateName: "cool_git", repo, cargoHome });
  assert.equal(gitMatch.matches[0].name, "cool-git");
  assert.equal(gitMatch.matches[0].kind, "git");
  assert.equal(gitMatch.matches[0].status, "found");

  const localMatch = resolveCrateSource({ crateName: "local-one", repo, cargoHome });
  assert.equal(localMatch.matches[0].kind, "path");
  assert.equal(localMatch.matches[0].status, "found");

  const uncachedCli = runCli(["crate-source", "missing-cache", repo, "--cargo-home", cargoHome, "--json"]);
  assert.equal(uncachedCli.status, 1);
  const uncJson = JSON.parse(uncachedCli.stdout);
  assert.equal(uncJson.matches[0].status, "not_cached");

  assert.throws(() => resolveCrateSource({ crateName: "../serde", repo, cargoHome }), /invalid crate name/);
});

test("polyglot-audit: detects indexed languages and warns on unsupported and filtered source extensions", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gg-polyglot-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "tools"), { recursive: true });
  writeFileSync(join(repo, "src/app.ts"), "export function run() { return 1; }\n");
  writeFileSync(join(repo, "tools/helper.py"), "def helper():\n    return 2\n");
  writeFileSync(join(repo, "src/kernel.mojo"), "fn main():\n    pass\n");
  writeFileSync(join(repo, "src/api.proto"), 'syntax = "proto3";\nmessage Ping {}\n');
  // Non-source files must never trigger false-positive warnings
  writeFileSync(join(repo, "README.md"), "# demo\n");
  writeFileSync(join(repo, "config.json"), '{"ok":true}\n');

  const fullBuild = await buildGraph(repo);
  const detectedLangs = fullBuild.polyglotAudit.detected.map((d) => d.language);
  assert.ok(detectedLangs.includes("typescript"));
  assert.ok(detectedLangs.includes("python"));
  const skippedExts = fullBuild.polyglotAudit.skipped.map((s) => s.extension);
  assert.ok(skippedExts.includes(".mojo"));
  assert.ok(skippedExts.includes(".proto"));
  assert.ok(!skippedExts.includes(".md"));
  assert.ok(!skippedExts.includes(".json"));

  // Filtered by -e warns about excluded supported language (.py)
  const extFiltered = await buildGraph(repo, { extensions: [".ts"] });
  const pySkipped = extFiltered.polyglotAudit.skipped.find((s) => s.extension === ".py");
  assert.equal(pySkipped?.reason, "excluded_by_extensions");

  // Filtered by --only warns about supported files outside --only
  const dirFiltered = await buildGraph(repo, { onlyDirs: ["src"] });
  const dirSkipped = dirFiltered.polyglotAudit.skipped.find((s) => s.extension === ".py");
  assert.equal(dirSkipped?.reason, "excluded_by_only_dirs");

  // CLI build prints explicit warning on stderr
  const buildCli = runCli(["build", repo]);
  assert.equal(buildCli.status, 0);
  assert.match(buildCli.stderr, /⚠ unindexed source extensions:.*\.mojo \(Mojo, 1 file: no parser\)/);
  assert.match(buildCli.stderr, /\.proto \(Protocol Buffers, 1 file: no parser\)/);

  // Repo audit helper matches
  const repoAudit = auditPolyglotRepo(repo);
  const formatted = formatPolyglotAuditLines(repoAudit);
  assert.match(formatted.detectedLine ?? "", /typescript \(1\)/);
  assert.match(formatted.warningLine ?? "", /⚠ unindexed source extensions:/);
});

test("review regressions: strict hub limit, sibling graft-prefix audit, crafted lockfile version and uppercase git rev", async () => {
  // 1. Strict --limit rejects trailing junk and decimals
  assert.throws(() => parseHubLimit("15abc"), /--limit must be an integer/);
  assert.throws(() => parseHubLimit("1.5"), /--limit must be an integer/);
  assert.throws(() => parseHubLimit("0"), /--limit must be an integer/);
  assert.throws(() => parseHubLimit("101"), /--limit must be an integer/);
  assert.equal(parseHubLimit(" 12 "), 12);

  // 2. Sibling directory sharing outDir prefix (`graft-tools/`) is NOT skipped by polyglot audit
  const repo = mkdtempSync(join(tmpdir(), "gg-sibling-prefix-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "graft-tools"), { recursive: true });
  writeFileSync(join(repo, "src/index.ts"), "export const x = 1;\n");
  writeFileSync(join(repo, "graft-tools/extra.mojo"), "fn main():\n    pass\n");
  const built = await buildGraph(repo);
  assert.ok(
    built.polyglotAudit.skipped.some((s) => s.extension === ".mojo"),
    "graft-tools/extra.mojo must not be swallowed by graft/ outDir prefix",
  );

  // 3. Crafted Cargo.lock version fails closed, and uppercase git rev matches lowercase checkout dir
  const base = mkdtempSync(join(tmpdir(), "gg-cratesrc-sec-"));
  const ws = join(base, "ws");
  const ch = join(base, "cargo");
  mkdirSync(ws, { recursive: true });
  const gitDir = join(ch, "git/checkouts/upper-1/abcdef1");
  mkdirSync(join(gitDir, "src"), { recursive: true });
  writeFileSync(join(gitDir, "Cargo.toml"), '[package]\nname = "upper-git"\nversion = "0.1.0"\n');
  mkdirSync(join(ch, "registry/src/index-a"), { recursive: true });
  mkdirSync(join(ch, "registry/src/other-index/evil-1.0.0"), { recursive: true });
  writeFileSync(join(ch, "registry/src/other-index/evil-1.0.0/Cargo.toml"), '[package]\nname = "evil"\nversion = "1.0.0"\n');
  writeFileSync(
    join(ws, "Cargo.lock"),
    [
      "version = 4",
      "",
      "[[package]]",
      'name = "upper-git"',
      'version = "0.1.0"',
      'source = "git+https://example.com/upper#ABCDEF1234567890ABCDEF1234567890ABCDEF12"',
      "",
      "[[package]]",
      'name = "evil"',
      'version = "../other-index/evil-1.0.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
    ].join("\n"),
  );
  const upRes = resolveCrateSource({ crateName: "upper-git", repo: ws, cargoHome: ch });
  assert.equal(upRes.matches[0].status, "found");
  assert.throws(
    () => resolveCrateSource({ crateName: "evil", repo: ws, cargoHome: ch }),
    /invalid version/,
  );
});
