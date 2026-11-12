/**
 * Every `trail` call and hook child loads the engine, but only model-backed
 * work needs a provider SDK. Loading both SDKs at start-up cost about 0.6 s
 * of a 1.2 s start, so they load when a model is first used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Graft } from '../src/engine.js';
import { tmpRepo } from './helpers.js';

const SRC = resolve('src');
const SDKS = ['@anthropic-ai/sdk', 'openai'];

/** Packages `entry` loads through static imports (`import type` left out), as claude-pre-bash.test.ts walks them. */
function staticPackages(entry: string): string[] {
  const files = new Set<string>();
  const packages = new Set<string>();
  const walk = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) {
      const spec = m[1]!;
      if (spec.startsWith('.')) walk(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      else packages.add(spec);
    }
  };
  walk(entry);
  return [...packages];
}

test('the CLI, the hooks and the MCP server load no LLM provider SDK at start-up', () => {
  for (const entry of ['cli.ts', join('claude', 'hooks.ts'), join('mcp', 'server.ts')]) {
    const sdks = staticPackages(join(SRC, entry)).filter((p) => SDKS.some((s) => p === s || p.startsWith(`${s}/`)));
    assert.deepEqual(sdks, [], entry);
  }
});

test('a build that needs a model and has no key still says how to set one', async () => {
  const saved = { ...process.env };
  for (const k of ['GRAFT_API_KEY', 'OPENROUTER_API_KEY', 'ORCAROUTER_API_KEY']) delete process.env[k];
  try {
    await assert.rejects(new Graft({}).init(tmpRepo('engine-lazy-llm')), /No API key\. Set GRAFT_API_KEY/);
  } finally {
    process.env = saved;
  }
});
