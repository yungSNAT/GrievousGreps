import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import {
  discoverSessions, repoRoots, sameRepoRoots, sessionFiles,
} from "../src/init/sessions.js";
import { claudeProjectDir } from "../src/notes/session-cost.js";

const started = Date.parse("2025-06-07T12:00:00.000Z");
const now = new Date("2025-06-08T12:00:00.000Z");
const origin = "https://github.com/example/session-fixture.git";
let scratch: string;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "init-sessions-gaps-"));
  scratch = realpathSync(scratch);
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Session discovery must not use the network");
  });
});

after(() => {
  mock.restoreAll();
  if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
});

function directory(...parts: string[]): string {
  const path = join(...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function git(dir: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.error ?? result.stderr}`);
}

function checkout(parent: string, name: string, remote?: string): string {
  const dir = directory(parent, name);
  git(dir, "init", "--quiet");
  if (remote) git(dir, "remote", "add", "origin", remote);
  return dir;
}

function canonicalRoots(paths: string[]): Set<string> {
  // Git may report Windows paths with forward slashes.
  return new Set(paths.map((path) => realpathSync(path)));
}

function projects(home: string): string {
  return join(home, ".claude", "projects");
}

function prompt(content: string) {
  return { type: "user", message: { role: "user", content } };
}

function readCall(file_path: string) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      id: `msg_${randomUUID()}`,
      content: [{ type: "tool_use", id: `toolu_${randomUUID()}`, name: "Read", input: { file_path } }],
    },
  };
}

function transcript(
  home: string,
  folder: string,
  id: string,
  cwd: string | undefined,
  events: Array<ReturnType<typeof prompt> | ReturnType<typeof readCall>> = [
    prompt("Please inspect the build configuration."),
  ],
) {
  const path = join(directory(projects(home), folder), `${id}.jsonl`);
  let parentUuid: string | null = null;
  const lines = events.map((event, i) => {
    const uuid = randomUUID();
    const line = JSON.stringify({
      ...event, uuid, parentUuid, cwd, sessionId: id, entrypoint: "cli",
      isSidechain: false, timestamp: new Date(started + i * 1000).toISOString(),
    }) + "\n";
    parentUuid = uuid;
    return line;
  });
  writeFileSync(path, lines.join(""));
  utimesSync(path, new Date(started), new Date(started));
  return {
    path,
    offset: (line: number) => Buffer.byteLength(lines.slice(0, line).join("")),
  };
}

describe("checkout roots", () => {
  test("a linked worktree finds both itself and the main checkout", () => {
    const root = directory(scratch, "worktrees");
    const main = checkout(root, "main");
    git(main, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Initial commit");
    const linked = join(root, "linked");
    git(main, "worktree", "add", "--quiet", "--detach", linked, "HEAD");

    const expected = canonicalRoots([main, linked]);
    assert.deepEqual(canonicalRoots(repoRoots(main)), expected);
    assert.deepEqual(canonicalRoots(repoRoots(linked)), expected);
  });

  test("a configured remote still yields the checkout when Claude has no projects directory", () => {
    const root = directory(scratch, "no-projects");
    const repo = checkout(root, "repo", origin);
    const home = directory(root, "home");

    assert.deepEqual(canonicalRoots(sameRepoRoots(repo, home)), canonicalRoots([repo]));
  });

  test("finds another checkout of the same remote through the default home", () => {
    const root = directory(scratch, "same-remote");
    const repo = checkout(root, "repo", origin);
    const clone = checkout(root, "other-copy", origin);
    const unrelated = checkout(root, "unrelated", "https://github.com/example/unrelated.git");
    const home = directory(root, "home");
    writeFileSync(join(directory(projects(home)), "project-index"), "{}");
    writeFileSync(join(directory(projects(home), "memory-only", "memory"), "MEMORY.md"), "# Notes\n");
    transcript(home, "missing-cwd", "no-cwd", undefined);
    transcript(home, "old-location", "removed", join(root, "removed-checkout"));
    transcript(home, "unrelated-project", "unrelated", unrelated);
    const subdir = directory(clone, "src");
    transcript(home, "other-copy-src", "other-copy", subdir);
    transcript(home, "older-folder-name", "same-cwd", subdir);

    const previousHome = process.env.HOME;
    const previousProfile = process.env.USERPROFILE;
    try {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      assert.deepEqual(canonicalRoots(sameRepoRoots(repo)), canonicalRoots([repo, clone]));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
    }
  });
});

test("sessionFiles verifies each transcript's cwd rather than trusting a matching folder name", () => {
  const root = directory(scratch, "session-files");
  const home = directory(root, "home");
  const repo = directory(root, "repo");
  const child = directory(repo, "src");
  const sibling = directory(root, "repo-old");
  const folder = basename(claudeProjectDir(repo, home));
  const own = transcript(home, folder, "own", repo).path;
  const nested = transcript(home, `${folder}-src`, "nested", child).path;
  transcript(home, `${folder}-old`, "sibling", sibling);
  transcript(home, folder, "no-cwd", undefined);
  transcript(home, "unrelated-folder-name", "misfiled", repo);
  directory(projects(home), folder, "not-a-file.jsonl");

  assert.deepEqual(sessionFiles([repo], home).sort(), [own, nested].sort());
});

test("discovery excludes a scratchpad inside a checkout but keeps sessions of a scratchpad checkout", () => {
  const root = directory(scratch, "scratch-sessions");
  const home = directory(root, "home");
  const repo = checkout(root, "repo");
  const scratchCheckout = checkout(directory(root, "scratchpad"), "experiment");
  const scratchSession = transcript(home, "repo-pad", "temporary", directory(repo, "scratchpad"));
  transcript(home, "repo-notes", "notes", directory(repo, "scratchpad-notes"));
  transcript(home, "experiment", "experiment", scratchCheckout);

  const regular = discoverSessions(repo, home, now);
  assert.deepEqual(regular.sessions.map(({ id, source }) => [id, source]), [["notes", "own"]]);
  assert.deepEqual(regular.skipped, [{ path: scratchSession.path, why: "scratch" }]);

  const experiment = discoverSessions(scratchCheckout, home, now);
  assert.deepEqual(experiment.sessions.map(({ id, source }) => [id, source]), [["experiment", "own"]]);
  assert.deepEqual(experiment.skipped, []);
});

test("an ancestor session at exactly 30% is kept only for its repo stretch", () => {
  const root = directory(scratch, "ancestor-sessions");
  const home = directory(root, "home");
  const workspace = directory(root, "workspace");
  const repo = checkout(workspace, "repo");
  const sibling = directory(workspace, "repo-old");

  function ancestorSession(id: string, hits: number) {
    const call = (i: number) => {
      const inRepo = i >= 1 && i <= hits;
      const file = `settings-${i}.json`;
      return readCall(inRepo ? relative(workspace, join(repo, file)) : join(sibling, file));
    };
    return transcript(home, "workspace", id, workspace, [
      prompt("Please inspect the archived configuration first."),
      call(0),
      prompt("Now check the current repository's release settings."),
      call(1), call(2), call(3),
      prompt("Go back to the archived configuration."),
      ...Array.from({ length: 6 }, (_, i) => call(i + 4)),
    ]);
  }

  const atThreshold = ancestorSession("at-threshold", 3);
  const belowThreshold = ancestorSession("below-threshold", 2);
  const found = discoverSessions(repo, home, now);

  assert.deepEqual(found.sessions.map(({ id, source }) => [id, source]), [["at-threshold", "ancestor"]]);
  const kept = found.sessions[0]!;
  assert.deepEqual(kept.stretch, { from: atThreshold.offset(2), to: atThreshold.offset(6) });
  assert.equal(kept.prompts.length, 1);
  assert.equal(found.bySource.ancestor, 1);
  assert.equal(found.skippedAncestor, 1);
  assert.deepEqual(found.skipped, [{ path: belowThreshold.path, why: "ancestor-under-30" }]);
});
