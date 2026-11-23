/**
 * Gap tests for src/skills/cli-skills-2.ts: the restore body's refusals (the person check, a bad version, a skill
 * that isn't there), the update body without an offer or with one that answers nothing, `draft --print` for a run
 * Trail knows nothing of, and lifting `--version` out of argv for `skills restore`.
 */
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import {
  restoreVersionCommand,
  updateCommand,
  draftFoldText,
  liftRestoreVersion,
  type CliCtx,
} from "../src/skills/cli-skills-2.js";

let home: string;

before(() => {
  home = tmpRepo("cli-skills-2-gaps");
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

type Captured = { ctx: CliCtx; outs: string[]; errs: string[]; tracked: Array<[string, Record<string, string>]> };

function ctx(personOk: boolean, env?: NodeJS.ProcessEnv): Captured {
  const outs: string[] = [];
  const errs: string[] = [];
  const tracked: Array<[string, Record<string, string>]> = [];
  const trailHome = join(home, "trail-home");
  const c: CliCtx = {
    env: env ?? { TRAIL_HOME: trailHome, HOME: home, USERPROFILE: home },
    now: () => new Date("2026-11-10T10:00:00Z"),
    person: () => ({ ok: personOk, tty: personOk, claudeCodeEnv: false, claudeAncestor: !personOk }),
    track: (event, props) => {
      tracked.push([event, props]);
    },
    out: (l) => outs.push(l),
    err: (l) => errs.push(l),
  };
  return { ctx: c, outs, errs, tracked };
}

describe("restoreVersionCommand", () => {
  test("someone other than the person gets the refusal with <n> when the version is not a number", () => {
    const c = ctx(false);
    assert.equal(restoreVersionCommand("ship-shop", "abc", c.ctx), 1);
    assert.deepEqual(c.errs, ["Only the person can run this, in their own terminal: trail skills restore ship-shop --version <n>"]);
    assert.deepEqual(c.outs, []);
    assert.deepEqual(c.tracked, []);
  });

  test("the person with a version that isn't a number is told what --version takes", () => {
    const c = ctx(true);
    assert.equal(restoreVersionCommand("ship-shop", "0", c.ctx), 1);
    assert.deepEqual(c.errs, ["✗ --version takes a version number: trail skills restore <name> --version <n>"]);
    assert.deepEqual(c.tracked, []);
  });

  test("an undefined version is treated as no number", () => {
    const c = ctx(true);
    assert.equal(restoreVersionCommand("ship-shop", undefined as unknown as string, c.ctx), 1);
    assert.equal(c.errs.length, 1);
    assert.match(c.errs[0]!, /--version takes a version number/);
  });

  test("the person naming a skill Trail doesn't keep is told there is none and nothing changes", () => {
    const c = ctx(true);
    assert.equal(restoreVersionCommand("no-such-skill", "2", c.ctx), 1);
    assert.deepEqual(c.errs, ["✗ no skill called no-such-skill · trail skills lists them"]);
    assert.deepEqual(c.outs, []);
    assert.deepEqual(c.tracked, []);
  });
});

describe("updateCommand", () => {
  test("without --offer it says what the command takes and sends nothing", () => {
    const c = ctx(true);
    assert.equal(updateCommand("ship-shop", {}, c.ctx), 1);
    assert.deepEqual(c.errs, ["✗ trail skills update takes the offer it answers: trail skills update <name> --offer <id>"]);
    assert.deepEqual(c.tracked, []);
  });

  test("an offer that answers nothing fails, prints on err, and records no skill change", () => {
    const c = ctx(true);
    const code = updateCommand("no-such-skill", { offer: "offer-that-does-not-exist" }, c.ctx);
    assert.notEqual(code, 0);
    assert.ok(c.errs.length > 0, "the reason is printed");
    assert.deepEqual(c.outs, []);
    assert.deepEqual(c.tracked, []);
  });
});

describe("draftFoldText", () => {
  test("a run Trail has no sheet for has no fold to show", () => {
    const env = { TRAIL_HOME: join(home, "trail-home-draft"), HOME: home, USERPROFILE: home };
    assert.equal(draftFoldText("run-does-not-exist", env), null);
  });
});

describe("liftRestoreVersion", () => {
  test("other commands keep their argv untouched and get no version", () => {
    const argv = ["node", "trail", "skills", "show", "x", "--version", "3"];
    const r = liftRestoreVersion(argv);
    assert.deepEqual(r, { argv });
    assert.notEqual(r.argv, argv, "a copy");
    assert.deepEqual(liftRestoreVersion(["node", "trail", "--version"]), { argv: ["node", "trail", "--version"] });
  });

  test("`--version <n>` is lifted out with its value", () => {
    const r = liftRestoreVersion(["node", "trail", "skills", "restore", "ship-shop", "--version", "3"]);
    assert.deepEqual(r, { argv: ["node", "trail", "skills", "restore", "ship-shop"], version: "3" });
  });

  test("`--version=<n>` is lifted out with its value", () => {
    const r = liftRestoreVersion(["node", "trail", "skills", "restore", "--version=12", "ship-shop"]);
    assert.deepEqual(r, { argv: ["node", "trail", "skills", "restore", "ship-shop"], version: "12" });
  });

  test("`--version` with no value, or followed by a flag, is lifted alone with an empty version", () => {
    assert.deepEqual(liftRestoreVersion(["node", "trail", "skills", "restore", "ship-shop", "--version"]), {
      argv: ["node", "trail", "skills", "restore", "ship-shop"],
      version: "",
    });
    assert.deepEqual(liftRestoreVersion(["node", "trail", "skills", "restore", "ship-shop", "--version", "--json"]), {
      argv: ["node", "trail", "skills", "restore", "ship-shop", "--json"],
      version: "",
    });
  });

  test("nothing after `--` is read as the flag, and a restore without --version has none", () => {
    const after = ["node", "trail", "skills", "restore", "ship-shop", "--", "--version", "3"];
    assert.deepEqual(liftRestoreVersion(after), { argv: after });
    const none = ["node", "trail", "skills", "restore", "ship-shop"];
    assert.deepEqual(liftRestoreVersion(none), { argv: none });
  });
});

test("mock is available and restores cleanly (no globals touched by these tests)", () => {
  const fn = mock.fn(() => 1);
  assert.equal(fn(), 1);
  assert.equal(fn.mock.callCount(), 1);
  mock.restoreAll();
});
