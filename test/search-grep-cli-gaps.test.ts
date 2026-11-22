import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  formatGrepHeader,
  formatGrepResult,
  runGrepCommand,
  zeroHitNote,
} from "../src/search/grep-cli.js";
import { tmpRepo } from "./helpers.js";

type GrepResult = Parameters<typeof formatGrepResult>[0];

const checkout = join("src", "checkout.ts");
const audit = join("src", "audit.ts");

const groups = [
  {
    path: checkout,
    symbol: { name: "authorize", kind: "function", path: checkout, span: "10-16" },
    inDegree: 3,
    hits: [
      { line: 10, text: "export function authorize(order: Order) {" },
      { line: 12, text: "return authorizePayment(order);" },
    ],
  },
  {
    path: checkout,
    symbol: null,
    inDegree: 0,
    hits: [{ line: 2, text: 'const auditEvent = "authorize";' }],
  },
  {
    path: audit,
    symbol: { name: "auditOrder", kind: "function", path: audit, span: "5-8" },
    inDegree: 1,
    hits: [{ line: 6, text: 'log("authorize", order.id);' }],
  },
];

function resultFixture({
  matches = groups,
  unreadableFiles = 0,
  droppedHits = 0,
}: {
  matches?: typeof groups;
  unreadableFiles?: number;
  droppedHits?: number;
} = {}): GrepResult {
  // The formatter only needs report fields, not a graph behind the symbols.
  return {
    pattern: "authorize",
    filesSearched: 5,
    totalHits: matches.reduce((sum, group) => sum + group.hits.length, 0),
    groups: matches,
    truncated: { files: unreadableFiles, hits: droppedHits },
    saved: 0,
  } as unknown as GrepResult;
}

describe("grep report formatting", () => {
  test("the header counts each path once even when it has multiple groups", () => {
    assert.equal(
      formatGrepHeader(resultFixture()),
      '"authorize" — 4 hits in 3 symbols across 2 files (searched 5 indexed files)',
    );
  });

  test("named and module-level hits render as separate blocks", () => {
    const result = resultFixture();
    const report = formatGrepResult(result);
    const lines = report.split("\n");
    const header = lines.indexOf(formatGrepHeader(result));

    assert.ok(header >= 0, "the report includes its summary header");
    assert.equal(lines[header + 1], "");
    assert.equal(lines[header + 2], `authorize · function · ${checkout}:10-16 · 3 in-edges`);
    assert.equal(lines[header + 3], "  L10: export function authorize(order: Order) {");
    assert.equal(lines[header + 4], "  L12: return authorizePayment(order);");
    assert.equal(lines[header + 5], "");
    assert.equal(lines[header + 6], `${checkout} (module level) · 0 in-edges`);
    assert.equal(lines[header + 7], '  L2: const auditEvent = "authorize";');
    assert.equal(lines[header + 8], "");
    assert.equal(lines[header + 9], `auditOrder · function · ${audit}:5-8 · 1 in-edges`);
    assert.doesNotMatch(report, /\(truncated:/);
    assert.match(report, /  L6: log\("authorize", order\.id\);\n$/);
  });

  for (const { unreadableFiles, droppedHits, detail } of [
    { unreadableFiles: 0, droppedHits: 1, detail: "1 more hit beyond the cap" },
    { unreadableFiles: 1, droppedHits: 0, detail: "1 indexed file unreadable" },
    {
      unreadableFiles: 2,
      droppedHits: 3,
      detail: "3 more hits beyond the cap, 2 indexed files unreadable",
    },
  ]) {
    test(`reports ${detail} directly under the summary`, () => {
      const result = resultFixture({ unreadableFiles, droppedHits });
      const lines = formatGrepResult(result).split("\n");
      const header = lines.indexOf(formatGrepHeader(result));

      assert.ok(header >= 0, "the report includes its summary header");
      assert.equal(
        lines[header + 1],
        `(truncated: ${detail} — narrow with --in or refine the pattern)`,
      );
      assert.equal(lines[header + 2], "");
      assert.equal(lines[header + 3], `authorize · function · ${checkout}:10-16 · 3 in-edges`);
    });
  }

  test("a zero-hit note warns when one indexed file could not be read", () => {
    const note = zeroHitNote(resultFixture({ matches: [], unreadableFiles: 1 }));

    assert.match(note, /^no hits for "authorize" in 5 indexed files\./);
    assert.match(note, /retry .* with a bare symbol name or short substring/);
    assert.match(note, /1 indexed file could not be read \(stale graph\? run [^)]+\bbuild\b/);
  });

  test("a zero-hit note distinguishes ignored code from unreadable indexed files", () => {
    const note = zeroHitNote(
      resultFixture({ matches: [], unreadableFiles: 2 }),
      ["generated.ts"],
    );

    assert.match(note, /Git-ignored code isn't indexed and wasn't searched: generated\.ts\./);
    assert.match(note, /2 indexed files could not be read/);
    assert.doesNotMatch(note, /All indexed code was searched/);
  });
});

describe("runGrepCommand without a graph", () => {
  let root: string;

  before(() => {
    root = tmpRepo("grep-cli-no-graph");
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("reports the missing graph and exits with status 1", () => {
    const stopped = new Error("stubbed process.exit");
    const error = mock.method(console, "error", () => {});
    const exit = mock.method(process, "exit", () => {
      throw stopped;
    });

    try {
      assert.throws(
        () => runGrepCommand("authorize", root, { globalDir: root }),
        (err: unknown) => err === stopped,
      );
      assert.equal(error.mock.callCount(), 1);
      assert.match(String(error.mock.calls[0].arguments[0]), /no graph — run .+\bbuild\b.*first/);
      assert.equal(exit.mock.callCount(), 1);
      assert.deepEqual(exit.mock.calls[0].arguments, [1]);
    } finally {
      exit.mock.restore();
      error.mock.restore();
    }
  });
});
