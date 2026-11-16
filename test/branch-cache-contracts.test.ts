/**
 * The branch cache's remote-ref stamp follows every form of `.git` pointer Git
 * writes: a relative or absolute `gitdir:` and a relative or absolute `commondir`.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { branchesStale, refsStamp } from "../src/notes/branches.js";
import { cacheDir } from "../src/util/state.js";
import { linkWorktree, tmpRepo } from "./helpers.js";

let oldGraftDir: string | undefined;
beforeEach(() => {
  oldGraftDir = process.env.GRAFT_DIR;
  delete process.env.GRAFT_DIR;
});
afterEach(() => {
  if (oldGraftDir === undefined) delete process.env.GRAFT_DIR;
  else process.env.GRAFT_DIR = oldGraftDir;
});

const BEFORE = new Date(2020, 9, 7, 12);
const AFTER = new Date(2020, 9, 8, 12);

function remoteRef(gitDir: string): string {
  const remotes = join(gitDir, "refs", "remotes");
  const origin = join(remotes, "origin");
  mkdirSync(origin, { recursive: true });
  const ref = join(origin, "main");
  writeFileSync(ref, "1111111111111111111111111111111111111111\n");
  for (const path of [ref, origin, remotes]) utimesSync(path, BEFORE, BEFORE);
  return ref;
}

function ownCache(repo: string): string {
  const dir = cacheDir(repo);
  assert.equal(relative(repo, dir).split(/[\\/]/)[0], "graft", "cache stays in the owned fixture");
  return dir;
}

test("relative gitdir worktree detects shared remote-ref movement before cache expiry", (t) => {
  const root = tmpRepo("branch-relative");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, "main");
  const linked = join(root, "linked");
  const ref = remoteRef(join(main, ".git"));
  linkWorktree(main, linked);
  const gitDir = join(main, ".git", "worktrees", "linked");
  writeFileSync(join(linked, ".git"), "gitdir: " + relative(linked, gitDir) + "\n");
  const before = refsStamp(main);
  assert.equal(before, String(BEFORE.getTime()));
  assert.equal(refsStamp(linked), before, "relative gitdir resolves from the linked checkout");
  const now = AFTER.getTime();
  mkdirSync(ownCache(linked), { recursive: true });
  writeFileSync(join(ownCache(linked), "trail-branches.json"), JSON.stringify({
    fetchedAt: now, stamp: before, base: null, branches: [],
  }));
  assert.equal(branchesStale(linked, now, 60_000), false);
  writeFileSync(ref, "2222222222222222222222222222222222222222\n");
  utimesSync(ref, AFTER, AFTER);
  assert.equal(refsStamp(linked), String(AFTER.getTime()));
  assert.equal(refsStamp(linked), refsStamp(main));
  assert.equal(branchesStale(linked, now, 60_000), true, "a push invalidates even a young cache");
});

test("absolute commondir worktree reads refs from the shared Git directory", (t) => {
  const root = tmpRepo("branch-absolute");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, "main");
  const linked = join(root, "linked");
  remoteRef(join(main, ".git"));
  linkWorktree(main, linked);
  writeFileSync(join(main, ".git", "worktrees", "linked", "commondir"), join(main, ".git") + "\n");
  assert.equal(refsStamp(linked), String(BEFORE.getTime()));
  assert.equal(refsStamp(linked), refsStamp(main));
});

test("Git directory pointers without commondir support relative and absolute module paths", (t) => {
  const root = tmpRepo("branch-module");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const absolute of [false, true]) {
    const repo = join(root, absolute ? "absolute" : "relative");
    const gitDir = join(root, "metadata", absolute ? "absolute" : "relative");
    mkdirSync(repo);
    remoteRef(gitDir);
    const pointer = absolute ? gitDir : relative(repo, gitDir);
    writeFileSync(join(repo, ".git"), "gitdir: " + pointer + "\n");
    assert.equal(refsStamp(repo), String(BEFORE.getTime()), pointer);
  }
});
