/**
 * The extraction cache is read from the repository's output folder, which a clone
 * can ship. A cached parse replays only when it speaks for its own file: a node
 * that names another path, or a malformed entry, is re-parsed instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { extractCachePath } from "../src/graph/extract-cache.js";
import type { GraphV1 } from "../src/graph/types.js";

const FILES: Record<string, string> = {
  "src/math.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  "src/app.ts": 'import { add } from "./math.js";\nexport function main(): number {\n  return add(1, 2);\n}\n',
  "py/tool.py": "def helper():\n    return 1\n\ndef run():\n    return helper()\n",
  "rs/lib.rs": "pub fn one() -> u8 { 1 }\npub fn two() -> u8 { one() + one() }\n",
  "go/main.go": "package main\n\nfunc helper() int { return 1 }\n\nfunc main() { helper() }\n",
  "php/Widget.php": "<?php\nnamespace App;\nuse App\\{Base, function helper};\nclass Widget extends Base {\n  public function run() { return helper(); }\n}\n",
  "web/Card.vue": '<script setup lang="ts">\nfunction shown(): boolean {\n  return true;\n}\n</script>\n<template><p v-if="shown()">x</p></template>\n',
};

function repo(t: { after: (fn: () => void) => void }): string {
  const d = mkdtempSync(join(tmpdir(), "graft-cache-trust-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(join(d, rel, ".."), { recursive: true });
    writeFileSync(join(d, rel), text);
  }
  return d;
}

const cacheOf = (d: string): string => extractCachePath(join(d, "graft"))!;
const graphOf = (path: string): GraphV1 => JSON.parse(readFileSync(path, "utf8"));

test("every language's own parse replays: each cached node names the file it came from", async (t) => {
  const d = repo(t);
  const cold = await buildGraph(d);
  assert.equal(cold.failed, 0, cold.errors.join("\n"));
  const warm = await buildGraph(d);
  assert.equal(warm.parsed, 0, "nothing changed, so nothing is re-parsed");
  assert.equal(warm.reused, Object.keys(FILES).length);
});

test("a planted cache entry whose node points outside its file is re-parsed, not replayed", async (t) => {
  const d = repo(t);
  await buildGraph(d);
  const path = cacheOf(d);
  const cache = JSON.parse(readFileSync(path, "utf8"));
  const entry = cache.files["src/math.ts"];
  const fn = entry.nodes.find((n: { kind: string }) => n.kind === "function");
  // The bytes still hash to the cached value: only the node's path is forged.
  entry.nodes.push({ ...fn, id: "../outside/secret.ts#add", path: "../outside/secret.ts" });
  writeFileSync(path, JSON.stringify(cache));

  const built = await buildGraph(d);
  assert.equal(built.parsed, 1, "the forged file is parsed again");
  assert.equal(built.reused, Object.keys(FILES).length - 1, "every honest entry still replays");
  const graph = graphOf(built.graphPath);
  assert.deepEqual(graph.nodes.filter((n) => !(n.path in FILES)), [], "no node names a path the walk did not list");
});

/** Plants one extra node in a file's cache entry, rebuilds and checks that only that file is parsed again. */
async function plantedNodeIsReparsed(t: { after: (fn: () => void) => void }, file: string, forge: (d: string, node: Record<string, unknown>) => Record<string, unknown>) {
  const d = repo(t);
  await buildGraph(d);
  const path = cacheOf(d);
  const cache = JSON.parse(readFileSync(path, "utf8"));
  const entry = cache.files[file];
  entry.nodes.push(forge(d, { ...entry.nodes[0] }));
  writeFileSync(path, JSON.stringify(cache));

  const built = await buildGraph(d);
  assert.equal(built.failed, 0, built.errors.join("\n"));
  assert.equal(built.parsed, 1, "the forged file is parsed again");
  assert.equal(built.reused, Object.keys(FILES).length - 1, "every honest entry still replays");
  const graph = graphOf(built.graphPath);
  assert.deepEqual(graph.nodes.filter((n) => !(n.path in FILES)), [], "no node names a path the walk did not list");
}

test("a planted node naming its own file by absolute path is re-parsed", async (t) => {
  await plantedNodeIsReparsed(t, "src/math.ts", (d, node) => ({ ...node, id: `${join(d, "src", "math.ts")}#add`, path: join(d, "src", "math.ts") }));
});

test("a planted node with no path is re-parsed, not thrown on", async (t) => {
  await plantedNodeIsReparsed(t, "py/tool.py", (_d, node) => {
    delete node.path;
    return node;
  });
});

test("malformed entries and a __proto__ key are dropped, not replayed or thrown on", async (t) => {
  const d = repo(t);
  await buildGraph(d);
  const path = cacheOf(d);
  const cache = JSON.parse(readFileSync(path, "utf8"));
  const forged = { ...cache.files["src/math.ts"], nodes: [{ ...cache.files["src/math.ts"].nodes[0], path: "/etc/passwd" }] };
  cache.files["src/app.ts"] = { ...cache.files["src/app.ts"], nodes: {} };
  cache.files["py/tool.py"] = { ...cache.files["py/tool.py"], rawEdges: null };
  cache.files["rs/lib.rs"] = null;
  delete cache.files["src/math.ts"];
  // Written as raw JSON, so `__proto__` is an ordinary key holding a forged entry.
  const proto = `"__proto__":{"src/math.ts":${JSON.stringify(forged)}},`;
  writeFileSync(path, JSON.stringify(cache).replace('"files":{', `"files":{${proto}`));

  const built = await buildGraph(d);
  assert.equal(built.failed, 0, built.errors.join("\n"));
  assert.equal(built.parsed, 4, "the 4 unusable entries are parsed again");
  assert.equal(built.reused, Object.keys(FILES).length - 4);
  const graph = graphOf(built.graphPath);
  assert.deepEqual(graph.nodes.filter((n) => !(n.path in FILES)), []);
});
