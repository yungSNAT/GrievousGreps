/**
 * Gap tests for src/claude/walls-hook.ts: the PATH probe behind fix lines, the lazy SSH remote, counted hits,
 * the Stop-time hit count, the guardrail deny/avoided counts and the post-compaction fix lines.
 */
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { createHash } from "node:crypto";
import {
  AVOIDED_MS,
  onPathHere,
  wallCtxFor,
  countedHits,
  withoutTimeout,
  wallsAtStop,
  guardrailCounts,
  compactWallLines,
  wallContextText,
} from "../src/claude/walls-hook.js";
import { sessionPath } from "../src/trace/gate-file.js";
import { normalizeCommand, stripTimeout } from "../src/trace/shell.js";
import { readWalls } from "../src/trace/wall-state.js";
import { hostFacts } from "../src/skills/host-facts.js";

void mock;

const win = process.platform === "win32";
let root = "";
let binDir = "";

function envFor(tag: string): NodeJS.ProcessEnv {
  const home = join(root, tag);
  mkdirSync(home, { recursive: true });
  return { ...process.env, HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, ".trail") };
}

const shaOf = (cmd: string) =>
  `sha256:${createHash("sha256").update(normalizeCommand(stripTimeout(cmd))).digest("hex")}`;

before(() => {
  root = mkdtempSync(join(tmpdir(), "gg-walls-gaps-"));
  binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  for (const n of ["gg-walls-tool", "gg-walls-tool.exe", "gg-walls-tool.cmd"]) {
    writeFileSync(join(binDir, n), "#!/bin/sh\nexit 0\n");
    if (!win) chmodSync(join(binDir, n), 0o755);
  }
  writeFileSync(join(binDir, "gg-walls-noexec"), "data\n");
  if (!win) chmodSync(join(binDir, "gg-walls-noexec"), 0o644);
  mkdirSync(join(binDir, "gg-walls-adir"), { recursive: true });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("onPathHere", () => {
  const pathEnv = (): NodeJS.ProcessEnv => ({
    PATH: binDir,
    Path: binDir,
    PATHEXT: ".EXE;.CMD",
    HOME: root,
    USER: "dev",
  });

  test("finds an executable program in the PATH", () => {
    assert.equal(onPathHere("gg-walls-tool", pathEnv()), true);
  });

  test("rejects names that are not one plain word", () => {
    assert.equal(onPathHere("../evil", pathEnv()), false);
    assert.equal(onPathHere("", pathEnv()), false);
    assert.equal(onPathHere("a".repeat(41), pathEnv()), false);
  });

  test("a missing program or a directory is not on the PATH", () => {
    assert.equal(onPathHere("gg-walls-missing-xyz", pathEnv()), false);
    assert.equal(onPathHere("gg-walls-adir", pathEnv()), false);
  });

  test("a file without the exec bit does not count outside Windows", { skip: win }, () => {
    assert.equal(onPathHere("gg-walls-noexec", pathEnv()), false);
  });

  test("falls back to the OS home and user when the env has none", () => {
    const env: NodeJS.ProcessEnv = { PATH: [binDir, join(root, "nowhere")].join(delimiter), Path: binDir, PATHEXT: ".EXE;.CMD" };
    assert.equal(onPathHere("gg-walls-tool", env), true);
    assert.equal(onPathHere("gg-walls-missing-xyz", env), false);
  });
});

describe("wallCtxFor", () => {
  test("hasProgram reads the PATH and remoteSsh is null outside a git checkout, cached", () => {
    const dir = join(root, "not-git");
    mkdirSync(dir, { recursive: true });
    const ctx = wallCtxFor(dir, { PATH: binDir, Path: binDir, PATHEXT: ".EXE;.CMD", HOME: root, USER: "dev" });
    assert.equal(ctx.hasProgram("gg-walls-tool"), true);
    assert.equal(ctx.hasProgram("gg-walls-missing-xyz"), false);
    assert.equal(ctx.remoteSsh, null);
    // Second read comes from the cached value.
    assert.equal(ctx.remoteSsh, null);
  });
});

describe("countedHits and withoutTimeout", () => {
  test("only calls with a wall count", () => {
    const at = new Date().toISOString();
    const hit = { cmd: "timeout 5 npm test", failed: true, wall: "timeout-missing", at };
    const plain = { cmd: "ls", failed: false, at };
    const run = { calls: [plain, hit], repoKey: "x", epoch: 1, closed: true } as any;
    const hits = countedHits(run);
    assert.equal(hits.length, 1);
    assert.equal(hits[0], hit);
    assert.deepEqual(countedHits({ calls: [plain] } as any), []);
  });

  test("withoutTimeout returns null without a timeout prefix", () => {
    assert.equal(withoutTimeout(null), null);
    assert.equal(withoutTimeout("npm test"), null);
    assert.equal(withoutTimeout("timeout 60 npm test"), "npm test");
  });
});

describe("wallsAtStop", () => {
  test("nothing to record returns 0 and writes nothing", () => {
    const env = envFor("stop-empty");
    const ctx = { env, sessionHash: "sh-empty", sessionId: "s-empty", host: "claude", checkout: root, repoKey: "github.com/acme/repo", now: new Date() } as any;
    const st = { epoch: 1, runs: [{ repoKey: null, epoch: 1, closed: true, calls: [] }] } as any;
    assert.equal(wallsAtStop(st, ctx), 0);
    assert.equal(Object.keys(readWalls(env).classes ?? {}).length, 0);
  });

  test("a new failed hit counts as reached when the host reads failure context", () => {
    const env = envFor("stop-hit");
    const repoKey = "github.com/acme/repo";
    const ctx = { env, sessionHash: "sh-hit", sessionId: "s-hit", host: "claude", checkout: root, repoKey, now: new Date() } as any;
    const at = new Date().toISOString();
    const hitCall = { cmd: "timeout 5 make build", failed: true, wall: "timeout-missing", at };
    const st = {
      epoch: 2,
      runs: [
        { repoKey: null, epoch: 1, closed: true, calls: [] },
        {
          repoKey,
          epoch: 1,
          closed: true,
          repairs: [],
          calls: [
            { cmd: "git status", failed: false, at },
            hitCall,
          ],
        },
        { repoKey, epoch: 1, closed: false, calls: [] },
      ],
    } as any;
    assert.equal(countedHits(st.runs[1]).length, 1);
    const expected = hostFacts(env, "claude" as any).failureContext ? 1 : 0;
    assert.equal(wallsAtStop(st, ctx), expected);
  });

  test("compactWallLines reads the held calls of the closed epoch", () => {
    const env = envFor("compact-calls");
    const now = new Date();
    const ctx = { env, sessionHash: "sh-cc", sessionId: "s-cc", host: "claude", checkout: root, repoKey: "r", now } as any;
    const at = now.toISOString();
    const st = {
      epoch: 3,
      runs: [
        { repoKey: "r", epoch: 2, calls: [{ cmd: "timeout 5 make", failed: true, wall: "timeout-missing", at }] },
        { repoKey: "r", epoch: 1, calls: [{ cmd: "timeout 5 ls", failed: true, wall: "timeout-missing", at }] },
      ],
    } as any;
    const lines = compactWallLines(st, ctx);
    assert.equal(lines.length, 1);
    const expected = wallContextText("timeout-missing", { checkout: root, repoKey: "r", env, now }).text;
    assert.ok(expected.length > 0);
    assert.equal(lines[0], expected);
    assert.deepEqual(compactWallLines({ epoch: 1, runs: st.runs } as any, ctx), []);
  });
});

describe("guardrailCounts", () => {
  test("counts sure-fail denies, avoided ones within 30 minutes, and moves deniedSeen on", () => {
    assert.equal(AVOIDED_MS, 30 * 60 * 1000);
    const env = envFor("guard");
    const ctx = { env, sessionHash: "sh-g", sessionId: "sess-guard", host: "claude", checkout: root, repoKey: "r", now: new Date() } as any;
    const file = sessionPath("sess-guard", ".denied.jsonl", env);
    mkdirSync(dirname(file), { recursive: true });
    const t0 = Date.parse("2025-03-01T10:00:00.000Z");
    const restSha = shaOf("npm test");
    const lines = [
      "not json",
      JSON.stringify({ at: new Date(t0).toISOString(), restSha }),
      JSON.stringify({ restSha: "sha256:abc" }),
      JSON.stringify({ at: new Date(t0 - 2 * 60 * 60 * 1000).toISOString(), restSha }),
    ];
    writeFileSync(file, lines.join("\n") + "\n");
    const st = {
      epoch: 1,
      deniedSeen: 0,
      runs: [{ calls: [
        { cmd: "npm test", failed: false, at: new Date(t0 + 60_000).toISOString() },
        { cmd: "npm run lint", failed: true, at: new Date(t0 + 60_000).toISOString() },
      ] }],
    } as any;
    const sent: any[] = [];
    guardrailCounts(st, ctx, sent);
    assert.deepEqual(sent.map((s) => s[1].outcome), ["sure-fail", "avoided", "sure-fail", "sure-fail"]);
    assert.ok(sent.every((s) => s[0] === "guardrail" && s[1].class === "no-timeout"));
    assert.equal(st.deniedSeen, 4);

    // Nothing new: no events.
    const again: any[] = [];
    guardrailCounts(st, ctx, again);
    assert.deepEqual(again, []);
    assert.equal(st.deniedSeen, 4);

    // A new deny with a command that never passed: sure-fail only.
    appendFileSync(file, JSON.stringify({ at: new Date(t0).toISOString(), restSha: shaOf("cargo build") }) + "\n");
    const more: any[] = [];
    guardrailCounts(st, ctx, more);
    assert.deepEqual(more, [["guardrail", { class: "no-timeout", outcome: "sure-fail" }]]);
    assert.equal(st.deniedSeen, 5);
  });

  test("no denied file leaves the state alone", () => {
    const env = envFor("guard-none");
    const ctx = { env, sessionHash: "x", sessionId: "sess-none", host: "claude", checkout: root, repoKey: "r", now: new Date() } as any;
    const st = { epoch: 1, deniedSeen: 2, runs: [] } as any;
    const sent: any[] = [];
    guardrailCounts(st, ctx, sent);
    assert.deepEqual(sent, []);
    assert.equal(st.deniedSeen, 2);
  });
});
