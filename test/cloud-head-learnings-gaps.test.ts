/**
 * headLearnings reads what HEAD has in .trail/learnings/ through git, never the
 * working tree. These tests cover the cases the main suites don't reach: no
 * repo, no commit, entries that aren't learnings (links, submodules, subfolders,
 * other files, executables), a checkout opened from a subfolder, and a damaged
 * object store.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { headLearnings } from "../src/cloud/head-learnings.js";
import { LEARNINGS_DIR } from "../src/notes/repo-trail.js";
import { tmpRepo } from "./helpers.js";

const made: string[] = [];
function scratch(tag: string): string {
  const d = tmpRepo(tag);
  made.push(d);
  return d;
}

after(() => {
  for (const d of made) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function git(cwd: string, args: string[], input?: string): string {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", input });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function initRepo(d: string): void {
  git(d, ["init", "-q", "-b", "main"]);
  git(d, ["config", "user.name", "Priya Raman"]);
  git(d, ["config", "user.email", "priya@acme.test"]);
  git(d, ["config", "core.autocrlf", "false"]);
}

/** Learnings dir as a git path (always forward slashes). */
const gitPath = (name: string) => `${LEARNINGS_DIR}/${name}`;
const fsDir = (d: string) => join(d, ...LEARNINGS_DIR.split("/"));

const learning = (title: string, body: string) => `---\ntitle: ${title}\nauthor: Priya\ndate: 2026-10-07\ntouches: []\n---\n${body}\n`;

describe("headLearnings when git can't say", () => {
  test("a folder that isn't a git repo gives null, not an empty set", () => {
    const d = scratch("head-learnings-nogit");
    mkdirSync(fsDir(d), { recursive: true });
    writeFileSync(join(fsDir(d), "a.md"), learning("A", "## Decided\nx"));
    assert.equal(headLearnings(d), null);
  });

  test("a repo with no commit yet gives null", () => {
    const d = scratch("head-learnings-nocommit");
    initRepo(d);
    mkdirSync(fsDir(d), { recursive: true });
    writeFileSync(join(fsDir(d), "a.md"), learning("A", "## Decided\nx"));
    git(d, ["add", "-A"]);
    assert.equal(headLearnings(d), null);
  });

  test("a learning HEAD lists but whose object is gone gives null: HEAD wasn't read", () => {
    const d = scratch("head-learnings-damaged");
    initRepo(d);
    mkdirSync(fsDir(d), { recursive: true });
    writeFileSync(join(fsDir(d), "a.md"), learning("Kept", "## Decided\nkept body"));
    writeFileSync(join(fsDir(d), "b.md"), learning("Lost", "## Decided\nlost body"));
    git(d, ["add", "-A"]);
    git(d, ["commit", "-qm", "learnings"]);
    // Before the damage both are read.
    const before = headLearnings(d);
    assert.deepEqual(before?.map((l) => l.name), ["a.md", "b.md"]);

    const oid = git(d, ["rev-parse", `HEAD:${gitPath("b.md")}`]).trim();
    const objectFile = join(d, ".git", "objects", oid.slice(0, 2), oid.slice(2));
    chmodSync(objectFile, 0o644);
    rmSync(objectFile, { force: true });
    assert.equal(headLearnings(d), null);
  });
});

describe("headLearnings reading HEAD", () => {
  test("a commit without the learnings folder gives an empty set", () => {
    const d = scratch("head-learnings-none");
    initRepo(d);
    writeFileSync(join(d, "README.md"), "# readme\n");
    git(d, ["add", "-A"]);
    git(d, ["commit", "-qm", "init"]);
    assert.deepEqual(headLearnings(d), []);
  });

  test("a learnings folder holding no .md files gives an empty set", () => {
    const d = scratch("head-learnings-txt-only");
    initRepo(d);
    mkdirSync(fsDir(d), { recursive: true });
    writeFileSync(join(fsDir(d), "notes.txt"), "not a learning\n");
    git(d, ["add", "-A"]);
    git(d, ["commit", "-qm", "init"]);
    assert.deepEqual(headLearnings(d), []);
  });

  test("only regular .md files directly in the folder are learnings, with their committed text", () => {
    const d = scratch("head-learnings-mixed");
    initRepo(d);
    const dir = fsDir(d);
    mkdirSync(join(dir, "sub"), { recursive: true });
    mkdirSync(join(d, "src"), { recursive: true });
    const aText = learning("Rotated PDFs", "## Decided\nRotate each box — café ✓ before scaling.");
    const bText = learning("Exec bit", "## Decided\nStill a learning.");
    writeFileSync(join(dir, "a.md"), aText);
    writeFileSync(join(dir, "b.md"), bText);
    writeFileSync(join(dir, "empty.md"), "");
    writeFileSync(join(dir, "notes.txt"), "not markdown\n");
    writeFileSync(join(dir, "sub", "c.md"), learning("Nested", "## Decided\nnested"));
    writeFileSync(join(d, "src", "main.go"), "package main\n");
    writeFileSync(join(d, "README.md"), "# readme\n");
    git(d, ["add", "-A"]);
    git(d, ["commit", "-qm", "base"]);
    const baseCommit = git(d, ["rev-parse", "HEAD"]).trim();

    // An executable learning (100755), a committed link (120000) and a submodule (160000).
    git(d, ["update-index", "--chmod=+x", gitPath("b.md")]);
    const linkTarget = git(d, ["hash-object", "-w", "--stdin"], "/somewhere/outside/mine.md").trim();
    git(d, ["update-index", "--add", "--cacheinfo", `120000,${linkTarget},${gitPath("link.md")}`]);
    git(d, ["update-index", "--add", "--cacheinfo", `160000,${baseCommit},${gitPath("mod.md")}`]);
    git(d, ["commit", "-qm", "more"]);

    // A working-tree edit and an untracked file after the commit stay local.
    writeFileSync(join(dir, "a.md"), learning("Rotated PDFs", "## Decided\nDraft: ask Globexsynthetic."));
    writeFileSync(join(dir, "untracked.md"), learning("Never added", "## Decided\nuntracked"));

    const got = headLearnings(d);
    assert.ok(got, "HEAD was read");
    assert.deepEqual(got.map((l) => l.name), ["a.md", "b.md", "empty.md"]);
    assert.equal(got[0]!.text, aText, "the committed text with multibyte characters intact");
    assert.equal(got[1]!.text, bText);
    assert.equal(got[2]!.text, "");
    for (const l of got) assert.ok(!l.text.includes("Globexsynthetic"));

    // Opened from a subfolder, paths still come from the top of the tree.
    assert.deepEqual(headLearnings(join(d, "src")), got);
  });
});
