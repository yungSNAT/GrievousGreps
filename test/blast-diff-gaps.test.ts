import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changedFiles, refExists } from "../src/blast/diff.js";
import { tmpRepo } from "./helpers.js";

const repos: string[] = [];

after(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
    { cwd: dir, encoding: "utf8", windowsHide: true },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function initRepo(tag: string): string {
  const dir = tmpRepo(`blast-diff-${tag}`);
  repos.push(dir);
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "Diff Test");
  git(dir, "config", "user.email", "diff-test@example.com");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "config", "diff.interHunkContext", "0");
  return dir;
}

function commit(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-m", message);
}

function fileNamed(result: ReturnType<typeof changedFiles>, name: string) {
  assert.ok(result, "expected a diff result");
  const file = result.files.find(({ path }) => path === name);
  assert.ok(file, `expected ${name} in the diff`);
  return file;
}

describe("explicit base refs", () => {
  let dir: string;

  before(() => {
    dir = initRepo("refs");
    writeFileSync(join(dir, "value.ts"), "export const value = 1;\n");
    commit(dir, "common ancestor");
    git(dir, "tag", "-a", "fork-point", "-m", "Common ancestor");
    git(dir, "tag", "blob-only", git(dir, "rev-parse", "HEAD:value.ts"));

    git(dir, "checkout", "-b", "feature");
    writeFileSync(join(dir, "value.ts"), "export const value = 2;\n");
    commit(dir, "feature changes value");

    git(dir, "checkout", "main");
    writeFileSync(join(dir, "base-only.ts"), "export const baseOnly = true;\n");
    commit(dir, "main advances independently");

    git(dir, "checkout", "feature");
    writeFileSync(join(dir, "value.ts"), "export const value = 3;\n");
  });

  test("refExists resolves branches and annotated commit tags, not blobs or missing refs", () => {
    assert.equal(refExists(dir, "main"), true);
    assert.equal(refExists(dir, "fork-point"), true);
    assert.equal(refExists(dir, "blob-only"), false);
    assert.equal(refExists(dir, "missing-base"), false);
  });

  test("an explicit base compares committed changes since the merge base", () => {
    const result = changedFiles(dir, "main");
    assert.ok(result);
    assert.equal(result.basis, "main...HEAD");
    assert.deepEqual(result.files.map(({ path }) => path), ["value.ts"]);

    const file = fileNamed(result, "value.ts");
    assert.equal(file.status, "modified");
    assert.deepEqual(file.ranges, [{ start: 1, end: 1 }]);
    assert.deepEqual(file.hunks[0]?.lines, [
      { n: null, sign: "-", text: "export const value = 1;" },
      { n: 1, sign: "+", text: "export const value = 2;" },
    ]);
  });

  test("an empty explicit comparison and an invalid base do not fall back to local edits", () => {
    assert.deepEqual(changedFiles(dir, "HEAD"), { basis: "HEAD...HEAD", files: [] });
    assert.equal(changedFiles(dir, "missing-base"), null);
  });
});

test("an unborn repository has no HEAD to compare against", () => {
  const dir = initRepo("unborn");
  writeFileSync(join(dir, "staged.txt"), "staged but not committed\n");
  git(dir, "add", "staged.txt");

  assert.equal(refExists(dir, "HEAD"), false);
  assert.equal(changedFiles(dir), null);
  assert.equal(changedFiles(join(dir, "absent-directory")), null);
});

test("a clean root commit has no previous commit, but a later clean tree reports its last commit", () => {
  const dir = initRepo("clean");
  writeFileSync(join(dir, "story.txt"), "first line\n");
  commit(dir, "first commit");

  writeFileSync(join(dir, "scratch.txt"), "untracked notes\n");
  assert.deepEqual(changedFiles(dir), { basis: "working tree vs HEAD", files: [] });

  writeFileSync(join(dir, "story.txt"), "first line\nsecond line\n");
  git(dir, "add", "story.txt");
  git(dir, "commit", "-m", "add a second line");

  const result = changedFiles(dir);
  assert.ok(result);
  assert.equal(result.basis, "HEAD~1...HEAD");
  assert.deepEqual(result.files.map(({ path }) => path), ["story.txt"]);
  const file = fileNamed(result, "story.txt");
  assert.deepEqual(file.ranges, [{ start: 2, end: 2 }]);
  assert.deepEqual(file.hunks[0]?.lines, [{ n: 2, sign: "+", text: "second line" }]);
});

test("deletion-only hunks in a surviving file keep their post-image anchors", () => {
  const dir = initRepo("deletions");
  writeFileSync(
    join(dir, "guide.txt"),
    "obsolete heading\nkept title\nkept intro\nobsolete sentence\nkept footer\n",
  );
  writeFileSync(join(dir, "retired.txt"), "no longer needed\n");
  writeFileSync(join(dir, "image.bin"), Buffer.from([0, 1, 2]));
  commit(dir, "initial files");

  writeFileSync(join(dir, "guide.txt"), "kept title\nkept intro\nkept footer\n");
  rmSync(join(dir, "retired.txt"));
  writeFileSync(join(dir, "image.bin"), Buffer.from([0, 3, 4]));
  writeFileSync(join(dir, "notes.txt"), "no final newline");
  git(dir, "add", "notes.txt");

  const result = changedFiles(dir);
  assert.ok(result);
  assert.equal(result.basis, "working tree vs HEAD");
  assert.equal(result.files.length, 4);

  const guide = fileNamed(result, "guide.txt");
  assert.equal(guide.status, "modified");
  assert.deepEqual(guide.ranges, [{ start: 0, end: 0 }, { start: 2, end: 2 }]);
  assert.deepEqual(guide.hunks.map(({ lines }) => lines), [
    [{ n: null, sign: "-", text: "obsolete heading" }],
    [{ n: null, sign: "-", text: "obsolete sentence" }],
  ]);

  const retired = fileNamed(result, "retired.txt");
  assert.equal(retired.status, "deleted");
  assert.deepEqual(retired.ranges, []);
  assert.deepEqual(retired.hunks, []);

  const image = fileNamed(result, "image.bin");
  assert.equal(image.status, "modified");
  assert.deepEqual(image.ranges, []);
  assert.deepEqual(image.hunks, []);

  const notes = fileNamed(result, "notes.txt");
  assert.equal(notes.status, "added");
  assert.deepEqual(notes.ranges, [{ start: 1, end: 1 }]);
  assert.deepEqual(notes.hunks[0]?.lines, [{ n: 1, sign: "+", text: "no final newline" }]);
  assert.equal(notes.hunks[0]?.dropped, 0);
});

test("hunk and file text caps preserve ranges and reset the budget for the next file", () => {
  const dir = initRepo("caps");
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const expectedRanges: { start: number; end: number }[] = [];

  // The first eight hunks have 198 edit lines, including the six already
  // dropped by the per-hunk cap. The ninth hunk crosses the file cap.
  for (const [block, size] of [15, 12, 12, 12, 12, 12, 12, 12, 3, 1].entries()) {
    const start = newLines.length + 1;
    expectedRanges.push({ start, end: start + size - 1 });
    for (let line = 1; line <= size; line++) {
      oldLines.push(`old block ${block} line ${line}`);
      newLines.push(`new block ${block} line ${line}`);
    }
    const separator = [`stable separator ${block}`, `stable footer ${block}`];
    oldLines.push(...separator);
    newLines.push(...separator);
  }

  writeFileSync(join(dir, "generated.txt"), `${oldLines.join("\n")}\n`);
  writeFileSync(join(dir, "summary.txt"), "old summary\n");
  commit(dir, "initial generated output");

  writeFileSync(join(dir, "generated.txt"), `${newLines.join("\n")}\n`);
  writeFileSync(join(dir, "summary.txt"), "new summary\n");

  const result = changedFiles(dir);
  const generated = fileNamed(result, "generated.txt");
  assert.deepEqual(generated.ranges, expectedRanges);
  assert.deepEqual(generated.hunks.map(({ start, end }) => ({ start, end })), expectedRanges);
  assert.deepEqual(generated.hunks.map(({ lines }) => lines.length), [
    24, 24, 24, 24, 24, 24, 24, 24, 2, 0,
  ]);
  assert.deepEqual(generated.hunks.map(({ dropped }) => dropped), [
    6, 0, 0, 0, 0, 0, 0, 0, 4, 2,
  ]);

  const first = generated.hunks[0];
  assert.ok(first);
  assert.deepEqual(first.lines[14], { n: null, sign: "-", text: "old block 0 line 15" });
  assert.deepEqual(first.lines[15], { n: 1, sign: "+", text: "new block 0 line 1" });
  assert.deepEqual(first.lines.at(-1), { n: 9, sign: "+", text: "new block 0 line 9" });
  assert.deepEqual(generated.hunks[8]?.lines, [
    { n: null, sign: "-", text: "old block 8 line 1" },
    { n: null, sign: "-", text: "old block 8 line 2" },
  ]);

  const summary = fileNamed(result, "summary.txt");
  assert.deepEqual(summary.ranges, [{ start: 1, end: 1 }]);
  assert.deepEqual(summary.hunks[0]?.lines, [
    { n: null, sign: "-", text: "old summary" },
    { n: 1, sign: "+", text: "new summary" },
  ]);
  assert.equal(summary.hunks[0]?.dropped, 0);
});

test("a failing textconv driver leaves the name-status result available", () => {
  const dir = initRepo("textconv");
  writeFileSync(join(dir, ".gitattributes"), "report.dat diff=report\n");
  writeFileSync(join(dir, "report.dat"), "previous report\n");
  commit(dir, "initial report");

  // Git appends the input filename. Without a mode, `git cat-file <file>` fails.
  git(dir, "config", "diff.report.textconv", "git cat-file");
  writeFileSync(join(dir, "report.dat"), "updated report\n");

  const result = changedFiles(dir);
  assert.ok(result);
  assert.equal(result.basis, "working tree vs HEAD");
  const report = fileNamed(result, "report.dat");
  assert.equal(report.status, "modified");
  assert.deepEqual(report.ranges, []);
  assert.deepEqual(report.hunks, []);

  git(dir, "config", "--unset", "diff.report.textconv");
  const raw = fileNamed(changedFiles(dir), "report.dat");
  assert.deepEqual(raw.ranges, [{ start: 1, end: 1 }]);
  assert.deepEqual(raw.hunks[0]?.lines, [
    { n: null, sign: "-", text: "previous report" },
    { n: 1, sign: "+", text: "updated report" },
  ]);
});
