/**
 * Gaps in the skills part of PreToolUse on Bash: the agent guard read from the
 * caller's command, the catch that logs a throw to state/hook-errors.log and
 * lets the command through, the gated step in a session that can't ask, the
 * fast-path split cut-off for very long commands, and canAskHere. Made-up repos only.
 */
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { preBashSkills, canAskHere, SAVE_GATE, SKILLS_ADD, guardWords, APPROVED_MS, TRAIL_WHO } from "../src/claude/pre-bash-skills.js";
import { promptSkills } from "../src/claude/prompt-skills.js";
import { tmpRepo } from "./helpers.js";
import { shipSkill } from "./skills-recall-fixtures.js";
import { box, CWD, gateFor, payload, save, SID } from "./skills-prompt-fixtures.js";

const PUSH = "git push git@github.com:acme/webshop.git $(git rev-parse HEAD):refs/heads/prod";
const dirs: string[] = [];

function scratch(tag: string): string {
  const d = tmpRepo(tag);
  dirs.push(d);
  return d;
}

function armed(tag: string, entry: string) {
  const b = box(tag, { entry });
  save(b, shipSkill());
  promptSkills(payload(b, "now ff to prod please"), CWD, b.env, { track: () => {}, gate: gateFor(b) });
  return b;
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("constants and guard words", () => {
  test("the save gate patterns know add, lesson and update, and the add pattern only add", () => {
    assert.ok(SKILLS_ADD.test("trail skills add ship"));
    assert.ok(!SKILLS_ADD.test("trail skills lesson ship"));
    for (const c of ["trail skills add x", "trail skills lesson x", "trail skills update x"]) assert.ok(SAVE_GATE.test(c), c);
    assert.ok(!SAVE_GATE.test("trail skills list"));
    assert.equal(APPROVED_MS, 30 * 60 * 1000);
    assert.match(TRAIL_WHO, /^Trail, the tool this person installed/);
  });

  test("guardWords reads quoted pieces as the shell joins them", () => {
    const w = guardWords(`tr''ail sk"ills" add ship`);
    assert.match(String(w), /trail skills add/);
    assert.ok(SAVE_GATE.test(String(w)));
  });
});

describe("preBashSkills basics", () => {
  test("no command at all lets the call through", async () => {
    const env = { ...process.env, TRAIL_HOME: scratch("pbs-empty") };
    assert.equal(await preBashSkills({ tool_name: "Bash", tool_input: {} }, CWD, env), null);
    assert.equal(await preBashSkills(null, CWD, env), null);
  });

  test("the agent guard denies turning skills on, plain or quoted, before any settings are read", async () => {
    const env = { ...process.env, TRAIL_HOME: scratch("pbs-guard") };
    for (const cmd of ["trail skills on", `tr''ail sk"ills" on`]) {
      const d = await preBashSkills({ session_id: "s1", tool_name: "Bash", tool_input: { command: cmd } }, CWD, env);
      assert.equal(d?.permissionDecision, "deny", cmd);
      assert.ok(d!.reason.startsWith("trail: "), d!.reason);
    }
  });

  test("the caller's command wins over tool_input.command", async () => {
    const env = { ...process.env, TRAIL_HOME: scratch("pbs-param") };
    const denied = await preBashSkills({ tool_name: "Bash", tool_input: { command: "ls" } }, CWD, env, "trail skills on");
    assert.equal(denied?.permissionDecision, "deny");
    const passed = await preBashSkills({ tool_name: "Bash", tool_input: { command: "trail skills on" } }, CWD, env, "ls -la");
    assert.equal(passed, null);
  });
});

describe("a throw lets the command through and is logged", () => {
  test("an Error is logged by name, never by message", async () => {
    const home = scratch("pbs-throw");
    const env = { ...process.env, TRAIL_HOME: home };
    class BoomError extends Error {
      override name = "BoomError";
    }
    const input = {
      session_id: "s1",
      get tool_input(): unknown {
        throw new BoomError("secret message here");
      },
    };
    const d = await preBashSkills(input, CWD, env);
    assert.equal(d, null);
    const log = join(home, "state", "hook-errors.log");
    assert.ok(existsSync(log), log);
    const text = readFileSync(log, "utf8");
    assert.match(text, /^\d{4}-\d\d-\d\dT[^ ]+ pre-bash BoomError/m);
    assert.ok(!text.includes("secret message here"), text);
  });

  test("a thrown non-Error is logged as Error and the lines append", async () => {
    const home = scratch("pbs-throw2");
    const env = { ...process.env, TRAIL_HOME: home };
    const input = {
      get tool_input(): unknown {
        throw "plain string";
      },
    };
    assert.equal(await preBashSkills(input, CWD, env), null);
    assert.equal(await preBashSkills(input, CWD, env), null);
    const lines = readFileSync(join(home, "state", "hook-errors.log"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    for (const l of lines) assert.match(l, / pre-bash Error\b/);
    assert.ok(!lines.join("\n").includes("plain string"));
  });

  test("when the log path is not a regular file nothing is written and the call still passes", async () => {
    const home = scratch("pbs-throw3");
    const env = { ...process.env, TRAIL_HOME: home };
    const log = join(home, "state", "hook-errors.log");
    mkdirSync(log, { recursive: true });
    const input = {
      get tool_input(): unknown {
        throw new Error("x");
      },
    };
    assert.equal(await preBashSkills(input, CWD, env), null);
    assert.ok(statSync(log).isDirectory());
  });
});

describe("the gated step", () => {
  test("without a session id, or with a command no step matches, nothing is asked", async () => {
    const b = armed("gaps-nosid", "cli");
    const noSid = await preBashSkills({ tool_name: "Bash", tool_input: { command: PUSH }, permission_mode: "default" }, CWD, b.env, PUSH);
    assert.equal(noSid, null);
    const other = await preBashSkills({ session_id: SID, tool_name: "Bash", tool_input: { command: "ls -la" }, permission_mode: "default" }, CWD, b.env, "ls -la");
    assert.equal(other, null);
    const noGate = await preBashSkills({ session_id: "no-such-session", tool_name: "Bash", tool_input: { command: PUSH }, permission_mode: "default" }, CWD, b.env, PUSH);
    assert.equal(noGate, null);
  });

  test("where it can't ask, a long command is shown cut to one line", async () => {
    const b = armed("gaps-long-headless", "sdk-cli");
    const cmd = `echo ${"y".repeat(70 * 1024)} && ${PUSH}`;
    const d = await preBashSkills({ session_id: SID, tool_name: "Bash", tool_input: { command: cmd }, permission_mode: "default" }, CWD, b.env, cmd);
    assert.equal(d?.permissionDecision, "deny");
    assert.match(d!.reason, /ask the person to run this command in their own terminal: echo y+…$/);
    assert.ok(d!.reason.length < 1200, String(d!.reason.length));
  });
});

describe("canAskHere", () => {
  const input = (mode: string) => ({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, permission_mode: mode });

  test("a scripted entrypoint can't ask", () => {
    const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" };
    assert.equal(canAskHere(input("default"), env), false);
  });

  test("an interactive entrypoint still can't ask when permissions are bypassed or the mode is not text", () => {
    const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" };
    assert.equal(canAskHere(input("bypassPermissions"), env), false);
    assert.equal(canAskHere({ ...input("default"), permission_mode: 7 }, env), false);
  });
});

void before;
void mock;
