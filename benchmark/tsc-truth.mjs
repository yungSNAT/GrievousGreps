// Derives a TypeScript repository's caller truth from the TypeScript compiler's references rather than
// by hand. It keeps each symbol's target from truth/<name>.json and rewrites only its rows:
//
//   node benchmark/tsc-truth.mjs --repo <checkout> --name radix [--typescript <dir>] [--out <file>]
//
// The checkout needs its dependencies installed, so the compiler can resolve them. --typescript names the
// folder of the `typescript` package to use; the default is the checkout's own.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);
const SOURCE = /\.(ts|tsx|mts|cts)$/;
const slash = (path) => path.replaceAll('\\', '/');

export function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !SKIP.has(entry.name)) sourceFiles(join(dir, entry.name), out);
    else if (entry.isFile() && SOURCE.test(entry.name) && !/\.d\.[mc]?ts$/.test(entry.name)) out.push(join(dir, entry.name));
  }
  return out;
}

// An unbuilt workspace package's manifest points at dist/, so map each package name and export to the
// source file that dist/ is built from.
function sourceFor(packageDir, target) {
  const stem = target.replace(/^\.\//, '').replace(/^dist\/(types\/)?/, 'src/').replace(/(\.d)?\.[mc]?[jt]s$/, '');
  for (const candidate of [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`]) {
    if (existsSync(join(packageDir, candidate))) return join(packageDir, candidate);
  }
  return null;
}

const exportTarget = (value) => (typeof value === 'string' ? value : value && exportTarget(value.types ?? value.import ?? value.default));

export function workspacePaths(root, manifests) {
  const paths = {};
  for (const manifest of manifests) {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (!pkg.name) continue;
    const dir = dirname(manifest);
    const exportsMap = typeof pkg.exports === 'object' && !Array.isArray(pkg.exports) && Object.keys(pkg.exports).every((key) => key.startsWith('.'))
      ? pkg.exports
      : { '.': pkg.exports ?? pkg.types ?? pkg.main ?? 'src/index.ts' };
    for (const [key, value] of Object.entries(exportsMap)) {
      const target = exportTarget(value);
      const source = target && !key.includes('*') && sourceFor(dir, target);
      if (source) paths[key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`] = [source];
    }
    paths[pkg.name] ??= [sourceFor(dir, 'src/index.ts') ?? join(dir, 'src/index.ts')];
    paths[`${pkg.name}/*`] ??= [join(dir, 'src/*')];
  }
  return paths;
}

// The repository's own root tsconfig `paths`, which take precedence over the derived ones.
export function rootPaths(ts, root) {
  const file = join(root, 'tsconfig.json');
  if (!existsSync(file)) return {};
  const options = ts.readConfigFile(file, ts.sys.readFile).config?.compilerOptions ?? {};
  const base = resolve(root, options.baseUrl ?? '.');
  return Object.fromEntries(Object.entries(options.paths ?? {}).map(([key, targets]) => [key, targets.map((target) => resolve(base, target))]));
}

function manifestsUnder(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !SKIP.has(entry.name)) manifestsUnder(join(dir, entry.name), out);
    else if (entry.isFile() && entry.name === 'package.json') out.push(join(dir, entry.name));
  }
  return out;
}

export function createService(ts, root, files, paths) {
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    paths,
    pathsBasePath: root,
  };
  const snapshots = new Map();
  const host = {
    getScriptFileNames: () => files,
    getScriptVersion: () => '0',
    getScriptSnapshot(file) {
      if (!snapshots.has(file)) snapshots.set(file, existsSync(file) ? ts.ScriptSnapshot.fromString(readFileSync(file, 'utf8')) : undefined);
      return snapshots.get(file);
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (settings) => ts.getDefaultLibFilePath(settings),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  };
  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

function tokenAt(ts, sourceFile, position) {
  let node = sourceFile;
  for (;;) {
    const child = node.getChildren(sourceFile).find((inner) => inner.getStart(sourceFile) <= position && position < inner.getEnd());
    if (!child) return node;
    node = child;
  }
}

// The names a scope gives its callers. Only named definitions are callers: a call inside an
// anonymous callback belongs to the definition around it, or to the file at module level.
function scopeName(ts, node) {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return node.name?.getText();
  }
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return node.name?.text;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    const holder = ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent);
    if (holder && parent.initializer === node) return parent.name.getText();
    return node.name?.text;
  }
  return undefined;
}

function enclosing(ts, node) {
  const names = [];
  let scope = null;
  for (let current = node.parent; current; current = current.parent) {
    const name = scopeName(ts, current);
    if (name) {
      names.unshift(name);
      scope ??= current;
    }
  }
  return { scope, names };
}

// The expression a reference stands for: the member access it names, and any parentheses, `as`, `!` or
// `satisfies` around it.
function calleeOf(ts, node) {
  let callee = node;
  for (;;) {
    const parent = callee.parent;
    const member = (ts.isPropertyAccessExpression(parent) && parent.name === callee) || (ts.isElementAccessExpression(parent) && parent.argumentExpression === callee);
    const wrapper = (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent) ||
      ts.isTypeAssertionExpression(parent) || ts.isSatisfiesExpression(parent)) && parent.expression === callee;
    if (!member && !wrapper) return callee;
    callee = parent;
  }
}

// A call, `new`, tagged template, decorator or JSX element whose callee is the reference.
export function isCall(ts, node) {
  const callee = calleeOf(ts, node);
  const parent = callee.parent;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === callee) return true;
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === callee) return true;
  if ((ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) && parent.tagName === callee) return true;
  return ts.isDecorator(parent);
}

const lineOf = (sourceFile, position) => sourceFile.getLineAndCharacterOfPosition(position).line + 1;

function declarationsNamed(ts, sourceFile, symbol) {
  const parts = symbol.split('.');
  const leaf = parts.at(-1);
  const owners = parts.slice(0, -1);
  const found = [];
  const visit = (node, scopes) => {
    const name = node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
    const declares = ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isClassDeclaration(node) ||
      ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node);
    if (declares && name === leaf && owners.every((owner) => scopes.includes(owner))) found.push(node.name);
    const inner = (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) && name ? [...scopes, name] : scopes;
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(sourceFile, []);
  return found;
}

// The target's declaration: the one whose name is on a `target_lines` line, or every declaration of the
// name in the target file when the truth gives no line.
export function targetNames(ts, sourceFile, symbol, targetLines) {
  const named = declarationsNamed(ts, sourceFile, symbol);
  if (!targetLines) return named;
  const onLine = named.filter((name) => targetLines.includes(lineOf(sourceFile, name.getStart(sourceFile))));
  if (onLine.length) return onLine;
  return named.filter((name) => {
    const node = name.parent;
    const [first, last] = [lineOf(sourceFile, node.getStart(sourceFile)), lineOf(sourceFile, node.getEnd())];
    return targetLines.some((line) => first <= line && line <= last);
  });
}

function rowsFrom(groups, rules) {
  return [...groups.values()]
    .map(({ file, names, lines }) => {
      const sorted = [...lines].sort((a, b) => a - b);
      if (!names) return { file, chain: '<file>', lines: sorted };
      const inner = names.at(-1);
      const chain = rules === 'span' ? names.join('::') : [...new Set([inner, inner.replace(/^#/, '')])];
      return { file, chain, lines: sorted };
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.lines[0] - b.lines[0]);
}

// Required rows are calls, grouped by file and calling definition. Optional rows are other references
// inside a named definition, such as a function passed as a value. Module-level references that are not
// calls, such as imports and re-exports, get no row.
export function deriveSymbol(ts, service, root, symbol, entry, rules) {
  const program = service.getProgram();
  const targetFile = program.getSourceFile(join(root, entry.target));
  if (!targetFile) throw new Error(`${symbol}: ${entry.target} is not in the program`);
  const names = targetNames(ts, targetFile, symbol, entry.target_lines);
  if (names.length === 0) throw new Error(`${symbol}: no declaration in ${entry.target}`);
  const calls = new Map();
  const others = new Map();
  const seen = new Set();
  // A function stored in an object literal, as in `const Jwt = { verify }`, is called as `Jwt.verify()`, and
  // the compiler gives that property its own symbol, so search the property too, one level deep.
  const searches = names.map((name) => ({ fileName: targetFile.fileName, position: name.getStart(targetFile), stored: false }));
  for (const search of searches) {
    for (const referenced of service.findReferences(search.fileName, search.position) ?? []) {
      for (const reference of referenced.references) {
        const key = `${reference.fileName}:${reference.textSpan.start}`;
        if (seen.has(key) || /[\\/]node_modules[\\/]/.test(reference.fileName)) continue;
        seen.add(key);
        const sourceFile = program.getSourceFile(reference.fileName);
        const node = tokenAt(ts, sourceFile, reference.textSpan.start);
        const holder = node.parent;
        if (!search.stored && (ts.isShorthandPropertyAssignment(holder) || (ts.isPropertyAssignment(holder) && holder.initializer === node))) {
          searches.push({ fileName: reference.fileName, position: holder.name.getStart(sourceFile), stored: true });
        }
        if (reference.isDefinition) continue;
        const { scope, names: scopes } = enclosing(ts, node);
        const call = isCall(ts, node);
        if (!call && !scope) continue;
        const file = slash(relative(root, reference.fileName));
        const group = `${file}#${scope ? scope.getStart(sourceFile) : 'file'}`;
        const into = call ? calls : others;
        if (!into.has(group)) into.set(group, { file, names: scope ? scopes : null, lines: new Set() });
        into.get(group).lines.add(lineOf(sourceFile, reference.textSpan.start));
      }
    }
  }
  for (const group of calls.keys()) others.delete(group);
  const derived = { target: entry.target };
  if (entry.target_lines) derived.target_lines = entry.target_lines;
  if (entry.category) derived.category = entry.category;
  derived.required = rowsFrom(calls, rules);
  const optional = rowsFrom(others, rules);
  if (optional.length) derived.optional = optional;
  return derived;
}

export function deriveTruth(ts, root, truth, rules) {
  const files = sourceFiles(root);
  const service = createService(ts, root, files, { ...workspacePaths(root, manifestsUnder(root)), ...rootPaths(ts, root) });
  return Object.fromEntries(Object.entries(truth).map(([symbol, entry]) => [symbol, deriveSymbol(ts, service, root, symbol, entry, rules)]));
}

// The layout of the hand-written truth files: one row per line.
export function formatTruth(truth) {
  const rows = (list) => (list.length ? `[\n${list.map((row) => `      ${JSON.stringify(row)}`).join(',\n')}\n    ]` : '[]');
  const entries = Object.entries(truth).map(([symbol, entry]) => {
    const fields = [`"target": ${JSON.stringify(entry.target)}`];
    if (entry.target_lines) fields.push(`"target_lines": ${JSON.stringify(entry.target_lines)}`);
    if (entry.category) fields.push(`"category": ${JSON.stringify(entry.category)}`);
    fields.push(`"required": ${rows(entry.required)}`);
    if (entry.optional) fields.push(`"optional": ${rows(entry.optional)}`);
    return `  ${JSON.stringify(symbol)}: {\n${fields.map((field) => `    ${field}`).join(',\n')}\n  }`;
  });
  return `{\n${entries.join(',\n')}\n}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { repo: { type: 'string' }, name: { type: 'string' }, typescript: { type: 'string' }, out: { type: 'string' } } });
  if (!values.repo || !values.name) {
    console.error('usage: node benchmark/tsc-truth.mjs --repo <checkout> --name <repository> [--typescript <dir>] [--out <file>]');
    process.exit(2);
  }
  const root = resolve(values.repo);
  const repo = JSON.parse(readFileSync(join(HERE, 'repos.json'), 'utf8')).find((item) => item.name === values.name);
  if (!repo || repo.language !== 'TypeScript') {
    console.error(`tsc-truth: ${values.name} is not a TypeScript repository in repos.json`);
    process.exit(2);
  }
  const ts = createRequire(join(resolve(values.typescript ?? join(root, 'node_modules/typescript')), 'package.json'))('./');
  const truth = JSON.parse(readFileSync(join(HERE, 'truth', `${values.name}.json`), 'utf8'));
  const derived = deriveTruth(ts, root, truth, repo.rules);
  console.error(`tsc-truth: ${values.name} with TypeScript ${ts.version}`);
  const text = formatTruth(derived);
  if (values.out) writeFileSync(values.out, text);
  else process.stdout.write(text);
}
