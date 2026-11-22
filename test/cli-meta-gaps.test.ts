import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readCurrentVersion,
  readPackageName,
  resolvePackageJsonPath,
  versionLine,
} from "../src/cli-meta.js";

let scratch: string;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "cli-meta-gaps-"));
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Package metadata tests must not make network requests");
  });
});

after(() => {
  mock.restoreAll();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function write(file: string, contents: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents, "utf8");
  return file;
}

const older = new Date("2024-01-01T00:00:00Z");
const newer = new Date("2024-01-02T00:00:00Z");

function setMtime(file: string, time: Date): void {
  utimesSync(file, time, time);
}

function buildFixture(tag: string, version: string, commit?: string) {
  const root = join(scratch, tag);
  write(join(root, "package.json"), JSON.stringify({ version }));

  const entry = write(join(root, "dist", "cli.js"), "");
  setMtime(entry, older);

  const stamp = join(root, "dist", "build-commit.txt");
  if (commit !== undefined) {
    write(stamp, commit);
    setMtime(stamp, newer);
  }

  return { root, entry, stamp, moduleUrl: pathToFileURL(entry).href };
}

describe("package metadata lookup", () => {
  test("prefers the package root manifest to one beside a source module", () => {
    const root = join(scratch, "source package");
    const parent = write(join(root, "package.json"), '{"version":"1.2.3"}');
    write(join(root, "src", "package.json"), '{"version":"9.9.9"}');
    const moduleUrl = pathToFileURL(write(join(root, "src", "cli.ts"), "")).href;

    assert.equal(resolvePackageJsonPath(moduleUrl), parent);
    assert.equal(readCurrentVersion(moduleUrl), "1.2.3");
  });

  test("uses the manifest beside the module if there is none in the parent", () => {
    const dir = join(scratch, "standalone package", "bin");
    const adjacent = write(join(dir, "package.json"), '{"name":"@example/local-cli"}');
    const moduleUrl = pathToFileURL(write(join(dir, "cli.js"), "")).href;

    assert.equal(resolvePackageJsonPath(moduleUrl), adjacent);
    assert.equal(readPackageName(moduleUrl), "@example/local-cli");
    assert.equal(readCurrentVersion(moduleUrl), "0.0.0");
  });

  test("returns the expected root manifest path even when neither candidate exists", () => {
    const root = join(scratch, "missing manifest");
    const moduleUrl = pathToFileURL(write(join(root, "dist", "cli.js"), "")).href;

    assert.equal(resolvePackageJsonPath(moduleUrl), join(root, "package.json"));
    assert.throws(() => readCurrentVersion(moduleUrl), { code: "ENOENT" });
  });
});

describe("versionLine build stamps", () => {
  test("ignores the build stamp when running from source or a sibling of dist", () => {
    const { root, moduleUrl } = buildFixture("source and backup", "1.2.3", "a1b2c3d\n");
    const source = write(join(root, "src", "cli.ts"), "");
    const backup = write(join(root, "dist-backup", "cli.js"), "");
    setMtime(source, older);
    setMtime(backup, older);

    // The stamp is valid for the build itself, not for files outside dist.
    assert.equal(versionLine(moduleUrl), "1.2.3+a1b2c3d");
    assert.equal(versionLine(pathToFileURL(source).href), "1.2.3");
    assert.equal(versionLine(pathToFileURL(backup).href), "1.2.3");
  });

  test("trims a fresh commit stamp and starts a SemVer metadata suffix", () => {
    const { moduleUrl } = buildFixture("fresh stamp", "1.2.3", "eaa839317b75\r\n");

    assert.equal(versionLine(moduleUrl), "1.2.3+eaa839317b75");
  });

  test("appends a dirty commit to existing metadata, even with equal mtimes", () => {
    const { entry, moduleUrl } = buildFixture("existing metadata", "1.2.3+ci.7", "a1b2c3d-dirty\n");
    setMtime(entry, newer);

    assert.equal(versionLine(moduleUrl), "1.2.3+ci.7.a1b2c3d-dirty");
  });

  test("ignores the stamp after the build output has been rewritten", () => {
    const { entry, stamp, moduleUrl } = buildFixture("stale stamp", "1.2.3", "a1b2c3d\n");
    write(entry, "export {};\n");
    setMtime(entry, newer);
    setMtime(stamp, older);

    assert.equal(versionLine(moduleUrl), "1.2.3");
  });

  test("ignores a fresh stamp that is not a commit hash", () => {
    const { moduleUrl } = buildFixture("invalid stamp", "1.2.3", "unknown\n");

    assert.equal(versionLine(moduleUrl), "1.2.3");
  });

  test("returns the package version when the build stamp is missing", () => {
    const { moduleUrl } = buildFixture("missing stamp", "1.2.3");

    assert.equal(versionLine(moduleUrl), "1.2.3");
  });

  test("surfaces malformed package metadata instead of treating it as a stamp error", () => {
    const { root, moduleUrl } = buildFixture("malformed manifest", "1.2.3", "a1b2c3d\n");
    write(join(root, "package.json"), '{"version":');

    assert.throws(() => versionLine(moduleUrl), SyntaxError);
  });
});
