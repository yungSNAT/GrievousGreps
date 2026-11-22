import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownReport, mermaidDiagram, textReport } from "../src/blast/render.js";
import type {
  BlastReport, ChangedArea, ImpactedModule, LeftBehind, TestSignal,
} from "../src/blast/blast.js";
import { sinceLabel, type Owner } from "../src/blast/owners.js";

function area(label: string, files: string[], tests: TestSignal = "na"): ChangedArea {
  const reaches = tests === "changed" || tests === "stale";
  const testFiles = reaches ? [files[0].replace(/\.ts$/, ".test.ts")] : [];
  return {
    label, labelSource: "concept", key: label, files, seeds: 1, tests, testFiles,
    changedTestFiles: tests === "changed" ? testFiles : [],
    reached: reaches ? 1 : 0,
    behavioural: tests === "na" ? 0 : 1,
    unreached: tests === "none" ? ["update"] : [],
    seedNames: [tests === "na" ? "Options" : "update"],
  };
}

function affected(label: string, from: string[], count = 1): ImpactedModule {
  const path = `${label}.ts`;
  return {
    label, labelSource: "concept", key: label, files: [path], from,
    symbols: Array.from({ length: count }, (_, i) => ({
      id: `${path}#${label}${i}`, name: `${label}${i}`, kind: "function",
      path, span: "L1-L3", relation: "calls", depth: 1,
    })),
  };
}

function report(overrides: Partial<BlastReport> = {}): BlastReport {
  const paths = new Set(
    (overrides.areas ?? []).flatMap((a) => [...a.files, ...a.changedTestFiles]),
  );
  return {
    basis: "main...HEAD",
    depth: 2,
    changed: [...paths].map((path) => ({
      path, status: "modified" as const, ranges: [{ start: 1, end: 1 }],
    })),
    unindexed: [],
    deleted: [],
    seeds: [],
    impacted: [],
    modules: [],
    testModules: [],
    areas: [],
    ...overrides,
  };
}

test("a types-only change with no resolved dependents has no diagram or test warning", () => {
  const r = report({ areas: [area("options", ["options.ts"])] });
  const md = markdownReport(r);

  assert.equal(mermaidDiagram(r), null);
  assert.match(md, /^\*\*No resolved dependents\.\*\* 1 area changed; no indexed dependents at depth 2\.$/m);
  assert.match(md, /^- – \*\*options\*\* — no function, method or class changed here$/m);
  assert.doesNotMatch(md, /```mermaid|^\| Can be affected|^Tests:|^Tag:/m);
  assert.match(md, / · main\.\.\.HEAD · depth 2 · 1 changed file<\/sub>\n$/);
});

test("the no-dependents headline counts unresolved calls, not just unresolved names", () => {
  const areas = [area("parser", ["parse.ts"]), area("lexer", ["scan.ts"])];
  const unresolved = [
    { name: "parse", calls: 1 },
    { name: "scan", calls: 2 },
  ] as NonNullable<BlastReport["unresolved"]>;

  const single = markdownReport(report({ areas, unresolved: unresolved.slice(0, 1) }));
  assert.match(single, /^\*\*No resolved dependents; 1 unresolved call names a changed symbol\.\*\*/m);
  assert.match(single, /^⚠️ 1 call naming a changed symbol \(parse \(1\)\) did not resolve/m);

  const multiple = markdownReport(report({ areas, unresolved, depth: Infinity }));
  assert.match(multiple, /^\*\*No resolved dependents; 3 unresolved calls name a changed symbol\.\*\* 2 areas changed; no indexed dependents at full closure\.$/m);
  assert.match(multiple, /^⚠️ 3 calls naming a changed symbol \(parse \(1\), scan \(2\)\) did not resolve/m);
  assert.doesNotMatch(multiple, /```mermaid/);
  assert.match(multiple, / · main\.\.\.HEAD · full closure · 2 changed files<\/sub>\n$/);
});

test("the impact table deduplicates source areas and summarizes modules beyond its cap", () => {
  const areas = [
    area("parser", ["parse.ts", "tokens.ts"], "changed"),
    area("formatter", ["format.ts"], "changed"),
    area("schema", ["schema.ts"]),
    area("storage", ["store.ts"]),
  ];
  const modules = [
    affected("routes", ["parse.ts", "tokens.ts", "format.ts", "schema.ts", "store.ts"]),
    ...["api", "cli", "cache", "ui", "jobs"].map((label) => affected(label, ["parse.ts"])),
    affected("workers", ["tokens.ts"], 2),
    affected("webhooks", ["format.ts"], 3),
    affected("exports", ["schema.ts"]),
    affected("diagnostics", ["store.ts"], 4),
  ];
  const md = markdownReport(report({ areas, modules }));
  const rows = md.split("\n").filter((line) => line.startsWith("| "));

  assert.match(md, /^\*\*4 areas changed → 10 areas can be affected\.\*\* 16 dependent symbols, depth 2\.$/m);
  assert.match(md, /^Tests: 2 areas updated their tests\.$/m);
  assert.equal(rows.length, 9, "header, divider, six named rows, and one overflow row");
  assert.equal(rows[2], "| routes | 1 | `routes.ts:L1-L3` routes0 — calls, depth 1 | parser, formatter +2 |");
  assert.equal(rows.at(-1), "| _4 smaller areas_ | 10 | workers, webhooks, exports, … | see below |");
  assert.match(md, /^\*\*diagnostics\*\* — 4 symbols in 1 file$/m);
});

test("left-behind callers point to the call line when known and the span otherwise", () => {
  const seed = { id: "parse.ts#parse", name: "parse", kind: "function", path: "parse.ts", span: "L1-L5" };
  const leftBehind = [
    { name: "serve", path: "server.ts", span: "L10-L20", line: 14, seed },
    { name: "loadConfig", path: "config.ts", span: "L8-L12", seed, inferred: true },
  ] as LeftBehind[];
  const r = report({
    areas: [area("parser", ["parse.ts"], "none")],
    modules: [
      affected("server", ["parse.ts"]),
      affected("config", ["parse.ts"]),
    ],
    leftBehind,
  });

  const md = markdownReport(r);
  const warning = md.split("\n").find((line) => line.startsWith("⚠️ **2 callers left behind**"));
  assert.ok(warning, "the declaration-change warning is shown");
  assert.ok(warning.includes("`serve` (`server.ts:14`), `loadConfig` (`config.ts:L8-L12`) [inferred]"));
  assert.ok(warning.endsWith("The diff did not edit their calls."));

  const text = textReport(r);
  assert.match(text, /^⚠ 2 callers left behind: each calls a symbol whose declaration changed/m);
  assert.match(text, /^  parse ← serve \(server\.ts:14\)$/m);
  assert.match(text, /^  parse ← loadConfig \(config\.ts:L8-L12\) \[inferred\]$/m);
});

test("reviewer suggestions count broad ownership and preserve named rows under the cap", () => {
  const now = Date.UTC(2025, 0, 20);
  const day = 24 * 60 * 60 * 1000;
  const dana = {
    name: "Dana Reyes", email: "dana@users.noreply.github.com", handle: "dana",
    commits: 4, last: now - 9 * day,
  } as Owner;
  const robin = {
    name: "Robin Park", email: "robin@example.com", commits: 1, last: now - 2 * day,
  } as Owner;
  const areas = [
    area("local config", ["local.ts"]),
    { ...area("scripts", ["scripts.ts"]), owners: [] },
    area("scratch", ["scratch.ts"]),
    area("notes", ["notes.ts"]),
    { ...area("parser", ["parse.ts"]), owners: [dana, robin] },
    { ...area("planner", ["plan.ts"]), owners: [dana] },
  ];
  const modules = [
    { ...affected("pipeline", ["parse.ts"]), owners: [dana] },
    { ...affected("workflow", ["plan.ts"]), owners: [dana] },
    { ...affected("cli", ["parse.ts"]), owners: [robin] },
    { ...affected("api", ["plan.ts"]), owners: [dana] },
  ];
  const reviewers = [
    { ...dana, areas: ["parser", "planner", "pipeline", "workflow", "api"] },
    { ...robin, areas: ["parser", "cli"] },
  ] as NonNullable<BlastReport["reviewers"]>;

  const clock = mock.method(Date, "now", () => now);
  let md: string;
  try {
    md = markdownReport(report({ areas, modules, reviewers }));
  } finally {
    clock.mock.restore();
  }

  const tag = "Tag: @dana — 5 of 10 areas · **Robin Park** — parser, cli";
  assert.match(md, /^Tag: @dana — 5 of 10 areas · \*\*Robin Park\*\* — parser, cli$/m);
  assert.ok(md.indexOf(tag) < md.indexOf("```mermaid"), "the tag appears above the diagram");
  assert.match(md, /<summary><strong>Who knows this code<\/strong> — 2 people across 10 areas<\/summary>/);

  const rows = md.split("\n").filter((line) => line.startsWith("| **"));
  assert.deepEqual(rows.map((line) => line.split(" | ")[0]), [
    "| **parser** · changed",
    "| **planner** · changed",
    "| **pipeline** · affected",
    "| **workflow** · affected",
    "| **cli** · affected",
    "| **api** · affected",
    "| **local config** · changed",
    "| **scripts** · changed",
  ]);
  assert.ok(rows[0].includes(`@dana — 4 commits, last ${sinceLabel(dana.last, now)}`));
  assert.match(rows[0], /Robin Park(?:\*\*)? — 1 commit, last /);
  for (const row of rows.slice(-2)) {
    assert.ok(row.endsWith(" | _only you — nobody else has touched these files_ |"));
  }
  assert.match(md, /^\| _…2 further areas_ \| \|$/m);
});

describe("markdown evidence from a checkout", () => {
  let root: string;
  // This report has no seed symbols, so the excerpt must refer to the changed
  // file itself. The bare call on line 2 does not identify that file.
  const reachingLine = 'import { readExpression } from "./parse.js";';

  before(() => {
    root = mkdtempSync(join(tmpdir(), "blast-render-gaps-"));
    writeFileSync(join(root, "parse.ts"), "export const readExpression = () => 42;\n");
    writeFileSync(
      join(root, "adapter.ts"),
      `${reachingLine}\nexport const adapter0 = () => readExpression();\n`,
    );
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("missing source suppresses only that symbol's excerpt, not its entry", () => {
    const r = report({
      areas: [area("parser", ["parse.ts"], "none")],
      modules: [affected("adapter", ["parse.ts"]), affected("legacy", ["parse.ts"])],
    });
    const md = markdownReport(r, { root });
    const lines = md.split("\n");
    const present = "- `adapter.ts:L1-L3` — adapter0 (calls, depth 1)";
    const missing = "- `legacy.ts:L1-L3` — legacy0 (calls, depth 1)";
    const summary = lines.findIndex((line) => line.includes("<strong>All 2 dependent symbols</strong>"));
    assert.ok(summary >= 0);
    const presentIndex = lines.indexOf(present);
    const missingIndex = lines.indexOf(missing);
    assert.ok(presentIndex > summary && missingIndex > presentIndex);
    assert.equal(lines[presentIndex + 1], `  \`\`\`1: ${reachingLine}\`\`\``);
    assert.equal(lines[missingIndex + 1], "", "no excerpt is emitted for the missing file");

    const bare = markdownReport(r);
    assert.ok(bare.includes(present) && bare.includes(missing));
    assert.ok(!bare.includes(reachingLine), "entries are retained without a checkout");
  });
});
