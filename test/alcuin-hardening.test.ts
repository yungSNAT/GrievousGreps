/**
 * Regression tests for Alcuin GPT-6 Pro r1 findings across provenance, hubs,
 * crate-source, workspace MCP dispatch, source-files and polyglot audit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { resolveCrateSource } from "../src/graph/crate-source.js";
import { computeHubs } from "../src/graph/hubs.js";
import { auditPolyglotRepo } from "../src/graph/polyglot-audit.js";
import { edgeWalk, resolveSymbol } from "../src/graph/traverse.js";
import { wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";
import type { GraphV1 } from "../src/graph/types.js";
import { writeWorkspace } from "../src/graph/workspace.js";
import { callTool } from "../src/mcp/tools.js";

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status ?? 1 };
}

test("BLOCKER 2 + SHOULD 8: default callers preserves legacy path whilst --provenance upgrades and emits structured unresolvedCalls", async () => {
  const d = mkdtempSync(join(tmpdir(), "gg-alcuin-b2-"));
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src/a.ts"), "export function A() { return 1; }\n");
  await buildGraph(d);

  const g: GraphV1 = {
    meta: { version: 1, nodeCount: 5, edgeCount: 4, languages: ["typescript"] },
    nodes: [
      { id: "src/a.ts", name: "a.ts", kind: "file", path: "src/a.ts", span: "L1-L20", signature: null, exported: false, origin: "ast", body_hash: "f0", chars: 200, summary_state: "pending", summary: null, crux: null },
      { id: "src/a.ts#A", name: "A", kind: "function", path: "src/a.ts", span: "L1-L3", signature: "A()", exported: true, origin: "ast", body_hash: "h1", summary_state: "pending", summary: null, crux: null },
      { id: "src/a.ts#B", name: "B", kind: "function", path: "src/a.ts", span: "L5-L7", signature: "B()", exported: true, origin: "ast", body_hash: "h2", summary_state: "pending", summary: null, crux: null },
      { id: "src/a.ts#C", name: "C", kind: "function", path: "src/a.ts", span: "L9-L11", signature: "C()", exported: true, origin: "ast", body_hash: "h3", summary_state: "pending", summary: null, crux: null },
      { id: "src/a.ts#D", name: "D", kind: "function", path: "src/a.ts", span: "L13-L15", signature: "D()", exported: true, origin: "ast", body_hash: "h4", summary_state: "pending", summary: null, crux: null },
    ],
    edges: [
      { source: "src/a.ts#B", target: "src/a.ts#A", relation: "references", confidence: "extracted" },
      { source: "src/a.ts#C", target: "src/a.ts#A", relation: "calls", confidence: "lsp_resolved" },
      { source: "src/a.ts#D", target: "src/a.ts#B", relation: "references", confidence: "extracted" },
      { source: "src/a.ts#D", target: "src/a.ts#C", relation: "calls", confidence: "lsp_resolved" },
    ],
    unresolvedCalls: [
      { name: "A", source: "src/other.ts#caller", through: "./missing", file: "src/missing.d.ts" },
    ],
  };
  writeFileSync(wiringPath(contextDirFor(d)), JSON.stringify(g));

  const [symA] = resolveSymbol(g, "A");
  const legacyHit = edgeWalk(g, symA, "in", 2).find((h) => h.id === "src/a.ts#D");
  assert.equal(legacyHit?.relation, "references");

  const provHit = edgeWalk(g, symA, "in", 2, { provenance: true }).find((h) => h.id === "src/a.ts#D");
  assert.equal(provHit?.relation, "calls");
  assert.equal(provHit?.confidence, "lsp_resolved");

  const cliProv = runCli(["callers", "A", d, "--depth", "2", "--provenance", "--json", "--no-refresh"]);
  assert.equal(cliProv.status, 0, cliProv.stderr);
  const parsed = JSON.parse(cliProv.stdout);
  assert.equal(parsed.matches[0].unresolvedCalls[0].source, "src/other.ts#caller");
  assert.equal(parsed.matches[0].unresolved, undefined);
});

test("BLOCKER 1 + SHOULD 1-5: crate-source verifies identity, workspace version, ambiguity, escaping src symlink, schemes and budget", () => {
  const base = mkdtempSync(join(tmpdir(), "gg-alcuin-cs-"));
  const repo = join(base, "repo");
  const ch = join(base, "cargo");
  mkdirSync(join(repo, "crates/ws-member/src"), { recursive: true });
  writeFileSync(join(repo, "Cargo.toml"), '[workspace]\nmembers = ["crates/ws-member"]\n[workspace.package]\nversion = "2.3.4"\n');
  writeFileSync(join(repo, "crates/ws-member/Cargo.toml"), '[package]\nname = "ws-member"\nversion.workspace = true\n');

  for (const sub of ["dup-a", "dup-b"]) {
    mkdirSync(join(repo, "crates", sub), { recursive: true });
    writeFileSync(join(repo, "crates", sub, "Cargo.toml"), '[package]\nname = "dup-local"\nversion = "0.1.0"\n');
  }

  const idx1 = join(ch, "registry/src/index.crates.io-111");
  const idx2 = join(ch, "registry/src/index.crates.io-222");
  mkdirSync(join(idx1, "spoofed-1.0.0"), { recursive: true });
  writeFileSync(join(idx1, "spoofed-1.0.0/Cargo.toml"), '[package]\nname = "spoofed"\nversion = "9.9.9"\n');

  for (const idx of [idx1, idx2]) {
    mkdirSync(join(idx, "ambig-1.0.0"), { recursive: true });
    writeFileSync(join(idx, "ambig-1.0.0/Cargo.toml"), '[package]\nname = "ambig"\nversion = "1.0.0"\n');
  }

  // Escaping src symlink inside a valid registry crate must be omitted from srcDir
  const outside = join(base, "outside-src");
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(idx1, "escape-src-1.0.0"), { recursive: true });
  writeFileSync(join(idx1, "escape-src-1.0.0/Cargo.toml"), '[package]\nname = "escape-src"\nversion = "1.0.0"\n');
  symlinkSync(outside, join(idx1, "escape-src-1.0.0/src"), "dir");

  // Unverified git checkout (lacks .git/HEAD and .cargo-vcs-info.json)
  const unv = join(ch, "git/checkouts/unv-123/1234567");
  mkdirSync(unv, { recursive: true });
  writeFileSync(join(unv, "Cargo.toml"), '[package]\nname = "unverified-git"\nversion = "0.1.0"\n');

  writeFileSync(
    join(repo, "Cargo.lock"),
    [
      "version = 4",
      "[[package]] # inline comment",
      'name = "ws-member"',
      'version = "2.3.4"',
      "[[package]]",
      'name = "dup-local"',
      'version = "0.1.0"',
      "[[package]]",
      'name = "spoofed"',
      'version = "1.0.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "[[package]]",
      'name = "ambig"',
      'version = "1.0.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "[[package]]",
      'name = "escape-src"',
      'version = "1.0.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "[[package]]",
      'name = "unverified-git"',
      'version = "0.1.0"',
      'source = "git+https://example.com/unv#1234567890abcdef1234567890abcdef12345678"',
    ].join("\n"),
  );

  assert.equal(resolveCrateSource({ crateName: "ws-member", repo, cargoHome: ch }).matches[0].status, "found");
  assert.equal(resolveCrateSource({ crateName: "dup-local", repo, cargoHome: ch }).matches[0].status, "ambiguous");
  assert.equal(resolveCrateSource({ crateName: "spoofed", repo, cargoHome: ch }).matches[0].status, "not_cached");
  assert.equal(resolveCrateSource({ crateName: "ambig", repo, cargoHome: ch }).matches[0].status, "ambiguous");
  assert.equal(resolveCrateSource({ crateName: "unverified-git", repo, cargoHome: ch }).matches[0].status, "unresolved");

  const esc = resolveCrateSource({ crateName: "escape-src", repo, cargoHome: ch }).matches[0];
  assert.equal(esc.status, "found");
  assert.equal(esc.srcDir, undefined);

  // Malformed source types and unsupported schemes fail closed
  for (const [label, body] of [
    ["non-str", '[[package]]\nname = "a"\nversion = "1.0.0"\nsource = 42\n'],
    ["bad-scheme", '[[package]]\nname = "a"\nversion = "1.0.0"\nsource = "bogus+location"\n'],
  ]) {
    const badDir = join(base, label);
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "Cargo.lock"), body);
    assert.throws(() => resolveCrateSource({ crateName: "a", repo: badDir, cargoHome: ch }));
  }

  // Registry directory budget cap -> budget_exhausted
  const budCh = join(base, "bud-cargo");
  for (let i = 0; i < 66; i++) mkdirSync(join(budCh, `registry/src/idx-${i}`), { recursive: true });
  const bud = resolveCrateSource({ crateName: "spoofed", repo, cargoHome: budCh }).matches[0];
  assert.equal(bud.status, "budget_exhausted");
});

test("SHOULD 7: hubs excludes self-loops from PageRank matching Rust parity", () => {
  const g: GraphV1 = {
    meta: { version: 1, nodeCount: 3, edgeCount: 2, languages: ["typescript"] },
    nodes: [
      { id: "src/r.ts", name: "r.ts", kind: "file", path: "src/r.ts", span: "L1-L10", signature: null, exported: false, origin: "ast", body_hash: "f0", chars: 100, summary_state: "pending", summary: null, crux: null },
      { id: "src/r.ts#A", name: "A", kind: "function", path: "src/r.ts", span: "L1-L5", signature: "A()", exported: true, origin: "ast", body_hash: "h1", summary_state: "pending", summary: null, crux: null },
      { id: "src/r.ts#B", name: "B", kind: "function", path: "src/r.ts", span: "L6-L10", signature: "B()", exported: true, origin: "ast", body_hash: "h2", summary_state: "pending", summary: null, crux: null },
    ],
    edges: [
      { source: "src/r.ts#A", target: "src/r.ts#A", relation: "calls", confidence: "extracted" },
      { source: "src/r.ts#A", target: "src/r.ts#B", relation: "calls", confidence: "extracted" },
    ],
  };
  const report = computeHubs(g);
  assert.equal(report.totals.walkEdges, 1);
  assert.equal(report.hubs[0].name, "A");
  assert.equal(report.hubs[0].pagerank, 1);
  assert.equal(report.hubs[1].name, "B");
  assert.equal(report.hubs[1].pagerank, 1);
  assert.equal(report.hubs[0].inDegree, 1);
  assert.equal(report.hubs[0].outDegree, 2);
});

test("SHOULD 6: workspace MCP rejects provenance:true and mode:hubs explicitly", async () => {
  const ws = mkdtempSync(join(tmpdir(), "gg-alcuin-ws-"));
  for (const child of ["api", "web"]) {
    const dir = join(ws, child);
    mkdirSync(join(dir, ".git"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/index.ts"), `export function ${child}Fn() { return 1; }\n`);
    await buildGraph(dir);
  }
  writeWorkspace(ws, { version: 1, children: ["api", "web"] });

  const provRes = await callTool(ws, "graft_trace_calls", { symbol: "apiFn", provenance: true });
  assert.equal(provRes.isError, true);
  assert.match(provRes.text, /not supported on a workspace parent/);

  const hubsRes = await callTool(ws, "graft_repo_map", { mode: "hubs" });
  assert.equal(hubsRes.isError, true);
  assert.match(hubsRes.text, /not supported on a workspace parent/);

  const normalMap = await callTool(ws, "graft_repo_map", {});
  assert.equal(normalMap.isError, false, normalMap.text);
});

test("SHOULD 9 + SHOULD 10: sibling graft-tools/*.ts is indexed and existing-graph audit flags unindexed supported files", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gg-alcuin-poly-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "graft-tools"), { recursive: true });
  writeFileSync(join(repo, "src/app.ts"), "export function app() { return 1; }\n");
  writeFileSync(join(repo, "graft-tools/helper.ts"), "export function helper() { return 2; }\n");
  writeFileSync(join(repo, "src/extra.py"), "def extra():\n    return 3\n");

  const full = await buildGraph(repo);
  assert.equal(full.files, 3, "graft-tools/helper.ts must be indexed despite sharing graft prefix");

  // Existing-graph audit with only src/app.ts indexed reports extra.py as unindexed_supported
  const audit = auditPolyglotRepo(repo, undefined, { indexedFiles: [join(repo, "src/app.ts")] });
  const py = audit.skipped.find((s) => s.extension === ".py");
  assert.equal(py?.reason, "unindexed_supported");
});
