import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildContext } from "../src/context/build.js";
import {
  checkContext,
  indexFreshness,
  staleBanner,
  formatCheckReport,
  type CheckResult,
} from "../src/context/check.js";
import { fakeProviders, tmpRepo } from "./helpers.js";

const dirs: string[] = [];

async function builtRepo(tag: string): Promise<string> {
  const d = tmpRepo(tag);
  dirs.push(d);
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "a.ts"), "// [[Alpha Concept]]\nexport const a = 1;\n");
  writeFileSync(join(d, "src", "b.ts"), "// [[Beta Concept]]\nexport const b = 2;\n");
  const r = await buildContext(d, { model: "fake", ...fakeProviders() });
  assert.deepEqual(r.errors, []);
  return d;
}

interface ManifestShape {
  files: Array<{ path: string; hash: string }>;
  nodes: Array<{ slug: string; sourcesDigest: string } & Record<string, unknown>>;
}

function manifestFile(dir: string): string {
  return join(dir, "graft", "manifest.json");
}

function readManifestJson(dir: string): ManifestShape {
  return JSON.parse(readFileSync(manifestFile(dir), "utf8")) as ManifestShape;
}

function writeManifestJson(dir: string, m: ManifestShape): void {
  writeFileSync(manifestFile(dir), JSON.stringify(m, null, 2));
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("checkContext", () => {
  test("reports a missing graph when no manifest exists", () => {
    const d = tmpRepo("ctx-check-missing");
    dirs.push(d);
    writeFileSync(join(d, "x.ts"), "export const x = 1;\n");
    const r = checkContext(d);
    assert.equal(r.missing, true);
    assert.equal(r.ok, false);
    assert.deepEqual(r.coverage, []);
    assert.equal(indexFreshness(d), null);
  });

  test("a fresh build is in sync", async () => {
    const d = await builtRepo("ctx-check-fresh");
    const r = checkContext(d);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.missing, false);
    assert.deepEqual(r.contentDrift, []);
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.coverage, []);
    assert.deepEqual(r.indexDrift, []);
    assert.match(formatCheckReport(r), /graft check: OK/);
  });

  test("detects content drift with short hashes", async () => {
    const d = await builtRepo("ctx-check-content");
    const recordedHash = readManifestJson(d).files.find((f) => f.path === "src/a.ts")!.hash;
    writeFileSync(join(d, "src", "a.ts"), "// [[Alpha Concept]]\nexport const a = 42;\n");
    const r = checkContext(d);
    assert.equal(r.ok, false);
    assert.equal(r.contentDrift.length, 1);
    const drift = r.contentDrift[0]!;
    assert.equal(drift.path, "src/a.ts");
    assert.equal(drift.from, recordedHash.slice(0, 8));
    assert.equal(drift.to.length, 8);
    assert.notEqual(drift.to, drift.from);
    assert.deepEqual(r.removed, []);
    const report = formatCheckReport(r);
    assert.match(report, /STALE/);
    assert.match(report, /changed \(1\):/);
    assert.ok(report.includes(`~ src/a.ts  (${drift.from} → ${drift.to})`));
  });

  test("detects removed files and newly added uncovered files", async () => {
    const d = await builtRepo("ctx-check-removed");
    rmSync(join(d, "src", "b.ts"));
    writeFileSync(join(d, "src", "c.ts"), "export const c = 3;\n");
    const r = checkContext(d);
    assert.equal(r.ok, false);
    assert.deepEqual(r.removed, ["src/b.ts"]);
    assert.deepEqual(r.coverage, ["src/c.ts"]);
    assert.deepEqual(r.contentDrift, []);
    const report = formatCheckReport(r, "custom label");
    assert.match(report, /^custom label: STALE/);
    assert.match(report, /removed \(1\):/);
    assert.ok(report.includes("  - src/b.ts"));
    assert.match(report, /not in graph \(1\):/);
    assert.ok(report.includes("  + src/c.ts"));
  });

  test("custom extensions change what counts as current code", async () => {
    const d = await builtRepo("ctx-check-exts");
    const r = checkContext(d, { extensions: [".zzz"] });
    assert.equal(r.ok, false);
    assert.deepEqual([...r.removed].sort(), ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(r.coverage, []);
    assert.deepEqual(r.contentDrift, []);
  });

  test("flags a frontmatter digest that disagrees with the manifest", async () => {
    const d = await builtRepo("ctx-check-digest");
    const m = readManifestJson(d);
    assert.ok(m.nodes.length >= 1, "expected at least one node");
    const slug = m.nodes[0]!.slug;
    m.nodes[0]!.sourcesDigest = "not-the-real-digest";
    writeManifestJson(d, m);
    const r = checkContext(d);
    assert.equal(r.ok, false);
    assert.ok(
      r.indexDrift.includes(`${slug}: frontmatter digest ≠ manifest`),
      JSON.stringify(r.indexDrift),
    );
    assert.deepEqual(r.contentDrift, []);
    assert.deepEqual(r.removed, []);
    const report = formatCheckReport(r);
    assert.match(report, /index mismatch \(\d+\):/);
    assert.ok(report.includes(`  ! ${slug}: frontmatter digest ≠ manifest`));
  });

  test("flags node files missing from the manifest and manifest nodes without files", async () => {
    const d = await builtRepo("ctx-check-roster");
    const m = readManifestJson(d);
    assert.ok(m.nodes.length >= 1, "expected at least one node");
    const dropped = m.nodes[0]!;
    const ghost = { ...dropped, slug: "ghost-node-that-does-not-exist" };
    m.nodes = [...m.nodes.slice(1), ghost];
    writeManifestJson(d, m);
    const r = checkContext(d);
    assert.equal(r.ok, false);
    assert.ok(
      r.indexDrift.includes(`${dropped.slug}: node file not in manifest`),
      JSON.stringify(r.indexDrift),
    );
    assert.ok(
      r.indexDrift.includes("ghost-node-that-does-not-exist: in manifest but node file missing"),
      JSON.stringify(r.indexDrift),
    );
  });
});

describe("indexFreshness and staleBanner", () => {
  let d: string;
  before(async () => {
    d = await builtRepo("ctx-check-fresh-banner");
  });

  test("fresh index yields zero missing and no banner", () => {
    const f = indexFreshness(d);
    assert.deepEqual(f, { missing: 0, total: 2 });
    assert.equal(staleBanner(f), null);
    assert.equal(staleBanner(null), null);
  });

  test("a vanished file is counted and produces a banner", () => {
    rmSync(join(d, "src", "a.ts"));
    const f = indexFreshness(d);
    assert.deepEqual(f, { missing: 1, total: 2 });
    const banner = staleBanner(f);
    assert.ok(banner);
    assert.ok(banner!.includes("1 of 2 indexed files are not on disk"));
  });
});

describe("formatCheckReport", () => {
  test("renders NO GRAPH for a missing result with the label", () => {
    const r: CheckResult = {
      ok: false,
      missing: true,
      contentDrift: [],
      removed: [],
      coverage: [],
      indexDrift: [],
    };
    const out = formatCheckReport(r, "ci");
    assert.match(out, /^ci: NO GRAPH/);
    assert.ok(out.includes("manifest.json"));
  });

  test("renders OK with a custom label", () => {
    const r: CheckResult = {
      ok: true,
      missing: false,
      contentDrift: [],
      removed: [],
      coverage: [],
      indexDrift: [],
    };
    assert.equal(formatCheckReport(r, "x"), "x: OK — the graph is in sync with the code.");
  });

  test("omits empty sections in a stale report", () => {
    const r: CheckResult = {
      ok: false,
      missing: false,
      contentDrift: [],
      removed: [],
      coverage: ["src/new.ts"],
      indexDrift: [],
    };
    const out = formatCheckReport(r);
    assert.match(out, /not in graph \(1\):/);
    assert.ok(!out.includes("changed ("));
    assert.ok(!out.includes("removed ("));
    assert.ok(!out.includes("index mismatch"));
    assert.match(out, /to regenerate, then commit graft\//);
  });
});
