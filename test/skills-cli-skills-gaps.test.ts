/**
 * Gaps in `trail skills` (cli-skills.ts): the default seams (console, process.exitCode),
 * a thrown non-Error in a guarded body, turning a skill on that only the settings know,
 * forget/restore round trips (with and without an agent), show of a kept skill and of an
 * unknown name, draft's refusals, and `shownText`'s scrubbing of markers and escapes.
 */
process.env.TZ = "UTC";
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command, CommanderError } from "commander";
import { registerSkillCommands, shownText, KEEP_NUMBERS_LINE, type SkillCliDeps } from "../src/skills/cli-skills.js";
import type { PersonDeps, PsRow } from "../src/skills/person.js";
import { listAllPersonal } from "../src/skills/store.js";
import { setSkillOff, readSettings } from "../src/skills/settings.js";
import { T } from "./skills-consent-fixtures.js";
import { cleanup, keptSkill, mk } from "./skills-update-fixtures.js";
import type { Box } from "./skills-consent-fixtures.js";

after(cleanup);

const rows = (...chain: Array<[string, string]>): PsRow[] =>
  chain.map(([comm, args], i) => ({ pid: 4242 - i, ppid: i === chain.length - 1 ? 1 : 4241 - i, comm, args }));
const PERSON: PersonDeps = {
  stdinTTY: true, stdoutTTY: true, pid: 4242,
  ps: () => rows(["/usr/local/bin/node", "node /usr/local/bin/trail skills"], ["/bin/zsh", "-zsh"]),
};

interface Ran { code: number; out: string[]; err: string; tracked: Array<[string, Record<string, string>]> }

async function trail(b: Box, args: string[], over: Partial<SkillCliDeps> = {}): Promise<Ran> {
  const program = new Command();
  const out: string[] = [];
  const tracked: Ran["tracked"] = [];
  let err = "";
  let code = 0;
  program.exitOverride();
  program.version("0.26.0", "-v, --version");
  program.configureOutput({ writeOut: (s) => out.push(s.replace(/\n$/, "")), writeErr: (s) => { err += s; } });
  registerSkillCommands(program, {
    env: b.env, cwd: () => b.repo, personDeps: PERSON, now: () => T(400),
    track: (e, p) => { tracked.push([e, p]); }, out: (l) => out.push(l), err: (l) => { err += `${l}\n`; }, exit: (c) => { code = c; },
    ...over,
  });
  try {
    await program.parseAsync(["node", "trail", ...args]);
  } catch (e) {
    if (!(e instanceof CommanderError)) throw e;
    code = e.exitCode;
  }
  return { code, out, err, tracked };
}

describe("shownText", () => {
  test("drops Trail-looking markers, terminal escapes and unseen characters, keeps indentation", () => {
    const text = "[trail] hi\n  [graft] [trail] x\u001b[31m\r\nplain\u200b\n\n";
    assert.equal(shownText(text), "hi\n  x[31m\nplain");
  });
  test("a plain markdown file is unchanged apart from trailing space", () => {
    assert.equal(shownText("# title\n\n- step one\n"), "# title\n\n- step one");
  });
});

describe("default seams (no deps)", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevExit: typeof process.exitCode;
  before(() => {
    home = mkdtempSync(join(tmpdir(), "skills-gaps-"));
    prevHome = process.env.TRAIL_HOME;
    process.env.TRAIL_HOME = home;
    prevExit = process.exitCode;
  });
  after(() => {
    if (prevHome === undefined) delete process.env.TRAIL_HOME;
    else process.env.TRAIL_HOME = prevHome;
    process.exitCode = prevExit;
    rmSync(home, { recursive: true, force: true });
  });

  test("an unknown skill goes to console.error and sets process.exitCode; skills off goes to console.log", async () => {
    const errs: string[] = [];
    const logs: string[] = [];
    const e = mock.method(console, "error", (...a: unknown[]) => { errs.push(a.map(String).join(" ")); });
    const l = mock.method(console, "log", (...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    try {
      const program = new Command();
      program.exitOverride();
      registerSkillCommands(program);
      await program.parseAsync(["node", "trail", "skills", "off", "zz-unknown-skill"]);
      assert.equal(process.exitCode, 1);
      assert.deepEqual(errs, ["✗ no skill called zz-unknown-skill · trail skills lists them"]);
      process.exitCode = undefined;

      const p2 = new Command();
      p2.exitOverride();
      registerSkillCommands(p2);
      await p2.parseAsync(["node", "trail", "skills", "off"]);
      assert.deepEqual(logs, ["✓ skills off: Trail stops counting jobs, offering skills and bringing them back · turn on again: trail skills on"]);
      assert.equal(process.exitCode, undefined);
    } finally {
      e.mock.restore();
      l.mock.restore();
      process.exitCode = prevExit;
    }
  });
});

describe("guarded errors", () => {
  test("a thrown string prints as ✗ and exits 1", async () => {
    const b = mk();
    const r = await trail(b, ["skills", "off"], { out: () => { throw "boom here"; } });
    assert.equal(r.code, 1);
    assert.equal(r.err, "✗ boom here\n");
  });
  test("a thrown Error loses its trail: prefix", async () => {
    const b = mk();
    const r = await trail(b, ["skills", "off"], { out: () => { throw new Error("trail: settings are busy"); } });
    assert.equal(r.code, 1);
    assert.equal(r.err, "✗ settings are busy\n");
  });
});

describe("on/off one skill", () => {
  test("a name only the settings know (turned off) can be turned back on", async () => {
    const b = mk();
    setSkillOff("ghost-skill", true, b.env);
    assert.ok(readSettings(b.env).skillsOff.includes("ghost-skill"));
    const r = await trail(b, ["skills", "on", "ghost-skill"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.out, ["✓ ghost-skill on: it reaches the agent again · turn it off: trail skills off ghost-skill"]);
    assert.ok(!readSettings(b.env).skillsOff.includes("ghost-skill"));
  });
  test("a kept skill turned off, and an unknown one refused", async () => {
    const b = mk();
    keptSkill(b);
    const r = await trail(b, ["skills", "off", "release-npm"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.out, ["✓ release-npm off: it stops reaching the agent · turn it back on: trail skills on release-npm"]);
    assert.ok(readSettings(b.env).skillsOff.includes("release-npm"));
    const u = await trail(b, ["skills", "off", "nope-nope"]);
    assert.equal(u.code, 1);
    assert.equal(u.err, "✗ no skill called nope-nope · trail skills lists them\n");
  });
});

describe("forget and restore", () => {
  test("forget a kept skill, restore it, and a second restore finds nothing", async () => {
    const b = mk();
    keptSkill(b);
    const f = await trail(b, ["forget", "release-npm"]);
    assert.equal(f.code, 0, f.err);
    assert.deepEqual(f.out, ["✓ release-npm forgotten · bring it back: trail skills restore release-npm"]);
    assert.equal(listAllPersonal(b.env).length, 0);
    const r = await trail(b, ["skills", "restore", "release-npm"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.out, ["✓ release-npm is back · forget it again: trail forget release-npm"]);
    assert.equal(listAllPersonal(b.env)[0]?.name, "release-npm");
    const again = await trail(b, ["skills", "restore", "release-npm"]);
    assert.equal(again.code, 1);
    assert.equal(again.err, "✗ no forgotten skill called release-npm\n");
  });
  test("an agent's forget (CLAUDECODE) still forgets and prints the way back", async () => {
    const b = mk();
    keptSkill(b);
    const env = { ...b.env, CLAUDECODE: "1" };
    const f = await trail({ ...b, env } as Box, ["skills", "forget", "release-npm"], { env });
    assert.equal(f.code, 0, f.err);
    assert.deepEqual(f.out, ["✓ release-npm forgotten · bring it back: trail skills restore release-npm"]);
    assert.equal(listAllPersonal(b.env).length, 0);
  });
  test("forgetting a name nobody knows fails", async () => {
    const b = mk();
    const f = await trail(b, ["forget", "no-such-thing"]);
    assert.equal(f.code, 1);
    assert.equal(f.err, "✗ no skill called no-such-thing · trail skills lists them\n");
  });
});

describe("show", () => {
  test("a kept skill prints its file and a status line", async () => {
    const b = mk();
    keptSkill(b);
    const r = await trail(b, ["skills", "show", "release-npm"]);
    assert.equal(r.code, 0, r.err);
    const text = r.out.join("\n");
    assert.match(text, /release-npm/);
    const blank = r.out.indexOf("");
    assert.ok(blank > 0, text);
    assert.match(r.out[blank + 1]!, /^· /);
  });
  test("an unknown name (neither kept nor held) fails", async () => {
    const b = mk();
    const r = await trail(b, ["skills", "show", "not-held"]);
    assert.equal(r.code, 1);
    assert.equal(r.err, "✗ no skill called not-held · trail skills lists them\n");
    assert.deepEqual(r.out, []);
  });
});

describe("draft and keep refusals", () => {
  test("draft without --print, and of a run that isn't kept", async () => {
    const b = mk();
    const a = await trail(b, ["skills", "draft", "r-123"]);
    assert.equal(a.code, 1);
    assert.equal(a.err, "✗ use --print: trail skills draft r-123 --print\n");
    const c = await trail(b, ["skills", "draft", "r-zz-missing", "--print"]);
    assert.equal(c.code, 1);
    assert.equal(c.err, "✗ no run called r-zz-missing (runs are kept 7 days)\n");
  });
  test("keep refuses numbers and more than one name", async () => {
    const b = mk();
    const n = await trail(b, ["skills", "keep", "1", "2"]);
    assert.equal(n.code, 1);
    assert.equal(n.err, `${KEEP_NUMBERS_LINE}\n`);
    const two = await trail(b, ["skills", "keep", "a-skill", "b-skill"]);
    assert.equal(two.code, 1);
    assert.equal(two.err, "✗ keep one skill at a time: trail skills keep <name>\n");
  });
});
