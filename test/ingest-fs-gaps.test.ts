import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  MAX_FILE_BYTES,
  shouldSkipDir,
  walkDir,
  type WalkOptions,
} from "../src/ingest/fs.js";

function write(root: string, path: string, contents = "export const value = 1;\n"): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore", windowsHide: true });
}

function assertWalk(
  root: string,
  expected: readonly string[],
  includes?: ReadonlySet<string>,
  options?: WalkOptions,
): void {
  assert.deepEqual(
    walkDir(root, includes, options).sort(),
    expected.map((path) => join(root, path)).sort(),
  );
}

test("shouldSkipDir lifts only the named skips, never the protected directories", () => {
  assert.equal(shouldSkipDir("build"), true);
  assert.equal(shouldSkipDir(".kb", new Set()), true);
  assert.equal(shouldSkipDir("src"), false);

  const includes = new Set(["build", ".kb", ".git", ".trail", ".graft"]);
  assert.equal(shouldSkipDir("build", includes), false);
  assert.equal(shouldSkipDir(".kb", includes), false);
  assert.equal(shouldSkipDir("dist", includes), true);
  assert.equal(shouldSkipDir(".hidden", includes), true);
  for (const name of [".git", ".trail", ".graft"]) {
    assert.equal(shouldSkipDir(name, includes), true, `${name} must stay excluded`);
  }
});

describe("walkDir filtering", () => {
  let scratch: string | undefined;

  before(() => {
    scratch = resolve(mkdtempSync(join(tmpdir(), "graft-ingest-fs-gaps-")));
  });

  after(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  });

  function fixture(name: string): string {
    assert.ok(scratch);
    const root = join(scratch, name);
    mkdirSync(root);
    return root;
  }

  test("the filesystem fallback opens named hidden and build directories only", () => {
    const root = fixture("plain");
    const main = join("src", "main.ts");
    const knowledge = join(".kb", "tools", "index.ts");
    const build = join("_build", "handwritten.ts");
    for (const path of [
      main,
      knowledge,
      build,
      join("dist", "bundle.js"),
      join(".hidden", "other.ts"),
      join(".trail", "state.ts"),
      join(".graft", "state.ts"),
      join(".kb", ".config.js"),
    ]) write(root, path);

    assertWalk(root, [main]);
    assertWalk(
      root,
      [main, knowledge, build],
      new Set([".kb", "_build", ".trail", ".graft"]),
    );
    assertWalk(root, [main], new Set());
  });

  test("Git keeps source dot folders but skips tool caches unless explicitly included", () => {
    const root = fixture("git-dot-folders");
    git(root, "init", "-q");

    const storybook = join("packages", ".storybook", "main.ts");
    const build = join("packages", "build", "handwritten.ts");
    const cacheFile = (name: string) => join("packages", name, "helper.ts");
    const caches = [
      ".yarn", ".pnpm-store", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".gradle",
      ".dart_tool", ".pub-cache", ".bundle", ".ipynb_checkpoints", ".terraform",
    ];
    for (const path of [
      storybook,
      build,
      ...caches.map(cacheFile),
      cacheFile(".trail"),
      cacheFile(".graft"),
      join("packages", ".storybook", ".settings.js"),
    ]) write(root, path);

    write(root, ".gitignore", "*.ignored.ts\n");
    // Stage the fixtures so the cache checks do not depend on global Git excludes.
    git(root, "add", "-f", "--", ".");
    write(root, join("packages", ".yarn", "local.ignored.ts"));
    write(root, join("packages", "build", "local.ignored.ts"));

    assertWalk(root, [storybook]);
    assertWalk(
      root,
      [storybook, build, cacheFile(".yarn"), cacheFile(".bundle")],
      new Set(["build", ".yarn", ".bundle", ".trail", ".graft"]),
    );
  });

  test("filesystem and Git walks keep files at the byte limit but not above it", () => {
    const root = fixture("size-limit");
    const small = "small.ts";
    const exact = "at-limit.ts";
    const large = "over-limit.ts";
    write(root, small);
    const source = "export const value = 1;\n";
    write(root, exact, source.padEnd(MAX_FILE_BYTES, " "));
    write(root, large, source.padEnd(MAX_FILE_BYTES + 1, " "));

    assertWalk(root, [small, exact]);
    assertWalk(root, [small, exact], undefined, { followNestedRepos: true });

    git(root, "init", "-q");
    write(root, "removed.ts");
    git(root, "add", "-f", "--", ".");
    unlinkSync(join(root, "removed.ts"));

    // Git still lists the deleted index entry; neither walk should return it.
    assertWalk(root, [small, exact]);
    assertWalk(root, [small, exact], undefined, { followNestedRepos: true });
  });
});
