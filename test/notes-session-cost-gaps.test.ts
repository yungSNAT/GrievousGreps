import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aboutTerms,
  claudeProjectDir,
  costFromTranscript,
  currentSessionCost,
  currentTranscript,
  FALLBACK_ACTIVE_MS,
  sessionProjectDir,
} from "../src/notes/session-cost.js";

void mock;

const BASE = Date.parse("2026-01-01T10:00:00.000Z");
const iso = (min: number) => new Date(BASE + min * 60_000).toISOString();
const at = (min: number) => BASE + min * 60_000;
const jsonl = (entries: unknown[]) => entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n";

const dirs: string[] = [];
const scratch = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `session-cost-${tag}-`));
  dirs.push(d);
  return d;
};

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("aboutTerms", () => {
  test("keeps file paths and long-enough names, drops anchors, blanks, phrases and common words", () => {
    const body = "Use `dropHtmlComments()` and `trail init` and `publish` and `true` and `repo_id`, `ab`.";
    const terms = aboutTerms(body, ["src/a/b.ts#L3", "  ", "lib/a.c", "src/x.go"]);
    assert.deepEqual(terms, ["src/a/b.ts", "b.ts", "lib/a.c", "src/x.go", "x.go", "dropHtmlComments", "repo_id"]);
  });

  test("defaults to no files", () => {
    assert.deepEqual(aboutTerms("see `check-ignore`"), ["check-ignore"]);
    assert.deepEqual(aboutTerms("nothing specific here"), []);
  });
});

describe("sessionProjectDir", () => {
  let home: string;
  let repo: string;
  before(() => {
    home = scratch("home");
    repo = scratch("repo");
  });

  test("finds the nearest ancestor's project folder from a subfolder", () => {
    const project = claudeProjectDir(repo, home);
    mkdirSync(project, { recursive: true });
    const sub = join(repo, "a", "b");
    mkdirSync(sub, { recursive: true });
    assert.equal(sessionProjectDir(sub, home), project);
    assert.equal(sessionProjectDir(repo, home), project);
  });

  test("returns null when no folder up to the root has a project", () => {
    const emptyHome = scratch("empty-home");
    assert.equal(sessionProjectDir(join(repo, "a"), emptyHome), null);
  });
});

describe("currentTranscript", () => {
  test("null when there is no project folder", () => {
    const home = scratch("ct-none");
    assert.equal(currentTranscript(scratch("ct-repo"), home), null);
  });

  test("null when the project path is a file, not a folder", () => {
    const home = scratch("ct-file");
    const repo = scratch("ct-file-repo");
    const project = claudeProjectDir(repo, home);
    mkdirSync(join(project, ".."), { recursive: true });
    writeFileSync(project, "not a folder");
    assert.equal(currentTranscript(repo, home), null);
  });

  test("picks the newest .jsonl and ignores other files; stale transcripts are not current", () => {
    const home = scratch("ct-pick");
    const repo = scratch("ct-pick-repo");
    const project = claudeProjectDir(repo, home);
    mkdirSync(project, { recursive: true });
    const now = Date.now();
    const old = join(project, "old.jsonl");
    const newer = join(project, "newer.jsonl");
    const other = join(project, "notes.txt");
    writeFileSync(old, "{}\n");
    writeFileSync(newer, "{}\n");
    writeFileSync(other, "x");
    const sec = (ms: number) => ms / 1000;
    utimesSync(old, sec(now - 120_000), sec(now - 120_000));
    utimesSync(newer, sec(now - 10_000), sec(now - 10_000));
    utimesSync(other, sec(now), sec(now));
    assert.equal(currentTranscript(repo, home, now), newer);
    assert.equal(currentTranscript(repo, home, now + 31 * 60_000), null);
  });
});

describe("costFromTranscript", () => {
  test("counts from the last finished note, dedups usage by message id, skips cache reads, lists edited and read files", () => {
    const text = jsonl([
      { type: "user", timestamp: iso(0), message: { content: "start" } },
      { type: "assistant", timestamp: iso(1), message: { id: "m1", usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npx -y @trailhq/trail note 'x'" } }] } },
      { type: "user", timestamp: iso(2), message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } },
      { type: "user", timestamp: iso(3), message: { content: "next" } },
      { type: "assistant", timestamp: iso(4), message: { id: "m2", usage: { input_tokens: 10, cache_creation_input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 9999 }, content: [{ type: "tool_use", name: "Edit", input: { file_path: "/r/a.ts" } }] } },
      { type: "assistant", timestamp: iso(4), message: { id: "m2", usage: { input_tokens: 10, cache_creation_input_tokens: 20, output_tokens: 5 }, content: [{ type: "tool_use", name: "Read", input: { file_path: "/r/b.ts" } }] } },
      { type: "assistant", timestamp: iso(5), message: { usage: { output_tokens: 7 }, content: [
        { type: "tool_use", name: "NotebookEdit", input: { notebook_path: "/r/n.ipynb" } },
        { type: "tool_use", name: "Read", input: { file_path: "/r/b.ts" } },
        { type: "tool_use", name: "Edit", input: { file_path: "/r/a.ts" } },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
        { type: "text", text: "done" },
      ] } },
      { type: "assistant", timestamp: iso(6), message: { id: "m3", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "trail note 'y'" } }] } },
      "{\"type\":\"assist",
    ]);
    const c = costFromTranscript(text, at(8));
    assert.ok(c);
    assert.equal(c.startedAt, at(3));
    assert.equal(c.countedFrom, at(3));
    assert.equal(c.minutes, 5);
    assert.equal(c.tokens, 35 + 7);
    assert.deepEqual(c.edited, ["/r/a.ts", "/r/n.ipynb"]);
    assert.deepEqual(c.read, ["/r/b.ts"]);
  });

  test("gaps over ten minutes count as nothing, and the minimum is one minute", () => {
    const text = jsonl([
      { type: "user", timestamp: iso(0), message: { content: "a" } },
      { type: "user", timestamp: iso(1), message: { content: "b" } },
      { type: "user", timestamp: iso(30), message: { content: "c" } },
    ]);
    assert.equal(costFromTranscript(text, at(32))!.minutes, 3);
    const one = jsonl([{ type: "user", timestamp: iso(0), message: { content: "a" } }]);
    assert.equal(costFromTranscript(one, at(0))!.minutes, 1);
  });

  test("null with no timestamped entries since the last note", () => {
    assert.equal(costFromTranscript(jsonl([{ type: "user", message: { content: "a" } }, { type: "user", timestamp: "garbage" }]), at(1)), null);
    const text = jsonl([
      { type: "assistant", timestamp: iso(0), message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "graft note 'x'" } }] } },
      { type: "user", timestamp: iso(1), message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } },
    ]);
    assert.equal(costFromTranscript(text, at(2)), null);
  });

  test("with terms, counts from the turn whose tool call first mentions them, ignoring note calls", () => {
    const entries = [
      { type: "user", timestamp: iso(0), message: { content: "look up the slack thread" } },
      { type: "assistant", timestamp: iso(5), message: { content: [{ type: "tool_use", name: "Bash", input: { command: "slack search" } }] } },
      { type: "user", timestamp: iso(10), message: { content: [{ type: "text", text: "now fix" }, { type: "text", text: "the parser" }] } },
      { type: "assistant", timestamp: iso(12), message: { content: [{ type: "tool_use", name: "Bash", input: { command: "cd /r && trail note 'about src/parse.ts'" } }] } },
      { type: "user", timestamp: iso(14), message: { content: [{ type: "tool_result", tool_use_id: "zz", content: "src/parse.ts" }] } },
      { type: "user", timestamp: iso(15), message: { content: [{ type: "text", text: "go" }] } },
      { type: "assistant", timestamp: iso(17), message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/r/src/parse.ts" } }] } },
    ];
    const c = costFromTranscript(jsonl(entries), at(19), ["src/parse.ts"]);
    assert.ok(c);
    assert.equal(c.startedAt, at(0));
    assert.equal(c.countedFrom, at(15));
    assert.equal(c.minutes, 4);
    assert.deepEqual(c.read, ["/r/src/parse.ts"]);
    const whole = costFromTranscript(jsonl(entries), at(19));
    assert.equal(whole!.countedFrom, at(0));
  });

  test("a mention in the typed prompt dates the work to that prompt", () => {
    const text = jsonl([
      { type: "user", timestamp: iso(0), message: { content: "merge the branch" } },
      { type: "user", timestamp: iso(4), message: { content: "rename dropHtmlComments please" } },
      { type: "assistant", timestamp: iso(6), message: { id: "a", usage: { output_tokens: 3 }, content: [{ type: "text", text: "ok" }] } },
    ]);
    const c = costFromTranscript(text, at(7), ["dropHtmlComments"]);
    assert.equal(c!.countedFrom, at(4));
    assert.equal(c!.minutes, 3);
    assert.equal(c!.tokens, 3);
  });

  test("with terms that never come up, only the last 30 active minutes count", () => {
    const entries = Array.from({ length: 13 }, (_, k) => ({ type: "user", timestamp: iso(k * 5), message: { content: `step ${k}` } }));
    const c = costFromTranscript(jsonl(entries), at(60), ["nothing-here.ts"]);
    assert.ok(c);
    assert.equal(c.startedAt, at(0));
    assert.equal(c.countedFrom, at(30));
    assert.equal(c.minutes, FALLBACK_ACTIVE_MS / 60_000);
    const empty = costFromTranscript(jsonl(entries), at(60), []);
    assert.equal(empty!.countedFrom, at(30));
  });

  test("a mention only in an untimed entry falls back to the last timed entry", () => {
    const text = jsonl([
      { type: "user", timestamp: iso(0), message: { content: "hi" } },
      { type: "assistant", timestamp: iso(2), message: { content: [{ type: "text", text: "hello" }] } },
      { type: "user", message: { content: "edit src/z.ts" } },
    ]);
    const c = costFromTranscript(text, at(5), ["src/z.ts"]);
    assert.equal(c!.countedFrom, at(2));
    assert.equal(c!.minutes, 3);
  });
});

describe("currentSessionCost", () => {
  test("null without a transcript", () => {
    assert.equal(currentSessionCost(scratch("cs-repo"), scratch("cs-home")), null);
  });

  test("reads the running transcript and applies the terms", () => {
    const home = scratch("cs-home2");
    const repo = scratch("cs-repo2");
    const project = claudeProjectDir(repo, home);
    mkdirSync(project, { recursive: true });
    const now = Date.now();
    const t = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
    writeFileSync(join(project, "s.jsonl"), jsonl([
      { type: "user", timestamp: t(8), message: { content: "something else" } },
      { type: "user", timestamp: t(4), message: { content: "fix `src/retry.ts`" } },
      { type: "assistant", timestamp: t(2), message: { id: "x", usage: { input_tokens: 4, output_tokens: 6 }, content: [{ type: "tool_use", name: "Write", input: { file_path: "/r/src/retry.ts" } }] } },
    ]));
    const c = currentSessionCost(repo, home, now, ["src/retry.ts"]);
    assert.ok(c);
    assert.equal(c.minutes, 4);
    assert.equal(c.tokens, 10);
    assert.deepEqual(c.edited, ["/r/src/retry.ts"]);
    assert.equal(currentSessionCost(repo, home, now)!.minutes, 8);
  });

  test("null when the newest transcript can't be read as a file", () => {
    const home = scratch("cs-home3");
    const repo = scratch("cs-repo3");
    const project = claudeProjectDir(repo, home);
    mkdirSync(join(project, "weird.jsonl"), { recursive: true });
    assert.equal(currentSessionCost(repo, home, Date.now()), null);
  });
});
