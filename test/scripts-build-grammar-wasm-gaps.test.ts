import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PATCHES } from "../scripts/build-grammar-wasm.mjs";

const script = fileURLToPath(new URL("../scripts/build-grammar-wasm.mjs", import.meta.url));
const builtDir = (root: string) => join(root, "src", "graph", "grammars");
const packageDir = (root: string, name: string) => join(root, "node_modules", name);
const workDir = (root: string, name: string) =>
  join(root, "node_modules", ".cache", "grammar-wasm", name);

// Use the checked-in manifest for the inventory only. All package versions,
// source bytes, and WASM bytes used by these tests come from the fixtures.
const inventory = JSON.parse(
  readFileSync(join(builtDir(dirname(dirname(script))), "grammars.json"), "utf8"),
) as Record<string, { module: string; source?: string }>;
const rows = Object.entries(inventory).map(([file, entry]) => ({
  file,
  module: entry.module,
  built: entry.source !== undefined,
}));
type Row = (typeof rows)[number];

const swift = "tree-sitter-swift";
const version = "9.8.7";
const cli = "0.27.1";
const compiledWasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const parser = (name: string) => `/* parser for ${name} */\n`;
const publishedWasm = (file: string) => `published bytes for ${file}\n`;
const existingWasm = (file: string) => `previously built bytes for ${file}\n`;
const originalScanner = [
  "const uint64_t mask = 1UL << FAKE_TRY_BANG;",
  "if (!(suppressing_symbols & 1 << suppressor)) {",
  "  calloc(0, sizeof(struct ScannerState));",
  "}",
  "",
].join("\n");

type CompilerCall = {
  command: string;
  args: string[];
  options: { cwd: string; stdio: string; shell: boolean };
  files: string[];
  parser: string;
  scanner: string | null;
};

// Load the real entry point at its original URL so child coverage is attributed
// to the repository script. Redirect only its on-disk location to the fixture,
// and stand in for npx at the subprocess boundary.
const runnerSource = `
import { mock } from "node:test";
import childProcess from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import url from "node:url";

const savedArgv = process.argv;
const [, , script, root, ...flags] = savedArgv;
const scriptUrl = url.pathToFileURL(script).href;
const fixtureScript = join(root, "scripts", "build-grammar-wasm.mjs");
const outDir = join(root, "src", "graph", "grammars");
const realFileURLToPath = url.fileURLToPath;
const calls = [];

mock.method(globalThis, "fetch", async () => {
  throw new Error("unexpected fetch");
});
mock.method(url, "fileURLToPath", (value, ...options) =>
  (value instanceof URL ? value.href : value) === scriptUrl
    ? fixtureScript
    : realFileURLToPath(value, ...options)
);
mock.method(childProcess, "execFileSync", (command, args, options) => {
  const scanner = join(options.cwd, "src", "scanner.c");
  calls.push({
    command, args, options,
    files: readdirSync(options.cwd).sort(),
    parser: readFileSync(join(options.cwd, "src", "parser.c"), "utf8"),
    scanner: existsSync(scanner) ? readFileSync(scanner, "utf8") : null,
  });
  const outputIndex = args.indexOf("-o");
  const output = args[outputIndex + 1];
  if (outputIndex === -1 || !output || dirname(output) !== outDir) {
    throw new Error("compiler output must be inside the fixture's grammar directory");
  }
  writeFileSync(output, Buffer.from(${JSON.stringify([...compiledWasm])}));
});
syncBuiltinESMExports();
process.argv = [savedArgv[0], fixtureScript, ...flags];
try {
  await import(scriptUrl);
} finally {
  process.argv = savedArgv;
  mock.restoreAll();
  syncBuiltinESMExports();
  writeFileSync(join(root, "compiler-calls.json"), JSON.stringify(calls));
}
`;

describe("build-grammar-wasm entry point", () => {
  let scratch: string;
  let runner: string;
  let restoreFetch: (() => void) | undefined;

  before(() => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("unexpected fetch");
    });
    restoreFetch = () => fetchMock.mock.restore();
    scratch = mkdtempSync(join(tmpdir(), "grammar-wasm-gaps-"));
    runner = join(scratch, "run-build.mjs");
    writeFileSync(runner, runnerSource);
  });

  after(() => {
    restoreFetch?.();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  function fixture(tag: string, scanner = originalScanner) {
    const root = join(scratch, tag);
    mkdirSync(builtDir(root), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    for (const row of rows) {
      const pkg = packageDir(root, row.module);
      mkdirSync(join(pkg, "src"), { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: row.module, version }));
      writeFileSync(join(pkg, "src", "parser.c"), parser(row.module));
      writeFileSync(join(pkg, row.file), publishedWasm(row.file));
      if (row.built) writeFileSync(join(builtDir(root), row.file), existingWasm(row.file));
      if (row.module === swift) {
        writeFileSync(join(pkg, "src", "scanner.c"), scanner);
        writeFileSync(join(pkg, "grammar.js"), "// Swift grammar fixture\n");
        writeFileSync(join(pkg, "tree-sitter.json"), "{}");
      }
    }
    return root;
  }

  function run(root: string, ...flags: string[]) {
    // If the subprocess mock is bypassed, do not find a real npx on PATH.
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "PATH") delete env[key];
    }
    env.PATH = root;
    const result = spawnSync(process.execPath, [runner, script, root, ...flags], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.ifError(result.error);
    const log = join(root, "compiler-calls.json");
    assert.ok(existsSync(log), result.stderr);
    const calls = JSON.parse(readFileSync(log, "utf8")) as CompilerCall[];
    return { ...result, calls };
  }

  function assertManifest(root: string, compiled: boolean, stdout: string) {
    const text = readFileSync(join(builtDir(root), "grammars.json"), "utf8");
    assert.ok(text.endsWith("\n"));
    const manifest = JSON.parse(text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(manifest).sort(), rows.map(({ file }) => file).sort());
    const lines = stdout.split(/\r?\n/);

    for (const { file, module, built } of rows) {
      const bytes = !built ? publishedWasm(file) : compiled ? compiledWasm : existingWasm(file);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const entry = { module, version, sha256 };
      if (built) {
        const source = createHash("sha256").update("parser.c").update(parser(module));
        if (module === swift) source.update("scanner.c").update(originalScanner);
        assert.deepEqual(manifest[file], {
          ...entry, cli, source: source.digest("hex"), patches: module === swift ? 3 : 0,
        }, file);
      } else {
        assert.deepEqual(manifest[file], entry, file);
      }
      const message = `${built && compiled ? "built" : "recorded"} ${file} (${module}@${version})`;
      assert.ok(lines.includes(message), `missing output: ${message}`);
    }
  }

  test("--record hashes existing artifacts without staging or compiling sources", () => {
    const root = fixture("record");
    const stale = join(workDir(root, swift), "keep.txt");
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, "untouched");

    const result = run(root, "--record");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, []);
    assert.equal(readFileSync(stale, "utf8"), "untouched");
    assertManifest(root, false, result.stdout);
  });

  test("builds only source grammars, patches the Swift copy, and cleans staging", () => {
    const root = fixture("build");
    const stale = join(workDir(root, swift), "stale.txt");
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, "previous build");

    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    const built = rows.filter(({ built }) => built);
    assert.ok(built.some(({ module }) => module === swift));
    assert.ok(built.some(({ module }) => module !== swift));
    assert.equal(result.calls.length, built.length);
    for (const { file, module } of built) {
      const output = join(builtDir(root), file);
      const call = result.calls.find(({ args }) => args[5] === output);
      assert.ok(call, `no compiler invocation for ${file}`);
      assert.equal(call.command, "npx");
      assert.deepEqual(call.args, ["--yes", `tree-sitter-cli@${cli}`, "build", "--wasm", "-o", output, "."]);
      assert.deepEqual(call.options, {
        cwd: workDir(root, module),
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      assert.deepEqual(call.files, module === swift
        ? ["grammar.js", "package.json", "src", "tree-sitter.json"]
        : ["package.json", "src"]);
      assert.equal(call.parser, parser(module));
      assert.equal(call.scanner, module === swift ? [
        "const uint64_t mask = 1ULL << FAKE_TRY_BANG;",
        "if (0) {",
        "  calloc(1, sizeof(struct ScannerState));",
        "}",
        "",
      ].join("\n") : null);
      assert.deepEqual(readFileSync(output), compiledWasm);
      assert.equal(existsSync(workDir(root, module)), false, `${module} staging was not cleaned`);
    }
    assert.equal(readFileSync(join(packageDir(root, swift), "src", "scanner.c"), "utf8"), originalScanner);
    assertManifest(root, true, result.stdout);
  });

  test("reports a missing Swift patch target without compiling Swift or publishing a manifest", () => {
    const target = PATCHES[swift][1]![1];
    const changedScanner = originalScanner.replace(target, "if (changed_upstream) {");
    assert.notEqual(changedScanner, originalScanner);
    const root = fixture("patch-drift", changedScanner);
    const swiftRow: Row | undefined = rows.find(({ module, built }) => module === swift && built);
    assert.ok(swiftRow);
    const manifest = join(builtDir(root), "grammars.json");
    const previous = '{"previous":true}\n';
    writeFileSync(manifest, previous);

    const result = run(root);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(
      result.stderr.includes(`${swift}: patch target not found in src/scanner.c: ${target}`),
      result.stderr,
    );
    assert.ok(result.calls.every(({ options }) => options.cwd !== workDir(root, swift)));
    assert.equal(readFileSync(join(builtDir(root), swiftRow.file), "utf8"), existingWasm(swiftRow.file));
    assert.equal(readFileSync(manifest, "utf8"), previous);
    assert.equal(readFileSync(join(packageDir(root, swift), "src", "scanner.c"), "utf8"), changedScanner);
  });
});
