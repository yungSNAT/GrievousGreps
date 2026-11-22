import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { repoPlace } from "../src/notes/home.js";
import { replaySession, sessionHashOf, typedAt } from "../src/init/replay-runs.js";
import { tmpRepo } from "./helpers.js";

const now = new Date("2026-01-12T12:00:00.000Z");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const whole = (path: string) => ({ from: 0, to: statSync(path).size });

/** Writes Claude Code records, not shell scripts: none of the recorded commands are executed. */
class Transcript {
  private readonly lines: string[] = [];
  private parent: string | null = null;
  private clock = Date.parse("2026-01-01T12:00:00.000Z");
  private calls = 0;
  offset = 0;

  constructor(readonly path: string, private readonly cwd?: string) {}

  raw(line: string): number {
    const start = this.offset;
    this.lines.push(line);
    this.offset += Buffer.byteLength(line + "\n");
    return start;
  }

  private record(type: string, fields: Record<string, unknown>): number {
    const uuid = randomUUID();
    const start = this.raw(JSON.stringify({
      type,
      uuid,
      parentUuid: this.parent,
      isSidechain: false,
      sessionId: basename(this.path, ".jsonl"),
      timestamp: new Date(this.clock).toISOString(),
      cwd: this.cwd,
      ...fields,
    }));
    this.parent = uuid;
    this.clock += 1_000;
    return start;
  }

  ask(text: string): number {
    return this.record("user", { message: { role: "user", content: text } });
  }

  private assistant(content: object, stopReason: string): void {
    this.record("assistant", {
      message: {
        id: `msg_${randomUUID()}`,
        role: "assistant",
        content: [content],
        stop_reason: stopReason,
      },
    });
  }

  bash(command: string, output: string, failed = false): void {
    const id = `toolu_${++this.calls}`;
    this.assistant({ type: "tool_use", id, name: "Bash", input: { command } }, "tool_use");
    this.record("user", {
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: output, is_error: failed }],
      },
      toolUseResult: {
        stdout: failed ? "" : output,
        stderr: failed ? output : "",
        interrupted: false,
        exitCode: failed ? 1 : 0,
      },
    });
  }

  compact(): number {
    return this.record("system", {
      subtype: "compact_boundary",
      parentUuid: null,
      logicalParentUuid: this.parent,
      content: "Conversation compacted",
      isMeta: false,
      compactMetadata: { trigger: "auto", preTokens: 100_000 },
    });
  }

  finishRelease(version: string): void {
    this.bash("npm test", "TAP version 13\nok 1 - package smoke test\n1..1\n# pass 1\n# fail 0");
    this.bash("npm publish", `+ replay-fixture@${version}`);
    this.bash("npm view replay-fixture version", version);
    this.assistant({
      type: "text",
      text: `Published replay-fixture@${version}. The tests passed, and npm view confirmed ${version}.`,
    }, "end_turn");
  }

  release(version: string): number {
    const start = this.ask(`publish ${version}`);
    this.bash(`npm version ${version}`, `v${version}`);
    this.finishRelease(version);
    this.clock += 2 * 24 * 60 * 60 * 1_000;
    return start;
  }

  save(): void {
    writeFileSync(this.path, this.lines.join("\n") + "\n");
  }
}

describe("init replay gaps", () => {
  let scratch: string;
  let repo: string;
  let projects: string;
  let env: NodeJS.ProcessEnv;
  let repoKey: string;
  let checkout: string;
  let restoreFetch: (() => void) | undefined;

  before(() => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("Replay tests must not make HTTP requests");
    });
    restoreFetch = () => fetchMock.mock.restore();

    scratch = tmpRepo("replay-runs-gaps");
    const home = join(scratch, "home");
    const config = join(home, ".claude");
    projects = join(config, "projects", "-replay-fixture");
    mkdirSync(projects, { recursive: true });
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: config,
      TRAIL_HOME: join(home, ".trail"),
    };

    repo = join(scratch, "package");
    mkdirSync(repo);
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repo, env });
    execFileSync("git", [
      "-c", "user.name=Replay Fixture",
      "-c", "user.email=replay@example.invalid",
      "-c", "commit.gpgsign=false",
      "commit", "--quiet", "--allow-empty", "-m", "Initial commit",
    ], { cwd: repo, env });
    const place = repoPlace(repo, env);
    assert.equal(place.git, true);
    repoKey = place.key;
    checkout = place.checkout;
  });

  after(() => {
    restoreFetch?.();
    if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  });

  const transcript = (cwd?: string) => new Transcript(join(projects, `${randomUUID()}.jsonl`), cwd);

  test("a missing transcript returns an empty replay with its requested identity and range", () => {
    const id = randomUUID();
    const path = join(projects, `${id}.jsonl`);
    const stretch = { from: 12, to: 80 };
    const replay = replaySession(path, stretch, repoKey);
    const hash = sha(id).slice(0, 12);
    assert.equal(sessionHashOf(path), hash);
    assert.equal(replay.sh, hash);
    assert.equal(replay.path, path);
    assert.equal(replay.repoKey, repoKey);
    assert.deepEqual(replay.stretch, stretch);
    assert.notStrictEqual(replay.stretch, stretch);
    assert.equal(replay.size, 0);
    assert.equal(replay.mtimeMs, 0);
    assert.equal(replay.headless, false);
    assert.deepEqual([replay.runs, replay.sheets, replay.typed, replay.programs], [[], [], [], []]);
  });

  test("a transcript without cwd skips a broken row and keeps a byte-accurate typed pointer", () => {
    const tx = transcript();
    const broken = '{"type":"user","message":"café"';
    tx.raw(broken);
    const offset = Buffer.byteLength(broken + "\n");
    const text = "Use concise changelog entries, please.";
    assert.equal(tx.ask(text), offset);
    tx.save();

    const replay = replaySession(tx.path, whole(tx.path), "", now, { env });
    assert.equal(replay.size, tx.offset);
    assert.equal(replay.typed.length, 1);
    const typed = replay.typed[0]!;
    assert.equal(typed.text, text);
    assert.equal(typed.ref.t, tx.path);
    assert.equal(typed.ref.o, offset);
    assert.equal(typedAt(typed.ref, env), text);
    assert.equal(typedAt({ ...typed.ref, o: offset + 1 }, env), null);
    assert.equal(typedAt({ ...typed.ref, s: sha("a different line") }, env), null);
    assert.deepEqual(replay.sheets, []);
  });

  test("repeated releases retain only the newest three checked sheets, not just the newest three runs", () => {
    const tx = transcript(repo);
    const versions = ["1.0.1", "1.0.2", "1.0.3", "1.0.4", "1.0.5"];
    const starts = versions.map((version) => tx.release(version));
    tx.save();
    const ranges = starts.map((from, i) => ({ from, to: starts[i + 1] ?? tx.offset }));

    const replay = replaySession(tx.path, whole(tx.path), repoKey, now, { env });
    assert.equal(replay.stopped, undefined);
    assert.equal(replay.runs.length, versions.length);
    for (const run of replay.runs) {
      assert.equal(run.closed, true);
      assert.equal(run.sheet, "checked");
      assert.ok(Number.isInteger(run.checkIndex));
      assert.deepEqual(run.calls, [], "ordinary calls are kept in the sheet, not the closed run");
    }

    assert.deepEqual(replay.sheets.map((entry) => entry.src), ranges.slice(-3));
    assert.deepEqual(replay.programs, ["npm"]);
    for (const [i, { root, sheet }] of replay.sheets.entries()) {
      assert.equal(root, checkout);
      assert.equal(sheet.repoKey, repoKey);
      assert.equal(sheet.checked, true);
      assert.ok(sheet.calls.some((call) => call.cmd === `npm version ${versions[i + 2]}`));
      assert.ok(sheet.calls.some((call) => call.cmd === "npm view replay-fixture version"));
    }

    const want = ranges[0]!;
    const found = replaySession(tx.path, whole(tx.path), repoKey, now, { env, want });
    assert.equal(found.sheets.length, 1);
    assert.equal(found.runs.length, 1);
    const wanted = found.wanted;
    assert.ok(wanted, "the exact range finds the first release before its sheet can be evicted");
    assert.deepEqual(wanted.src, want);
    assert.strictEqual(wanted, found.sheets[0]);
    // Run IDs belong to this fold; the byte range and release command identify the run across replays.
    assert.equal(wanted.sheet.id, found.runs[0]!.id);
    assert.equal(wanted.sheet.checked, true);
    assert.ok(wanted.sheet.calls.some((call) => call.cmd === `npm version ${versions[0]}`));

    const cut = replaySession(tx.path, { from: 0, to: want.to }, repoKey, now, { env, want });
    assert.deepEqual(cut.sheets.map((entry) => entry.src), [want]);
    assert.equal(cut.wanted, undefined, "a cut does not count as the line that closed the run");
  });

  test("a failed publish closes as a draft and is not a checked release candidate", () => {
    const tx = transcript(repo);
    tx.ask("publish 1.0.1");
    tx.bash("npm publish", "Exit code 1\nnpm error E403: publishing was denied", true);
    tx.save();

    const replay = replaySession(tx.path, whole(tx.path), repoKey, now, { env, keepCalls: true });
    assert.equal(replay.runs.length, 1);
    const run = replay.runs[0]!;
    assert.equal(run.closed, true);
    assert.equal(run.sheet, "draft");
    assert.equal(run.checkIndex, null);
    assert.equal(run.failedCount, 1);
    assert.ok(run.calls.some((call) => call.cmd === "npm publish"));
    assert.deepEqual(replay.programs, ["npm"]);
    assert.deepEqual(replay.sheets, []);
  });

  test("a checked release continued after compaction includes its earlier draft and byte range", () => {
    const tx = transcript(repo);
    const start = tx.ask("publish 1.0.1");
    tx.bash("npm version 1.0.1", "v1.0.1");
    tx.bash("npm publish", "Exit code 1\nnpm error ETIMEDOUT: registry request timed out", true);
    tx.compact();
    tx.finishRelease("1.0.1");
    tx.save();

    const replay = replaySession(tx.path, whole(tx.path), repoKey, now, { env });
    const draft = replay.runs.find((run) => run.sheet === "draft");
    assert.ok(draft, "compaction closes the interrupted attempt as a draft");
    assert.equal(replay.sheets.length, 1);
    const entry = replay.sheets[0]!;
    assert.equal(entry.sheet.checked, true);
    assert.equal(entry.sheet.joined?.[0]?.id, draft.id);
    assert.deepEqual(entry.src, { from: start, to: tx.offset });
    assert.ok(entry.sheet.calls.some((call) => call.cmd === "npm version 1.0.1"));
    assert.ok(entry.sheet.calls.some((call) => call.cmd === "npm view replay-fixture version"));
  });

  test("replay reports the time cap without admitting a turn after the deadline", () => {
    const tx = transcript(repo);
    tx.ask("publish 1.0.1");
    tx.save();
    let reads = 0;
    const clock = mock.method(Date, "now", () => reads++ === 0 ? 1_000 : 1_002);
    try {
      const replay = replaySession(tx.path, whole(tx.path), repoKey, now, { env, maxMs: 1 });
      assert.equal(replay.stopped, "time");
      assert.deepEqual([replay.typed, replay.runs, replay.sheets], [[], [], []]);
    } finally {
      clock.mock.restore();
    }
  });
});
