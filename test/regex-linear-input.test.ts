/**
 * Regexes that read repository files or the person's message run in linear time: a file
 * or message built to make them backtrack (long runs of blank lines, spaces or
 * punctuation) costs milliseconds, not minutes. Before the rewrite these
 * inputs took 92 to 351 seconds; the limit leaves room for a
 * slow runner while still failing a quadratic regex at these sizes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPythonRoots } from "../src/graph/python-roots.js";
import { buildGraph } from "../src/graph/build.js";
import { classifyAnswer, isGoAhead } from "../src/trace/typed.js";
import { classifyFor } from "../src/skills/offer-answers.js";

const LIMIT_MS = 3000;
const N = 200_000;

function quick<T>(what: string, run: () => T): T {
  const start = performance.now();
  const out = run();
  const ms = performance.now() - start;
  assert.ok(ms < LIMIT_MS, `${what} took ${ms.toFixed(0)} ms`);
  return out;
}

test("Python config files full of blank lines or spaces are read in linear time", () => {
  const dir = mkdtempSync(join(tmpdir(), "regex-linear-py-"));
  writeFileSync(join(dir, "pyproject.toml"), `${"\n".repeat(N)}x\n[tool.setuptools.packages.find]\n  where = ["lib"]\n`);
  writeFileSync(join(dir, "setup.cfg"), `[options]\npackage_dir =${"\n".repeat(N)}x\n`);
  const roots = quick("readPythonRoots", () => readPythonRoots(dir, [join(dir, "pyproject.toml"), join(dir, "setup.cfg")]));
  assert.ok(roots.includes("lib"), "a where after the blank lines is still read");
});

test("a go.mod and a pnpm-workspace.yaml full of blank lines are read in linear time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regex-linear-ws-"));
  writeFileSync(join(dir, "go.mod"), `${"\n".repeat(N)}x\n`);
  writeFileSync(join(dir, "pnpm-workspace.yaml"), `${"\n".repeat(N)}x\n`);
  writeFileSync(join(dir, "main.go"), "package main\nfunc main() {}\n");
  const start = performance.now();
  await buildGraph(dir);
  const ms = performance.now() - start;
  assert.ok(ms < LIMIT_MS * 3, `buildGraph took ${ms.toFixed(0)} ms`);
});

test("a message built to backtrack is classified in linear time", () => {
  for (const typed of [`a${" ".repeat(N)}b`, `no${" ".repeat(N)}x`, `a${",".repeat(N)}b`, `a${". ".repeat(N / 2)}b`]) {
    quick("classifyAnswer", () => classifyAnswer(typed, false));
    assert.equal(quick("isGoAhead", () => isGoAhead(typed)), false);
    quick("classifyFor", () => classifyFor("retire", typed, false));
  }
});

test("the rewritten regexes keep their answers", () => {
  assert.equal(classifyAnswer("yes, keep it 👍🏽", false), "yes");
  assert.equal(classifyAnswer("  yes ,  keep it!!  ", false), "yes");
  assert.equal(isGoAhead("ok, go on 🙂"), true);
  assert.equal(isGoAhead("go ahead - thanks"), true);
  assert.equal(classifyFor("retire", "no, leave it for now", false), "no");
  assert.equal(classifyFor("retire", "retire it 👍", false), "retire");
});
