/**
 * The hooks other than pre-bash read their payload from stdin too. A host that
 * leaves stdin open must not hold one until the host's own timeout (5 s for
 * pre-edit): the read gives up as pre-bash's does (pre-bash.ts STDIN_WAIT_MS),
 * by ending the hook outright.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homeEnv, tmpRepo } from './helpers.js';
import { timeBar } from './machine-speed.js';

test('pre-edit with a stdin that never closes ends by its own read bound, saying nothing', async () => {
  const dir = tmpRepo('hook-open-stdin');
  const home = join(dir, 'home');
  const env: NodeJS.ProcessEnv = { ...homeEnv(home), TRAIL_HOME: join(home, '.trail'), CLAUDE_PROJECT_DIR: dir, TRAIL_NO_HOOKS: '', DO_NOT_TRACK: '1', TRAIL_CLOUD: '0' };
  delete env.GRAFT_TEST_STDIN;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "await (await import('./src/claude/hooks.ts')).main('pre-edit');"], {
    cwd: resolve(import.meta.dirname, '..'),
    env,
    stdio: 'pipe',
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.on('error', () => { /* the hook may stop reading early */ });
  child.stdin.write('{"tool_name":"Edit","tool_input":{"file_path":"');
  // A backstop only: the assertion that matters is how the child ended.
  const bar = timeBar(4500, 13_500);
  const t = Date.now();
  const ms = await new Promise<number>((done) => {
    const stop = setTimeout(() => child.kill('SIGTERM'), bar);
    child.on('exit', () => { clearTimeout(stop); done(Date.now() - t); });
  });
  child.stdin.destroy();
  // The hook's bound kills its own process. Node reports that as SIGKILL on POSIX; on Windows a
  // process that kills itself exits with status 1 and no signal, whilst the test's own kill reads SIGTERM.
  if (process.platform === 'win32') {
    assert.deepEqual([child.exitCode, child.signalCode], [1, null], `ended after ${ms} ms; stderr: ${stderr}`);
    assert.equal(stderr, '', 'a status of 1 from a crash would print to stderr');
  } else {
    assert.equal(child.signalCode, 'SIGKILL', `ended after ${ms} ms with ${child.signalCode ?? child.exitCode}; stderr: ${stderr}`);
  }
  assert.equal(stdout, '', 'no decision on a payload that never finished');
  assert.ok(ms < bar, `the hook waited ${ms} ms on an open stdin`);
});
