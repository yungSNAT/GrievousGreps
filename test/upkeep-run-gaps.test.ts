/**
 * Gap tests for src/upkeep-run.ts: the trail-switch opt-out, replaying wiring
 * for hosts other than Claude Code (with a laptop list that declines claude's
 * global writes), the committed-link guard, and a graft-wired repo moving to
 * trail once the trail command is on PATH. Made-up repos and homes only.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { runUpkeep, shouldMoveToTrail } from "../src/upkeep-run.js";
import { stampPath } from "../src/upkeep.js";
import { BRAND_ENV, repoWiredForTrail } from "../src/brand.js";
import { linkOutOfRepo } from "../src/init/install-paths.js";
import { runInit } from "../src/claude/init.js";

const made: string[] = [];
function scratch(tag: string): string {
  const d = tmpRepo(tag);
  made.push(d);
  return d;
}
after(() => {
  for (const d of made) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const KEYS = ["HOME", "USERPROFILE", "TRAIL_HOME", BRAND_ENV, "PATH", "GRAFT_NO_TRAIL_SWITCH"] as const;
/** Run fn with a scratch home in the env, restoring every key afterwards. */
function withHome<T>(home: string, fn: () => T, extra: Record<string, string | undefined> = {}): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of Object.keys(extra)) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.TRAIL_HOME = join(home, ".trail");
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

function gitRepo(tag: string): string {
  const repo = scratch(tag);
  for (const args of [["init", "-q"], ["config", "user.name", "upkeep test"], ["config", "user.email", "upkeep@example.invalid"], ["config", "commit.gpgsign", "false"]]) {
    assert.equal(spawnSync("git", args, { cwd: repo }).status, 0, `git ${args.join(" ")}`);
  }
  return repo;
}

function writeStamp(repo: string, version: string, hosts: string[], opts: Record<string, unknown>): void {
  mkdirSync(join(stampPath(repo), ".."), { recursive: true });
  writeFileSync(stampPath(repo), JSON.stringify({ version, hosts, opts, at: "2026-10-15T00:00:00.000Z" }));
}

describe("shouldMoveToTrail", () => {
  test("GRAFT_NO_TRAIL_SWITCH=1 keeps a machine on graft whatever the repo looks like", () => {
    const repo = gitRepo("upk-noswitch");
    assert.equal(shouldMoveToTrail(repo, { GRAFT_NO_TRAIL_SWITCH: "1", PATH: process.env.PATH }), false);
  });

  test("a repo without Claude Code wiring never moves", () => {
    const repo = gitRepo("upk-nowiring");
    assert.equal(shouldMoveToTrail(repo, { PATH: process.env.PATH }), false);
  });
});

describe("runUpkeep", () => {
  test("a stamp at the running version refreshes nothing and shows no lines", () => {
    const repo = gitRepo("upk-same");
    const home = scratch("upk-same-home");
    writeStamp(repo, "99.0.0", ["claude"], { global: false, mcp: true, hooks: true, statusline: false });
    const r = withHome(home, () => runUpkeep(repo, "99.0.0", { background: false, home }));
    assert.deepEqual(r.lines, []);
  });

  test("an older stamp with codex replays the other hosts too, honouring a laptop list without claude", () => {
    const repo = gitRepo("upk-others");
    const home = scratch("upk-others-home");
    writeStamp(repo, "0.23.0", ["claude", "codex"], { global: true, laptop: ["codex"], mcp: true, hooks: true, statusline: false });
    const r = withHome(home, () => runUpkeep(repo, "99.0.0", { background: false, home }), { GRAFT_NO_TRAIL_SWITCH: "1" });
    const text = r.lines.join("\n");
    assert.match(text, /refreshed this repo's agent wiring \(written by 0\.23\.0, now 99\.0\.0\)/);
    assert.match(text, /codex/);
    // The laptop list leaves claude out, so its ~/.claude shim is not written.
    assert.equal(existsSync(join(home, ".claude", "helpers", "graft-hooks.cjs")), false);
  });

  test("a committed link that leaves the repo stops the refresh, fail-soft", (t) => {
    const repo = gitRepo("upk-link");
    const home = scratch("upk-link-home");
    const outside = scratch("upk-link-outside");
    try {
      symlinkSync(outside, join(repo, ".claude"), "dir");
    } catch {
      t.skip("symlinks are not available here");
      return;
    }
    assert.equal(spawnSync("git", ["add", "-A"], { cwd: repo }).status, 0, "git add");
    assert.equal(spawnSync("git", ["commit", "-q", "-m", "link"], { cwd: repo }).status, 0, "git commit");
    assert.ok(withHome(home, () => linkOutOfRepo(repo, homedir())), "the committed link is flagged as leaving the repo");
    writeStamp(repo, "0.23.0", ["claude"], { global: false, mcp: true, hooks: true, statusline: false });
    const r = withHome(home, () => runUpkeep(repo, "99.0.0", { background: false, home }), { GRAFT_NO_TRAIL_SWITCH: "1" });
    assert.equal(r.lines.some((l) => /refreshed this repo's agent wiring/.test(l)), false);
    assert.equal(existsSync(join(outside, "settings.json")), false, "nothing written through the link");
    assert.equal(JSON.parse(readFileSync(stampPath(repo), "utf8")).version, "0.23.0", "stamp left as it was");
  });

  test("a graft-wired repo moves to trail once the trail command is on PATH", () => {
    const repo = gitRepo("upk-totrail");
    const home = scratch("upk-totrail-home");
    const bin = scratch("upk-totrail-bin");
    const sh = join(bin, "trail");
    writeFileSync(sh, "#!/bin/sh\necho 99.0.0\n");
    try { chmodSync(sh, 0o755); } catch { /* windows */ }
    writeFileSync(join(bin, "trail.cmd"), "@echo 99.0.0\r\n");
    const path = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    withHome(home, () => {
      runInit(repo, { global: false, build: false, home, brand: "graft" } as Parameters<typeof runInit>[1]);
      writeStamp(repo, "0.1.0", ["claude"], { global: false, mcp: true, hooks: true, statusline: false });
      assert.equal(shouldMoveToTrail(repo), true, "the graft-wired repo is ready to move");
      const r = runUpkeep(repo, "99.0.0", { background: false, home });
      const text = r.lines.join("\n");
      assert.match(text, /graft is now trail, and this repo just moved to it/);
      assert.match(text, /\.trail\/learnings\//);
      assert.equal(repoWiredForTrail(repo), true, "the repo now speaks trail");
      assert.equal(existsSync(join(repo, ".trail")), true, "the repo got its .trail/");
      assert.equal(shouldMoveToTrail(repo), false, "it moves only once");
    }, { PATH: path, [BRAND_ENV]: undefined, GRAFT_NO_TRAIL_SWITCH: undefined });
  });
});
