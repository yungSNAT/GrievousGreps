import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { turnOnly, writeMarkIn, tamperedBefore } from "../src/init/replay-tamper.js";

let root: string;
let th: string;
let work: string;

before(() => {
  root = tmpRepo("replay-tamper-gaps");
  th = join(root, "trail-home");
  work = join(root, "work");
  mkdirSync(th, { recursive: true });
  mkdirSync(work, { recursive: true });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function call(name: string, input: unknown, cwd?: unknown): any {
  return { kind: "tool_call", name, input, cwd };
}

describe("turnOnly", () => {
  test("null is never turn-only", () => {
    assert.equal(turnOnly(null), false);
  });
});

describe("writeMarkIn", () => {
  test("a write into Trail's home is a session-wide mark", () => {
    const target = join(th, "notes", "x.md");
    const m = writeMarkIn([call("Write", { file_path: target, content: "x" }, work)] as any, {
      trailHome: th,
      transcriptPath: join(root, "t.jsonl"),
      checkout: work,
    });
    assert.equal(typeof m, "string");
    assert.ok(m && m.length > 0);
    assert.equal(turnOnly(m), false);
  });

  test("a write without a cwd on the event falls back to the checkout / null folder", () => {
    const target = join(th, "y.md");
    const withCheckout = writeMarkIn([call("Write", { file_path: target, content: "y" })] as any, {
      trailHome: th,
      transcriptPath: join(root, "t.jsonl"),
      checkout: work,
    });
    assert.equal(typeof withCheckout, "string");
    const noCheckout = writeMarkIn([call("Write", { file_path: target, content: "y" }, "")] as any, {
      trailHome: th,
      transcriptPath: join(root, "t.jsonl"),
    });
    assert.equal(typeof noCheckout, "string");
    assert.equal(turnOnly(noCheckout), false);
  });

  test("harmless calls and non-tool events give no mark", () => {
    const m = writeMarkIn(
      [
        { kind: "typed", text: "hello" } as any,
        call("Read", { file_path: join(work, "a.txt") }, work),
        call("Read", null, work),
        call("Grep", "not an object", 42),
        call("Bash", { command: "ls" }, work),
        call("Bash", { command: 5 }, work),
      ] as any,
      { trailHome: th, transcriptPath: join(root, "t.jsonl"), checkout: work },
    );
    assert.equal(m, null);
  });

  test("the first write after harmless calls is returned", () => {
    const target = join(th, "z.md");
    const m = writeMarkIn(
      [
        call("Read", { file_path: join(work, "a.txt") }, work),
        call("Write", { file_path: target, content: "z" }, work),
      ] as any,
      { trailHome: th, transcriptPath: join(root, "t.jsonl"), checkout: work },
    );
    assert.equal(typeof m, "string");
  });

  test("an empty chunk has no mark", () => {
    assert.equal(writeMarkIn([], { trailHome: th, transcriptPath: join(root, "t.jsonl") }), null);
  });
});

describe("tamperedBefore", () => {
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, TRAIL_HOME: th });

  function transcript(name: string, lines: unknown[]): { path: string; text: string } {
    const text = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
    const path = join(root, name);
    writeFileSync(path, text);
    return { path, text };
  }

  const writeLine = (file: string) => ({
    type: "assistant",
    cwd: work,
    message: {
      content: [
        null,
        { type: "text", text: "writing" },
        { type: "tool_use", id: "t1", name: "Write", input: { file_path: file, content: "x" } },
      ],
    },
  });

  test("a write into Trail's home before the run taints it", () => {
    const { path, text } = transcript("write.jsonl", [writeLine(join(th, "notes.md"))]);
    assert.equal(tamperedBefore(path, Buffer.byteLength(text), env()), true);
  });

  test("a write at or after `to` does not count", () => {
    const { path } = transcript("late.jsonl", [writeLine(join(th, "notes.md"))]);
    assert.equal(tamperedBefore(path, 0, env()), false);
  });

  test("harmless tool calls, sidechains and junk lines leave the session clean", () => {
    const { path, text } = transcript("clean.jsonl", [
      "not json but mentions \"tool_use\"",
      "null",
      {
        type: "assistant",
        cwd: work,
        message: {
          content: [
            { type: "tool_use", id: "r1", name: "Read", input: { file_path: join(work, "a.txt") } },
            { type: "tool_use", id: "r2", input: null },
            { type: "tool_use", id: "r3", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      {
        type: "assistant",
        isSidechain: true,
        cwd: work,
        message: {
          content: [{ type: "tool_use", id: "s1", name: "Write", input: { file_path: join(th, "side.md"), content: "x" } }],
        },
      },
      { type: "assistant", cwd: work, message: { content: "tool_use as text" } },
      { type: "progress", note: "tool_use" },
    ]);
    assert.equal(tamperedBefore(path, Buffer.byteLength(text), env()), false);
  });

  test("a write survives a later typed line", () => {
    const { path, text } = transcript("write-then-typed.jsonl", [
      writeLine(join(th, "notes.md")),
      { type: "user", message: { role: "user", content: "carry on please" }, cwd: work },
      { type: "assistant", cwd: work, message: { content: [{ type: "tool_use", id: "r", name: "Read", input: { file_path: join(work, "b") } }] } },
    ]);
    assert.equal(tamperedBefore(path, Buffer.byteLength(text), env()), true);
  });
});
