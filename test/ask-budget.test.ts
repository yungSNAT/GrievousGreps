/**
 * `ask --max-tokens` / graft_find_code `max_tokens`: the answer fits the budget,
 * keeps the ranking, and says what it folded or left out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetAsk, foldCode, parseMaxTokens } from "../src/ask/budget.js";
import type { AskHit, AskResult } from "../src/ask/ask.js";
import { buildGraph } from "../src/graph/build.js";
import { callTool } from "../src/mcp/tools.js";
import { runCli } from "./helpers.js";

const TS = [
  "export function total(items: Item[]): number {",
  "  let sum = 0;",
  "  const rate = 0.1;",
  "  const floor = 2;",
  "  for (const item of items) {",
  "    sum += price(item);",
  "  }",
  "  if (sum > floor) {",
  "    sum = sum * rate;",
  "    sum = sum + floor;",
  "  }",
  "  return round(sum);",
  "}",
].join("\n");

test("foldCode keeps the signature, the call lines and the last line, and marks each run it elides", () => {
  assert.equal(
    foldCode(TS),
    [
      "export function total(items: Item[]): number {",
      "  ⋯ 4 lines",
      "    sum += price(item);",
      "  ⋯ 5 lines",
      "  return round(sum);",
      "}",
    ].join("\n"),
  );
});

test("foldCode reads a Python signature and does not count keywords as calls", () => {
  const py = ["def load(path,", "         strict=False):", "    if (strict):", "        x = 1", "        y = 2", "    return parse(path)"].join("\n");
  assert.equal(foldCode(py), ["def load(path,", "         strict=False):", "    ⋯ 3 lines", "    return parse(path)"].join("\n"));
});

test("foldCode keeps a signature whose parameters span lines, and counts macros and generic calls", () => {
  const button = ["export function Button({", "  label,", "  onClick,", "}: Props) {", "  const a = 1;", "  const b = 2;", "  return a + b;", "}"].join("\n");
  assert.equal(foldCode(button), ["export function Button({", "  label,", "  onClick,", "}: Props) {", "  ⋯ 3 lines", "}"].join("\n"));
  const rust = ["fn run() {", "    let a = 1;", "    let b = 2;", "    info!(\"{a}\");", "    let n = s.parse::<u32>();", "    let c = 3;", "    let d = 4;", "}"].join("\n");
  assert.equal(foldCode(rust), ["fn run() {", "    ⋯ 2 lines", "    info!(\"{a}\");", "    let n = s.parse::<u32>();", "    ⋯ 2 lines", "}"].join("\n"));
});

test("foldCode keeps an object return type, and a call with nested generics", () => {
  const load = ["function load(): {", "  id: string;", "  name: string;", "} {", "  const a = 1;", "  const b = 2;", "  const c = factory<Map<string, number>>(a);", "  return c;", "}"].join("\n");
  assert.equal(
    foldCode(load),
    ["function load(): {", "  id: string;", "  name: string;", "} {", "  ⋯ 2 lines", "  const c = factory<Map<string, number>>(a);", "  return c;", "}"].join("\n"),
  );
});

test("budgetAsk: text that is not ASCII is counted at a token a character", () => {
  const cjk = TS.replace("let sum = 0;", `let sum = 0; // ${"合計を計算する".repeat(20)}`);
  const r = budgetAsk(result([hit(1, cjk), hit(2, cjk), hit(3, cjk)]), 300);
  assert.ok(tokens(r.text) <= 300, `${tokens(r.text)} tokens\n${r.text}`);
});

test("foldCode leaves code with nothing to elide unchanged", () => {
  const code = "function f() {\n  return g();\n}";
  assert.equal(foldCode(code), code);
});

function hit(n: number, code?: string): AskHit {
  return { kind: "symbol", title: `fn${n}`, pointer: `src/f${n}.ts:L1-L13`, snippet: `does thing ${n}`, score: 10 - n, ...(code !== undefined && { code }) };
}
const result = (hits: AskHit[]): AskResult => ({ query: "q", mode: "lexical", hits });
// What budget.ts estimates: 4 ASCII characters a token, 1 for each other character.
const tokens = (text: string): number => Math.ceil(text.replace(/[^\x00-\x7f]/gu, "").length / 4) + [...text.replace(/[\x00-\x7f]/g, "")].length;

test("budgetAsk: room for all keeps the top hit whole and folds the rest, in rank order", () => {
  const r = budgetAsk(result([hit(1, TS), hit(2, TS), hit(3, TS)]), 2000);
  assert.deepEqual(r.result.hits.map((h) => h.title), ["fn1", "fn2", "fn3"]);
  assert.equal(r.result.hits[0].code, TS);
  assert.equal(r.result.hits[1].code, foldCode(TS));
  assert.deepEqual({ ...r.result.budget, used_tokens: 0 }, { max_tokens: 2000, used_tokens: 0, folded: 2, pointer_only: 0, omitted: 0 });
  assert.match(r.text, /\nbudget: about \d+ of 2000 tokens, 2 folded; for whole bodies, rerun with a larger max_tokens or without it, or read a pointer\n$/);
  assert.ok(tokens(r.text) <= 2000);
});

test("budgetAsk: a tight budget falls back to pointers, then leaves hits out, and stays inside it", () => {
  const hits = Array.from({ length: 8 }, (_, i) => hit(i + 1, TS));
  for (const max of [120, 200, 300]) {
    const r = budgetAsk(result(hits), max);
    const b = r.result.budget;
    assert.ok(tokens(r.text) <= max, `${max}: ${tokens(r.text)} tokens\n${r.text}`);
    assert.equal(b.used_tokens >= tokens(r.text) - 1, true);
    assert.equal(r.result.hits.length + b.omitted, 8, "every hit is shown or counted");
    assert.ok(b.omitted > 0, `${max}: something had to go`);
    assert.deepEqual(r.result.hits.map((h) => h.title), hits.slice(0, r.result.hits.length).map((h) => h.title), "the ranking holds");
  }
  // Some budget between these leaves room for a later hit's pointer but not its folded body.
  const fitted = Array.from({ length: 600 }, (_, k) => budgetAsk(result(hits), 60 + k).result);
  assert.ok(
    fitted.some((f) => f.hits.slice(1).some((h) => h.code === undefined) && f.budget.pointer_only > 0),
    "a hit that no longer fits folded is a pointer",
  );
});

test("budgetAsk: the first hit always shows, at least as its pointer", () => {
  const r = budgetAsk(result([hit(1, TS), hit(2, TS)]), 1);
  assert.equal(r.result.hits.length, 1);
  assert.equal(r.result.hits[0].pointer, "src/f1.ts:L1-L13");
  assert.equal(r.result.hits[0].code, undefined);
  assert.deepEqual({ ...r.result.budget, used_tokens: 0 }, { max_tokens: 1, used_tokens: 0, folded: 0, pointer_only: 1, omitted: 1 });
});

test("budgetAsk: a hit shown without code, such as a deployment file, stays as it is", () => {
  const r = budgetAsk(result([hit(1), hit(2, TS)]), 2000);
  assert.equal(r.result.hits[0].code, undefined);
  assert.equal(r.result.hits[0].snippet, "does thing 1");
  assert.equal(r.result.hits[1].code, foldCode(TS));
});

test("parseMaxTokens takes a whole number of at least 1", () => {
  assert.equal(parseMaxTokens(300), 300);
  assert.equal(parseMaxTokens("300"), 300);
  for (const bad of [0, -5, 1.5, "1e3", "", null, true]) assert.equal(typeof parseMaxTokens(bad), "string", String(bad));
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "graft-budget-"));
  mkdirSync(join(d, "src"), { recursive: true });
  for (let i = 1; i <= 6; i++) {
    writeFileSync(join(d, "src", `invoice${i}.ts`), TS.replace("total(", `invoiceTotal${i}(`).replace("Item[]", "Invoice[]") + "\n");
  }
  return d;
}

test("graft_find_code: max_tokens fits the answer, and without it the answer is as before", async () => {
  const d = repo();
  await buildGraph(d);
  const plain = await callTool(d, "graft_find_code", { query: "invoice total", limit: 6 });
  assert.doesNotMatch(plain.text, /\nbudget: /);
  const fitted = await callTool(d, "graft_find_code", { query: "invoice total", limit: 6, max_tokens: 250 });
  assert.equal(fitted.isError, false, fitted.text);
  assert.match(fitted.text, /\nbudget: about \d+ of 250 tokens/);
  assert.match(fitted.text, /left out/, "the budget cut the answer");
  assert.doesNotMatch(fitted.text, /don't re-ask/, "a search that found 6 hits is not called thin");
  const answer = fitted.text.slice(fitted.text.indexOf("\n") + 1);
  assert.ok(tokens(answer) <= 250, `${tokens(answer)} tokens\n${fitted.text}`);
  const bad = await callTool(d, "graft_find_code", { query: "invoice total", max_tokens: 0 });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /max_tokens must be a whole number of at least 1/);
});

test("ask --max-tokens: JSON gives the budget record; a bad value is refused", async () => {
  const d = repo();
  await buildGraph(d);
  const r = runCli(["ask", "invoice total", d, "--max-tokens", "250", "--json", "--no-refresh"]);
  assert.equal(r.status, 0, r.describe());
  const json = JSON.parse(r.stdout);
  assert.equal(json.budget.max_tokens, 250);
  assert.equal(json.hits.length + json.budget.omitted > 0, true);
  const bad = runCli(["ask", "invoice total", d, "--max-tokens", "lots", "--no-refresh"]);
  assert.equal(bad.status, 1, bad.describe());
  assert.match(bad.stderr, /--max-tokens must be a whole number of at least 1/);
});
