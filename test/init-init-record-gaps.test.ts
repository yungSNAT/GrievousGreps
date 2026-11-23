/**
 * Gap tests for src/init/init-record.ts: the strict reader (each pending kind, priors, branches, runs, notices, v1
 * upgrade), the on-disk shape, the link guard, the busy lock and the record listing.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpRepo } from "./helpers.js";
import {
  emptyRecord,
  initRecordPath,
  listInitRecords,
  newRunId,
  pendingItems,
  readInitRecord,
  recordFrom,
  uncompiledOf,
  updateInitRecord,
  writeInitRecord,
  MAX_RUNS,
} from "../src/init/init-record.js";
import { WALLS } from "../src/trace/walls.js";
import { withLock, writePrivate } from "../src/util/private-fs.js";

let TRAIL = "";
let ENV: NodeJS.ProcessEnv = {};
before(() => {
  TRAIL = tmpRepo("init-record-gaps");
  ENV = { HOME: TRAIL, TRAIL_HOME: TRAIL };
});
after(() => rmSync(TRAIL, { recursive: true, force: true }));

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const COUNT = { days: 3, from: "2025-01-01", to: "2025-01-05", costly: 2, repos: -1 };
const wall = WALLS.find((w) => w.guardrail)!;
const wallCheck = (wall.guardrail as { check?: string }).check;

const src = (prior: unknown = null) => ({ t: "s1.jsonl", size: 100, mtimeMs: 1.5, run: { from: 0, to: 10 }, prior, skillSha: SHA_A });

function base(n: number, id: string, kind: string, key: string, extra: Record<string, unknown>) {
  return { n, id, kind, key, plainName: `item ${n}`, nameWords: ["ship", "it"], count: COUNT, applies: "this repo", scope: "repo", typed: true, ticked: true, ...extra };
}

function writeRaw(key: string, data: unknown): void {
  const p = initRecordPath(key, ENV);
  mkdirSync(dirname(p), { recursive: true });
  writePrivate(p, JSON.stringify(data));
}

describe("paths and ids", () => {
  test("initRecordPath makes one folder per key part, dropping dot parts", () => {
    assert.ok(initRecordPath("local/home-dev-acme-shop", ENV).endsWith(join("init", "local", "home-dev-acme-shop.json")));
    assert.ok(initRecordPath("a/./../b", ENV).endsWith(join("init", "a", "b.json")));
    assert.ok(initRecordPath("", ENV).endsWith(join("init", "repo.json")));
  });

  test("newRunId is ir- and four hex digits", () => {
    for (let i = 0; i < 5; i++) assert.match(newRunId(), /^ir-[0-9a-f]{4}$/);
  });
});

describe("recordFrom", () => {
  test("non-object input gives an empty record", () => {
    assert.deepEqual(recordFrom(null, "k/x"), emptyRecord("k/x"));
    assert.deepEqual(recordFrom([1, 2], "k/x"), emptyRecord("k/x"));
  });

  test("a v1 file keeps only its closed quote hashes", () => {
    const r = recordFrom({ v: 1, pending: [{ title: "x" }], closed: [{ quotes: ["0123456789abcdef", "nothex"] }, { quotes: ["0123456789abcdef", "fedcba9876543210"] }, "x"] }, "k/v1");
    assert.deepEqual(r.closedV1, ["0123456789abcdef", "fedcba9876543210"]);
    assert.deepEqual(r.pending, []);
    assert.equal(r.v, 2);
  });

  test("each pending kind is read strictly", () => {
    const raw = {
      v: 2,
      pending: [
        base(1, "i-0000000001", "skill", "local/acme|job:ship", { skill: { src: src({ t: "p.jsonl", from: 2, to: 5 }), branches: ["main", "bad name", "release/1.x"] } }),
        base(2, "i-0000000002", "guardrail", "wall:force-push", { guardrail: { cls: wall.cls } }),
        base(3, "i-0000000003", "preference", "pref:0123456789abcdef", { pref: { refs: [{ t: "s.jsonl", o: 4, s: SHA_B }] } }),
        base(4, "i-0000000004", "review", "wall:x", {}),
        base(5, "i-0000000005", "guardrail", "wall:x", { guardrail: { cls: "no-such-wall" } }),
        base(6, "i-0000000006", "skill", "local/acme|job:release", { skill: { src: src({ t: "p.jsonl", from: 5, to: 2 }) } }),
        base(7, "i-0000000007", "preference", "pref:0123456789abcdef", { pref: { refs: [{ t: "s.jsonl", o: 4, s: "short" }] } }),
        base(1, "i-0000000008", "guardrail", "wall:dup", { guardrail: { cls: wall.cls } }),
        base(9, "i-0000000009", "skill", "bad key", { skill: { src: src() } }),
        base(10, "i-0000000010", "skill", "local/acme|job:release", { skill: { src: src(), branches: ["main"] }, scope: "x", typed: "yes" }),
      ],
    };
    const r = recordFrom(raw, "local/acme");
    assert.deepEqual(r.pending.map((p) => p.n), [1, 2, 3, 10]);
    const [skill, guard, pref, rel] = pendingItems(r);
    assert.deepEqual(skill!.skill, { src: { ...src(), prior: { t: "p.jsonl", from: 2, to: 5 } }, branches: ["main", "release/1.x"] });
    assert.deepEqual(skill!.count, { days: 3, from: "2025-01-01", to: "2025-01-05", costly: 2 });
    assert.deepEqual(skill!.nameWords, ["ship", "it"]);
    assert.deepEqual(guard!.guardrail, wallCheck ? { cls: wall.cls, check: wallCheck } : { cls: wall.cls });
    assert.deepEqual(pref!.pref, { refs: [{ t: "s.jsonl", o: 4, s: SHA_B }] });
    assert.deepEqual(pref!.nameWords, [], "a preference's words are never read back");
    assert.deepEqual(rel!.skill, { src: src() }, "branches only for a ship job");
    assert.equal(rel!.scope, "personal");
    assert.equal(rel!.typed, false);
  });

  test("runs, notice, handover and id lists", () => {
    const run = {
      id: "ir-abcd", at: "2025-01-05T00:00:00Z", by: "person", screen: "tty",
      reads: {
        sessions: 3, days: 2, from: "2025-01-01", to: "bad", parent: 1, read: ["a".repeat(12), "zz", "a".repeat(12)],
        skipped: [{ sh: "b".repeat(12), why: "too-big" }, { sh: "nothex", why: "x" }, null],
        uncompiled: [{ job: "release", days: 2, why: ["no-check", "no-check", "Bad Text"] }, { job: "dance", days: 1, why: ["x"] }, { job: "ship", days: 1, why: ["Bad"] }],
      },
      model: "claude-x", modelWhy: "x".repeat(41), calls: 2, tokens: -1, ms: 1.5, shown: ["i-0123456789", "nope"],
    };
    const r = recordFrom({
      v: 2,
      runs: [run, { ...run, id: "ir-beef", by: "robot" }, { ...run, id: "ir-cafe", screen: "web" }, { id: "ir-0001", at: "t", by: "agent", screen: "relay" }],
      pendingFrom: "ir-abcd", shownAt: 5, handedAt: "2025-01-06",
      handover: { session: "sess-1", offset: 10 },
      closed: ["i-0123456789", "bad"], closedV1: ["0123456789abcdef"], deferred: ["i-9876543210"],
      notice: { run: "ir-abcd", at: "now", shownAt: 7, items: [
        { kind: "skill", name: "release-npm", id: "s-1", forget: "release-npm" },
        { kind: "preference", name: "", id: "l-1", forget: "l-1" },
        { kind: "bogus", name: "x", id: "x", forget: "x" },
      ] },
    }, "local/acme");
    assert.deepEqual(r.runs.map((x) => x.id), ["ir-abcd", "ir-0001"]);
    const a = r.runs[0]!;
    assert.deepEqual(a.reads, {
      sessions: 3, days: 2, from: "2025-01-01", to: null, parent: 1, read: ["a".repeat(12)],
      skipped: [{ sh: "b".repeat(12), why: "too-big" }], uncompiled: [{ job: "release", days: 2, why: ["no-check"] }],
    });
    assert.equal(a.model, "claude-x");
    assert.equal(a.modelWhy, null);
    assert.equal(a.tokens, 0);
    assert.equal(a.ms, 0);
    assert.deepEqual(a.shown, ["i-0123456789"]);
    const b = r.runs[1]!;
    assert.equal(b.model, "none");
    assert.deepEqual(b.reads, { sessions: 0, days: 0, from: null, to: null, parent: 0, read: [], skipped: [] });
    assert.equal(r.pendingFrom, "ir-abcd");
    assert.equal(r.shownAt, null);
    assert.equal(r.handedAt, "2025-01-06");
    assert.deepEqual(r.handover, { session: "sess-1", offset: 10 });
    assert.deepEqual(r.closed, ["i-0123456789"]);
    assert.deepEqual(r.closedV1, ["0123456789abcdef"]);
    assert.deepEqual(r.deferred, ["i-9876543210"]);
    assert.deepEqual(r.notice, { run: "ir-abcd", at: "now", shownAt: null, items: [
      { kind: "skill", name: "release-npm", id: "s-1", forget: "release-npm" },
      { kind: "preference", name: "", id: "l-1", forget: "l-1" },
    ] });
  });

  test("bad notice, handover and pendingFrom read as null; runs are capped", () => {
    const runs = Array.from({ length: MAX_RUNS + 3 }, (_, i) => ({ id: `ir-${(0x1000 + i).toString(16)}`, at: "t", by: "script", screen: "list" }));
    const r = recordFrom({ v: 2, runs, notice: { run: "bad", at: "x", items: [] }, handover: { session: "", offset: 3 }, pendingFrom: "ir-zz" }, "k");
    assert.equal(r.runs.length, MAX_RUNS);
    assert.equal(r.runs[0]!.id, `ir-${(0x1003).toString(16)}`);
    assert.equal(r.notice, null);
    assert.equal(r.handover, null);
    assert.equal(r.pendingFrom, null);
  });
});

test("uncompiledOf keeps known jobs with codes only", () => {
  assert.deepEqual(uncompiledOf("x"), []);
  assert.deepEqual(uncompiledOf([null, { job: "tests", days: 0, why: ["a"] }, { job: "tests", days: 4, why: "a" }, { job: "sweep", days: 4, why: ["no-run", 3, "x".repeat(41)] }]),
    [{ job: "sweep", days: 4, why: ["no-run"] }]);
});

describe("on disk", () => {
  test("write then read round-trips; preference words and compiled checks never go to disk", () => {
    const key = "local/disk-shop";
    const r = emptyRecord(key);
    const skill = recordFrom({ v: 2, pending: [base(1, "i-00000000a1", "skill", "local/x|job:ship", { skill: { src: src() } })] }, key).pending[0]!;
    (skill.skill as Record<string, unknown>).compiled = { check: "git rev-parse refs/heads/main && git push refs/heads/dev" };
    const pref = recordFrom({ v: 2, pending: [base(2, "i-00000000a2", "preference", "pref:0123456789abcdef", { pref: { refs: [{ t: "s", o: 0, s: SHA_B }] } })] }, key).pending[0]!;
    pref.nameWords = ["secret", "words"];
    r.pending = [skill, pref];
    writeInitRecord(key, r, ENV);
    const disk = JSON.parse(readFileSync(initRecordPath(key, ENV), "utf8"));
    assert.equal(disk.v, 2);
    assert.equal(disk.repo, key);
    assert.deepEqual(disk.pending[0].skill, { src: src(), branches: ["main", "dev"] });
    assert.deepEqual(disk.pending[1].nameWords, []);
    const back = readInitRecord(key, ENV);
    assert.deepEqual(back.pending[0]!.skill?.branches, ["main", "dev"]);
    assert.deepEqual(back.pending.map((p) => p.id), ["i-00000000a1", "i-00000000a2"]);
  });

  test("updateInitRecord changes the record under its lock", () => {
    const key = "local/update-shop";
    const out = updateInitRecord(key, (r) => { r.closed.push("i-0000000abc"); }, ENV);
    assert.deepEqual(out.closed, ["i-0000000abc"]);
    assert.deepEqual(readInitRecord(key, ENV).closed, ["i-0000000abc"]);
  });

  test("a busy record throws after the wait", () => {
    const key = "local/busy-shop";
    updateInitRecord(key, () => {}, ENV);
    const held = withLock(initRecordPath(key, ENV), () => {
      assert.throws(() => updateInitRecord(key, (r) => { r.closed.push("i-0000000abc"); }, ENV, 50), /busy/);
      return true;
    }, 1000);
    assert.ok(held.ok);
    assert.deepEqual(readInitRecord(key, ENV).closed, []);
  });

  test("unreadable JSON reads as an empty record", () => {
    const key = "local/broken-shop";
    const p = initRecordPath(key, ENV);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{not json");
    assert.deepEqual(readInitRecord(key, ENV), emptyRecord(key));
  });

  test("a file where the record's folder should be blocks reading and writing", () => {
    const key = "blocked/owner/shop";
    // `<trail home>/init/blocked` is a plain file, so the record's folder can't be a plain folder.
    const initRoot = dirname(initRecordPath("x", ENV));
    const blocker = join(initRoot, "blocked");
    mkdirSync(initRoot, { recursive: true });
    writeFileSync(blocker, "not a folder");
    try {
      assert.deepEqual(readInitRecord(key, ENV), emptyRecord(key));
      assert.throws(() => writeInitRecord(key, emptyRecord(key), ENV), /a link sits in ~\/\.trail\/init/);
      assert.throws(() => updateInitRecord(key, () => {}, ENV), /Remove the link/);
      assert.equal(readFileSync(blocker, "utf8"), "not a folder", "nothing written through it");
    } finally {
      rmSync(blocker, { force: true });
    }
  });
});

test("listInitRecords finds every record with its key", () => {
  const home = tmpRepo("init-record-list");
  const env = { HOME: home, TRAIL_HOME: home };
  try {
    assert.deepEqual(listInitRecords(env), [], "no init folder yet");
    const a = initRecordPath("local/one", env);
    const b = initRecordPath("gh/acme/two", env);
    for (const [p, closed] of [[a, ["i-0000000001"]], [b, []]] as const) {
      mkdirSync(dirname(p), { recursive: true });
      writePrivate(p, JSON.stringify({ v: 2, closed }));
    }
    writeFileSync(join(dirname(a), "notes.txt"), "x");
    writeFileSync(join(dirname(a), "bad.json"), "{nope");
    const got = listInitRecords(env).sort((x, y) => x.repoKey.localeCompare(y.repoKey));
    assert.deepEqual(got.map((g) => g.repoKey), ["gh/acme/two", "local/one"]);
    assert.deepEqual(got[1]!.record.closed, ["i-0000000001"]);
    assert.equal(got[0]!.record.repo, "gh/acme/two");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeRaw records read back through readInitRecord", () => {
  writeRaw("local/raw-shop", { v: 2, deferred: ["i-0000000def", "i-0000000def"] });
  assert.deepEqual(readInitRecord("local/raw-shop", ENV).deferred, ["i-0000000def"]);
});
