import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { markersFor } from "../src/hosts/sections.js";
import {
  UPDATE_TTL_MS,
  compareVersions,
  formatUpdateNudge,
  formatWiringRefresh,
  isNewer,
  maybeRefreshInBackground,
  needsRefresh,
  readStamp,
  readUpdateCache,
  reconcileWiring,
  runningVersion,
  updateCachePath,
  wiredHostIds,
  writeStamp,
} from "../src/upkeep.js";
import { tmpRepo } from "./helpers.js";

// All four hosts read the same managed section in AGENTS.md.
const SHARED_AGENTS_HOSTS = ["agents", "antigravity", "hermes", "pi"];

let scratch: string;

before(() => {
  scratch = tmpRepo("upkeep-gaps");
});

after(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function fixture(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir);
  return dir;
}

function put(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function agentsWithWiring(name: "graft" | "trail"): string {
  const { start, end } = markersFor(name);
  return `# Project notes\n\n${start}\nUse the project index.\n${end}\n`;
}

describe("running version and upgrade nudges", () => {
  test("reports the installed package version from another project's cwd", () => {
    const project = fixture("other-project");
    put(join(project, "package.json"), JSON.stringify({ version: "999.0.0" }));
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(typeof version, "string");

    const cwd = process.cwd();
    try {
      process.chdir(project);
      assert.equal(runningVersion(), version);
    } finally {
      process.chdir(cwd);
    }
  });

  test("compares numeric release components and zero-fills omitted components", () => {
    assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
    assert.equal(compareVersions("1.9.9", "1.10.0"), -1);
    assert.equal(compareVersions("2.4", "2.4.0+build.7"), 0);
    assert.equal(compareVersions("2.4.0-rc.1", "2.4"), 0);
    assert.equal(compareVersions("2.4", "2.4.1"), -1);
    assert.equal(isNewer(undefined, "2.4.0"), false);
  });

  test("only suggests an upgrade when the cached release is ahead", () => {
    assert.equal(formatUpdateNudge("1.8.0", null), null);
    assert.equal(formatUpdateNudge("1.8.0", "1.8.0-rc.1"), null);
    assert.equal(formatUpdateNudge("1.8.0", "1.7.9"), null);
    const nudge = formatUpdateNudge("1.8.0", "1.10.0");
    assert.ok(nudge);
    assert.match(nudge, /1\.8\.0 → 1\.10\.0 available/);
    assert.match(nudge, /`(?:graft|trail) upgrade`/);
  });
});

describe("registry cache", () => {
  test("treats a missing cache as stale and expires a stored answer at the TTL boundary", () => {
    const home = fixture("cache-ttl");
    const path = updateCachePath(home);
    assert.equal(path, join(home, ".graft", "update-check.json"));
    const checkedAt = 2 * UPDATE_TTL_MS;
    assert.equal(readUpdateCache(home), null);
    assert.equal(needsRefresh(readUpdateCache(home), checkedAt), true);

    const answer = { latest: "2.0.0", checkedAt };
    put(path, JSON.stringify(answer));
    const cached = readUpdateCache(home);
    assert.deepEqual(cached, answer);
    assert.equal(needsRefresh(cached, checkedAt + UPDATE_TTL_MS - 1), false);
    assert.equal(needsRefresh(cached, checkedAt + UPDATE_TTL_MS), true);

    put(path, JSON.stringify({ latest: "2.0.0" }));
    assert.equal(needsRefresh(readUpdateCache(home), checkedAt), true);
  });

  test("does not immediately retry a failed registry check", () => {
    const home = fixture("recent-failure");
    const cache = { latest: null, checkedAt: 10_000 };
    put(updateCachePath(home), JSON.stringify(cache));
    assert.equal(
      maybeRefreshInBackground(home, cache.checkedAt + 1, { GRAFT_UPDATE_CHECK: "1", DO_NOT_TRACK: "0" }),
      false,
    );
    assert.deepEqual(readUpdateCache(home), cache);
  });

  test("does not start a background check if it cannot record the attempt", () => {
    const home = fixture("blocked-cache");
    const blocker = dirname(updateCachePath(home));
    writeFileSync(blocker, "not a directory");
    assert.equal(maybeRefreshInBackground(home, 50_000, { GRAFT_UPDATE_CHECK: "1" }), false);
    assert.equal(readUpdateCache(home), null);
    assert.equal(readFileSync(blocker, "utf8"), "not a directory");
  });
});

describe("wiring discovery and refresh", () => {
  test("distinguishes user-owned shared docs from Trail sections and legacy Claude wiring", () => {
    const repo = fixture("wired-hosts");
    put(join(repo, "AGENTS.md"), "# Project instructions\n");
    put(join(repo, "GEMINI.md"), "# Personal workflow\n");
    assert.deepEqual(wiredHostIds(repo), []);

    put(join(repo, "AGENTS.md"), agentsWithWiring("trail"));
    assert.deepEqual(wiredHostIds(repo).sort(), SHARED_AGENTS_HOSTS);

    put(join(repo, ".claude", "helpers", "graft-hooks.cjs"), "// legacy project hook\n");
    assert.deepEqual(wiredHostIds(repo).sort(), [...SHARED_AGENTS_HOSTS, "claude"].sort());
  });

  test("a shared doc path that is a directory does not hide other wired hosts", () => {
    const repo = fixture("bad-shared-doc");
    mkdirSync(join(repo, "GEMINI.md"));
    put(join(repo, ".trail", "hook.cjs"), "// project hook\n");
    assert.deepEqual(wiredHostIds(repo), ["claude"]);
  });

  test("a pre-stamp repo refreshes only the hosts found on disk with repo-local defaults", () => {
    const repo = fixture("pre-stamp");
    const rewrite = mock.fn(() => {});
    assert.equal(reconcileWiring(repo, "2.0.0", { rewrite }), null);
    assert.equal(rewrite.mock.callCount(), 0);
    assert.equal(readStamp(repo), null);

    put(join(repo, "AGENTS.md"), agentsWithWiring("graft"));
    assert.deepEqual(reconcileWiring(repo, "2.0.0", { rewrite }), {
      from: "unwired",
      to: "2.0.0",
      hosts: SHARED_AGENTS_HOSTS,
      global: false,
    });
    assert.equal(rewrite.mock.callCount(), 1);
    assert.deepEqual(rewrite.mock.calls[0].arguments, [
      repo, SHARED_AGENTS_HOSTS, { global: false, mcp: true, hooks: true, statusline: true }, false,
    ]);
    const stamp = readStamp(repo);
    assert.equal(stamp?.version, "2.0.0");
    assert.deepEqual(stamp?.hosts, SHARED_AGENTS_HOSTS);
  });

  test("refreshes the union of stamped and on-disk hosts, then skips repeat work", () => {
    const repo = fixture("refresh-union");
    const opts = { global: false, mcp: false, hooks: false, statusline: true };
    writeStamp(repo, "1.0.0", ["cursor", "agents"], opts, "2025-01-01T00:00:00.000Z");
    // Cursor's rule is missing, while Claude still has its legacy hook.
    put(join(repo, "AGENTS.md"), agentsWithWiring("graft"));
    put(join(repo, ".claude", "helpers", "graft-hooks.cjs"), "// legacy hook\n");

    const rewrite = mock.fn(() => {});
    const hosts = [...SHARED_AGENTS_HOSTS, "claude", "cursor"].sort();
    const result = reconcileWiring(repo, "2.0.0", { rewrite });
    assert.deepEqual(result, { from: "1.0.0", to: "2.0.0", hosts, global: false });
    assert.equal(rewrite.mock.callCount(), 1);
    assert.deepEqual(rewrite.mock.calls[0].arguments, [repo, hosts, opts, false]);
    const stamp = readStamp(repo);
    assert.equal(stamp?.version, "2.0.0");
    assert.deepEqual(stamp?.hosts, hosts);
    assert.deepEqual(stamp?.opts, opts);

    const message = formatWiringRefresh(result);
    assert.ok(message);
    assert.match(message, /written by 1\.0\.0, now 2\.0\.0/);
    assert.doesNotMatch(message, /this machine's/);
    assert.equal(reconcileWiring(repo, "2.0.0", { rewrite }), null);
    assert.equal(rewrite.mock.callCount(), 1);
  });

  test("migration to Trail rewrites wiring even when the stamped version matches", () => {
    const repo = fixture("switch-to-trail");
    writeStamp(repo, "2.0.0", ["agents"], { global: true, statusline: false });
    const rewrite = mock.fn(() => {});
    const result = reconcileWiring(repo, "2.0.0", { rewrite, toTrail: () => true });
    assert.deepEqual(result, {
      from: "2.0.0", to: "2.0.0", hosts: ["agents"], global: true, switched: true,
    });
    assert.equal(rewrite.mock.callCount(), 1);
    assert.deepEqual(rewrite.mock.calls[0].arguments, [
      repo, ["agents"], { global: true, mcp: true, hooks: true, statusline: false }, true,
    ]);
    const message = formatWiringRefresh(result);
    assert.ok(message);
    assert.match(message, /graft is now trail/);
    assert.match(message, /this repo just moved to it/);
  });

  test("a failed rewrite leaves the old stamp in place so a later session can retry", () => {
    const repo = fixture("failed-rewrite");
    writeStamp(repo, "1.0.0", ["agents"]);
    const oldStamp = readStamp(repo);
    assert.ok(oldStamp);
    const rewrite = mock.fn(() => {
      throw new Error("cannot write rules");
    });

    const result = reconcileWiring(repo, "2.0.0", { rewrite });
    assert.equal(rewrite.mock.callCount(), 1);
    assert.equal(result, null);
    assert.equal(formatWiringRefresh(result), null);
    assert.deepEqual(readStamp(repo), oldStamp);
  });
});
