/**
 * CLI tests for `graft callers` and its `--direction`/`--depth` flags — the one
 * command that wires src/graph/traverse.ts's pure resolver + edge-walkers into
 * the `graft` binary (`--direction out` is the old `callees`; `--depth N` is the
 * old `impact`). Runs the real CLI via execFileSync (same pattern as
 * test/mcp-tools.test.ts's `builtRepo` helper) against a built fixture repo,
 * so these tests exercise the actual process boundary: exit codes, stdout vs
 * stderr, and --json shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { contextDirFor } from '../src/context/node-file.js';
import { wiringPath } from '../src/graph/write.js';
import { callerBlocks } from '../src/graph/traverse-cli.js';
import { impactedEvidence, referenceLine, wordRe } from '../src/blast/evidence.js';
import type { GraphV1, NodeV1 } from '../src/graph/types.js';
import type { EdgeHit } from '../src/graph/traverse.js';

function builtRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'graft-traversecli-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(
    join(d, 'src', 'math.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n' +
      'export function sub(a: number, b: number): number {\n  return add(a, -b);\n}\n' +
      'export function compute(a: number, b: number): number {\n  return sub(a, b);\n}\n',
  );
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d], { stdio: 'pipe' });
  return d;
}

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

test('graft callers: happy path shows header and the caller hit', () => {
  const d = builtRepo();
  const r = runCli(['callers', 'add', d]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /add · function · src\/math\.ts:L\d+-L\d+ · calls ←\n  src\/math\.ts\n {4}sub L5: /);
});

test('graft callers --json: shape matches {query, matches:[{symbol,hits}]}', () => {
  const d = builtRepo();
  const r = runCli(['callers', 'add', d, '--json']);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.query, 'add');
  assert.equal(parsed.matches.length, 1);
  const m = parsed.matches[0];
  assert.equal(m.symbol.name, 'add');
  assert.equal(m.symbol.kind, 'function');
  assert.ok(m.symbol.path.endsWith('math.ts'));
  assert.ok(m.symbol.id);
  assert.ok(m.symbol.span);
  assert.equal(m.hits.length, 1);
  assert.equal(m.hits[0].name, 'sub');
  assert.equal(m.hits[0].relation, 'calls');
  assert.equal(m.hits[0].depth, 1);
});

test('graft callers: unknown symbol exits 1 with a stderr message', () => {
  const d = builtRepo();
  const r = runCli(['callers', 'noSuchSymbolAnywhere', d]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no symbol "noSuchSymbolAnywhere" in the graph/);
  assert.match(r.stderr, /graft build/);
  assert.equal(r.stdout, '');
});

test('graft callers --direction out: happy path shows the outgoing (callee) hit', () => {
  const d = builtRepo();
  // `sub` calls `add`, so its outgoing edge points at add with a `→` arrow.
  const r = runCli(['callers', 'sub', d, '--direction', 'out']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /sub · function · src\/math\.ts:/);
  assert.match(r.stdout, /· calls →\n  src\/math\.ts: add L1$/m);
});

test('graft callers --direction out: zero-edge symbol prints a loud callees note and still exits 0', () => {
  const d = builtRepo();
  // `add` calls nothing, so its callees are empty — must not be a silent list.
  const r = runCli(['callers', 'add', d, '--direction', 'out']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /add · function · src\/math\.ts:/);
  assert.match(r.stdout, /no indexed callees/);
  assert.match(r.stdout, /graft grep "add"/);
});

test('graft callers --direction out --json: zero-edge symbol includes a note field', () => {
  const d = builtRepo();
  const r = runCli(['callers', 'add', d, '--direction', 'out', '--json']);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.query, 'add');
  assert.equal(parsed.matches.length, 1);
  const m = parsed.matches[0];
  assert.equal(m.symbol.name, 'add');
  assert.equal(m.hits.length, 0);
  assert.ok(m.note, 'zero-edge match must have a note field');
  assert.match(m.note, /graft grep "add"/);
});

function ambiguousRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'graft-traversecli-ambiguous-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'a.ts'), 'export function shared(): number {\n  return 1;\n}\n');
  writeFileSync(join(d, 'src', 'b.ts'), 'export function shared(): number {\n  return 2;\n}\n');
  // A cross-file call to the ambiguous name, with no import to say which: resolve.ts drops it rather than
  // guessing which `shared` it means, so NEITHER definition gets a caller edge.
  writeFileSync(join(d, 'src', 'user.ts'), 'export function use(): number {\n  return shared();\n}\n');
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d], { stdio: 'pipe' });
  return d;
}

test('A6: an ambiguous name (2 definitions) states the candidate count in the zero-hit note', () => {
  const d = ambiguousRepo();
  const r = runCli(['callers', 'shared', d]);
  assert.equal(r.status, 0);
  // Both candidates are reported (resolveSymbol returns every match).
  assert.equal((r.stdout.match(/shared · function · src\//g) ?? []).length, 2);
  // One note for the edgeless definitions together, stating the count.
  assert.equal((r.stdout.match(/dropped rather than guessed/g) ?? []).length, 1);
  assert.match(r.stdout, /no indexed callers for any of the 2 definitions named "shared"/);
});

test('many definitions of one name: those with callers first, then the rest counted under one note', () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-traversecli-homonyms-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'a.ts'), 'export function shared(): number {\n  return 1;\n}\nexport function useA(): number {\n  return shared();\n}\n');
  for (const f of ['b', 'c', 'd', 'e']) writeFileSync(join(d, 'src', `${f}.ts`), `export function shared(): number {\n  return 2;\n}\n`);
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d], { stdio: 'pipe' });
  const r = runCli(['callers', 'shared', d]);
  assert.equal(r.status, 0);
  const blocks = r.stdout.trim().split('\n\n');
  const called = blocks.findIndex((b) => b.startsWith('shared · function · src/a.ts') && /useA/.test(b));
  assert.ok(called >= 0, 'the definition with a caller keeps its own block');
  assert.equal(blocks.length, called + 2, 'then one block for the 4 without callers');
  const quiet = blocks[called + 1];
  assert.equal((quiet.match(/^shared · function · src\//gm) ?? []).length, 3, 'up to 3 are named');
  assert.match(quiet, /… and 1 more in 1 file\(s\)/);
  assert.match(quiet, /no indexed callers for 4 of the 5 definitions named "shared"/);
  assert.equal((r.stdout.match(/dropped rather than guessed/g) ?? []).length, 1);
});

test('callerless definitions whose names differ in case: each name is in the note and keeps its unresolved-calls note', () => {
  const node = (path: string, name: string) => ({ id: `${path}#${name}`, name, kind: 'function', path, span: 'L1-L3' }) as unknown as NodeV1;
  const graph = {
    nodes: [], edges: [],
    unresolvedCalls: [
      { source: 'src/x.ts#useFoo', name: 'Foo', through: './gen' },
      { source: 'src/y.ts#usefoo', name: 'foo', through: './gen' },
    ],
  } as unknown as GraphV1;
  // The odd name sits past the 3 headers shown, so only the note can name it.
  const blocks = callerBlocks(graph, 'in', false, [
    { symbol: node('src/a.ts', 'Foo'), hits: [] },
    { symbol: node('src/b.ts', 'Foo'), hits: [] },
    { symbol: node('src/c.ts', 'Foo'), hits: [] },
    { symbol: node('src/d.ts', 'foo'), hits: [] },
  ]);
  const text = blocks.join('\n\n');
  assert.match(text, /no indexed callers for any of the 4 definitions named "Foo" or "foo";/);
  assert.doesNotMatch(text, /grep/, 'no grep for one name when the names differ');
  assert.match(text, /call\(s\) to "Foo" did not resolve/);
  assert.match(text, /call\(s\) to "foo" did not resolve/);
});

test('A6 --json: the ambiguous-name note includes the candidate count', () => {
  const d = ambiguousRepo();
  const r = runCli(['callers', 'shared', d, '--json']);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.matches.length, 2);
  for (const m of parsed.matches) {
    assert.equal(m.hits.length, 0, 'the ambiguity drop leaves no caller edges for either candidate');
    assert.match(m.note, /2 definitions share the name/);
    assert.match(m.note, /dropped rather than guessed/);
  }
});

test('graft callers --depth: depth flag walks the BFS transitively (blast radius)', () => {
  const d = builtRepo();
  // compute -> sub -> add: callers of `add` at depth 1 is just `sub`;
  // depth 2 also reaches `compute` and tags each hit with its depth.
  const shallow = runCli(['callers', 'add', d, '--depth', '1']);
  assert.equal(shallow.status, 0);
  assert.match(shallow.stdout, /^ {4}sub L\d+:/m);
  assert.doesNotMatch(shallow.stdout, /compute/);
  assert.doesNotMatch(shallow.stdout, /\[depth/); // depth 1 → no depth tags

  const deeper = runCli(['callers', 'add', d, '--depth', '2']);
  assert.equal(deeper.status, 0);
  assert.match(deeper.stdout, /^ {4}sub L\d+ \[depth 1\]:/m);
  assert.match(deeper.stdout, /^ {4}compute L\d+ \[depth 2\]$/m);
});

test('graft callers --depth all: walks the entire connected closure', () => {
  const d = builtRepo();
  // compute -> sub -> add. `all` must reach BOTH hops (the full closure),
  // like an unbounded depth, terminating when no new node is found.
  const all = runCli(['callers', 'add', d, '--depth', 'all']);
  assert.equal(all.status, 0);
  assert.match(all.stdout, /^ {4}sub L\d+ \[depth 1\]:/m);
  assert.match(all.stdout, /^ {4}compute L\d+ \[depth 2\]$/m);
});

test('graft callers --depth: rejects a non-numeric, non-"all" value with exit 1', () => {
  const d = builtRepo();
  const r = runCli(['callers', 'add', d, '--depth', 'banana']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--depth must be a positive number or "all"/);
});

test('graft callers --direction: rejects a bad value with exit 1', () => {
  const d = builtRepo();
  const r = runCli(['callers', 'add', d, '--direction', 'sideways']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--direction must be "in" or "out"/);
});

test('graft callers: no graph at all is a stderr error, exit 1', () => {
  const bare = mkdtempSync(join(tmpdir(), 'graft-traversecli-bare-'));
  const r = runCli(['callers', 'add', bare]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /graft build/);
});

test('graft callers: quotes the call site, and only where it is the right line', () => {
  const d = builtRepo();
  const r = runCli(['callers', 'add', d]);
  assert.equal(r.status, 0);
  // `sub` calls `add` on line 5 of the fixture. The edge is a claim; this is the
  // evidence, and it saves opening the file to check. The call's line stands in for
  // the caller's first line, as it is where the reader goes next.
  assert.match(r.stdout, /· calls ←\n  src\/math\.ts\n {4}sub L5: return add\(a, -b\);$/m);

  // A second-hop hit references what is BETWEEN it and the symbol, not the symbol
  // itself, so quoting it would point at the wrong line.
  const deep = runCli(['callers', 'add', d, '--depth', '2']);
  assert.match(deep.stdout, /^ {4}compute L\d+ \[depth 2\]$/m, 'no quote on a second-hop hit');

  // --json is a data contract: the quote is a text-output nicety and must stay out.
  const json = JSON.parse(runCli(['callers', 'add', d, '--json']).stdout);
  assert.ok(!JSON.stringify(json).includes('return add(a, -b)'));
});

test('graft callers: a quote is a line that names the symbol in code, never in a string or a comment', () => {
  const d = builtRepo();
  writeFileSync(
    join(d, 'src', 'run.ts'),
    "import { add } from './math';\nexport function run(): number {\n  // add the two\n  console.log(\"add them\", 'add', `add`); /* add */\n" +
      '  /* add\n     add(1, 2) */\n  return add(1, 2);\n}\n' +
      "export function talk(): number {\n  console.log('add(1, 2)');\n  return add(3, 4);\n}\n",
  );
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d], { stdio: 'pipe' });
  const r = runCli(['callers', 'add', d]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^ {4}run L7: return add\(1, 2\);$/m);
  assert.match(r.stdout, /^ {4}talk L11: return add\(3, 4\);$/m);
});

test('referenceLine: a string, a comment or a docstring naming the symbol is not its reference, in any comment style', () => {
  const at = (path: string, text: string, span = 'L1-L20') => referenceLine(path, span, [wordRe('install')], () => text.split('\n'), true)?.n ?? null;
  // The ledger case: a Python caller whose first mention is inside a string.
  assert.equal(at('examples/suppress.py', 'def main():\n    print("Please install click")\n    install()'), 3);
  assert.equal(at('a.py', 'def main():\n    """Run install\n    then install again."""\n    # install it\n    x = \'install\'\n    install()'), 6);
  assert.equal(at('a.py', "def main():\n    '''install'''\n    install()"), 3);
  // Escapes do not end a string early.
  assert.equal(at('a.ts', 'function f() {\n  g("\\"install\\" ok");\n  g(\'it\\\'s install\');\n  install();\n}'), 4);
  // A Go raw string runs across lines; a Rust lifetime is not a quote.
  assert.equal(at('a.go', 'func f() {\n\ts := `install\ninstall`\n\tinstall()\n}'), 4);
  assert.equal(at('a.rs', "fn f<'a>(x: &'a str) { install(x) }"), 1);
  assert.equal(at('a.rs', "fn f() {\n    let c = '\"'; install();\n}"), 2);
  // A Ruby or shell comment starts with #; in C a # line is a directive, which is code.
  assert.equal(at('a.rb', "def f\n  # install\n  install\nend"), 3);
  assert.equal(at('a.c', '#define RUN install()\nvoid f() { RUN; }'), 1);
  // Only a string or a comment names it: no line is quoted.
  assert.equal(at('a.py', 'def main():\n    print("Please install click")'), null);
});

test('referenceLine: a regex literal, a Go raw string ending in a backslash and a Rust string over lines are read as what they are', () => {
  const at = (path: string, text: string, span = 'L1-L20') => referenceLine(path, span, [wordRe('install')], () => text.split('\n'), true)?.n ?? null;
  // A quote in a regex literal opens no string; a name in one is not a call.
  assert.equal(at('a.ts', "function f() {\n  const r = /'/; install();\n}"), 2);
  assert.equal(at('a.js', 'function f() {\n  const r = /[/]install/g;\n  install();\n}'), 3);
  // A slash after a value divides.
  assert.equal(at('a.ts', 'function f(a: number, b: number) {\n  return a / install() / b;\n}'), 2);
  // A JSX closing tag or self-closing `/>` starts no regex.
  assert.equal(at('a.tsx', 'function F() {\n  return <tr><td>{a}</td><td>{install(b)}</td></tr>;\n}'), 2);
  assert.equal(at('a.tsx', 'function F() {\n  return <div><p>Run</p>{install()}<p>x</p></div>;\n}'), 2);
  assert.equal(at('a.jsx', 'function F() {\n  return <A x={1} /><B onClick={install} />;\n}'), 2);
  // A `.js` file can hold JSX too: a `/` after `}` closes the tag (or divides), it starts no regex.
  assert.equal(at('a.js', 'function F() {\n  return <A x={1} /><B onClick={install} />;\n}'), 2);
  // A multi-line tag's last line starts with `/>`, in any JS file.
  assert.equal(at('a.js', 'function F() {\n  return <A\n    x={1}\n  /><B onClick={install} />;\n}'), 4);
  // JSX text after `{a}` divides nothing and starts no regex.
  assert.equal(at('a.tsx', 'function F() {\n  return <p>{a} / {install()}</p>;\n}'), 2);
  // Outside .jsx and .tsx a regex literal may start with `>`; a `/` in a later string must not end it early.
  for (const path of ['a.ts', 'a.js', 'a.mjs']) {
    assert.equal(at(path, 'function f(s) {\n  const t = s.replace(/>/g, "&gt;"); install("/");\n  install();\n}'), 2, path);
  }
  // A Go raw string has no escapes: a backslash before its backtick does not keep it open.
  assert.equal(at('a.go', 'func f() {\n\ts := `C:\\`\n\tinstall()\n}'), 3);
  // A Rust string, raw or not, runs across lines until it closes.
  assert.equal(at('a.rs', 'fn f() {\n    let s = r#"say "hi"\ninstall()\n"#;\n    install();\n}'), 5);
  assert.equal(at('a.rs', 'fn f() {\n    let s = "a\ninstall()\n";\n    install();\n}'), 5);
});

test('impactedEvidence: the note names the symbol the quoted line uses; an import path is still read in its string', () => {
  const sym = { id: 'u', name: 'use', kind: 'function', path: 'src/u.ts', span: 'L1-L4', relation: 'calls', depth: 1 };
  const read = (text: string) => () => text.split('\n');
  const byName = impactedEvidence(sym, { names: ['alpha', 'beta'], modules: [] }, read('export function use() {\n  const x = "alpha"; beta();\n}'));
  assert.equal(byName?.note, 'calls beta');
  assert.equal(byName?.lines[0]?.n, 2);
  const byModule = impactedEvidence(sym, { names: ['gamma'], modules: [/from\s+["']\.\/data\.js["']/] }, read('import { x } from "./data.js";\nexport function use() {\n  return x;\n}'));
  assert.equal(byModule?.note, 'calls');
  assert.equal(byModule?.lines[0]?.n, 1);
});

test('graft callers: a caller in a test gets no quote, its line already names it', () => {
  const d = builtRepo();
  mkdirSync(join(d, 'test'), { recursive: true });
  writeFileSync(join(d, 'test', 'math.test.ts'), "import { add } from '../src/math';\nexport function addsTwo(): boolean {\n  return add(1, 1) === 2;\n}\n");
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d], { stdio: 'pipe' });
  const r = runCli(['callers', 'add', d]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^  src\/math\.ts\n {4}sub L5: return add\(a, -b\);$/m, 'production callers keep their quote');
  assert.match(r.stdout, /^  test\/math\.test\.ts: addsTwo L2$/m, 'the test caller is listed at its first line');
  assert.doesNotMatch(r.stdout, /add\(1, 1\)/, 'without its call line');
});

test('an imported call to a shared name reaches only the definition it imports', () => {
  const d = ambiguousRepo();
  writeFileSync(join(d, 'src', 'user.ts'), 'import { shared } from "./a.js";\nexport function use(): number {\n  return shared();\n}\n');
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d], { stdio: 'pipe' });
  const parsed = JSON.parse(runCli(['callers', 'shared', d, '--json']).stdout);
  const hits = Object.fromEntries(parsed.matches.map((m: { symbol: { path: string }; hits: unknown[] }) => [m.symbol.path, m.hits.length]));
  assert.deepEqual(hits, { 'src/a.ts': 1, 'src/b.ts': 0 });
});

/** compute -> sub -> add with sub -> add marked inferred in the built graph: 3 nodes, inferred then extracted. */
function inferredThenExtractedRepo(): string {
  const d = builtRepo();
  const file = wiringPath(contextDirFor(d));
  const g = JSON.parse(readFileSync(file, 'utf8'));
  g.edges.find((x: { source: string; target: string }) => x.source.endsWith('sub') && x.target.endsWith('add')).confidence = 'inferred';
  writeFileSync(file, JSON.stringify(g));
  return d;
}

test('graft callers --depth: a hit reached through an inferred edge is marked, in text', () => {
  const r = runCli(['callers', 'add', inferredThenExtractedRepo(), '--depth', '2']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^  src\/math\.ts \[inferred\]\n {4}sub L5 \[depth 1\]: .*\n {4}compute L\d+ \[depth 2\]$/m);
});

test('graft callers --depth --json: a hit reached through an inferred edge is marked, with the same hits', () => {
  const r = runCli(['callers', 'add', inferredThenExtractedRepo(), '--depth', '2', '--json']);
  assert.equal(r.status, 0);
  const hits = JSON.parse(r.stdout).matches[0].hits as { name: string; depth: number; inferred?: true }[];
  assert.deepEqual(hits.map((h) => [h.name, h.depth, h.inferred]), [['sub', 1, true], ['compute', 2, true]]);
});

/** A definition, and a depth-1 hit on another, for the report's layout. */
const layoutNode = (path: string, name: string, span: string) => ({ id: `${path}#${name}`, name, kind: 'function', path, span }) as unknown as NodeV1;
const layoutHit = (path: string, name: string, span: string, relation = 'calls', inferred?: true) =>
  ({ node: layoutNode(path, name, span), id: `${path}#${name}`, relation, depth: 1, ...(inferred ? { inferred } : {}) }) as EdgeHit;
/** The report's one block for `target` in src/a.ts with these hits, as lines. */
const layout = (hits: EdgeHit[], quote?: Parameters<typeof callerBlocks>[4]) =>
  callerBlocks({ nodes: [], edges: [] } as unknown as GraphV1, 'in', false, [{ symbol: layoutNode('src/a.ts', 'target', 'L1-L3'), hits }], quote)[0].split('\n');

test('callers report: each file once, its hits on one line, the shared relation once in the header', () => {
  assert.deepEqual(layout([layoutHit('test/a.test.ts', 'one', 'L5-L9'), layoutHit('src/b.ts', 'two', 'L7-L8'), layoutHit('test/a.test.ts', 'three', 'L12-L30')]), [
    'target · function · src/a.ts:L1-L3 · calls ←',
    '  test/a.test.ts: one L5, three L12',
    '  src/b.ts: two L7',
  ]);
});

test('callers report: mixed relations name their own, a quoted hit gives its call line, an inferred hit its own group', () => {
  const hits = [layoutHit('src/b.ts', 'b.ts', 'L1', 'imports'), layoutHit('src/b.ts', 'two', 'L7-L9'), layoutHit('src/b.ts', 'guess', 'L11-L12', 'calls', true)];
  assert.deepEqual(layout(hits, (h) => (h.node?.name === 'two' ? { n: 8, text: '  return target();  ' } : undefined)), [
    'target · function · src/a.ts:L1-L3',
    '  imports ← src/b.ts: b.ts L1',
    '  calls ← src/b.ts',
    '    two L8: return target();',
    '  calls ← src/b.ts [inferred]: guess L11',
  ]);
});

test('callers report: a path or name holding the layout separators is quoted, so a mark or a boundary cannot be read into it', () => {
  const hits = [
    layoutHit('src/a [inferred]', 'plain', 'L2-L4'), layoutHit('src/a', 'guess', 'L5-L6', 'calls', true), layoutHit('odd: dir/b.ts', 'one, two', 'L7-L8'),
    layoutHit('[x]/c.ts', '"q"', 'L9'), layoutHit('d.ts ', 'e', 'L10'), layoutHit('f.ts', 'g ', 'L11'),
  ];
  assert.deepEqual(layout(hits), [
    'target · function · src/a.ts:L1-L3 · calls ←',
    '  "src/a [inferred]": plain L2', '  src/a [inferred]: guess L5', '  "odd: dir/b.ts": "one, two" L7',
    '  "[x]/c.ts": "\\"q\\"" L9', '  "d.ts ": e L10', '  f.ts: "g " L11',
  ]);
});

test('callers report: an unresolved import among grouped hits keeps its own line, in walk order', () => {
  const missing = { node: null, id: 'pkg/missing', relation: 'imports', depth: 1 } as EdgeHit;
  const hits = [layoutHit('src/b.ts', 'one', 'L2-L4', 'imports'), missing, layoutHit('src/b.ts', 'two', 'L6-L7', 'imports'), layoutHit('src/c.ts', 'three', 'L9-L9', 'imports')];
  assert.deepEqual(layout(hits), [
    'target · function · src/a.ts:L1-L3 · imports ←',
    '  src/b.ts: one L2, two L6',
    '  imports ← pkg/missing (unresolved import)',
    '  src/c.ts: three L9',
  ]);
});
