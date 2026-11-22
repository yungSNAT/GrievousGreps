/**
 * Gap tests for `src/graph/traverse-cli.ts`. They cover:
 * - the callee and caller wording of the empty-result note;
 * - reports where hits have different relations, so the header prints no shared relation;
 * - quoting of group labels, unresolved-import hits and the block of definitions with no edges;
 * - the token-savings baseline, including hits with no node;
 * - `runCallersCommand` run in-process (with its exits stubbed) and through the real CLI.
 */
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  callerBlocks,
  callersSavings,
  looseNoteFor,
  runCallersCommand,
} from "../src/graph/traverse-cli.js";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";
import { savingsFor } from "../src/context/savings.js";
import { resolveSymbol, edgeWalk, type EdgeHit } from "../src/graph/traverse.js";
import { INFERRED_MARK, type GraphV1, type NodeV1 } from "../src/graph/types.js";
import { runCli, tmpRepo } from "./helpers.js";

function node(id: string, name: string, path: string, span: string): NodeV1 {
  return { id, name, kind: "function", path, span } as unknown as NodeV1;
}

const EMPTY_GRAPH = { nodes: [], edges: [] } as unknown as GraphV1;

class Exit extends Error {
  constructor(public code: number | undefined) {
    super(`exit ${code}`);
  }
}

/** Runs fn with process.exit and console.error stubbed; returns the exit code and the error text. */
function expectExit(fn: () => void): { code: number | undefined; err: string } {
  const errs: string[] = [];
  const e = mock.method(console, "error", (...a: unknown[]) => {
    errs.push(a.map(String).join(" "));
  });
  const x = mock.method(process, "exit", ((c?: number) => {
    throw new Exit(c);
  }) as typeof process.exit);
  try {
    fn();
    assert.fail("expected process.exit");
  } catch (err) {
    if (!(err instanceof Exit)) throw err;
    return { code: err.code, err: errs.join("\n") };
  } finally {
    e.mock.restore();
    x.mock.restore();
  }
}

function captureStdout(fn: () => void): string {
  let out = "";
  const write = mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  try {
    fn();
  } finally {
    write.mock.restore();
  }
  return out;
}

function captureJson(fn: () => void): any {
  const log = mock.method(console, "log", () => {});
  try {
    fn();
  } finally {
    log.mock.restore();
  }
  assert.equal(log.mock.callCount(), 1);
  return JSON.parse(String(log.mock.calls[0].arguments[0]));
}

describe("looseNoteFor", () => {
  test("for callees it says callees and outgoing, with no ambiguity note when there is one definition", () => {
    const note = looseNoteFor("out", "doThing", 1);
    assert.match(note, /no indexed callees/);
    assert.match(note, /no outgoing call\/reference edges/);
    assert.ok(!note.includes("definitions share the name"));
    assert.ok(note.includes('"doThing"'));
  });

  test("for callers it says callers and incoming, and flags an ambiguous name", () => {
    const note = looseNoteFor("in", "verify", 3);
    assert.match(note, /no indexed callers/);
    assert.match(note, /no incoming call\/reference edges/);
    assert.ok(note.includes('3 definitions share the name "verify"'));
  });
});

describe("callerBlocks with mixed relations", () => {
  const symbol = node("a.ts#main", "main", "a.ts", "L1-L5");
  const hits: EdgeHit[] = [
    { id: "b.ts#weird", relation: "calls", depth: 1, node: node("b.ts#weird", "weird, name", "b.ts", "L3-L4") } as unknown as EdgeHit,
    { id: "c.ts#y", relation: "references", depth: 1, node: node("c.ts#y", "y", "c.ts", "L7-L9") } as unknown as EdgeHit,
  ];

  test("without a shared relation, each group line has its own relation and arrow", () => {
    const blocks = callerBlocks(EMPTY_GRAPH, "out", false, [{ symbol, hits }]);
    assert.equal(blocks.length, 1);
    const lines = blocks[0].split("\n");
    assert.equal(lines[0], "main · function · a.ts:L1-L5");
    assert.equal(lines[1], '  calls → b.ts: "weird, name" L3');
    assert.equal(lines[2], "  references → c.ts: y L7");
  });

  test("depth tags and quoted call sites print one hit per line under the group lead", () => {
    const blocks = callerBlocks(EMPTY_GRAPH, "in", true, [{ symbol, hits }], (h, name) => {
      assert.equal(name, "main");
      return h.id === "b.ts#weird" ? { n: 4, text: "   main()   " } : undefined;
    });
    const lines = blocks[0].split("\n");
    assert.equal(lines[0], "main · function · a.ts:L1-L5");
    assert.equal(lines[1], "  calls ← b.ts");
    assert.equal(lines[2], '    "weird, name" L4 [depth 1]: main()');
    assert.equal(lines[3], "  references ← c.ts: y L7 [depth 1]");
  });

  test("a shared relation moves to the header and leaves the group lead bare", () => {
    const same = hits.map((h) => ({ ...h, relation: "calls" })) as EdgeHit[];
    const blocks = callerBlocks(EMPTY_GRAPH, "out", false, [{ symbol, hits: same }]);
    const lines = blocks[0].split("\n");
    assert.equal(lines[0], "main · function · a.ts:L1-L5 · calls →");
    assert.equal(lines[1], '  b.ts: "weird, name" L3');
    assert.equal(lines[2], "  c.ts: y L7");
  });

  test("an unresolved import keeps its own line and a quoted path carries the inferred mark", () => {
    const mixed: EdgeHit[] = [
      { id: "ext.mod", relation: "imports", depth: 1 } as unknown as EdgeHit,
      { id: "p#y", relation: "calls", depth: 1, inferred: true, node: node("p#y", "y", "dir: x/c.ts", "L7-L9") } as unknown as EdgeHit,
    ];
    const blocks = callerBlocks(EMPTY_GRAPH, "out", false, [{ symbol, hits: mixed }]);
    const lines = blocks[0].split("\n");
    assert.equal(lines[0], "main · function · a.ts:L1-L5");
    assert.equal(lines[1], "  imports → ext.mod (unresolved import)");
    assert.equal(lines[2], `  calls → "dir: x/c.ts"${INFERRED_MARK}: y L7`);
  });

  test("edgeless homonyms share one block with a count of the rest and one unresolved note", () => {
    const graph = {
      nodes: [],
      edges: [],
      unresolvedCalls: [{ name: "dup", source: "x.ts#f", through: "lib", file: "lib.js" }],
    } as unknown as GraphV1;
    const withHit = node("a.ts#dup", "dup", "a.ts", "L1-L2");
    const quiet = [1, 2, 3, 4, 5].map((i) => node(`q${i}.ts#dup`, "dup", `q${i}.ts`, "L1-L2"));
    const results = [
      { symbol: withHit, hits: [hits[1]] },
      ...quiet.map((symbol) => ({ symbol, hits: [] as EdgeHit[] })),
    ];
    const blocks = callerBlocks(graph, "in", false, results);
    assert.equal(blocks.length, 2);
    const last = blocks[1].split("\n");
    assert.equal(last[0], "dup · function · q1.ts:L1-L2");
    assert.equal(last[2], "dup · function · q3.ts:L1-L2");
    assert.equal(last[3], "… and 2 more in 2 file(s)");
    assert.ok(last[4].includes('no indexed callers for 5 of the 6 definitions named "dup"'), last[4]);
    assert.ok(last[4].includes("Pick one with --in <path prefix>"), last[4]);
    const all = blocks.join("\n\n");
    assert.equal(all.split("may be incomplete").length - 1, 1);
    assert.ok(all.includes("x.ts#f (through lib, in lib.js, which is not indexed)"), all);
  });
});

describe("callersSavings", () => {
  test("hits without a node add no file to the baseline", () => {
    const symbol = node("a.ts#main", "main", "a.ts", "L1-L5");
    const hits = [{ id: "ext.mod", relation: "imports", depth: 1 } as unknown as EdgeHit];
    assert.deepEqual(callersSavings(EMPTY_GRAPH, [{ symbol, hits }]), savingsFor(EMPTY_GRAPH, ["a.ts"]));
  });
});

describe("runCallersCommand exits", () => {
  let empty: string;
  before(() => {
    empty = tmpRepo("tcli-empty");
  });
  after(() => {
    rmSync(empty, { recursive: true, force: true });
  });

  test("with no graph it exits 1 and says to build first", () => {
    const r = expectExit(() => runCallersCommand("main", empty, {}));
    assert.equal(r.code, 1);
    assert.match(r.err, /no graph found at/);
  });
});

describe("runCallersCommand on a built graph", () => {
  let root: string;
  let graph: GraphV1;

  before(async () => {
    root = tmpRepo("tcli-gaps");
    const files: Record<string, string> = {
      "app.py": "def helper():\n    return 1\n\n\ndef main():\n    return helper()\n",
      "b.py": "from app import helper\n\n\ndef run():\n    return helper()\n",
    };
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    await buildGraph(root);
    graph = readGraph(wiringPath(contextDirFor(root)))!;
    assert.ok(graph, "graph was built");
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("callersSavings matches savingsFor over the files of the symbol and its hits", () => {
    const [main] = resolveSymbol(graph, "main", {});
    assert.ok(main, "main is indexed");
    const hits = edgeWalk(graph, main, "out", 1);
    const results = [{ symbol: main, hits }];
    const expectedPaths = [main.path, ...hits.filter((h) => h.node).map((h) => h.node!.path)];
    assert.deepEqual(callersSavings(graph, results), savingsFor(graph, expectedPaths));
    assert.deepEqual(callersSavings(graph, []), savingsFor(graph, []));
  });

  test("--direction out --json lists the callees of main", () => {
    const payload = captureJson(() => runCallersCommand("main", root, { json: true, direction: "out" }));
    assert.equal(payload.query, "main");
    assert.equal(payload.matches.length, 1);
    assert.equal(payload.matches[0].symbol.name, "main");
    const names = payload.matches[0].hits.map((h: { name?: string }) => h.name);
    assert.ok(names.includes("helper"), `callees: ${JSON.stringify(names)}`);
    assert.equal(payload.matches[0].note, undefined);
  });

  test("--direction out --json on a function that calls nothing gives the callee note", () => {
    const payload = captureJson(() => runCallersCommand("helper", root, { json: true, direction: "out" }));
    assert.deepEqual(payload.matches[0].hits, []);
    assert.match(payload.matches[0].note, /no indexed callees/);
    assert.match(payload.matches[0].note, /outgoing/);
  });

  test("--json on a function nobody calls gives the caller note", () => {
    const payload = captureJson(() => runCallersCommand("run", root, { json: true }));
    assert.deepEqual(payload.matches[0].hits, []);
    assert.match(payload.matches[0].note, /no indexed callers/);
    assert.match(payload.matches[0].note, /incoming/);
  });

  test("--depth all walks every callee", () => {
    const payload = captureJson(() => runCallersCommand("main", root, { json: true, direction: "out", depth: "all" }));
    const helper = payload.matches[0].hits.find((h: { name?: string }) => h.name === "helper");
    assert.ok(helper, JSON.stringify(payload));
    assert.equal(helper.depth, 1);
  });

  test("the text report for callers of helper names both calling functions", () => {
    const out = captureStdout(() => runCallersCommand("helper", root, {}));
    const first = out.split("\n")[0];
    assert.ok(first.startsWith("helper · "), first);
    assert.ok(out.includes("app.py"), out);
    assert.ok(out.includes("main"), out);
    assert.ok(out.includes("run"), out);
  });

  test("--depth 2 tags every hit with its depth", () => {
    const out = captureStdout(() => runCallersCommand("helper", root, { depth: "2" }));
    assert.ok(out.includes("[depth 1]"), out);
  });

  test("the text report for a function nobody calls prints the caller note under its header", () => {
    const out = captureStdout(() => runCallersCommand("run", root, {}));
    const lines = out.split("\n");
    assert.ok(lines[0].startsWith("run · "), lines[0]);
    assert.match(lines[1], /no indexed callers — the graph has no incoming/);
  });

  test("an unknown symbol exits 1 and names it", () => {
    const r = expectExit(() => runCallersCommand("doesNotExist", root, {}));
    assert.equal(r.code, 1);
    assert.ok(r.err.includes('no symbol "doesNotExist" in the graph'), r.err);
  });

  test("an --in prefix that matches nothing exits 1 with a one-line error", () => {
    const r = expectExit(() => runCallersCommand("helper", root, { in: "nowhere-at-all/" }));
    assert.equal(r.code, 1);
    assert.ok(r.err.startsWith("✗ "), r.err);
  });

  test("a bad --direction exits 1", () => {
    const r = expectExit(() => runCallersCommand("helper", root, { direction: "sideways" }));
    assert.equal(r.code, 1);
    assert.ok(r.err.includes('--direction must be "in" or "out", got "sideways"'), r.err);
  });

  test("a bad --depth exits 1", () => {
    const r = expectExit(() => runCallersCommand("helper", root, { depth: "0" }));
    assert.equal(r.code, 1);
    assert.ok(r.err.includes('--depth must be a positive number or "all", got "0"'), r.err);
  });

  test("the text report through the CLI groups the callers and matches the relations in --json", () => {
    const json = runCli(["callers", "helper", root, "--json"]);
    assert.equal(json.status, 0, json.describe());
    const payload = JSON.parse(json.stdout);
    const hits: { relation: string; name?: string; path?: string }[] = payload.matches[0].hits;
    assert.ok(hits.some((h) => h.name === "main"), json.stdout);
    const relations = [...new Set(hits.map((h) => h.relation))];

    const text = runCli(["callers", "helper", root]);
    assert.equal(text.status, 0, text.describe());
    const lines = text.stdout.split("\n");
    assert.ok(lines[0].startsWith("helper · "), lines[0]);
    if (relations.length === 1) {
      assert.ok(lines[0].includes(`· ${relations[0]} ←`), lines[0]);
    } else {
      assert.ok(!lines[0].includes(" ←"), lines[0]);
      for (const rel of relations) {
        assert.ok(lines.some((l) => l.startsWith(`  ${rel} ← `)), `${rel} in ${text.stdout}`);
      }
    }
    assert.ok(text.stdout.includes("main"), text.stdout);
  });

  test("--direction out through the CLI gives the callee note for a function that calls nothing", () => {
    const r = runCli(["callers", "helper", root, "--direction", "out"]);
    assert.equal(r.status, 0, r.describe());
    assert.match(r.stdout, /no indexed callees/);
    assert.match(r.stdout, /no outgoing call\/reference edges/);
  });

  test("through the CLI a function nobody calls gives the caller note", () => {
    const r = runCli(["callers", "run", root]);
    assert.equal(r.status, 0, r.describe());
    assert.match(r.stdout, /no indexed callers/);
    assert.match(r.stdout, /no incoming call\/reference edges/);
  });

  test("--direction out --json through the CLI lists the callees of main", () => {
    const r = runCli(["callers", "main", root, "--direction", "out", "--json"]);
    assert.equal(r.status, 0, r.describe());
    const payload = JSON.parse(r.stdout);
    const names = payload.matches[0].hits.map((h: { name?: string }) => h.name);
    assert.ok(names.includes("helper"), r.stdout);
  });
});
