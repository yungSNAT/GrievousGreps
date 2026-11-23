import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  foldInputFor,
  proposalShaOf,
  replan,
  sessionOf,
} from "../src/skills/update-plan.js";
import { trailPath } from "../src/util/private-fs.js";

type Sheet = Parameters<typeof sessionOf>[0];

const sessionHash = "af719369ed8edf01";
const skillId = "bce82707401b23a9";
const runId = "dceef77123a8400f";
const start = "2025-02-01T12:00:00.000Z";
const sessionMaxBytes = 8 * 1024 * 1024;

const sheet = {
  id: runId,
  session: sessionHash,
  repoKey: "f1e2c3b4a5968778",
  startedAt: start,
  endedAt: "2025-02-01T12:01:00.000Z",
  calls: [],
} as Sheet;

function injection(target: string) {
  return {
    skillId,
    runId,
    params: { target },
    steps: ["node --version"],
    at: start,
  };
}

function savedSession(target: string, hash = sessionHash): string {
  return JSON.stringify({
    skills: { sessionHash: hash, injected: [injection(target)] },
  });
}

function put(dir: string, name: string, text: string, rank: number): void {
  const path = join(dir, name);
  writeFileSync(path, text);
  const seconds = Date.parse(start) / 1000 + rank * 2;
  utimesSync(path, seconds, seconds);
}

describe("update plans from disk", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "trail-update-plan-"));
    mock.method(globalThis, "fetch", async () => {
      throw new Error("Update plan tests must not make HTTP requests");
    });
  });

  after(() => {
    mock.restoreAll();
    rmSync(root, { recursive: true, force: true });
  });

  function isolatedEnv(name: string): NodeJS.ProcessEnv {
    const home = join(root, name);
    mkdirSync(home, { recursive: true });
    return {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TRAIL_HOME: join(home, "trail"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"),
    };
  }

  function sessionDir(env: NodeJS.ProcessEnv): string {
    const dir = trailPath(env, "sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  test("a missing sessions directory has no session for the sheet", () => {
    const env = isolatedEnv("missing-sessions");
    assert.equal(sessionOf(sheet, env), null);
  });

  test("finds the newest matching session by mtime, skipping unusable records", () => {
    const env = isolatedEnv("session-order");
    const dir = sessionDir(env);
    put(dir, "z-stale.json", savedSession("stale"), 1);
    put(dir, "a-current.json", savedSession("current"), 2);
    put(dir, "other-session.json", savedSession("unrelated", "another-session"), 3);
    put(dir, "primitive-skills.json", '{"skills":"not a session"}', 4);
    put(dir, "no-skills.json", JSON.stringify({ sessionHash }), 5);
    put(dir, "broken.json", '{"skills":', 6);

    const result = sessionOf(sheet, env);
    assert.ok(result);
    assert.equal(result.sessionHash, sessionHash);
    assert.equal(result.injected.length, 1);
    assert.equal(result.injected[0]?.params?.target, "current");

    assert.equal(sessionOf({ ...sheet, session: "not-recorded" }, env), null);
  });

  test("only the newest 64 eligible files count toward session lookup", () => {
    const env = isolatedEnv("session-limit");
    const dir = sessionDir(env);
    put(dir, "matching.json", savedSession("at-the-boundary"), 0);
    for (let i = 1; i <= 63; i++) {
      put(dir, `unrelated-${i}.json`, savedSession("other", `other-${i}`), i);
    }

    // These are newer than matching.json, but none is a session candidate.
    const directory = join(dir, "directory.json");
    mkdirSync(directory);
    const directoryTime = Date.parse(start) / 1000 + 128;
    utimesSync(directory, directoryTime, directoryTime);
    put(dir, "with a space.json", savedSession("invalid-filename"), 64);
    for (const suffix of ["hooks", "gate", "lesson", "update"]) {
      put(dir, `matching.${suffix}.json`, savedSession(suffix), 65);
    }
    put(dir, "oversized.json", savedSession("oversized").padEnd(sessionMaxBytes + 1), 66);

    const result = sessionOf(sheet, env);
    assert.ok(result);
    assert.equal(result.injected[0]?.params?.target, "at-the-boundary");

    // A file exactly at the size cap does count, pushing the match to 65th.
    put(dir, "one-more-session.json", savedSession("other", "other-64").padEnd(sessionMaxBytes), 67);
    assert.equal(sessionOf(sheet, env), null);
  });

  test("a saved injection cannot substitute for a missing personal skill", () => {
    const env = isolatedEnv("missing-skill");
    put(sessionDir(env), "recorded-session.json", savedSession("recorded"), 1);

    const st = sessionOf(sheet, env);
    assert.ok(st);
    assert.equal(st.injected[0]?.skillId, skillId);
    assert.equal(st.injected[0]?.runId, runId);

    assert.equal(foldInputFor(skillId, runId, env, { st }), null);
    assert.equal(replan(skillId, runId, "replace", env, { st }), null);
  });

  test("rejects an in-place split before consulting the store environment", () => {
    const baseEnv = isolatedEnv("split");
    const reads: PropertyKey[] = [];
    const env = new Proxy(baseEnv, {
      get(target, key, receiver) {
        reads.push(key);
        return Reflect.get(target, key, receiver);
      },
    });

    assert.equal(replan(skillId, runId, "split", env, { inj: injection("explicit") }), null);
    assert.deepEqual(reads, []);
  });

  test("the proposal digest pins the exact text, including a trailing newline", () => {
    assert.equal(proposalShaOf("abc"), "ba7816bf8f01cfea");
    assert.equal(proposalShaOf("abc\n"), "edeaaff3f1774ad2");
  });
});
