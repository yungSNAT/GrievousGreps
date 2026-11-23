/**
 * Gap tests for src/skills/anchors-git.ts: scp-style remote URLs, remotes that match nothing, a packed-refs file too big
 * to read, a missing packed-refs, loose refs found directly, refOid under reftable and on loose or packed refs.
 * Every git folder here is a small synthetic one written by hand. No git process is run and no network is used.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gitOf, refOid, branchGone, repoBranches, branchTest, readSmall, type Git } from "../src/skills/anchors-git.js";
import type { Anchor } from "../src/skills/anchors.js";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const OID_C = "c".repeat(40);

const CONFIG = [
  "[core]",
  "\tbare = false",
  '[remote "origin"]',
  "\turl = https://github.com/acme/shop.git",
  "\tfetch = +refs/heads/*:refs/remotes/origin/*",
  '[branch "main"]',
  "\tremote = origin",
  "",
].join("\n");

/** A checkout whose .git folder holds exactly these files (paths relative to .git, with `/`). */
function fakeRepo(tag: string, files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), `anchors-git-${tag}-`));
  roots.push(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, ".git", ...rel.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

const anchor = (a: Record<string, unknown>) => a as unknown as Anchor;
const mustGit = (dir: string): Git => {
  const g = gitOf(dir);
  assert.ok(g, `git folder found for ${dir}`);
  return g;
};

describe("branchGone for a remote anchor: remote names and URLs", () => {
  const dir = fakeRepo("remote", {
    config: CONFIG,
    "refs/heads/main": `${OID_A}\n`,
    "refs/remotes/origin/main": `${OID_A}\n`,
    "refs/remotes/origin/HEAD": "ref: refs/remotes/origin/main\n",
  });

  test("an scp-style URL for the same repo resolves to the configured remote", () => {
    const git = mustGit(dir);
    assert.equal(git.remotes.get("origin"), "https://github.com/acme/shop.git");
    assert.deepEqual(branchGone(git, anchor({ via: "remote", name: "main", remote: "git@github.com:acme/shop.git" })), { gone: false, remote: "origin" });
    assert.deepEqual(branchGone(mustGit(dir), anchor({ via: "remote", name: "feature-x", remote: "git@GitHub.com:acme/shop" })), { gone: true, remote: "origin" });
  });

  test("an ssh:// URL with a port for the same repo also resolves", () => {
    assert.deepEqual(branchGone(mustGit(dir), anchor({ via: "remote", name: "main", remote: "ssh://git@github.com:22/acme/shop.git/" })), { gone: false, remote: "origin" });
  });

  test("a URL for some other repo matches no remote: not known", () => {
    assert.equal(branchGone(mustGit(dir), anchor({ via: "remote", name: "main", remote: "https://gitlab.com/other/repo.git" })), null);
    assert.equal(branchGone(mustGit(dir), anchor({ via: "remote", name: "main", remote: "git@gitlab.com:other/repo.git" })), null);
  });

  test("a bare name that is neither a remote nor a URL: not known", () => {
    assert.equal(branchGone(mustGit(dir), anchor({ via: "remote", name: "main", remote: "upstream" })), null);
    assert.equal(branchGone(mustGit(dir), anchor({ via: "remote", name: "main" })), null, "no remote at all");
  });

  test("a remote with only a HEAD ref was never fetched: not known", () => {
    const d = fakeRepo("headonly", {
      config: CONFIG + '[remote "fork"]\n\turl = https://github.com/me/shop.git\n',
      "refs/remotes/fork/HEAD": "ref: refs/remotes/fork/main\n",
      "packed-refs": `# pack-refs with: peeled\n${OID_A} refs/remotes/fork/HEAD\n`,
    });
    assert.equal(branchGone(mustGit(d), anchor({ via: "remote", name: "main", remote: "fork" })), null);
  });

  test("a remote known only through packed refs", () => {
    const d = fakeRepo("packedremote", {
      config: CONFIG,
      "packed-refs": `# pack-refs with: peeled\n${OID_A} refs/remotes/origin/main\n`,
    });
    assert.deepEqual(branchGone(mustGit(d), anchor({ via: "remote", name: "main", remote: "origin" })), { gone: false, remote: "origin" });
    assert.deepEqual(branchGone(mustGit(d), anchor({ via: "remote", name: "dev", remote: "origin" })), { gone: true, remote: "origin" });
  });
});

describe("branchGone for a checkout anchor", () => {
  test("a loose local branch is found without reading packed-refs", () => {
    const dir = fakeRepo("loose", { config: CONFIG, "refs/heads/feature/one": `${OID_A}\n` });
    const git = mustGit(dir);
    assert.deepEqual(branchGone(git, anchor({ via: "checkout", name: "feature/one" })), { gone: false });
    assert.equal(git.packed, undefined, "packed-refs was not needed");
  });

  test("no local branch and no packed-refs: gone unless a remote has it", () => {
    const dir = fakeRepo("nopacked", { config: CONFIG, "refs/remotes/mirror/dev": `${OID_A}\n` });
    assert.deepEqual(branchGone(mustGit(dir), anchor({ via: "checkout", name: "dev" })), { gone: false }, "the mirror remote has dev");
    const git = mustGit(dir);
    assert.deepEqual(branchGone(git, anchor({ via: "checkout", name: "missing" })), { gone: true });
    assert.equal(git.packed, "", "no packed-refs file reads as empty");
  });

  test("a packed-refs file too big to read: not known", () => {
    const big = `# pack-refs with: peeled\n${"x".repeat(4 * 1024 * 1024 + 16)}\n`;
    const dir = fakeRepo("bigpacked", { config: CONFIG, "refs/heads/main": `${OID_A}\n`, "packed-refs": big });
    const git = mustGit(dir);
    assert.equal(branchGone(git, anchor({ via: "checkout", name: "nope" })), null);
    assert.equal(git.packed, null);
    assert.equal(refOid(mustGit(dir), "refs/heads/nope"), null);
    assert.equal(refOid(mustGit(dir), "refs/heads/main"), OID_A, "loose refs still read");
    assert.deepEqual([...repoBranches(dir)], ["main"], "only the loose branch is listed");
  });

  test("reftable: nothing can be said", () => {
    const dir = fakeRepo("reftable", { config: CONFIG, "reftable/tables.list": "" });
    const git = mustGit(dir);
    assert.equal(git.reftable, true);
    assert.equal(branchGone(git, anchor({ via: "checkout", name: "main" })), null);
    assert.equal(repoBranches(dir).size, 0);
  });
});

describe("refOid", () => {
  test("reftable returns null even when a loose file is there", () => {
    const dir = fakeRepo("refoid-rt", { "refs/heads/main": `${OID_A}\n` });
    const git: Git = { common: join(dir, ".git"), remotes: new Map(), packed: undefined, reftable: true, sparse: false };
    assert.equal(refOid(git, "refs/heads/main"), null);
    assert.equal(refOid({ ...git, reftable: false, packed: undefined }, "refs/heads/main"), OID_A);
  });

  test("loose, symbolic, packed with CRLF, and missing refs", () => {
    const dir = fakeRepo("refoid", {
      config: CONFIG,
      "refs/heads/main": `${OID_A}\n`,
      "refs/heads/sym": "ref: refs/heads/main\n",
      "packed-refs": `# pack-refs with: peeled\r\n${OID_B} refs/heads/release/1.0\r\n${OID_C} refs/tags/v1.0\r\n`,
    });
    assert.equal(refOid(mustGit(dir), "refs/heads/main"), OID_A);
    assert.equal(refOid(mustGit(dir), "refs/heads/sym"), null, "a symbolic loose ref has no object id");
    assert.equal(refOid(mustGit(dir), "refs/heads/release/1.0"), OID_B);
    assert.equal(refOid(mustGit(dir), "refs/tags/v1.0"), OID_C, "second read hits the memo");
    assert.equal(refOid(mustGit(dir), "refs/heads/release/1x0"), null, "the dot is matched literally");
    assert.equal(refOid(mustGit(dir), "refs/heads/gone"), null);
  });

  test("no packed-refs and no loose ref", () => {
    const dir = fakeRepo("refoid-none", { config: CONFIG });
    const git = mustGit(dir);
    assert.equal(refOid(git, "refs/heads/main"), null);
    assert.equal(git.packed, "");
  });
});

describe("gitOf and friends", () => {
  test("a worktree's .git file leads through gitdir and commondir to the common folder", () => {
    const main = fakeRepo("wt-main", {
      config: CONFIG,
      "refs/heads/main": `${OID_A}\n`,
      "worktrees/wt/commondir": "../..\n",
      "worktrees/wt/info/sparse-checkout": "/src/\n",
    });
    const wt = mkdtempSync(join(tmpdir(), "anchors-git-wt-"));
    roots.push(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
    mkdirSync(join(wt, "src", "deep"), { recursive: true });
    const git = mustGit(join(wt, "src", "deep"));
    assert.equal(git.common, resolve(main, ".git"));
    assert.equal(git.sparse, true);
    assert.equal(git.remotes.get("origin"), "https://github.com/acme/shop.git");
    assert.ok(repoBranches(wt).has("main"));
  });

  test("empty checkout, readSmall limits, and branchTest", () => {
    assert.equal(gitOf(""), null);
    const dir = fakeRepo("small", { config: CONFIG, "refs/heads/dev": `${OID_A}\n` });
    assert.equal(readSmall(join(dir, ".git", "config"), 10), null, "over the limit");
    assert.equal(readSmall(join(dir, ".git")), null, "a folder");
    assert.equal(readSmall(join(dir, "nope")), null, "missing");
    const has = branchTest(dir);
    assert.equal(has("dev"), true);
    assert.equal(has("prod"), false);
    assert.equal(branchTest("")("dev"), false);
  });
});
