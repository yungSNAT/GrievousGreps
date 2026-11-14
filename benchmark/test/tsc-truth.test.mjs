import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveTruth, formatTruth } from '../tsc-truth.mjs';

const ts = createRequire(import.meta.url)('typescript');
const TRUTH = join(dirname(fileURLToPath(import.meta.url)), '..', 'truth');

test('the output keeps the layout of every committed truth file', () => {
  for (const name of readdirSync(TRUTH)) {
    const text = readFileSync(join(TRUTH, name), 'utf8').replaceAll('\r\n', '\n');
    assert.equal(formatTruth(JSON.parse(text)), text, name);
  }
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'tsc-truth-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const FILES = {
  'package.json': '{ "name": "fixture" }',
  'src/a.ts': ['export function target() {', '  return 1;', '}', 'export function target2() {}', ''].join('\n'),
  'src/b.ts': [
    "import { target } from './a';",
    'export function caller() {',
    '  return [1].map(() => target());',
    '}',
    'export const viaArrow = () => target();',
    'export class Box {',
    '  #open() {',
    '    return target() + target();',
    '  }',
    '}',
    'export function passes() {',
    '  return [1].map(target);',
    '}',
    'export const table = { run: target };',
    'target();',
    'describe(() => target());',
    'declare function describe(body: () => void): void;',
    '',
  ].join('\n'),
  'src/c.ts': ["import { Ns } from './ns';", 'export function viaNs() {', '  return Ns.target();', '}', ''].join('\n'),
  'src/ns.ts': ["import { target } from './a';", 'export const Ns = { target };', ''].join('\n'),
  'src/other.ts': ['function target() {}', 'export function local() {', '  target();', '}', ''].join('\n'),
  'src/view.tsx': [
    "import { Comp } from '@fx/lib/sub';",
    'export function View() {',
    '  return <Comp />;',
    '}',
    '',
  ].join('\n'),
  'packages/lib/package.json': '{ "name": "@fx/lib", "exports": { ".": { "types": "./dist/index.d.ts" }, "./sub": { "types": "./dist/types/inner/sub.d.ts", "import": "./dist/inner/sub.mjs" } } }',
  'packages/lib/src/index.ts': 'export const one = 1;\n',
  'packages/lib/src/inner/sub.ts': 'export function Comp() {\n  return null;\n}\n',
};

test('calls are grouped by calling definition, with anonymous callbacks counted in the definition or file around them, and calls through an object property found', (t) => {
  const root = fixture(FILES);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const truth = deriveTruth(ts, root, { target: { target: 'src/a.ts', target_lines: [1], category: 'kept' } }, 'span');
  assert.deepEqual(truth.target.required, [
    { file: 'src/b.ts', chain: 'caller', lines: [3] },
    { file: 'src/b.ts', chain: 'viaArrow', lines: [5] },
    { file: 'src/b.ts', chain: 'Box::#open', lines: [8] },
    { file: 'src/b.ts', chain: '<file>', lines: [15, 16] },
    { file: 'src/c.ts', chain: 'viaNs', lines: [3] },
  ]);
  assert.deepEqual(truth.target.optional, [{ file: 'src/b.ts', chain: 'passes', lines: [12] }]);
  assert.equal(truth.target.category, 'kept');
  assert.deepEqual(truth.target.target_lines, [1]);
});

test('a same-named local function is a different symbol', (t) => {
  const root = fixture(FILES);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const truth = deriveTruth(ts, root, { target: { target: 'src/a.ts', target_lines: [1] } }, 'span');
  assert.equal(truth.target.required.some((row) => row.file === 'src/other.ts'), false);
});

test('the names rules keep the calling definition and its name without the private mark', (t) => {
  const root = fixture(FILES);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const truth = deriveTruth(ts, root, { target: { target: 'src/a.ts' } }, 'names');
  assert.deepEqual(truth.target.required.find((row) => row.lines[0] === 8).chain, ['#open', 'open']);
  assert.equal(truth.target.target_lines, undefined);
});

test('a JSX element is a call, and a workspace export resolves to its source', (t) => {
  const root = fixture(FILES);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const truth = deriveTruth(ts, root, { Comp: { target: 'packages/lib/src/inner/sub.ts', target_lines: [1] } }, 'span');
  assert.deepEqual(truth.Comp.required, [{ file: 'src/view.tsx', chain: 'View', lines: [3] }]);
});

test("the root tsconfig's paths resolve imports the manifests do not", (t) => {
  const root = fixture({
    'package.json': '{ "name": "paths" }',
    'tsconfig.json': '{ "compilerOptions": { "paths": { "@alias/*": ["./lib/*"] } } }',
    'lib/x.ts': 'export function aliased() {}\n',
    'use.ts': ["import { aliased } from '@alias/x';", 'export function user() {', '  aliased();', '}', ''].join('\n'),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const truth = deriveTruth(ts, root, { aliased: { target: 'lib/x.ts', target_lines: [1] } }, 'span');
  assert.deepEqual(truth.aliased.required, [{ file: 'use.ts', chain: 'user', lines: [3] }]);
});

test('wrapped callees, element access, tagged templates, decorators and `new` are calls', (t) => {
  const root = fixture({
    'package.json': '{ "name": "shapes" }',
    'a.ts': 'export function fn(...args: unknown[]): any {}\nexport class K {}\n',
    'b.ts': [
      "import { fn, K } from './a';",
      'export function wrapped() {',
      '  (fn)();',
      '  (fn as any)();',
      '  fn!();',
      '  fn`x`;',
      '  (<any>fn)();',
      '  (fn satisfies Function)();',
      '}',
      '(fn)();',
      'const box = { fn };',
      'export function indexed() {',
      "  box['fn']();",
      '}',
      '@fn',
      'export class Decorated {}',
      'export function make() {',
      '  return new K();',
      '}',
      'export function keyed(methods: any) {',
      '  return methods[fn as any]();',
      '}',
      '',
    ].join('\n'),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const truth = deriveTruth(ts, root, { fn: { target: 'a.ts', target_lines: [1] }, K: { target: 'a.ts', target_lines: [2] } }, 'span');
  assert.deepEqual(truth.fn.required, [
    { file: 'b.ts', chain: 'wrapped', lines: [3, 4, 5, 6, 7, 8] },
    { file: 'b.ts', chain: '<file>', lines: [10] },
    { file: 'b.ts', chain: 'indexed', lines: [13] },
    { file: 'b.ts', chain: 'Decorated', lines: [15] },
  ]);
  assert.deepEqual(truth.fn.optional, [{ file: 'b.ts', chain: 'keyed', lines: [21] }]);
  assert.deepEqual(truth.K.required, [{ file: 'b.ts', chain: 'make', lines: [18] }]);
});

test('a target with no declaration in its file is an error', (t) => {
  const root = fixture(FILES);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => deriveTruth(ts, root, { missing: { target: 'src/a.ts' } }, 'span'), /no declaration/);
});

test('a target file outside the program is an error', (t) => {
  const root = fixture(FILES);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => deriveTruth(ts, root, { target: { target: 'src/absent.ts' } }, 'span'), /not in the program/);
});
