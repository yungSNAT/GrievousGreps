import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import {
  appendPrivateLine,
  ensurePrivateDir,
  readJsonSafe,
  withLock,
  writePrivate,
  writePrivateJson,
} from "../src/util/private-fs.js";
import { tmpRepo } from "./helpers.js";

describe("private filesystem helpers", () => {
  let root: string;

  before(() => {
    root = tmpRepo("private-fs-gaps");
  });

  after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("the re-exported helpers create a directory and persist JSON", () => {
    const dir = join(root, "json", "state");
    const path = join(dir, "settings.json");
    const settings = { enabled: true, count: 2 };

    ensurePrivateDir(dir);
    assert.equal(fs.statSync(dir).isDirectory(), true);
    writePrivateJson(path, settings);
    assert.deepEqual(readJsonSafe(path), settings);
  });

  test("a whole-file write can replace existing content with an empty file", () => {
    const path = join(root, "whole-file", "helper");

    writePrivate(path, "original café");
    assert.equal(fs.readFileSync(path, "utf8"), "original café");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path).mode & 0o777, 0o600);
    }

    writePrivate(path, "", 0o700);
    assert.equal(fs.readFileSync(path, "utf8"), "");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path).mode & 0o777, 0o700);
    }
  });

  test("a failed rename leaves the destination intact and removes the temporary file", () => {
    const parent = join(root, "failed-rename");
    const destination = join(parent, "occupied");
    fs.mkdirSync(destination, { recursive: true });
    const child = join(destination, "keep.txt");
    fs.writeFileSync(child, "keep me");

    assert.throws(() => writePrivate(destination, "replacement"), { syscall: "rename" });
    assert.equal(fs.readFileSync(child, "utf8"), "keep me");
    assert.deepEqual(fs.readdirSync(parent), ["occupied"]);
  });

  test("whole-file writes replace symlinks rather than modifying their targets", (t) => {
    const target = join(root, "link-target.txt");
    const link = join(root, "file-link.txt");
    fs.writeFileSync(target, "original target");
    try {
      fs.symlinkSync(target, link, "file");
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
        t.skip("creating file symlinks requires privileges on this Windows runner");
        return;
      }
      throw error;
    }

    if (fs.constants.O_NOFOLLOW) {
      assert.throws(() => appendPrivateLine(link, "must not reach the target"));
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(target, "utf8"), "original target");
    }

    writePrivate(link, "replacement");
    assert.equal(fs.lstatSync(link).isFile(), true);
    assert.equal(fs.readFileSync(link, "utf8"), "replacement");
    assert.equal(fs.readFileSync(target, "utf8"), "original target");
  });

  test("append creates missing parent directories and preserves earlier lines", () => {
    const path = join(root, "append", "nested", "events.log");
    const largestAllowed = "é".repeat(2047) + "x";
    assert.equal(Buffer.byteLength(largestAllowed, "utf8"), 4095);

    appendPrivateLine(path, largestAllowed);
    appendPrivateLine(path, "next event");

    assert.equal(fs.readFileSync(path, "utf8"), `${largestAllowed}\nnext event\n`);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path).mode & 0o777, 0o600);
    }
  });

  test("append rejects line breaks and 4096 UTF-8 bytes before creating anything", () => {
    const path = join(root, "rejected-append", "events.log");
    const oversized = "é".repeat(2048);
    assert.equal(Buffer.byteLength(oversized, "utf8"), 4096);

    for (const line of ["first\nsecond", "first\rsecond"]) {
      assert.throws(() => appendPrivateLine(path, line), /holds a line break/);
    }
    assert.throws(() => appendPrivateLine(path, oversized), /4 KB or more is refused/);
    assert.equal(fs.existsSync(dirname(path)), false);
  });

  test("append refuses a non-regular descriptor and closes it without writing", () => {
    const path = join(root, "non-regular-append.log");
    fs.writeFileSync(path, "unchanged\n");
    const logStat = fs.statSync(path);
    const directoryStat = fs.statSync(root);
    const realFstatSync = fs.fstatSync;
    const examined: number[] = [];

    // Model an open that succeeds on a non-regular file without requiring a device or FIFO.
    const fstat = mock.method(fs, "fstatSync", (...args: Parameters<typeof realFstatSync>) => {
      const stat = realFstatSync(...args);
      if (stat.dev !== logStat.dev || stat.ino !== logStat.ino) return stat;
      examined.push(args[0]);
      return directoryStat;
    });
    try {
      syncBuiltinESMExports();
      assert.throws(() => appendPrivateLine(path, "must not be written"), /not a regular file/);
    } finally {
      fstat.mock.restore();
      syncBuiltinESMExports();
    }

    assert.equal(examined.length, 1);
    const [fd] = examined;
    assert.ok(fd !== undefined);
    assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
    assert.equal(fs.readFileSync(path, "utf8"), "unchanged\n");
  });

  test("withLock returns the callback's value and removes its own lock", () => {
    const path = join(root, "locked", "state.txt");
    const lock = `${path}.lock`;

    const result = withLock(path, () => {
      assert.match(fs.readFileSync(lock, "utf8"), new RegExp(`^${process.pid} `));
      writePrivate(path, "committed");
      return 9;
    });

    assert.deepEqual(result, { ok: true, value: 9 });
    assert.equal(fs.readFileSync(path, "utf8"), "committed");
    assert.equal(fs.existsSync(lock), false);
  });

  test("withLock preserves the callback's result and leaves a lock it cannot verify", () => {
    const path = join(root, "unreadable-lock", "state.txt");
    const lock = `${path}.lock`;
    const realReadFileSync = fs.readFileSync;
    const read = mock.method(fs, "readFileSync", (...args: Parameters<typeof realReadFileSync>) => {
      if (args[0] === lock) {
        throw Object.assign(new Error("simulated failure reading the lock token"), { code: "EACCES" });
      }
      return realReadFileSync(...args);
    });

    try {
      syncBuiltinESMExports();
      assert.deepEqual(withLock(path, () => "finished"), { ok: true, value: "finished" });
    } finally {
      read.mock.restore();
      syncBuiltinESMExports();
    }

    assert.match(fs.readFileSync(lock, "utf8"), new RegExp(`^${process.pid} `));
  });
});
