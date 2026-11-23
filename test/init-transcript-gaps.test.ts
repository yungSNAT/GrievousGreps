import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dayOf,
  eachLine,
  firstCwd,
  ownWords,
  readSession,
  scanTranscript,
  sessionOf,
} from "../src/init/transcript.js";

const MAX_LINE = 2 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;

function user(content: string, fields: Record<string, unknown> = {}) {
  return {
    type: "user",
    entrypoint: "cli",
    message: { role: "user", content },
    ...fields,
  };
}

function toolResultOfSize(bytes: number): string {
  const prefix = '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_read","content":"';
  const suffix = '"}]}}';
  return prefix + "x".repeat(bytes - prefix.length - suffix.length) + suffix;
}

describe("init transcript reader", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "init-transcript-gaps-"));
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, contents: string): string {
    const path = join(dir, `${name}.jsonl`);
    writeFileSync(path, contents, "utf8");
    return path;
  }

  function transcript(name: string, ...rows: unknown[]) {
    let next = 0;
    const offsets: number[] = [];
    const lines = rows.map((row) => {
      const line = typeof row === "string" ? row : JSON.stringify(row);
      offsets.push(next);
      next += Buffer.byteLength(line) + 1;
      return line;
    });
    return { path: write(name, lines.join("\n") + "\n"), offsets };
  }

  test("dayOf handles absent dates, date-only values, and invalid timestamps", () => {
    assert.equal(dayOf(undefined), "");
    assert.equal(dayOf("January 9, 2026"), "");
    assert.equal(dayOf("2026-01-09"), "2026-01-09");
    assert.equal(dayOf("2026-19-09T08:05:00Z"), "");
  });

  test("dayOf uses local midnight, not UTC midnight", () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      assert.equal(dayOf("2026-01-09T07:55:00Z"), "2026-01-08");
      assert.equal(dayOf("2026-01-09T08:05:00Z"), "2026-01-09");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  test("eachLine finishes an in-range row across a chunk boundary, even inside a UTF-8 character", () => {
    const crossing = JSON.stringify(user("é — check the release notes"));
    // The first byte of é is the last byte of the first read.
    const crossingOffset = CHUNK_BYTES - 1 - crossing.indexOf("é");
    const secondBytes = crossingOffset - MAX_LINE - 2;
    const { path } = transcript(
      "chunk-boundary",
      toolResultOfSize(MAX_LINE),
      toolResultOfSize(secondBytes),
      crossing,
      user("This row starts outside the range"),
    );
    const seen: { offset: number; bytes: number; text?: string }[] = [];

    eachLine(path, (line, offset) => {
      seen.push({
        offset,
        bytes: Buffer.byteLength(line),
        ...(line.length < 1024 ? { text: line } : {}),
      });
    }, { from: -1, to: crossingOffset + 1 });

    assert.deepEqual(seen, [
      { offset: 0, bytes: MAX_LINE },
      { offset: MAX_LINE + 1, bytes: secondBytes },
      { offset: crossingOffset, bytes: Buffer.byteLength(crossing), text: crossing },
    ]);
  });

  test("eachLine skips a multi-chunk tool result and a blank line, then reports the unterminated final row", () => {
    const oversized = toolResultOfSize(CHUNK_BYTES + 31);
    const final = JSON.stringify(user("Verify the résumé export"));
    const path = write("oversized", `${oversized}\n\n${final}`);
    const visit = mock.fn((_line: string, _offset: number) => {});

    eachLine(path, visit);

    assert.equal(visit.mock.callCount(), 1);
    assert.deepEqual(visit.mock.calls[0]!.arguments, [final, oversized.length + 2]);
  });

  test("eachLine starts at a nonzero byte offset and clamps an end before the file", () => {
    const { path, offsets } = transcript("range", user("Review café output"), user("Update the changelog"));
    const visit = mock.fn((_line: string, _offset: number) => {});

    eachLine(path, visit, { from: 0, to: -1 });
    assert.equal(visit.mock.callCount(), 0);

    const from = offsets[1]!;
    eachLine(path, visit, { from, to: from + 1 });
    assert.equal(visit.mock.callCount(), 1);
    assert.deepEqual(visit.mock.calls[0]!.arguments, [
      JSON.stringify(user("Update the changelog")),
      from,
    ]);
  });

  test("firstCwd decodes the initial cwd rather than the cwd after a directory change", () => {
    const cwd = join(dir, "café workspace");
    const encoded = JSON.stringify(cwd).replace("é", "\\u00e9");
    const { path } = transcript(
      "cwd",
      `{"type":"user","cwd":${encoded}}`,
      { type: "assistant", cwd: join(dir, "other workspace") },
    );

    assert.equal(firstCwd(path), cwd);
  });

  test("firstCwd returns null for a malformed escape or a cwd beyond the initial read", () => {
    const broken = write("broken-cwd", String.raw`{"cwd":"bad\q"}`);
    const { path: late } = transcript(
      "late-cwd",
      toolResultOfSize(256 * 1024),
      user("Review the output", { cwd: dir }),
    );

    assert.equal(firstCwd(broken), null);
    assert.equal(firstCwd(late), null);
  });

  test("the transcript readers distinguish a missing file from readable transcript content", () => {
    const path = join(dir, "not-created.jsonl");
    assert.throws(() => eachLine(path, () => assert.fail("unexpected line")));
    assert.equal(firstCwd(path), null);
    assert.deepEqual(scanTranscript(path), { headless: false, prompts: [], calls: [] });
    assert.equal(readSession(path), null);
  });

  test("ownWords drops reminder-only content and only adds an ellipsis above the prompt cap", () => {
    assert.equal(ownWords("<system-reminder>\nThe IDE opened a file.\n</system-reminder>"), null);

    const details = "Please verify the generated fixtures: " +
      Array.from({ length: 100 }, (_, n) => `fixture-${String(n).padStart(3, "0")}`).join(", ");
    const atLimit = `${details.slice(0, 1199)}.`;
    const overLimit = `${details.slice(0, 1200)}.`;

    assert.equal(ownWords(atLimit), atLimit);
    assert.equal(ownWords(overLimit), `${overLimit.slice(0, 1200)}…`);
  });

  test("a scan keeps prompt and call order, ignores transcript noise, and survives a failed tool classification", () => {
    const at = "2026-01-09T08:05:00Z";
    const input = { file_path: join(dir, "README.md") };
    const finalWords = "\n  Keep the worktree.";
    const padding = "x".repeat(240 - finalWords.length);
    const { path, offsets } = transcript(
      "mixed",
      '{"type":',
      null,
      42,
      {
        type: "assistant",
        cwd: dir,
        message: { content: [
          { type: "text", text: `Earlier context: ${padding}${finalWords}` },
          { type: "tool_use", id: "toolu_read", name: "Read", input },
        ] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_partial", input: {} }] },
      },
      toolResultOfSize(300),
      user("Sidechain prompt", { isSidechain: true, gitBranch: "sidechain" }),
      user("Keep it for now", { timestamp: at, gitBranch: "review" }),
      user("Update the notes too", { timestamp: 123, gitBranch: "later" }),
    );
    const touches = mock.fn((cwd: string, name: string, _input: unknown) => {
      if (!name) throw new Error("Cannot classify an unnamed tool");
      return cwd === dir && name === "Read";
    });

    const scan = scanTranscript(path, touches);

    assert.equal(scan.headless, false);
    assert.equal(scan.branch, "review");
    assert.deepEqual(touches.mock.calls.map((call) => call.arguments), [
      [dir, "Read", input],
      ["", "", {}],
    ]);
    assert.deepEqual(scan.calls, [
      { i: 0, o: offsets[3], inRepo: true },
      { i: 1, o: offsets[4], inRepo: false },
    ]);
    assert.deepEqual(scan.prompts, [
      { i: 2, o: offsets[7], text: "Keep it for now", before: `${padding} Keep the worktree.`, at },
      { i: 3, o: offsets[8], text: "Update the notes too" },
    ]);
    assert.deepEqual(scanTranscript(path).calls, [
      { i: 0, o: offsets[3], inRepo: false },
      { i: 1, o: offsets[4], inRepo: false },
    ]);

    const whole = sessionOf(path, scan);
    assert.equal(whole?.at, at);
    assert.deepEqual(whole?.prompts, [
      { text: "Keep it for now", before: `${padding} Keep the worktree.`, at },
      { text: "Update the notes too" },
    ]);

    const stretch = sessionOf(path, scan, scan.prompts.slice(1), "ancestor");
    assert.equal(stretch?.source, "ancestor");
    assert.equal(stretch?.at, "");
    assert.deepEqual(stretch?.prompts, [{ text: "Update the notes too" }]);
  });

  test("readSession preserves file identity without inventing a timestamp or source", () => {
    const { path } = transcript("untimed", user("Run the unit tests"));
    const session = readSession(path);

    assert.ok(session);
    assert.equal(session.id, "untimed");
    assert.equal(session.path, path);
    assert.equal(session.at, "");
    assert.equal(Object.hasOwn(session, "source"), false);
    assert.deepEqual(session.prompts, [{ text: "Run the unit tests" }]);
  });

  test("an SDK marker prevents a session from being built even from prompts already scanned", () => {
    const { path } = transcript(
      "sdk-replay",
      user("Check the build", { entrypoint: undefined }),
      { type: "assistant", entrypoint: "sdk-cli" },
      user("This replayed prompt is not counted"),
    );

    const scan = scanTranscript(path, undefined, { TRAIL_LAB_INTERACTIVE: "0" });

    assert.equal(scan.headless, true);
    assert.deepEqual(scan.prompts, [{ text: "Check the build", i: 0, o: 0 }]);
    assert.equal(sessionOf(path, scan), null);
  });
});
