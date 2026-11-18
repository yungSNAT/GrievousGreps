/**
 * LSP enrichment tier: registry selection + graceful degradation. These run
 * without any language server installed — they assert the OPT-IN promise that
 * `graft build --lsp` is a safe no-op when no server applies (never a crash,
 * never a mutated graph), which is the contract the build relies on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickServers, LSP_SERVERS } from "../src/graph/lsp/registry.js";
import { enrichWithLsp } from "../src/graph/lsp/enrich.js";
import type { GraphV1 } from "../src/graph/types.js";

test("pickServers: no languages present → no servers", () => {
  assert.deepEqual(pickServers(new Set(), process.cwd()).servers, []);
});

test("pickServers: languages no registered server covers → no servers", () => {
  assert.deepEqual(pickServers(new Set(["cobol", "fortran"]), process.cwd()).servers, []);
});

test("registry rows are well-formed (languages, command, languageId)", () => {
  for (const s of LSP_SERVERS) {
    assert.ok(s.languages.length > 0 && s.command && s.languageId, `${s.command} row shape`);
    assert.ok(Array.isArray(s.args), `${s.command} args is an array`);
  }
});

test("enrichWithLsp is a no-op when no server matches the repo's languages", async () => {
  // A graph whose only file is an unsupported language → no server is picked →
  // no process spawned, graph returned unchanged.
  const graph: GraphV1 = {
    meta: { version: 1, nodeCount: 1, edgeCount: 0, languages: ["text"], scopes: [] },
    nodes: [
      { id: "notes.txt", name: "notes.txt", kind: "file", path: "notes.txt", span: "L1-L1",
        signature: null, exported: true, origin: "ast", body_hash: "x", summary_state: "pending", summary: null, crux: null },
    ],
    edges: [],
  };
  const before = graph.edges.length;
  const r = await enrichWithLsp(graph, "/tmp/does-not-matter");
  assert.deepEqual(r.servers, [], "no server selected for an unsupported language");
  assert.equal(r.added, 0);
  assert.equal(graph.edges.length, before, "graph edges untouched");
});

test("--lsp names a server it will not start: one only in a node_modules/.bin or inside the checkout", async (t) => {
  const top = realpathSync.native(mkdtempSync(join(tmpdir(), "lsp-skipped-")));
  const was = process.env.PATH;
  t.after(() => { process.env.PATH = was; rmSync(top, { recursive: true, force: true }); });
  const graph = (): GraphV1 => ({
    meta: { version: 1, nodeCount: 1, edgeCount: 0, languages: ["typescript"], scopes: [] },
    nodes: [
      { id: "a.ts", name: "a.ts", kind: "file", path: "a.ts", span: "L1-L1",
        signature: null, exported: true, origin: "ast", body_hash: "x", summary_state: "pending", summary: null, crux: null },
    ],
    edges: [],
  });
  const server = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, process.platform === "win32" ? "typescript-language-server.cmd" : "typescript-language-server");
    writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
    return file;
  };
  const repo = join(top, "repo");
  for (const dir of [join(repo, "node_modules", ".bin"), join(top, "node_modules", ".bin"), join(repo, "tools")]) {
    const file = server(dir);
    process.env.PATH = dir;
    const r = await enrichWithLsp(graph(), repo);
    assert.deepEqual(r.servers, [], `not started from ${dir}`);
    assert.equal(r.notices.length, 1, `one notice for ${dir}`);
    const [notice] = r.notices;
    assert.ok(notice.includes("typescript-language-server") && notice.includes(file), notice);
    assert.match(notice, /does not start programs from/);
    assert.match(notice, /install it globally, or anywhere outside the checkout and outside node_modules\/\.bin/i);
    rmSync(dir, { recursive: true, force: true });
  }
});
