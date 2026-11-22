import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveStats } from "../src/claude/statusline.js";
import { emptyStats } from "../src/claude/state.js";
import { tmpRepo, runCli } from "./helpers.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function findFile(dir: string, name: string, depth = 0): string | null {
  if (depth > 5) return null;
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return null; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".git") continue;
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isFile() && e === name) return p;
    if (st.isDirectory()) {
      const found = findFile(p, name, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function writeSources(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "math.ts"),
    "export function add(a: number, b: number): number { return a + b; }\n" +
      "export function twice(a: number): number { return add(a, a); }\n",
  );
  writeFileSync(
    join(dir, "src", "main.ts"),
    "import { twice } from './math.js';\nexport function run(): number { return twice(2); }\n",
  );
}

function build(dir: string): void {
  let r = runCli(["build", "--dir", dir], { timeoutMs: 120000 });
  if (r.status !== 0) r = runCli(["build", dir], { timeoutMs: 120000 });
  assert.equal(r.status, 0, `build failed: ${r.stderr}`);
}

/** Every plausible location of the hook-maintained stats cache (graft/.cache/stats.json). */
function cacheCandidates(dir: string, wiringPath: string): string[] {
  const rel = relative(dir, wiringPath);
  const top = rel.split(sep)[0];
  const set = new Set<string>([
    join(dir, top, ".cache", "stats.json"),
    join(wiringPath, "..", ".cache", "stats.json"),
    join(dir, "graft", ".cache", "stats.json"),
  ]);
  return [...set];
}

function writeCache(paths: string[], nodeCount: number): void {
  for (const p of paths) {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify({ ...emptyStats(), nodeCount }));
  }
}

function removeCache(paths: string[]): void {
  for (const p of paths) rmSync(p, { force: true });
}

function runMain(input: unknown, env: NodeJS.ProcessEnv = {}) {
  const modUrl = pathToFileURL(join(repoRoot, "src", "claude", "statusline.ts")).href;
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  if (!("CLAUDE_PROJECT_DIR" in env)) delete childEnv.CLAUDE_PROJECT_DIR;
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", `const m = await import(${JSON.stringify(modUrl)}); m.main();`],
    { cwd: repoRoot, input: JSON.stringify(input), encoding: "utf8", env: childEnv, timeout: 60000 },
  );
}

describe("resolveStats", () => {
  const dirs: string[] = [];

  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("returns null for a fresh folder with no stats cache and no wiring graph", () => {
    const dir = tmpRepo("statusline-fresh");
    dirs.push(dir);
    assert.equal(resolveStats(dir), null);
    assert.deepEqual(readdirSync(dir), []);
  });

  describe("with a built graph", () => {
    let dir: string;
    let wiringPath: string;
    let graphNodes = 0;

    before(() => {
      dir = tmpRepo("statusline-built");
      dirs.push(dir);
      writeSources(dir);
      build(dir);
      const found = findFile(dir, "wiring.json");
      assert.ok(found, "build should produce wiring.json");
      wiringPath = found!;
    });

    test("falls back to the wiring graph when no cache exists", () => {
      const stats = resolveStats(dir);
      assert.ok(stats, "expected stats from the wiring graph");
      assert.ok(stats!.nodeCount > 0, `expected nodes, got ${stats!.nodeCount}`);
      graphNodes = stats!.nodeCount;
      for (const key of Object.keys(emptyStats())) {
        assert.ok(key in stats!, `missing stats key ${key}`);
      }
    });

    test("prefers the hook-maintained cache when it has nodes", () => {
      const paths = cacheCandidates(dir, wiringPath);
      writeCache(paths, 987);
      try {
        const stats = resolveStats(dir);
        assert.ok(stats);
        assert.equal(stats!.nodeCount, 987);
      } finally {
        removeCache(paths);
      }
    });

    test("ignores an empty cache and reads the graph instead", () => {
      const paths = cacheCandidates(dir, wiringPath);
      writeCache(paths, 0);
      try {
        const stats = resolveStats(dir);
        assert.ok(stats);
        assert.ok(stats!.nodeCount > 0);
        if (graphNodes > 0) assert.equal(stats!.nodeCount, graphNodes);
      } finally {
        removeCache(paths);
      }
    });
  });
});

describe("main", () => {
  let dir: string;

  before(() => {
    dir = tmpRepo("statusline-main");
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("renders a statusline for the cwd given on stdin", () => {
    const r = runMain({ cwd: dir, session_id: "s1", context_window: { used_percentage: 42.4 } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.length > 0, "statusline output should not be empty");
  });

  test("renders a subagent line when an agent name is given", () => {
    const r = runMain({ cwd: dir, agent: { name: "explorer-agent" } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("explorer-agent"), `got: ${r.stdout}`);
  });

  test("uses CLAUDE_PROJECT_DIR when set", () => {
    const r = runMain({}, { CLAUDE_PROJECT_DIR: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.length > 0);
  });
});
