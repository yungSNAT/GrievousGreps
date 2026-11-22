import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { enrichWithLsp } from "../src/graph/lsp/enrich.js";
import { LspClient } from "../src/graph/lsp/client.js";
import type { EdgeV1, GraphV1, NodeV1 } from "../src/graph/types.js";
import { tmpRepo } from "./helpers.js";

function node(path: string, name: string, kind: NodeV1["kind"], span: string): NodeV1 {
  return {
    id: `${path}:${name}`, path, name, kind, span,
    signature: null, exported: true, origin: "ast", body_hash: "x",
    summary_state: "pending", summary: null, crux: null,
  };
}

function graph(nodes: NodeV1[], edges: EdgeV1[] = []): GraphV1 {
  return {
    meta: {
      version: 1, nodeCount: nodes.length, edgeCount: edges.length,
      languages: [], scopes: [],
    },
    nodes,
    edges,
  };
}

function hierarchyItem(abs: string, name: string, line: number, selectedLine = line) {
  return {
    uri: pathToFileURL(abs).href,
    name,
    kind: 12 as const,
    range: {
      start: { line, character: 0 },
      end: { line: selectedLine, character: 40 },
    },
    selectionRange: {
      start: { line: selectedLine, character: 0 },
      end: { line: selectedLine, character: name.length },
    },
  };
}

function assertTypeScriptAttempt(servers: string[]) {
  assert.equal(servers.length, 1);
  assert.match(basename(servers[0]), /^typescript-language-server(?:\.exe)?$/i);
}

describe("enrichWithLsp with an offline language server", () => {
  let top: string;
  let repo: string;
  let checkout: string;
  const streams: PassThrough[] = [];
  let spawns = 0;
  const savedPath = process.env.PATH;
  const savedPathExt = process.env.PATHEXT;

  before(() => {
    top = tmpRepo("lsp-enrich-gaps");
    repo = join(top, "repo");
    checkout = join(top, "linked-checkout");
    const bin = join(top, "bin");
    mkdirSync(repo);
    mkdirSync(bin);
    symlinkSync(repo, checkout, process.platform === "win32" ? "junction" : "dir");

    // Exercise real registry selection, but never execute the discovered file.
    const executable = process.platform === "win32"
      ? "typescript-language-server.exe"
      : "typescript-language-server";
    writeFileSync(join(bin, executable), "test fixture\n", { mode: 0o755 });
    process.env.PATH = bin;
    if (process.platform === "win32") process.env.PATHEXT = ".EXE;.CMD";

    mock.method(childProcess, "spawn", () => {
      spawns++;
      const child = new ChildProcess();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      streams.push(stdin, stdout, stderr);
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.stdio = [stdin, stdout, stderr, null, null];
      return child;
    });
    syncBuiltinESMExports();
  });

  after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = savedPathExt;
    for (const stream of streams) stream.destroy();
    if (top) rmSync(top, { recursive: true, force: true });
  });

  test("does not launch a server for an unrecognized file or a declaration-only graph", async () => {
    const beforeSpawns = spawns;
    const unsupported = graph([node("notes.unknown-extension", "notes", "file", "L1-L1")]);
    const declarations = graph([
      node("api.ts", "api.ts", "file", "L1-L2"),
      node("api.ts", "Service", "interface", "L1-L2"),
    ]);
    const idle = { added: 0, queried: 0, servers: [], notices: [] };

    assert.deepEqual(await enrichWithLsp(unsupported, repo), idle);
    assert.deepEqual(await enrichWithLsp(declarations, repo), idle);
    assert.deepEqual(unsupported.edges, []);
    assert.deepEqual(declarations.edges, []);
    assert.equal(spawns, beforeSpawns);
  });

  test("resolves calls to the innermost definition under a linked checkout", async (t) => {
    const callerPath = "caller.ts";
    const targetPath = "service # types.ts";
    const callerAbs = join(realpathSync(repo), callerPath);
    const targetAbs = join(realpathSync(repo), targetPath);
    writeFileSync(callerAbs, [
      "// éport $port portExtra",
      "export function port() {",
      "  return new Service().call();",
      "}",
      "export function malformed() {}",
      "export function nothing() {}",
    ].join("\n"));
    writeFileSync(targetAbs, [
      "export class Service {",
      "  // Implementation",
      "  call() { return 42; }",
      "}",
      "",
      "export class Fallback {}",
      "export class AlreadyCalled {}",
    ].join("\n"));

    const port = node(callerPath, "port", "function", "L1-L4");
    const outer = node(targetPath, "Service", "class", "L1-L4");
    const inner = node(targetPath, "call", "method", "L3-L3");
    const fallback = node(targetPath, "Fallback", "class", "L6-L6");
    const already = node(targetPath, "AlreadyCalled", "class", "L7-L7");
    const oldEdge: EdgeV1 = {
      source: port.id, target: already.id, relation: "calls", confidence: "lsp_resolved",
    };
    const g = graph([
      node(callerPath, callerPath, "file", "L1-L6"),
      node("tools.lua", "tools.lua", "file", "L1-L1"),
      node("build.zig", "build.zig", "file", "L1-L1"),
      node(callerPath, "malformed", "function", "L5"),
      node("removed.ts", "missing", "function", "L1-L1"),
      port,
      node(callerPath, "nothing", "function", "L6-L6"),
      outer,
      inner,
      fallback,
      already,
    ], [oldEdge]);

    const portItem = hierarchyItem(callerAbs, "port", 1);
    const call = hierarchyItem(targetAbs, "call", 0, 2);
    // Some server responses omit selectionRange; the enclosing range still locates this target.
    const { selectionRange: _selectionRange, ...rangeOnly } =
      hierarchyItem(targetAbs, "Fallback", 5);

    t.mock.method(LspClient.prototype, "initialize", async () => true);
    t.mock.method(LspClient.prototype, "didOpen", () => {});
    const ready = t.mock.method(LspClient.prototype, "waitUntilReady", async () => true);
    const prepare = t.mock.method(
      LspClient.prototype, "prepareCallHierarchy",
      (_abs: string, pos: { line: number; character: number }) =>
        Promise.resolve(pos.line === 1 ? [portItem] : []),
    );
    const outgoing = t.mock.method(LspClient.prototype, "outgoingCalls", async () => [
      { ...call, uri: "untitled:scratch" },
      hierarchyItem(join(top, "repo-neighbor", targetPath), "call", 2),
      hierarchyItem(targetAbs, "unindexed", 4),
      portItem,
      hierarchyItem(targetAbs, "AlreadyCalled", 6),
      call,
      call,
      rangeOnly,
    ]);
    const dispose = t.mock.method(LspClient.prototype, "dispose", async () => {});

    const progress: Array<[number, number]> = [];
    const result = await enrichWithLsp(g, checkout, {
      maxNodes: 4,
      onProgress: (done, total) => progress.push([done, total]),
    });

    assertTypeScriptAttempt(result.servers);
    assert.deepEqual(result.notices, []);
    assert.equal(result.queried, 1, "an empty prepare response is not a completed query");
    assert.equal(result.added, 2);
    assert.deepEqual(progress, [[1, 4]]);
    assert.deepEqual(g.edges, [
      oldEdge,
      { source: port.id, target: inner.id, relation: "calls", confidence: "lsp_resolved" },
      { source: port.id, target: fallback.id, relation: "calls", confidence: "lsp_resolved" },
    ]);

    const portPos = { line: 1, character: "export function ".length };
    assert.deepEqual(ready.mock.calls.map((c) => c.arguments), [[callerAbs, portPos]]);
    assert.deepEqual(prepare.mock.calls.map((c) => c.arguments), [
      [callerAbs, portPos],
      [callerAbs, { line: 5, character: "export function ".length }],
    ]);
    assert.deepEqual(outgoing.mock.calls.map((c) => c.arguments), [[portItem]]);
    assert.equal(dispose.mock.callCount(), 1);
  });

  test("reports a failed startup and disposes the client when the checkout has disappeared", async (t) => {
    const g = graph([node("caller.ts", "port", "function", "L1-L1")]);
    const initialize = t.mock.method(LspClient.prototype, "initialize", async () => false);
    const didOpen = t.mock.method(LspClient.prototype, "didOpen", () => {});
    const dispose = t.mock.method(LspClient.prototype, "dispose", async () => {});
    const beforeSpawns = spawns;

    const result = await enrichWithLsp(g, join(top, "removed-checkout"));

    assertTypeScriptAttempt(result.servers);
    assert.deepEqual(result.notices, []);
    assert.equal(result.added, 0);
    assert.equal(result.queried, 0);
    assert.deepEqual(g.edges, []);
    assert.equal(spawns, beforeSpawns + 1);
    assert.equal(initialize.mock.callCount(), 1);
    assert.equal(didOpen.mock.callCount(), 0);
    assert.equal(dispose.mock.callCount(), 1);
  });
});
