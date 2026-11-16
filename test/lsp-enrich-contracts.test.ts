/**
 * `graft build --lsp` against a scripted language server: which position each
 * definition is queried at, and which callees become `lsp_resolved` edges.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildGraph } from "../src/graph/build.js";
import type { GraphV1 } from "../src/graph/types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "graft lsp enrichment "));
  const log = join(dir, "server.json");
  t.after(async () => {
    if (existsSync(log)) {
      const { pid } = JSON.parse(readFileSync(log, "utf8"));
      const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const deadline = Date.now() + 14000;
      while (alive() && Date.now() < deadline) await sleep(20);
      assert.equal(alive(), false, "the owned language server has exited");
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 25 });
  });
  const root = join(dir, "repo");
  const bin = join(dir, "bin");
  mkdirSync(root);
  mkdirSync(bin);
  const source = [
    "export function warmup() {}",
    "/* éport $port portExtra */ export function port(receiver: any) { receiver.handle(); }",
    "export function $port() {}",
    "/* 🦀 */ export function café() {}",
    "export class Receiver {",
    "  handle() {}",
    "}",
  ];
  const sourcePath = join(root, "source.ts");
  writeFileSync(sourcePath, source.join("\n") + "\n");
  const built = await buildGraph(root, { graphOnly: true });
  assert.equal(built.failed, 0);
  const graph: GraphV1 = JSON.parse(readFileSync(built.graphPath, "utf8"));
  const node = (name: string) => {
    const found = graph.nodes.find((n) => n.name === name && (n.kind === "function" || n.kind === "method"));
    assert.ok(found, `real graph contains ${name}`);
    return found;
  };
  // Warm indexing on an unambiguous declaration, so a later bad position fails
  // promptly instead of waiting for the readiness timeout.
  const warm = node("warmup");
  graph.nodes = [warm, ...graph.nodes.filter((n) => n !== warm)];
  const positions = ["warmup", "port", "$port", "café", "handle"].map((name) => {
    const line = source.findIndex((text) => text.includes(name === "handle" ? "  handle()" : `function ${name}(`));
    const character = source[line].indexOf(name === "handle" ? "handle()" : `function ${name}(`) + (name === "handle" ? 0 : "function ".length);
    return { name, line, character };
  });
  const server = join(bin, "server.cjs");
  const rpc = fileURLToPath(import.meta.resolve("vscode-jsonrpc/node.js"));
  const uri = pathToFileURL(sourcePath).href;
  const outsideUri = pathToFileURL(join(root + "-outside", "source.ts")).href;
  // The server answers call hierarchy only at a declaration's exact name position.
  const run = () => {
    writeFileSync(server, `
      const fs = require("node:fs");
      const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require(${JSON.stringify(rpc)});
      const state = { pid: process.pid, opens: [], probes: [], outgoing: [] };
      const save = () => fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(state));
      save();
      setTimeout(() => process.exit(89), 12000);
      const positions = ${JSON.stringify(positions)};
      const item = (p) => ({ name: p.name, kind: 12, uri: ${JSON.stringify(uri)},
        range: { start: { line: p.name === "handle" ? 4 : p.line, character: 0 }, end: { line: p.line, character: 60 } },
        selectionRange: { start: { line: p.line, character: p.character }, end: { line: p.line, character: p.character + p.name.length } } });
      const conn = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
      conn.onRequest("initialize", () => ({ capabilities: { callHierarchyProvider: true } }));
      conn.onNotification("textDocument/didOpen", p => { state.opens.push(p.textDocument.uri); save(); });
      conn.onRequest("textDocument/prepareCallHierarchy", p => {
        state.probes.push(p); save();
        const found = positions.find(q => q.line === p.position.line && q.character === p.position.character);
        return found ? [item(found)] : [];
      });
      conn.onRequest("callHierarchy/outgoingCalls", p => {
        state.outgoing.push(p.item.name); save();
        const target = item(positions.find(q => q.name === "handle"));
        if (!["warmup", "port"].includes(p.item.name)) return [];
        return [target, target, p.item, { ...target, uri: ${JSON.stringify(outsideUri)} },
          { ...target, uri: "PUBLIC invalid URI" },
          { ...target, selectionRange: { start: { line: 99, character: 0 }, end: { line: 99, character: 1 } } }].map(to => ({ to }));
      });
      conn.listen();
    `);
    const command = join(bin, process.platform === "win32" ? "typescript-language-server.cmd" : "typescript-language-server");
    if (process.platform === "win32") {
      // npmShimEntry recognises npm's entry reference and runs Node directly.
      writeFileSync(command, '@echo off\r\n"%_prog%" "%dp0%\\server.cjs" %*\r\n');
    } else {
      writeFileSync(command, `#!${process.execPath}\nrequire(${JSON.stringify(server)});\n`, { mode: 0o700 });
    }
    const runner = join(dir, "run.mts");
    const result = join(dir, "result.json");
    writeFileSync(runner, `
      import { writeFileSync } from "node:fs";
      import { enrichWithLsp } from ${JSON.stringify(new URL("../src/graph/lsp/enrich.ts", import.meta.url).href)};
      const deadline = setTimeout(() => process.exit(88), 18000);
      const graph = ${JSON.stringify(graph)};
      const progress = [];
      const stats = await enrichWithLsp(graph, ${JSON.stringify(root)}, { onProgress: (done, total) => progress.push([done, total]) });
      writeFileSync(${JSON.stringify(result)}, JSON.stringify({ graph, stats, progress }));
      clearTimeout(deadline);
    `);
    // A fresh process gives each private PATH a fresh registry resolution cache.
    const child = spawnSync(process.execPath, ["--import", "tsx", runner], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, PATH: bin }, encoding: "utf8", timeout: 22000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr + child.stdout);
    return { ...JSON.parse(readFileSync(result, "utf8")), state: JSON.parse(readFileSync(log, "utf8")) };
  };
  return { graph, node, positions, run, uri };
}

test("LSP enrichment queries whole symbol names and maps selection ranges to the innermost definition", { timeout: 45000 }, async (t) => {
  const { graph, node, positions, run, uri } = await fixture(t);
  const warm = node("warmup"), port = node("port"), target = node("handle");
  assert.equal(graph.edges.some(e => e.source === port.id && e.target === target.id && e.relation === "calls"), false, "the dynamic receiver needs language server resolution");
  graph.edges.push({ source: warm.id, target: target.id, relation: "calls", confidence: "inferred" });
  const before = structuredClone(graph.edges);
  const result = run();
  assert.deepEqual(result.state.probes.filter((p: { position: { line: number } }) => p.position.line === 1).map((p: { position: unknown }) => p.position), [positions.find(p => p.name === "port")!].map(({ line, character }) => ({ line, character })), "port is queried on its declaration, never inside another identifier");
  assert.deepEqual(result.graph.edges, [...before, { source: port.id, target: target.id, relation: "calls", confidence: "lsp_resolved" }]);
  assert.equal(result.stats.added, 1);
  assert.equal(result.stats.queried, positions.length);
  assert.deepEqual(result.progress, positions.map((_, i) => [i + 1, positions.length]));
  assert.deepEqual(result.state.opens, [uri]);
  assert.deepEqual(new Set(result.state.outgoing), new Set(positions.map(p => p.name)));
});
