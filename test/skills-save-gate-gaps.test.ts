/**
 * Gap tests for src/skills/save-gate.ts: the pure line builders, the transcript
 * tail readers, the gate's early denies and the CLI half's first refusals.
 * Made-up skills and runs only.
 */
process.env.TZ = "UTC";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  savedLines,
  heldLines,
  tailEntries,
  tailCalls,
  bashCommand,
  tamperInTail,
  ctxFromReceipt,
  checkSkillsAdd,
  saveGateFor,
  saveGate,
  saveOrLessonGate,
  cliAdd,
  DENY,
  type ToolCall,
} from "../src/skills/save-gate.js";
import { CLAUDE_DIALECT } from "../src/trace/dialect.js";
import type { CompiledSkill, Receipt } from "../src/skills/types.js";

let dir: string;
let env: NodeJS.ProcessEnv;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "save-gate-gaps-"));
  env = { ...process.env, HOME: dir, USERPROFILE: dir, TRAIL_HOME: join(dir, ".trail") };
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const step = (n: number, cmd: string) => ({ n, cmd, gated: null, bg: false, wait: false });
const skill = (over: Record<string, unknown> = {}) =>
  ({
    name: "run-tests",
    meta: { asks: "integration tests", applies: "github.com/acme/widget" },
    steps: [step(1, "npm ci"), step(2, "npm test")],
    check: "",
    checkIsStep: false,
    ...over,
  } as unknown as CompiledSkill);
const NOW = new Date("2026-10-20T11:00:00.000Z");

describe("savedLines", () => {
  test("asked for the team says the team save comes later", () => {
    const [, tell] = savedLines(skill(), 2, "2026-10-20T10:07:00.000Z", "team", NOW);
    assert.match(tell, /Saving it for the team comes later, so for now it's just yours\./);
    assert.ok(!tell.includes("whole repo"), tell);
  });

  test("asked for the repo says the repo save comes later", () => {
    const [, tell] = savedLines(skill(), 2, "2026-10-20T10:07:00.000Z", "repo", NOW);
    assert.match(tell, /Saving it for the whole repo comes later/);
  });

  test("every repo, no asks, an unreadable end time and a followed note", () => {
    const c = skill({ meta: { asks: "", applies: "every repo" }, followed: "step 2 follows your note on caching" });
    const [mark, tell] = savedLines(c, 2, "not a date", null, NOW);
    assert.match(mark, /^✓ saved run-tests, just for you, in every repo · 2 steps, each one ran here earlier · step 2 follows your note on caching$/);
    assert.match(tell, /Next time you ask to do this job, I start from them\./);
    assert.match(tell, /each one ran here earlier\. step 2 follows your note on caching Next time/);
    assert.ok(!tell.includes("comes later"), tell);
  });

  test("a run that ended on another day is named by its date", () => {
    const [mark] = savedLines(skill(), 1, "2026-10-18T09:00:00.000Z", null, NOW);
    assert.match(mark, /just for you in this repo · 1 step, each one ran here on .*18/);
    assert.ok(!mark.includes("today"), mark);
  });
});

describe("heldLines", () => {
  test("host: names the host it came from", () => {
    const [line, tell] = heldLines("run-tests", "host", "cursor");
    assert.equal(line, "· not kept: it came from Cursor, where Trail can't check which steps ran");
    assert.match(tell, /trail skills keep run-tests$/);
  });

  test("host: an unknown host is another tool", () => {
    const [line] = heldLines("run-tests", "host", "mystery");
    assert.match(line, /it came from another tool,/);
  });

  test("transcript: says where the host keeps the conversation", () => {
    assert.match(heldLines("x", "transcript", "codex")[0], /where Codex keeps it, so it can't check that you said yes/);
    assert.match(heldLines("x", "transcript", "nope")[0], /where your agent keeps it/);
  });

  test("no-yes: you didn't say yes", () => {
    const [line, tell] = heldLines("run-tests", "no-yes", "claude");
    assert.equal(line, "· not kept: you didn't say yes to keeping it");
    assert.match(tell, /I didn't keep run-tests as a skill, because you didn't say yes/);
  });
});

describe("tailEntries", () => {
  test("a missing file reads as nothing", () => {
    assert.deepEqual(tailEntries(join(dir, "missing.jsonl")), []);
  });

  test("only whole JSON objects are kept", () => {
    const tx = join(dir, "mixed.jsonl");
    writeFileSync(tx, ['[1,2]', '42', 'null', '"str"', 'not json', '{"ok":1}', '{"ok":2}', ''].join("\n"));
    assert.deepEqual(tailEntries(tx), [{ ok: 1 }, { ok: 2 }]);
  });

  test("past 4 MB the cut first line is dropped", () => {
    const tx = join(dir, "big.jsonl");
    writeFileSync(tx, JSON.stringify({ big: "x".repeat(5 * 1024 * 1024) }) + "\n" + JSON.stringify({ last: true }) + "\n");
    assert.deepEqual(tailEntries(tx), [{ last: true }]);
  });
});

describe("tool calls", () => {
  const call = (name: string, input: unknown, cwd: string | null = null) =>
    ({ kind: "tool_call", id: "t1", name, input, cwd } as unknown as ToolCall);

  test("bashCommand reads only Bash commands", () => {
    assert.equal(bashCommand(call("Bash", { command: "npm test" })), "npm test");
    assert.equal(bashCommand(call("Edit", { command: "npm test" })), null);
    assert.equal(bashCommand(call("Bash", null)), null);
    assert.equal(bashCommand(call("Bash", { command: 3 })), null);
  });

  test("tailCalls: a missing transcript has no calls", () => {
    assert.deepEqual(tailCalls(join(dir, "none.jsonl"), CLAUDE_DIALECT, env), []);
  });

  test("tailCalls reads Claude's tool_use blocks", () => {
    const tx = join(dir, "claude.jsonl");
    const line = {
      type: "assistant",
      uuid: "u1",
      sessionId: "sess-1",
      cwd: dir,
      timestamp: "2026-10-20T10:00:00.000Z",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }] },
    };
    writeFileSync(tx, JSON.stringify(line) + "\n" + "[1]\n");
    const calls = tailCalls(tx, CLAUDE_DIALECT, env);
    assert.ok(calls.length >= 1, JSON.stringify(calls));
    assert.ok(calls.every((c) => c.kind === "tool_call"));
    assert.ok(calls.map(bashCommand).includes("npm test"));
  });

  test("tamperInTail: harmless calls pass, a write to the transcript is caught", () => {
    const tx = join(dir, "session.jsonl");
    assert.equal(tamperInTail([], tx, env), null);
    assert.equal(tamperInTail([call("Bash", { command: "ls" }, dir)], tx, env), null);
    const hit = tamperInTail([call("Bash", { command: "ls" }, dir), call("Write", { file_path: tx, content: "{}" })], tx, env);
    assert.equal(typeof hit, "string");
    assert.ok((hit as string).length > 0);
  });
});

describe("ctxFromReceipt", () => {
  const receipt = (tier: string, transcriptPath: string) =>
    ({ v: 1, session: "sess-1", transcriptPath, host: "claude", tier, checkout: "" } as unknown as Receipt);
  const sheet = () => ({ runId: "r1", repoKey: "github.com/acme/widget", checkout: dir, cwd: dir, host: "claude" } as never);

  test("tier A learns; an empty transcript path is null", () => {
    const now = new Date("2026-10-20T10:00:00.000Z");
    const ctx = ctxFromReceipt(receipt("A", ""), sheet(), env, now);
    assert.equal(ctx.sessionId, "sess-1");
    assert.match(ctx.sessionHash, /^[0-9a-f]{12}$/);
    assert.equal(ctx.learn, true);
    assert.equal(ctx.learnOff, null);
    assert.equal(ctx.transcriptPath, null);
    assert.equal(ctx.repoKey, "github.com/acme/widget");
    assert.equal(ctx.fold, true);
    assert.equal(ctx.subagent, false);
    assert.equal(ctx.now, now);
  });

  test("other tiers don't learn and keep the transcript path", () => {
    const tx = join(dir, "t.jsonl");
    const ctx = ctxFromReceipt(receipt("B", tx), sheet(), env);
    assert.equal(ctx.learn, false);
    assert.equal(ctx.learnOff, "host");
    assert.equal(ctx.transcriptPath, tx);
    assert.ok(ctx.now instanceof Date);
  });
});

describe("the hook half", () => {
  test("checkSkillsAdd ignores anything that is not an add", () => {
    assert.equal(checkSkillsAdd(null, {} as never, {} as never, null), null);
    assert.equal(checkSkillsAdd({ tool_input: { command: 42 } }, {} as never, {} as never, null), null);
    assert.equal(checkSkillsAdd({ tool_input: { command: "echo hi" } }, {} as never, {} as never, null), null);
  });

  test("checkSkillsAdd refuses an add it can't check", () => {
    const ctx = { env, now: NOW, sessionId: "s", host: "claude", tier: "A" } as never;
    const r = checkSkillsAdd({ tool_input: { command: "trail skills add run-tests --run no-such-run" } }, ctx, null as never, null);
    assert.ok(r);
    assert.equal(r!.permissionDecision, "deny");
    assert.equal(typeof r!.reason, "string");
  });

  test("saveGateFor denies a subagent and a session with no person", () => {
    const input = { tool_input: { command: "trail skills add run-tests --run r1" } };
    assert.deepEqual(saveGateFor(input, { subagent: true, fold: true } as never), { permissionDecision: "deny", reason: DENY.subagent });
    assert.deepEqual(saveGateFor(input, { subagent: false, fold: false } as never), { permissionDecision: "deny", reason: DENY.noPerson });
  });

  test("saveGate and saveOrLessonGate let a command with no session through to the CLI", async () => {
    assert.equal(saveGate({}, dir, env, NOW), null);
    assert.equal(await saveOrLessonGate({ tool_input: { command: "ls" } }, dir, env, NOW), null);
    assert.equal(await saveOrLessonGate(null, dir, env, NOW), null);
  });
});

describe("cliAdd", () => {
  test("a run that doesn't exist (or skills off) is refused", () => {
    const r = cliAdd("run-tests", "no-such-run", env, NOW, dir);
    assert.equal(r.exit, 1);
    assert.equal(r.lines.length, 1);
    assert.match(r.lines[0], /Skills are off|no run called no-such-run \(runs are kept 7 days\)/);
    assert.equal(r.saved, undefined);
    assert.equal(r.held, undefined);
  });
});
