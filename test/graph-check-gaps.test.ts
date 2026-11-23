import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { buildGraph, tierOf } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { checkGraph, formatGraphCheckReport, type GraphCheckResult } from "../src/graph/check.js";

const dirs: string[] = [];
function scratch(tag: string): string {
  const d = tmpRepo(tag);
  dirs.push(d);
  return d;
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const A_TS = `export function alpha(x: number): number {
  return x + 1;
}
`;
const B_TS = `export function beta(): string {
  return "b";
}
`;

async function buildFixture(tag: string): Promise<{ dir: string; contextDir: string }> {
  const dir = scratch(tag);
  writeFileSync(join(dir, "a.ts"), A_TS);
  writeFileSync(join(dir, "b.ts"), B_TS);
  const result = await buildGraph(dir, { reuse: false });
  assert.deepEqual(result.errors, []);
  return { dir, contextDir: result.contextDir };
}

function baseResult(over: Partial<GraphCheckResult> = {}): GraphCheckResult {
  return {
    ok: true,
    missing: false,
    added: [],
    removed: [],
    changed: [],
    stale: [],
    pending: 0,
    pendingIds: [],
    nodes: 0,
    ...over,
  };
}

describe("checkGraph", () => {
  test("reports a missing graph when nothing was built", async () => {
    const dir = scratch("check-missing");
    writeFileSync(join(dir, "a.ts"), A_TS);
    const r = await checkGraph(dir);
    assert.equal(r.missing, true);
    assert.equal(r.ok, false);
    assert.equal(r.nodes, 0);
    const report = formatGraphCheckReport(r);
    assert.match(report, /NO GRAPH/);
    assert.match(report, /wiring\.json/);
  });

  test("a fresh Tier-1 build is in sync and every node is pending", async () => {
    const { dir, contextDir } = await buildFixture("check-ok");
    const r = await checkGraph(dir);
    assert.equal(r.missing, false);
    assert.equal(r.ok, true);
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.changed, []);
    const graph = readGraph(wiringPath(contextDir));
    assert.ok(graph);
    assert.equal(r.nodes, graph.nodes.length);
    assert.ok(r.nodes > 0);
    assert.equal(r.pending, r.pendingIds.length);
    assert.deepEqual([...r.pendingIds], [...r.pendingIds].sort());
    const report = formatGraphCheckReport(r);
    assert.match(report, /graph check: OK/);
    if (r.pending > 0) assert.match(report, /pending/);
  });

  test("detects changed, added and removed definitions", async () => {
    const { dir, contextDir } = await buildFixture("check-drift");
    const graph = readGraph(wiringPath(contextDir));
    assert.ok(graph);
    const bIds = graph.nodes.filter((n) => n.path === "b.ts").map((n) => n.id);
    assert.ok(bIds.length > 0);

    writeFileSync(
      join(dir, "a.ts"),
      `export function alpha(x: number): number {
  return x * 42 - 7;
}

export function gamma(): number {
  return 3;
}
`,
    );
    unlinkSync(join(dir, "b.ts"));

    const r = await checkGraph(dir);
    assert.equal(r.ok, false);
    assert.ok(r.changed.length > 0, "alpha's body changed");
    assert.ok(r.added.some((id) => id.includes("gamma")), `gamma added: ${r.added.join(",")}`);
    for (const id of bIds) assert.ok(r.removed.includes(id), `${id} removed`);
    assert.deepEqual(r.removed, [...r.removed].sort());

    const report = formatGraphCheckReport(r);
    assert.match(report, /graph check: STALE/);
    assert.match(report, /changed \(\d+\):/);
    assert.match(report, /added \(\d+\):/);
    assert.match(report, /removed \(\d+\):/);
    assert.match(report, /to rebuild the structure/);
    assert.doesNotMatch(report, /refresh stale summaries/);
  });

  test("a file in an unsupported encoding reads as removed", async () => {
    const { dir, contextDir } = await buildFixture("check-utf16be");
    const graph = readGraph(wiringPath(contextDir));
    assert.ok(graph);
    const bIds = graph.nodes.filter((n) => n.path === "b.ts").map((n) => n.id);
    assert.ok(bIds.length > 0);

    const le = Buffer.from(B_TS, "utf16le");
    const be = Buffer.alloc(le.length);
    for (let i = 0; i + 1 < le.length; i += 2) {
      be[i] = le[i + 1];
      be[i + 1] = le[i];
    }
    writeFileSync(join(dir, "b.ts"), Buffer.concat([Buffer.from([0xfe, 0xff]), be]));

    const r = await checkGraph(dir);
    assert.equal(r.ok, false);
    for (const id of bIds) assert.ok(r.removed.includes(id), `${id} removed`);
    assert.deepEqual(r.added, []);
  });

  test("a committed stale summary is reported as drift", async () => {
    const { dir, contextDir } = await buildFixture("check-stale");
    const path = wiringPath(contextDir);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    assert.ok(Array.isArray(raw.nodes));
    const target = raw.nodes.find((n: { path?: string }) => n.path === "a.ts");
    assert.ok(target);
    target.summary_state = "stale";
    writeFileSync(path, JSON.stringify(raw, null, 2));

    const r = await checkGraph(dir);
    assert.equal(r.ok, false);
    assert.deepEqual(r.stale, [target.id]);
    assert.ok(!r.pendingIds.includes(target.id));
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.changed, []);

    const report = formatGraphCheckReport(r);
    assert.match(report, /stale summaries \(1\):/);
    assert.ok(report.includes(`  ! ${target.id}`));
    assert.match(report, /refresh stale summaries/);
    assert.doesNotMatch(report, /to rebuild the structure/);
  });

  test("deploy and generic tier files re-extract in step with the build", async () => {
    const dir = scratch("check-deploy");
    writeFileSync(join(dir, "Dockerfile"), "FROM node:22\nWORKDIR /app\nRUN echo hi\nCMD [\"node\", \"x.js\"]\n");
    writeFileSync(
      join(dir, "docker-compose.yml"),
      "services:\n  web:\n    image: nginx\n    ports:\n      - \"80:80\"\n",
    );
    writeFileSync(join(dir, "setup.sh"), "#!/usr/bin/env bash\ngreet() {\n  echo hi\n}\n");
    writeFileSync(join(dir, "a.ts"), A_TS);

    const tiers = ["Dockerfile", "docker-compose.yml", "setup.sh", "a.ts"].map((f) => tierOf(join(dir, f)));
    assert.ok(tiers[2].generic, "bash is a generic-tier file");
    assert.ok(tiers[3].lang, "TypeScript is a depth-tier file");

    const built = await buildGraph(dir, { reuse: false });
    const r = await checkGraph(dir);
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.changed, []);
    assert.equal(r.ok, true);

    const graph = readGraph(wiringPath(built.contextDir));
    assert.ok(graph);
    assert.equal(r.nodes, graph.nodes.length);
    assert.ok(graph.nodes.some((n) => n.path === "setup.sh"));
  });
});

describe("formatGraphCheckReport", () => {
  test("OK without pending nodes has no meaning-tier note", () => {
    const out = formatGraphCheckReport(baseResult({ nodes: 5 }));
    assert.equal(out, "graph check: OK — the wiring graph is in sync with the code.");
  });

  test("OK with pending nodes reports the share and caps the id sample", () => {
    const ids = Array.from({ length: 11 }, (_, i) => `n${String(i).padStart(2, "0")}`);
    const out = formatGraphCheckReport(baseResult({ nodes: 20, pending: 11, pendingIds: ids }));
    assert.match(out, /meaning tier 45% complete — 11 of 20 node\(s\) pending/);
    assert.ok(out.includes("n00, n01, n02, n03, n04, n05, n06, n07, … +3 more"));
    assert.ok(!out.includes("n08"));
    assert.match(out, /build --deep/);
  });

  test("a short pending list is named in full without a 'more' suffix", () => {
    const out = formatGraphCheckReport(baseResult({ nodes: 4, pending: 2, pendingIds: ["x", "y"] }));
    assert.match(out, /50% complete — 2 of 4 node\(s\) pending: x, y\. /);
    assert.doesNotMatch(out, /more/);
  });

  test("pending without ids (older result shape) and zero nodes", () => {
    const r = baseResult({ nodes: 0, pending: 3 });
    (r as { pendingIds?: string[] }).pendingIds = undefined;
    const out = formatGraphCheckReport(r);
    assert.match(out, /meaning tier 0% complete — 3 of 0 node\(s\) pending\. /);
  });

  test("STALE report lists each category with its marker", () => {
    const out = formatGraphCheckReport(
      baseResult({ ok: false, changed: ["c1"], added: ["a1", "a2"], removed: ["r1"], stale: ["s1"] }),
    );
    const lines = out.split("\n");
    assert.equal(lines[0], "graph check: STALE");
    assert.ok(lines.includes("changed (1):"));
    assert.ok(lines.includes("  ~ c1"));
    assert.ok(lines.includes("added (2):"));
    assert.ok(lines.includes("  + a2"));
    assert.ok(lines.includes("removed (1):"));
    assert.ok(lines.includes("  - r1"));
    assert.ok(lines.includes("stale summaries (1):"));
    assert.ok(lines.includes("  ! s1"));
    assert.match(out, /to rebuild the structure/);
    assert.match(out, /refresh stale summaries/);
  });

  test("STALE report with only removals omits other sections", () => {
    const out = formatGraphCheckReport(baseResult({ ok: false, removed: ["gone"] }));
    assert.doesNotMatch(out, /changed \(/);
    assert.doesNotMatch(out, /added \(/);
    assert.doesNotMatch(out, /stale summaries/);
    assert.match(out, /removed \(1\):\n {2}- gone/);
  });
});
