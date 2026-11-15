/**
 * A Vue, Svelte or Astro file's script block is TypeScript, so its definitions belong to the
 * TypeScript family: a Python call never resolves into one, and a TypeScript call still does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";

test("a component's script functions are TypeScript to the resolver", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-container-family-"));
  writeFileSync(join(dir, "Widget.svelte"), "<script lang=\"ts\">\n  export function formatLabel(x: string) { return x; }\n</script>\n<p>hi</p>\n");
  writeFileSync(join(dir, "Card.vue"), "<script lang=\"ts\">\nexport function cardTitle(x: string) { return x; }\n</script>\n<template><p>hi</p></template>\n");
  writeFileSync(join(dir, "jobs.py"), "def run():\n    formatLabel('a')\n    cardTitle('b')\n");
  writeFileSync(join(dir, "main.ts"), "export function go() {\n  formatLabel('a');\n  cardTitle('b');\n}\n");
  await buildGraph(dir);
  const graph = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "wiring graph should be written");
  const calls = (source: string) => graph!.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target).sort();
  assert.deepEqual(calls("jobs.py#run"), [], "Python does not reach a component's functions");
  assert.deepEqual(calls("main.ts#go"), ["Card.vue#cardTitle", "Widget.svelte#formatLabel"], "TypeScript does");
});
