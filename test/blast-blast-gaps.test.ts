/**
 * Gap coverage for src/blast/blast.ts: seeding, merged walks, declaration changes,
 * callers left behind, unresolved names, test reach, area grouping and folding.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { blastRadius, blastRadiusIn, hubLabel } from "../src/blast/blast.js";
import type { BlastReport, LineReader } from "../src/blast/blast.js";
import type { GraphV1 } from "../src/graph/types.js";
import type { ChangedFile } from "../src/blast/diff.js";
import type { ModuleIndex } from "../src/blast/modules.js";

type Line = { sign: "+" | "-" | " "; text: string };

function node(id: string, kind: string, name: string, path: string, span: string, extra: Record<string, unknown> = {}) {
  return { id, kind, name, path, span, ...extra };
}

function hunk(start: number, end: number, lines: Line[]) {
  return { start, end, lines, dropped: 0 };
}

function changedFile(path: string, status: string, ranges: { start: number; end: number }[], hunks: unknown[]): ChangedFile {
  return { path, status, ranges, hunks } as unknown as ChangedFile;
}

const FILES: Record<string, string[]> = {
  "src/a.ts": [
    "export function foo(x: number, y: number): number {",
    "  return x + y;",
    "}",
    "",
    "export class Cls {",
    "  constructor(a: string) {",
    "    this.a = a;",
    "  }",
    "}",
  ],
  "src/b.ts": ["export function bar() {", "  return 1;", "}"],
  "src/c.ts": [
    'import { foo, Cls } from "./a.js";',
    'import { bar } from "./b.js";',
    "export function useFoo() {",
    "  // foo(1) is how it used to be called",
    "  return foo(1, 2) + bar();",
    "}",
  ],
  "test/a.test.ts": ['test("foo", () => {', "  foo(1, 2);", "});"],
  "test/b.test.ts": ['test("bar", () => {', "  bar();", "});"],
};

const read: LineReader = (p) => FILES[p] ?? null;

function graph(): GraphV1 {
  return {
    nodes: [
      node("f:src/a.ts", "file", "a.ts", "src/a.ts", "L1-L9"),
      node("f:src/b.ts", "file", "b.ts", "src/b.ts", "L1-L3"),
      node("f:src/c.ts", "file", "c.ts", "src/c.ts", "L1-L6"),
      node("f:src/d.ts", "file", "d.ts", "src/d.ts", "L1-L4"),
      node("f:test/a.test.ts", "file", "a.test.ts", "test/a.test.ts", "L1-L3"),
      node("f:test/b.test.ts", "file", "b.test.ts", "test/b.test.ts", "L1-L3"),
      node("foo", "function", "foo", "src/a.ts", "L1-L3", { signature: "function foo(x: number, y: number): number" }),
      node("Cls", "class", "Cls", "src/a.ts", "L5-L9"),
      node("ctor", "method", "constructor", "src/a.ts", "L6-L8", { owner: "Cls", signature: "constructor(a: string)" }),
      node("bar", "function", "bar", "src/b.ts", "L1-L3", { signature: "function bar()" }),
      node("useFoo", "function", "useFoo", "src/c.ts", "L3-L6", { signature: "function useFoo()" }),
      node("runFoo", "function", "runFoo", "test/a.test.ts", "L1-L3"),
      node("runBar", "function", "runBar", "test/b.test.ts", "L1-L3"),
    ],
    edges: [
      { source: "useFoo", target: "bar", relation: "calls", confidence: "inferred" },
      { source: "useFoo", target: "foo", relation: "calls", confidence: "inferred" },
      { source: "useFoo", target: "foo", relation: "calls", confidence: "extracted" },
      { source: "useFoo", target: "Cls", relation: "calls", confidence: "extracted" },
      { source: "runFoo", target: "foo", relation: "calls", confidence: "extracted" },
      { source: "runBar", target: "bar", relation: "calls", confidence: "inferred" },
      { source: "ghost", target: "foo", relation: "calls", confidence: "extracted" },
      { source: "f:src/c.ts", target: "f:src/d.ts", relation: "imports", confidence: "extracted" },
    ],
    unresolvedCalls: [{ name: "foo" }, { name: "zzz" }, { name: "bar" }, { name: "foo" }],
  } as unknown as GraphV1;
}

function changes(): ChangedFile[] {
  return [
    // b.ts first: its inferred reach of useFoo is replaced by a.ts's definite one.
    changedFile("src/b.ts", "modified", [{ start: 2, end: 2 }], []),
    changedFile("src/a.ts", "modified", [{ start: 1, end: 1 }, { start: 6, end: 6 }], [
      hunk(1, 1, [
        { sign: "-", text: "export function foo(x: number): number {" },
        { sign: "+", text: FILES["src/a.ts"][0] },
      ]),
      hunk(6, 6, [
        { sign: "-", text: "  constructor() {" },
        { sign: "+", text: FILES["src/a.ts"][5] },
      ]),
    ]),
    changedFile("src/d.ts", "modified", [], []),
    changedFile("src/gone.ts", "deleted", [], []),
    changedFile("docs/readme.md", "modified", [{ start: 1, end: 1 }], []),
    changedFile("test/a.test.ts", "modified", [{ start: 2, end: 2 }], [
      hunk(2, 2, [
        { sign: "-", text: "  foo(1);" },
        { sign: "+", text: "  foo(1, 2);" },
      ]),
    ]),
  ];
}

describe("blastRadius over a small hand-built graph", () => {
  let r: BlastReport;
  before(() => {
    r = blastRadius(graph(), changes(), "main...HEAD", { depth: 3, read, tests: true });
  });

  test("deleted and unindexed paths are reported, not seeded", () => {
    assert.deepEqual(r.deleted, ["src/gone.ts"]);
    assert.deepEqual(r.unindexed, ["docs/readme.md"]);
    assert.equal(r.basis, "main...HEAD");
    assert.equal(r.depth, 3);
  });

  test("innermost symbols seed, a rangeless file seeds as a whole", () => {
    const byId = new Map(r.seeds.map((s) => [s.id, s]));
    assert.ok(byId.has("foo"));
    assert.ok(byId.has("ctor"), "the method, not its class");
    assert.ok(!byId.has("Cls"));
    assert.ok(byId.has("bar"));
    assert.equal(byId.get("f:src/d.ts")?.wholeFile, true);
    assert.equal(byId.get("foo")?.declarationChanged, true);
    assert.equal(byId.get("ctor")?.declarationChanged, true);
    // bar's edit is in its body, and with no hunk text only the ranges are compared.
    assert.equal(byId.get("bar")?.declarationChanged, undefined);
    assert.equal(byId.get("runFoo")?.declarationChanged, undefined);
  });

  test("a dependent reached from two files keeps the definite path and both origins", () => {
    const useFoo = r.impacted.find((i) => i.id === "useFoo") ?? assert.fail("useFoo not impacted");
    assert.equal(useFoo.depth, 1);
    assert.equal(useFoo.inferred, undefined);
    assert.ok(!r.impacted.some((i) => i.id === "ghost"), "an endpoint with no node is dropped");

    const mod = r.modules.find((m) => m.files.includes("src/c.ts")) ?? assert.fail("no module for c.ts");
    assert.deepEqual(mod.from, ["src/a.ts", "src/b.ts", "src/d.ts"]);
    assert.equal(mod.labelSource, "symbol");
    assert.ok(!r.modules.some((m) => m.files.some((f) => f.startsWith("test/"))));
    assert.ok(r.testModules.some((m) => m.files.includes("test/b.test.ts")));
    assert.ok(!r.testModules.some((m) => m.files.includes("test/a.test.ts")), "a changed file is the diff, not reach");
  });

  test("unresolved calls are counted per changed symbol name", () => {
    assert.deepEqual(r.unresolved, [
      { name: "foo", calls: 2 },
      { name: "bar", calls: 1 },
    ]);
  });

  test("callers whose call the diff did not edit are left behind", () => {
    const lb = r.leftBehind ?? assert.fail("expected leftBehind");
    const viaFoo = lb.find((l) => l.seed.id === "foo") ?? assert.fail("foo caller missing");
    assert.equal(viaFoo.id, "useFoo");
    assert.equal(viaFoo.line, 5, "the commented-out mention on line 4 is skipped");
    assert.equal(viaFoo.inferred, undefined, "a definite edge clears the inferred mark");
    assert.ok(!lb.some((l) => l.id === "runFoo"), "the test's call was edited");

    const viaCtor = lb.find((l) => l.seed.id === "ctor") ?? assert.fail("constructor caller missing");
    assert.equal(viaCtor.id, "useFoo");
    assert.equal(viaCtor.seed.name, "constructor");
    assert.equal(viaCtor.line, undefined, "no line names Cls inside the caller");
  });

  test("tests reached: the edited test at depth 0, the inferred one flagged", () => {
    const tests = r.tests ?? assert.fail("tests requested");
    const a = tests.find((t) => t.path === "test/a.test.ts") ?? assert.fail("a.test missing");
    assert.equal(a.depth, 0);
    assert.equal(a.changed, true);
    assert.equal(a.inferred, undefined);
    // runFoo is itself a seed (the diff edits it), so the walk never reaches it as a dependent.
    assert.deepEqual(a.symbols, []);
    const b = tests.find((t) => t.path === "test/b.test.ts") ?? assert.fail("b.test missing");
    assert.equal(b.depth, 1);
    assert.equal(b.inferred, true);
    assert.deepEqual(b.symbols, ["runBar"]);
    assert.equal(b.changed, undefined);
    assert.equal(tests[0].path, "test/a.test.ts");
  });

  test("the changed area carries its test signal and hub", () => {
    assert.equal(r.areas.length, 1, "test files are never an area");
    const area = r.areas[0];
    assert.deepEqual(area.files, ["src/a.ts", "src/b.ts", "src/d.ts"]);
    assert.equal(area.behavioural, 3);
    assert.equal(area.reached, 2);
    assert.deepEqual(area.unreached, ["constructor"]);
    assert.deepEqual(area.testFiles, ["test/a.test.ts", "test/b.test.ts"]);
    assert.deepEqual(area.changedTestFiles, ["test/a.test.ts"]);
    assert.equal(area.tests, "changed");
    assert.equal(area.seedNames[0], "foo", "most-depended-on behaviour first");
    assert.equal(area.labelSource, "symbol");
  });

  test("without tests asked for, no tests key", () => {
    const plain = blastRadius(graph(), changes(), "b", { depth: 1, read });
    assert.equal("tests" in plain, false);
  });
});

test("blastRadius: a concept claiming every file names the area and the module", () => {
  const index: ModuleIndex = {
    hasConcepts: true,
    labelOf: (p) => p,
    conceptOf: (p) => (p.startsWith("src/") ? "Core Logic" : null),
  } as ModuleIndex;
  const r = blastRadius(graph(), changes(), "b", { depth: 2, read, modules: index });
  assert.equal(r.areas[0].labelSource, "concept");
  const mod = r.modules.find((m) => m.files.includes("src/c.ts")) ?? assert.fail("module missing");
  assert.equal(mod.labelSource, "concept");
  assert.equal(mod.key, "Core Logic");
});

test("blastRadius: without the checkout, a touched first line is a declaration change", () => {
  const r = blastRadius(graph(), changes(), "b", { depth: 1 });
  const foo = r.seeds.find((s) => s.id === "foo") ?? assert.fail("foo seed");
  assert.equal(foo.declarationChanged, true);
  const lb = r.leftBehind ?? [];
  // Without the file, any change inside the caller's span would count as the edit;
  // c.ts is untouched, so useFoo stays behind with no line to point at.
  const viaFoo = lb.find((l) => l.seed.id === "foo" && l.id === "useFoo") ?? assert.fail("useFoo missing");
  assert.equal(viaFoo.line, undefined);
});

test("blastRadius: deleting a body line or moving a declaration is not a signature change", () => {
  const lines = ["export function foo() {", "  return 1;", "}", "", "export function baz() {", "  return 2;", "}"];
  const g = {
    nodes: [
      node("f:src/m.ts", "file", "m.ts", "src/m.ts", "L1-L7"),
      node("foo", "function", "foo", "src/m.ts", "L1-L3", { signature: "function foo()" }),
      node("baz", "function", "baz", "src/m.ts", "L5-L7", { signature: "function baz()" }),
    ],
    edges: [],
  } as unknown as GraphV1;
  const file = changedFile("src/m.ts", "modified", [{ start: 1, end: 1 }, { start: 5, end: 7 }], [
    // Pure deletion right after foo's first line: the gap is inside the body.
    hunk(1, 1, [{ sign: "-", text: "  const x = 2;" }]),
    // baz added here, and removed from elsewhere unchanged: it moved as it stood.
    hunk(5, 7, [
      { sign: "+", text: lines[4] },
      { sign: "+", text: lines[5] },
      { sign: "+", text: lines[6] },
    ]),
    hunk(7, 7, [
      { sign: "-", text: "export function baz() {" },
      { sign: "-", text: "  return 2;" },
      { sign: "-", text: "}" },
    ]),
  ]);
  const r = blastRadius(g, [file], "b", { depth: 1, read: (p) => (p === "src/m.ts" ? lines : null) });
  const seeds = new Map(r.seeds.map((s) => [s.id, s]));
  assert.ok(seeds.has("foo") && seeds.has("baz"));
  assert.equal(seeds.get("foo")?.declarationChanged, undefined);
  assert.equal(seeds.get("baz")?.declarationChanged, undefined);
  assert.deepEqual(r.leftBehind, []);
  assert.deepEqual(r.unresolved, [], "no unresolvedCalls in the graph");
  assert.equal(r.areas[0].tests, "none");
});

test("blastRadius: many directories fold into at most five areas", () => {
  const dirs = ["a", "b", "c", "d", "e", "f", "g"];
  const g = {
    nodes: dirs.map((d) => node(`f:lib/${d}/x.ts`, "file", `${d}x`, `lib/${d}/x.ts`, "L1-L2")),
    edges: [],
  } as unknown as GraphV1;
  const changed = dirs.map((d) => changedFile(`lib/${d}/x.ts`, "modified", [], []));
  const r = blastRadius(g, changed, "b", { depth: 1 });
  assert.ok(r.areas.length <= 5, `got ${r.areas.length} areas`);
  assert.equal(r.areas.reduce((n, a) => n + a.files.length, 0), 7);
  assert.ok(r.areas.every((a) => a.tests === "na"), "no behaviour changed, so no test question");
  assert.ok(r.seeds.every((s) => s.wholeFile));
});

describe("blastRadiusIn", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "blast-gaps-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("builds the module index from a context dir and passes options through", () => {
    const r = blastRadiusIn(graph(), dir, changes(), "HEAD~1...HEAD", 2, { read, tests: true });
    assert.equal(r.basis, "HEAD~1...HEAD");
    assert.equal(r.depth, 2);
    assert.ok(Array.isArray(r.tests));
    assert.ok(r.impacted.some((i) => i.id === "useFoo"));
  });

  test("defaults to no extras", () => {
    const r = blastRadiusIn(graph(), dir, changes(), "x", 1);
    assert.equal(r.tests, undefined);
  });
});

test("hubLabel: first non-empty name, else the fallback", () => {
  assert.equal(hubLabel(["", "writeGraph", "other"], "src/"), "writeGraph");
  assert.equal(hubLabel([], "src/"), "src/");
  assert.equal(hubLabel([""], "lib/"), "lib/");
});
