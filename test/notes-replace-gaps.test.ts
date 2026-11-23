import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learningToReplace, savedIdLine } from "../src/notes/replace.js";
import { notePlace, shortDate, whoseLearning, type Note } from "../src/notes/notes.js";

let scratch: string;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "trail-notes-replace-"));
});

after(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function learning(
  id: string,
  {
    scope = "repo",
    slug = id,
    date = "2025-10-08",
  }: { scope?: "repo" | "personal"; slug?: string; date?: string } = {},
): Note {
  const filename = `${slug}.md`;
  const relPath = join(".trail", "learnings", filename);
  const path = join(scratch, scope, relPath);
  return {
    id,
    scope,
    date,
    author: "Maya",
    title: slug,
    text: "Run the focused tests before committing.",
    filename,
    file: path,
    path,
    rel: relPath,
    relPath,
    relativePath: relPath,
  } as Note;
}

describe("learningToReplace", () => {
  test("reports a missing id without a list heading in an empty repo", () => {
    assert.deepEqual(learningToReplace([], "l-dead00", false), {
      error: [
        "✗ no learning here has the id l-dead00",
        "  this repo has no learnings yet",
      ],
    });
  });

  test("collapses whitespace and caps the displayed name at 80 characters", () => {
    const ref = ` \t missing\n \t learning   ${"x".repeat(90)} \n `;
    const shown = `missing learning ${"x".repeat(63)}`;

    assert.deepEqual(learningToReplace([], ref, false), {
      error: [
        `✗ no learning here is called ${shown}`,
        "  this repo has no learnings yet",
      ],
    });
  });

  test("lists only the five newest learnings, in the order supplied", () => {
    const first = learning("l-a10005", { date: "2025-10-15" });
    const second = learning("l-a10002", { date: "2025-10-14", scope: "personal" });
    const third = learning("l-a10004", { date: "2025-10-13" });
    const fourth = learning("l-a10001", { date: "2025-10-12" });
    const fifth = learning("l-a10003", { date: "2025-10-11" });
    const sixth = learning("l-a10000", { date: "2025-10-10" });
    const notes = [first, second, third, fourth, fifth, sixth];

    assert.deepEqual(learningToReplace(notes, "l-dead00", false), {
      error: [
        "✗ no learning here has the id l-dead00",
        "  learnings here, newest first:",
        `  l-a10005  ${notePlace(first)}`,
        `  l-a10002  ${notePlace(second)}`,
        `  l-a10004  ${notePlace(third)}`,
        `  l-a10001  ${notePlace(fourth)}`,
        `  l-a10003  ${notePlace(fifth)}`,
      ],
    });
  });

  test("rejects a personal replacement for a repo learning but allows a repo replacement", () => {
    const original = learning("l-0a1b2c");

    assert.deepEqual(learningToReplace([original], original.id, true), {
      error: [
        "✗ a learning just for you can't replace one added to this repo: your teammates would still get the old one.",
        "  Save it for the repo (leave out --personal), or leave out --replaces.",
      ],
    });

    const result = learningToReplace([original], original.id, false);
    assert.ok("note" in result);
    assert.equal(result.note, original);
  });

  test("allows a personal learning to replace another personal learning", () => {
    const original = learning("l-0a1b2c", { scope: "personal" });
    const result = learningToReplace([original], original.id, true);

    assert.ok("note" in result);
    assert.equal(result.note, original);
  });
});

describe("savedIdLine", () => {
  test("lists distinct saved ids in first-seen order without a replacement", () => {
    const first = learning("l-3f9a21");
    const second = learning("l-0a1b2c");
    const duplicate = learning("l-3f9a21", { slug: "another-copy" });

    assert.equal(savedIdLine([first, second, duplicate]), "· id l-3f9a21, l-0a1b2c");
  });

  test("reports the old learning's author, date and id after the new id", () => {
    const original = learning("l-0a1b2c", { date: "2025-10-08" });
    const saved = learning("l-3f9a21", { date: "2025-10-15" });

    assert.equal(
      savedIdLine([saved], original),
      `· id l-3f9a21 · replaces ${whoseLearning(original)} from ${shortDate(original.date)} (l-0a1b2c)`,
    );
  });
});
