import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BranchCache } from "../src/notes/branches.js";
import {
  changedLines,
  editedLines,
  functionOverlaps,
  landedIn,
  symbolsIn,
  type CodeSymbol,
} from "../src/notes/edit-overlap.js";

let scratch: string | undefined;

before(() => {
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network request in edit-overlap tests");
  });
});

after(() => {
  mock.restoreAll();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

const BACKOFF = [
  "export function backoff(attempt: number): number {",
  "  return attempt * 100;",
  "}",
  "",
].join("\n");

test("symbolsIn reports the callable's span without returning a file symbol", async () => {
  const rel = "src/retry.ts";
  assert.deepEqual(await symbolsIn(rel, BACKOFF), [
    { id: `${rel}#backoff`, label: "backoff()", start: 1, end: 3 },
  ]);
});

describe("changedLines", () => {
  test("a rename without textual changes has no changed lines", () => {
    const diff = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "",
    ].join("\n");

    assert.deepEqual(changedLines(diff), []);
  });

  test("deleting the first line marks line one rather than line zero", () => {
    const diff = "@@ -1 +0,0 @@\n-// obsolete header\n";
    assert.deepEqual(changedLines(diff), [{ start: 1, end: 1 }]);
  });
});

describe("landedIn", () => {
  test("an edit inside a method lands on the method regardless of symbol order", () => {
    const rel = "policy.ts";
    const source = [
      "class RetryPolicy {",
      "  retries() {",
      "    return 4;",
      "  }",
      "  backoff(attempt: number) {",
      "    const delay = attempt * 150;",
      "    return delay;",
      "  }",
      "}",
    ].join("\n");
    const cls: CodeSymbol = {
      id: `${rel}#RetryPolicy`, label: "RetryPolicy", start: 1, end: 9,
    };
    const retries: CodeSymbol = {
      id: `${rel}#RetryPolicy.retries`, label: "RetryPolicy.retries()", start: 2, end: 4,
    };
    const backoff: CodeSymbol = {
      id: `${rel}#RetryPolicy.backoff`, label: "RetryPolicy.backoff()", start: 5, end: 8,
    };
    const ranges = editedLines({ new_string: "const delay = attempt * 150;" }, source);
    const expected = new Map([[backoff.id, backoff.label]]);

    assert.deepEqual(landedIn([cls, retries, backoff], ranges, source, rel), expected);
    assert.deepEqual(landedIn([backoff, retries, cls], ranges, source, rel), expected);
  });

  test("a typed assignment is a landing, but an import and a deleted tail line are not", () => {
    const rel = "settings.py";
    const source = "from math import ceil\nRETRY_MAX: int = 4\n# end of settings";
    const diff = [
      "@@ -1,2 +1,2 @@",
      "-from math import floor",
      "-RETRY_MAX: int = 8",
      "+from math import ceil",
      "+RETRY_MAX: int = 4",
      "@@ -4 +3,0 @@",
      "-OLD_LIMIT = 10",
      "",
    ].join("\n");

    assert.deepEqual(
      landedIn([], changedLines(diff), source, rel),
      new Map([[`${rel}#RETRY_MAX`, "RETRY_MAX"]]),
    );
  });

  test("the fallback scan for a whole-file write includes line 41 but not line 42", () => {
    const rel = "limits.ts";
    const source = [
      "export const MIN_RETRIES = 1;",
      ...Array.from({ length: 39 }, () => ""),
      "export const MAX_RETRIES = 10;",
      "export const DEFAULT_RETRIES = 4;",
    ].join("\n");

    assert.deepEqual(
      landedIn([], editedLines({ content: source }, source), source, rel),
      new Map([
        [`${rel}#MIN_RETRIES`, "MIN_RETRIES"],
        [`${rel}#MAX_RETRIES`, "MAX_RETRIES"],
      ]),
    );
  });
});

test("a pruned cached branch does not hide an overlap on a still-available branch", async () => {
  const repo = mkdtempSync(join(tmpdir(), "edit-overlap-gaps-"));
  scratch = repo;
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Morgan Example");
  git(repo, "config", "user.email", "morgan@example.test");
  git(repo, "config", "core.autocrlf", "false");

  const rel = "src/retry.ts";
  const file = join(repo, "src", "retry.ts");
  mkdirSync(join(repo, "src"));
  writeFileSync(file, BACKOFF);
  git(repo, "add", "--", rel);
  git(repo, "commit", "-qm", "Add retry backoff");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");

  git(repo, "checkout", "-qb", "morgan/backoff");
  writeFileSync(file, BACKOFF.replace("attempt * 100", "Math.min(attempt * 100, 5000)"));
  git(repo, "commit", "-qam", 'fix: cap "backoff"');
  git(repo, "update-ref", "refs/remotes/origin/morgan/backoff", "HEAD");
  git(repo, "update-ref", "refs/remotes/origin/old-backoff", "HEAD");
  git(repo, "checkout", "-q", "main");

  const at = Date.UTC(2025, 0, 1);
  // Supply the cached metadata used by overlap detection; no remote fetch is needed.
  const cache = {
    base: "origin/main",
    branches: [
      { ref: "origin/old-backoff", author: "Morgan", at, files: [rel] },
      { ref: "origin/morgan/backoff", author: "Morgan", at, files: [rel] },
    ],
  } as BranchCache;
  git(repo, "update-ref", "-d", "refs/remotes/origin/old-backoff");

  const edit = { old_string: "attempt * 100", new_string: "attempt * 150" };
  writeFileSync(file, BACKOFF.replace(edit.old_string, edit.new_string));

  const found = await functionOverlaps(repo, file, edit, "Alex", cache);
  assert.equal(found.length, 1);
  const overlap = found[0]!;
  assert.equal(overlap.ref, "origin/morgan/backoff");
  assert.equal(overlap.author, "Morgan");
  assert.equal(overlap.file, rel);
  assert.equal(overlap.subject, "fix: cap 'backoff'");
  assert.deepEqual(overlap.symbols, [{ id: `${rel}#backoff`, label: "backoff()" }]);
});
