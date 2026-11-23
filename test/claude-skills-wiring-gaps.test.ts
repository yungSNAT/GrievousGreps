import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Env = NodeJS.ProcessEnv;
type Props = Record<string, unknown>;
type Out = { context?: string; block?: string };
type Run = { out: Out; sent: [string, Props][]; marked: boolean };

const quiet = (): Run => ({ out: {}, sent: [], marked: false });
const startedAt = new Date("2026-01-02T03:04:05Z");

// These doubles sit at the wiring boundary. The tests exercise the real
// guards, lazy imports, event routing, and fail-open behavior.
export const skillsOn = mock.fn((_env: Env) => true);
export const trailNow = mock.fn((_env: Env) => startedAt);
export const noteSkillsStarted = mock.fn((_env: Env, _when: Date) => {});
export const track = mock.fn((_event: string, _props: Props, _opts: { env: Env }) => {});
export const sessionStartSkillsRun = mock.fn((_input: unknown, _dir: string, _env: Env): Run => quiet());
export const promptSkills = mock.fn((_input: unknown, _dir: string, _env: Env): Out => ({}));
export const postBashRun = mock.fn((_input: unknown, _dir: string, _env: Env, _failed: boolean): Run => quiet());
export const codexPostBash = mock.fn((_input: unknown, _dir: string, _env: Env): Run | undefined => undefined);
export const stopSkillsRun = mock.fn((_input: unknown, _dir: string, _env: Env): Run => quiet());
export const detectHost = mock.fn((input: unknown) => ({
  host: (input as { thread_id?: string } | null)?.thread_id ? "codex" : "claude",
}));
export const withCodexSandbox = mock.fn((out: Out, _host: string): Out => ({
  ...out,
  ...(out.context ? { context: `${out.context} (Codex sandbox)` } : {}),
  ...(out.block ? { block: `${out.block} (Codex sandbox)` } : {}),
}));

const collaborators = new Set([
  "../skills/settings.js",
  "../telemetry/track.js",
  "../trace/host.js",
  "../hosts/codex-trust.js",
  "./start-skills.js",
  "./prompt-skills.js",
  "./post-bash.js",
  "./stop-skills.js",
]);

function resetCalls(): void {
  for (const fn of [
    skillsOn, trailNow, noteSkillsStarted, track, sessionStartSkillsRun,
    promptSkills, postBashRun, codexPostBash, stopSkillsRun, detectHost,
    withCodexSandbox,
  ]) {
    fn.mock.resetCalls();
  }
}

function expectEvents(env: Env, names: string[], hook?: string): void {
  const calls = track.mock.calls.map(({ arguments: args }) => args);
  assert.deepEqual(calls.map(([name]) => name), names);
  for (const [, , options] of calls) assert.strictEqual(options.env, env);
  if (hook) {
    const [, props] = calls.at(-1)!;
    assert.equal(props.event, hook);
    assert.notEqual(props.bucket, undefined);
  }
}

describe("learned-skills hook wiring", () => {
  let wiring: typeof import("../src/claude/skills-wiring.js");
  let registration: ReturnType<typeof registerHooks> | undefined;
  let scratch: string | undefined;
  let dir: string;
  let env: Env;

  before(async () => {
    dir = scratch = mkdtempSync(join(tmpdir(), "claude-skills-wiring-"));
    env = { TRAIL_HOME: join(dir, ".trail") };
    mock.method(globalThis, "fetch", async () => {
      throw new Error("Network is disabled in skills wiring tests");
    });

    // Redirect only the collaborators imported by this instance of the
    // module under test. The doubles are exports of this test module.
    let wiringURL: string | undefined;
    registration = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL === import.meta.url && specifier === "../src/claude/skills-wiring.js") {
          const resolved = nextResolve(specifier, context);
          wiringURL = resolved.url;
          return resolved;
        }
        if (wiringURL && context.parentURL === wiringURL && collaborators.has(specifier)) {
          return { url: import.meta.url, format: "module", shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
    wiring = await import("../src/claude/skills-wiring.js");
  });

  after(() => {
    registration?.deregister();
    mock.restoreAll();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  test("headless callers skip settings; 0, empty, and mixed-case false defer to settings", () => {
    resetCalls();
    for (const value of ["1", "true"]) {
      assert.equal(wiring.skillsWired({ ...env, TRAIL_NO_HOOKS: value }), false);
    }
    assert.equal(skillsOn.mock.callCount(), 0);

    const enabledEnvs = [env, ...["0", "", "FaLsE"].map(TRAIL_NO_HOOKS => ({ ...env, TRAIL_NO_HOOKS }))];
    for (const candidate of enabledEnvs) {
      assert.equal(wiring.skillsWired(candidate), true);
    }
    assert.deepEqual(skillsOn.mock.calls.map(call => call.arguments[0]), enabledEnvs);

    skillsOn.mock.mockImplementationOnce(() => false);
    assert.equal(wiring.skillsWired(env), false);
    skillsOn.mock.mockImplementationOnce(() => { throw new Error("Cannot read skills settings"); });
    assert.equal(wiring.skillsWired(env), false);
  });

  test("disabled hooks return no directives and do not run learned-skills parts", async () => {
    resetCalls();
    const off = { ...env, TRAIL_NO_HOOKS: "1" };
    const bash = { cwd: dir, tool_name: "Bash", tool_input: { command: "git status --short" } };

    assert.deepEqual(await wiring.sessionStartPart({ cwd: dir }, dir, off), {});
    assert.deepEqual(await wiring.promptPart({ prompt: "What changed?", cwd: dir }, dir, off), {});
    assert.deepEqual(await wiring.postBashPart(bash, dir, false, off), {});
    assert.deepEqual(await wiring.codexPostBashPart(bash, dir, off), {});
    assert.deepEqual(await wiring.stopPart({ cwd: dir }, dir, off), {});

    for (const fn of [skillsOn, noteSkillsStarted, sessionStartSkillsRun, promptSkills, postBashRun, codexPostBash, stopSkillsRun]) {
      assert.equal(fn.mock.callCount(), 0);
    }
    expectEvents(off, []);
  });

  test("session start uses the default environment, records startup, and returns the part's context", async () => {
    resetCalls();
    const input = { hook_event_name: "SessionStart", session_id: "claude-start", cwd: dir };
    const out = { context: "Learned skill available: check repository status." };
    sessionStartSkillsRun.mock.mockImplementationOnce(() => {
      assert.deepEqual(noteSkillsStarted.mock.calls[0]?.arguments, [process.env, startedAt]);
      return { ...quiet(), out };
    });

    const saved = process.env.TRAIL_NO_HOOKS;
    try {
      process.env.TRAIL_NO_HOOKS = "0";
      assert.deepEqual(await wiring.sessionStartPart(input, dir), out);
      assert.strictEqual(skillsOn.mock.calls[0]?.arguments[0], process.env);
      assert.strictEqual(trailNow.mock.calls[0]?.arguments[0], process.env);
      assert.deepEqual(sessionStartSkillsRun.mock.calls[0]?.arguments, [input, dir, process.env]);
      expectEvents(process.env, ["hook_ms"], "session-start");
    } finally {
      if (saved === undefined) delete process.env.TRAIL_NO_HOOKS;
      else process.env.TRAIL_NO_HOOKS = saved;
    }
  });

  test("a prompt preserves Claude context, adapts Codex context, and skips adaptation for empty output", async () => {
    resetCalls();
    const claude = { cwd: dir, session_id: "claude-prompt", prompt: "How should I check repo status?" };
    const codex = { ...claude, session_id: "codex-prompt", thread_id: "codex-prompt" };
    const out = { context: "Check repository status before editing." };

    promptSkills.mock.mockImplementationOnce(() => out);
    assert.deepEqual(await wiring.promptPart(claude, dir, env), out);
    assert.equal(withCodexSandbox.mock.callCount(), 0);

    promptSkills.mock.mockImplementationOnce(() => out);
    assert.deepEqual(await wiring.promptPart(codex, dir, env), {
      context: `${out.context} (Codex sandbox)`,
    });
    assert.deepEqual(await wiring.promptPart({ ...codex, prompt: "Thanks." }, dir, env), {});
    assert.deepEqual(withCodexSandbox.mock.calls.map(call => call.arguments), [[out, "codex"]]);
    assert.deepEqual(promptSkills.mock.calls[1]?.arguments, [codex, dir, env]);
    expectEvents(env, ["hook_ms", "hook_ms", "hook_ms"], "prompt");
  });

  test("post-tool hooks ignore absent and non-Bash tools before checking settings", async () => {
    resetCalls();
    assert.deepEqual(await wiring.postBashPart(undefined, dir, false, env), {});
    assert.deepEqual(await wiring.postBashPart({ tool_name: "Read" }, dir, true, env), {});
    assert.deepEqual(await wiring.codexPostBashPart(null, dir, env), {});
    assert.deepEqual(await wiring.codexPostBashPart({ tool_name: "Read" }, dir, env), {});
    assert.equal(skillsOn.mock.callCount(), 0);
    assert.equal(postBashRun.mock.callCount(), 0);
    assert.equal(codexPostBash.mock.callCount(), 0);
  });

  test("Bash timing is queued only for a mark or an event, with a separate failure label", async () => {
    resetCalls();
    const success = {
      cwd: dir, session_id: "claude-bash", tool_name: "Bash",
      tool_input: { command: "git status --short" }, tool_response: { stdout: "" },
    };
    const failure = {
      cwd: dir, session_id: "claude-bash", tool_name: "Bash",
      tool_input: { command: "git rev-parse --verify HEAD" }, error: "Exit code 128",
    };

    assert.deepEqual(await wiring.postBashPart(success, dir, false, env), {});
    expectEvents(env, []);

    postBashRun.mock.mockImplementationOnce(() => ({ ...quiet(), marked: true }));
    assert.deepEqual(await wiring.postBashPart(success, dir, false, env), {});
    expectEvents(env, ["hook_ms"], "post-bash");

    track.mock.resetCalls();
    const out = { context: "This repository has no commits yet." };
    const props = { skill: "repository-status" };
    postBashRun.mock.mockImplementationOnce(() => ({ ...quiet(), out, sent: [["skill_used", props]] }));
    assert.deepEqual(await wiring.postBashPart(failure, dir, true, env), out);
    assert.deepEqual(postBashRun.mock.calls[2]?.arguments, [failure, dir, env, true]);
    assert.deepEqual(track.mock.calls[0]?.arguments[1], props);
    expectEvents(env, ["skill_used", "hook_ms"], "post-bash-fail");
  });

  test("Codex distinguishes unrecognized output from a handled Bash exit", async () => {
    resetCalls();
    const input = {
      cwd: dir, thread_id: "codex-bash", tool_name: "Bash",
      tool_input: { command: "git status --short" }, tool_response: "",
    };
    assert.deepEqual(await wiring.codexPostBashPart(input, dir, env), {});
    expectEvents(env, []);

    const completed = {
      ...input,
      tool_response: "Wall time: 0.01 seconds\nProcess exited with code 0\nFinal output:\n",
    };
    codexPostBash.mock.mockImplementationOnce(quiet);
    assert.deepEqual(await wiring.codexPostBashPart(completed, dir, env), {});
    expectEvents(env, []);

    const out = { context: "The working tree is clean." };
    codexPostBash.mock.mockImplementationOnce(() => ({ ...quiet(), out, marked: true }));
    assert.deepEqual(await wiring.codexPostBashPart(completed, dir, env), out);
    assert.deepEqual(codexPostBash.mock.calls[2]?.arguments, [completed, dir, env]);
    expectEvents(env, ["hook_ms"], "post-bash");
  });

  test("stop adapts a block-only Codex directive even when event tracking throws", async () => {
    resetCalls();
    const input = { cwd: dir, thread_id: "codex-stop", hook_event_name: "Stop" };
    const out = { block: "Record the verification result before stopping." };
    stopSkillsRun.mock.mockImplementationOnce(() => ({
      ...quiet(), out, sent: [["skill_used", { skill: "verify-changes" }]],
    }));
    track.mock.mockImplementationOnce(() => { throw new Error("Cannot write telemetry queue"); });

    assert.deepEqual(await wiring.stopPart(input, dir, env), { block: `${out.block} (Codex sandbox)` });
    assert.deepEqual(stopSkillsRun.mock.calls[0]?.arguments, [input, dir, env]);
    assert.deepEqual(withCodexSandbox.mock.calls[0]?.arguments, [out, "codex"]);
    expectEvents(env, ["skill_used", "hook_ms"], "stop");
  });

  test("a failed skills lookup does not block a user prompt or report a completed part", async () => {
    resetCalls();
    const input = { cwd: dir, session_id: "claude-prompt", prompt: "What does this repo do?" };
    promptSkills.mock.mockImplementationOnce(() => { throw new Error("Cannot read the skills index"); });

    assert.deepEqual(await wiring.promptPart(input, dir, env), {});
    assert.deepEqual(promptSkills.mock.calls[0]?.arguments, [input, dir, env]);
    assert.equal(withCodexSandbox.mock.callCount(), 0);
    expectEvents(env, []);
  });
});
