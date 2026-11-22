import { test, describe, before, after, mock } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Graft } from "../src/engine.js";
import { buildGraph } from "../src/graph/build.js";
import { nativeFallbackNotice } from "../src/graph/native.js";
import { migrationNote } from "../src/graph/workspace.js";
import { runWorkspaceBuild, runWorkspaceGrep } from "../src/graph/workspace-cli.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { readBuildConfig, writeBuildConfig } from "../src/util/state.js";

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "workspace-cli-gaps-")));
  scratchDirs.push(dir);
  return dir;
}

function addChild(root: string, name: string, independent = true): string {
  const dir = join(root, name);
  mkdirSync(independent ? join(dir, ".git") : dir, { recursive: true });
  writeFileSync(join(dir, "main.ts"), "export function ping(): number { return 1; }\n");
  return dir;
}

function captureConsole(t: TestContext) {
  const out: string[] = [];
  const err: string[] = [];
  t.mock.method(console, "log", (message: unknown) => { out.push(String(message)); });
  t.mock.method(console, "error", (message: unknown) => { err.push(String(message)); });
  return { out, err };
}

function manifestChildren(contextDir: string): string[] {
  return JSON.parse(readFileSync(join(contextDir, "workspace.json"), "utf8")).children;
}

function childGraph(root: string, name: string) {
  const graph = readGraph(wiringPath(join(root, name, "graft")));
  assert.ok(graph, `expected a graph for ${name}`);
  assert.ok(graph.nodes.some((node) => node.id === "main.ts#ping"));
  return graph;
}

describe("workspace CLI gaps", { concurrency: false }, () => {
  before(() => {
    // In particular, keep the strict-build failure's telemetry offline.
    mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  });

  after(() => {
    mock.restoreAll();
    for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  });

  test("persists an explicit false nested-repo choice without clearing each child's include list", async (t) => {
    const root = scratch();
    const names = ["repoA", "repoB"];
    for (const name of names) {
      const dir = addChild(root, name);
      mkdirSync(join(dir, "build"));
      writeFileSync(join(dir, "build", "local.ts"), "export function fromBuild(): number { return 2; }\n");
      writeBuildConfig(dir, {
        includeDirs: ["build"],
        followSubmodules: true,
        followNestedRepos: true,
      });
    }
    const { out } = captureConsole(t);
    const federationDir = join(root, "federation");
    const unusedChildDir = join(root, "unused-child-context");

    await runWorkspaceBuild(root, {
      deep: false,
      override: federationDir,
      childConfig: { contextDir: unusedChildDir },
      includeDirs: [],
      followNestedRepos: false,
    });

    assert.deepEqual(manifestChildren(federationDir), names);
    assert.equal(existsSync(unusedChildDir), false);
    for (const name of names) {
      assert.deepEqual(readBuildConfig(join(root, name)), {
        includeDirs: ["build"],
        followSubmodules: true,
        followNestedRepos: false,
      });
      assert.ok(childGraph(root, name).nodes.some((node) => node.id === "build/local.ts#fromBuild"));
      assert.ok(out.some((line) => line.startsWith(`✓ ${name}/:`)));
    }
    assert.ok(out.some((line) => line.startsWith("✓ workspace: 2 repos federated")));
  });

  test("warns when replacing an old parent graph with the federation index", async (t) => {
    const root = scratch();
    const names = ["repoA", "repoB"];
    const dirs = names.map((name) => addChild(root, name, false));
    const parentContext = join(root, "graft");
    const oldWiring = wiringPath(parentContext);
    await buildGraph(root);
    const oldGraph = readGraph(oldWiring);
    assert.ok(oldGraph);
    for (const name of names) {
      assert.ok(oldGraph.nodes.some((node) => node.id === `${name}/main.ts#ping`));
    }
    for (const dir of dirs) mkdirSync(join(dir, ".git"));
    const { err } = captureConsole(t);

    await runWorkspaceBuild(root, { deep: false, childConfig: {} });

    assert.deepEqual(manifestChildren(parentContext), names);
    assert.equal(existsSync(oldWiring), false);
    const warningIndex = err.indexOf(migrationNote(names));
    const progressIndex = err.indexOf("building 2 workspace repos: repoA, repoB");
    assert.ok(warningIndex >= 0 && warningIndex < progressIndex);
    for (const name of names) childGraph(root, name);
  });

  for (const strict of [false, true]) {
    test(`${strict ? "strict" : "non-strict"} build reports structural errors and still federates partial graphs`, async (t) => {
      const root = scratch();
      const names = ["repoA", "repoB", "repoC"];
      for (const name of names) addChild(root, name);
      const { out, err } = captureConsole(t);
      const oldExitCode = process.exitCode;
      t.after(() => { process.exitCode = oldExitCode; });
      process.exitCode = 0;

      // Keep real wiring and manifest writes, but control the otherwise
      // environment-dependent structural diagnostics and native fallbacks.
      const init = t.mock.method(Graft.prototype, "init", async () => {});
      const realGraph = Graft.prototype.graph;
      const graph = t.mock.method(Graft.prototype, "graph", async function (
        this: Graft,
        dir: string,
        options?: Parameters<Graft["graph"]>[1],
      ) {
        const result = await realGraph.call(this, dir, { ...options, llm: false });
        const name = basename(dir);
        if (name === "repoC") return { ...result, nativeFallback: undefined };
        return {
          ...result,
          structuralErrors: 1,
          errors: [`incomplete wiring for ${name}`],
          nativeFallback: name === "repoA"
            ? {
                languages: ["typescript", "python"],
                packages: ["tree-sitter-typescript", "tree-sitter-python"],
              }
            : { languages: ["python"], packages: ["tree-sitter-python"] },
        };
      });

      const deep = !strict;
      await runWorkspaceBuild(root, {
        strict,
        deep,
        concurrency: 2,
        synthConcurrency: 3,
        synthBatchChars: 8000,
        childConfig: {},
      });

      assert.deepEqual(manifestChildren(join(root, "graft")), names);
      assert.deepEqual(graph.mock.calls.map((call) => basename(call.arguments[0])).sort(), names);
      for (const { arguments: [, options] } of graph.mock.calls) {
        assert.deepEqual(options, { llm: deep, concurrency: 2, extensions: undefined });
      }
      assert.deepEqual(init.mock.calls.map((call) => basename(call.arguments[0])).sort(), deep ? names : []);
      for (const { arguments: [, options] } of init.mock.calls) {
        assert.deepEqual(options, {
          extensions: undefined,
          concurrency: 2,
          synthConcurrency: 3,
          synthBatchChars: 8000,
        });
      }
      for (const name of names) childGraph(root, name);

      for (const name of ["repoA", "repoB"]) {
        assert.ok(err.includes(`✗ ${name}/: incomplete wiring for ${name}`));
        assert.equal(err.some((line) => line.startsWith(
          `✗ ${name}/: wiring incomplete — 1 structural error(s)`,
        )), strict);
        assert.equal(out.some((line) => line.startsWith(`✓ ${name}/:`)), !strict);
      }
      assert.ok(out.some((line) => line.startsWith("✓ repoC/:")));
      assert.equal(out.some((line) => line.startsWith("✓ workspace: 3 repos federated")), !strict);
      assert.equal(err.some((line) =>
        line.startsWith("✗ workspace incomplete: 2 of 3 repo(s) had structural errors") &&
        line.includes("partial graphs were federated")
      ), strict);
      assert.equal(process.exitCode, strict ? 1 : 0);

      const notice = nativeFallbackNotice({
        languages: ["python", "typescript"],
        packages: ["tree-sitter-python", "tree-sitter-typescript"],
      });
      assert.ok(notice);
      assert.equal(err.filter((line) => line === notice).length, 1);
    });
  }

  test("grep keeps JSON parseable and reports an unbuilt child even when there are no hits", async (t) => {
    const root = scratch();
    addChild(root, "repoA");
    const repoB = addChild(root, "repoB");
    const { out, err } = captureConsole(t);
    await runWorkspaceBuild(root, { deep: false, childConfig: {} });

    const pattern = "NoSuchWorkspaceSymbol48271";
    out.length = err.length = 0;
    runWorkspaceGrep(root, undefined, pattern, { fixed: true, json: true });
    assert.equal(out.length, 1);
    assert.equal(JSON.parse(out[0]!).totalHits, 0);
    assert.deepEqual(err, []);

    rmSync(join(repoB, "graft"), { recursive: true });
    out.length = err.length = 0;
    runWorkspaceGrep(root, undefined, pattern, { fixed: true, json: true });
    assert.equal(out.length, 1);
    assert.equal(JSON.parse(out[0]!).totalHits, 0);
    assert.equal(err.length, 1);
    const coverage = err[0]!;
    assert.match(coverage, /\brepoB\b/);

    out.length = err.length = 0;
    runWorkspaceGrep(root, undefined, pattern, { fixed: true });
    assert.deepEqual(out, []);
    assert.equal(err.length, 1);
    assert.ok(err[0]!.endsWith(`\n${coverage}`));
    assert.ok(err[0]!.slice(0, -coverage.length - 1).trim(), "expected a no-hit note before coverage");
  });
});
