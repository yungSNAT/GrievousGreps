import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lastResult, lastResultLine } from "../src/skills/check-result.js";
import type { CheckResult } from "../src/skills/check-result.js";

let home: string;
let env: NodeJS.ProcessEnv;

before(() => {
  home = mkdtempSync(join(tmpdir(), "check-result-gaps-"));
  env = { ...process.env, TRAIL_HOME: home };
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

function candidate(opts: {
  refId?: string;
  trail?: string;
  check?: string;
  steps?: { n: number; cmd: string }[];
  addedAt?: string | null;
} = {}): any {
  const trail = opts.trail ?? "trail-gap-default";
  const steps = opts.steps ?? [
    { n: 1, cmd: "npm run build" },
    { n: 2, cmd: "npm test" },
    { n: 3, cmd: "git push prod main" },
  ];
  return {
    ref: { id: opts.refId ?? trail, name: "deploy-prod", path: join(home, "deploy-prod.md") },
    skill: {
      name: "deploy-prod",
      title: "deploy-prod",
      description: "Ship to prod",
      meta: { trail, name: "deploy-prod" },
      steps,
      check: opts.check ?? "git push prod main",
    },
    state: opts.addedAt === undefined ? undefined : { addedAt: opts.addedAt },
    score: 1,
  };
}

function block(skillId: string, cue: string, at: string): any {
  return {
    skillId,
    cue,
    at,
    name: "deploy-prod",
    steps: [
      { n: 1, cmd: "npm run build" },
      { n: 2, cmd: "npm test" },
      { n: 3, cmd: "git push prod main" },
    ],
    check: "git push prod main",
  };
}

describe("lastResult", () => {
  test("no block and no ledger falls back to the save day", () => {
    const c = candidate({ trail: "trail-gap-saved-1", addedAt: "2024-03-05T10:00:00.000Z" });
    const r = lastResult(c, null, [], env);
    assert.equal(r.where, "saved");
    assert.equal(r.at, "2024-03-05T10:00:00.000Z");
    assert.deepEqual(r.stepsRan, []);
    assert.equal(r.failedStep, null);
    assert.equal(r.check, "none");
  });

  test("no state means the saved result has no time", () => {
    const c = candidate({ trail: "trail-gap-saved-2" });
    const r = lastResult(c, null, [], env);
    assert.equal(r.where, "saved");
    assert.equal(r.at, null);
    assert.equal(r.check, "none");
  });

  test("an empty ref id uses the skill's trail id", () => {
    const c = candidate({ refId: "", trail: "trail-gap-meta", addedAt: "2024-01-01T00:00:00.000Z" });
    const b = block("trail-gap-meta", "use", "2024-06-01T12:00:00.000Z");
    const r = lastResult(c, b, [], env);
    assert.equal(r.where, "session");
    assert.equal(r.at, "2024-06-01T12:00:00.000Z");
  });

  test("this session's block of the skill is credited", () => {
    const c = candidate({ trail: "trail-gap-session", addedAt: "2024-01-01T00:00:00.000Z" });
    const b = block("trail-gap-session", "use", "2024-06-02T08:30:00.000Z");
    const r = lastResult(c, b, [], env);
    assert.equal(r.where, "session");
    assert.equal(r.at, "2024-06-02T08:30:00.000Z");
    assert.ok(Array.isArray(r.stepsRan));
    assert.ok(["passed", "failed", "none"].includes(r.check));
  });

  test("a check-cue block is not used as the session result", () => {
    const c = candidate({ trail: "trail-gap-checkcue", addedAt: "2024-02-02T00:00:00.000Z" });
    const b = block("trail-gap-checkcue", "check", "2024-06-03T08:30:00.000Z");
    const r = lastResult(c, b, [], env);
    assert.equal(r.where, "saved");
    assert.equal(r.at, "2024-02-02T00:00:00.000Z");
  });

  test("a block of another skill is ignored", () => {
    const c = candidate({ trail: "trail-gap-other", addedAt: "2024-02-03T00:00:00.000Z" });
    const b = block("some-other-skill", "use", "2024-06-03T08:30:00.000Z");
    const r = lastResult(c, b, [], env);
    assert.equal(r.where, "saved");
    assert.equal(r.at, "2024-02-03T00:00:00.000Z");
  });
});

describe("lastResultLine", () => {
  const typed = "did the deploy go out?";
  const r = (o: Partial<CheckResult>): CheckResult => ({
    where: "ledger",
    at: "2024-05-01T09:00:00.000Z",
    stepsRan: [],
    failedStep: null,
    check: "none",
    ...o,
  });

  test("names the check step when the check is one of the steps", () => {
    const line = lastResultLine(candidate(), typed, r({ where: "session", check: "passed" }));
    assert.match(line, /has no check that only reads: its check is step 3, which changes things/);
    assert.match(line, /In this session its check passed \(step 3\)\./);
    assert.match(line, /don't run its steps to find out/);
  });

  test("says the only check changes things when no step matches it", () => {
    const c = candidate({ check: "kubectl rollout restart" });
    const line = lastResultLine(c, typed, r({ where: "session", check: "passed" }));
    assert.match(line, /its only check changes things/);
    assert.match(line, /In this session its check passed\./);
    assert.ok(!line.includes("(step"));
  });

  test("saved result names the save day", () => {
    const line = lastResultLine(candidate(), typed, r({ where: "saved", at: "2024-03-05T10:00:00.000Z" }));
    assert.match(line, /Trail has no run of it here since it was saved on /);
  });

  test("ledger pass", () => {
    const line = lastResultLine(candidate(), typed, r({ check: "passed" }));
    assert.match(line, /Its last run here, on .+, passed its check \(step 3\)\./);
  });

  test("a failed step", () => {
    const line = lastResultLine(candidate(), typed, r({ where: "session", failedStep: 2, stepsRan: [1, 2] }));
    assert.match(line, /In this session step 2 failed, so Trail can't say it went out\./);
  });

  test("a failed check", () => {
    const line = lastResultLine(candidate(), typed, r({ check: "failed", stepsRan: [1, 2, 3] }));
    assert.match(line, /its check ran and didn't pass\./);
  });

  test("no steps ran (the check step itself does not count)", () => {
    const line = lastResultLine(candidate(), typed, r({ where: "session", stepsRan: [3] }));
    assert.match(line, /In this session none of its steps ran, so Trail can't say it went out\./);
  });

  test("one step ran and the check step didn't", () => {
    const line = lastResultLine(candidate(), typed, r({ where: "session", stepsRan: [1] }));
    assert.match(line, /In this session step 1 ran and step 3 didn't, so Trail can't say it went out; the person may have run it themselves\./);
  });

  test("several steps ran and the unmatched check didn't", () => {
    const c = candidate({ check: "kubectl rollout restart" });
    const line = lastResultLine(c, typed, r({ stepsRan: [1, 2, 3] }));
    assert.match(line, /steps 1, 2 and 3 ran and its check didn't, so Trail can't say it went out/);
  });
});
