import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PastSession } from "../src/init/sessions.js";
import type { Learning } from "../src/learn/bar.js";
import {
  beginSessionRead,
  finishSessionRead,
  sessionLines,
  sessionsDigest,
  type SessionRead,
} from "../src/learn/sessions.js";
import { ensureRepoHome } from "../src/notes/home.js";

let scratch: string;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "learn-sessions-gaps-"));
  mock.method(globalThis, "fetch", async () => assert.fail("session tests must stay offline"));
});

after(() => {
  mock.restoreAll();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const at = "2026-10-20T10:00:00Z";
const user = (content: unknown, flags = {}) =>
  JSON.stringify({ type: "user", timestamp: at, message: { role: "user", content }, ...flags });
const assistant = (content: unknown) =>
  JSON.stringify({ type: "assistant", timestamp: at, message: { role: "assistant", content } });
const reply = (text: string) => assistant([{ type: "text", text }]);
const tool = (name: string, fields: { id?: string; input?: Record<string, unknown> } = {}) =>
  ({ type: "tool_use", name, ...fields });
const answer = (id: string, content: unknown) => ({ type: "tool_result", tool_use_id: id, content });

function transcript(name: string, ...rows: string[]): string {
  const path = join(scratch, `${name}.jsonl`);
  writeFileSync(path, rows.join("\n") + "\n");
  return path;
}

function session(id: string, timestamp: string, path = "", branch?: string): PastSession {
  return { id, at: timestamp, path, prompts: [], ...(branch ? { branch } : {}) };
}

describe("session transcript gaps", () => {
  test("ignores damaged rows, side conversations, and metadata, then resumes reading", () => {
    const path = transcript(
      "damaged",
      user("Use the existing queue."),
      "a log line outside the JSON records",
      '{"type":"user","message":',
      user("Do not include the forked conversation.", { isSidechain: true }),
      user("Do not include this generated message.", { isMeta: true }),
      JSON.stringify({ type: "user", timestamp: at }),
      assistant("Not a block array."),
      assistant([null, { type: "text", text: "OK" }]),
      user([answer("unrelated-tool", "a build log, not a person speaking")]),
      user("Keep the retry limit\n\tat two."),
    );

    assert.deepEqual(sessionLines(path), [
      "[person] Use the existing queue.",
      "[person] Keep the retry limit at two.",
    ]);
    assert.deepEqual(sessionLines(join(scratch, "removed-transcript.jsonl")), []);
  });

  test("pairs only recorded questions with their answers, including block-form results", () => {
    const path = transcript(
      "questions",
      assistant([
        tool("AskUserQuestion", { id: "no-input" }),
        tool("AskUserQuestion", { id: "legacy", input: { questions: "Not a list" } }),
        tool("AskUserQuestion", { id: "blank", input: { questions: [null, {}, { question: "" }] } }),
        tool("AskUserQuestion", { input: { questions: [{ question: "No ID?" }] } }),
        tool("AskUserQuestion", {
          id: "queue",
          input: { questions: [null, {}, { question: "Which\n queue?" }, { question: "How many retries?" }] },
        }),
        tool("AskUserQuestion", {
          id: "rollout",
          input: { questions: [{ question: "When do we roll out?" }] },
        }),
        tool("AskUserQuestion", {
          id: "approval",
          input: { questions: [{ question: "Was it approved?" }] },
        }),
      ]),
      user([
        answer("no-input", "orphaned result"),
        answer("legacy", "another orphaned result"),
        answer("blank", "nothing was asked"),
        { type: "tool_result", content: "no correlation ID" },
        answer("queue", [{ type: "text", text: "Batch\n queue." }, { type: "image" }, { type: "text", text: "Retry once." }]),
        answer("rollout", "After  the\n freeze."),
        answer("approval", { status: "unavailable" }),
      ]),
    );

    const lines = sessionLines(path);
    assert.equal(lines.length, 3);
    assert.equal(lines[0], "[answered] Which queue? / How many retries? -> Batch queue. Retry once.");
    assert.equal(lines[1], "[answered] When do we roll out? -> After the freeze.");
    assert.match(lines[2]!, /^\[answered\] Was it approved\? ->\s*$/);
  });

  test("keeps plans, commits and PRs, but not routine commands or their output", () => {
    const plan = `Retain the old queue.\n${"Verify the retry limit after deploying. ".repeat(60)}`;
    const pr = `gh pr create --title "Document retries" --body "${"Describe the rollout. ".repeat(55)}"`;
    const path = transcript(
      "release",
      assistant([
        tool("ExitPlanMode", { input: { plan } }),
        tool("ExitPlanMode", { input: { plan: { draft: true } } }),
        tool("Bash", { input: { command: 17 } }),
        tool("Bash", { id: "status", input: { command: "git status" } }),
        tool("Bash", { input: { command: 'git commit -m "Document retries"' } }),
        tool("Bash", { input: { command: pr } }),
      ]),
      user([answer("status", "untracked files that should not enter the digest")]),
    );

    const lines = sessionLines(path);
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /^\[plan\] Retain the old queue\. Verify the retry limit/);
    assert.ok(lines[0]!.endsWith("…"));
    assert.ok(lines[0]!.length <= "[plan] ".length + 1_501);
    assert.equal(lines[1], '[ran] git commit -m "Document retries"');
    assert.match(lines[2]!, /^\[ran\] gh pr create --title "Document retries"/);
    assert.ok(lines[2]!.endsWith("…"));
    assert.ok(lines[2]!.length <= "[ran] ".length + 901);
  });

  test("uses the larger reply budget for decisions, answered replies and the last reply", () => {
    const routine = "Current progress: " + "I am reading through the queue tests. ".repeat(24).trimEnd();
    const decision = "We chose batch processing. " + "Every batch has a separate checkpoint. ".repeat(10).trimEnd();
    const answered = "Here is the proposed rollout. " + "A worker records its checkpoint first. ".repeat(10).trimEnd();
    const last = "The rollout is ready. " + "All workers now publish retry counts. ".repeat(10).trimEnd();
    const path = transcript(
      "reply-budgets",
      reply(routine),
      reply(decision),
      reply(answered),
      user("No, keep the checkpoint at the end."),
      reply(last),
      assistant([tool("Bash", { input: { command: 'git commit -m "Move checkpoint"' } })]),
    );

    const lines = sessionLines(path);
    assert.equal(lines[0], `[claude] ${routine.slice(0, 240).trimEnd()}…`);
    assert.equal(lines[1], `[claude] ${decision}`);
    assert.equal(lines[2], `[claude] ${answered}`);
    assert.equal(lines[4], `[claude] ${last}`);
    assert.equal(lines[5], '[ran] git commit -m "Move checkpoint"');

    const full = sessionLines(path, undefined, { full: true });
    assert.equal(full[0], `[claude] ${routine.slice(0, 700).trimEnd()}…`);
    assert.equal(full[3], "[person] No, keep the checkpoint at the end.");

    const digest = sessionsDigest([session("replybud-1", at, path)], undefined, { full: true });
    assert.equal(digest.text.split("\n")[1], full[0]);
  });

  test("reads a stretch by byte offset even when earlier log text is multibyte", () => {
    const prefix = user("Changes for the café dashboard belong to another repo.") + "\n";
    const inScope = user("Keep the release jobs on main.") + "\n";
    const path = transcript(
      "byte-range",
      prefix + inScope + user("Later we switched to another repo."),
    );
    const stretch = { from: Buffer.byteLength(prefix), to: Buffer.byteLength(prefix + inScope) };

    assert.deepEqual(sessionLines(path, stretch), ["[person] Keep the release jobs on main."]);
    const digest = sessionsDigest([{ ...session("stretch1-1", at, path), stretch }]);
    assert.deepEqual(digest.read, ["stretch1"]);
    assert.deepEqual(digest.text.split("\n").slice(1), ["[person] Keep the release jobs on main."]);
  });
});

describe("session digest gaps", () => {
  test("sorts readable sessions newest first and omits sessions without conversation", () => {
    const old = session("old00000-1", at, transcript("older", user("Run the smoke tests.")), "main");
    const recent = session(
      "new00000-1", "2026-10-21T10:00:00Z", transcript("recent", user("Keep the smoke tests on main.")),
    );
    const onlyOutput = session(
      "output00-1", "2026-10-22T10:00:00Z", transcript("tool-output", user([answer("build", "build output")])),
    );
    const noPath = session("nopath00-1", "2026-10-23T10:00:00Z");
    const input = [old, noPath, onlyOutput, recent];

    const digest = sessionsDigest(input);
    assert.deepEqual(digest.read, ["new00000", "old00000"]);
    assert.deepEqual(digest.sources.map(({ id, at }) => [id, at]), [
      ["new00000", recent.at],
      ["old00000", old.at],
    ]);
    assert.deepEqual(digest.text.split("\n").filter((line) => line.startsWith("===")), [
      "=== session new00000 (2026-10-21)",
      "=== session old00000 (2026-10-20, branch main)",
    ]);
    assert.equal(input[0], old, "building a digest must not reorder the caller's sessions");
  });

  test("keeps complete recent lines from an oversized first session and verifies only those lines", () => {
    const path = transcript(
      "oversized",
      user("abandoned cache design " + "earlier discussion ".repeat(30)),
      user("keep one release branch"),
      user("require two approvals"),
    );
    const digest = sessionsDigest([session("tail0000-1", at, path)], 110);

    assert.ok(digest.text.length <= 110);
    assert.deepEqual(digest.read, ["tail0000"]);
    assert.deepEqual(digest.text.split("\n").slice(1), [
      "[person] keep one release branch",
      "[person] require two approvals",
    ]);
    assert.equal(digest.sources[0]!.said.length, 2);
    assert.match(digest.sources[0]!.said[0]!, /keep one release branch/);
    assert.match(digest.sources[0]!.said[1]!, /require two approvals/);
    assert.doesNotMatch(digest.sources[0]!.said.join("\n"), /abandoned cache design/);
  });

  test("skips an oversized first session when no line fits, but stops on overflow after reading one", () => {
    const longPath = transcript("long-only", user("A long deployment checklist. ".repeat(20)));
    const shortPath = transcript("short-only", user("Ship on Monday."));
    const long = session("long0000-1", "2026-10-22T10:00:00Z", longPath);
    const short = session("short000-1", at, shortPath);
    const unread = session("unread00-1", "2026-10-19T10:00:00Z", shortPath);

    assert.deepEqual(sessionsDigest([short, long], 140).read, ["short000"]);
    const digest = sessionsDigest([unread, { ...short, at: "2026-10-23T10:00:00Z" }, long], 140);
    assert.deepEqual(digest.read, ["short000"]);
    assert.doesNotMatch(digest.text, /deployment checklist|unread00/);
  });
});

describe("finishing and restarting a session read", () => {
  const learning: Learning = {
    headline: "Keep the deployment queue single threaded",
    why: "Parallel deployments raced while writing the same checkpoint.",
    forAgent: "Keep a single worker in the deployment queue.",
    kind: "decided",
    sources: ["tail0000"],
    quotes: ["keep one worker in the deployment queue"],
    last: "2026-10-20",
  };

  let home: string;
  const previousEnv = new Map<string, string | undefined>();
  before(() => {
    home = mkdtempSync(join(scratch, "home-"));
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    for (const [key, value] of Object.entries({ TRAIL_HOME: join(home, ".trail"), DO_NOT_TRACK: "1" })) {
      previousEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
  });
  after(() => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function repo(): string {
    const path = realpathSync(mkdtempSync(join(scratch, "repo-")));
    const init = spawnSync("git", ["init", "-q"], { cwd: path, encoding: "utf8" });
    assert.equal(init.status, 0, init.error?.message ?? init.stderr);
    return path;
  }

  function completedRead(findings: Learning[]): SessionRead {
    return {
      started: Date.now(),
      done: true,
      result: Promise.resolve({
        sessions: 1, read: 1, findings, durationMs: 20, model: "fixture-model", newest: at,
      }),
    };
  }

  test("cancelling leaves the learning available to accept on a later read", async () => {
    const dir = repo();
    const markPath = join(ensureRepoHome(dir).place.dir, "session-learnings.json");

    const cancelled = await finishSessionRead(dir, completedRead([learning]), async (offered) => {
      assert.deepEqual(offered.map((l) => l.headline), [learning.headline]);
      return null;
    });

    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.offered, 1);
    assert.deepEqual(cancelled.kept, []);
    assert.deepEqual(cancelled.saved, []);
    assert.equal(existsSync(markPath), false);

    const accepted = await finishSessionRead(dir, completedRead([learning]));
    assert.equal(accepted.cancelled, false);
    assert.equal(accepted.offered, 1);
    assert.deepEqual(accepted.saved.map((note) => note.title), [learning.headline]);
    assert.equal(JSON.parse(readFileSync(markPath, "utf8")).saved, 1);
  });

  test("accepting no notes still records the read; a look-back with no sessions preserves the mark", async () => {
    const dir = repo();
    const finished = await finishSessionRead(dir, completedRead([learning]), async () => []);
    assert.equal(finished.cancelled, false);
    assert.equal(finished.offered, 1);
    assert.deepEqual(finished.saved, []);

    const markPath = join(ensureRepoHome(dir).place.dir, "session-learnings.json");
    const original = readFileSync(markPath, "utf8");
    const mark = JSON.parse(original);
    assert.equal(mark.newest, at);
    assert.equal(mark.saved, 0);
    assert.equal(mark.model, "fixture-model");
    assert.equal(Object.hasOwn(mark, "costUsd"), false);

    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
      TRAIL_NO_FETCH: "0",
    };
    assert.equal(beginSessionRead(dir, env), null);

    const lookBack = beginSessionRead(dir, env, { again: true, capMs: 5_000 });
    assert.ok(lookBack);
    const { result, saved } = await finishSessionRead(dir, lookBack);
    assert.equal(lookBack.done, true);
    assert.equal(result.reason, "no_sessions");
    assert.equal(result.sessions, 0);
    assert.equal(result.read, 0);
    assert.deepEqual(saved, []);
    assert.equal(readFileSync(markPath, "utf8"), original);
  });
});
