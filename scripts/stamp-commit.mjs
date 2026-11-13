/**
 * Records the commit a build came from in `dist/build-commit.txt`, which
 * `trail --version` prints after the version: every build of this fork is
 * `0.28.0+gg`, so the version alone does not say which code is running.
 *
 * Runs at the end of `npm run build`. Outside a git checkout, or without git,
 * it removes any old stamp rather than leave a wrong one.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'dist', 'build-commit.txt');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

try {
  // A copy without its own .git inside another repository must not take that repository's commit.
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!same(realpathSync.native(git('rev-parse', '--show-toplevel')), realpathSync.native(root))) throw new Error('not its own checkout');
  const commit = git('rev-parse', '--short=12', 'HEAD');
  const dirty = git('status', '--porcelain', '--untracked-files=no') ? '-dirty' : '';
  writeFileSync(target, `${commit}${dirty}\n`);
} catch {
  rmSync(target, { force: true });
}
