/**
 * Gaps in moment 5's offer (src/skills/offer-update.ts): the version parser,
 * the early returns before the plan (pending offer, notice channel, a check
 * that isn't there or didn't pass, a missing or foreign sheet, settled uses
 * that don't match, a lesson watch), a version Trail can't key, the repo
 * fallback, and planners that return nothing or a different plan.
 * Made-up acme/shop only.
 */
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import type { RunCall, SkillSessionState } from "../src/trace/types.js";
import { settleCredit } from "../src/skills/credit.js";
import { updateOfferDue, versionNumber, type FoldPlanner } from "../src/skills/offer-update.js";
import { writeLesson } from "../src/skills/lessons.js";
import { renderSkillMd, skillHash } from "../src/skills/skillmd.js";
import { updateSkillState } from "../src/skills/state.js";
import {
  call, cleanup, injFor, input, lab, NOW, releaseCalls, runOf, sheetOf, SHOP, standIn, state, writeSheet, type Lab,
} from "./skills-moments-2-fixtures.js";

const homes: string[] = [];
after(() => cleanup(homes));
const STAMP = (v: string) => call(`node scripts/stamp-cli.mjs ${v}`);

function checkedUse(l: Lab, v: string, raw: RunCall[], runId: string, o: { st?: SkillSessionState } = {}) {
  const sheet = writeSheet(l.env, sheetOf(runId, raw, { skillId: l.id, promptParams: { version: v } }));
  const run = runOf(sheet, { skillId: l.id });
  const st = o.st ?? state();
  st.injected.push({ ...injFor(l, v, runId), injId: `i-${runId.slice(-6)}`, at: new Date(Date.parse(raw[0]!.at) - 60_000).toISOString() });
  st.runs.push(run);
  const settled = settleCredit(st, { host: "claude", env: l.env, now: NOW });
  return { sheet, run, st, settled };
}
type Use = ReturnType<typeof checkedUse>;
const baseInput = (l: Lab, u: Use, extra: Parameters<typeof input>[4] = {}) =>
  input(l, u.run, u.sheet, u.st, { settled: u.settled, ...extra });
const due = (l: Lab, u: Use, extra: Parameters<typeof input>[4] = {}) => updateOfferDue(baseInput(l, u, extra));
const lessonOn = (l: Lab, text: string) =>
  writeLesson({ id: "ls-1a2b3c", skill: "release-npm", at: "2026-10-30", text, kind: "lesson", src: "correction", wall: null }, SHOP, l.env);

/** A kept lesson whose command ran and passed: the baseline that is due. */
function lessonUse(tag: string): { l: Lab; u: Use } {
  const l = lab(tag, homes);
  lessonOn(l, "stamp the build too: node scripts/stamp-cli.mjs {version}");
  const u = checkedUse(l, "0.22.4", releaseCalls("0.22.4", { extraAfter: { 2: [STAMP("0.22.4")] } }), "r-1112-0002");
  return { l, u };
}

const planner = (over: Partial<FoldPlanner>): FoldPlanner => ({
  foldInputFor: (...a) => standIn.foldInputFor(...a),
  replan: (...a) => standIn.replan(...a),
  ...over,
});

describe("versionNumber", () => {
  test("only a positive integer of up to six digits keys and bumps", () => {
    assert.equal(versionNumber("3"), 3);
    assert.equal(versionNumber(2), 2);
    assert.equal(versionNumber("999999"), 999999);
    assert.equal(versionNumber(undefined), null);
    assert.equal(versionNumber(null), null);
    assert.equal(versionNumber("0"), null);
    assert.equal(versionNumber("1.2"), null);
    assert.equal(versionNumber("1234567"), null);
    assert.equal(versionNumber("draft"), null);
  });
});

describe("updateOfferDue early returns", () => {
  let l: Lab;
  let u: Use;
  before(() => ({ l, u } = lessonUse("gaps-early")));

  test("the baseline is due, and a notice channel is due too with that channel on the offer", () => {
    assert.equal(due(l, u).due, true);
    const d = due(l, u, { channel: "notice" });
    assert.ok(d.due, `not due: ${"why" in d ? d.why : ""}`);
    assert.equal(d.offer.channel, "notice");
    assert.equal(d.offer.moment, "update");
  });

  test("an offer already pending waits", () => {
    const pendingOffer = { offerId: "o-000009", moment: "repeated", runId: "r-x", name: "x", key: "k", lines: ["a", "b"], channel: "stop",
      shownAt: NOW.toISOString(), showMe: false, yes: null, typedAfter: [], repo: SHOP };
    assert.deepEqual(due(l, { ...u, st: { ...u.st, pendingOffer } as SkillSessionState }), { due: false, why: "pending" });
  });

  test("a checked verdict without a check index, past the calls, or on a failed check is not a checked use", () => {
    assert.deepEqual(due(l, u, { verdict: { checked: true, checkIndex: null, end: "done" } }), { due: false, why: "not-checked" });
    assert.deepEqual(due(l, u, { verdict: { checked: true, checkIndex: u.run.calls.length + 5, end: "done" } }), { due: false, why: "not-checked" });
    const failedCheck = { ...u.run, calls: u.run.calls.map((c) => (c.check ? { ...c, check: { ...c.check, passed: false } } : c)) };
    assert.deepEqual(due(l, { ...u, run: failedCheck }), { due: false, why: "not-checked" });
  });

  test("no sheet, or a sheet of another run, is no offer", () => {
    assert.deepEqual(updateOfferDue({ ...baseInput(l, u), sheet: undefined as never }), { due: false, why: "no-sheet" });
    assert.deepEqual(updateOfferDue({ ...baseInput(l, u), sheet: { ...u.sheet, id: "r-9999-0009" } }), { due: false, why: "no-sheet" });
  });

  test("no settled uses at all, or a settled use whose injection is gone, is not settled", () => {
    assert.deepEqual(updateOfferDue({ ...baseInput(l, u), settled: undefined }), { due: false, why: "not-settled" });
    const lost = [{ ...u.settled[0]!, injIds: ["i-missing"] }];
    assert.deepEqual(due(l, u, { settled: lost }), { due: false, why: "not-settled" });
  });

  test("a block injected for a joined part of the run counts as this run's use", () => {
    const st = structuredClone(u.st);
    st.injected[0]!.runId = "r-1112-0001";
    assert.deepEqual(due(l, { ...u, st }), { due: false, why: "not-settled" });
    const sheet = { ...u.sheet, joined: [{ ...(u.sheet as object), id: "r-1112-0001" }] } as typeof u.sheet;
    const d = updateOfferDue(input(l, u.run, sheet, st, { settled: u.settled }));
    assert.ok(d.due, `not due: ${"why" in d ? d.why : ""}`);
    assert.equal(d.offer.runId, "r-1112-0002");
  });

  test("a lesson watch on that use is a correction coming, so moment 4 goes first", () => {
    const st = { ...u.st, lessonWatch: { useId: u.settled[0]!.use.useId } } as unknown as SkillSessionState;
    assert.deepEqual(due(l, { ...u, st }), { due: false, why: "corrected" });
  });

  test("the offer falls back to the session's repo when the run has none", () => {
    const ctxRepo = baseInput(l, u).ctx.repoKey;
    const d = due(l, { ...u, run: { ...u.run, repoKey: "" } });
    assert.ok(d.due, `not due: ${"why" in d ? d.why : ""}`);
    assert.equal(d.offer.repo, ctxRepo);
  });
});

describe("updateOfferDue planners", () => {
  let l: Lab;
  let u: Use;
  before(() => ({ l, u } = lessonUse("gaps-plan")));

  test("the planner is given the block's params, the first injection's time and the session's now", () => {
    const fi = mock.fn((...a: Parameters<FoldPlanner["foldInputFor"]>) => standIn.foldInputFor(...a));
    const inp = baseInput(l, u, { plan: planner({ foldInputFor: fi }) });
    const d = updateOfferDue(inp);
    assert.ok(d.due, `not due: ${"why" in d ? d.why : ""}`);
    assert.equal(fi.mock.callCount(), 1);
    const [skillId, runId, , o] = fi.mock.calls[0]!.arguments;
    assert.equal(skillId, l.id);
    assert.equal(runId, "r-1112-0002");
    assert.deepEqual(o!.inj!.params, u.st.injected[0]!.params);
    assert.equal(o!.inj!.at, u.st.injected[0]!.at);
    assert.equal(o!.now, inp.ctx.now);
  });

  test("a planner with no fold input is no plan", () => {
    assert.deepEqual(due(l, u, { plan: planner({ foldInputFor: () => null }) }), { due: false, why: "no-plan" });
  });

  test("a replan that finds nothing, or plans another op, is no offer", () => {
    assert.deepEqual(due(l, u, { plan: planner({ replan: () => null }) }), { due: false, why: "replan" });
    const other = planner({
      replan: (...a) => {
        const r = standIn.replan(...a);
        return r && { ...r, plan: { op: "split", from: 1, to: 2 } as never };
      },
    });
    assert.deepEqual(due(l, u, { plan: other }), { due: false, why: "replan" });
  });

  test("a replan that agrees pins the offer to its hashes", () => {
    const pinned = planner({
      replan: (...a) => {
        const r = standIn.replan(...a);
        return r && { ...r, baseHash: "b".repeat(64), proposalSha: "c".repeat(16) };
      },
    });
    const d = due(l, u, { plan: pinned });
    assert.ok(d.due, `not due: ${"why" in d ? d.why : ""}`);
    assert.equal(d.offer.fold!.baseHash, "b".repeat(64));
    assert.equal(d.offer.fold!.proposalSha, "c".repeat(16));
    assert.deepEqual(d.offer.fold!.lessonIds, ["ls-1a2b3c"]);
  });
});

test("a skill whose version Trail can't key is no offer", () => {
  const { l, u } = lessonUse("gaps-version");
  assert.equal(due(l, u).due, true);
  const odd = renderSkillMd({ ...l.base, meta: { ...l.base.meta, version: "1.0" } });
  writeFileSync(l.file, odd);
  updateSkillState(l.id, (s) => ({ ...s!, hash: skillHash(odd) }), l.env);
  assert.match(readFileSync(l.file, "utf8"), /1\.0/);
  assert.deepEqual(due(l, u), { due: false, why: "version" });
});
