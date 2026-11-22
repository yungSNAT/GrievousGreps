/**
 * Gap tests for src/skills/cli-skills-report.ts: the word helpers (dayWords,
 * whereWords, statusWords, heldWords), every arm of reportLines, and
 * skillsReport on an empty made-up home (with and without a cwd).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  dayWords,
  heldWords,
  reportLines,
  skillsReport,
  statusWords,
  whereWords,
  type HeldRow,
  type SkillRow,
  type SkillsReport,
  type WatchRow,
} from "../src/skills/cli-skills-report.js";
import { tmpRepo } from "./helpers.js";

const NOW = new Date("2026-10-17T10:00:00Z");

function row(over: Partial<SkillRow> = {}): SkillRow {
  return {
    name: "deploy-site", id: "id-1", scope: "personal", applies: null, status: "candidate", version: null,
    uses: 0, checkedUses: 0, lastWorked: null, addedAt: null, source: null, statusWhy: null, off: false, refused: null,
    ...over,
  };
}

function report(over: Partial<SkillsReport> = {}): SkillsReport {
  return {
    skills: [], held: [], watching: [],
    offers: { on: true, offSince: null, offIn: [], perSession: 1, perWeek: 3, thisWeek: 0, kept: 0 },
    governor: null,
    settings: { skills: "off", onSince: null },
    guardrails: [], errorsHere: [], lessons: 0,
    ...over,
  };
}

describe("dayWords", () => {
  test("reads a plain local day as that day and an ISO time too", () => {
    assert.match(dayWords("2026-10-29"), /Oct\s+29/);
    assert.match(dayWords("2026-03-05T12:00:00"), /Mar\s+0?5/);
  });
});

describe("whereWords", () => {
  test("null and 'every repo' (any case) read as every repo", () => {
    assert.equal(whereWords(null), "yours, in every repo");
    assert.equal(whereWords(""), "yours, in every repo");
    assert.equal(whereWords("Every Repo"), "yours, in every repo");
  });
  test("a repo names that repo", () => {
    const w = whereWords("webshop");
    assert.ok(w.startsWith("yours, in "), w);
    assert.match(w, /webshop/);
    assert.doesNotMatch(w, /every repo/);
  });
});

describe("statusWords", () => {
  test("refused at recall wins over status", () => {
    const s = statusWords(row({ refused: "step 2 deletes files", status: "active" }));
    assert.equal(s, "needs a fix: step 2 deletes files · not used until fixed");
  });
  test("needs-fix uses its why, or the default why", () => {
    assert.equal(statusWords(row({ status: "needs-fix", statusWhy: "npm ci failed" })), "needs a fix: npm ci failed · not used until fixed");
    assert.equal(statusWords(row({ status: "needs-fix" })), "needs a fix: its steps failed twice · not used until fixed");
  });
  test("active with version and last worked day; and without", () => {
    const s = statusWords(row({ status: "active", version: "1.2", uses: 3, checkedUses: 2, lastWorked: "2026-10-29" }));
    assert.equal(s, `active v1.2 · used 3, checked 2 · last worked ${dayWords("2026-10-29")}`);
    assert.equal(statusWords(row({ status: "active", uses: 1, checkedUses: 0 })), "active · used 1, checked 0");
  });
  test("candidate: saved day, with the run it came from", () => {
    const a = statusWords(row({ addedAt: "2026-10-01", source: { commands: 1, failed: 0 } }));
    assert.equal(a, `candidate · saved ${dayWords("2026-10-01")} from a run of 1 command, none failed`);
    const b = statusWords(row({ version: "2", addedAt: "2026-10-01", source: { commands: 5, failed: 2 } }));
    assert.equal(b, `candidate v2 · saved ${dayWords("2026-10-01")} from a run of 5 commands, 2 failed`);
    assert.equal(statusWords(row({ addedAt: "2026-10-01" })), `candidate · saved ${dayWords("2026-10-01")}`);
    assert.equal(statusWords(row()), "candidate");
  });
  test("an off skill says how to turn it on", () => {
    const s = statusWords(row({ off: true }));
    assert.equal(s, "candidate · off: turn it on with trail skills on deploy-site");
  });
});

describe("heldWords", () => {
  test("from a known host, an unknown host, and without a yes", () => {
    assert.equal(
      heldWords({ name: "lint-fix", why: "host" as HeldRow["why"], host: "cursor" }),
      "held, not kept: lint-fix (came from Cursor) · keep it: trail skills keep lint-fix",
    );
    assert.match(heldWords({ name: "x", why: "host" as HeldRow["why"], host: "mystery" }), /came from another tool/);
    const other = heldWords({ name: "y", why: "unasked" as unknown as HeldRow["why"], host: "claude" });
    assert.equal(other, "held, not kept: y (started without your yes) · keep it: trail skills keep y");
  });
});

describe("reportLines", () => {
  test("value first, no skills, held, watching, offers on with repos off and a governor, skills on", () => {
    const held: HeldRow[] = [{ name: "lint-fix", why: "host" as HeldRow["why"], host: "codex", repo: "webshop", at: NOW.toISOString(), shownAt: null }];
    const watching = [{ job: "test", repo: "webshop", sessionDays: 2, need: 3 }] as unknown as WatchRow[];
    const lines = reportLines(report({
      value: "this week here: 3 skills saved you 12 minutes",
      held, watching,
      offers: { on: true, offSince: null, offIn: ["webshop"], perSession: 1, perWeek: 3, thisWeek: 2, kept: 1 },
      governor: "offers are slowing down: you said no to most",
      settings: { skills: "on", onSince: "2026-08-01" },
    }));
    assert.equal(lines[0], "this week here: 3 skills saved you 12 minutes");
    assert.ok(lines.includes("no skills yet"));
    assert.ok(lines.some((l) => l.includes("(came from Codex)")));
    assert.ok(lines.includes("watching: test in webshop, 2 of 3 days"), lines.join("\n"));
    const offers = lines.find((l) => l.startsWith("offers:")) ?? "";
    assert.match(offers, /^offers: on, off in webshop · at most 1 per session, 3 a week · 2 this week, 1 kept · stop them: trail skills offers off$/);
    assert.ok(lines.includes("offers are slowing down: you said no to most"));
    assert.equal(lines.at(-1), `skills: on since ${dayWords("2026-08-01")} · turn off: trail skills off`);
  });

  test("offers on with none this week, no governor; skills on without a day", () => {
    const lines = reportLines(report({ settings: { skills: "on", onSince: null } }));
    assert.ok(lines.includes("offers: on · at most 1 per session, 3 a week · none this week · stop them: trail skills offers off"));
    assert.equal(lines.at(-1), "skills: on · turn off: trail skills off");
    assert.ok(!lines.some((l) => l.startsWith("watching:")));
    assert.equal(lines[0], "no skills yet");
  });

  test("offers off, with and without a day; skills off; missing 1b fields", () => {
    const since = reportLines(report({ offers: { on: false, offSince: "2026-09-10", offIn: [], perSession: 1, perWeek: 3, thisWeek: 0, kept: 0 } }));
    assert.ok(since.includes(`offers: off since ${dayWords("2026-09-10")} · turn back on: trail skills offers on`));
    assert.equal(since.at(-1), "skills: off · turn on: trail skills on");

    const bare = report({ offers: { on: false, offSince: null, offIn: [], perSession: 1, perWeek: 3, thisWeek: 0, kept: 0 }, governor: "never shown" });
    const old = { ...bare } as Partial<SkillsReport>;
    delete old.guardrails; delete old.errorsHere; delete old.lessons;
    const lines = reportLines(old as SkillsReport);
    assert.ok(lines.includes("offers: off · turn back on: trail skills offers on"));
    assert.ok(!lines.includes("never shown"), "the governor is only said while offers are on");
    assert.deepEqual(lines, ["no skills yet", "offers: off · turn back on: trail skills offers on", "skills: off · turn on: trail skills on"]);
  });
});

describe("skillsReport on an empty home", () => {
  let root = "";
  let env: NodeJS.ProcessEnv = {};
  before(() => {
    root = tmpRepo("skills-report-gaps");
    env = { HOME: join(root, "home"), TRAIL_HOME: join(root, "trail-home") };
    mkdirSync(env.HOME!, { recursive: true });
    mkdirSync(env.TRAIL_HOME!, { recursive: true });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test("without a cwd: nothing kept, nothing held, offers limits fixed", () => {
    const r = skillsReport(env, NOW);
    assert.deepEqual(r.skills, []);
    assert.deepEqual(r.held, []);
    assert.deepEqual(r.watching, []);
    assert.equal(r.offers.perSession, 1);
    assert.equal(r.offers.perWeek, 3);
    assert.equal(r.offers.thisWeek, 0);
    assert.equal(r.offers.kept, 0);
    if (!r.offers.on) assert.equal(r.governor, null, "no governor line while offers are off");
    else assert.equal(r.offers.offSince, null, "offers on: no off day");
    const lines = reportLines(r);
    assert.ok(lines.includes("no skills yet"));
    assert.match(lines.at(-1)!, /^skills: (on|off)/);
  });

  test("with a cwd: same empty facts, and the lines name the commands", () => {
    const cwd = join(root, "work");
    mkdirSync(cwd, { recursive: true });
    const r = skillsReport(env, NOW, cwd);
    assert.equal(r.skills.length, 0);
    assert.equal(r.lessons >= 0, true);
    const lines = reportLines(r);
    assert.ok(lines.some((l) => l.startsWith("offers:") && /trail skills offers (on|off)/.test(l)), lines.join("\n"));
  });
});
