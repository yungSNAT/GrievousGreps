import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, posix } from "node:path";
import { contextDirFor } from "../src/context/node-file.js";
import { tmpRepo } from "./helpers.js";

function write(root: string, file: string, text: string): void {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function symbol(file: string, name: string) {
  return { id: `${file}#${name}`, kind: "function", name, file };
}

describe("codeAnchors", () => {
  let workspace: string | undefined;
  let indexed: string;
  let unindexed: string;
  let codeAnchors: typeof import("../src/notes/team-check.js").codeAnchors;

  // Graph IDs use POSIX paths on both platforms.
  const queue = posix.join("src", "queue.ts");
  const doubles = [
    posix.join("test", "queue-double.ts"),
    posix.join("src", "queue.test.ts"),
    posix.join("src", "queue.spec.ts"),
    posix.join("worker", "queue_test.go"),
  ];
  const fixtureFiles = [
    posix.join("tests", "fixtures.ts"),
    posix.join("src", "__tests__", "helpers.ts"),
    posix.join("spec", "setup.ts"),
  ];
  const metricFiles = ["queue", "cache", "worker", "scheduler"].map((area) =>
    posix.join("src", area, "metrics.ts"),
  );
  const worker = posix.join("src", "worker.ts");
  const fixtureTool = posix.join("tools", "resetFixture");
  const mentioned = posix.join("src", "retry.ts");
  const inline = join("src", "client.ts");
  const missing = posix.join("src", "removed.ts");

  before(async () => {
    mock.method(globalThis, "fetch", async () => {
      assert.fail("code anchor lookup must not use the network");
    });

    workspace = tmpRepo("team-check-gaps");
    indexed = join(workspace, "indexed");
    unindexed = join(workspace, "unindexed");

    write(unindexed, mentioned, "export const retries = 4;\n");
    write(unindexed, inline, "export const timeoutMs = 7000;\n");
    write(workspace, "outside.ts", "export const outside = true;\n");

    const functions = [
      ...[queue, ...doubles].map((file) => symbol(file, "dispatchBatch")),
      ...fixtureFiles.map((file) => symbol(file, "resetFixture")),
      ...metricFiles.map((file) => symbol(file, "recordMetric")),
      symbol(worker, "run"),
    ];
    for (const { file, name } of functions) {
      write(indexed, file, file.endsWith(".go")
        ? `package worker\n\nfunc ${name}() {}\n`
        : `export function ${name}() {}\n`);
    }
    write(indexed, fixtureTool, "# Fixture reset tool\n");

    const files = [...functions.map(({ file }) => file), fixtureTool];
    const nodes = [
      ...files.map((file) => ({
        id: file,
        kind: "file",
        name: posix.basename(file),
        file,
      })),
      ...functions,
    ];

    // Exercise the graph records that codeAnchors consumes without depending
    // on the graph cache's on-disk format.
    const fixtureSource = `
      const graph = ${JSON.stringify({ nodes, edges: [] })};
      export function loadGraphCached(dir) {
        return dir === ${JSON.stringify(contextDirFor(indexed))} ? graph : null;
      }
    `;
    const fixtureUrl = `data:text/javascript,${encodeURIComponent(fixtureSource)}`;
    const teamCheckUrl = new URL("../src/notes/team-check.ts", import.meta.url).href;
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "../graph/load.js" && context.parentURL === teamCheckUrl) {
          return { url: fixtureUrl, format: "module", shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
    try {
      ({ codeAnchors } = await import("../src/notes/team-check.js"));
    } finally {
      hooks.deregister();
    }
  });

  after(() => {
    mock.restoreAll();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test("without a graph, keeps existing mentions and inline paths once, in order", () => {
    assert.deepEqual(
      codeAnchors(
        unindexed,
        `See ${mentioned} and ${missing} before calling \`dispatchBatch()\`.`,
        [inline, mentioned, "", missing, join("..", "outside.ts")],
      ),
      [mentioned, inline],
    );
  });

  test("bare and qualified symbol names resolve to production code rather than test doubles", () => {
    for (const reference of [
      "`dispatchBatch`",
      "`Queue.dispatchBatch()`",
      "`Queue::dispatchBatch`",
      "`Queue#dispatchBatch()`",
    ]) {
      assert.deepEqual(
        codeAnchors(indexed, `Preserve batch ordering in ${reference}.`),
        [`${queue}#dispatchBatch`],
        reference,
      );
    }
  });

  test("keeps three test-only symbol matches and ignores a same-named file node", () => {
    assert.deepEqual(
      codeAnchors(indexed, "Call `Harness::resetFixture()` between cases."),
      fixtureFiles.map((file) => `${file}#resetFixture`),
    );
  });

  test("omits ambiguous and short symbol names without dropping an inline file anchor", () => {
    assert.deepEqual(
      codeAnchors(indexed, "Call `recordMetric()` before `run()`.", [worker]),
      [worker],
    );
  });

  test("an indexed checkout still requires backticks around symbol names", () => {
    assert.deepEqual(
      codeAnchors(indexed, "Preserve dispatchBatch ordering when calling `run()`.", [worker]),
      [worker],
    );
  });
});
