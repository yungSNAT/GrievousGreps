/**
 * Gaps in compile.ts: helper scripts a run executed from a scratch folder (copied in, shared, renamed on a clash,
 * missing, too big), a prior run whose steps can't be kept (skipped, not refused), refusals with no detail, and an
 * unexpected error turned into a "bug" refusal. Synthetic run sheets only.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileRun, type CompileOpts, type CompileResult } from "../src/skills/compile.js";
import { callKind } from "../src/trace/checks.js";
import type { CheckHit, RunCall, RunSheet } from "../src/trace/types.js";
import type { CompiledSkill } from "../src/skills/types.js";
import { tmpRepo } from "./helpers.js";

const KEY = "github.com/acme/widget";
const OPTS: CompileOpts = { repoRoot: "/home/dev/src/widget", home: "/home/dev", platform: "linux", moment: "asked", applies: KEY, taken: () => false };

let seq = 0;
function call(cmd: string | null, o: Partial<RunCall> = {}): RunCall {
  seq++;
  return {
    id: `toolu_${String(seq).padStart(3, "0")}`, at: new Date(Date.UTC(2026, 9, 27, 10, 31, 40) + seq * 20_000).toISOString(), cmd,
    key: KEY, cwd: "", bg: false, failed: false, isError: false, kind: callKind(cmd ?? "", "ship"), src: { use: seq * 1000, result: seq * 1000 + 400 }, ...o,
  } as RunCall;
}
const passed = (family: CheckHit["family"]): CheckHit => ({ family, passed: true, facts: {} });

function sheet(calls: RunCall[], helpers: string[] = [], o: Partial<RunSheet> = {}): RunSheet {
  return {
    v: 1, id: `r-1027-${String(seq).padStart(4, "0")}`, session: "e76b4ca7f1a0", repoKey: KEY, branch: "main", host: "claude", tier: "A", epoch: 1,
    startedAt: "2026-10-27T10:31:40Z", endedAt: "2026-10-27T10:44:05Z", job: "ship", jobWords: ["ship"], sharedWords: [], promptParams: {},
    calls, checkIndex: calls.length - 1, checked: true, end: "done",
    counts: { commands: calls.length, failed: 0, toolCalls: calls.length, edits: 0 }, helpers, skillId: null, ...o,
  } as RunSheet;
}

function ok(r: CompileResult): CompiledSkill {
  if (!r.ok) assert.fail(`refused ${r.reason}: ${r.detail}`);
  return r.skill;
}

/** A ship with one or more extra steps in the middle. */
const ship = (middle: RunCall[]) => [
  call("npm test"),
  ...middle,
  call("git push origin main"),
  call("git ls-remote origin main", { check: passed("ls-remote") }),
];

const fwd = (p: string) => p.replace(/\\/g, "/");
const script = (dir: string, sub: string, file: string, content: string) => {
  const folder = join(dir, sub, "scratchpad");
  mkdirSync(folder, { recursive: true });
  const p = join(folder, file);
  writeFileSync(p, content);
  return fwd(p);
};
const bash = (p: string, extra = "") => call(`bash ${p}${extra}`, { kind: "step" });

let dir = "";
before(() => { dir = tmpRepo("compile-gaps"); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

describe("helper scripts run from a scratch folder", () => {
  test("a helper that ran is copied in, and two steps running it share one copy", () => {
    const p = script(dir, "one", "bump.sh", "#!/bin/sh\necho bumping the version\n");
    const c = ok(compileRun(sheet(ship([bash(p), bash(p, " --again")]), [p]), OPTS));
    assert.equal(c.helpers.length, 1);
    assert.equal(c.helpers[0]!.file, "bump.sh");
    assert.equal(c.helpers[0]!.from, p);
    assert.match(c.helpers[0]!.content, /echo bumping the version/);
    const cmds = c.steps.map((s) => s.cmd);
    const copy = `$HOME/.trail/skills/${c.name}/scripts/bump.sh`;
    assert.ok(cmds.some((s) => s.includes(`bash ${copy}`) && !s.includes("--again")), cmds.join("\n"));
    assert.ok(cmds.some((s) => s.includes(`bash ${copy} --again`)), cmds.join("\n"));
    // The scratch path itself and the placeholder for the skill folder are gone.
    assert.ok(cmds.every((s) => !s.includes(p) && !s.includes("\u0000")));
  });

  test("two helpers with the same file name from different folders get distinct names", () => {
    const a = script(dir, "a", "run.sh", "#!/bin/sh\necho first helper\n");
    const b = script(dir, "b", "run.sh", "#!/bin/sh\necho second helper\n");
    const c = ok(compileRun(sheet(ship([bash(a), bash(b)]), [a, b]), OPTS));
    assert.deepEqual(c.helpers.map((h) => h.file), ["run.sh", "run-2.sh"]);
    assert.deepEqual(c.helpers.map((h) => h.from), [a, b]);
    const cmds = c.steps.map((s) => s.cmd).join("\n");
    assert.ok(cmds.includes(`$HOME/.trail/skills/${c.name}/scripts/run.sh`), cmds);
    assert.ok(cmds.includes(`$HOME/.trail/skills/${c.name}/scripts/run-2.sh`), cmds);
  });

  test("a helper the run listed but that is gone refuses as helper-missing", () => {
    const gone = fwd(join(dir, "gone", "scratchpad", "deploy.sh"));
    const r = compileRun(sheet(ship([bash(gone)]), [gone]), OPTS);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "helper-missing");
    assert.equal(r.detail, gone);
  });

  test("a helper path that is a folder, not a file, refuses as helper-missing", () => {
    const folder = fwd(join(dir, "folder", "scratchpad", "tools"));
    mkdirSync(folder, { recursive: true });
    const r = compileRun(sheet(ship([bash(folder)]), [folder]), OPTS);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "helper-missing");
  });

  test("a helper too long to copy refuses as a scratch path, saying why", () => {
    const body = Array.from({ length: 205 }, (_, n) => `echo line ${n}`).join("\n") + "\n";
    const big = script(dir, "big", "long.sh", body);
    const r = compileRun(sheet(ship([bash(big)]), [big]), OPTS);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "scratch-path");
    assert.equal(r.detail, `${big} (too big, or unsafe to copy)`);
  });

  test("a scratch path the run never listed as a helper refuses with that path", () => {
    const p = script(dir, "unlisted", "x.sh", "#!/bin/sh\necho hi\n");
    const r = compileRun(sheet(ship([bash(p)]), []), OPTS);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "scratch-path");
    assert.equal(r.detail, p);
  });
});

describe("a prior run is read leniently", () => {
  test("steps of the prior that can't be kept are skipped, and the skill still compiles", () => {
    const stray = script(dir, "prior", "stray.sh", "#!/bin/sh\necho stray\n");
    const gone = fwd(join(dir, "prior-gone", "scratchpad", "missing.sh"));
    const prior = sheet(ship([
      bash(stray), // a scratch path that was never a helper: strict would refuse
      bash(gone), // a listed helper that is gone: strict would refuse
      call("npm run build", { kind: "step", secret: "refused" } as Partial<RunCall>), // a secret Trail couldn't name
    ]), [gone], { id: "r-1026-prior" });
    const current = sheet(ship([call("npm run build", { kind: "step" })]), [], { id: "r-1027-now" });
    const c = ok(compileRun(current, { ...OPTS, prior }));
    const cmds = c.steps.map((s) => s.cmd);
    assert.ok(cmds.some((s) => s.includes("npm run build")), cmds.join("\n"));
    assert.ok(cmds.every((s) => !s.includes("scratchpad")), cmds.join("\n"));
    assert.equal(c.helpers.length, 0);
  });
});

describe("refusals", () => {
  test("a step holding a secret Trail can't name refuses with no detail", () => {
    const r = compileRun(sheet(ship([call("npm run deploy", { kind: "step", secret: "refused" } as Partial<RunCall>)])), OPTS);
    assert.deepEqual(r, { ok: false, reason: "secret", detail: "" });
  });

  test("a repeated run with no check refuses as no-check", () => {
    const s = sheet(ship([]), [], { checkIndex: null });
    const r = compileRun(s, { ...OPTS, moment: "repeated" });
    assert.deepEqual(r, { ok: false, reason: "no-check", detail: "" });
  });

  test("more commands counted than kept refuses as too-long overflow", () => {
    const calls = ship([]);
    const s = sheet(calls, [], { counts: { commands: calls.length + 3, failed: 0, toolCalls: calls.length + 3, edits: 0 } } as Partial<RunSheet>);
    assert.deepEqual(compileRun(s, OPTS), { ok: false, reason: "too-long", detail: "overflow" });
  });

  test("a long call cut before its pieces were kept refuses as truncated, naming the command", () => {
    const r = compileRun(sheet(ship([call("npm run release-all", { kind: "step", truncated: true } as Partial<RunCall>)])), OPTS);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "truncated");
    assert.match(r.detail, /npm run release-all/);
  });

  test("an unexpected error is reported as a bug, not thrown", () => {
    const boom = compileRun(sheet(ship([])), { ...OPTS, taken: () => { throw new Error("store unreadable"); } });
    assert.deepEqual(boom, { ok: false, reason: "never-save", detail: "bug: store unreadable" });
    const odd = compileRun(sheet(ship([])), { ...OPTS, taken: () => { throw "plain string"; } });
    assert.deepEqual(odd, { ok: false, reason: "never-save", detail: "bug: plain string" });
  });

  test("an agent-given name that is free is used as is", () => {
    const c = ok(compileRun(sheet(ship([])), { ...OPTS, name: "ship-widget" }));
    assert.equal(c.name, "ship-widget");
    assert.equal(c.source.commands, 3);
  });
});
