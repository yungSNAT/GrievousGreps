import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import matter from "gray-matter";
import { dirLabel, moduleIndex, parentDir, shortLabel } from "../src/blast/modules.js";
import { tmpRepo } from "./helpers.js";

describe("moduleIndex", () => {
  let scratch: string;

  before(() => {
    scratch = tmpRepo("blast-modules-gaps");
  });

  after(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  function makeContext(name: string): string {
    const context = join(scratch, name);
    mkdirSync(context);
    return context;
  }

  test("a context without graft nodes uses directory labels, not concepts", () => {
    const index = moduleIndex(makeContext("breadth"));
    const nested = posix.join("src", "graph", "extract.ts");

    assert.equal(index.hasConcepts, false);
    assert.equal(index.conceptOf(nested), null);
    assert.equal(index.labelOf(nested), posix.join("src", "graph") + posix.sep);
    assert.equal(index.conceptOf("README.md"), null);
    assert.equal(index.labelOf("README.md"), "(root)");
  });

  test("an unnamed note does not supply a concept label for its cited file", () => {
    const context = makeContext("untitled");
    const graft = join(context, "graft");
    const directory = posix.join("src", "cache");
    const cited = posix.join(directory, "read.ts");

    mkdirSync(graft);
    writeFileSync(
      join(graft, "untitled-cache-note.md"),
      matter.stringify("Notes without a concept title.\n", {
        name: "",
        sources: [{ path: cited }],
      }),
      "utf8",
    );

    const index = moduleIndex(context);

    assert.equal(index.conceptOf(cited), null);
    assert.equal(index.labelOf(cited), directory + posix.sep);
  });
});

describe("shortLabel", () => {
  test("strips synthesis prefixes and keeps names that already fit", () => {
    assert.equal(shortLabel("cOnCePtS:   Dependency Mapping  "), "Dependency Mapping");
    assert.equal(
      shortLabel("Database Schema Reconciliation"),
      "Database Schema Reconciliation",
    );
  });

  test("cuts at usable clause breaks without adding an ellipsis", () => {
    assert.equal(shortLabel("Indexing via Incremental Dependency Analysis"), "Indexing");
    assert.equal(
      shortLabel("Database Schema Reconciliation: Handling Migration Conflicts"),
      "Database Schema Reconciliation",
    );
  });

  test("uses an ellipsis when a clause break is absent, too early, or too late", () => {
    assert.equal(
      shortLabel("Distributed Dependency Invalidation Rules"),
      "Distributed Dependency…",
    );
    assert.equal(
      shortLabel("Build and Dependency Invalidation Rules"),
      "Build and Dependency…",
    );
    assert.equal(
      shortLabel("Distributed Schema Reconciliation via Migration Planning"),
      "Distributed Schema…",
    );
  });

  test("uses the available width when a word break would cut too much", () => {
    assert.equal(
      shortLabel("DependencyGraph CrossWorkspaceReconciliation"),
      "DependencyGraph CrossWorkspace…",
    );
    assert.equal(
      shortLabel("CrossWorkspaceDependencyResolution"),
      "CrossWorkspaceDependencyResolu…",
    );
  });
});

describe("directory labels", () => {
  test("walks to a directory's parent with or without a trailing separator", () => {
    const core = posix.join("packages", "core");
    const src = posix.join(core, "src");

    assert.equal(dirLabel(posix.join(src, "index.ts")), src + posix.sep);
    assert.equal(parentDir(src + posix.sep), core + posix.sep);
    assert.equal(parentDir(src), core + posix.sep);
    assert.equal(parentDir("packages" + posix.sep), "");
  });

  test("a top-level file has a root label with no parent directory", () => {
    const root = dirLabel("package.json");
    assert.equal(root, "(root)");
    assert.equal(parentDir(root), "");
  });
});
