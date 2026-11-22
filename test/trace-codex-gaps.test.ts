import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  codexLineEvents, codexTypedByPerson, codexTypedSha, noteCodexPrompt,
  readNewCodexEvents, type CodexMemo,
} from "../src/trace/codex.js";
import type { SkillSessionState } from "../src/trace/types.js";
import { tmpRepo } from "./helpers.js";

let root: string;
before(() => { root = tmpRepo("trace-codex-gaps"); });
after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function scratchEnv(tag: string) {
  const home = join(root, tag);
  return { HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, "trail"), CODEX_HOME: join(home, ".codex") };
}

const at = "2026-10-27T10:00:00Z";
const line = (type: string, payload: unknown) => ({ timestamp: at, type, payload });
const event = (type: string, fields: Record<string, unknown> = {}) =>
  line("event_msg", { type, ...fields });
const response = (type: string, fields: Record<string, unknown>) =>
  line("response_item", { type, ...fields });
const message = (role: string, content: unknown) => response("message", { role, content });
const call = (id: string, name: string, args: unknown) =>
  response("function_call", { call_id: id, name, arguments: args });
const output = (id: string, text: string) =>
  response("function_call_output", { call_id: id, output: text });

function walk(memo: CodexMemo = {}) {
  return (entry: unknown, offset?: number) => codexLineEvents(entry, memo, offset);
}

function result(events: ReturnType<typeof codexLineEvents>, id: string) {
  const ev = events.find((e) => e.kind === "tool_result" && e.id === id);
  assert.ok(ev?.kind === "tool_result", `expected a result for ${id}`);
  return ev;
}

const commandOutput = (status: string, body: string) =>
  `Chunk ID: abc123\nWall time: 1.001 seconds\n${status}\nOriginal token count: 5\nOutput:\n${body}`;
const exited = (code: number, body: string) =>
  commandOutput(`Process exited with code ${code}`, body);
const running = (session: number, body: string) =>
  commandOutput(`Process running with session ID ${session}`, body);

describe("Codex prompt attribution", () => {
  test("reads without creating a key, then creates and reuses it when the hook records a prompt", () => {
    const env = scratchEnv("key");
    const keyPath = join(env.TRAIL_HOME, "state", "typed-key");
    const state = {} as SkillSessionState;
    const oldTrailHome = process.env.TRAIL_HOME;
    process.env.TRAIL_HOME = env.TRAIL_HOME;
    try {
      assert.equal(codexTypedSha("run the tests"), null);
      assert.equal(existsSync(keyPath), false);
      assert.equal(codexTypedByPerson("run the tests", undefined), false);

      noteCodexPrompt(state, "  run the tests\n");
      const diskKey = readFileSync(keyPath, "utf8");
      assert.match(diskKey, /^[0-9a-f]{64}\n$/);
      const expected = createHmac("sha256", Buffer.from(diskKey.trim(), "hex"))
        .update("run the tests", "utf8").digest("hex").slice(0, 16);
      assert.deepEqual(state.codex?.typedShas, [expected]);
      assert.equal(codexTypedSha("run the tests"), expected);
      assert.equal(codexTypedByPerson("run the tests", state), true);
      assert.equal(codexTypedByPerson("run the build", state), false);
      assert.equal(codexTypedByPerson("   ", state), false);
      assert.equal(codexTypedByPerson("run the tests", state, scratchEnv("no-key")), false);

      noteCodexPrompt(state, "check the build");
      assert.equal(readFileSync(keyPath, "utf8"), diskKey);
      assert.equal(state.codex?.typedShas[0], expected);
      assert.equal(codexTypedByPerson("check the build", state), true);
    } finally {
      if (oldTrailHome === undefined) delete process.env.TRAIL_HOME;
      else process.env.TRAIL_HOME = oldTrailHome;
    }
  });

  test("leaves an invalid existing key alone and does not record the prompt", () => {
    const env = scratchEnv("invalid-key");
    const keyPath = join(env.TRAIL_HOME, "state", "typed-key");
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, "not a key\n");
    const state = {} as SkillSessionState;

    noteCodexPrompt(state, "check the build", env);

    assert.equal(state.codex, undefined);
    assert.equal(codexTypedSha("check the build", env), null);
    assert.equal(readFileSync(keyPath, "utf8"), "not a key\n");
  });

  test("discards malformed saved hashes and keeps only the last twenty prompts", () => {
    const env = scratchEnv("prompt-history");
    const state = { codex: { typedShas: [null, 123] } } as unknown as SkillSessionState;
    const prompts = Array.from({ length: 22 }, (_, i) => `check package ${i}`);
    noteCodexPrompt(state, prompts[0]!, env);
    assert.deepEqual(state.codex, { meta: null, typedShas: [codexTypedSha(prompts[0]!, env)] });

    for (const prompt of prompts.slice(1)) noteCodexPrompt(state, prompt, env);
    assert.deepEqual(state.codex?.typedShas, prompts.slice(-20).map((p) => codexTypedSha(p, env)));
    assert.equal(codexTypedByPerson(prompts[1]!, state, env), false);
    assert.equal(codexTypedByPerson(prompts[2]!, state, env), true);
  });
});

describe("Codex rollout lines", () => {
  test("joins only text parts and lets a new typed candidate reset reply deduplication", () => {
    const read = walk();
    const reply = message("assistant", [
      null, 7, { type: "output_text", text: "  Ready." },
      { type: "image", url: "fixture.png" }, { text: 42 },
      { type: "output_text", text: "Run the checks.  " },
    ]);
    const assistant = { kind: "assistant", text: "Ready.\nRun the checks.", at };

    assert.deepEqual(read(reply, 0), [{ ...assistant, offset: 0 }]);
    assert.deepEqual(read(event("agent_message", { message: assistant.text })), []);
    assert.deepEqual(read(event("item_completed", {
      item: { type: "UserMessage", content: [{ type: "input_text", text: "  Start now.  " }] },
    }), 42), [{ kind: "typed", text: "Start now.", at, offset: 42 }]);
    assert.deepEqual(read(reply), [assistant]);
    assert.deepEqual(read(event("user_message", { message: "  " })), []);
    assert.deepEqual(read(reply), [], "an empty user message must not reset deduplication");
  });

  test("ignores empty or malformed messages and clips large injected context in the middle", () => {
    const read = walk();
    assert.deepEqual(read([message("user", "not a rollout record")]), []);
    assert.deepEqual(read(line("response_item", [])), []);
    assert.deepEqual(read(message("user", { text: "not a content part" })), []);
    assert.deepEqual(read(message("user", " \n ")), []);
    assert.deepEqual(read({ ...message("developer", " workspace instructions "), timestamp: null }), [
      { kind: "injected", text: "workspace instructions", at: "" },
    ]);

    const [ev] = read(message("user", [
      { type: "input_text", text: `${"H".repeat(8_000)}discard this middle${"T".repeat(32_000)}` },
    ]));
    assert.ok(ev?.kind === "injected");
    assert.equal(ev.text.length, 40_003);
    assert.equal(ev.text.slice(7_998, 8_005), "HH\n…\nTT");
    assert.ok(ev.text.startsWith("HHHH"));
    assert.ok(ev.text.endsWith("TTTT"));
    assert.ok(!ev.text.includes("discard this middle"));
  });

  test("coalesces the two compaction records when they share a timestamp", () => {
    const read = walk();
    assert.deepEqual(read(line("compacted", {}), 10), [{ kind: "compaction", at, offset: 10 }]);
    assert.deepEqual(read(event("context_compacted"), 20), []);
    const untimed = { ...line("compacted", {}), timestamp: undefined };
    assert.deepEqual(read(untimed, 30), [{ kind: "compaction", at: "", offset: 30 }]);
    assert.deepEqual(read(untimed, 40), [{ kind: "compaction", at: "", offset: 40 }]);
  });

  test("uses session and turn context, with a shell_command workdir relative to the turn", () => {
    const memo: CodexMemo = {};
    const read = walk(memo);
    const cwd = join(root, "project");
    const pkg = join(cwd, "package");
    assert.deepEqual(read(line("session_meta", { cwd, git: { branch: "main" } })), []);
    assert.deepEqual(read(call("list", "list_files", { glob: "*.ts" })), [{
      kind: "tool_call", id: "list", name: "list_files", input: { glob: "*.ts" }, at, cwd, branch: "main",
    }]);
    assert.deepEqual(read(line("turn_context", { cwd: pkg, git_branch: "checks", turn_id: "turn-1" })), []);
    assert.deepEqual(read(line("turn_context", { cwd: pkg })), []);
    assert.equal(memo.turn, "turn-1");

    assert.deepEqual(read(call("test", "shell_command", JSON.stringify({
      command: "npm test", workdir: "checks",
    })), 12), [{
      kind: "tool_call", id: "test", name: "Bash", input: { command: "npm test" },
      at, offset: 12, cwd: join(pkg, "checks"), branch: "checks",
    }]);

    assert.deepEqual(read(call("invalid-json", "list_files", "{")), []);
    assert.deepEqual(read(call("array-args", "list_files", "[]")), []);
    assert.deepEqual(read(call("empty-command", "shell_command", { command: "" })), [{
      kind: "tool_call", id: "empty-command", name: "shell_command", input: { command: "" },
      at, cwd: pkg, branch: "checks",
    }]);
  });

  test("uses a structured exit over the output header and requires an exit for shell success", () => {
    const read = walk();
    read(call("tests", "shell_command", { command: "npm test" }));
    assert.deepEqual(read(event("exec_command_end", { call_id: "tests", exit_code: 7 })), []);
    const failed = result(read(output("tests", exited(0, "Checks finished."))), "tests");
    assert.equal(failed.ok, false);
    assert.equal(failed.isError, true);
    assert.match(failed.text, /^Exit code 7\n/);
    assert.match(failed.text, /Checks finished\./);

    read(call("build", "exec_command", { cmd: "npm run build" }));
    const passed = result(read(output("build", exited(0, "Build complete."))), "build");
    assert.equal(passed.ok, true);
    assert.equal(passed.isError, false);
    assert.match(passed.text, /Build complete\./);

    read(call("lint", "exec_command", { cmd: "npm run lint" }));
    const unknown = result(read(output("lint", "Output without an exit header")), "lint");
    assert.equal(unknown.ok, false);
    assert.equal(unknown.isError, false);
  });

  test("evicts the oldest open call when a long rollout reaches the memo limit", () => {
    const read = walk();
    for (let i = 0; i <= 500; i++) read(call(`list-${i}`, "list_files", { page: i }));

    // A result without an exit header is fine for a known non-shell tool,
    // but an unknown call is conservatively treated as a command.
    assert.equal(result(read(output("list-0", "file listing")), "list-0").ok, false);
    assert.equal(result(read(output("list-1", "file listing")), "list-1").ok, true);
    assert.equal(result(read(output("list-500", "file listing")), "list-500").ok, true);
  });

  test("joins stdin by session without saving keystrokes, and clears only the finished session's polls", () => {
    const memo: CodexMemo = {};
    const read = walk(memo);
    const stdin = (id: string, session: number, chars: string) =>
      call(id, "write_stdin", { session_id: session, chars });
    for (const [id, session] of [["first", 11], ["second", 22]] as const) {
      read(call(id, "exec_command", { cmd: "node" }));
      assert.deepEqual(read(output(id, running(session, `Waiting for ${id}.`))), []);
    }

    assert.deepEqual(read(stdin("feed-1", 11, "help")), [{
      kind: "tool_call", id: "feed-1", name: "write_stdin",
      input: { session_id: "11", chars: "help" }, at,
    }]);
    const ack = read(output("feed-1", running(11, "Input received.")));
    assert.deepEqual(ack, [{
      kind: "tool_result", id: "feed-1", ok: true, text: "", isError: false, at,
    }]);
    assert.deepEqual(read(stdin("feed-2", 11, "()\n")), [{
      kind: "tool_call", id: "feed-2", name: "write_stdin",
      input: { session_id: "11", chars: "help()\n" }, at,
    }]);
    assert.deepEqual(read(stdin("feed-other", 22, "exit\n")), [{
      kind: "tool_call", id: "feed-other", name: "write_stdin",
      input: { session_id: "22", chars: "exit\n" }, at,
    }]);
    assert.ok(!JSON.stringify(memo).includes("help"));
    assert.deepEqual(read(stdin("poll-first", 11, "")), []);
    assert.deepEqual(read(stdin("poll-second", 22, "")), []);

    const closed = read(output("feed-2", exited(0, "Done.")));
    assert.equal(result(closed, "feed-2").text, "");
    const first = result(closed, "first");
    assert.equal(first.ok, true);
    assert.match(first.text, /Waiting for first\.[\s\S]*Input received\.[\s\S]*Done\./);
    assert.deepEqual(memo.stdin, { "feed-other": "22", "poll-second": "22" });

    const second = result(read(output("poll-second", exited(3, "Stopped."))), "second");
    assert.equal(second.ok, false);
    assert.equal(second.isError, true);
    assert.match(second.text, /^Exit code 3\n/);
    assert.match(second.text, /Waiting for second\.[\s\S]*Stopped\./);
    assert.deepEqual(memo.stdin, {});
  });
});

test("the incremental reader attributes only recorded prompts and resumes at the saved offset", () => {
  const env = scratchEnv("incremental");
  const id = "12345678-1234-4234-8234-123456789abc";
  const rollout = join(env.CODEX_HOME, "sessions", "2026", "10", "27",
    `rollout-2026-10-27T10-00-00-${id}.jsonl`);
  const cursor = join(env.HOME, "cursor.json");
  mkdirSync(dirname(rollout), { recursive: true });

  const jsonl = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const meta = jsonl(line("session_meta", {
    id, timestamp: at, cwd: root, originator: "codex_cli_rs", source: "cli", git: { branch: "main" },
  }));
  const initial = meta + jsonl(event("user_message", { message: "unrecorded prompt" }));
  writeFileSync(rollout, initial);
  assert.deepEqual(readNewCodexEvents(rollout, cursor, { env }), [{
    kind: "injected", text: "unrecorded prompt", at, offset: Buffer.byteLength(meta),
  }]);

  const state = {} as SkillSessionState;
  noteCodexPrompt(state, "run the checks", env);
  const skipped = "{bad json}\nnull\n[]\n";
  const prompt = jsonl(event("user_message", { message: " run the checks " }));
  appendFileSync(rollout, skipped + prompt + jsonl(message("user", "run the checks")));
  const onEntry = mock.fn();
  const offset = Buffer.byteLength(initial + skipped);
  assert.deepEqual(readNewCodexEvents(rollout, cursor, { env, state, onEntry }), [
    { kind: "typed", text: "run the checks", at, offset },
    { kind: "injected", text: "run the checks", at, offset: offset + Buffer.byteLength(prompt) },
  ]);
  assert.equal(onEntry.mock.calls.length, 2);
  assert.deepEqual(readNewCodexEvents(rollout, cursor, { env, state, onEntry }), []);
  assert.equal(onEntry.mock.calls.length, 2);
});
