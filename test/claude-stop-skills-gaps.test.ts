import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { offerEndsReply } from "../src/skills/offer-moment.js";
import { noticeText, stopBlockReason } from "../src/skills/offers.js";
import { guardrailStopsIn } from "../src/skills/value-line.js";
import * as runs from "../src/trace/runs.js";

type StopModule = typeof import("../src/claude/stop-skills.js");
type PoolRun = Parameters<StopModule["notePool"]>[0];

const now = new Date(2025, 4, 12, 12);
const repo = "acme/shop";
const lines: [string, string] = [
  "That was 4 commands this time, 1 failed.",
  "Keep this as a skill, just for you in this repo? (yes / no)",
];
const offerText = lines.join("\n");

function offer(channel: "stop" | "post-tool") {
  return {
    moment: "repeated",
    channel,
    lines: [...lines] as [string, string],
    shownAt: channel === "stop" ? now.toISOString() : null,
    yes: null,
    showMe: false,
    typedAfter: [],
  };
}

function fixture(dir: string) {
  return {
    ctx: {
      env: { TRAIL_HOME: join(dir, "home") },
      now,
      host: "claude",
      sessionId: "stop-gaps",
      sessionHash: "stop-gaps-hash",
      transcriptPath: join(dir, "transcript.jsonl"),
      checkout: dir,
      repoKey: repo as string | null,
      fold: true,
      subagent: false,
      learn: true,
    },
    fold: { typed: [], lastAssistant: "The release is complete." },
    st: {
      epoch: 0,
      runs: [] as PoolRun[],
      pendingOffer: null as ReturnType<typeof offer> | null,
      offerUsed: false,
      offerUsedBy: null as string | null,
      withdrewFor: null as string | null,
    },
    gateOpen: true,
    lockBusy: false,
    stopNotice: false,
    settled: [] as {
      name: string;
      outcome: string;
      use: { calls: number; failed: number };
      state?: { source: { commands: number; failed: number } };
    }[],
  };
}

let dir: string;
let stop: StopModule;
let f: ReturnType<typeof fixture>;

// Supply the fold and persisted state at the session-lock boundary. Keep the
// real reply matching and text formatting; spy on the writes Stop coordinates.
const gate = mock.fn((_input: unknown, _dir: string, _env: NodeJS.ProcessEnv) =>
  f.gateOpen ? { ok: true, ctx: f.ctx } : { ok: false },
);
const lock = mock.fn((
  _ctx: unknown,
  _options: unknown,
  fn: (state: typeof f.st, fold: typeof f.fold) => unknown,
) => f.lockBusy ? undefined : fn(f.st, f.fold));
const shown = mock.fn((_offer: unknown, _repo: unknown, _env: unknown, _at: unknown) => {});
const notShown = mock.fn((_offer: unknown, _repo: unknown, _env: unknown, _at: unknown) => {});
const sync = mock.fn();
const hookError = mock.fn();
const settle = mock.fn(() => f.settled);
const refresh = mock.fn((_repo: unknown, _env: unknown) => {});
const value = mock.fn((_repo: unknown, _counts: unknown, _env: unknown, _at: unknown) => {});
const due = mock.fn(() => ({ due: false }));
const known = mock.fn((_repo: unknown, _checkout: unknown, _env: unknown) => true);
const poolDay = mock.fn((
  _repo: unknown, _job: unknown, _day: unknown, _sheet: unknown, _env: unknown, _at: unknown,
) => true);

const replacements = {
  "../trace/skill-session.js": {
    skillsGate: gate,
    withSkillSession: lock,
    currentRun: () => null,
  },
  "./skills-hook-util.js": { syncGate: sync, hookError },
  "./walls-hook.js": { wallsAtStop: () => 2, guardrailCounts: () => {} },
  "../skills/value-line.js": { guardrailStopsIn, noteValue: value },
  "../notes/lesson-index.js": { refreshLessonIndex: refresh },
  "../skills/credit.js": { noteCorrectionLine: () => {}, settleCredit: settle },
  "../skills/host-facts.js": {
    hostFacts: () => ({ offerChannel: "stop", stopNotice: f.stopNotice }),
  },
  "../skills/offer-moment.js": { offerEndsReply, offerRepo: () => repo, offerDue: due },
  "../skills/offers.js": { recordShown: shown, recordNotShown: notShown, noticeText, stopBlockReason },
  "../trace/runs.js": {
    checkedSuccess: runs.checkedSuccess,
    runHelpers: runs.runHelpers,
    writeRunSheet: runs.writeRunSheet,
    costly: () => true,
  },
  "../trace/known-repo.js": { repoKnown: known },
  "../trace/pool.js": { notePoolDay: poolDay },
};

let fetchStub: ReturnType<typeof mock.method<typeof globalThis, "fetch">>;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "trail-stop-gaps-"));
  fetchStub = mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected HTTP request in Stop test");
  });

  // Scope the substitutions to this import and to Stop's direct dependencies.
  // No experimental test-runner flags or modifications to on-disk modules.
  const target = new URL("../src/claude/stop-skills.ts", import.meta.url).href;
  const key = `${import.meta.url}#stop-dependencies`;
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value: replacements });
  const urls = new Map(Object.entries(replacements).map(([specifier, exports]) => {
    const bridge = `globalThis[${JSON.stringify(key)}][${JSON.stringify(specifier)}]`;
    const source = Object.keys(exports).map((name) => `export const ${name} = ${bridge}.${name};`).join("\n");
    return [specifier, `data:text/javascript,${encodeURIComponent(source)}`];
  }));
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = context.parentURL?.split("?")[0] === target ? urls.get(specifier) : undefined;
      return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
    },
  });
  try {
    stop = await import("../src/claude/stop-skills.js");
  } finally {
    hooks.deregister();
    if (previous) Object.defineProperty(globalThis, key, previous);
    else Reflect.deleteProperty(globalThis, key);
  }
});

after(() => {
  fetchStub?.mock.restore();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function reset() {
  f = fixture(dir);
  for (const fn of [gate, lock, shown, notShown, sync, hookError, settle, refresh, value, due, known, poolDay]) {
    fn.mock.resetCalls();
  }
}

function payload(fields: Record<string, unknown> = {}) {
  return {
    hook_event_name: "Stop",
    session_id: f.ctx.sessionId,
    transcript_path: f.ctx.transcriptPath,
    cwd: dir,
    ...fields,
  };
}

function run(fields?: Record<string, unknown>) {
  return stop.stopSkillsRun(payload(fields), dir, f.ctx.env);
}

describe("Claude Stop skills gaps", { concurrency: false }, () => {
  test("the public wrapper returns only hook output and defaults to the process environment", () => {
    reset();
    f.gateOpen = false;

    assert.deepEqual(stop.stopSkills(payload(), dir), {});
    assert.equal(gate.mock.calls[0]!.arguments[2], process.env);
    assert.equal(lock.mock.callCount(), 0);
  });

  test("a busy session defers settling and leaves the pending offer untouched", () => {
    reset();
    f.lockBusy = true;
    const pending = offer("post-tool");
    f.st.pendingOffer = pending;

    assert.deepEqual(run({ last_assistant_message: offerText }), { out: {}, sent: [] });
    assert.equal(f.st.pendingOffer, pending);
    assert.equal(pending.shownAt, null);
    assert.equal(shown.mock.callCount(), 0);
    assert.equal(settle.mock.callCount(), 0);
  });

  test("an offer at the end of the Stop payload is shown even before the transcript catches up", () => {
    reset();
    const pending = offer("post-tool");
    f.st.pendingOffer = pending;

    const result = run({ last_assistant_message: `Released successfully.\n\n${offerText}` });
    assert.deepEqual(result.out, {});
    assert.deepEqual(result.sent, [["skill_offered", { moment: pending.moment }]]);
    assert.equal(f.st.pendingOffer, pending);
    assert.equal(pending.shownAt, now.toISOString());
    assert.equal(f.st.offerUsed, true);
    assert.equal(f.st.offerUsedBy, "offer");
    assert.deepEqual(shown.mock.calls[0]!.arguments, [pending, repo, f.ctx.env, now]);
    assert.equal(notShown.mock.callCount(), 0);

    assert.deepEqual(run({ last_assistant_message: offerText }).sent, []);
    assert.equal(shown.mock.callCount(), 1, "a later Stop must not count the same offer twice");
  });

  test("a post-tool offer followed by other words is cleared rather than counted", () => {
    reset();
    const pending = offer("post-tool");
    f.st.pendingOffer = pending;
    f.st.runs.push({ epoch: 0, stepCalls: 0 } as PoolRun);
    f.fold.lastAssistant = `${offerText}\nI'll check the release notes next.`;

    assert.deepEqual(run({ last_assistant_message: " \n" }), { out: {}, sent: [] });
    assert.equal(f.st.pendingOffer, null);
    assert.equal(f.st.offerUsed, false);
    assert.equal(shown.mock.callCount(), 0);
    assert.deepEqual(notShown.mock.calls[0]!.arguments, [pending, repo, f.ctx.env, now]);
    assert.equal(due.mock.callCount(), 0, "the post-tool offer spent this Stop's opportunity");
  });

  test("an active Stop clears a blocked offer the agent omitted", () => {
    reset();
    const pending = offer("stop");
    f.st.pendingOffer = pending;
    f.st.offerUsed = true;
    f.st.offerUsedBy = "offer";

    assert.deepEqual(run({ stop_hook_active: true }), { out: {}, sent: [] });
    assert.equal(f.st.pendingOffer, null);
    assert.equal(f.st.offerUsed, true);
    assert.deepEqual(notShown.mock.calls[0]!.arguments, [pending, repo, f.ctx.env, now]);
    assert.equal(sync.mock.callCount(), 1);
  });

  test("an active Stop keeps the blocked offer when it ends the reply", () => {
    reset();
    const pending = offer("stop");
    f.st.pendingOffer = pending;
    f.st.offerUsed = true;
    f.fold.lastAssistant = `Released successfully.\n\n${offerText}`;

    assert.deepEqual(run({ stop_hook_active: true }), { out: {}, sent: [] });
    assert.equal(f.st.pendingOffer, pending);
    assert.equal(notShown.mock.callCount(), 0);
    assert.equal(shown.mock.callCount(), 0);
  });

  test("judging a reply removes the offer's failure count but preserves the actual report", () => {
    reset();
    const pending = offer("stop") as NonNullable<Parameters<StopModule["withoutOffer"]>[1]>;
    const report = "Released successfully.";
    assert.equal(stop.withoutOffer(`${report}\r\n\r\n${lines.join("\r\n")}`, pending), report);
    assert.equal(stop.withoutOffer(offerText, pending), "");
    const followed = `${offerText}\nI'll check the release notes next.`;
    assert.equal(stop.withoutOffer(followed, pending), followed);
  });

  test("Stop counts wall fixes for a known learning repo and refreshes the lesson index", () => {
    reset();

    assert.deepEqual(run(), { out: {}, sent: [] });
    assert.deepEqual(value.mock.calls[0]!.arguments, [
      repo, { guardrailStops: 0, wallFixes: 2 }, f.ctx.env, now,
    ]);
    assert.deepEqual(refresh.mock.calls[0]!.arguments, [repo, f.ctx.env]);

    f.ctx.repoKey = null;
    assert.deepEqual(run().out, {});
    assert.equal(value.mock.callCount(), 1, "a repo-less Stop must not record weekly value");
  });

  test("a non-learning Stop does not settle credit or record weekly value", () => {
    reset();
    f.ctx.learn = false;
    f.stopNotice = true;

    assert.deepEqual(run(), { out: {}, sent: [] });
    assert.equal(settle.mock.callCount(), 0);
    assert.equal(value.mock.callCount(), 0);
    assert.equal(sync.mock.callCount(), 1);
  });

  test("a notice-capable host reports settled uses with a by-hand comparison only when available", () => {
    reset();
    f.stopNotice = true;
    f.settled.push(
      {
        name: "release-npm",
        outcome: "passed",
        use: { calls: 2, failed: 0 },
        state: { source: { commands: 7, failed: 2 } },
      },
      { name: "integration-tests", outcome: "failed", use: { calls: 3, failed: 1 } },
    );

    const out = stop.stopSkills(payload(), dir, f.ctx.env);
    assert.equal(out.block, undefined);
    assert.deepEqual(out.notice?.split("\n"), [
      "trail: release-npm, 2 commands, 0 failed (by hand last time: 7 commands, 2 failed)",
      "trail: integration-tests, 3 commands, 1 failed",
    ]);
  });

  test("a checked release notes its local day and points the pool at its sheet", () => {
    reset();
    const release = {
      id: "r-release",
      job: "release",
      jobWords: ["release"],
      repoKey: repo,
      startedAt: now.toISOString(),
      stepCalls: 4,
      sheet: "checked",
      poolNoted: false,
    } as PoolRun;

    stop.notePool(release, f.ctx);
    assert.deepEqual(known.mock.calls[0]!.arguments, [repo, dir, f.ctx.env]);
    assert.deepEqual(poolDay.mock.calls[0]!.arguments, [
      repo, { job: "release", words: ["release"] },
      { d: "2025-05-12", s: f.ctx.sessionHash, costly: true },
      release.id, f.ctx.env, now,
    ]);
    assert.equal(release.poolNoted, true);

    known.mock.mockImplementationOnce(() => false);
    const unknownCheckout = { ...release, checkout: join(dir, "unregistered"), poolNoted: false };
    stop.notePool(unknownCheckout, f.ctx);
    assert.equal(known.mock.calls[1]!.arguments[1], unknownCheckout.checkout);
    assert.equal(poolDay.mock.callCount(), 1);
    assert.equal(unknownCheckout.poolNoted, false);
  });
});
