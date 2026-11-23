import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  errorLine,
  extrasWords,
  guardrailLines,
  guardrailRows,
  skillExtras,
} from "../src/skills/cli-skills-report-1b.js";
import type { RepoPlace } from "../src/notes/home.js";
import { repoNotesDir } from "../src/notes/repo-notes-dir.js";
import type { CompiledSkill, SkillRef } from "../src/skills/types.js";
import { WALLS } from "../src/trace/walls.js";
import { tmpRepo } from "./helpers.js";

describe("phase 1b skills report", () => {
  const now = new Date("2026-05-01T12:00:00Z");
  const name = "start-worker";
  const composeWithoutWorker = "services:\n  web:\n    image: acme/web\n";
  const skill = {
    kind: "compiled",
    name,
    title: "Start the worker",
    params: [],
    steps: [{ n: 1, cmd: "docker compose up -d worker", gated: null, bg: false, wait: false }],
  } as CompiledSkill;

  let root: string | undefined;
  let env: NodeJS.ProcessEnv;
  let place: RepoPlace;
  let ref: SkillRef;
  let composePath: string;

  before(() => {
    const scratch = root = tmpRepo("skills-report-1b");
    const home = join(scratch, "home");
    const trail = join(home, "trail");
    env = {
      HOME: home,
      USERPROFILE: home,
      TRAIL_HOME: trail,
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      CODEX_HOME: join(home, "codex"),
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
    };

    const checkout = join(scratch, "checkout");
    mkdirSync(checkout);
    execFileSync("git", ["init", "--quiet"], { cwd: checkout, stdio: "ignore" });
    composePath = join(checkout, "compose.yaml");
    writeFileSync(composePath, composeWithoutWorker);

    place = {
      checkout,
      git: true,
      key: "github.com/acme/webshop",
      dir: join(trail, "repos", "webshop"),
    };
    const skillDir = join(trail, "skills", name);
    mkdirSync(skillDir, { recursive: true });
    ref = { name, dir: skillDir, applies: place.key.toUpperCase() } as SkillRef;
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("a missing Compose service is reported for skills that apply here, and clears after repair", () => {
    const expected = {
      lessons: 0,
      outOfDate: "it uses the worker service, and compose.yaml has no worker now",
      unusedSince: null,
    };
    for (const applies of [ref.applies, "Every Repo", null]) {
      assert.deepEqual(skillExtras({ ...ref, applies }, skill, undefined, place, env, now), expected);
    }

    try {
      writeFileSync(composePath, `${composeWithoutWorker}  worker:\n    image: acme/worker\n`);
      assert.deepEqual(skillExtras(ref, skill, undefined, place, env, now), {
        ...expected,
        outOfDate: null,
      });
    } finally {
      writeFileSync(composePath, composeWithoutWorker);
    }
  });

  test("a missing service is not reported outside the skill's scope or for an unreadable skill", () => {
    const empty = { lessons: 0, outOfDate: null, unusedSince: null };
    assert.deepEqual(
      skillExtras({ ...ref, applies: "github.com/acme/other" }, skill, undefined, place, env, now),
      empty,
    );
    assert.deepEqual(skillExtras(ref, skill, undefined, null, env, now), empty);
    assert.deepEqual(skillExtras(ref, null, undefined, place, env, now), empty);
  });

  test("a checkout lookup failure suppresses the anchor warning without losing the rest of the report", () => {
    const checkout = mock.fn((): string => {
      throw new Error("checkout is no longer accessible");
    });
    const unavailable: RepoPlace = {
      ...place,
      get checkout() { return checkout(); },
    };

    assert.deepEqual(skillExtras(ref, skill, undefined, unavailable, env, now), {
      lessons: 0,
      outOfDate: null,
      unusedSince: null,
    });
    assert.equal(checkout.mock.callCount(), 1);
  });

  test("the skill suffix omits empty facts and formats counts and dates", () => {
    assert.equal(extrasWords({ lessons: 0, outOfDate: null, unusedSince: null }), "");
    assert.equal(extrasWords({ lessons: 1, outOfDate: null, unusedSince: null }), " · 1 learning");
    const suffix = extrasWords({
      lessons: 2,
      outOfDate: "the worker service is gone",
      unusedSince: "2026-02-04",
    });
    assert.match(suffix, /^ · 2 learnings · may be out of date: the worker service is gone/);
    assert.match(suffix, / · unused since Feb 4 \(not in the list agents see; asking for it still brings it\)$/);
  });

  test("repo guardrails include plain notes up to 64 KiB, not directories or oversized notes", () => {
    const notes = repoNotesDir(place.key, env);
    mkdirSync(notes, { recursive: true });
    const guardrail = [
      "---",
      "title: Check for timeout before using it",
      "kind: guardrail",
      "status: active",
      `applies: ${place.key}`,
      "check: no-timeout",
      "enforce: sure-fail",
      "---",
      "",
      "# Check for timeout before using it",
      "",
      "Check that timeout is installed before wrapping a command with it.",
      "",
    ].join("\n");

    mkdirSync(join(notes, "archive.md"));
    writeFileSync(join(notes, "archive.md", "old.md"), guardrail);
    writeFileSync(join(notes, "at-limit.md"), guardrail.padEnd(64 * 1024, " "));
    writeFileSync(join(notes, "oversized.md"), guardrail.padEnd(64 * 1024 + 1, " "));
    writeFileSync(
      join(notes, "read-only.md"),
      guardrail.replace("status: active\n", "").replace("enforce: sure-fail\n", ""),
    );

    const rows = guardrailRows(place, env);
    assert.deepEqual(rows, [
      { name: "at-limit", applies: "this repo", enforced: true },
      { name: "read-only", applies: "this repo", enforced: false },
    ]);
    assert.deepEqual(guardrailRows(null, env), [], "repo notes are not reported outside a repo");
    const disabled = guardrailRows(place, env, false);
    assert.deepEqual(disabled, rows.map((row) => ({ ...row, enforced: false })));
    assert.match(guardrailLines(rows)[1]!, /stops `timeout N`/);
    assert.match(guardrailLines(disabled)[1]!, /agents read it at session start$/);
  });

  test("catalog errors use the catalog wording and only mention repairs when one was recorded", () => {
    const wall = WALLS[0]!;
    assert.equal(
      errorLine([{ class: wall.cls, times: 2, fixed: 1 }]),
      `errors Trail knows here (30 days): ${wall.words} 2 times, fixed 1 time`,
    );
    assert.equal(
      errorLine([{ class: wall.cls, times: 1, fixed: 0 }]),
      `errors Trail knows here (30 days): ${wall.words} 1 time`,
    );
  });
});
