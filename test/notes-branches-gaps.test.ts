import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

let branches: typeof import("../src/notes/branches.js");
let cacheDir: typeof import("../src/util/state.js").cacheDir;
const execGit = childProcess.execFileSync;
const scratch: string[] = [];
const savedEnv = new Map<string, string | undefined>();
const ghCalls: Array<{ args: string[]; timeout?: number; promptDisabled?: string }> = [];
let ghReply = { stdout: "", status: 1 };

function temp(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `notes-branches-${tag}-`));
  scratch.push(dir);
  return realpathSync(dir);
}

function setEnv(key: string, value: string | undefined): void {
  savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

before(async () => {
  setEnv("GRAFT_DIR", undefined);
  setEnv("TRAIL_NO_FETCH", undefined);
  setEnv("GIT_ALLOW_PROTOCOL", "file");

  // Let executable lookup find a fixture rather than a real GitHub CLI. The
  // subprocess mock below substitutes Node for it, without a shell shim.
  const bin = temp("bin");
  for (const name of ["gh", "gh.exe"]) {
    writeFileSync(join(bin, name), "", { mode: 0o755 });
  }
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  setEnv(pathKey, [bin, process.env[pathKey]].filter(Boolean).join(delimiter));

  for (const method of ["execFileSync", "spawnSync"] as const) {
    const original = childProcess[method];
    mock.method(childProcess, method, (file: string, ...rest: unknown[]) => {
      if (!/^gh(?:\.exe)?$/i.test(basename(file))) {
        return Reflect.apply(original, childProcess, [file, ...rest]);
      }
      const [args, options] = rest as [
        string[],
        { timeout?: number; env?: NodeJS.ProcessEnv },
      ];
      ghCalls.push({
        args,
        timeout: options?.timeout,
        promptDisabled: options?.env?.GH_PROMPT_DISABLED,
      });
      return Reflect.apply(original, childProcess, [
        process.execPath,
        [
          "-e",
          "process.stdout.write(process.argv[1]); process.exitCode = Number(process.argv[2]);",
          "--",
          ghReply.stdout,
          String(ghReply.status),
        ],
        options,
      ]);
    });
  }
  syncBuiltinESMExports();
  branches = await import("../src/notes/branches.js");
  ({ cacheDir } = await import("../src/util/state.js"));
});

after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  return execGit("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function writeCache(repo: string, value: unknown): void {
  const dir = cacheDir(repo);
  const local = relative(repo, dir);
  assert.ok(!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "trail-branches.json"), JSON.stringify(value));
}

function fakeGh(stdout: string, status = 0): void {
  ghCalls.length = 0;
  ghReply = { stdout, status };
}

const topics = ["abandoned", "done", "reopened", "updated"];

function pushedRepo(github: boolean) {
  const root = temp("pushed");
  const repo = join(root, "checkout");
  // A file URL containing github.com/ exercises the GitHub-origin check while
  // Git fetches exclusively from a local bare repository.
  const remote = join(root, github ? "github.com" : "local", "origin.git");
  mkdirSync(repo);
  mkdirSync(remote, { recursive: true });
  git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.name", "Ada Lovelace");
  git(repo, "config", "user.email", "ada@example.invalid");
  writeFileSync(join(repo, "shared.txt"), "base\n");
  git(repo, "add", "shared.txt");
  git(repo, "commit", "--quiet", "--no-gpg-sign", "-m", "Base");
  const baseOid = git(repo, "rev-parse", "HEAD");

  git(repo, "checkout", "--quiet", "-b", "work");
  writeFileSync(join(repo, "shared.txt"), "topic change\n");
  git(repo, "commit", "--quiet", "--no-gpg-sign", "-am", "Change shared file");
  const tip = git(repo, "rev-parse", "HEAD");
  for (const name of topics) git(repo, "branch", name, tip);
  git(repo, "remote", "add", "origin", pathToFileURL(remote).href);
  git(repo, "push", "--quiet", "origin", "main", ...topics);
  return { repo, tip, baseOid };
}

function refs(cache: { branches: Array<{ ref: string }> }): string[] {
  return cache.branches.map(({ ref }) => ref).sort();
}

describe("branch cache on disk", () => {
  test("rejects a non-object cache and sanitizes edited branch entries", () => {
    const repo = temp("edited");
    writeCache(repo, "not a cache object");
    assert.equal(branches.readBranchCache(repo), null);

    const valid = { ref: "origin/topic", author: "Ada", at: 1234, files: [], learnings: [] };
    const files = Array.from({ length: 205 }, (_, i) => `file-${i}.txt`);
    const learnings = Array.from({ length: 22 }, (_, i) => ({
      name: `note-${i}.md`,
      text: `Learning ${i}`,
    }));
    writeCache(repo, {
      fetchedAt: "yesterday",
      base: 42,
      branches: [
        null,
        "a branch",
        { ...valid, ref: 17 },
        { ...valid, ref: "origin/not a ref" },
        { ...valid, at: "1234" },
        { ...valid, files: {} },
        { ...valid, learnings: null },
        {
          ...valid,
          author: "ada lovelace",
          files: [false, ...files],
          learnings: [
            null,
            { text: "Missing a name" },
            { name: "../outside.md", text: "Not a learning name" },
            { name: "number.md", text: 27 },
            { name: "oversize.md", text: "x".repeat(64 * 1024 + 1) },
            ...learnings,
          ],
        },
        { ...valid, ref: "origin/review" },
      ],
    });

    const cache = branches.readBranchCache(repo);
    assert.ok(cache);
    assert.equal(cache.fetchedAt, 0);
    assert.equal(cache.base, null);
    assert.deepEqual(refs(cache), ["origin/review", "origin/topic"]);
    const topic = cache.branches.find((branch) => branch.ref === "origin/topic");
    assert.ok(topic);
    assert.equal(topic.author, "");
    assert.equal(topic.at, 1234);
    assert.deepEqual(topic.files.slice(0, 2), files.slice(0, 2));
    assert.equal(topic.files.length, 200);
    assert.equal(topic.files.at(-1), files[199]);
    assert.equal(topic.learnings.length, 20);
    assert.deepEqual(topic.learnings[0], learnings[0]);
    assert.deepEqual(topic.learnings.at(-1), learnings[19]);
    assert.equal(cache.branches.find((branch) => branch.ref === "origin/review")?.author, "Ada");
  });

  test("a checkout without origin gets a fresh empty cache without calling gh", () => {
    const repo = temp("no-origin");
    git(repo, "init", "--quiet", "--initial-branch=main");
    fakeGh("[]");
    assert.equal(branches.readBranchCache(repo), null);
    assert.equal(branches.branchesStale(repo), true);

    const result = branches.refreshBranches(repo, { prs: true });
    assert.equal(ghCalls.length, 0);
    assert.equal(result.base, null);
    assert.deepEqual(result.branches, []);
    assert.deepEqual(result.closed, {});
    const disk = branches.readBranchCache(repo);
    assert.ok(disk);
    assert.equal(disk.fetchedAt, result.fetchedAt);
    assert.equal(disk.stamp, branches.refsStamp(repo));
    assert.equal(branches.branchesStale(repo, result.fetchedAt), false);
  });
});

describe("pull request information during a branch refresh", () => {
  test("uses the latest closed head, but preserves reopened branches and newer pushes", () => {
    const { repo, tip, baseOid } = pushedRepo(true);
    fakeGh(JSON.stringify([
      { headRefName: "done", headRefOid: tip, state: "MERGED" },
      { headRefName: "done", headRefOid: baseOid, state: "CLOSED" },
      { headRefName: "abandoned", headRefOid: tip, state: "CLOSED" },
      { headRefName: "reopened", headRefOid: tip, state: "CLOSED" },
      { headRefName: "reopened", headRefOid: baseOid, state: "OPEN" },
      { headRefName: "updated", headRefOid: baseOid, state: "CLOSED" },
      { headRefName: "missing-oid", state: "CLOSED" },
      { headRefOid: tip, state: "MERGED" },
      { headRefName: "missing-state", headRefOid: tip },
    ]));

    const result = branches.refreshBranches(repo, { prs: true });
    assert.equal(ghCalls.length, 1);
    assert.deepEqual(ghCalls[0], {
      args: ["pr", "list", "--state", "all", "--limit", "200", "--json", "headRefName,headRefOid,state"],
      timeout: 10_000,
      promptDisabled: "1",
    });
    assert.equal(result.base, "origin/main");
    assert.deepEqual(result.closed, { done: tip, abandoned: tip, updated: baseOid });
    assert.deepEqual(refs(result), ["origin/reopened", "origin/updated"]);
    const disk = branches.readBranchCache(repo);
    assert.ok(disk);
    assert.deepEqual(disk.closed, result.closed);
    assert.deepEqual(refs(disk), refs(result));
    assert.deepEqual(disk.branches.find((branch) => branch.ref === "origin/reopened")?.files, ["shared.txt"]);
  });

  test("retains cached closed heads when gh fails or returns malformed JSON", () => {
    const { repo, tip } = pushedRepo(true);
    const closed = { done: tip };
    branches.refreshBranches(repo, { fetch: false, closed });

    for (const { stdout, status } of [
      {
        stdout: JSON.stringify([{ headRefName: "reopened", headRefOid: tip, state: "CLOSED" }]),
        status: 1,
      },
      { stdout: "not JSON", status: 0 },
    ]) {
      fakeGh(stdout, status);
      const result = branches.refreshBranches(repo, { prs: true });
      assert.equal(ghCalls.length, 1);
      assert.deepEqual(result.closed, closed);
      assert.deepEqual(refs(result), ["origin/abandoned", "origin/reopened", "origin/updated"]);
      assert.deepEqual(branches.readBranchCache(repo)?.closed, closed);
    }
  });

  test("a non-GitHub remote refreshes its branches without asking gh", () => {
    const { repo, tip } = pushedRepo(false);
    fakeGh(JSON.stringify([{ headRefName: "done", headRefOid: tip, state: "CLOSED" }]));

    const result = branches.refreshBranches(repo, { prs: true });
    assert.equal(ghCalls.length, 0);
    assert.equal(result.base, "origin/main");
    assert.deepEqual(result.closed, {});
    assert.deepEqual(refs(result), topics.map((name) => `origin/${name}`));
  });
});
