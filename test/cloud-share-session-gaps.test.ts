import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync,
  truncateSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  bundleSession, quickTitle, redactEnvValues, redactedCount, sessionsHere,
  sessionsSince, whoIAm, type Bundle, type SessionFile,
} from "../src/cloud/share-session.js";

const R = "[redacted]";
const DAY = 24 * 60 * 60 * 1000;
let scratch: string;

before(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "trail-share-gaps-")));
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected fetch while testing local session sharing");
  });
});

after(() => {
  mock.restoreAll();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function jsonl(...entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function transcript(path: string, text: string, mtime?: number): SessionFile {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mtime !== undefined) utimesSync(path, mtime / 1000, mtime / 1000);
  const { mtimeMs, size } = statSync(path);
  return { id: basename(path, ".jsonl"), path, mtime: mtimeMs, size };
}

function userPrompt(content: string) {
  return { type: "user", message: { role: "user", content } };
}

function unpack(bundle: Bundle): string[] {
  const text = gunzipSync(bundle.gz).toString("utf8");
  assert.equal(Buffer.byteLength(text), bundle.bytes);
  assert.ok(text.endsWith("\n"), "the bundle ends with a JSONL line break");
  return text.slice(0, -1).split("\n");
}

function withGitConfig(path: string, run: () => void): void {
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = path;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
}

describe("session discovery and titles", () => {
  test("a recent listing includes the cutoff, sorts across projects, and ignores non-sessions", () => {
    const home = join(scratch, "recent-home");
    assert.deepEqual(sessionsSince(1, home), []);

    const projects = join(home, ".claude", "projects");
    const alpha = join(projects, "alpha");
    const beta = join(projects, "beta");
    const now = Date.UTC(2025, 5, 4, 12);
    const body = jsonl(userPrompt("Check the build"));
    const cutoff = transcript(join(alpha, "at-cutoff.jsonl"), body, now - DAY);
    const newest = transcript(join(beta, "newest.jsonl"), body, now - 1000);
    transcript(join(beta, "too-old.jsonl"), body, now - DAY - 1000);
    transcript(join(alpha, "agent-helper.jsonl"), body, now);
    transcript(join(alpha, "notes.txt"), body, now);
    transcript(join(alpha, "empty.jsonl"), "", now);
    mkdirSync(join(alpha, "directory.jsonl"));
    writeFileSync(join(projects, "index.txt"), "not a project directory");

    // A linked archive can disappear while its entry is still in the project.
    // Junctions work on Windows without privileged file symlink creation.
    const archive = join(scratch, "removed-archive");
    mkdirSync(archive);
    symlinkSync(archive, join(alpha, "removed.jsonl"), "junction");
    rmSync(archive, { recursive: true });

    assert.deepEqual(sessionsSince(1, home, now), [
      { ...newest, folder: "beta" },
      { ...cutoff, folder: "alpha" },
    ]);
  });

  test("the current workspace lists its sessions newest first without cross-project labels", () => {
    const home = join(scratch, "workspace-home");
    const repo = join(scratch, "workspace");
    mkdirSync(repo);
    assert.deepEqual(sessionsHere(repo, home), []);

    // Account for project keys that remove the Windows drive colon rather
    // than encoding it as a second dash.
    const keys = new Set([
      repo.replace(/[^A-Za-z0-9]/g, "-"),
      repo.replace(/[\\/:]/g, "-"),
      repo.replace(/:/g, "").replace(/[\\/]/g, "-"),
    ]);
    const now = Date.UTC(2025, 5, 4, 12);
    const body = jsonl(userPrompt("Review the workspace"));
    for (const key of keys) {
      const folder = join(home, ".claude", "projects", key);
      transcript(join(folder, "backup.jsonl"), body, now - DAY);
      transcript(join(folder, "working.jsonl"), body, now);
    }

    const found = sessionsHere(repo, home);
    assert.deepEqual(found.map((s) => s.id), ["working", "backup"]);
    assert.equal(found[0]!.size, Buffer.byteLength(body));
    assert.ok(found.every((s) => s.folder === undefined));
  });

  test("the newest usable inline title wins over a prompt and invalid later titles", () => {
    const s = transcript(join(scratch, "titles", "inline.jsonl"), jsonl(
      userPrompt("Initial question"),
      { type: "custom-title", customTitle: "Old title" },
      { type: "custom-title", customTitle: "Parser review" },
      { type: "custom-title", customTitle: 17 },
      { type: "custom-title", customTitle: "  " },
    ) + '{"type":"custom-title","customTitle":');

    assert.equal(quickTitle(s), "Parser review");
  });

  test("a desktop title takes precedence over the first prompt, but not if it is invalid", () => {
    const dir = join(scratch, "titles");
    const s = transcript(join(dir, "desktop.jsonl"), jsonl(userPrompt("Inspect the parser")));
    const sidecar = join(dir, "desktop", "custom-title.json");
    mkdirSync(dirname(sidecar), { recursive: true });
    writeFileSync(sidecar, JSON.stringify({ customTitle: "Desktop title" }));
    assert.equal(quickTitle(s), "Desktop title");

    writeFileSync(sidecar, JSON.stringify({ customTitle: false }));
    assert.equal(quickTitle(s), "Inspect the parser");

    rmSync(s.path);
    assert.equal(quickTitle(s), "");
  });
});

describe("bundled transcripts", () => {
  test("merges both subagent layouts and keeps only readable, supported tool output", () => {
    const project = join(scratch, "bundle");
    const own = join(project, "work-session");
    const startedAt = "2025-06-04T08:00:00.000Z";
    const endedAt = "2025-06-04T09:00:00.000Z";
    const middle = "2025-06-04T08:30:00.000Z";
    const fakeKey = "sk-" + "live-" + "1234567890abcdefghijklmnop";
    const s = transcript(join(project, "work-session.jsonl"), jsonl(
      { ...userPrompt("Inspect the build"), timestamp: middle },
      {
        type: "assistant",
        timestamp: middle,
        message: {
          id: "reply-1",
          content: [
            { type: "thinking", signature: "opaque signature", thinking: "Check the build" },
            { type: "redacted_thinking", data: "opaque thinking data" },
            { type: "image", source: { type: "base64", data: "A".repeat(512) } },
          ],
        },
      },
      { type: "assistant", message: { id: "reply-1", content: [{ type: "text", text: "Build checked" }] } },
      { type: "custom-title", customTitle: "Review with Rowan Cypress" },
      { type: "progress", timestamp: "not a timestamp" },
    ) + `API_KEY=${fakeKey}\n`);

    transcript(join(own, "subagents", "agent-modern.jsonl"), jsonl(
      { ...userPrompt("Modern subagent work"), agentId: "modern", timestamp: endedAt },
    ));
    transcript(join(project, "agent-legacy.jsonl"), jsonl(
      { ...userPrompt("Legacy subagent work"), agentId: "legacy", sessionId: s.id, timestamp: startedAt },
    ));
    transcript(join(project, "agent-unrelated.jsonl"), jsonl(
      { ...userPrompt("Unrelated agent work"), sessionId: "other-session" },
    ));

    const tools = join(own, "tool-results");
    mkdirSync(tools);
    writeFileSync(join(tools, "report.TXT"), `API_KEY=${fakeKey}\nContact: author@example.test\n`);
    writeFileSync(join(tools, "screenshot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const oversized = join(tools, "oversized.log");
    writeFileSync(oversized, "");
    truncateSync(oversized, 5 * 1024 * 1024 + 1);
    mkdirSync(join(tools, "unreadable.txt"));

    const bundle = bundleSession(s, ["Rowan Cypress"]);
    assert.equal(bundle.session, s);
    assert.equal(bundle.title, "Review with [you]");
    assert.equal(bundle.messages, 4, "two reply blocks are one message");
    assert.equal(bundle.subagents, 2);
    assert.equal(bundle.startedAt, startedAt);
    assert.equal(bundle.endedAt, endedAt);
    assert.equal(bundle.leftOut, 3, "one inline image and two unsupported or oversized files");
    assert.equal(bundle.hidden, 3, "the title is cleaned in two places, plus the report email");
    assert.equal(redactedCount(bundle), 1, "the same key in the transcript and report counts once");

    const lines = unpack(bundle);
    assert.ok(lines.includes(`API_KEY=${R}`), "a non-JSON line is still redacted");
    assert.ok(lines.every((line) => !line.includes(fakeKey) && !line.includes("Unrelated agent work")));
    const records = lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    assert.deepEqual(records.filter((r) => r.agentId).map((r) => r.agentId).sort(), ["legacy", "modern"]);
    const blocks = records.find((r) => r.message?.id === "reply-1").message.content;
    assert.equal(blocks[0].signature, "[left out]");
    assert.equal(blocks[0].thinking, "Check the build");
    assert.equal(blocks[1].data, "[left out]");
    assert.equal(blocks[2].source.data, "[left out: image or file bytes]");

    const attachments = records.filter((r) => r.type === "trail-share-file");
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].sessionId, s.id);
    assert.equal(attachments[0].path, "tool-results/report.TXT");
    assert.equal(attachments[0].content, `API_KEY=${R}\nContact: [email]\n`);
  });

  test("redacts dotenv tool calls and both copies of their results, but not templates or mentions", () => {
    const calls = [
      { id: "read-local", name: "Read", input: { file_path: join("config", ".env.local") }, redact: true },
      { id: "write-prod", name: "Write", input: { file_path: join("config", "prod.env"), content: "THEME=blue" }, redact: true },
      { id: "read-shell", name: "Bash", input: { command: "cat .env.example; head .envrc" }, redact: true },
      { id: "read-template", name: "Read", input: { file_path: ".env.example" }, redact: false },
      { id: "shell-template", name: "Bash", input: { command: "cat .env.sample" }, redact: false },
      { id: "shell-mention", name: "Bash", input: { command: "git commit -m 'Document .env settings'" }, redact: false },
      { id: "read-normal", name: "Read", input: { file_path: "env" }, redact: false },
    ];
    const entries = calls.flatMap(({ id, name, input }, i) => {
      const content = `MODE_NAME=setting-${i}`;
      return [
        { type: "assistant", message: { id, content: [{ type: "tool_use", id, name, input }] } },
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
          toolUseResult: { text: content },
        },
      ];
    });
    const s = transcript(join(scratch, "dotenv", "settings.jsonl"), jsonl(...entries));
    const bundle = bundleSession(s, []);
    const records = unpack(bundle).map((line) => JSON.parse(line));

    assert.deepEqual(bundle.redacted, { "a .env value": 4 });
    assert.equal(records.length, entries.length);
    for (const [i, call] of calls.entries()) {
      const result = records[i * 2 + 1];
      const expected = `MODE_NAME=${call.redact ? R : `setting-${i}`}`;
      assert.equal(result.message.content[0].tool_use_id, call.id);
      assert.equal(result.message.content[0].content, expected, call.id);
      assert.equal(result.toolUseResult.text, expected, `${call.id}: duplicate result`);
    }
    assert.equal(records[2].message.content[0].input.content, `THEME=${R}`);
    assert.equal(records[4].message.content[0].input.command, calls[2]!.input.command);
  });

  test("dotenv redaction preserves read prefixes and reports only newly hidden assignments", () => {
    const taken: string[] = [];
    const text = `  12→ export COLOR_MODE = indigo\r\nKEEP=${R}\r\n`;
    assert.equal(redactEnvValues(text, (s) => taken.push(s)), `  12→ export COLOR_MODE = ${R}\r\nKEEP=${R}\r\n`);
    assert.deepEqual(taken, ["COLOR_MODE=indigo"]);
  });

  test("the default bundle identity uses the isolated git config", () => {
    const config = join(scratch, "identity.gitconfig");
    writeFileSync(config, "[user]\n\tname = Cedar Hawthorn\n\temail = copper-contact@example.test\n");
    const s = transcript(join(scratch, "identity", "session.jsonl"), jsonl(
      { type: "custom-title", customTitle: "Review with Cedar Hawthorn" },
    ));

    withGitConfig(config, () => {
      const names = whoIAm([" Cedar Hawthorn ", "team-hawthorn@example.test", "runner", "xy"]);
      for (const name of ["Cedar Hawthorn", "copper-contact@example.test", "copper-contact", "team-hawthorn@example.test", "team-hawthorn"]) {
        assert.ok(names.includes(name), name);
      }
      assert.equal(names.filter((name) => name === "Cedar Hawthorn").length, 1);
      assert.ok(!names.includes("runner") && !names.includes("xy"));
      assert.deepEqual(names.map((name) => name.length), names.map((name) => name.length).sort((a, b) => b - a));

      const bundle = bundleSession(s);
      assert.equal(bundle.title, "Review with [you]");
      assert.equal(JSON.parse(unpack(bundle)[0]!).customTitle, "Review with [you]");
      assert.equal(bundle.hidden, 2);
    });

    const empty = join(scratch, "empty.gitconfig");
    writeFileSync(empty, "");
    withGitConfig(empty, () => {
      const names = whoIAm(["Juniper Test Contact"]);
      assert.ok(names.includes("Juniper Test Contact"));
      assert.ok(!names.includes("Cedar Hawthorn") && !names.includes("copper-contact@example.test"));
      assert.ok(names.every((name) => name.length >= 3));
    });
  });
});
