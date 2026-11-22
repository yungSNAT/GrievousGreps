import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import {
  buildGraph,
  tierOf,
  warmGrammarsFor,
  type GraphBuildResult,
} from "../src/graph/build.js";
import { isContainerWarm } from "../src/graph/container.js";
import { isWarm } from "../src/graph/generic.js";
import type { GraphV1 } from "../src/graph/types.js";
import { tmpRepo } from "./helpers.js";

function put(root: string, parts: string[], text: string): string {
  const path = join(root, ...parts);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function graphOf(result: GraphBuildResult): GraphV1 {
  return JSON.parse(readFileSync(result.graphPath, "utf8")) as GraphV1;
}

describe("graph build gaps", () => {
  let scratch: string;

  before(() => {
    scratch = tmpRepo("graph-build-gaps");
    mock.method(globalThis, "fetch", async () => {
      throw new Error("Graph build tests must stay offline");
    });
  });

  after(() => {
    mock.restoreAll();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  function repo(name: string): string {
    const root = join(scratch, name);
    mkdirSync(root);
    return root;
  }

  test("warms a Vue container and its script grammar alongside a breadth grammar", async () => {
    const root = repo("mixed-grammars");
    const vue = put(root, ["components", "Status.vue"], [
      '<script lang="ts">',
      'export function formatStatus() { return "ready"; }',
      "</script>",
      "<template><span>Ready</span></template>",
      "",
    ].join("\n"));
    const lua = put(root, ["format.lua"], 'function format() return "ready" end\n');

    const container = tierOf(vue).container;
    const generic = tierOf(lua).generic;
    assert.ok(container);
    assert.equal(container.name, "vue");
    assert.ok(generic);
    assert.equal(generic.name, "lua");

    await warmGrammarsFor(new Set([vue, lua]));
    assert.equal(isContainerWarm(container.name), true);
    assert.equal(isWarm(generic.name), true);
    assert.equal(tierOf(join(root, "script.ts")).lang, container.inner);

    const result = await buildGraph(root, { graphOnly: true });
    assert.equal(result.parsed, 2, result.errors.join("\n"));
    assert.equal(result.failed, 0);
    const { nodes } = graphOf(result);
    assert.ok(nodes.some((node) =>
      node.path === posix.join("components", "Status.vue") && node.kind === "function"
    ));
  });

  test("inherits an alias without baseUrl when later extends entries cannot be read", async () => {
    const root = repo("unavailable-extends");
    put(root, ["tsconfig.json"], JSON.stringify({
      extends: ["./tsconfig.shared", "./tsconfig.editing.json", "./generated-config"],
    }));
    put(root, ["tsconfig.shared.json"], JSON.stringify({
      compilerOptions: { paths: { "@app/check": ["./src/check"] } },
    }));
    put(root, ["tsconfig.editing.json"], '{ "compilerOptions": ');
    put(root, ["src", "check.ts"], "export function validate() { return true; }\n");
    put(root, ["src", "run.ts"], [
      'import { validate } from "@app/check";',
      "export function run() { return validate(); }",
      "",
    ].join("\n"));

    const result = await buildGraph(root, { graphOnly: true });
    assert.equal(result.parsed, 2, result.errors.join("\n"));
    assert.equal(result.structuralErrors, 0, result.errors.join("\n"));
    assert.equal(result.byRelation.calls, 1, "run should resolve its call through the inherited alias");
  });

  test("uses the child baseUrl for paths inherited from another directory", async () => {
    const root = repo("base-url-override");
    put(root, ["tsconfig.json"], JSON.stringify({
      extends: "./config/aliases.json",
      compilerOptions: { baseUrl: "./src" },
    }));
    put(root, ["config", "aliases.json"], JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@app/*": ["./lib/*"] } },
    }));
    put(root, ["src", "lib", "measure.ts"], "export function measure() { return 42; }\n");
    put(root, ["src", "main.ts"], [
      'import { measure } from "@app/measure";',
      "export function report() { return measure(); }",
      "",
    ].join("\n"));

    const result = await buildGraph(root, { graphOnly: true });
    assert.equal(result.structuralErrors, 0, result.errors.join("\n"));
    assert.equal(result.byRelation.calls, 1, "the alias must resolve under src, not config");
  });

  test("collapses package scopes that have too few symbols after extension filtering", async () => {
    const root = repo("thin-package-scopes");
    for (const name of ["client", "server"]) {
      put(root, [name, "package.json"], JSON.stringify({ name, private: true }));
      for (let i = 0; i < 8; i++) {
        put(root, [name, `helper-${i}.js`], `export function helper${i}() { return ${i}; }\n`);
      }
      put(root, [name, "entry.ts"], `export function ${name}Entry() { return true; }\n`);
    }

    const result = await buildGraph(root, { graphOnly: true, extensions: [".ts"] });
    assert.equal(result.files, 2);
    assert.equal(result.byKind.function, 2, result.errors.join("\n"));
    assert.deepEqual(
      graphOf(result).meta.scopes?.map(({ prefix, label }) => ({ prefix, label })),
      [{ prefix: "", label: "" }],
    );
  });

  test("a graph-only build leaves projections alone but can seed the next full build's cache", async () => {
    const root = repo("graph-only");
    const ignore = "local-notes.txt\n";
    const ignorePath = put(root, [".gitignore"], ignore);
    put(root, ["entry.ts"], "export function ready() { return true; }\n");

    const queryBuild = await buildGraph(root, { graphOnly: true });
    assert.equal(queryBuild.cards, 0);
    assert.equal(queryBuild.parsed, 1, queryBuild.errors.join("\n"));
    assert.equal(readFileSync(ignorePath, "utf8"), ignore);
    assert.ok(graphOf(queryBuild).nodes.some((node) =>
      node.path === "entry.ts" && node.kind === "function"
    ));

    const fullBuild = await buildGraph(root);
    assert.equal(fullBuild.cards, 1, fullBuild.errors.join("\n"));
    assert.equal(fullBuild.parsed, 0);
    assert.equal(fullBuild.reused, 1);
  });

  test("opt-in LSP reports no servers or queries for an empty repository", async () => {
    const progress: { phase: string; index: number; total: number; file: string }[] = [];
    const result = await buildGraph(repo("empty-lsp"), {
      graphOnly: true,
      lsp: true,
      onProgress: (event) => progress.push(event),
    });

    assert.equal(result.files, 0);
    assert.equal(result.edges, 0);
    assert.deepEqual(progress.find(({ file }) => file.startsWith("lsp:")), {
      phase: "enrich",
      index: 0,
      total: 0,
      file: "lsp:none",
    });
  });
});
