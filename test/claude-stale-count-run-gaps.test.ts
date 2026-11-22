import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CHECK_TIMEOUT_MS, runStaleCount } from "../src/claude/stale-count-run.js";
import { cacheDir, patchStats, readStats } from "../src/claude/state.js";
import { tmpRepo } from "./helpers.js";

describe("runStaleCount locking", () => {
  const repos: string[] = [];
  const otherPid = process.pid + 1;
  let savedGraftDir: string | undefined;

  before(() => {
    savedGraftDir = process.env.GRAFT_DIR;
    delete process.env.GRAFT_DIR;
  });

  after(() => {
    if (savedGraftDir === undefined) delete process.env.GRAFT_DIR;
    else process.env.GRAFT_DIR = savedGraftDir;
    for (const dir of repos) rmSync(dir, { recursive: true, force: true });
  });

  function fixture() {
    const dir = tmpRepo("stale-count-lock");
    repos.push(dir);
    execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
    return { dir, lock: join(cacheDir(dir), "stale-check.lock") };
  }

  function ageLock(lock: string) {
    const past = new Date(Date.now() - CHECK_TIMEOUT_MS - 60_000);
    utimesSync(lock, past, past);
  }

  test("a live check keeps a second check from starting", () => {
    const { dir, lock } = fixture();
    const contender = mock.fn(() => null);
    const count = mock.fn((cwd: string) => {
      assert.equal(cwd, dir);
      const contents = readFileSync(lock, "utf8");
      const owner = JSON.parse(contents);
      assert.equal(owner.pid, process.pid);
      assert.ok(Number.isFinite(Date.parse(owner.at)));

      runStaleCount(dir, contender);

      assert.equal(contender.mock.callCount(), 0);
      assert.equal(readFileSync(lock, "utf8"), contents);
      return null;
    });

    runStaleCount(dir, count);

    assert.equal(count.mock.callCount(), 1);
    assert.equal(existsSync(lock), false);
  });

  test("reclaims an abandoned lock and publishes the new count", () => {
    const { dir, lock } = fixture();
    const oldSync = new Date(0).toISOString();
    patchStats(dir, { dirty: true, staleCount: 7, syncedAt: oldSync });
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: otherPid, at: oldSync }));
    ageLock(lock);

    const count = mock.fn(() => {
      assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, process.pid);
      return 3;
    });

    runStaleCount(dir, count);

    assert.equal(count.mock.callCount(), 1);
    assert.equal(readStats(dir)?.staleCount, 3);
    assert.equal(readStats(dir)?.dirty, true);
    assert.equal(existsSync(lock), false);
  });

  test("skips the check when the stale lock path cannot be reclaimed", () => {
    const { dir, lock } = fixture();
    // An unexpected directory at the lock path must not be removed recursively.
    mkdirSync(lock, { recursive: true });
    const entry = join(lock, "keep");
    writeFileSync(entry, "leave this alone");
    ageLock(lock);
    const count = mock.fn(() => null);

    runStaleCount(dir, count);

    assert.equal(count.mock.callCount(), 0);
    assert.equal(readFileSync(entry, "utf8"), "leave this alone");
  });

  test("leaves a replacement lock owned by another worker in place", () => {
    const { dir, lock } = fixture();
    const successor = JSON.stringify({ pid: otherPid, at: new Date().toISOString() });
    const count = mock.fn(() => {
      // Simulate a later worker reclaiming the lock while this check is in flight.
      rmSync(lock);
      writeFileSync(lock, successor, { flag: "wx" });
      return null;
    });

    runStaleCount(dir, count);

    assert.equal(count.mock.callCount(), 1);
    assert.equal(readFileSync(lock, "utf8"), successor);
  });

  test("releases its lock even when the check throws", () => {
    const { dir, lock } = fixture();
    const failure = new Error("check failed");

    assert.throws(
      () => runStaleCount(dir, () => {
        assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, process.pid);
        throw failure;
      }),
      (error: unknown) => error === failure,
    );
    assert.equal(existsSync(lock), false);
  });

  test("finishes cleanup if the lock has already disappeared", () => {
    const { dir, lock } = fixture();
    const count = mock.fn(() => {
      rmSync(lock);
      return null;
    });

    runStaleCount(dir, count);

    assert.equal(count.mock.callCount(), 1);
    assert.equal(existsSync(lock), false);
  });
});
