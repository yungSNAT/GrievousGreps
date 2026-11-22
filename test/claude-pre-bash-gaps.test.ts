import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  codexPayload,
  preBashContext,
  preBashOutput,
  readInput,
  shellCommand,
  type PreBashDecision,
} from "../src/claude/pre-bash.js";
import { tmpRepo } from "./helpers.js";

let scratch: string;
before(() => {
  scratch = tmpRepo("claude-pre-bash-gaps");
});
after(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("Codex payload detection", () => {
  const sessionPath = win32.join("home", ".codex", "sessions", "session.jsonl");

  test("recognizes a turn ID, a rollout basename, or a Codex session directory", () => {
    assert.equal(codexPayload({ turn_id: "turn-1" }), true);
    assert.equal(codexPayload({ transcript_path: "rollout-2026-01-01.jsonl" }), true);
    assert.equal(
      codexPayload({ transcriptPath: win32.join("archive", "rollout-old.jsonl.zst") }),
      true,
    );
    assert.equal(codexPayload({ transcript_path: sessionPath }), true);
    assert.equal(codexPayload({ transcript_path: posix.join("logs", "session.jsonl") }), false);
    assert.equal(codexPayload({ transcript_path: posix.join("rollout-old.jsonl", "notes.txt") }), false);
  });

  test("prefers the snake-case path when present and falls back when it is nullish", () => {
    const camel = { transcriptPath: sessionPath };
    assert.equal(codexPayload({ ...camel, transcript_path: "ordinary.jsonl" }), false);
    assert.equal(codexPayload({ ...camel, transcript_path: 42 }), false);
    assert.equal(codexPayload({ ...camel, transcript_path: null }), true);
    assert.equal(codexPayload({ ...camel, transcript_path: undefined }), true);
  });

  test("Cursor and Antigravity signatures take precedence over Codex signatures", () => {
    for (const key of [
      "conversation_id", "generation_id", "cursor_version", "workspace_roots",
      "conversationId", "artifactDirectoryPath", "workspacePaths",
    ]) {
      assert.equal(codexPayload({ turn_id: "turn-1", [key]: "present" }), false, key);
    }
    for (const transcript_path of [
      win32.join("home", ".cursor", "rollout-x.jsonl"),
      posix.join("project", "agent-transcripts", "rollout-x.jsonl"),
      win32.join("home", ".gemini", "antigravity", "rollout-x.jsonl"),
    ]) {
      assert.equal(codexPayload({ transcript_path, turn_id: "turn-1" }), false, transcript_path);
    }
    assert.equal(codexPayload({ turn_id: "turn-1", conversation_id: null }), true);
  });

  test("rejects non-record payloads, inherited turn IDs, and unreadable paths", () => {
    for (const input of [
      null, "turn-1", Object.assign([], { turn_id: "turn-1" }),
      Object.create({ turn_id: "turn-1" }), { turn_id: null },
    ]) {
      assert.equal(codexPayload(input), false);
    }
    assert.equal(codexPayload({
      turn_id: "turn-1",
      get transcript_path() { throw new Error("unreadable transcript path"); },
    }), false);
  });
});

describe("PreToolUse output", () => {
  const claude = { tool_name: "Bash", tool_input: { command: "git status" } };
  const codex = { ...claude, turn_id: "turn-1" };
  const reason = "Review the command before continuing.";

  test("serializes Claude decisions and adapts decisions to Codex", () => {
    for (const [input, decision, expected] of [
      [claude, "allow", "allow"],
      [claude, "ask", "ask"],
      [claude, "deny", "deny"],
      [codex, "ask", "deny"],
      [codex, "deny", "deny"],
    ] as const) {
      const decide = mock.fn((_input: unknown, _dir: string) => ({
        permissionDecision: decision,
        reason,
      }));
      const output = preBashOutput(input, scratch, decide);
      assert.equal(decide.mock.callCount(), 1);
      assert.strictEqual(decide.mock.calls[0].arguments[0], input);
      assert.equal(decide.mock.calls[0].arguments[1], scratch);
      assert.deepEqual(JSON.parse(output), {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: expected,
          permissionDecisionReason: reason,
        },
      });
    }
    assert.equal(preBashOutput(codex, scratch, () => ({ permissionDecision: "allow", reason })), "");
  });

  test("is silent when the decision is absent, malformed, or throws", () => {
    assert.equal(preBashOutput(claude, scratch), "");
    const invalid: unknown[] = [
      null,
      "allow",
      { permissionDecision: "block", reason },
      { permissionDecision: "deny", reason: 42 },
      { permissionDecision: "deny", reason: "" },
    ];
    for (const result of invalid) {
      assert.equal(preBashOutput(claude, scratch, () => result as PreBashDecision | null), "");
    }
    assert.equal(preBashOutput(claude, scratch, () => {
      throw new Error("decision unavailable");
    }), "");
  });

  test("passes a warning to Claude as context, but sends nothing to Codex", () => {
    assert.deepEqual(JSON.parse(preBashContext(claude, reason)), {
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: reason },
    });
    assert.equal(preBashContext(codex, reason), "");
    assert.equal(preBashContext(claude, ""), "");
  });
});

describe("shell command extraction", () => {
  test("accepts shell payloads from Claude, Cursor, and Copilot", () => {
    const command = "git status --short";
    for (const input of [
      { tool_name: "Bash", tool_input: { command } },
      { tool_name: "Shell", tool_input: { command } },
      { tool_name: "PowerShell", tool_input: { command } },
      { toolName: "bash", toolArgs: JSON.stringify({ command }) },
      { tool_name: null, toolName: "BASH", tool_input: null, toolArgs: { command } },
    ]) {
      assert.equal(shellCommand(input), command);
    }
    assert.equal(shellCommand({
      tool_name: "Bash",
      toolName: "Read",
      tool_input: { command },
      toolArgs: { command: "git log" },
    }), command);
  });

  test("ignores non-shell tools and missing, malformed, or empty commands", () => {
    for (const input of [
      null,
      "git status",
      Object.assign([], { tool_name: "Bash", tool_input: { command: "git status" } }),
      { tool_input: { command: "git status" } },
      { toolName: "Read", toolArgs: { command: "git status" } },
      { toolName: "bash" },
      { toolName: "bash", toolArgs: "{}" },
      { toolName: "bash", toolArgs: '"git status"' },
      { toolName: "bash", toolArgs: '{"command":' },
      { toolName: "bash", toolArgs: '{"command":42}' },
      { toolName: "bash", toolArgs: { command: "" } },
    ]) {
      assert.equal(shellCommand(input), null);
    }
  });
});

async function withTestStdin<T>(text: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.GRAFT_TEST_STDIN;
  if (text === undefined) delete process.env.GRAFT_TEST_STDIN;
  else process.env.GRAFT_TEST_STDIN = text;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.GRAFT_TEST_STDIN;
    else process.env.GRAFT_TEST_STDIN = previous;
  }
}

// A regular file on fd 0 exercises the real reader without relying on a terminal,
// shell redirection, or the platform's pipe buffer size.
function readFromFile(
  text: string,
  { maxBytes, useImport = false }: { maxBytes?: number; useImport?: boolean } = {},
): unknown {
  const path = join(scratch, "stdin.json");
  writeFileSync(path, text, "utf8");
  const fd = openSync(path, "r");
  try {
    const env = { ...process.env };
    delete env.GRAFT_TEST_STDIN;
    const child = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval", `
        import { readInput } from "../src/claude/pre-bash.js";
        const original = ${useImport}
          ? Object.getOwnPropertyDescriptor(process, "getBuiltinModule")
          : undefined;
        try {
          if (original) {
            Object.defineProperty(process, "getBuiltinModule", { ...original, value: undefined });
          }
          process.stdout.write(JSON.stringify(await readInput(${maxBytes ?? ""})));
        } finally {
          if (original) Object.defineProperty(process, "getBuiltinModule", original);
        }
      `,
    ], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      env,
      stdio: [fd, "pipe", "pipe"],
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  } finally {
    closeSync(fd);
  }
}

type StdinFs = {
  fstatSync(fd: number): { isCharacterDevice(): boolean };
  read(
    fd: number, buffer: Buffer, offset: number, length: number, position: null,
    callback: (error: NodeJS.ErrnoException | null, bytesRead: number) => void,
  ): void;
};

async function readWithFs(fs: StdinFs): Promise<unknown> {
  const original = process.getBuiltinModule;
  const builtin = mock.method(process, "getBuiltinModule", (name: string) =>
    name === "node:fs" ? fs : original(name),
  );
  try {
    return await withTestStdin(undefined, () => readInput());
  } finally {
    builtin.mock.restore();
  }
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function scriptedReads(...steps: (string | NodeJS.ErrnoException)[]): StdinFs {
  return {
    fstatSync: () => ({ isCharacterDevice: () => false }),
    read(_fd, buffer, offset, length, _position, callback) {
      const step = steps.shift();
      queueMicrotask(() => {
        if (typeof step === "string") callback(null, buffer.write(step, offset, length, "utf8"));
        else callback(step ?? null, 0);
      });
    },
  };
}

describe("reading the hook payload", () => {
  test("parses an object from the stdin seam, but not malformed JSON or non-objects", async () => {
    assert.deepEqual(
      await withTestStdin('{"tool_name":"Bash"}', () => readInput()),
      { tool_name: "Bash" },
    );
    for (const text of ["", "{", "null", "[]", "42", '"Bash"']) {
      assert.equal(await withTestStdin(text, () => readInput()), null, text);
    }
  });

  test("reassembles UTF-8 across stdin chunks", () => {
    const prefix = " ".repeat(64 * 1024 - Buffer.byteLength('{"word":"') - 1);
    assert.deepEqual(readFromFile(`${prefix}{"word":"café"}`.replace(
      '{"word":"café"}', '{"word":"éclair"}',
    )), { word: "éclair" });
  });

  test("accepts the byte limit exactly and rejects a larger, still valid payload", () => {
    const text = '{"word":"éclair"}';
    const maxBytes = Buffer.byteLength(text);
    assert.deepEqual(readFromFile(text, { maxBytes, useImport: true }), { word: "éclair" });
    assert.equal(readFromFile(text + " ", { maxBytes }), null);
  });

  test("does not read from a terminal or an unavailable stdin descriptor", async () => {
    for (const fstatSync of [
      () => ({ isCharacterDevice: () => true }),
      () => { throw errno("EBADF"); },
    ]) {
      const read = mock.fn<StdinFs["read"]>((_fd, _buf, _offset, _length, _pos, callback) => {
        callback(null, 0);
      });
      assert.equal(await readWithFs({ fstatSync, read }), null);
      assert.equal(read.mock.callCount(), 0);
    }
  });

  test("retries a temporarily unavailable read and preserves the payload on EOF", async () => {
    const fs = scriptedReads('{"tool_', errno("EAGAIN"), 'name":"Bash"}', errno("EOF"));
    assert.deepEqual(await readWithFs(fs), { tool_name: "Bash" });
  });

  test("drops accumulated bytes on a hard read error even if they parse", async () => {
    assert.equal(await readWithFs(scriptedReads('{"tool_name":"Bash"}', errno("EIO"))), null);
  });
});
