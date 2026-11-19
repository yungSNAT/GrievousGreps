/**
 * `trail blast` beyond the dependents of changed lines: the callers a declaration
 * change left unedited, and (`--tests`) the test files a change reaches.
 *
 * A signature change breaks its call sites, and those are the lines a diff most
 * often forgets, so they are named on their own. The unit tests pin the rules on a
 * hand-built graph; the CLI tests run them through a real build and a real git diff.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { runCli, tmpRepo } from "./helpers.js";
import { blastRadius, type LineReader } from "../src/blast/blast.js";
import { markdownReport, textReport } from "../src/blast/render.js";
import type { ChangedFile } from "../src/blast/diff.js";
import type { Confidence, GraphV1, NodeV1 } from "../src/graph/types.js";

const ADD = ["export function add(", "  a: number,", "  b: number,", "): number {", "  return a + b;", "}"];
const CALLER = (name: string): string[] => [`export function ${name}(): number {`, "  return add(1, 2);", "}"];

function node(id: string, span: string, extra: Partial<NodeV1> = {}): NodeV1 {
  const [path, name = path] = id.split("#");
  return {
    id, name, kind: "function", path, span, signature: null, exported: true,
    origin: "ast", body_hash: "", summary_state: "pending", summary: null, crux: null, ...extra,
  };
}

/** `add` in a.ts with a wrapped signature; `total` (c.ts) and `sum` (d.ts) call it. */
function graph(confidence: Confidence = "extracted"): GraphV1 {
  return {
    meta: { version: 1, nodeCount: 0, edgeCount: 0, languages: [] },
    nodes: [
      node("a.ts", "L1-L6", { kind: "file" }), node("c.ts", "L1-L3", { kind: "file" }), node("d.ts", "L1-L3", { kind: "file" }),
      node("a.ts#add", "L1-L6", { signature: "function add( a: number, b: number, ): number" }),
      node("c.ts#total", "L1-L3"), node("d.ts#sum", "L1-L3"),
    ],
    edges: [
      { source: "c.ts#total", target: "a.ts#add", relation: "calls", confidence },
      { source: "d.ts#sum", target: "a.ts#add", relation: "calls", confidence: "extracted" },
    ],
  };
}

const files: Record<string, string[]> = { "a.ts": ADD, "c.ts": CALLER("total"), "d.ts": CALLER("sum") };
const read: LineReader = (path) => files[path] ?? null;
const at = (path: string, ...lines: number[]): ChangedFile =>
  ({ path, status: "modified", ranges: lines.map((n) => ({ start: n, end: n })), hunks: [] });

test("blast: a change on a wrapped signature's third line leaves behind the callers whose call it did not edit", () => {
  // `sum`'s call line was edited with the signature; `total`'s was not.
  const report = blastRadius(graph(), [at("a.ts", 3), at("d.ts", 2)], "test", { depth: 2, read });
  assert.equal(report.seeds.find((s) => s.name === "add")?.declarationChanged, true);
  assert.deepEqual(report.leftBehind, [{
    seed: { id: "a.ts#add", name: "add" },
    id: "c.ts#total", name: "total", kind: "function", path: "c.ts", span: "L1-L3", line: 2,
  }]);
  assert.match(textReport(report), /⚠ 1 caller left behind: it calls a symbol whose declaration changed, and the diff did not edit the call\n {2}add ← total \(c\.ts:2\)\n/);
  assert.match(markdownReport(report), /⚠️ \*\*1 caller left behind\*\* by a changed declaration: `total` \(`c\.ts:2`\)\. The diff did not edit its call\./);
});

test("blast: a body-only change leaves no caller behind", () => {
  const report = blastRadius(graph(), [at("a.ts", 5)], "test", { depth: 2, read });
  assert.equal(report.seeds.find((s) => s.name === "add")?.declarationChanged, undefined);
  assert.deepEqual(report.leftBehind, []);
  assert.doesNotMatch(textReport(report), /left behind/);
  assert.doesNotMatch(markdownReport(report), /left behind/);
});

const hunk = (start: number, end: number, lines: [sign: "+" | "-", text: string][]): ChangedFile["hunks"][number] => {
  let n = start;
  return { start, end, dropped: 0, lines: lines.map(([sign, text]) => ({ n: sign === "+" ? n++ : null, sign, text })) };
};

test("blast: deleting a body line just under the signature is no declaration change", () => {
  // git records a pure deletion at the line before the gap: here the signature's last line.
  const file: ChangedFile = { path: "a.ts", status: "modified", ranges: [{ start: 4, end: 4 }], hunks: [hunk(4, 4, [["-", "  const unused = 1;"]])] };
  const report = blastRadius(graph(), [file], "test", { depth: 2, read });
  assert.equal(report.seeds.find((s) => s.name === "add")?.declarationChanged, undefined);
  assert.deepEqual(report.leftBehind, []);
});

test("blast: a declaration the diff removed and re-added as it was is not changed", () => {
  // git's alignment can remove and re-add an unchanged line; so does moving the function.
  const realigned = hunk(2, 2, [["-", "  a: number,"], ["+", "a: number,  "]]);
  const same = blastRadius(graph(), [{ path: "a.ts", status: "modified", ranges: [{ start: 2, end: 2 }], hunks: [realigned] }], "test", { depth: 2, read });
  assert.deepEqual(same.leftBehind, [], "one removed line matching the rewritten one");

  const moved: ChangedFile[] = [
    { path: "a.ts", status: "added", ranges: [{ start: 1, end: 6 }], hunks: [hunk(1, 6, ADD.map((t) => ["+", t] as ["+", string]))] },
    { path: "old.ts", status: "modified", ranges: [{ start: 3, end: 3 }], hunks: [hunk(3, 3, ADD.map((t) => ["-", t] as ["-", string]))] },
  ];
  assert.deepEqual(blastRadius(graph(), moved, "test", { depth: 2, read }).leftBehind, [], "moved from old.ts unchanged");

  const changedOnMove = [moved[0], { ...moved[1], hunks: [hunk(3, 3, ADD.filter((t) => !t.includes("b:")).map((t) => ["-", t] as ["-", string]))] }];
  assert.deepEqual(
    blastRadius(graph(), changedOnMove, "test", { depth: 2, read }).leftBehind?.map((c) => c.name),
    ["total", "sum"],
    "moved and given a parameter",
  );
});

test("blast: an edit elsewhere in a caller is not an edit to its call", () => {
  const withTail = { ...files, "c.ts": [...CALLER("total").slice(0, 2), "  // reviewed", "}"] };
  const g = graph();
  g.nodes = g.nodes.map((n) => (n.id === "c.ts#total" ? { ...n, span: "L1-L4" } : n));
  const report = blastRadius(g, [at("a.ts", 3), at("c.ts", 3)], "test", { depth: 2, read: (p) => withTail[p] ?? null });
  assert.deepEqual(report.leftBehind?.map((c) => [c.name, c.line]), [["total", 2], ["sum", 2]]);
});

test("blast: a changed argument on a later line of a wrapped call is an edit to the call", () => {
  const wrapped = { ...files, "c.ts": ["export function total(): number {", "  return add(", "    1,", "    2,", "  ) + 0;", "  // after", "}"] };
  const g = graph();
  g.nodes = g.nodes.map((n) => (n.id === "c.ts#total" ? { ...n, span: "L1-L7" } : n));
  const opts = { depth: 2, read: (p: string) => wrapped[p] ?? null };
  assert.deepEqual(blastRadius(g, [at("a.ts", 3), at("c.ts", 4)], "test", opts).leftBehind?.map((c) => c.name), ["sum"]);
  assert.deepEqual(
    blastRadius(g, [at("a.ts", 3), at("c.ts", 6)], "test", opts).leftBehind?.map((c) => [c.name, c.line]),
    [["total", 2], ["sum", 2]],
    "a line after the call's closing parenthesis is not the call",
  );
});

test("blast: deleting an argument line of a wrapped call is an edit to the call", () => {
  const wrapped = { ...files, "c.ts": ["export function total(): number {", "  return add(", "    1,", "  );", "}"] };
  const g = graph();
  g.nodes = g.nodes.map((n) => (n.id === "c.ts#total" ? { ...n, span: "L1-L5" } : n));
  // `    2,` was deleted after line 3: git places the gap at line 3, inside the call.
  const c: ChangedFile = { path: "c.ts", status: "modified", ranges: [{ start: 3, end: 3 }], hunks: [hunk(3, 3, [["-", "    2,"]])] };
  const report = blastRadius(g, [at("a.ts", 3), c], "test", { depth: 2, read: (p) => wrapped[p] ?? null });
  assert.deepEqual(report.leftBehind?.map((x) => x.name), ["sum"]);
});

test("blast: a caller whose second call was left alone is left behind at that call, and a comment is no call", () => {
  const twice = {
    ...files,
    "c.ts": ["export function total(): number {", "  // add(1, 2) was add(1)", "  const x = add(1, 2);", "  return add(3) + x;", "}"],
  };
  const g = graph();
  g.nodes = g.nodes.map((n) => (n.id === "c.ts#total" ? { ...n, span: "L1-L5" } : n));
  const opts = { depth: 2, read: (p: string) => twice[p] ?? null };
  const updatedFirst = blastRadius(g, [at("a.ts", 3), at("c.ts", 2, 3), at("d.ts", 2)], "test", opts);
  assert.deepEqual(updatedFirst.leftBehind?.map((x) => [x.name, x.line]), [["total", 4]]);
  // Only the comment changed: both calls are left behind, and the first is the one named.
  const commentOnly = blastRadius(g, [at("a.ts", 3), at("c.ts", 2), at("d.ts", 2)], "test", opts);
  assert.deepEqual(commentOnly.leftBehind?.map((x) => [x.name, x.line]), [["total", 3]]);
});

test("blast: every call starting on a line is checked, and a trailing or block comment is no call", () => {
  // The inner call runs over lines 2 to 4 and the outer one to line 6; only the outer's argument changed.
  const nested = {
    ...files,
    "c.ts": ["export function total(): number {", "  return add(add(", "    1,", "  ),", "    2, // add(", "  ); /* add( */", "}"],
  };
  const g = graph();
  g.nodes = g.nodes.map((n) => (n.id === "c.ts#total" ? { ...n, span: "L1-L7" } : n));
  const opts = { depth: 2, read: (p: string) => nested[p] ?? null };
  const outer = blastRadius(g, [at("a.ts", 3), at("c.ts", 5), at("d.ts", 2)], "test", opts);
  assert.deepEqual(outer.leftBehind?.map((x) => [x.name, x.line]), [["total", 2]], "the inner call was left alone");
  // Both calls edited: the `add(` in each comment is no call left alone.
  const both = blastRadius(g, [at("a.ts", 3), at("c.ts", 3, 5), at("d.ts", 2)], "test", opts);
  assert.deepEqual(both.leftBehind, []);
});

test("blast: a comment marker inside quotes hides no call, and one with no space before it still starts a comment", () => {
  const quoted = {
    ...files,
    "c.ts": [
      "export function total(): number {", "  const x = add(1, 2);",
      '  const note = "text // marker"; const y = add(3);', "  const tag = 'a #b'; const z = add(4);",
      "  const n = 1;// add(2)", "  return x + y + z + n;", "}",
    ],
  };
  const g = graph();
  g.nodes = g.nodes.map((n) => (n.id === "c.ts#total" ? { ...n, span: "L1-L7" } : n));
  const opts = { depth: 2, read: (p: string) => quoted[p] ?? null };
  const left = (...lines: number[]) =>
    blastRadius(g, [at("a.ts", 3), at("c.ts", ...lines), at("d.ts", 2)], "test", opts).leftBehind?.map((x) => [x.name, x.line]);
  assert.deepEqual(left(2, 3), [["total", 4]], "the call after a quoted `#`");
  assert.deepEqual(left(2, 4), [["total", 3]], "the call after a quoted `//`");
  assert.deepEqual(left(2, 3, 4), [], "`// add(2)` is a comment");
});

/** The callers left behind with `total` in `path` as `src`, when its line `edited` and `sum`'s call changed. */
function leftIn(path: string, src: string[], edited: number): unknown[] | undefined {
  const g = graph();
  g.nodes = g.nodes.map((n) => (n.id === "c.ts#total" ? { ...n, path, span: `L1-L${src.length}` } : n));
  const all: Record<string, string[]> = { ...files, [path]: src };
  const report = blastRadius(g, [at("a.ts", 3), at(path, edited), at("d.ts", 2)], "test", { depth: 2, read: (p) => all[p] ?? null });
  return report.leftBehind?.map((x) => [x.name, x.path, x.line]);
}

/** Comments read by the file's syntax: [case, path, the caller's lines, its edited line, the left-behind line or none]. */
const SYNTAX_CASES: [string, string, string[], number, number | null][] = [
  ["Python: `//` divides, `#` comments", "c.py", ["def total():", "    x = add(1, 2)", "    return x // add(3)  # add("], 2, 3],
  [
    "a block comment spans lines; a line starting with `*` outside one is code", "c.go",
    ["func total() int {", "\t/* add(1) was", "\t   add(2) */", "\tx := add(1, 2)", "\t*out = add(3)", "\treturn x", "}"], 4, 5,
  ],
  ["`\\/*` in a regex literal opens no block comment", "c.ts", ["export function total(): number {", "  const x = add(1, 2);", '  const t = s.replace(/\\/*$/, "");', "  return add(3) + x;", "}"], 2, 4],
  ["Swift: `#` is no comment", "c.swift", ["func total() -> Int {", "    let x = add(1, 2)", "    #expect(add(3) == 3)", "    return x", "}"], 2, 3],
  ["Rust: a lifetime opens no quote", "c.rs", ["fn total() -> i32 {", "    let x = add(1, 2);", "    const M: &'static str = \"it's // x\"; let y = add(3);", "    x + y", "}"], 2, 3],
  ["Lua: `--` comments", "c.lua", ["local function total()", "  local x = add(1, 2)", "  return x -- add(2)", "end"], 2, null],
];

for (const [label, path, src, edited, line] of SYNTAX_CASES) {
  test(`blast: comments by the file's syntax: ${label}`, () => {
    assert.deepEqual(leftIn(path, src, edited), line === null ? [] : [["total", path, line]]);
  });
}

test("blast: whitespace changed inside a default string is no declaration change", () => {
  // What a caller must pass is unchanged, so no call is left behind (round 2's S9, declined).
  const g: GraphV1 = {
    meta: { version: 1, nodeCount: 0, edgeCount: 0, languages: [] },
    nodes: [node("g.ts", "L1-L3", { kind: "file" }), node("g.ts#greet", "L1-L3", { signature: 'function greet(s = "ab"): string' })],
    edges: [],
  };
  const src = ['export function greet(s = "ab"): string {', "  return s;", "}"];
  const file: ChangedFile = { path: "g.ts", status: "modified", ranges: [{ start: 1, end: 1 }], hunks: [hunk(1, 1, [["-", 'export function greet(s = "a b"): string {'], ["+", src[0]]])] };
  const report = blastRadius(g, [file], "test", { depth: 2, read: (p) => (p === "g.ts" ? src : null) });
  assert.equal(report.seeds.find((s) => s.name === "greet")?.declarationChanged, undefined);
});

test("blast: with no file to read, the first line is the declaration and any edit in a caller's span counts", () => {
  assert.deepEqual(blastRadius(graph(), [at("a.ts", 3)], "test", { depth: 2 }).leftBehind, [], "line 3 is past the first line");
  const report = blastRadius(graph(), [at("a.ts", 1), at("d.ts", 3)], "test", { depth: 2 });
  assert.deepEqual(report.leftBehind?.map((c) => [c.name, c.line]), [["total", undefined]]);
  assert.match(textReport(report), /add ← total \(c\.ts:L1-L3\)/);
});

test("blast: a left-behind caller reached by an inferred edge is marked", () => {
  const report = blastRadius(graph("inferred"), [at("a.ts", 2)], "test", { depth: 2, read });
  const byName = new Map(report.leftBehind?.map((c) => [c.name, c.inferred]));
  assert.deepEqual([...byName], [["total", true], ["sum", undefined]]);
  assert.match(textReport(report), /add ← total \(c\.ts:2\) \[inferred\]/);
});

test("blast: a changed __init__ leaves behind the calls that construct its class", () => {
  const g: GraphV1 = {
    meta: { version: 1, nodeCount: 0, edgeCount: 0, languages: [] },
    nodes: [
      node("shop.py", "L1-L4", { kind: "file" }), node("use.py", "L1-L2", { kind: "file" }),
      node("shop.py#Cart", "L1-L4", { kind: "class", signature: "class Cart" }),
      node("shop.py#Cart.__init__", "L2-L3", { name: "__init__", kind: "method", owner: "Cart", signature: "def __init__(self, items)" }),
      node("use.py#make", "L1-L2"),
    ],
    edges: [{ source: "use.py#make", target: "shop.py#Cart", relation: "calls", confidence: "extracted" }],
  };
  const py: Record<string, string[]> = {
    "shop.py": ["class Cart:", "    def __init__(self, items):", "        self.items = items", ""],
    "use.py": ["def make():", "    return Cart()"],
  };
  const report = blastRadius(g, [at("shop.py", 2)], "test", { depth: 2, read: (p) => py[p] ?? null });
  assert.deepEqual(report.leftBehind?.map((c) => [c.seed.name, c.name, c.line]), [["__init__", "make", 2]]);
});

test("blast: the Markdown line names 5 left-behind callers and counts the rest", () => {
  const g = graph();
  for (let i = 0; i < 7; i++) {
    g.nodes.push(node(`e${i}.ts`, "L1-L3", { kind: "file" }), node(`e${i}.ts#c${i}`, "L1-L3"));
    g.edges.push({ source: `e${i}.ts#c${i}`, target: "a.ts#add", relation: "calls", confidence: "extracted" });
  }
  const md = markdownReport(blastRadius(g, [at("a.ts", 1)], "test", { depth: 1 }));
  assert.match(md, /\*\*9 callers left behind\*\*/);
  assert.match(md, /, \+4 more, all in `--format json`\. The diff did not edit their calls\./);
});

function git(dir: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
}

/** A committed, built repo; `files` maps repo paths to their text. */
function builtRepo(t: { after: (fn: () => void) => void }, tree: Record<string, string>): string {
  const d = tmpRepo("blast-behind");
  t.after(() => rmSync(d, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(tree)) {
    mkdirSync(join(d, path, ".."), { recursive: true });
    writeFileSync(join(d, path), text);
  }
  git(d, "init", "-b", "main");
  git(d, "config", "user.email", "test@example.com");
  git(d, "config", "user.name", "test");
  git(d, "add", "-A");
  git(d, "commit", "-m", "initial");
  const build = runCli(["build", d]);
  assert.equal(build.status, 0, build.describe());
  git(d, "add", "-A");
  git(d, "commit", "-m", "index");
  return d;
}

const TS_TREE: Record<string, string> = {
  "src/math.ts": "export function add(\n  a: number,\n  b: number,\n): number {\n  return a + b;\n}\n",
  "src/total.ts": 'import { add } from "./math.js";\nexport function total(xs: number[]): number {\n  return xs.reduce((s, x) => add(s, x), 0);\n}\n',
  "src/area.ts": 'import { add } from "./math.js";\nexport function area(w: number): number {\n  return add(w, w);\n}\n',
  "src/report.ts": 'import { total } from "./total.js";\nexport function report(xs: number[]): string {\n  return `sum=${total(xs)}`;\n}\n',
  "test/math.test.ts": 'import { add } from "../src/math.js";\nexport function checksAdd(): boolean {\n  return add(1, 2) === 3;\n}\n',
  "test/report.test.ts": 'import { report } from "../src/report.js";\nexport function checksReport(): boolean {\n  return report([1]) === "sum=1";\n}\n',
  "test/other.test.ts": "export function checksNothing(): boolean {\n  return true;\n}\n",
};

function blastJson(args: string[]): Record<string, unknown> & {
  seeds: { name: string; declarationChanged?: true }[];
  leftBehind?: { seed: { name: string }; name: string; path: string; line?: number }[];
  tests?: { path: string; depth: number; changed?: true; symbols: string[] }[];
} {
  const r = runCli(["blast", ...args, "--format", "json"]);
  assert.equal(r.status, 0, r.describe());
  return JSON.parse(r.stdout);
}

test("blast CLI: a new parameter names each caller whose call the diff left alone, at its call line", (t) => {
  const d = builtRepo(t, TS_TREE);
  writeFileSync(join(d, "src/math.ts"), TS_TREE["src/math.ts"].replace("  b: number,\n", "  b: number,\n  c = 0,\n"));
  writeFileSync(join(d, "src/area.ts"), TS_TREE["src/area.ts"].replace("add(w, w)", "add(w, w, 0)"));

  const report = blastJson([d]);
  assert.equal(report.seeds.find((s) => s.name === "add")?.declarationChanged, true);
  assert.deepEqual(
    report.leftBehind?.map((c) => [c.seed.name, c.name, c.path, c.line]),
    [["add", "total", "src/total.ts", 3], ["add", "checksAdd", "test/math.test.ts", 3]],
    "area's call was edited, so only total and the test are left behind",
  );
  const text = runCli(["blast", d]);
  assert.equal(text.status, 0, text.describe());
  assert.match(text.stdout, /⚠ 2 callers left behind/);
  assert.match(text.stdout, /add ← total \(src\/total\.ts:3\)/);
});

test("blast CLI: a body edit reports no caller left behind, nor does deleting the body's first line", (t) => {
  const d = builtRepo(t, { ...TS_TREE, "src/math.ts": TS_TREE["src/math.ts"].replace("  return", "  const s = a + b;\n  return") });
  writeFileSync(join(d, "src/math.ts"), TS_TREE["src/math.ts"].replace("a + b", "b + a"));
  const report = blastJson([d]);
  assert.equal(report.seeds.find((s) => s.name === "add")?.declarationChanged, undefined);
  assert.deepEqual(report.leftBehind, []);

  // A pure deletion: git places its range on the line before, the signature's last.
  writeFileSync(join(d, "src/math.ts"), TS_TREE["src/math.ts"]);
  const deleted = blastJson([d]);
  assert.deepEqual((deleted.changed as { ranges: unknown }[])[0].ranges, [{ start: 4, end: 4 }]);
  assert.deepEqual(deleted.seeds.map((s) => [s.name, s.declarationChanged]), [["add", undefined]]);
  assert.deepEqual(deleted.leftBehind, []);
});

test("blast CLI: wrapping a signature as a formatter does, trailing comma included, is no declaration change", (t) => {
  const oneLine = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
  const d = builtRepo(t, { ...TS_TREE, "src/math.ts": oneLine });
  writeFileSync(join(d, "src/math.ts"), TS_TREE["src/math.ts"]);
  const report = blastJson([d]);
  assert.deepEqual(report.seeds.map((s) => [s.name, s.declarationChanged]), [["add", undefined]]);
  assert.deepEqual(report.leftBehind, []);
});

test("blast CLI: a const arrow's one-line body is not its declaration, its parameters are", (t) => {
  const inc = "export const inc = (n: number): number => n + 1;\n";
  const d = builtRepo(t, {
    "src/inc.ts": inc,
    "src/use.ts": 'import { inc } from "./inc.js";\nexport function twice(n: number): number {\n  return inc(inc(n));\n}\n',
  });
  writeFileSync(join(d, "src/inc.ts"), inc.replace("n + 1", "n + 2"));
  const body = blastJson([d]);
  assert.deepEqual(body.seeds.map((s) => [s.name, s.declarationChanged]), [["inc", undefined]]);
  assert.deepEqual(body.leftBehind, []);

  writeFileSync(join(d, "src/inc.ts"), inc.replace("(n: number)", "(n: number, by: number)"));
  assert.deepEqual(blastJson([d]).leftBehind?.map((c) => [c.name, c.line]), [["twice", 3]]);
});

test("blast CLI: a Rust signature wrapped over several lines counts a change on its third line", (t) => {
  const lib = "pub fn add(\n    a: u32,\n    b: u32,\n) -> u32 {\n    a + b\n}\n\npub fn total() -> u32 {\n    add(1, 2)\n}\n";
  const d = builtRepo(t, { "Cargo.toml": '[package]\nname = "m"\nversion = "0.1.0"\nedition = "2021"\n', "src/lib.rs": lib });
  writeFileSync(join(d, "src/lib.rs"), lib.replace("b: u32,", "b: u64,"));
  const report = blastJson([d]);
  assert.equal(report.seeds.find((s) => s.name === "add")?.declarationChanged, true);
  assert.deepEqual(report.leftBehind?.map((c) => [c.seed.name, c.name, c.line]), [["add", "total", 9]]);

  writeFileSync(join(d, "src/lib.rs"), lib.replace("a + b", "b + a"));
  assert.deepEqual(blastJson([d]).leftBehind, [], "a body edit");
});

test("blast CLI: a decorated Python function's parameters are its declaration", (t) => {
  const geo = "import functools\n\n\n@functools.cache\ndef area(w, h):\n    return w * h\n";
  const d = builtRepo(t, { "geo.py": geo, "use.py": "from geo import area\n\n\ndef square(s):\n    return area(s, s)\n" });
  writeFileSync(join(d, "geo.py"), geo.replace("def area(w, h):", "def area(w, h, d):"));
  assert.deepEqual(blastJson([d]).leftBehind?.map((c) => [c.name, c.line]), [["square", 5]]);
  writeFileSync(join(d, "geo.py"), geo.replace("w * h", "h * w"));
  assert.deepEqual(blastJson([d]).leftBehind, [], "a body edit");
});

test("blast CLI: a Python __init__ change names the calls that construct the class", (t) => {
  const d = builtRepo(t, {
    "shop/cart.py": "class Cart:\n    def __init__(self):\n        self.items = []\n",
    "shop/use.py": "from shop.cart import Cart\n\n\ndef make():\n    return Cart()\n",
  });
  writeFileSync(join(d, "shop/cart.py"), "class Cart:\n    def __init__(self, items):\n        self.items = items\n");
  const report = blastJson([d]);
  assert.deepEqual(report.leftBehind?.map((c) => [c.seed.name, c.name, c.line]), [["__init__", "make", 5]]);
});

test("blast CLI --tests: lists every test file the change reaches past --depth, and only with the flag", (t) => {
  const d = builtRepo(t, TS_TREE);
  writeFileSync(join(d, "src/math.ts"), TS_TREE["src/math.ts"].replace("a + b", "b + a"));
  writeFileSync(join(d, "test/other.test.ts"), TS_TREE["test/other.test.ts"].replace("true", "!false"));

  assert.equal(blastJson([d, "--depth", "1"]).tests, undefined, "absent without --tests");
  const report = blastJson([d, "--depth", "1", "--tests"]);
  assert.deepEqual(report.tests, [
    { path: "test/other.test.ts", depth: 0, changed: true, symbols: [] },
    { path: "test/math.test.ts", depth: 1, symbols: ["checksAdd"] },
    // add ← total ← report ← checksReport: 3 hops, past --depth 1.
    { path: "test/report.test.ts", depth: 3, symbols: ["checksReport"] },
  ]);

  const text = runCli(["blast", d, "--depth", "1", "--tests"]);
  assert.equal(text.status, 0, text.describe());
  assert.match(text.stdout, /tests reaching this change \(full closure\): 3 files\n {2}test\/other\.test\.ts — changed in this diff\n {2}test\/math\.test\.ts — depth 1 · checksAdd\n {2}test\/report\.test\.ts — depth 3 · checksReport\n/);
  const md = runCli(["blast", d, "--depth", "1", "--tests", "--format", "markdown"]);
  assert.equal(md.status, 0, md.describe());
  assert.match(md.stdout, /<summary><strong>Tests reaching this change<\/strong> — 3 test files, full closure<\/summary>/);
  assert.match(md.stdout, /- `test\/report\.test\.ts` — depth 3 · checksReport/);
});

test("blast --tests: says when no test file is reached, and why one can be missing", () => {
  const report = blastRadius(graph(), [at("a.ts", 5)], "test", { depth: 2, read, tests: true });
  assert.deepEqual(report.tests, []);
  assert.match(textReport(report), /tests reaching this change \(full closure\): none found \(a test that runs the code through a CLI or a spawned process has no edge, so it is not listed\)/);
  assert.match(markdownReport(report), /Tests reaching this change<\/strong> — none found, full closure/);
});
