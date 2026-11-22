import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { matchSteps, rulesOf } from "../src/skills/learning-steps.js";

describe("learning-step sentence and clause parsing", () => {
  test("a prohibition followed by a replacement is one swap, not two separate rules", () => {
    const read = rulesOf("Don’t run npm, but use pnpm.");
    assert.deepEqual(read, {
      whole: true,
      rules: [{
        t: "swap",
        use: { prog: "pnpm", args: [] },
        not: { prog: "npm", args: [] },
      }],
    });
    assert.deepEqual(matchSteps(read.rules, ["npm i", "pnpm install", "npm i --offline"]), {
      repeats: [2],
      contradicts: [
        { step: 1, fix: "pnpm install" },
        { step: 3, fix: null },
      ],
    });
  });

  test("an unnamed replacement leaves only the independently readable prohibition", () => {
    const read = rulesOf("Don't run npm, use the package manager.");
    assert.deepEqual(read, {
      whole: false,
      rules: [{ t: "never", cmd: { prog: "npm", args: [] } }],
    });
    assert.deepEqual(matchSteps(read.rules, ["npm install", "pnpm install"]), {
      repeats: [],
      contradicts: [{ step: 1, fix: null }],
    });
  });

  test("a before-first sentence recognizes unquoted pre-commit as a command", () => {
    const read = rulesOf("Before you run git commit, always run pre-commit run first.");
    assert.deepEqual(read, {
      whole: true,
      rules: [{
        t: "before",
        first: { prog: "pre-commit", args: ["run"] },
        then: { prog: "git", args: ["commit"] },
      }],
    });
    assert.deepEqual(matchSteps(read.rules, ["pre-commit run --all-files", "git commit"]), {
      repeats: [1],
      contradicts: [],
    });
    assert.deepEqual(matchSteps(read.rules, ["git commit", "pre-commit run --all-files"]), {
      repeats: [],
      contradicts: [{ step: 1, fix: null }],
    });
  });

  test("an English before phrase falls back to the command in the second clause", () => {
    const read = rulesOf("Before committing, always run pre-commit run.");
    assert.deepEqual(read, {
      whole: false,
      rules: [{ t: "always", cmd: { prog: "pre-commit", args: ["run"] } }],
    });
    assert.deepEqual(matchSteps(read.rules, ["git commit", "pre-commit run --all-files"]), {
      repeats: [2],
      contradicts: [],
    });
  });

  test("running a generator rather than hand-editing creates a command rule and a file rule", () => {
    const read = rulesOf("Run `node generate-config.js` rather than hand-editing `./generated.ts` directly.");
    assert.deepEqual(read, {
      whole: true,
      rules: [
        { t: "always", cmd: { prog: "node", args: ["generate-config.js"] } },
        { t: "never-edit", file: "generated.ts" },
      ],
    });
    assert.deepEqual(matchSteps(read.rules, [
      "node generate-config.js",
      "vim generated.ts",
      "cat generated.ts",
    ]), {
      repeats: [1],
      contradicts: [{ step: 2, fix: null }],
    });
  });

  test("an edit replacement needs both a recognizable command and a named file", () => {
    for (const text of [
      "Run the generator instead of editing `generated.ts` by hand.",
      "Run node generate-config.js instead of editing the checked-in file.",
    ]) {
      assert.deepEqual(rulesOf(text), { whole: false, rules: [] }, text);
    }
  });

  test("missing or null learning text from a JavaScript caller yields no rules", () => {
    assert.deepEqual(Reflect.apply(rulesOf, undefined, []), { whole: false, rules: [] });
    assert.deepEqual(Reflect.apply(rulesOf, undefined, [null]), { whole: false, rules: [] });
  });
});
