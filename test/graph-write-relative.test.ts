/**
 * A relative `outDir` names a directory under the working directory, as an absolute
 * one names itself: `writeGraph` used to resolve it against its own `dirname`, so
 * `sub/nested/graft` wrote `sub/nested/sub/nested/graft/.graph/wiring.json`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { readGraph, wiringPath, writeGraph } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

const graph = { meta: { version: 1 }, nodes: [], edges: [] } as unknown as GraphV1;

function inTempCwd(body: (cwd: string) => void): void {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gg-write-rel-")));
  const here = process.cwd();
  try {
    process.chdir(cwd);
    body(cwd);
  } finally {
    process.chdir(here);
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("a nested relative outDir writes under the working directory, not under its own dirname", () => {
  inTempCwd((cwd) => {
    const out = join("sub", "nested", "graft");
    writeGraph(graph, out);
    assert.ok(existsSync(join(cwd, "sub", "nested", "graft", ".graph", "wiring.json")));
    assert.ok(!existsSync(join(cwd, "sub", "nested", "sub")));
    assert.deepEqual(readGraph(wiringPath(out), dirname(out)), graph);
  });
});

test("a relative outDir ending in .. is refused, as its absolute form is", () => {
  inTempCwd((cwd) => {
    mkdirSync(join(cwd, "graft"));
    assert.throws(() => writeGraph(graph, "graft/.."), /outside/);
    assert.throws(() => writeGraph(graph, `${cwd}/graft/..`), /outside/);
    assert.ok(!existsSync(join(cwd, ".graph")));
  });
});
