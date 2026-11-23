import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs, {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { localDate } from "../src/skills/settings.js";
import { MAX_SKILL_BYTES } from "../src/skills/store-fs.js";
import type { SkillRef } from "../src/skills/types.js";
import {
  V_DIR,
  copyFlat,
  keepFolder,
  keepHand,
  prune,
  regularText,
  versionsDir,
  writeSynced,
} from "../src/skills/versions-fs.js";
import { tmpRepo } from "./helpers.js";

describe("kept version filesystem operations", () => {
  let root: string;

  before(() => {
    root = tmpRepo("skills-versions-fs-gaps");
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function folder(name: string): string {
    const dir = join(root, name);
    mkdirSync(dir);
    return dir;
  }

  function skill(name: string): SkillRef {
    // These filesystem operations only use the directory from the ref.
    return { dir: folder(name) } as SkillRef;
  }

  test("regularText accepts the byte limit and rejects oversized and non-file paths", () => {
    const dir = folder("regular-text");
    const path = join(dir, "SKILL.md");
    const text = "a".repeat(MAX_SKILL_BYTES - 2) + "é";

    writeFileSync(path, text);
    assert.equal(regularText(path), text);

    writeFileSync(path, text + "\n");
    assert.equal(regularText(path), null);
    assert.equal(regularText(dir), null);
    assert.equal(regularText(join(dir, "missing.md")), null);
  });

  test("writeSynced creates empty and UTF-8 files without overwriting", () => {
    const dir = folder("synced-write");
    const blank = join(dir, "blank.md");
    const path = join(dir, "SKILL.md");

    writeSynced(blank, "");
    assert.equal(readFileSync(blank, "utf8"), "");

    const text = "# Café\n";
    writeSynced(path, text, 0o600);
    assert.equal(readFileSync(path, "utf8"), text);
    assert.throws(() => writeSynced(path, "replacement"), { code: "EEXIST" });
    assert.equal(readFileSync(path, "utf8"), text);
  });

  test("copyFlat copies only eligible top-level files and applies an optional filter", () => {
    const dir = folder("copy-flat");
    const from = join(dir, "source");
    const filtered = join(dir, "filtered");
    const unfiltered = join(dir, "unfiltered");
    mkdirSync(from);
    mkdirSync(join(from, "nested.sh"));
    writeFileSync(join(from, "nested.sh", "inner.sh"), "nested");
    writeFileSync(join(from, ".private.sh"), "hidden");
    writeFileSync(join(from, "large.sh"), Buffer.alloc(MAX_SKILL_BYTES + 1, 0x61));
    writeFileSync(join(from, "build.sh"), "build café\n");
    writeFileSync(join(from, "check.sh"), "check\n");
    writeFileSync(join(from, "notes.txt"), "notes\n");

    assert.equal(copyFlat(from, filtered, 0o700, (name) => name.endsWith(".sh")), 2);
    assert.deepEqual(readdirSync(filtered).sort(), ["build.sh", "check.sh"]);
    assert.equal(readFileSync(join(filtered, "build.sh"), "utf8"), "build café\n");
    assert.equal(readFileSync(join(filtered, "check.sh"), "utf8"), "check\n");

    assert.equal(copyFlat(from, unfiltered, 0o600), 3);
    assert.deepEqual(readdirSync(unfiltered).sort(), ["build.sh", "check.sh", "notes.txt"]);
    assert.equal(readFileSync(join(unfiltered, "notes.txt"), "utf8"), "notes\n");
  });

  test("copyFlat leaves the destination absent when there is nothing to copy", () => {
    const from = folder("copy-no-matches");
    const to = join(from, "destination");
    writeFileSync(join(from, ".private.sh"), "hidden");

    assert.equal(copyFlat(join(from, "missing"), to, 0o700), 0);
    assert.equal(existsSync(to), false);
    assert.equal(copyFlat(from, to, 0o700), 0);
    assert.equal(existsSync(to), false);
  });

  test("keepFolder publishes a version with scripts and never rewrites it on reuse", () => {
    const ref = skill("keep-version");
    const scripts = join(ref.dir, "scripts");
    mkdirSync(scripts);
    writeFileSync(join(scripts, "build.sh"), "original helper\n");

    const text = "# First version\n";
    const vdir = versionsDir(ref);
    const first = join(vdir, "v1");

    assert.equal(keepFolder(ref, "v1", text, scripts), "kept");
    assert.equal(readFileSync(join(first, "SKILL.md"), "utf8"), text);
    assert.equal(readFileSync(join(first, "scripts", "build.sh"), "utf8"), "original helper\n");

    writeFileSync(join(scripts, "build.sh"), "edited helper\n");
    assert.equal(keepFolder(ref, "v1", text, scripts), "same");
    assert.equal(keepFolder(ref, "v1", "# Different bytes\n", null), "changed");
    assert.equal(readFileSync(join(first, "SKILL.md"), "utf8"), text);
    assert.equal(readFileSync(join(first, "scripts", "build.sh"), "utf8"), "original helper\n");

    assert.equal(keepFolder(ref, "v2", "# No helpers\n", null), "kept");
    assert.deepEqual(readdirSync(join(vdir, "v2")), ["SKILL.md"]);
    assert.equal(readFileSync(join(vdir, "v2", "SKILL.md"), "utf8"), "# No helpers\n");
    assert.deepEqual(readdirSync(vdir).sort(), ["v1", "v2"]);
  });

  test("keepFolder does not reuse a linked directory even if its SKILL.md matches", () => {
    const ref = skill("linked-version");
    const text = "# Kept text\n";
    const vdir = versionsDir(ref);
    assert.equal(keepFolder(ref, "v1", text, null), "kept");

    const original = join(vdir, "v1");
    const linked = join(vdir, "v2");
    // Directory junctions do not require symlink privileges on Windows.
    symlinkSync(original, linked, "junction");

    assert.equal(keepFolder(ref, "v2", text, null), "changed");
    assert.equal(lstatSync(linked).isSymbolicLink(), true);
    assert.equal(readFileSync(join(original, "SKILL.md"), "utf8"), text);
  });

  test("keepFolder removes staging and rethrows if publication fails", () => {
    const ref = skill("failed-publication");
    assert.equal(keepFolder(ref, "v1", "already kept\n", null), "kept");

    const vdir = versionsDir(ref);
    const target = join(vdir, "v2");
    const text = "ready to publish\n";
    const failure = Object.assign(new Error("publication denied"), { code: "EACCES" });
    const renameSync = fs.renameSync;
    const rename = mock.method(fs, "renameSync", (from, to) => {
      if (to === target) {
        const staged = String(from);
        assert.equal(dirname(staged), vdir);
        assert.notEqual(staged, target);
        assert.equal(readFileSync(join(staged, "SKILL.md"), "utf8"), text);
        throw failure;
      }
      return renameSync(from, to);
    });

    try {
      syncBuiltinESMExports();
      assert.throws(() => keepFolder(ref, "v2", text, null), (err) => err === failure);
    } finally {
      rename.mock.restore();
      syncBuiltinESMExports();
    }

    assert.deepEqual(readdirSync(vdir), ["v1"]);
    assert.equal(readFileSync(join(vdir, "v1", "SKILL.md"), "utf8"), "already kept\n");
  });

  test("keepHand reuses identical bytes, suffixes same-day edits, and keeps only three", () => {
    const ref = skill("hand-edits");
    const yesterday = new Date(2025, 4, 19, 12);
    const today = new Date(2025, 4, 20, 12);
    const old = `hand-${localDate(yesterday)}`;
    const base = `hand-${localDate(today)}`;
    const vdir = versionsDir(ref);

    assert.equal(keepHand(ref, "yesterday\n", yesterday), old);
    assert.equal(keepHand(ref, "first edit\n", today), base);
    assert.equal(keepHand(ref, "first edit\n", today), base);
    assert.deepEqual(readdirSync(vdir).sort(), [old, base]);

    assert.equal(keepHand(ref, "second edit\n", today), `${base}-2`);
    assert.equal(keepHand(ref, "third edit\n", today), `${base}-3`);
    assert.deepEqual(readdirSync(vdir).sort(), [base, `${base}-2`, `${base}-3`]);
    assert.equal(readFileSync(join(vdir, base, "SKILL.md"), "utf8"), "first edit\n");
    assert.equal(readFileSync(join(vdir, `${base}-2`, "SKILL.md"), "utf8"), "second edit\n");
    assert.equal(readFileSync(join(vdir, `${base}-3`, "SKILL.md"), "utf8"), "third edit\n");
  });

  test("prune sorts version numbers numerically and counts a spared folder toward the limit", () => {
    const ref = skill("prune-numbered");
    const vdir = versionsDir(ref);
    mkdirSync(vdir);
    for (const name of ["v1", "v2", "v9", "v10", "v11", "unrelated"]) {
      mkdirSync(join(vdir, name));
    }
    writeFileSync(join(vdir, "v99"), "not a directory\n");

    prune(ref, V_DIR, 3, "v1");
    assert.deepEqual(readdirSync(vdir).sort(), ["unrelated", "v1", "v10", "v11", "v99"]);

    prune(ref, V_DIR, 1);
    assert.deepEqual(readdirSync(vdir).sort(), ["unrelated", "v11", "v99"]);
    assert.equal(readFileSync(join(vdir, "v99"), "utf8"), "not a directory\n");
  });

  test("prune leaves a skill without a version store unchanged", () => {
    const ref = skill("prune-missing");
    const path = join(ref.dir, "SKILL.md");
    writeFileSync(path, "# Unversioned skill\n");

    prune(ref, V_DIR, 1);

    assert.deepEqual(readdirSync(ref.dir), ["SKILL.md"]);
    assert.equal(readFileSync(path, "utf8"), "# Unversioned skill\n");
  });
});
