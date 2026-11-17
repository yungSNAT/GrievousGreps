import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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

test('outside a checkout, a commit an archive wrote into scripts/archive-commit.txt is stamped; the bare placeholder is not', () => {
  const sha = 'eaa839317b75f3c2d7fc96243a5c046d047a57aa';
  for (const [archived, stamp] of [[`${sha}\n`, 'eaa839317b75\n'], ['$Format:%H$\n', null], ['not a commit\n', null]] as const) {
    const pkg = mkdtempSync(join(tmpdir(), 'graft-stamp-archive-'));
    try {
      mkdirSync(join(pkg, 'scripts'));
      mkdirSync(join(pkg, 'dist'));
      copyFileSync(resolve(process.cwd(), 'scripts', 'stamp-commit.mjs'), join(pkg, 'scripts', 'stamp-commit.mjs'));
      writeFileSync(join(pkg, 'scripts', 'archive-commit.txt'), archived);
      writeFileSync(join(pkg, 'dist', 'build-commit.txt'), '0123456789ab\n');
      const r = spawnSync(process.execPath, [join(pkg, 'scripts', 'stamp-commit.mjs')], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const file = join(pkg, 'dist', 'build-commit.txt');
      assert.equal(existsSync(file) ? readFileSync(file, 'utf8') : null, stamp, archived);
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  }
});

test('git archive, as GitHub serves a commit to npm, writes that commit into scripts/archive-commit.txt', (t) => {
  const git = (...args: string[]) => spawnSync('git', args, { encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD');
  if (head.status !== 0) return t.skip('not a git checkout');
  const archive = git('archive', '--format=tar', 'HEAD', 'scripts/archive-commit.txt');
  assert.equal(archive.status, 0, archive.stderr);
  // A tar member's text follows its 512-byte header, which starts with its name (after git's pax header).
  const at = archive.stdout.indexOf('scripts/archive-commit.txt');
  // Only the commit: git archive writes the line ending core.autocrlf asks for, CRLF on Windows.
  assert.equal(archive.stdout.slice(at + 512, at + 552), head.stdout.trim());
});

// --- npm launch: a fake npm first on PATH stands in for the real one ---
//
// On Windows `npm` is the `npm.cmd` shim, which spawnSync cannot start without a
// shell: the update check stored nothing. Ported from ansidium/trail-code-se7en
// (4fa301e664a8, MIT).

// On Windows the fake is laid out as Node's installer lays npm out: npm.cmd beside
// node_modules/npm/bin/npm-cli.js, which trail runs with Node directly. Its npm.cmd fails if run.
// `npm view cwd version` answers with the folder npm ran in.
function withFakeNpm(fn: () => void, folder = 'npm'): void {
  const top = mkdtempSync(join(tmpdir(), 'graft-fake-npm-'));
  const dir = join(top, folder);
  const script = [
    'const args = process.argv.slice(2);',
    "if (args[0] === 'view') console.log(args[1] === 'cwd' ? process.cwd() : '9.9.9');",
  ];
  if (process.platform === 'win32') {
    mkdirSync(join(dir, 'node_modules', 'npm', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), script.join('\n'));
    writeFileSync(join(dir, 'npm.cmd'), '@exit /b 7\r\n');
  } else {
    mkdirSync(dir);
    writeFileSync(join(dir, 'fake-npm.cjs'), script.join('\n'));
    writeFileSync(join(dir, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-npm.cjs" "$@"\n`);
    chmodSync(join(dir, 'npm'), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${path}`;
  try {
    fn();
  } finally {
    process.env.PATH = path;
    rmSync(top, { recursive: true, force: true });
  }
}

test('getNpmViewVersion reads the latest version from npm on PATH', () => {
  withFakeNpm(() => {
    assert.deepEqual(getNpmViewVersion('@equitybot/grievousgreps', 30_000), { ok: true, version: '9.9.9' });
  });
});

test('getNpmViewVersion: an npm installed under a path with spaces, & and %NAME% still answers', () => {
  withFakeNpm(() => {
    assert.deepEqual(getNpmViewVersion('@equitybot/grievousgreps', 30_000), { ok: true, version: '9.9.9' });
  }, 'npm & 100% %PATH% x');
});

test('getNpmViewVersion runs npm in the working folder, so a project .npmrc still applies', (t) => {
  const here = mkdtempSync(join(tmpdir(), 'graft-npm-cwd-'));
  const back = process.cwd();
  t.after(() => { process.chdir(back); rmSync(here, { recursive: true, force: true }); });
  process.chdir(here);
  withFakeNpm(() => {
    const r = getNpmViewVersion('cwd', 30_000);
    assert.ok(r.ok && r.version, JSON.stringify(r));
    assert.equal(realpathSync.native(r.version!), realpathSync.native(here));
  });
});

// --- npm.cmd's own choice of npm, made without cmd.exe (Windows) ---
//
// npm.cmd runs node_modules\npm\bin\npm-cli.js under the configured global prefix, which
// npm-prefix.js prints, when that file exists, and else the one beside it. Trail makes the same
// choice, and starts none of npm's files from a folder it starts no program from.

const onWindows = { skip: process.platform !== 'win32' };

/** npm in `dir` as Node's installer lays it out: npm.cmd (which fails if run), an npm-cli.js that
 * answers `version` and leaves the file `mark` when given, and an npm-prefix.js printing `prefix`. */
function npmAt(dir: string, version: string, opts: { prefix?: string; mark?: string } = {}): void {
  const bin = join(dir, 'node_modules', 'npm', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, 'npm.cmd'), '@exit /b 7\r\n');
  writeFileSync(join(bin, 'npm-cli.js'), [
    ...(opts.mark ? [`require('fs').writeFileSync(${JSON.stringify(opts.mark)}, '');`] : []),
    `if (process.argv[2] === 'view') console.log(${JSON.stringify(version)});`,
  ].join('\n'));
  if (opts.prefix !== undefined) writeFileSync(join(bin, 'npm-prefix.js'), `console.log(${JSON.stringify(opts.prefix)});`);
}

/** A scratch folder, and the working folder `here` (made current), both removed afterwards; npm's folder `top\npm` goes first on PATH. */
function npmScene(t: { after: (fn: () => void) => void }): { top: string; here: string } {
  const top = realpathSync.native(mkdtempSync(join(tmpdir(), 'graft-npm-prefix-')));
  const here = realpathSync.native(mkdtempSync(join(tmpdir(), 'graft-npm-here-')));
  const back = process.cwd();
  const path = process.env.PATH;
  t.after(() => {
    process.chdir(back);
    process.env.PATH = path;
    rmSync(top, { recursive: true, force: true });
    rmSync(here, { recursive: true, force: true });
  });
  process.chdir(here);
  process.env.PATH = `${join(top, 'npm')}${delimiter}${path}`;
  return { top, here };
}

test('getNpmViewVersion (Windows) runs the npm under the configured global prefix, as npm.cmd does', onWindows, (t) => {
  const { top } = npmScene(t);
  npmAt(join(top, 'npm'), '9.9.9', { prefix: join(top, 'prefix') });
  npmAt(join(top, 'prefix'), '8.8.8');
  assert.deepEqual(getNpmViewVersion('@equitybot/grievousgreps', 30_000), { ok: true, version: '8.8.8' });
});

test('getNpmViewVersion (Windows): a prefix with no npm in it leaves the npm beside npm.cmd', onWindows, (t) => {
  const { top } = npmScene(t);
  npmAt(join(top, 'npm'), '9.9.9', { prefix: join(top, 'empty') });
  assert.deepEqual(getNpmViewVersion('@equitybot/grievousgreps', 30_000), { ok: true, version: '9.9.9' });
});

test('getNpmViewVersion (Windows): a prefix inside the working folder is never run', onWindows, (t) => {
  const { top, here } = npmScene(t);
  const mark = join(top, 'ran');
  npmAt(join(top, 'npm'), '9.9.9', { prefix: join(here, 'prefix') });
  npmAt(join(here, 'prefix'), '7.7.7', { mark });
  assert.deepEqual(getNpmViewVersion('@equitybot/grievousgreps', 30_000), { ok: false });
  assert.equal(existsSync(mark), false, "the working folder's npm ran");
});

test("getNpmViewVersion (Windows): npm's files reached through a link into the working folder are never run", onWindows, (t) => {
  const { top, here } = npmScene(t);
  const mark = join(top, 'ran');
  npmAt(join(here, 'pkg'), '7.7.7', { mark });
  mkdirSync(join(top, 'npm'));
  writeFileSync(join(top, 'npm', 'npm.cmd'), '@exit /b 7\r\n');
  symlinkSync(join(here, 'pkg', 'node_modules'), join(top, 'npm', 'node_modules'), 'junction');
  assert.deepEqual(getNpmViewVersion('@equitybot/grievousgreps', 30_000), { ok: false });
  assert.equal(existsSync(mark), false, "the working folder's npm-cli.js ran");
});

test("getNpmViewVersion (Windows): a node.exe beside npm.cmd that links into the working folder is never run", onWindows, (t) => {
  const { top, here } = npmScene(t);
  npmAt(join(top, 'npm'), '9.9.9');
  copyFileSync(process.execPath, join(here, 'node.exe'));
  try {
    symlinkSync(join(here, 'node.exe'), join(top, 'npm', 'node.exe'), 'file');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return t.skip('this Windows account cannot make file links');
    throw e;
  }
  assert.deepEqual(getNpmViewVersion('@equitybot/grievousgreps', 30_000), { ok: false });
});
