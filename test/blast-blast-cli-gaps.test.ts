import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runBlastCommand, type BlastCliOptions } from "../src/blast/blast-cli.js";
import type { BlastReport } from "../src/blast/blast.js";
import { markdownReport, textReport } from "../src/blast/render.js";
import { contextDirFor } from "../src/context/node-file.js";
import { loadGraphCached } from "../src/graph/load.js";
import { tmpRepo } from "./helpers.js";

class BlastExit extends Error {
  constructor(readonly status: string | number | null | undefined) {
    super(`blast exited with status ${status}`);
  }
}

async function expectExit(dir: string, opts: BlastCliOptions): Promise<string> {
  const messages: string[] = [];
  const stderr = mock.method(console, "error", (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  });
  const exit = mock.method(process, "exit", (status?: string | number | null): never => {
    throw new BlastExit(status);
  });
  try {
    await assert.rejects(
      runBlastCommand(dir, opts),
      (error: unknown) => error instanceof BlastExit && error.status === 1,
    );
    assert.equal(exit.mock.callCount(), 1);
    return messages.join("\n");
  } finally {
    exit.mock.restore();
    stderr.mock.restore();
  }
}

async function output(dir: string, opts: BlastCliOptions) {
  const lines: string[] = [];
  const chunks: string[] = [];
  const log = mock.method(console, "log", (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  const write = mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  try {
    await runBlastCommand(dir, opts);
    return { logged: lines.join("\n"), written: chunks.join("") };
  } finally {
    write.mock.restore();
    log.mock.restore();
  }
}

function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", windowsHide: true });
}

function buildGraph(dir: string): void {
  // Use a real build so the fixture uses the same graph format as a checkout in CI.
  // The child gets its own fetch guard, since a mock in this process cannot reach it.
  const noHttp = `data:text/javascript,${encodeURIComponent(
    'globalThis.fetch = async () => { throw new Error("Unexpected HTTP in blast fixture build"); };',
  )}`;
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(?:API_KEY|AUTH_TOKEN)$/i.test(key)) delete env[key];
  }
  const cli = (...args: string[]) =>
    execFileSync(process.execPath, [
      "--import", import.meta.resolve("tsx"),
      "--import", noHttp,
      fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      ...args,
    ], {
      cwd: dir,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      windowsHide: true,
    });

  const help = cli("build", "--help");
  const offlineFlag = [
    "--no-llm", "--no-ai", "--structural", "--code-only", "--graph-only", "--pr", "--fast",
  ].find((flag) => help.split(/\r?\n/).some((line) =>
    line.trimStart().split(/[\s,]+/)[0] === flag,
  ));
  const args: string[] = [];
  if (offlineFlag) {
    args.push(offlineFlag);
  } else {
    // Some build interfaces expose the offline build as a tier instead of a switch.
    for (const line of help.split(/\r?\n/)) {
      const option = /^\s+(--(?:tier|profile|mode))\s+[<[][^>\]]+[>\]]\s+(.+)$/.exec(line);
      const value = option?.[2].match(
        /\b(?:1|pr|fast|structural|structure|code|index|ast|syntax|lite|light|shallow|quick|basic|minimal)\b/i,
      )?.[0];
      if (option && value) {
        args.push(option[1], value.toLowerCase());
        break;
      }
    }
  }
  cli("build", ...args);
  assert.ok(loadGraphCached(contextDirFor(dir, undefined)), "the build wrote a loadable graph");
}

const sourceFile = "calculate.ts";
const original = "export function calculateTotal(price: number): number {\n  return price + 1;\n}\n";
const edited = original.replace("price + 1", "price + 2");

let scratch: string;
let missingGraph: string;

before(() => {
  scratch = tmpRepo("blast-cli-gaps");
  missingGraph = join(scratch, "unbuilt");
  mkdirSync(missingGraph);
});

after(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("rejects an unknown output format before looking for a graph", async () => {
  const message = await expectExit(missingGraph, { format: "yaml" });
  assert.match(message, /--format must be text, markdown, mermaid or json, got "yaml"/);
  assert.doesNotMatch(message, /no graph found/);
});

for (const depth of ["0", "Infinity", "many"]) {
  test(`rejects --depth ${depth} before looking for a graph`, async () => {
    const message = await expectExit(missingGraph, { depth });
    assert.ok(message.includes(`--depth must be a positive number or "all", got "${depth}"`));
    assert.doesNotMatch(message, /no graph found/);
  });
}

test("an unbuilt checkout gets a graph diagnostic and a build hint", async () => {
  const message = await expectExit(missingGraph, {});
  assert.ok(message.includes(`no graph found at ${contextDirFor(missingGraph, undefined)}`));
  assert.match(message, /build.*first/);
});

describe("blast with an indexed checkout", () => {
  let root: string;

  before(() => {
    root = join(scratch, "checkout");
    mkdirSync(root);
    git(root, "init", "-q");
    // Keep any files generated by the build out of the working-tree diff.
    writeFileSync(join(root, ".gitignore"), "*\n!.gitignore\n!calculate.ts\n");
    writeFileSync(join(root, sourceFile), original);
    git(root, "add", ".gitignore", sourceFile);
    git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "Initial calculation");
    buildGraph(root);
  });

  async function withWorkingTreeEdit(check: () => Promise<void>): Promise<void> {
    const path = join(root, sourceFile);
    writeFileSync(path, edited);
    try {
      await check();
    } finally {
      writeFileSync(path, original);
    }
  }

  test("an unavailable base explains how to fix a shallow CI checkout", async () => {
    const base = "refs/heads/not-fetched";
    const message = await expectExit(root, { base, owners: false });
    assert.ok(message.includes(`base ref "${base}" is not in this checkout`));
    assert.match(message, /actions\/checkout with `fetch-depth: 0`/);
    assert.doesNotMatch(message, /could not read a diff/);
  });

  test("a copied index is not enough to read a diff outside Git", async () => {
    const unpacked = join(scratch, "unpacked");
    mkdirSync(unpacked);
    const contextDir = contextDirFor(unpacked, undefined);
    cpSync(contextDirFor(root, undefined), contextDir, { recursive: true });
    assert.ok(loadGraphCached(contextDir), "the copied graph must load before diffing");

    const message = await expectExit(unpacked, { owners: false });
    assert.ok(message.includes(`could not read a diff in ${unpacked}`));
    assert.match(message, /is this a git repository\?/);
  });

  test("the default text format reports the unstaged edit at depth two", async () => {
    await withWorkingTreeEdit(async () => {
      const json = await output(root, { format: "json", owners: false });
      const report: BlastReport = JSON.parse(json.logged);
      assert.equal(json.written, "");
      assert.equal(report.depth, 2);
      assert.deepEqual(report.changed.map(({ path, status }) => ({ path, status })), [
        { path: sourceFile, status: "modified" },
      ]);
      assert.ok(report.changed[0].ranges.some(({ start, end }) => start <= 2 && end >= 2));

      const text = await output(root, { owners: false });
      assert.equal(text.logged, "");
      assert.ok(text.written.trim(), "a working-tree change should produce a report");
      assert.equal(text.written, textReport(report));
    });
  });

  test("markdown uses the same changed file and rounds a fractional depth down", async () => {
    await withWorkingTreeEdit(async () => {
      const opts = { depth: "3.9", owners: false, tests: true };
      const json = await output(root, { ...opts, format: "json" });
      const report: BlastReport = JSON.parse(json.logged);
      assert.equal(report.depth, 3);
      assert.deepEqual(report.changed.map(({ path }) => path), [sourceFile]);

      const markdown = await output(root, { ...opts, format: "markdown" });
      assert.equal(markdown.logged, "");
      assert.ok(markdown.written.trim());
      assert.equal(markdown.written, markdownReport(report, { root }));
    });
  });

  test("a valid base ignores working-tree edits and mixed-case MAX requests unlimited depth", async () => {
    await withWorkingTreeEdit(async () => {
      const json = await output(root, {
        base: "HEAD", format: "json", depth: "MaX", owners: false,
      });
      const report = JSON.parse(json.logged);
      assert.equal(report.basis, "HEAD...HEAD");
      assert.equal(report.depth, null, "JSON represents the unlimited numeric depth as null");
      assert.deepEqual(report.changed, []);
    });
  });

  test("an empty radius has a Mermaid comment and no clusters to send for naming", async () => {
    const fetch = mock.method(globalThis, "fetch", async () => {
      throw new Error("Naming an empty radius must not make a request");
    });
    try {
      const result = await output(root, { base: "HEAD", format: "mermaid", name: true });
      assert.equal(result.logged, "%% no dependents to draw");
      assert.equal(result.written, "");
      assert.equal(fetch.mock.callCount(), 0);
    } finally {
      fetch.mock.restore();
    }
  });
});
