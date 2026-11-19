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
  assert.equal(classifyAnswer("yes, ,keep it", false), "yes");
  assert.equal(classifyFor("retire", "retire, ,it", false), "retire");
  assert.equal(isGoAhead("ok, go on 🙂"), true);
  assert.equal(isGoAhead("go ahead - thanks"), true);
  assert.equal(classifyFor("retire", "no, leave it for now", false), "no");
  assert.equal(classifyFor("retire", "retire it 👍", false), "retire");
});

test("a no whose rest is about the offer still reads across a CR or Unicode line break", () => {
  for (const sep of ["\r", "\u2028", "\u2029", " \r "]) assert.equal(classifyFor("retire", `no${sep}retire`, false), "no", JSON.stringify(sep));
  for (const sep of ["\r", "\u2028"]) quick("classifyFor", () => classifyFor("retire", `no${sep.repeat(N)}x`, false));
});

/**
 * Each rewritten pattern beside the one it replaced. The config-file patterns are read only for their
 * captures, and a match may now start at a later line start, so for them the captures must agree; for
 * the rest, every match, split and replacement.
 */
const CAPTURES_ONLY = new Set(["go module", "pnpm", "where", "package_dir", "packages", "python-source", "empty key", "setup where"]);
const PAIRS: [string, RegExp, RegExp][] = [
  ["go module", /^\s*module\s+(\S+)/m, /^[^\S\r\n\u2028\u2029]*module\s+(\S+)/m],
  ["pnpm", /^\s*-\s*['"]?([^'"\s#!]+)/gm, /^[^\S\r\n\u2028\u2029]*-\s*['"]?([^'"\s#!]+)/gm],
  ["where", /^\s*(where|pythonpath)\s*=\s*(\[[^\]]*\]|"[^"]*"|'[^']*')/gm, /^[^\S\r\n\u2028\u2029]*(where|pythonpath)\s*=\s*(\[[^\]]*\]|"[^"]*"|'[^']*')/gm],
  ["package_dir", /^\s*package_dir\s*=\s*(?:\r?\n\s*)?=\s*(\S+)/gm, /^[^\S\r\n\u2028\u2029]*package_dir\s*=\s*=\s*(\S+)/gm],
  ["packages", /^\s*packages\s*=\s*\[([^\]]*)\]/gm, /^[^\S
  ]*packages\s*=\s*\[([^\]]*)\]/gm],
  ["python-source", /^\s*python-source\s*=\s*["']([^"']+)["']/gm, /^[^\S
  ]*python-source\s*=\s*["']([^"']+)["']/gm],
  ["empty key", /^\s*(?:""|'')\s*=\s*["']([^"']+)["']/gm, /^[^\S
  ]*(?:""|'')\s*=\s*["']([^"']+)["']/gm],
  ["setup where", /^\s*where\s*=\s*(\S+)/gm, /^[^\S
  ]*where\s*=\s*(\S+)/gm],
  ["trailing emoji", /[\s\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]+$/u, /(?<![\s\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}])[\s\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]+$/u],
  ["outer punctuation", /^[\s.!?,;:]+|[\s.!?,;:]+$/g, /^[\s.!?,;:]+|(?<![\s.!?,;:])[\s.!?,;:]+$/g],
  ["comma", /\s*,\s*/g, /(?<!\s)\s*,\s*/g],
  ["first clause", /\s*(?:[,:;.!]|\s-\s|\s\u2014\s|$)/, /(?<!\s)\s*(?:[,:;.!]|\s-\s|\s\u2014\s|$)/],
  ["no about", /^(no|nope|nah|not now)\b[\s,.;:!]+.*\b(retire|replace|leave|keep|later|for now|not now)\b/, /^(no|nope|nah|not now)\b(?:[\s,.;:!]*[\n\r\u2028\u2029]|[\s,.;:!]).*\b(retire|replace|leave|keep|later|for now|not now)\b/],
];
const SAMPLES = [
  "", " ", "x", "module a", "\n\n  module  a/b \n", "\r\n\tmodule x\r\n", "\u2028 module y", "-a\n  - 'pkg/*'\n -\n  b\n\r- \"c\"",
  "[options]\npackage_dir =\n    = src\nwhere=lib", "  where = [\"a\", 'b']\n\npythonpath = \"x\"", "package_dir\n=\n\n=\n src",
  "yes 👍🏽 ", "ok 👨‍👩‍👧", "  ,. yes !! ", ".,;", "a , b,c ,  d", "go on - now", "ok \u2014 sure", "ok", "  ", "no, leave it for now",
  "no \nretire", "no \rretire", "no\u2028 \u2029keep", "nope ,, later", "no retire", "no\r\r later x", "noretire",
];

test("each rewritten pattern gives what the one it replaced gave", () => {
  for (const [name, before, after] of PAIRS) {
    for (const s of SAMPLES) {
      const label = `${name} on ${JSON.stringify(s)}`;
      if (CAPTURES_ONLY.has(name)) {
        const caps = (re: RegExp) => [...s.matchAll(new RegExp(re.source, `${re.flags.replace("g", "")}g`))].map((m) => m.slice(1));
        assert.deepEqual(caps(after), caps(before), label);
        continue;
      }
      assert.equal(s.replace(after, "<>"), s.replace(before, "<>"), label);
      assert.deepEqual(s.split(after), s.split(before), label);
      if (before.global) assert.deepEqual([...s.matchAll(after)].map((m) => [...m]), [...s.matchAll(before)].map((m) => [...m]), label);
      else assert.deepEqual(after.exec(s)?.slice(), before.exec(s)?.slice(), label);
    }
  }
});
