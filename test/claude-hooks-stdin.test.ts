/**
 * The hooks other than pre-bash read their payload from stdin too. A host that
 * leaves stdin open must not hold one until the host's own timeout (5 s for
 * pre-edit): the read gives up as pre-bash's does (pre-bash.ts STDIN_WAIT_MS).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homeEnv, tmpRepo } from './helpers.js';
import { timeBar } from './machine-speed.js';

test('pre-edit with a stdin that never closes ends inside the host timeout', async () => {
  const dir = tmpRepo('hook-open-stdin');
  const home = join(dir, 'home');
  const env: NodeJS.ProcessEnv = { ...homeEnv(home), TRAIL_HOME: join(home, '.trail'), CLAUDE_PROJECT_DIR: dir, TRAIL_NO_HOOKS: '', DO_NOT_TRACK: '1', TRAIL_CLOUD: '0' };
  delete env.GRAFT_TEST_STDIN;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "await (await import('./src/claude/hooks.ts')).main('pre-edit');"], {
    cwd: resolve(import.meta.dirname, '..'),
    env,
    stdio: 'pipe',
  });
  child.stdin.on('error', () => { /* the hook may stop reading early */ });
  child.stdin.write('{"tool_name":"Edit","tool_input":{"file_path":"');
  // 4.5 s where the bar was set, scaled, never under 13.5 s; the child is killed 3.5 s past it, which fails the bar.
  const bar = timeBar(4500, 13_500);
  const t = Date.now();
  const ms = await new Promise<number>((done) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), bar + 3500);
    child.on('exit', () => { clearTimeout(kill); done(Date.now() - t); });
  });
  child.stdin.destroy();
  assert.ok(ms < bar, `the hook waited ${ms} ms on an open stdin`);
});
