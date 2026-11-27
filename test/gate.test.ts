import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph } from "../src/graph/build.js";
import type { Confidence, EdgeV1, GraphV1, NodeV1, Relation } from "../src/graph/types.js";
import {
  buildBaseline,
  evaluateGate,
  formatGateJson,
  formatGateMarkdown,
  formatGateText,
  parseGateBaseline,
  parseGateConfig,
  type GateBaseline,
} from "../src/gate/gate.js";
import { runGateCommand, type GateCliOptions } from "../src/gate/gate-cli.js";
import { homeEnv, tmpRepo } from "./helpers.js";

const dirs: string[] = [];
function scratch(tag: string): string {
  const d = tmpRepo(tag);
  dirs.push(d);
  return d;
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function node(
  id: string,
  path: string,
  span = "L1-L5",
  kind: NodeV1["kind"] = "function",
  origin: NodeV1["origin"] = "ast",
): NodeV1 {
  const hashIdx = id.lastIndexOf("#");
  const name = hashIdx === -1 ? path : id.slice(hashIdx + 1);
  return {
    id,
    name,
    kind,
    path,
    span,
    signature: kind === "file" ? null : `${name}()`,
    exported: true,
    origin,
    body_hash: "h",
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

function edge(
  source: string,
  target: string,
  relation: Relation = "calls",
  confidence: Confidence = "extracted",
): EdgeV1 {
  return { source, target, relation, confidence };
}

function graphOf(nodes: NodeV1[], edges: EdgeV1[]): GraphV1 {
  return {
    meta: {
      version: 1,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      languages: ["typescript"],
    },
    nodes,
    edges,
  };
}

async function captureRun(dir: string, opts: GateCliOptions) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErr = console.error;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  };
  try {
    const code = await runGateCommand(dir, opts);
    return { code, stdout: stdout.join(""), stderr: stderr.join("\n") };
  } finally {
    process.stdout.write = origWrite;
    console.error = origErr;
  }
}

function runTrailCli(args: string[], cwd: string, home: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...homeEnv(home),
    DO_NOT_TRACK: "1",
  };
  delete env.CLAUDECODE;
  delete env.GRAFT_NO_GITIGNORE;
  delete env.GRAFT_NO_IGNORE;
  const r = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/bin/trail.ts", import.meta.url)), ...args],
    {
      cwd,
      env,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("parseGateConfig and parseGateBaseline", () => {
  test("parses valid rules and normalizes globs", () => {
    const cfg = parseGateConfig({
      rules: [
        {
          name: "domain-no-infra",
          from: ["./src\\domain\\**"],
          to: ["src/infra/**"],
          relations: ["imports", "calls"],
          allowConfidence: "likely",
        },
      ],
    });
    assert.equal(cfg.rules.length, 1);
    assert.deepEqual(cfg.rules[0]!.from, ["src/domain/**"]);
    assert.deepEqual(cfg.rules[0]!.to, ["src/infra/**"]);
    assert.deepEqual([...cfg.rules[0]!.relations], ["imports", "calls"]);
    assert.equal(cfg.rules[0]!.allowConfidence, "likely");
  });

  test("rejects malformed configs", () => {
    assert.throws(() => parseGateConfig(null), /JSON object/);
    assert.throws(() => parseGateConfig([]), /JSON object/);
    assert.throws(() => parseGateConfig({}), /"rules" array/);
    assert.throws(() => parseGateConfig({ rules: [null] }), /must be an object/);
    assert.throws(() => parseGateConfig({ rules: [{ name: "", from: ["a"], to: ["b"] }] }), /non-empty string/);
    assert.throws(
      () =>
        parseGateConfig({
          rules: [
            { name: "dup", from: ["a/**"], to: ["b/**"] },
            { name: "dup", from: ["c/**"], to: ["d/**"] },
          ],
        }),
      /duplicate rule name/,
    );
    assert.throws(() => parseGateConfig({ rules: [{ name: "r", from: [], to: ["b"] }] }), /non-empty array/);
    assert.throws(() => parseGateConfig({ rules: [{ name: "r", from: ["./"], to: ["b"] }] }), /empty glob/);
    assert.throws(() => parseGateConfig({ rules: [{ name: "r", from: ["src/[abc"], to: ["b"] }] }), /unclosed "\["/);
    assert.throws(() => parseGateConfig({ rules: [{ name: "r", from: ["src/[]"], to: ["b"] }] }), /empty character class/);
    assert.throws(() => parseGateConfig({ rules: [{ name: "r", from: ["src/{a,b"], to: ["b"] }] }), /unclosed "\{"/);
    assert.throws(() => parseGateConfig({ rules: [{ name: "r", from: ["a"], to: ["b"], relations: [] }] }), /non-empty array/);
    assert.throws(
      () => parseGateConfig({ rules: [{ name: "r", from: ["a"], to: ["b"], relations: ["bogus"] }] }),
      /unknown relation/,
    );
    assert.throws(
      () => parseGateConfig({ rules: [{ name: "r", from: ["a"], to: ["b"], allowConfidence: "lsp_resolved" }] }),
      /allowConfidence/,
    );
  });

  test("parses, deduplicates, and sorts baseline entries, rejecting invalid baselines", () => {
    const b = parseGateBaseline({
      version: 1,
      violations: [
        { rule: "z", sourceId: "b#x", targetId: "c#y" },
        { rule: "a", sourceId: "a#1", targetId: "b#2" },
        { rule: "a", sourceId: "a#1", targetId: "b#2" },
      ],
    });
    assert.deepEqual(b.violations, [
      { rule: "a", sourceId: "a#1", targetId: "b#2" },
      { rule: "z", sourceId: "b#x", targetId: "c#y" },
    ]);
    assert.throws(() => parseGateBaseline({ version: 2, violations: [] }), /unsupported baseline version/);
    assert.throws(() => parseGateBaseline({ version: 1, violations: "bad" }), /"violations" array/);
    assert.throws(() => parseGateBaseline({ version: 1, violations: [{ rule: "r", sourceId: "", targetId: "t" }] }), /sourceId/);
  });
});

describe("evaluateGate, confidence categories, baseline, and ratchet", () => {
  test("clean graph passes with zero violations and zero warnings", () => {
    const g = graphOf(
      [node("src/domain/a.ts#fn", "src/domain/a.ts"), node("src/domain/b.ts#fn", "src/domain/b.ts")],
      [edge("src/domain/a.ts#fn", "src/domain/b.ts#fn", "calls", "extracted")],
    );
    const cfg = parseGateConfig({
      rules: [{ name: "domain-no-infra", from: ["src/domain/**"], to: ["src/infra/**"] }],
    });
    const res = evaluateGate(g, cfg);
    assert.equal(res.ok, true);
    assert.equal(res.violations.length, 0);
    assert.equal(res.warnings.length, 0);
  });

  test("tracks multiple violating symbols between the same file pair independently and detects renames", () => {
    const nA1 = node("src/a.ts#alpha", "src/a.ts", "L10-L15");
    const nA2 = node("src/a.ts#beta", "src/a.ts", "L20-L25");
    const nB1 = node("src/b.ts#helperOne", "src/b.ts", "L1-L4");
    const nB2 = node("src/b.ts#helperTwo", "src/b.ts", "L6-L9");
    const cfg = parseGateConfig({
      rules: [{ name: "a-no-b", from: ["src/a.ts"], to: ["src/b.ts"] }],
    });

    const g1 = graphOf(
      [nA1, nA2, nB1, nB2],
      [
        edge("src/a.ts#beta", "src/b.ts#helperTwo", "calls", "extracted"),
        edge("src/a.ts#alpha", "src/b.ts#helperOne", "calls", "extracted"),
      ],
    );
    const r1 = evaluateGate(g1, cfg);
    assert.equal(r1.ok, false);
    assert.equal(r1.violations.length, 2);
    // Deterministic sorting: alpha before beta
    assert.equal(r1.violations[0]!.sourceId, "src/a.ts#alpha");
    assert.equal(r1.violations[0]!.sourceLine, 10);
    assert.equal(r1.violations[1]!.sourceId, "src/a.ts#beta");
    assert.equal(r1.violations[1]!.sourceLine, 20);

    // Accept both into baseline; verify no line numbers in baseline
    const baseline = buildBaseline(r1, null);
    assert.deepEqual(baseline.violations, [
      { rule: "a-no-b", sourceId: "src/a.ts#alpha", targetId: "src/b.ts#helperOne" },
      { rule: "a-no-b", sourceId: "src/a.ts#beta", targetId: "src/b.ts#helperTwo" },
    ]);

    // Shift line numbers (edits above symbols): still accepted
    const gMoved = graphOf(
      [
        node("src/a.ts#alpha", "src/a.ts", "L40-L45"),
        node("src/a.ts#beta", "src/a.ts", "L50-L55"),
        nB1,
        nB2,
      ],
      g1.edges,
    );
    const rMoved = evaluateGate(gMoved, cfg, baseline);
    assert.equal(rMoved.ok, true);
    assert.equal(rMoved.accepted.length, 2);
    assert.equal(rMoved.accepted[0]!.sourceLine, 40);

    // Rename alpha -> alphaRenamed: unmatched edge fails as new, old baseline entry becomes resolved
    const gRenamed = graphOf(
      [
        node("src/a.ts#alphaRenamed", "src/a.ts", "L40-L45"),
        node("src/a.ts#beta", "src/a.ts", "L50-L55"),
        nB1,
        nB2,
      ],
      [
        edge("src/a.ts#alphaRenamed", "src/b.ts#helperOne", "calls", "extracted"),
        edge("src/a.ts#beta", "src/b.ts#helperTwo", "calls", "extracted"),
      ],
    );
    const rRenamed = evaluateGate(gRenamed, cfg, baseline);
    assert.equal(rRenamed.ok, false);
    assert.deepEqual(
      rRenamed.violations.map((v) => v.sourceId),
      ["src/a.ts#alphaRenamed"],
    );
    assert.deepEqual(
      rRenamed.accepted.map((v) => v.sourceId),
      ["src/a.ts#beta"],
    );
    assert.deepEqual(rRenamed.resolved, [
      { rule: "a-no-b", sourceId: "src/a.ts#alpha", targetId: "src/b.ts#helperOne" },
    ]);
  });

  test("enforces definite edges by default, warns on likely/inferred, and respects allowConfidence opt-in", () => {
    const confidences: Confidence[] = ["lsp_resolved", "lsp_dispatch", "extracted", "likely", "inferred"];
    const nodes: NodeV1[] = [node("src/t.ts#target", "src/t.ts")];
    const edges: EdgeV1[] = [];
    for (const c of confidences) {
      const id = `src/s.ts#call_${c}`;
      nodes.push(node(id, "src/s.ts"));
      edges.push(edge(id, "src/t.ts#target", "calls", c));
    }
    const g = graphOf(nodes, edges);

    // Default (extracted)
    const defCfg = parseGateConfig({ rules: [{ name: "no-t", from: ["src/s.ts"], to: ["src/t.ts"] }] });
    const defRes = evaluateGate(g, defCfg);
    assert.equal(defRes.ok, false);
    assert.deepEqual(
      defRes.violations.map((v) => v.confidence).sort(),
      ["extracted", "lsp_dispatch", "lsp_resolved"],
    );
    assert.deepEqual(
      defRes.warnings.map((v) => v.confidence).sort(),
      ["inferred", "likely"],
    );

    // Explicit allowConfidence: "likely" enforces likely + definite; inferred remains warning
    const likelyCfg = parseGateConfig({
      rules: [{ name: "no-t", from: ["src/s.ts"], to: ["src/t.ts"], allowConfidence: "likely" }],
    });
    const likelyRes = evaluateGate(g, likelyCfg);
    assert.equal(likelyRes.ok, false);
    assert.deepEqual(
      likelyRes.violations.map((v) => v.confidence).sort(),
      ["extracted", "likely", "lsp_dispatch", "lsp_resolved"],
    );
    assert.deepEqual(
      likelyRes.warnings.map((v) => v.confidence),
      ["inferred"],
    );

    // Explicit allowConfidence: "inferred" enforces all categories
    const infCfg = parseGateConfig({
      rules: [{ name: "no-t", from: ["src/s.ts"], to: ["src/t.ts"], allowConfidence: "inferred" }],
    });
    const infRes = evaluateGate(g, infCfg);
    assert.equal(infRes.ok, false);
    assert.equal(infRes.violations.length, 5);
    assert.equal(infRes.warnings.length, 0);

    // Warnings alone do not fail the gate
    const warnOnlyGraph = graphOf(
      [node("src/s.ts#w1", "src/s.ts"), node("src/s.ts#w2", "src/s.ts"), node("src/t.ts#target", "src/t.ts")],
      [
        edge("src/s.ts#w1", "src/t.ts#target", "calls", "likely"),
        edge("src/s.ts#w2", "src/t.ts#target", "calls", "inferred"),
      ],
    );
    const warnOnlyRes = evaluateGate(warnOnlyGraph, defCfg);
    assert.equal(warnOnlyRes.ok, true);
    assert.equal(warnOnlyRes.violations.length, 0);
    assert.equal(warnOnlyRes.warnings.length, 2);
  });

  test("matches imports, calls, and deployment-node edges across forbidden paths and skips unresolved imports", () => {
    const g = graphOf(
      [
        node("src/web/app.ts", "src/web/app.ts", "L1-L20", "file"),
        node("src/web/app.ts#handle", "src/web/app.ts", "L5-L12", "function"),
        node("src/db/pool.ts", "src/db/pool.ts", "L1-L10", "file"),
        node("src/db/pool.ts#query", "src/db/pool.ts", "L2-L8", "function"),
        node("deploy/Dockerfile#web", "deploy/Dockerfile", "L3-L7", "resource", "deploy"),
        node("src/secret/key.ts", "src/secret/key.ts", "L1-L2", "file"),
      ],
      [
        edge("src/web/app.ts", "src/db/pool.ts", "imports", "extracted"),
        edge("src/web/app.ts#handle", "src/db/pool.ts#query", "calls", "extracted"),
        edge("src/web/app.ts", "node:fs", "imports", "extracted"), // unresolved external module
        edge("deploy/Dockerfile#web", "src/secret/key.ts", "references", "extracted"),
        edge("src/web/app.ts", "src/web/app.ts#handle", "contains", "extracted"), // structural contains skipped by default
      ],
    );

    const cfg = parseGateConfig({
      rules: [
        { name: "web-no-db-calls", from: ["src/web/**"], to: ["src/db/**"], relations: ["calls"] },
        { name: "web-no-db-imports", from: ["src/web/**"], to: ["src/db/**"], relations: ["imports"] },
        { name: "deploy-no-secret", from: ["deploy/**"], to: ["src/secret/**"] },
        { name: "no-self-contains", from: ["src/web/**"], to: ["src/web/**"] },
      ],
    });
    const res = evaluateGate(g, cfg);
    assert.equal(res.ok, false);
    assert.deepEqual(
      res.violations.map((v) => `${v.rule}:${v.relation}:${v.sourceId}->${v.targetId}`),
      [
        "deploy-no-secret:references:deploy/Dockerfile#web->src/secret/key.ts",
        "web-no-db-calls:calls:src/web/app.ts#handle->src/db/pool.ts#query",
        "web-no-db-imports:imports:src/web/app.ts->src/db/pool.ts",
      ],
    );
  });

  test("buildBaseline with --ratchet removes resolved entries without adding new ones", () => {
    const existing: GateBaseline = {
      version: 1,
      violations: [
        { rule: "r1", sourceId: "src/a.ts#old1", targetId: "src/b.ts#t1" },
        { rule: "r1", sourceId: "src/a.ts#kept", targetId: "src/b.ts#t2" },
      ],
    };
    const g = graphOf(
      [
        node("src/a.ts#kept", "src/a.ts", "L1-L2"),
        node("src/a.ts#brandNew", "src/a.ts", "L5-L8"),
        node("src/b.ts#t2", "src/b.ts", "L1-L2"),
        node("src/b.ts#t3", "src/b.ts", "L4-L5"),
      ],
      [
        edge("src/a.ts#kept", "src/b.ts#t2", "calls", "extracted"),
        edge("src/a.ts#brandNew", "src/b.ts#t3", "calls", "extracted"),
      ],
    );
    const cfg = parseGateConfig({ rules: [{ name: "r1", from: ["src/a.ts"], to: ["src/b.ts"] }] });
    const res = evaluateGate(g, cfg, existing);

    const ratcheted = buildBaseline(res, existing, { ratchet: true });
    assert.deepEqual(ratcheted.violations, [{ rule: "r1", sourceId: "src/a.ts#kept", targetId: "src/b.ts#t2" }]);

    const fullUpdate = buildBaseline(res, existing, { ratchet: false });
    assert.deepEqual(fullUpdate.violations, [
      { rule: "r1", sourceId: "src/a.ts#brandNew", targetId: "src/b.ts#t3" },
      { rule: "r1", sourceId: "src/a.ts#kept", targetId: "src/b.ts#t2" },
    ]);
  });

  test("formatters render text, markdown, and json deterministically", () => {
    const g = graphOf(
      [node("src/a.ts#fn", "src/a.ts", "L12-L16"), node("src/b.ts#db", "src/b.ts", "L1-L3")],
      [
        edge("src/a.ts#fn", "src/b.ts#db", "calls", "extracted"),
        edge("src/a.ts#fn", "src/b.ts#db", "references", "likely"),
      ],
    );
    const cfg = parseGateConfig({ rules: [{ name: "r|1", from: ["src/a.ts"], to: ["src/b.ts"] }] });
    const res = evaluateGate(g, cfg, {
      version: 1,
      violations: [{ rule: "r|1", sourceId: "src/a.ts#gone", targetId: "src/b.ts#db" }],
    });

    const text = formatGateText(res);
    assert.match(text, /gate: FAIL — 1 new violation/);
    assert.match(text, /src\/a\.ts:12/);
    assert.match(text, /Warnings \(1, non-failing confidence\)/);
    assert.match(text, /Resolved baseline entries \(1\)/);

    const md = formatGateMarkdown(res);
    assert.match(md, /^## Architecture Gate: FAIL/m);
    assert.match(md, /r\\\|1/);
    assert.match(md, /### Warnings \(1\)/);

    const parsed = JSON.parse(formatGateJson(res));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.summary.new, 1);
    assert.equal(parsed.summary.warnings, 1);
    assert.equal(parsed.summary.resolved, 1);
  });
});

describe("trail gate CLI and filesystem integration", () => {
  test("rejects missing graph and stale graph explicitly (exit 2)", async () => {
    const dir = scratch("gate-freshness");
    mkdirSync(join(dir, "src", "domain"), { recursive: true });
    mkdirSync(join(dir, "src", "infra"), { recursive: true });
    writeFileSync(join(dir, "src", "infra", "db.ts"), "export function query(): number { return 1; }\n");
    writeFileSync(
      join(dir, "src", "domain", "svc.ts"),
      "import { query } from '../infra/db.js';\nexport function run(): number { return query(); }\n",
    );
    writeFileSync(
      join(dir, "trail.gate.json"),
      JSON.stringify({ rules: [{ name: "domain-no-infra", from: ["src/domain/**"], to: ["src/infra/**"] }] }),
    );

    // 1. Missing graph -> exit 2
    const missing = await captureRun(dir, {});
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /no graph found/);

    // 2. Build real graph, then edit a source file -> stale -> exit 2
    const built = await buildGraph(dir, { reuse: false });
    assert.deepEqual(built.errors, []);
    writeFileSync(
      join(dir, "src", "domain", "svc.ts"),
      "import { query } from '../infra/db.js';\nexport function run(): number { return query() + 1; }\n",
    );
    const stale = await captureRun(dir, {});
    assert.equal(stale.code, 2);
    assert.match(stale.stderr, /stale/);

    // 3. Rebuild -> fresh, missing fingerprint -> stale -> exit 2
    await buildGraph(dir, { reuse: false });
    const cacheDir = join(built.contextDir, ".cache");
    const { readdirSync } = await import("node:fs");
    for (const f of readdirSync(cacheDir)) {
      if (f.startsWith("fingerprint.")) unlinkSync(join(cacheDir, f));
    }
    const noFp = await captureRun(dir, {});
    assert.equal(noFp.code, 2);
    assert.match(noFp.stderr, /no build fingerprint/);
  });

  test("end-to-end build, violation detection, --update-baseline, --ratchet, and CLI process", async () => {
    const dir = scratch("gate-e2e");
    const home = scratch("gate-home");
    mkdirSync(join(dir, "src", "domain"), { recursive: true });
    mkdirSync(join(dir, "src", "infra"), { recursive: true });
    writeFileSync(
      join(dir, "src", "infra", "db.ts"),
      "export function q1(): number { return 1; }\nexport function q2(): number { return 2; }\n",
    );
    writeFileSync(
      join(dir, "src", "domain", "svc.ts"),
      [
        "import { q1, q2 } from '../infra/db.js';",
        "export function first(): number { return q1(); }",
        "export function second(): number { return q2(); }",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "trail.gate.json"),
      JSON.stringify(
        {
          rules: [
            {
              name: "domain-no-infra",
              from: ["src/domain/**"],
              to: ["src/infra/**"],
            },
          ],
        },
        null,
        2,
      ),
    );

    const built = await buildGraph(dir, { reuse: false });
    assert.deepEqual(built.errors, []);

    // Run real `trail gate --format json` subprocess: fails with exit 1
    const failCli = runTrailCli(["gate", dir, "--format", "json"], dir, home);
    assert.equal(failCli.status, 1, failCli.stderr);
    const failJson = JSON.parse(failCli.stdout);
    assert.equal(failJson.ok, false);
    // imports edge + two symbol call edges (first -> q1, second -> q2)
    assert.ok(failJson.summary.new >= 2);
    assert.ok(failJson.violations.some((v: { sourceId: string }) => v.sourceId === "src/domain/svc.ts#first"));
    assert.ok(failJson.violations.some((v: { sourceId: string }) => v.sourceId === "src/domain/svc.ts#second"));

    // Update baseline -> exit 0, writes trail.gate.baseline.json without line numbers
    const updateRes = await captureRun(dir, { updateBaseline: true, format: "json" });
    assert.equal(updateRes.code, 0);
    const baselineRaw = JSON.parse(readFileSync(join(dir, "trail.gate.baseline.json"), "utf8"));
    assert.equal(baselineRaw.version, 1);
    assert.ok(baselineRaw.violations.length >= 2);
    for (const entry of baselineRaw.violations) {
      assert.deepEqual(Object.keys(entry).sort(), ["rule", "sourceId", "targetId"]);
    }

    // Re-run clean -> exit 0
    const cleanCli = runTrailCli(["gate", dir], dir, home);
    assert.equal(cleanCli.status, 0, cleanCli.stderr);
    assert.match(cleanCli.stdout, /gate: PASS/);

    // Fix `first` (removes q1 call) and add `third` (calls q2) -> rebuild -> --ratchet removes `first` but refuses `third` (exit 1)
    writeFileSync(
      join(dir, "src", "domain", "svc.ts"),
      [
        "import { q2 } from '../infra/db.js';",
        "export function first(): number { return 0; }",
        "export function second(): number { return q2(); }",
        "export function third(): number { return q2(); }",
        "",
      ].join("\n"),
    );
    await buildGraph(dir, { reuse: false });

    const ratchetRes = await captureRun(dir, { updateBaseline: true, ratchet: true, format: "json" });
    assert.equal(ratchetRes.code, 1);
    const ratchetJson = JSON.parse(ratchetRes.stdout);
    assert.equal(ratchetJson.baselineUpdated, true);
    assert.equal(ratchetJson.summary.prunedFromBaseline, 1);
    assert.equal(ratchetJson.summary.new, 1);
    assert.deepEqual(
      ratchetJson.violations.map((v: { sourceId: string }) => v.sourceId),
      ["src/domain/svc.ts#third"],
    );
    const afterBaseline = JSON.parse(readFileSync(join(dir, "trail.gate.baseline.json"), "utf8"));
    assert.ok(!afterBaseline.violations.some((e: { sourceId: string }) => e.sourceId === "src/domain/svc.ts#first"));
    assert.ok(!afterBaseline.violations.some((e: { sourceId: string }) => e.sourceId === "src/domain/svc.ts#third"));
  });

  test("rejects bad format, missing/bad config, bad baseline, and symlinks with exit 2", async () => {
    const dir = scratch("gate-errors");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    await buildGraph(dir, { reuse: false });

    // Bad format
    const badFmt = await captureRun(dir, { format: "xml" });
    assert.equal(badFmt.code, 2);

    // Missing config
    const noCfg = await captureRun(dir, {});
    assert.equal(noCfg.code, 2);
    assert.match(noCfg.stderr, /no gate config found/);

    // Bad config JSON
    writeFileSync(join(dir, "trail.gate.json"), "{not json");
    const badCfg = await captureRun(dir, {});
    assert.equal(badCfg.code, 2);
    assert.match(badCfg.stderr, /invalid gate config/);

    // Valid config + invalid baseline
    writeFileSync(join(dir, "trail.gate.json"), JSON.stringify({ rules: [] }));
    writeFileSync(join(dir, "trail.gate.baseline.json"), JSON.stringify({ version: 99, violations: [] }));
    const badBase = await captureRun(dir, {});
    assert.equal(badBase.code, 2);
    assert.match(badBase.stderr, /invalid gate baseline/);

    // Symlinked config refused (skip on Windows if symlink creation requires privilege)
    writeFileSync(join(dir, "real.json"), JSON.stringify({ rules: [] }));
    let symlinkCreated = false;
    try {
      symlinkSync(join(dir, "real.json"), join(dir, "linked.json"));
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      const symRes = await captureRun(dir, { config: "linked.json" });
      assert.equal(symRes.code, 2);
      assert.match(symRes.stderr, /symlink/);
    }
  });
});
