/**
 * A kept preference's title is the person's own line, so a long line is cut
 * only at a whole word and marked, never mid-word or with dangling punctuation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { prefTitle } from "../src/init/keep.js";

const a = "a".repeat(100);

test("pref title: a line of 120 characters or fewer is the title as it is", () => {
  const line = `${a} ${"b".repeat(19)}`;
  assert.equal(line.length, 120);
  assert.equal(prefTitle(line), line);
  assert.equal(prefTitle("run the linter first"), "run the linter first");
});

test("pref title: a longer line is cut after the last whole word, with an ellipsis", () => {
  assert.equal(prefTitle(`${a} ${"b".repeat(20)}`), `${a}…`, "121 characters: the cut word goes");
  assert.equal(prefTitle(`${a} ${"b".repeat(30)}`), `${a}…`);
});

test("pref title: a word that ends right at the cut is kept whole", () => {
  const word = "b".repeat(18);
  assert.equal(prefTitle(`${a} ${word} and more words after it`), `${a} ${word}…`);
});

test("pref title: punctuation left before the cut is dropped", () => {
  assert.equal(prefTitle(`${a}, ${"b".repeat(30)}`), `${a}…`);
  assert.equal(prefTitle(`${a}; ${"b".repeat(30)}`), `${a}…`);
});

test("pref title: one word longer than the title is cut hard, still under 121 characters", () => {
  const title = prefTitle("c".repeat(200));
  assert.equal(title, `${"c".repeat(119)}…`);
  assert.equal(title.length, 120);
});
