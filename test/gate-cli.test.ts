import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph } from "../src/graph/build.js";
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

    const missing = await captureRun(dir, {});
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /no graph found/);

    const built = await buildGraph(dir, { reuse: false });
    assert.deepEqual(built.errors, []);
    writeFileSync(
      join(dir, "src", "domain", "svc.ts"),
      "import { query } from '../infra/db.js';\nexport function run(): number { return query() + 1; }\n",
    );
    const stale = await captureRun(dir, {});
    assert.equal(stale.code, 2);
    assert.match(stale.stderr, /stale/);

    await buildGraph(dir, { reuse: false });

    // 3. Deleted source file -> stale -> exit 2
    unlinkSync(join(dir, "src", "domain", "svc.ts"));
    const deleted = await captureRun(dir, {});
    assert.equal(deleted.code, 2);
    assert.match(deleted.stderr, /stale/);

    // 4. Rebuild + untracked source file -> stale -> exit 2
    writeFileSync(
      join(dir, "src", "domain", "svc.ts"),
      "import { query } from '../infra/db.js';\nexport function run(): number { return query(); }\n",
    );
    await buildGraph(dir, { reuse: false });
    writeFileSync(join(dir, "src", "domain", "extra.ts"), "export const extra = 1;\n");
    const untracked = await captureRun(dir, {});
    assert.equal(untracked.code, 2);
    assert.match(untracked.stderr, /stale/);

    // 5. Rebuild -> fresh, missing fingerprint -> stale -> exit 2
    await buildGraph(dir, { reuse: false });
    const cacheDir = join(built.contextDir, ".cache");
    for (const f of readdirSync(cacheDir)) {
      if (f.startsWith("fingerprint.")) unlinkSync(join(cacheDir, f));
    }
    const noFp = await captureRun(dir, {});
    assert.equal(noFp.code, 2);
    assert.match(noFp.stderr, /no build fingerprint/);

    // 6. Corrupt `{}` wiring.json and malformed node elements -> exit 2
    writeFileSync(join(built.contextDir, ".graph", "wiring.json"), "{}");
    const corrupt = await captureRun(dir, {});
    assert.equal(corrupt.code, 2);
    assert.match(corrupt.stderr, /invalid wiring graph/);

    writeFileSync(join(built.contextDir, ".graph", "wiring.json"), JSON.stringify({ meta: { version: 1 }, nodes: [null], edges: [] }));
    const badNodes = await captureRun(dir, {});
    assert.equal(badNodes.code, 2);
    assert.match(badNodes.stderr, /invalid wiring graph/);

    // 7. Syntactically invalid JSON in wiring.json -> exit 2 (G1)
    writeFileSync(join(built.contextDir, ".graph", "wiring.json"), "{not json");
    const badJsonGraph = await captureRun(dir, {});
    assert.equal(badJsonGraph.code, 2);
    assert.match(badJsonGraph.stderr, /no graph found/);
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

    const failCli = runTrailCli(["gate", dir, "--format", "json"], dir, home);
    assert.equal(failCli.status, 1, failCli.stderr);
    const failJson = JSON.parse(failCli.stdout);
    assert.equal(failJson.ok, false);
    assert.ok(failJson.summary.new >= 2);
    assert.ok(failJson.violations.some((v: { sourceId: string }) => v.sourceId === "src/domain/svc.ts#first"));
    assert.ok(failJson.violations.some((v: { sourceId: string }) => v.sourceId === "src/domain/svc.ts#second"));

    const updateRes = await captureRun(dir, { updateBaseline: true, format: "json" });
    assert.equal(updateRes.code, 0);
    const baselineRaw = JSON.parse(readFileSync(join(dir, "trail.gate.baseline.json"), "utf8"));
    assert.equal(baselineRaw.version, 1);
    assert.ok(baselineRaw.violations.length >= 2);
    for (const entry of baselineRaw.violations) {
      assert.deepEqual(Object.keys(entry).sort(), ["rule", "sourceId", "targetId"]);
    }

    const cleanCli = runTrailCli(["gate", dir], dir, home);
    assert.equal(cleanCli.status, 0, cleanCli.stderr);
    assert.match(cleanCli.stdout, /gate: PASS/);

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

    // Standalone --ratchet without --update-baseline exits 2 and leaves baseline untouched
    const beforeStandalone = readFileSync(join(dir, "trail.gate.baseline.json"), "utf8");
    const standaloneRatchet = await captureRun(dir, { ratchet: true });
    assert.equal(standaloneRatchet.code, 2);
    assert.match(standaloneRatchet.stderr, /--ratchet requires --update-baseline/);
    assert.equal(readFileSync(join(dir, "trail.gate.baseline.json"), "utf8"), beforeStandalone);

    // CLI --format markdown and subdirectory cwd resolution for --config
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(
      join(dir, "sub", "local.gate.json"),
      JSON.stringify({ rules: [{ name: "domain-no-infra", from: ["src/domain/**"], to: ["src/infra/**"] }] }),
    );
    const mdCli = runTrailCli(["gate", "--config", "./local.gate.json", "--format", "markdown"], join(dir, "sub"), home);
    assert.equal(mdCli.status, 1, mdCli.stderr);
    assert.match(mdCli.stdout, /^## Architecture Gate: FAIL/m);

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

    const badFmt = await captureRun(dir, { format: "xml" });
    assert.equal(badFmt.code, 2);

    const noCfg = await captureRun(dir, {});
    assert.equal(noCfg.code, 2);
    assert.match(noCfg.stderr, /no gate config found/);

    writeFileSync(join(dir, "trail.gate.json"), "{not json");
    const badCfg = await captureRun(dir, {});
    assert.equal(badCfg.code, 2);
    assert.match(badCfg.stderr, /invalid gate config/);

    writeFileSync(join(dir, "trail.gate.json"), JSON.stringify({ rules: [] }));
    writeFileSync(join(dir, "trail.gate.baseline.json"), JSON.stringify({ version: 99, violations: [] }));
    const badBase = await captureRun(dir, {});
    assert.equal(badBase.code, 2);
    assert.match(badBase.stderr, /invalid gate baseline/);

    const missingExplicitBase = await captureRun(dir, { baseline: "missing.baseline.json" });
    assert.equal(missingExplicitBase.code, 2);
    assert.match(missingExplicitBase.stderr, /not found/);

    mkdirSync(join(dir, "subdir"), { recursive: true });
    const dirConfig = await captureRun(dir, { config: "subdir" });
    assert.equal(dirConfig.code, 2);
    assert.match(dirConfig.stderr, /not a regular file/);

    const outsideCfg = await captureRun(dir, { config: "../outside.json" });
    assert.equal(outsideCfg.code, 2);
    assert.match(outsideCfg.stderr, /outside/);

    // G2(c): attempted baseline write outside repo exits 2 and creates no external file
    const escapeBase = join(scratch("gate-escape-parent"), "escape.json");
    const outsideWrite = await captureRun(dir, { baseline: escapeBase, updateBaseline: true });
    assert.equal(outsideWrite.code, 2);
    assert.match(outsideWrite.stderr, /outside/);
    assert.equal(existsSync(escapeBase), false);

    // G2(b): symlinked parent directory under repo root rejected on read & --update-baseline write
    const outsideTarget = scratch("gate-symlink-target");
    writeFileSync(join(outsideTarget, "cfg.json"), JSON.stringify({ rules: [] }));
    writeFileSync(join(outsideTarget, "base.json"), JSON.stringify({ version: 1, violations: [] }));
    symlinkSync(outsideTarget, join(dir, "symdir"), process.platform === "win32" ? "junction" : "dir");
    const symDirCfg = await captureRun(dir, { config: "symdir/cfg.json" });
    assert.equal(symDirCfg.code, 2);
    assert.match(symDirCfg.stderr, /symlink/);
    const symDirBase = await captureRun(dir, { baseline: "symdir/base.json" });
    assert.equal(symDirBase.code, 2);
    assert.match(symDirBase.stderr, /symlink/);
    const symDirWrite = await captureRun(dir, { baseline: "symdir/new.json", updateBaseline: true });
    assert.equal(symDirWrite.code, 2);
    assert.match(symDirWrite.stderr, /symlink/);
    assert.equal(existsSync(join(outsideTarget, "new.json")), false);

    // G2(a): symlinked config and baseline leaf rejected on read
    writeFileSync(join(dir, "real.json"), JSON.stringify({ rules: [] }));
    writeFileSync(join(dir, "real-base.json"), JSON.stringify({ version: 1, violations: [] }));
    let symlinkCreated = false;
    try {
      symlinkSync(join(dir, "real.json"), join(dir, "linked.json"), "file");
      symlinkSync(join(dir, "real-base.json"), join(dir, "linked-base.json"), "file");
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      const symRes = await captureRun(dir, { config: "linked.json" });
      assert.equal(symRes.code, 2);
      assert.match(symRes.stderr, /symlink/);
      const symBase = await captureRun(dir, { baseline: "linked-base.json" });
      assert.equal(symBase.code, 2);
      assert.match(symBase.stderr, /symlink/);
    }
  });
});
