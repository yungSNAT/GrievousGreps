import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { delimiter, join, resolve } from 'node:path';
import {
  formatVersionReport,
  resolvePackageJsonPath,
  readCurrentVersion,
  getNpmViewVersion,
  versionLine,
} from '../src/cli-meta.js';

// --- formatVersionReport: this distribution has nothing published to compare with ---

test('formatVersionReport: the local version, said not to be compared', () => {
  assert.equal(formatVersionReport('0.28.0+gg'), 'graft 0.28.0+gg\nnot compared with npm: this distribution has no published package');
});

// --- resolvePackageJsonPath / readCurrentVersion: real filesystem, no network ---

test('resolvePackageJsonPath finds package.json one level above a dist/cli.js-shaped module path', () => {
  const fakeDistCli = pathToFileURL(resolve(process.cwd(), 'dist/cli.js')).href;
  const found = resolvePackageJsonPath(fakeDistCli);
  assert.equal(found, resolve(process.cwd(), 'package.json'));
});

test('resolvePackageJsonPath finds package.json one level above a src/cli.ts-shaped module path', () => {
  const fakeSrcCli = pathToFileURL(resolve(process.cwd(), 'src/cli.ts')).href;
  const found = resolvePackageJsonPath(fakeSrcCli);
  assert.equal(found, resolve(process.cwd(), 'package.json'));
});

test('readCurrentVersion reads the real package.json version', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
  const v = readCurrentVersion(pathToFileURL(resolve(process.cwd(), 'src/cli.ts')).href);
  assert.equal(v, pkg.version);
});

// --- versionLine: every build of this fork has the same version, so --version names the commit ---

/** A fake built package: package.json, dist/cli.js written at `builtAt`, and the stamp written after it. */
function builtPackage(stamp: string | null): { pkg: string; cli: string; stampFile: string } {
  const pkg = mkdtempSync(join(tmpdir(), 'graft-version-line-'));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '0.28.0+gg' }));
  mkdirSync(join(pkg, 'dist'));
  mkdirSync(join(pkg, 'src'));
  const cliFile = join(pkg, 'dist', 'cli.js');
  writeFileSync(cliFile, '');
  const builtAt = new Date(Date.now() - 60_000);
  utimesSync(cliFile, builtAt, builtAt);
  const stampFile = join(pkg, 'dist', 'build-commit.txt');
  if (stamp !== null) writeFileSync(stampFile, stamp);
  return { pkg, cli: pathToFileURL(cliFile).href, stampFile };
}

test('versionLine adds the commit the build recorded as build metadata, and only a commit', () => {
  for (const [stamp, line] of [
    [null, '0.28.0+gg'],
    ['eaa839317b75\n', '0.28.0+gg.eaa839317b75'],
    ['eaa839317b75-dirty\n', '0.28.0+gg.eaa839317b75-dirty'],
    ['not a commit\n', '0.28.0+gg'],
  ] as const) {
    const { pkg, cli } = builtPackage(stamp);
    try {
      assert.equal(versionLine(cli), line, String(stamp));
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  }
});

test('versionLine ignores a stamp the running code is newer than, or that a source run did not build', () => {
  const { pkg, cli, stampFile } = builtPackage('eaa839317b75\n');
  try {
    // A later `tsc` or `npm run dev` rewrote dist/cli.js after the stamp.
    const later = new Date(Date.now() + 60_000);
    utimesSync(fileURLToPath(cli), later, later);
    assert.equal(versionLine(cli), '0.28.0+gg', 'a stale stamp');
    // `npm run cli` runs src/cli.ts through tsx, whatever dist holds.
    utimesSync(stampFile, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));
    assert.equal(versionLine(pathToFileURL(join(pkg, 'src', 'cli.ts')).href), '0.28.0+gg', 'running from source');
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
});

test('outside its own git checkout the build leaves no stamp, not a wrong one', () => {
  const pkg = mkdtempSync(join(tmpdir(), 'graft-stamp-'));
  try {
    mkdirSync(join(pkg, 'scripts'));
    mkdirSync(join(pkg, 'dist'));
    copyFileSync(resolve(process.cwd(), 'scripts', 'stamp-commit.mjs'), join(pkg, 'scripts', 'stamp-commit.mjs'));
    writeFileSync(join(pkg, 'dist', 'build-commit.txt'), 'eaa839317b75\n');
    const r = spawnSync(process.execPath, [join(pkg, 'scripts', 'stamp-commit.mjs')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(pkg, 'dist', 'build-commit.txt')), false);
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
});

// --- npm launch: a fake npm first on PATH stands in for the real one ---
//
// On Windows `npm` is the `npm.cmd` shim, which spawnSync cannot start without a
// shell: the update check stored nothing. Ported from ansidium/trail-code-se7en
// (4fa301e664a8, MIT).

function withFakeNpm(fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'graft-fake-npm-'));
  const script = [
    'const args = process.argv.slice(2);',
    "if (args[0] === 'view') console.log('9.9.9');",
  ];
  writeFileSync(join(dir, 'fake-npm.cjs'), script.join('\n'));
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'npm.cmd'), `@"${process.execPath}" "%~dp0fake-npm.cjs" %*\r\n`);
  } else {
    writeFileSync(join(dir, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-npm.cjs" "$@"\n`);
    chmodSync(join(dir, 'npm'), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${path}`;
  try {
    fn();
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('getNpmViewVersion reads the latest version from npm on PATH', () => {
  withFakeNpm(() => {
    assert.deepEqual(getNpmViewVersion('@equitybot/grievousgreps', 30_000), { ok: true, version: '9.9.9' });
  });
});
