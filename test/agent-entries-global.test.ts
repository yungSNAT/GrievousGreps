/**
 * The fork writes user-level agent config only with `--global`. `addAgentEntries`
 * writes it (~/.claude.json, ~/.cursor, ~/.codex), so every call must sit behind
 * that choice: `trail login --global`, or a repeat of it. Upstream's
 * `share-session` sign-in (#836) called it unconditionally. Its sign-in needs a
 * terminal and a browser, so this reads the calls from the source.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("every addAgentEntries() call in the CLI is behind --global", () => {
  const lines = readFileSync(resolve(process.cwd(), "src/cli.ts"), "utf8").split(/\r?\n/);
  const calls = lines
    .map((text, i) => ({ text: text.trim(), line: i + 1 }))
    .filter(({ text }) => /\baddAgentEntries\(\)/.test(text) && !text.startsWith("function "));
  assert.ok(calls.length > 0, "no addAgentEntries() call found: the test reads the wrong file");
  const unguarded = calls.filter(({ text }) => !/^if \((opts\.)?global\) addAgentEntries\(\);$/.test(text));
  assert.deepEqual(unguarded, []);
});
