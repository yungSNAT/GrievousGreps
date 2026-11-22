import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { buildGraph } from "../src/graph/build.js";
import { contextDirFor } from "../src/context/node-file.js";
import { ask, formatAsk, skeleton, formatSkeleton, askSavedTokens } from "../src/ask/ask.js";

function materialize(dir: string, layout: Record<string, string>): void {
  for (const [p, content] of Object.entries(layout)) {
    const abs = join(dir, ...p.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
}

const SINGLE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "single" }),
  "src/server.ts":
    "export function handleRequest(req: unknown) { return validateInput(req); }\n" +
    "export function validateInput(x: unknown) { return x != null; }\n" +
    "export function startServer() { return handleRequest({}); }\n" +
    "export function lonelyHelper() { return 42; }\n",
  "src/util.ts": "export function formatError(e: Error) { return e.message; }\n",
  "lib/util.ts": "export function libraryThing(n: number) { return n * 2; }\n",
  "src/server.test.ts":
    "import { validateInput } from './server';\n" +
    "export function checkValidateInput() { return validateInput(1); }\n",
};

const MULTI: Record<string, string> = {
  "frontend/package.json": JSON.stringify({ name: "frontend" }),
  "frontend/src/auth.ts":
    "export function validateToken(t: string) { return t.length > 3; }\n" +
    "export function loginUser(t: string) { return validateToken(t); }\n",
  "backend/pyproject.toml": '[project]\nname = "backend"\n',
  "backend/auth.py":
    "def validate_token(t):\n    return len(t) > 3\n\n" +
    "def login_user(t):\n    return validate_token(t)\n",
};

let single = "";
let multi = "";
let empty = "";
const savedSemantic = process.env.TRAIL_SEMANTIC;

before(async () => {
  process.env.TRAIL_SEMANTIC = "0";
  single = tmpRepo("ask-gaps-single");
  materialize(single, SINGLE);
  await buildGraph(single);
  // A hand-written concept node next to the graph.
  writeFileSync(
    join(contextDirFor(single), "request-flow.md"),
    "---\nslug: request-flow\nname: Request Validation Flow\nsources:\n  - path: src/server.ts\nlinks:\n  - to: error-handling\n---\n" +
      "# Request Validation Flow\n\n<!-- marker -->\n- bullet skipped\n\nRequests are validated before handling.\n",
  );
  multi = tmpRepo("ask-gaps-multi");
  materialize(multi, MULTI);
  await buildGraph(multi);
  empty = tmpRepo("ask-gaps-empty");
});

after(() => {
  if (savedSemantic === undefined) delete process.env.TRAIL_SEMANTIC;
  else process.env.TRAIL_SEMANTIC = savedSemantic;
  for (const d of [single, multi, empty]) if (d) rmSync(d, { recursive: true, force: true });
});

describe("structural mode", () => {
  test("who calls X walks incoming edges", () => {
    const r = ask(single, "who calls validateInput");
    assert.equal(r.mode, "structural");
    assert.equal(r.subject, "validateInput");
    assert.equal(r.note, "callers / references of validateInput");
    assert.ok(r.hits.some((h) => h.title === "handleRequest" && h.kind === "caller"));
    assert.ok(r.hits.every((h) => h.score === 1));
    const text = formatAsk(r);
    assert.match(text, /\(structural\)/);
    assert.match(text, /handleRequest\s+src\/server\.ts:L\d+-L\d+\s+\(calls\)/);
  });

  test("callees of X walks outgoing edges", () => {
    const r = ask(single, "callees of handleRequest");
    assert.equal(r.mode, "structural");
    assert.equal(r.note, "outgoing edges from handleRequest");
    assert.ok(r.hits.some((h) => h.title === "validateInput" && h.kind === "callee"));
  });

  test("structural limit truncates hits", () => {
    const r = ask(single, "who calls validateInput", { limit: 1 });
    assert.equal(r.mode, "structural");
    assert.equal(r.hits.length, 1);
  });

  test("an unresolved subject falls through to lexical with a loud note", () => {
    const r = ask(single, "who calls nonexistentThingXyz");
    assert.notEqual(r.mode, "structural");
    assert.ok(r.note?.startsWith("structural index: no entries for 'nonexistentThingXyz'"));
    assert.match(formatAsk(r), /⚠ structural index: no entries/);
  });

  test("a resolved subject with no edges also falls through", () => {
    const r = ask(single, "who calls lonelyHelper");
    assert.notEqual(r.mode, "structural");
    assert.match(r.note ?? "", /no entries for 'lonelyHelper'/);
  });

  test("--in filters the subject resolution and falls through outside the prefix", () => {
    const r = ask(single, "who calls validateInput", { in: "lib" });
    assert.notEqual(r.mode, "structural");
    assert.match(r.note ?? "", /structural index: no entries/);
    for (const h of r.hits) assert.ok(h.pointer.startsWith("lib/"), h.pointer);
  });
});

describe("lexical mode (single scope)", () => {
  test("ranks real code above tests and inlines source", () => {
    const r = ask(single, "validate input", { source: true });
    assert.equal(r.mode, "lexical");
    assert.ok(r.hits.length > 0);
    assert.ok(!r.hits[0].pointer.includes(".test."), r.hits[0].pointer);
    assert.equal(typeof r.coverage, "number");
    assert.equal(typeof r.coverageStrong, "number");
    assert.ok(r.coverage! > 0 && r.coverage! <= 1);
    const withCode = r.hits.find((h) => h.title.startsWith("validateInput"));
    assert.ok(withCode?.code?.includes("validateInput"), "source inlined");
    assert.equal(r.scopes, undefined);
    assert.ok(askSavedTokens(r) >= 0);
  });

  test("a query asking about tests does not penalise test files", () => {
    const r = ask(single, "check validate input tests", { limit: 10 });
    assert.ok(r.hits.some((h) => h.pointer.includes("server.test.ts")));
  });

  test("concept nodes are scored and rendered with related links", () => {
    const r = ask(single, "request validation flow", { limit: 10 });
    const c = r.hits.find((h) => h.kind === "concept");
    assert.ok(c, "concept hit present");
    assert.equal(c.title, "Request Validation Flow");
    assert.equal(c.pointer, "src/server.ts");
    assert.equal(c.snippet, "Requests are validated before handling.");
    assert.deepEqual(c.related, ["error-handling"]);
    assert.match(formatAsk(r), /related: error-handling/);
  });

  test("--in drops concepts and nodes outside the prefix", () => {
    const r = ask(single, "library thing request validation", { in: "lib/", limit: 10 });
    assert.ok(r.hits.length > 0);
    assert.ok(r.hits.every((h) => h.kind !== "concept"));
    for (const h of r.hits) assert.ok(h.pointer.startsWith("lib/"), h.pointer);
  });

  test("--in with an unindexed prefix throws", () => {
    assert.throws(() => ask(single, "validate", { in: "nowhere-at-all" }));
  });

  test("ranking metadata exposes file groups and the baseline list", () => {
    const r = ask(single, "validate input request", { includeRankingMetadata: true, limit: 10 });
    assert.ok(r.ranking, "ranking metadata present");
    assert.ok(r.ranking.groups.length > 0);
    assert.ok(r.ranking.baseline.length > 0);
    assert.equal(typeof r.ranking.baselineCoverage, "number");
    assert.ok(r.ranking.groups.every((g) => g.key.startsWith("file:") || g.key.startsWith("concept:")));
    assert.ok(Array.isArray(r.ranking.groups[0].baselineHits));
  });

  test("ranking metadata with source inlines internal hits too", () => {
    const r = ask(single, "validate input", { includeRankingMetadata: true, source: true });
    assert.ok(r.ranking);
    const internal = r.ranking.baseline.map((b) => b.hit).filter((h) => h.kind === "symbol");
    assert.ok(internal.some((h) => typeof h.code === "string"));
  });

  test("raw baseline order without file-first", () => {
    const r = ask(single, "validate input", { fileFirst: false, limit: 10 });
    assert.equal(r.mode, "lexical");
    assert.ok(r.hits.length > 0);
    assert.equal(r.ranking, undefined);
    for (let i = 1; i < r.hits.length; i++) assert.ok(r.hits[i - 1].score >= r.hits[i].score);
  });

  test("bounded file complement without the top lock", () => {
    const r = ask(single, "validate input", { fileFirst: false, fileComplement: true, limit: 10 });
    assert.ok(r.hits.length > 0);
    const files = r.hits.filter((h) => h.kind === "symbol").map((h) => h.pointer.split(":")[0]);
    assert.equal(new Set(files).size, files.length, "one representative per file");
  });

  test("pure lexical ranking with graphRank off and a wide limit", () => {
    const r = ask(single, "validate input handle request", { graphRank: false, limit: 30 });
    assert.equal(r.mode, "lexical");
    assert.ok(r.hits.some((h) => h.title.startsWith("handleRequest")));
    assert.ok(r.hits.some((h) => h.title.startsWith("validateInput")));
  });

  test("no matches yields the empty mode with escalation nudge", () => {
    const r = ask(single, "zzqqxxjj");
    assert.equal(r.mode, "empty");
    assert.equal(r.hits.length, 0);
    assert.match(r.note ?? "", /no matching nodes/);
    assert.equal(r.coverage, undefined);
    assert.match(formatAsk(r), /no hits — don't re-ask/);
  });

  test("no graph at all still answers (empty)", () => {
    const r = ask(empty, "anything here");
    assert.equal(r.mode, "empty");
    assert.deepEqual(r.hits, []);
    assert.match(r.note ?? "", /no matching nodes/);
  });
});

describe("lexical mode (sub-project layout)", () => {
  test("a query matching both sub-projects returns code from each", () => {
    const r = ask(multi, "validate token", { limit: 10 });
    assert.equal(r.mode, "lexical");
    assert.ok(r.hits.some((h) => h.pointer.startsWith("frontend/")), "frontend hit");
    assert.ok(r.hits.some((h) => h.pointer.startsWith("backend/")), "backend hit");
    assert.match(formatAsk(r), /validate/i);
  });

  test("ranking metadata groups hits by file", () => {
    const r = ask(multi, "validate token login", { includeRankingMetadata: true, limit: 10 });
    assert.ok(r.ranking);
    assert.ok(r.ranking.groups.length > 0);
    assert.ok(r.ranking.groups.every((g) => g.key.startsWith("file:") || g.key.startsWith("concept:")));
    assert.ok(r.ranking.baseline.length > 0);
  });

  test("raw order is score-descending and graph-free ranking still finds login", () => {
    const raw = ask(multi, "validate token", { fileFirst: false, limit: 10 });
    assert.ok(raw.hits.length > 0);
    for (let i = 1; i < raw.hits.length; i++) assert.ok(raw.hits[i - 1].score >= raw.hits[i].score);
    const flat = ask(multi, "validate token login user", { graphRank: false, limit: 30 });
    assert.ok(flat.hits.some((h) => /login/i.test(h.title)));
  });

  test("--in narrows to one sub-project", () => {
    const r = ask(multi, "validate token", { in: "backend" });
    assert.ok(r.hits.length > 0);
    for (const h of r.hits) assert.ok(h.pointer.startsWith("backend/"), h.pointer);
  });

  test("zero hits says nothing matched", () => {
    const r = ask(multi, "zzqqxxjj");
    assert.equal(r.mode, "empty");
    assert.match(r.note ?? "", /no matching nodes/);
  });
});

describe("skeleton", () => {
  test("lists definitions by exact path and by basename", () => {
    const s = skeleton(single, "src/server.ts");
    assert.equal(s.file, "src/server.ts");
    assert.deepEqual(
      s.entries.map((e) => e.name),
      ["handleRequest", "validateInput", "startServer", "lonelyHelper"],
    );
    assert.match(formatSkeleton(s), /handleRequest/);
    const b = skeleton(single, "server.ts");
    assert.equal(b.file, "src/server.ts");
  });

  test("ambiguous, missing and graph-less lookups explain themselves", () => {
    assert.match(skeleton(single, "util.ts").note ?? "", /ambiguous — matches: lib\/util\.ts, src\/util\.ts/);
    assert.equal(skeleton(single, "nope.ts").note, "no definitions indexed for this file");
    const none = skeleton(empty, "x.ts");
    assert.match(none.note ?? "", /no wiring graph/);
    assert.match(formatSkeleton(none), /no wiring graph/);
  });
});
