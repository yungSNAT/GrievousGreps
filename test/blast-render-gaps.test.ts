import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { markdownReport, mermaidDiagram, textReport } from "../src/blast/render.js";
import type {
  BlastReport, ChangedArea, Impacted, ImpactedModule, LeftBehind, TestSignal,
} from "../src/blast/blast.js";
import { mention, sinceLabel, type Owner } from "../src/blast/owners.js";

// Graph paths are repository-relative; only filesystem paths use the host separator.
const src = (name: string) => posix.join("src", `${name}.ts`);
const suite = (name: string) => posix.join("test", `${name}.test.ts`);
const change = (path: string) => ({
  path, status: "modified" as const, ranges: [{ start: 1, end: 3 }],
});

function area(label: string, tests: TestSignal = "na"): ChangedArea {
  const reached = tests === "stale" || tests === "changed" ? 1 : 0;
  return {
    label, labelSource: "concept", key: label, files: [src(label)], seeds: 1, tests,
    testFiles: reached ? [suite(label)] : [],
    changedTestFiles: tests === "changed" ? [suite(label)] : [],
    reached, behavioural: tests === "na" ? 0 : 1,
    unreached: tests === "none" ? [label] : [],
    seedNames: [label],
  };
}

function symbol(path: string, name: string): Impacted {
  return { id: `${path}#${name}`, name, kind: "function", path, span: "L1-L3", relation: "calls", depth: 1 };
}

function moduleFor(label: string, from: string[], count = 1, path = src(label)): ImpactedModule {
  return {
    label, labelSource: "concept", key: label, files: [path], from,
    symbols: Array.from({ length: count }, (_, i) => symbol(path, `hop${i + 1}`)),
  };
}

function report(overrides: Partial<BlastReport> = {}): BlastReport {
  const areas = overrides.areas ?? [];
  const modules = overrides.modules ?? [];
  return {
    basis: "main...HEAD",
    depth: 2,
    changed: [...new Set(areas.flatMap((a) => [...a.files, ...a.changedTestFiles]))].map(change),
    unindexed: [],
    deleted: [],
    seeds: [],
    impacted: modules.flatMap((m) => m.symbols),
    modules,
    testModules: [],
    areas,
    ...overrides,
  };
}

test("an empty report does not render a diagram, table, or optional sections", () => {
  const r = report();
  assert.equal(mermaidDiagram(r), null);
  const body = markdownReport(r);
  assert.match(body, /\*\*No resolved dependents\.\*\* 0 areas changed; no indexed dependents at depth 2\./);
  assert.match(body, / · main\.\.\.HEAD · depth 2 · 0 changed files<\/sub>\n$/);
  assert.doesNotMatch(body, /```mermaid|Can be affected|<details>|Tests:|Tag:|⚠/);

  const text = textReport(r);
  assert.match(text, /^  impacted: 0 symbols in 0 areas$/m);
  assert.match(text, /\nno indexed dependents outside the changed files themselves\n$/);
  assert.doesNotMatch(text, /who to tag|left behind|tests reaching this change/);
});

test("a types-only edit has no test warning, even when an explicit test search finds nothing", () => {
  const r = report({ areas: [area("types")], depth: Infinity, tests: [], reviewers: [] });
  const body = markdownReport(r, {});
  assert.match(body, /1 area changed; no indexed dependents at full closure\./);
  assert.match(body, / · full closure · 1 changed file<\/sub>/);
  assert.match(body, /^- – \*\*types\*\* — no function, method or class changed here$/m);
  assert.match(body, /<strong>Tests reaching this change<\/strong> — none found, full closure/);
  assert.doesNotMatch(body, /^Tests:|^Tag:|Who knows this code/m);
  assert.match(textReport(r), /^tests reaching this change \(full closure\): none found \(a test that runs the code through a CLI or a spawned process has no edge, so it is not listed\)$/m);
});

test("an unresolved call qualifies the no-dependents headline without becoming a dependent", () => {
  const r = report({
    areas: [area("parse", "none")],
    unresolved: [{ name: "parse", calls: 1 }],
  });
  const body = markdownReport(r);
  assert.match(body, /\*\*No resolved dependents; 1 unresolved call names a changed symbol\.\*\*/);
  assert.match(body, /⚠️ 1 call naming a changed symbol \(parse \(1\)\) did not resolve to one definition/);
  assert.doesNotMatch(body, /```mermaid|Can be affected/);
});

test("graph caveats count all missing files and unresolved calls but name only five entries each", () => {
  const deleted = Array.from({ length: 6 }, (_, i) => src(`removed${i + 1}`));
  const unindexed = Array.from({ length: 6 }, (_, i) => posix.join("assets", `new${i + 1}.dat`));
  const r = report({
    deleted,
    unindexed,
    unresolved: Array.from({ length: 6 }, (_, i) => ({ name: `parse${i + 1}`, calls: i + 1 })),
  });
  const body = markdownReport(r);
  assert.match(body, /\*\*No resolved dependents; 21 unresolved calls name a changed symbol\.\*\*/);
  for (const [output, glyph] of [[body, "⚠️"], [textReport(r), "⚠"]]) {
    assert.ok(output.includes(`${glyph} 6 deleted files (${deleted.slice(0, 5).join(", ")}) — their dependents cannot be computed`));
    assert.ok(output.includes(`${glyph} 6 changed files not in the graph (${unindexed.slice(0, 5).join(", ")}) — no parser claims the extension`));
    assert.ok(output.includes(`${glyph} 21 calls naming a changed symbol (parse1 (1), parse2 (2), parse3 (3), parse4 (4), parse5 (5))`));
    assert.match(output, /their callers are not counted above, so this may undercount/);
    for (const name of [deleted[5], unindexed[5], "parse6"]) assert.ok(!output.includes(name));
  }
});

test("test signals distinguish multiple updated and stale areas from unreached functions", () => {
  const updated = area("reader", "changed");
  updated.testFiles.push(suite("reader-errors"));
  updated.changedTestFiles.push(suite("reader-errors"));
  const stale = area("cache", "stale");
  stale.testFiles.push(suite("cache-expiry"));
  const missing = area("totals", "none");
  missing.unreached = Array.from({ length: 9 }, (_, i) => `total${i + 1}`);
  missing.seedNames = missing.unreached;
  missing.seeds = missing.behavioural = missing.unreached.length;

  const body = markdownReport(report({
    areas: [updated, area("writer", "changed"), stale, area("store", "stale"), missing],
  }));
  assert.match(body, /^Tests: \*\*no test reaches totals\*\*; cache, store have tests the diff did not touch; 2 areas updated their tests\.$/m);
  assert.ok(body.includes(`- ✓ **reader** — 1 of 1 reached · 2 test files changed here: \`${suite("reader")}\`, \`${suite("reader-errors")}\``));
  assert.match(body, /^- ⚠ \*\*cache\*\* — 1 of 1 reached · 2 test files reach it, none changed here$/m);
  assert.match(body, /^- ✗ \*\*totals\*\* — 0 of 9 reached · no test file reaches it$/m);
  assert.match(body, /^  - not reached: `total1`.*`total8`, …1 more$/m);
  assert.ok(!body.includes("`total9`"));
});

test("the impact table deduplicates source areas and abbreviates both kinds of overflow", () => {
  const api = area("api");
  api.files.push(src("api-types"));
  const areas = [api, area("model"), area("config")];
  const loose = src("legacy");
  const modules = Array.from({ length: 10 }, (_, i) => moduleFor(`consumer${i + 1}`, [src("api")]));
  modules[0].from = [...api.files, src("model"), src("config")];
  modules[1].from = [loose];
  const r = report({ areas, modules });
  r.changed.push(change(loose));
  const body = markdownReport(r);

  assert.match(body, /\*\*3 areas changed → 10 areas can be affected\.\*\* 10 dependent symbols, depth 2\./);
  assert.ok(body.includes(`| consumer1 | 1 | \`${src("consumer1")}:L1-L3\` hop1 — calls, depth 1 | api, model +1 |`));
  assert.ok(body.split("\n").some((line) => line.startsWith("| consumer2 |") && line.endsWith(` | ${loose} |`)));
  assert.match(body, /^\| _4 smaller areas_ \| 4 \| consumer7, consumer8, consumer9, … \| see below \|$/m);
  assert.doesNotMatch(body, /^\| consumer7 \|/m);
  assert.match(body, /^  AX\(\("5 smaller areas<br\/>5 symbols"\)\)$/m);
});

test("Mermaid escapes user-facing labels without escaping its own line break", () => {
  const modules = Array.from({ length: 6 }, (_, i) => moduleFor(`client${i + 1}`, [src("api")]));
  modules[0].label = 'client "<beta>"';
  const diagram = mermaidDiagram(report({ areas: [area("api")], modules })) ?? assert.fail("missing diagram");
  assert.match(diagram, /^  A0\(\("client #quot;&lt;beta&gt;#quot;<br\/>1 symbol"\)\)$/m);
  assert.match(diagram, /^  AX\(\("1 smaller area<br\/>1 symbol"\)\)$/m);
  assert.match(diagram, /^  class AX tail;$/m);
  assert.doesNotMatch(diagram, /^  A5\(\(/m);

  const single = mermaidDiagram(report({ modules: modules.slice(0, 1) })) ?? assert.fail("missing diagram");
  assert.match(single, /^  class A0 reached;$/m);
  assert.doesNotMatch(single, /\bAX\b|classDef tail/);
});

test("left-behind callers prefer a call line, fall back to a span, and are capped only in Markdown", () => {
  const seed = symbol(src("api"), "connect");
  const dependents = Array.from({ length: 6 }, (_, i) => ({
    ...symbol(src(`client${i + 1}`), `start${i + 1}`),
    inferred: i === 0,
  }));
  const callers = dependents.map((s, i) => ({
    ...s, seed, ...(i === 0 ? { line: 2 } : {}),
  } as LeftBehind));
  const clients: ImpactedModule = {
    ...moduleFor("clients", [seed.path]),
    files: dependents.map((s) => s.path),
    symbols: dependents,
  };
  const r = report({ areas: [area("api", "none")], modules: [clients], leftBehind: callers });
  const body = markdownReport(r);
  const warning = body.split("\n").find((line) => line.startsWith("⚠️ **6 callers left behind**"))
    ?? assert.fail("missing caller warning");
  assert.ok(warning.includes(`\`start1\` (\`${src("client1")}:2\`) [inferred]`));
  assert.ok(warning.includes(`\`start2\` (\`${src("client2")}:L1-L3\`)`));
  assert.match(warning, /`start5`.*\+1 more, all in `--format json`\. The diff did not edit their calls\.$/);
  assert.ok(!warning.includes("start6"));
  assert.ok(body.indexOf(warning) < body.indexOf("```mermaid"));

  const text = textReport(r);
  assert.match(text, /^⚠ 6 callers left behind: each calls a symbol whose declaration changed/m);
  assert.ok(text.includes(`  connect ← start1 (${src("client1")}:2) [inferred]\n`));
  assert.ok(text.includes(`  connect ← start6 (${src("client6")}:L1-L3)\n`));

  const single = { ...r, leftBehind: [callers[1]] };
  assert.match(markdownReport(single), /\*\*1 caller left behind\*\*.*The diff did not edit its call\./);
  assert.match(textReport(single), /^⚠ 1 caller left behind: it calls a symbol whose declaration changed/m);
});

test("reviewer suggestions name a short remit and put owners ahead of solo rows", (t) => {
  const now = Date.UTC(2025, 2, 20);
  const clock = mock.method(Date, "now", () => now);
  t.after(() => clock.mock.restore());
  const day = 86_400_000;
  const dana = { name: "Dana Reyes", handle: "dana-r", commits: 2, last: now - 9 * day } as Owner;
  const sam = { name: "Sam Patel", commits: 1, last: now - day } as Owner;
  const areas = Array.from({ length: 8 }, (_, i) => area(`edit${i + 1}`));
  areas[0].owners = [];
  areas[1].owners = [sam];
  const gateway = { ...moduleFor("gateway", [src("edit1")]), owners: [dana, sam] };
  const r = report({
    areas,
    modules: [gateway],
    reviewers: [
      { ...dana, areas: ["gateway", "edit1", "edit2"] },
      { ...sam, areas: ["edit2", "gateway"] },
    ],
  });

  const body = markdownReport(r);
  const tag = "Tag: @dana-r — 3 of 9 areas · **Sam Patel** — edit2, gateway";
  assert.ok(body.includes(`${tag}\n`));
  assert.ok(body.indexOf(tag) < body.indexOf("```mermaid"));
  assert.match(body, /<strong>Who knows this code<\/strong> — 2 people across 9 areas/);
  const danaCell = `${mention(dana)} — 2 commits, last ${sinceLabel(dana.last, now)}`;
  const samCell = `${mention(sam)} — 1 commit, last ${sinceLabel(sam.last, now)}`;
  assert.ok(body.includes(`| **edit2** · changed | ${samCell} |`));
  const named = `| **gateway** · affected | ${danaCell} · ${samCell} |`;
  const solo = "| **edit1** · changed | _only you — nobody else has touched these files_ |";
  assert.ok(body.includes(named));
  assert.ok(body.includes(solo));
  assert.ok(body.indexOf(named) < body.indexOf(solo));
  assert.match(body, /^\| _…1 further area_ \| \|$/m);
  assert.doesNotMatch(body, /^\| \*\*edit8\*\* · changed/m);
  assert.match(body, /A suggestion from history, not a CODEOWNERS rule/);

  const text = textReport(r);
  assert.match(text, /^who to tag$/m);
  assert.ok(text.includes(`  ${mention(dana)} — 3 areas · 2 commits, last ${sinceLabel(dana.last, now)}\n`));
  assert.ok(text.includes(`  ${mention(sam)} — edit2, gateway · 1 commit, last ${sinceLabel(sam.last, now)}\n`));
});

test("the collapsed inventory caps the whole report, while terminal output caps each area", () => {
  const areas = [area("schema")];
  const broad = moduleFor("generated", [src("schema")], 60);
  const other = moduleFor("adapter", [src("schema")], 3);
  const r = report({ areas, modules: [broad, other] });
  const bullets = (body: string) => body.split("\n").filter((line) => line.startsWith("- `"));

  const body = markdownReport(r);
  assert.match(body, /<strong>All 63 dependent symbols<\/strong>/);
  assert.equal(bullets(body).length, 60);
  assert.ok(body.includes(`- \`${broad.files[0]}:L1-L3\` — hop60 (calls, depth 1)`));
  assert.match(body, /^…3 further symbols not listed\.$/m);
  assert.ok(!bullets(body).some((line) => line.includes(other.files[0])));

  const oneLargeArea = markdownReport(report({
    areas, modules: [moduleFor("generated", [src("schema")], 64)],
  }));
  assert.equal(bullets(oneLargeArea).length, 60);
  assert.doesNotMatch(oneLargeArea, /— hop61 \(calls,/);

  const text = textReport(r);
  assert.ok(text.includes(`  calls ← hop25 (${broad.files[0]}:L1-L3) [depth 1]\n`));
  assert.doesNotMatch(text, /calls ← hop26 /);
  assert.match(text, /^  …35 more symbols$/m);
  assert.ok(text.includes(`  calls ← hop3 (${other.files[0]}:L1-L3) [depth 1]\n`));
});

test("explicit test reach shows changed, inferred, and abbreviated entries; text keeps the tail", () => {
  const tests = Array.from({ length: 22 }, (_, i) => ({
    path: suite(`reach${i + 1}`),
    changed: i === 0,
    inferred: i === 1,
    depth: 2,
    symbols: i === 2 ? [] : ["testAdd", "testSum", "testTotal", "testAverage"],
  }));
  const r = report({ areas: [area("sum", "stale")], depth: Infinity, tests });
  const body = markdownReport(r);
  assert.match(body, /<strong>Tests reaching this change<\/strong> — 22 test files, full closure/);
  assert.ok(body.includes(`- \`${tests[0].path}\` — changed in this diff\n`));
  assert.ok(body.includes(`- \`${tests[1].path}\` — depth 2 [inferred] · testAdd, testSum, testTotal +1\n`));
  assert.ok(body.includes(`- \`${tests[2].path}\` — depth 2\n`));
  assert.ok(body.includes(`- \`${tests[19].path}\` — `));
  assert.ok(!body.includes(`\`${tests[20].path}\``));
  assert.match(body, /^- …2 more, all in `--format json`$/m);
  assert.match(body, /a test that runs the code through a CLI or a spawned process has no edge/);

  const text = textReport(r);
  assert.match(text, /^tests reaching this change \(full closure\): 22 files$/m);
  assert.ok(text.includes(`  ${tests[21].path} — depth 2 · testAdd, testSum, testTotal +1\n`));
});

test("test-only suites are sorted and capped separately from production dependents", () => {
  const files = Array.from({ length: 22 }, (_, i) => suite(`case-${String(i + 1).padStart(2, "0")}`));
  const testModule: ImpactedModule = {
    ...moduleFor("checks", [src("parser")]),
    files: [...files].reverse(),
    symbols: files.map((path) => symbol(path, "testParse")),
  };
  const r = report({ areas: [area("parser", "stale")], testModules: [testModule] });
  const body = markdownReport(r);
  assert.match(body, /<summary>22 test suites also reference this code<\/summary>/);
  assert.match(body, /22 symbols, kept out of the diagram and the table/);
  const listed = body.split("\n").filter((line) => line.startsWith("- `"));
  assert.deepEqual(listed, files.slice(0, 20).map((path) => `- \`${path}\``));
  assert.match(body, /^- …2 more$/m);
  assert.doesNotMatch(body, /```mermaid|Can be affected/);
  assert.match(textReport(r), /^22 test suites also reference this code \(not listed\)$/m);
});

describe("source evidence in the collapsed Markdown inventory", () => {
  let root: string;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "blast-render-gaps-"));
    mkdirSync(join(root, "core"));
    writeFileSync(join(root, "core", "dep.ts"), 'import { thing } from "./f0.js";\nexport function hop1() {\n  return thing();\n}\n');
  });
  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("an available reaching line is quoted below the fold; a missing file still gets a symbol entry", () => {
    const local = posix.join("core", "dep.ts");
    const missing = posix.join("core", "missing.ts");
    const r = report({
      areas: [area("f0")],
      modules: [
        moduleFor("core", [src("f0")], 1, local),
        moduleFor("other", [src("f0")], 1, missing),
      ],
    });
    const quote = '`1: import { thing } from "./f0.js";`';
    const body = markdownReport(r, { root });
    const entry = `- \`${local}:L1-L3\` — hop1 (calls, depth 1)`;
    const missingEntry = `- \`${missing}:L1-L3\` — hop1 (calls, depth 1)`;
    assert.ok(body.includes(`${entry}\n  \`\`${quote}\`\`\n`));
    assert.ok(body.indexOf(quote) > body.indexOf("<details>"));
    assert.ok(body.includes(`${missingEntry}\n\n`));
    const withoutCheckout = markdownReport(r);
    assert.ok(withoutCheckout.includes(entry));
    assert.ok(!withoutCheckout.includes(quote));
  });
});
