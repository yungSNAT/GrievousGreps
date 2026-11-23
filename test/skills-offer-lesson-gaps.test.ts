import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixCommand, offerLinesOf } from "../src/skills/offer-lesson.js";
import type { PendingOffer, SkillSessionState } from "../src/trace/types.js";

const OFFSET = 100;
const PUSH_VERSION = "git push origin v1.4.3";
const PUSH_TAGS = "git push origin --tags";

let root: string;
let where: { checkout: string; home: string };

before(() => {
  root = mkdtempSync(join(tmpdir(), "offer-lesson-gaps-"));
  where = { checkout: join(root, "checkout"), home: join(root, "home") };
  mkdirSync(where.checkout);
  mkdirSync(where.home);
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Offer lesson tests must not use the network");
  });
});

after(() => {
  mock.restoreAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

interface CallFields {
  cmd?: string | null;
  kind?: "step" | "look";
  failed?: boolean;
  truncated?: boolean;
  secret?: boolean;
  bg?: boolean;
  fromMark?: boolean;
  src?: { use: number; result: number | null };
}

function call(id: string, use: number, fields: CallFields = {}) {
  return {
    id,
    cmd: PUSH_VERSION,
    kind: "step" as const,
    failed: false,
    src: { use, result: use + 1 },
    ...fields,
  };
}

type Call = ReturnType<typeof call>;

function findFix(runs: Array<Call[] | null>, steps: string[] = []) {
  // Only the recorded calls are read; a stale run may not have a call array.
  const st = {
    runs: runs.map((calls, i) => ({ id: `r-${i}`, calls })),
  } as unknown as SkillSessionState;
  return fixCommand(st, OFFSET, steps, {}, where);
}

describe("fixCommand", () => {
  test("orders eligible calls by transcript offset, ignoring stale runs and calls without a usable offset", () => {
    const fix = findFix([
      null,
      [
        call("before-correction", OFFSET - 10),
        call("at-correction", OFFSET),
        call("no-source", OFFSET + 1, { src: undefined }),
        call("fractional-offset", OFFSET + 1.5),
        call("later-fix", OFFSET + 50, { cmd: PUSH_TAGS }),
      ],
      [call("first-fix", OFFSET + 20)],
    ]);

    assert.deepEqual(fix, { id: "first-fix", cmd: PUSH_VERSION });
  });

  const skipped: Array<[string, CallFields]> = [
    ["a failed call", { failed: true }],
    ["a call without a command", { cmd: null }],
    ["a truncated command", { truncated: true }],
    ["a command flagged as secret", { secret: true }],
    ["a background call", { bg: true }],
    ["a call with no recorded result", { src: { use: OFFSET + 10, result: null } }],
    ["a call whose recorded kind is look", { kind: "look" }],
    ["a look command recorded as a step", { cmd: "git status" }],
  ];

  for (const [reason, fields] of skipped) {
    test(`skips ${reason} in favor of a later successful step`, () => {
      const fix = findFix([[
        call("skipped", OFFSET + 10, fields),
        call("later-fix", OFFSET + 20, { cmd: PUSH_TAGS }),
      ]]);

      assert.deepEqual(fix, { id: "later-fix", cmd: PUSH_TAGS });
    });
  }

  test("accepts a call recovered from a mark even without a transcript result", () => {
    const fix = findFix([[
      call("marked-fix", OFFSET + 10, {
        fromMark: true,
        src: { use: OFFSET + 10, result: null },
      }),
      call("later-fix", OFFSET + 20, { cmd: PUSH_TAGS }),
    ]]);

    assert.deepEqual(fix, { id: "marked-fix", cmd: PUSH_VERSION });
  });

  test("passes over a successful command that is already a skill step", () => {
    const runs = [[
      call("existing-step", OFFSET + 10),
      call("new-step", OFFSET + 20, { cmd: PUSH_TAGS }),
    ]];

    assert.deepEqual(findFix(runs), { id: "existing-step", cmd: PUSH_VERSION });
    assert.deepEqual(findFix(runs, [PUSH_VERSION]), { id: "new-step", cmd: PUSH_TAGS });
  });

  test("returns neither an ID nor a command if the only successful call repeats a skill step", () => {
    const fix = findFix([[call("existing-step", OFFSET + 10)]], [PUSH_VERSION]);

    assert.deepEqual(fix, { id: null, cmd: null });
  });

  test("trims a fix before enforcing the length limit and retains the ID of an overlong fix", () => {
    const refs = Array.from({ length: 22 }, (_, i) => `rel/v1.4.${i + 10}`);
    const prefix = `git push origin ${refs.join(" ")} `;
    const atLimit = prefix + "release-v1.4.100".padEnd(300 - prefix.length, "a");

    assert.deepEqual(
      findFix([[call("at-limit", OFFSET + 10, { cmd: `${atLimit}   ` })]]),
      { id: "at-limit", cmd: atLimit },
    );
    assert.deepEqual(
      findFix([[
        call("over-limit", OFFSET + 10, { cmd: `${atLimit}a` }),
        call("later-fix", OFFSET + 20, { cmd: PUSH_TAGS }),
      ]]),
      { id: "over-limit", cmd: null },
    );
  });
});

test("offerLinesOf returns stored lines for a repeated offer but not for a correction", () => {
  const repeated: PendingOffer = {
    offerId: "o-000001",
    moment: "repeated",
    runId: "r-1",
    name: "release-npm",
    key: "repo|job:release",
    lines: ["You've run this release more than once.", "Save it as a skill? (yes / no)"],
    channel: "stop",
    shownAt: null,
    showMe: false,
    yes: null,
    typedAfter: [],
  };

  assert.deepEqual(offerLinesOf(repeated, null), [
    "You've run this release more than once.",
    "Save it as a skill? (yes / no)",
  ]);
  assert.equal(offerLinesOf({ ...repeated, moment: "correction" }, null), null);
});
