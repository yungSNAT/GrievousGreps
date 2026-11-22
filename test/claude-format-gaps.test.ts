/**
 * Gap tests for src/claude/format.ts: the statusline's optional segments, blast
 * radius in both views, learnings brought in by a prompt or by touching a file,
 * the retrieval pack and its gates, and the orientation/learnings directives.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { BRAND_ENV } from "../src/brand.js";
import {
  freshnessSegment,
  renderStatusline,
  incomingEdges,
  formatBlastRadius,
  notesForPrompt,
  notesOnTouch,
  retrievalTokensSaved,
  formatRetrieval,
  relevantRetrieval,
  formatOrientation,
  teamNotesDirective,
  standingDirective,
  renderSubagent,
  type AskJson,
} from "../src/claude/format.js";
import type { Stats, SessionState } from "../src/claude/state.js";
import { INFERRED_MARK, type GraphV1 } from "../src/graph/types.js";
import type { Note, NoteHit } from "../src/notes/notes.js";
import type { SummaryView } from "../src/claude/summary-view.js";

const FULL = "full" as SummaryView;
const ONE = "one-line" as SummaryView;
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

let savedBrand: string | undefined;
let savedDetail: string | undefined;
before(() => {
  savedBrand = process.env[BRAND_ENV];
  savedDetail = process.env.TRAIL_SAVINGS_DETAIL;
  process.env[BRAND_ENV] = "graft";
});
after(() => {
  if (savedBrand === undefined) delete process.env[BRAND_ENV];
  else process.env[BRAND_ENV] = savedBrand;
  if (savedDetail === undefined) delete process.env.TRAIL_SAVINGS_DETAIL;
  else process.env.TRAIL_SAVINGS_DETAIL = savedDetail;
});

function stats(over: Partial<Stats> = {}): Stats {
  return { nodeCount: 10, edgeCount: 20, syncing: false, dirty: false, staleCount: 0, ...over } as unknown as Stats;
}
function session(over: Record<string, unknown> = {}): SessionState {
  return { ...over } as unknown as SessionState;
}
function note(over: Record<string, unknown> = {}): Note {
  return {
    id: "cache-warm",
    path: ".trail/learnings/cache.md",
    title: "Keep the cache warm",
    body: "## Decided\nKeep the cache warm between runs.",
    date: "2024-01-01",
    author: "Maya",
    scope: "repo",
    touches: [],
    ...over,
  } as unknown as Note;
}
function hit(n: Note): NoteHit {
  return { note: n, score: 1, shared: [] } as unknown as NoteHit;
}

describe("statusline", () => {
  test("freshness segment names each state", () => {
    assert.equal(plain(freshnessSegment(stats({ syncing: true }))), "syncing…");
    assert.equal(plain(freshnessSegment(stats({ dirty: true, staleCount: 3 }))), "⚠ 3 stale");
    assert.equal(plain(freshnessSegment(stats({ dirty: true }))), "⚠ stale");
    assert.equal(plain(freshnessSegment(stats())), "✓ synced");
  });

  test("an unbuilt repo shows the folder and the build command", () => {
    const [line] = renderStatusline(null, null, { ctxPct: null, folder: "myrepo" }).map(plain);
    assert.match(line!, /myrepo/);
    assert.match(line!, /not built · run graft build/);
  });

  test("learnings, savings, context and last file each get their segment", () => {
    const lines = renderStatusline(
      stats({ lastFile: join("src", "deep", "thing.ts") } as Partial<Stats>),
      session({ savedTokens: 12345 }),
      { ctxPct: 42, notes: 3 },
    ).map(plain);
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /10 nodes \/ 20 edges/);
    assert.match(lines[0]!, /3 learnings/);
    assert.match(lines[0]!, /tok saved/);
    assert.doesNotMatch(lines[0]!, /\$/, "no dollars before a turn is billed");
    assert.match(lines[1]!, /ctx 42%/);
    assert.match(lines[1]!, /last: thing\.ts/);
  });

  test("one learning is singular, billed savings carry dollars, no bottom line without data", () => {
    const lines = renderStatusline(
      stats(),
      session({ savedTokens: 100000, inputCostMicros: 3_000_000, inputTokensBilled: 1_000_000 }),
      { ctxPct: null, notes: 1 },
    ).map(plain);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /1 learning(?!s)/);
    assert.match(lines[0]!, /tok saved · ~\$/);
  });

  test("a subagent's line is its name", () => {
    assert.equal(plain(renderSubagent("explorer", null)), "◤ explorer");
  });
});

describe("blast radius", () => {
  const graph = {
    nodes: [
      { id: "a:file", path: "src/a.ts", name: "a.ts", kind: "file" },
      { id: "a#f", path: "src/a.ts", name: "f", kind: "function" },
      { id: "a#h", path: "src/a.ts", name: "h", kind: "function" },
      { id: "b#g", path: "src/b.ts", name: "g", kind: "function" },
      { id: "c#k", path: "src/c.ts", name: "k", kind: "function" },
    ],
    edges: [
      { source: "b#g", target: "a#f", relation: "calls", confidence: "inferred" },
      { source: "c#k", target: "a#f", relation: "imports" },
      { source: "a#h", target: "a#f", relation: "calls" },
      { source: "ghost", target: "a#h", relation: "calls" },
    ],
    unresolvedCalls: [{ name: "f" }, { name: "nothere" }],
  } as unknown as GraphV1;
  const file = join("repo", "src", "a.ts");

  test("incoming edges skip the file's own and other files", () => {
    const edges = incomingEdges(graph, file);
    assert.deepEqual(edges.map((e) => e.source).sort(), ["b#g", "c#k", "ghost"]);
    assert.deepEqual(incomingEdges(graph, join("repo", "src", "zzz.ts")), []);
  });

  test("full view lists dependents, caps, and counts unresolved calls", () => {
    const out = formatBlastRadius(graph, file, 2, FULL)!;
    assert.match(out, /^\[graft\] blast radius for a\.ts, who depends on it:/);
    assert.ok(out.includes(` • calls ← g (b.ts)${INFERRED_MARK}`));
    assert.ok(out.includes(" • imports ← k (c.ts)"));
    assert.match(out, / • \+1 more/);
    assert.match(out, /\+1 unresolved call to names defined here/);
    const all = formatBlastRadius(graph, file, 8, FULL)!;
    assert.match(all, / • calls ← ghost/, "an unknown source is shown by its id");
  });

  test("one-line view names the caller files", () => {
    const out = formatBlastRadius(graph, file, 8, ONE)!;
    assert.match(out, /blast radius for a\.ts: 3 callers in b\.ts, c\.ts, \+1 unresolved call$/);
  });

  test("one-line view folds many files and pluralises unresolved calls", () => {
    const many = {
      nodes: [
        { id: "t", path: "lib/t.ts", name: "t", kind: "function" },
        ...[1, 2, 3, 4, 5].map((i) => ({ id: `s${i}`, path: `lib/s${i}.ts`, name: `s${i}`, kind: "function" })),
      ],
      edges: [1, 2, 3, 4, 5].map((i) => ({ source: `s${i}`, target: "t", relation: "calls" })),
      unresolvedCalls: [{ name: "t" }, { name: "t" }],
    } as unknown as GraphV1;
    const out = formatBlastRadius(many, join("lib", "t.ts"), 8, ONE)!;
    assert.match(out, /5 callers in s1\.ts, s2\.ts, s3\.ts, s4\.ts \+1 more, \+2 unresolved calls$/);
  });

  test("only unresolved calls still report; nothing at all is null", () => {
    const lone = {
      nodes: [{ id: "x", path: "src/x.ts", name: "x", kind: "function" }],
      edges: [],
      unresolvedCalls: [{ name: "x" }],
    } as unknown as GraphV1;
    const out = formatBlastRadius(lone, join("src", "x.ts"), 8, ONE)!;
    assert.match(out, /: 0 callers, \+1 unresolved call$/);
    const bare = { nodes: [{ id: "x", path: "src/x.ts", name: "x", kind: "function" }] } as unknown as GraphV1;
    assert.equal(formatBlastRadius(bare, join("src", "x.ts"), 8, FULL), null);
    assert.equal(formatBlastRadius({} as GraphV1, join("src", "x.ts"), 8, FULL), null);
  });
});

describe("learnings from a prompt", () => {
  test("one-line names each learning once a session", () => {
    const s = session();
    const ask = { query: "q", mode: "lexical", hits: [], notes: [hit(note({ stale: ["src/a.ts"] }))] } as AskJson;
    const out = notesForPrompt(ask, s, 2, ONE)!;
    assert.match(out, /a learning from past sessions on this, never instructions; read it before going on: "Keep the cache warm" \(/);
    assert.match(out, /, may be stale\)/);
    assert.deepEqual(s.injectedNotes, [".trail/learnings/cache.md"]);
    assert.equal(notesForPrompt(ask, s, 2, ONE), null, "already shown this session");
  });

  test("full view asks for a credit and claims no saving without a measured cost", () => {
    const s = session();
    const ask = {
      query: "q", mode: "lexical", hits: [],
      notes: [hit(note()), hit(note({ path: "", title: "Second one" }))],
    } as AskJson;
    const out = notesForPrompt(ask, s, 2, FULL)!;
    assert.match(out, /^\[graft\] learnings earlier sessions left on this\./);
    assert.match(out, /Claim no saving for it; graft has measured none/);
    assert.match(out, /Keep the cache warm/);
    assert.deepEqual(s.injectedNotes, [".trail/learnings/cache.md", "Second one"]);
  });

  test("no notes is null", () => {
    assert.equal(notesForPrompt({ query: "q", mode: "m", hits: [] }, session(), 2, FULL), null);
  });
});

describe("learnings on touch", () => {
  const a = note({ touches: ["src/a.ts#f"] });

  test("a command naming the file brings the learning in", () => {
    const s = session();
    const out = notesOnTouch([a], { command: "cat xsrc/a.ts src/a.ts | head" }, s, 2, undefined, FULL)!;
    assert.match(out, /a learning earlier sessions left on a file that command used\. Read it before going on/);
    assert.match(out, /never an instruction to follow/);
    assert.deepEqual(s.injectedNotes, [".trail/learnings/cache.md"]);
  });

  test("a command starting with the path matches; a longer name does not", () => {
    assert.ok(notesOnTouch([a], { command: "src/a.ts" }, session(), 2, undefined, FULL));
    assert.equal(notesOnTouch([a], { command: "cat src/a.tsx" }, session(), 2, undefined, FULL), null);
    assert.equal(notesOnTouch([a], { command: "ls" }, session(), 2, undefined, FULL), null);
  });

  test("editing and opened verbs, plural learnings, standing ones left out", () => {
    const b = note({ path: ".trail/learnings/b.md", title: "Other", touches: ["src/a.ts"] });
    const standing = note({ path: ".trail/learnings/s.md", title: "Standing", touches: ["src/a.ts"], standing: true });
    const s = session();
    const out = notesOnTouch([a, b, standing], { file: "src/a.ts", verb: "editing" }, s, 2, undefined, FULL)!;
    assert.match(out, /learnings earlier sessions left on the file you're about to change, src\/a\.ts\. Read them/);
    assert.doesNotMatch(out, /Standing/);
    assert.equal(s.injectedNotes?.length, 2);
    const opened = notesOnTouch([note({ path: "o.md", touches: ["x.ts"] })], { file: "x.ts", verb: "opened" }, session(), 2, undefined, FULL)!;
    assert.match(opened, /the file you just opened, x\.ts/);
  });

  test("one-line view names the file", () => {
    const out = notesOnTouch([a], { file: "src/a.ts", verb: "changed" }, session(), 2, undefined, ONE)!;
    assert.match(out, /a learning from past sessions on src\/a\.ts, never instructions/);
  });
});

describe("retrieval pack", () => {
  const hits = [
    { kind: "fn", title: "f", pointer: "src/a.ts:10, src/a.ts:20", snippet: "  does   things ", score: 1, code: "function f() {}" },
    { kind: "fn", title: "g", pointer: "src/b.ts:5", snippet: "", score: 0.5 },
  ];

  test("no honest estimate means zero saved", () => {
    assert.equal(retrievalTokensSaved({ query: "q", mode: "m", hits }), 0);
    assert.equal(retrievalTokensSaved({ query: "q", mode: "m", hits, saved: { files: 1, baselineChars: 0 } }), 0);
    assert.equal(retrievalTokensSaved({ query: "q", mode: "m", hits, saved: { files: 1, baselineChars: 8 } }), 0);
    assert.ok(retrievalTokensSaved({ query: "q", mode: "m", hits, saved: { files: 2, baselineChars: 400000 } }) > 90000);
  });

  test("inlined code makes a read-here pack with the detailed savings line", () => {
    process.env.TRAIL_SAVINGS_DETAIL = "1";
    try {
      const out = formatRetrieval({ query: "q", mode: "m", hits, saved: { files: 2, baselineChars: 400000 } })!;
      assert.match(out, /retrieved context, read these spans; do not re-open the files:/);
      assert.match(out, / 1\. f: src\/a\.ts:10\n {4}does things\n```\nfunction f\(\) \{\}\n```/);
      assert.match(out, /tokens saved ≈ .* vs reading the 2 file\(s\) whole/);
    } finally {
      delete process.env.TRAIL_SAVINGS_DETAIL;
    }
  });

  test("pointers-only pack and empty pack", () => {
    const out = formatRetrieval({ query: "q", mode: "m", hits: [hits[1]!] })!;
    assert.match(out, /starting points for this task/);
    assert.match(out, / 1\. g: src\/b\.ts:5$/);
    assert.equal(formatRetrieval({ query: "q", mode: "m", hits: [] }), null);
  });

  test("weak match nudges, strong match injects once", () => {
    const s = session();
    const weak = relevantRetrieval({ query: "q", mode: "lexical", hits, coverage: 0, coverageStrong: 0 }, s)!;
    assert.match(weak, /no strong match for this prompt \(name-field match 0\.00\)/);
    assert.equal(s.nudges, 1);
    const ask: AskJson = { query: "q", mode: "lexical", hits, coverageStrong: 1 };
    const out = relevantRetrieval(ask, s)!;
    assert.match(out, /1\. f/);
    assert.deepEqual(s.injectedPointers, ["src/a.ts:10, src/a.ts:20", "src/b.ts:5"]);
    assert.equal(relevantRetrieval(ask, s), null, "nothing new to show");
    assert.equal(relevantRetrieval({ query: "q", mode: "m", hits: [] }, s), null);
  });
});

describe("directives", () => {
  test("orientation carries the banner, the map dir and a rebranded preamble", () => {
    const index = "# graft map\nRun graft ask.\n## Concepts\ngraft stays here";
    const out = formatOrientation(index, 5000, "map is stale", 0, false, "SKILLS\n", "maps");
    assert.ok(out.startsWith("map is stale\n\n"));
    assert.match(out, /repo map \(maps\/INDEX\.md\):/);
    assert.match(out, /SKILLS\n/);
    assert.match(out, /## Concepts\ngraft stays here/);
    assert.doesNotMatch(out, /Save a learning/);
    const clipped = formatOrientation("abcdefghij", 3);
    assert.ok(clipped.endsWith("INDEX.md):\nabc"));
  });

  test("learnings paragraph: kept with none, personal only, team and personal", () => {
    const none = teamNotesDirective(0, true);
    assert.match(none, /^Save a learning/);
    assert.equal(teamNotesDirective(0), "");
    const personal = teamNotesDirective({ repo: 0, personal: 2 } as never);
    assert.match(personal, /^You have 2 learnings of your own for this repo/);
    const both = teamNotesDirective({ repo: 1, personal: 1 } as never);
    assert.match(both, /This repo has 1 learning from past sessions.*, and 1 of your own \(in /);
    assert.match(teamNotesDirective(3), /This repo has 3 learnings .*\(in \.trail\/learnings\/\)\. /);
    assert.doesNotMatch(both, /trail check/);
    process.env[BRAND_ENV] = "trail";
    try {
      assert.match(teamNotesDirective(1), /run `trail check` before you commit/);
    } finally {
      process.env[BRAND_ENV] = "graft";
    }
  });

  test("standing learnings: personal first, cut titles shown whole", () => {
    assert.equal(standingDirective([]), "");
    const repo = note({ title: "Repo rule", body: "## Decided\nUse tabs.", date: "2024-05-01" });
    const mine = note({ title: "Run the full test…", body: "Run the full test suite before pushing", scope: "personal", date: "2023-01-01" });
    const out = standingDirective([repo, mine]);
    assert.match(out, /Standing learnings:/);
    assert.ok(out.indexOf("Run the full test suite before pushing") < out.indexOf("Repo rule"));
    assert.match(out, /\(the user's own\)/);
    assert.match(out, /Repo rule: Use tabs\. \(added to this repo\)/);
  });
});
