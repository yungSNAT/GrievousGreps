import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import {
  REPAIR_COPY,
  deltaWords,
  fixedWords,
  lessonWhere,
  repairLessonText,
  repairLines,
} from "../src/skills/offer-repair.js";
import { WALLS } from "../src/trace/walls.js";
import type { FixDelta, WallClass } from "../src/trace/types.js";

before(() => {
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Repair offer formatting must not fetch");
  });
});

after(() => mock.restoreAll());

function fix(kind: FixDelta["kind"], name: string, text: string): FixDelta {
  return { kind, name, text, callId: "call-1" };
}

const authWall = "git-https-auth";
const authFix = fix("step", "git", "git remote set-url origin git@github.com:example/project.git");
const noglob = fix("wrapper", "noglob", "noglob git show HEAD:item[1].ts");
const globoff = fix("flag", "--globoff", "curl --globoff 'https://example.invalid/item[1]'");
const colimaHost = fix("env", "DOCKER_HOST", "DOCKER_HOST=unix://$HOME/.colima/default/docker.sock");

function zshWall() {
  const wall = WALLS.find(({ words }) => /no matches found/i.test(words));
  assert.ok(wall, "the wall catalog describes zsh's unmatched glob error");
  return wall;
}

function render(overrides: Partial<Parameters<typeof repairLines>[0]> = {}) {
  return repairLines({
    checkLine: "Done: the check passed!",
    nth: 2,
    days: 9,
    cls: authWall,
    delta: [authFix],
    program: "git",
    as: "skill",
    steps: 3,
    lessonText: null,
    where: "this repo",
    ...overrides,
  });
}

describe("repair delta wording", () => {
  test("names a repeated flag only once and joins distinct fixes in order", () => {
    const repeatedFlag = { ...globoff, callId: "call-2" };

    assert.equal(deltaWords([]), "");
    assert.equal(deltaWords([globoff, repeatedFlag]), "the --globoff flag");
    assert.equal(
      deltaWords([globoff, repeatedFlag, noglob, colimaHost]),
      "the --globoff flag, noglob in front and Colima's socket",
    );
  });

  test("does not call a non-Colima Docker socket Colima's socket", () => {
    const localSocket = fix("env", "DOCKER_HOST", "DOCKER_HOST=unix:///var/run/docker.sock");
    const colimaProfile = fix("env", "COLIMA_PROFILE", "COLIMA_PROFILE=.colima");

    assert.equal(deltaWords([colimaHost]), "Colima's socket");
    assert.equal(deltaWords([localSocket, colimaProfile]), "DOCKER_HOST set and COLIMA_PROFILE set");
  });

  test("names the fallback that enables the job, not the directory, check or log file", () => {
    const start = fix("step", "colima", "cd tools && colima status || colima start 2>colima.log");

    assert.equal(deltaWords([start]), "colima start first");
  });

  test("skips a program flag and stops after two subcommand words", () => {
    const setRemote = fix(
      "step",
      "git",
      "git --no-pager remote set-url origin git@github.com:example/project.git",
    );

    assert.equal(deltaWords([setRemote]), "git remote set-url first");
  });

  test("does not repeat a quoted directory operand as a subcommand", () => {
    assert.equal(deltaWords([fix("step", "mkdir", 'mkdir ".cache"')]), "mkdir first");
  });
});

describe("repair lessons", () => {
  test("keeps remote authentication repo-local and machine fixes applicable in every repo", () => {
    const auth = WALLS.find(({ cls }) => cls === authWall);
    assert.ok(auth);
    assert.equal(fixedWords(authWall), auth.words);
    assert.equal(lessonWhere(authWall), "this repo");
    assert.equal(lessonWhere(zshWall().cls), "every repo");
  });

  test("uses the class name if a wall is missing from the wording catalog", () => {
    const newerClass = "unrecognized-wall" as WallClass;

    assert.equal(fixedWords(newerClass), "unrecognized-wall");
  });

  test("keeps the actual repair text in a short lesson, but never truncates a long one", () => {
    const wall = zshWall();
    const longTarget = fix("wrapper", "noglob", `noglob git show HEAD:${"a".repeat(210)}[1].ts`);

    assert.equal(repairLessonText(wall.cls, []), null);
    assert.equal(repairLessonText(wall.cls, [noglob]), `${wall.words}: ${noglob.text}`);
    assert.equal(repairLessonText(wall.cls, [longTarget]), null);
  });

  test("the kept-learning confirmation names its scope, recurrence trigger and undo command", () => {
    assert.match(REPAIR_COPY.savedWall!, /just for you \{where\}/);
    assert.match(REPAIR_COPY.savedWall!, /when \{fixed\} comes back/);
    assert.match(REPAIR_COPY.savedWall!, /undo: trail forget \{id\}$/);
  });
});

describe("repair offer lines", () => {
  test("retains check punctuation and offers the working steps on an older repeat", () => {
    const [context, prompt] = render();

    assert.match(context, /^Done: the check passed! This is the 2nd time in 9 days that git failed on /);
    assert.match(context, /and needed git remote set-url first\.$/);
    assert.match(prompt, /Keep the 3 working steps as a skill/);
    assert.match(prompt, /in this repo\? \(yes \/ show me \/ no\)$/);
  });

  test("finishes an unpunctuated check and uses single quotes inside a quoted lesson", () => {
    const wall = zshWall();
    const [context, prompt] = render({
      checkLine: "Done: the check passed",
      days: 7,
      cls: wall.cls,
      delta: [noglob],
      program: "",
      as: "lesson",
      steps: 1,
      lessonText: 'zsh “no matches found”: use noglob with "HEAD:item[1].ts"',
      where: lessonWhere(wall.cls),
    });

    assert.match(context, /^Done: the check passed\. This is the 2nd time this week that it failed on /);
    assert.match(context, /and needed noglob in front\.$/);
    assert.match(prompt, /in every repo: "[^"]*"\? \(yes \/ no\)$/);
    assert.ok(prompt.includes("zsh 'no matches found'"));
    assert.ok(prompt.includes("'HEAD:item[1].ts'"));
    assert.doesNotMatch(prompt, /[“”]/);
  });

  test("renders an absent lesson as empty text, without displaying null", () => {
    const [, prompt] = render({ as: "lesson", steps: 1, lessonText: null });

    assert.match(prompt, /in this repo: ""\? \(yes \/ no\)$/);
  });

  test("leaves an unrecognized copy placeholder visible while filling known fields", () => {
    const original = REPAIR_COPY.line1!;
    try {
      REPAIR_COPY.line1 = `${original} {detail}`;
      const [context] = render();

      assert.match(context, /that git failed on /);
      assert.match(context, /first\. \{detail\}$/);
    } finally {
      REPAIR_COPY.line1 = original;
    }
  });
});
