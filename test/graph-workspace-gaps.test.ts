import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { contextDirFor } from "../src/context/node-file.js";
import { wiringPath } from "../src/graph/write.js";
import {
  clearParentGraft,
  coverageNote,
  federateAsk,
  federateCallers,
  federateCheck,
  federateGrep,
  federateMap,
  federateMapJson,
  hasMegaGraph,
  isWorkspaceBuildRoot,
  loadWorkspaceGraphs,
  migrationNote,
  readWorkspace,
  splitWorkspace,
  workspacePath,
  workspaceRepos,
  writeWorkspace,
} from "../src/graph/workspace.js";
import { tmpRepo } from "./helpers.js";

void mock;

const cleanup: string[] = [];
let savedGraftDir: string | undefined;
let ws = "";

function gitChild(parent: string, name: string, files: Record<string, string>): string {
  const dir = join(parent, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

function scratch(tag: string): string {
  const dir = tmpRepo(tag);
  cleanup.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "ignore" });
}

function writeRawWorkspace(root: string, text: string): void {
  const path = workspacePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

before(async () => {
  savedGraftDir = process.env.GRAFT_DIR;
  delete process.env.GRAFT_DIR;
  ws = scratch("ws-gaps");
  gitChild(ws, "alpha", {
    "src/util.ts": "export function helperAlpha() { return 1; }\n",
    "src/main.ts": 'import { helperAlpha } from "./util";\nexport function runAlpha() { return helperAlpha(); }\n',
  });
  gitChild(ws, "beta", {
    "lib.ts": 'export function betaWidget() { return "token"; }\n',
  });
  gitChild(ws, "gamma", { "g.ts": "export const gammaValue = 3;\n" });
  await buildGraph(join(ws, "alpha"));
  await buildGraph(join(ws, "beta"));
});

after(() => {
  if (savedGraftDir === undefined) delete process.env.GRAFT_DIR;
  else process.env.GRAFT_DIR = savedGraftDir;
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

describe("workspace index format", () => {
  test("migrationNote names every child's graft folder", () => {
    const note = migrationNote(["repoA", "repoB"]);
    assert.match(note, /contains 2 separate git repos/);
    assert.ok(note.includes("repoA/graft/, repoB/graft/"));
    assert.match(note, /replaced by a workspace index/);
  });

  test("coverageNote is empty when complete and lists missing repos otherwise", () => {
    assert.equal(coverageNote({ loaded: [], missing: [] }), "");
    const note = coverageNote({ loaded: [{ child: "a", graph: {} as never }], missing: ["b", "c"] });
    assert.ok(note.startsWith("1 of 3 workspace repos have graphs; run "));
    assert.ok(note.endsWith("to cover b, c"));
  });

  test("readWorkspace rejects foreign, malformed and escaping indexes", () => {
    const root = scratch("ws-read");
    assert.equal(readWorkspace(root), null);
    writeRawWorkspace(root, "not json at all");
    assert.equal(readWorkspace(root), null);
    writeRawWorkspace(root, JSON.stringify({ version: 2, children: ["a"] }));
    assert.equal(readWorkspace(root), null);
    writeRawWorkspace(root, JSON.stringify({ version: 1, children: "a" }));
    assert.equal(readWorkspace(root), null);
    for (const bad of ["..", ".", "", "a/b", "a\\b", "c:x"]) {
      writeRawWorkspace(root, JSON.stringify({ version: 1, children: ["ok", bad] }));
      assert.equal(readWorkspace(root), null, `child ${JSON.stringify(bad)} must be rejected`);
    }
    const written = writeWorkspace(root, { version: 1, children: ["zeta", "alpha", "mid"] });
    assert.equal(written, workspacePath(root));
    assert.deepEqual(readWorkspace(root), { version: 1, children: ["alpha", "mid", "zeta"] });
  });

  test("isWorkspaceBuildRoot honours an index, an own .git and the child count", () => {
    const own = scratch("ws-own-git");
    mkdirSync(join(own, ".git"));
    gitChild(own, "a", {});
    gitChild(own, "b", {});
    assert.equal(isWorkspaceBuildRoot(own), false);
    writeWorkspace(own, { version: 1, children: ["a", "b"] });
    assert.equal(isWorkspaceBuildRoot(own), true);

    const single = scratch("ws-single");
    gitChild(single, "only", {});
    assert.equal(isWorkspaceBuildRoot(single), false);
    gitChild(single, "second", {});
    assert.equal(isWorkspaceBuildRoot(single), true);
  });

  test("hasMegaGraph and clearParentGraft manage the parent graft tree", () => {
    const root = scratch("ws-mega");
    assert.equal(hasMegaGraph(root), false);
    const wiring = wiringPath(contextDirFor(root));
    mkdirSync(dirname(wiring), { recursive: true });
    writeFileSync(wiring, "{}");
    assert.equal(hasMegaGraph(root), true);
    clearParentGraft(root);
    assert.equal(hasMegaGraph(root), false);
    assert.equal(existsSync(contextDirFor(root)), false);
  });
});

describe("workspaceRepos", () => {
  test("a linked worktree beside its main checkout is not a second repo", () => {
    const parent = scratch("ws-worktree");
    const main = join(parent, "main");
    mkdirSync(main);
    git(main, ["init", "-q", "-b", "main"]);
    writeFileSync(join(main, "a.txt"), "a\n");
    git(main, ["add", "a.txt"]);
    git(main, ["commit", "-q", "-m", "init"]);
    git(main, ["worktree", "add", "-q", "-b", "wt", join(parent, "wt")]);
    assert.deepEqual(workspaceRepos(parent), ["main"]);
  });

  test("a folder of only worktrees federates through its first worktree", () => {
    const outside = scratch("ws-outside-main");
    git(outside, ["init", "-q", "-b", "main"]);
    writeFileSync(join(outside, "a.txt"), "a\n");
    git(outside, ["add", "a.txt"]);
    git(outside, ["commit", "-q", "-m", "init"]);
    const parent = scratch("ws-only-worktrees");
    git(outside, ["worktree", "add", "-q", "-b", "w1", join(parent, "wt1")]);
    git(outside, ["worktree", "add", "-q", "-b", "w2", join(parent, "wt2")]);
    assert.deepEqual(workspaceRepos(parent), ["wt1"]);
  });

  test("a dangling .git pointer still counts as its own repo", () => {
    const parent = scratch("ws-dangling");
    mkdirSync(join(parent, "ghost"));
    writeFileSync(join(parent, "ghost", ".git"), `gitdir: ${join(parent, "missing", ".git", "worktrees", "ghost")}\n`);
    gitChild(parent, "real", {});
    assert.deepEqual(workspaceRepos(parent).sort(), ["ghost", "real"]);
  });
});

describe("federated queries", () => {
  test("loadWorkspaceGraphs discovers children, then follows the index", () => {
    const discovered = loadWorkspaceGraphs(ws);
    assert.deepEqual(discovered.loaded.map((l) => l.child), ["alpha", "beta"]);
    assert.deepEqual(discovered.missing, ["gamma"]);
    writeWorkspace(ws, { version: 1, children: ["gamma", "beta", "alpha"] });
    const indexed = loadWorkspaceGraphs(ws);
    assert.deepEqual(indexed.loaded.map((l) => l.child), ["alpha", "beta"]);
    assert.deepEqual(indexed.missing, ["gamma"]);
  });

  test("federateGrep prefixes child paths and honours --in", () => {
    const all = federateGrep(ws, undefined, "return", { fixed: true });
    const paths = all.result.groups.map((g) => g.path);
    assert.ok(paths.some((p) => p.startsWith("alpha/")));
    assert.ok(paths.some((p) => p.startsWith("beta/")));
    assert.ok(all.result.totalHits >= 3);
    assert.ok(all.coverage.includes("gamma"));
    for (const g of all.result.groups) if (g.symbol) assert.ok(g.symbol.path.startsWith(g.path.split("/")[0] + "/"));

    const onlyBeta = federateGrep(ws, undefined, "RETURN", { ignoreCase: true, in: "beta" });
    assert.ok(onlyBeta.result.groups.length > 0);
    assert.ok(onlyBeta.result.groups.every((g) => g.path.startsWith("beta/")));

    assert.throws(() => federateGrep(ws, undefined, "x", { in: "nope" }), /no workspace repo "nope" - repos: alpha, beta, gamma/);
  });

  test("federateMap and federateMapJson render one section per child", () => {
    const text = federateMap(ws, undefined, { maxDirs: 4 });
    assert.ok(text.startsWith("workspace map — 2 repo(s)"));
    assert.ok(text.includes("## alpha/"));
    assert.ok(text.includes("## beta/"));
    assert.ok(text.includes("to cover gamma"));

    const { json, coverage } = federateMapJson(ws, undefined, { maxDirs: 1 });
    assert.deepEqual(json.repos.map((r) => r.repo), ["alpha", "beta"]);
    assert.deepEqual(json.missing, ["gamma"]);
    assert.ok(coverage.includes("gamma"));
    for (const r of json.repos) {
      for (const d of r.map.dirs) assert.ok(d.path.startsWith(`${r.repo}/`), d.path);
      for (const h of r.map.hotspots) assert.ok(h.path.startsWith(`${r.repo}/`), h.path);
    }
    const unbounded = federateMapJson(ws, undefined);
    assert.equal(unbounded.json.repos.length, 2);
  });

  test("federateCallers resolves across children, scoped and unscoped", () => {
    const found = federateCallers(ws, undefined, "helperAlpha");
    assert.equal(found.found, true);
    assert.ok(found.text.includes("## alpha/"));
    assert.ok(found.text.includes("to cover gamma"));
    assert.equal(found.json.matches[0].symbol.path, "alpha/src/util.ts");

    const out = federateCallers(ws, undefined, "runAlpha", { direction: "out", depth: 2 });
    assert.equal(out.found, true);
    assert.equal(out.json.matches[0].symbol.path, "alpha/src/main.ts");

    const scoped = federateCallers(ws, undefined, "helperAlpha", { in: "beta" });
    assert.equal(scoped.found, false);
    assert.ok(scoped.text.includes('no symbol "helperAlpha" in beta/'));

    const none = federateCallers(ws, undefined, "noSuchSymbolAnywhere");
    assert.equal(none.found, false);
    assert.ok(none.text.includes("any of the 2 workspace repo(s)"));
    assert.ok(none.text.includes("gamma"));
    assert.deepEqual(none.json.matches, []);
  });

  test("federateAsk fuses child hits with prefixed pointers", () => {
    for (const fileTopLock of [true, false]) {
      const r = federateAsk(ws, undefined, "helperAlpha", { limit: 5, fileTopLock });
      assert.ok(r.hits.length > 0, `hits expected (fileTopLock ${fileTopLock})`);
      assert.ok(r.hits[0].pointer.startsWith("alpha/"), r.hits[0].pointer);
      assert.ok(r.scopes && r.scopes.federated.length > 0);
      assert.ok(r.note?.includes("to cover gamma"));
    }
  });

  test("federateAsk narrows with --in and reports empty results", () => {
    const beta = federateAsk(ws, undefined, "betaWidget", { in: "beta" });
    assert.ok(beta.hits.length > 0);
    assert.ok(beta.hits.every((h) => h.pointer.split(", ").every((p) => p.startsWith("beta/") || p.includes(" "))));

    const subScope = federateAsk(ws, undefined, "helperAlpha", { in: "alpha/src", fileTopLock: false });
    assert.ok(subScope.hits.length > 0);
    assert.ok(subScope.hits[0].pointer.startsWith("alpha/src/"));

    assert.throws(() => federateAsk(ws, undefined, "x", { in: "nope" }), /no workspace repo "nope"/);

    for (const fileTopLock of [true, false]) {
      const empty = federateAsk(ws, undefined, "qqzzxxv", { fileTopLock });
      assert.equal(empty.mode, "empty");
      assert.equal(empty.hits.length, 0);
      assert.ok(empty.note?.includes("no matching nodes across 2 workspace repo(s)"));
      assert.ok(empty.note?.includes("to cover gamma"));
    }
  });

  test("federateCheck reports OK, unbuilt and stale children", async () => {
    const clean = await federateCheck(ws);
    assert.equal(clean.ok, true);
    assert.ok(clean.text.startsWith("workspace check — 3 repo(s)"));
    assert.ok(clean.text.includes("alpha/: OK"));
    assert.ok(clean.text.includes("gamma/: not built"));

    writeFileSync(join(ws, "alpha", "src", "util.ts"), "export function helperAlpha() { return 2; }\nexport const more = 1;\n");
    const stale = await federateCheck(ws);
    assert.equal(stale.ok, false);
    assert.match(stale.text, /alpha\/: STALE \(.*changed/);
    assert.ok(stale.text.includes("beta/: OK"));
  });
});

describe("splitWorkspace", () => {
  test("builds every child, migrates a mega-graph and leaves only workspace.json", async () => {
    const parent = scratch("ws-split");
    gitChild(parent, "two", { "b.ts": "export const b = 2;\n" });
    gitChild(parent, "one", { "a.ts": "export const a = 1;\n" });
    const wiring = wiringPath(contextDirFor(parent));
    mkdirSync(dirname(wiring), { recursive: true });
    writeFileSync(wiring, "{}");
    writeFileSync(join(contextDirFor(parent), "stale-card.md"), "old\n");

    const events: string[] = [];
    const result = await splitWorkspace(
      parent,
      undefined,
      async (childDir, name) => {
        assert.equal(childDir, join(parent, name));
        events.push(`build:${name}`);
      },
      (info) => events.push(`start:${info.children.join(",")}:${info.migrated}`),
    );
    assert.deepEqual(result, { children: ["one", "two"], migrated: true });
    assert.deepEqual(events, ["start:one,two:true", "build:one", "build:two"]);
    assert.deepEqual(readdirSync(contextDirFor(parent)), ["workspace.json"]);
    assert.deepEqual(readWorkspace(parent)?.children, ["one", "two"]);

    const again = await splitWorkspace(parent, undefined, async () => {});
    assert.equal(again.migrated, false);
    assert.equal(isWorkspaceBuildRoot(parent), true);
  });
});
