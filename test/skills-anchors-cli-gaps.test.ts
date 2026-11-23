/**
 * Gaps in src/skills/anchors-cli.ts: the bins of the nearest package.json,
 * the source folder, the registration reader's refusals, the walk's limits
 * (links, file count, a bin target outside src) and the anchors cache
 * (stale, future-dated, corrupt and partly bad entries). Every scratch
 * checkout has its own Trail home.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpRepo } from "./helpers.js";
import {
  MAX_SRC_FILES, binsNear, cliNames, registrations, srcOf, subcommandGone, type Cli,
} from "../src/skills/anchors-cli.js";

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function scratch(tag: string): string {
  const d = tmpRepo(`acli-${tag}`);
  made.push(d);
  return d;
}
function put(root: string, rel: string, text: string): void {
  const p = join(root, ...rel.split("/"));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
const later = () => Date.now() + 10_000;

const CLI_SRC = [
  "import { Command } from 'commander';",
  "const program = new Command();",
  "program.command('init').action(() => {});",
  "program.command(\"build <dir>\").action(() => {});",
  "program.command('deploy').alias('d');",
  "program.command('status');",
].join("\n");

interface Box { dir: string; trail: string; env: NodeJS.ProcessEnv; cli: Cli }
function cliBox(tag: string, src: string | null = CLI_SRC): Box {
  const dir = scratch(tag);
  const trail = join(dir, "trail");
  put(dir, "package.json", JSON.stringify({ name: "@acme/cli", bin: { acme: "dist/cli.js" } }));
  if (src !== null) put(dir, "src/cli.ts", src);
  return { dir, trail, env: { HOME: join(dir, "home"), TRAIL_HOME: trail }, cli: { prog: "acme", pkgDir: dir, target: "dist/cli.js" } };
}
const cacheFile = (b: Box) => join(b.trail, "state", "anchors-cache.json");
function editCache(b: Box, fn: (e: { sig: string; cli: Record<string, unknown>; at: string }) => void): void {
  const c = JSON.parse(readFileSync(cacheFile(b), "utf8"));
  for (const e of Object.values(c.checkouts)) fn(e as never);
  writeFileSync(cacheFile(b), JSON.stringify(c));
}

/* ------------------------------------------------------------- binsNear */

describe("binsNear", () => {
  test("a string bin is named after the package without its scope, and its target normalized", () => {
    const dir = scratch("bins-str");
    put(dir, "package.json", JSON.stringify({ name: "@acme/tool", bin: ".\\bin\\tool.js" }));
    const r = binsNear(dir, ".");
    assert.ok(r);
    assert.equal(r.pkgDir, resolve(dir));
    assert.deepEqual([...r.bins], [["tool", "bin/tool.js"]]);
  });

  test("an object bin keeps only string targets; a nested package is found from a step folder below it", () => {
    const dir = scratch("bins-obj");
    put(dir, "package.json", JSON.stringify({ name: "root" }));
    put(dir, "packages/web/package.json", JSON.stringify({ bin: { web: "./dist//web.js", bad: 5, nope: null } }));
    mkdirSync(join(dir, "packages", "web", "src", "deep"), { recursive: true });
    const r = binsNear(dir, join("packages", "web", "src", "deep"));
    assert.ok(r);
    assert.equal(r.pkgDir, resolve(dir, "packages", "web"));
    assert.deepEqual([...r.bins], [["web", "dist/web.js"]]);
  });

  test("a string bin without a name, no bin, bad JSON, no package.json or a folder outside: null", () => {
    const dir = scratch("bins-none");
    assert.equal(binsNear(dir, "."), null, "no package.json up to the checkout");
    put(dir, "package.json", JSON.stringify({ bin: "cli.js" }));
    assert.equal(binsNear(dir, "."), null, "a string bin needs the package name");
    put(dir, "package.json", JSON.stringify({ name: "x", bin: { a: 1 } }));
    assert.equal(binsNear(dir, "."), null, "no string target");
    put(dir, "package.json", "{ not json");
    assert.equal(binsNear(dir, "."), null, "unparsable");
    put(dir, "package.json", JSON.stringify({ name: "x", bin: "cli.js" }));
    assert.equal(binsNear(dir, ".."), null, "a step folder above the checkout");
    put(dir, "package.json", JSON.stringify({ name: "x", bin: "cli.js", pad: "#".repeat(300 * 1024) }));
    assert.equal(binsNear(dir, "."), null, "too big to read");
  });
});

/* ---------------------------------------------------------------- srcOf */

test("srcOf: src/ first, else the bin target's folder inside the package, else null", () => {
  const dir = scratch("srcof");
  assert.equal(srcOf(dir, "bin/cli.js"), null, "the target's folder isn't there");
  mkdirSync(join(dir, "bin"));
  assert.equal(srcOf(dir, "bin/cli.js"), join(dir, "bin"));
  assert.equal(srcOf(dir, "../elsewhere/cli.js"), null, "outside the package");
  mkdirSync(join(dir, "src"));
  assert.equal(srcOf(dir, "bin/cli.js"), join(dir, "src"));
});

/* -------------------------------------------------------- registrations */

describe("registrations", () => {
  test("plain literals, aliases arrays and an empty new Command() are read", () => {
    const out = new Set<string>();
    const ok = registrations([
      "const p = new Command();",
      "p.command('build <dir>');",
      "p.command(`serve`).aliases([ 's', \"sv\" ]);",
      "p.aliases([]);",
      "createCommand('tool');",
    ].join("\n"), out);
    assert.equal(ok, true);
    assert.deepEqual([...out].sort(), ["build", "s", "serve", "sv", "tool"]);
  });

  test("yargs commandDir and completion, a default command, and non-literal names make it unsure", () => {
    const cases: Array<[string, string]> = [
      ["yargs.commandDir('cmds')", "commandDir"],
      ["yargs.completion()", "completion"],
      ["program.command('run', { isDefault: true })", "isDefault"],
      ["program.command(name)", "a variable"],
      ["program.command(`x-${n}`)", "a template with a hole"],
      ["yargs.command('$0', 'default')", "$0"],
      ["yargs.command('*', 'default')", "*"],
      ["p.aliases(list)", "aliases not an array"],
      ["p.aliases(['a' 'b'])", "no comma"],
      ["p.command('unclosed)", "an unclosed literal"],
      ["p.command('a\\nb')", "an escape"],
    ];
    for (const [text, why] of cases) assert.equal(registrations(text, new Set()), false, why);
  });
});

/* ------------------------------------------------------- subcommandGone */

test("subcommandGone: null, help and fewer than 3 others are never gone", () => {
  assert.equal(subcommandGone(null, "connect"), false);
  assert.equal(subcommandGone(["a", "b", "c"], "help"), false);
  assert.equal(subcommandGone(["a", "b", "help"], "connect"), false, "help is not counted");
  assert.equal(subcommandGone(["a", "b", "c"], "connect"), true);
  assert.equal(subcommandGone(["a", "b", "c", "connect"], "connect"), false);
  assert.equal(subcommandGone([], "connect"), false);
});

/* ------------------------------------------------------------- cliNames */

describe("cliNames", () => {
  test("a scan reads the names and writes the cache; SessionStart then reads it without scanning", () => {
    const b = cliBox("scan");
    assert.equal(cliNames(b.cli, b.dir, b.env, { scan: false, deadline: later() }), null, "no cache yet");
    const names = cliNames(b.cli, b.dir, b.env, { scan: true, deadline: later() });
    assert.deepEqual(names, ["build", "d", "deploy", "init", "status"]);
    assert.ok(existsSync(cacheFile(b)));
    const text = readFileSync(cacheFile(b), "utf8");
    assert.ok(!text.includes("commander"), "no file text in the cache");
    assert.deepEqual(cliNames(b.cli, b.dir, b.env, { scan: false, deadline: later() }), names);
    assert.equal(cliNames({ ...b.cli, prog: "other" }, b.dir, b.env, { scan: false, deadline: later() }), null, "another program isn't cached");
  });

  test("an unchanged signature returns the cached names; a changed file is read again", () => {
    const b = cliBox("sig");
    cliNames(b.cli, b.dir, b.env, { scan: true, deadline: later() });
    editCache(b, (e) => { e.cli.acme = ["cached", "only"]; });
    assert.deepEqual(cliNames(b.cli, b.dir, b.env, { scan: true, deadline: later() }), ["cached", "only"]);
    put(b.dir, "src/cli.ts", `${CLI_SRC}\nprogram.command('connect');\n`);
    assert.deepEqual(cliNames(b.cli, b.dir, b.env, { scan: true, deadline: later() }), ["build", "connect", "d", "deploy", "init", "status"]);
  });

  test("a second program of the same package is added beside the first under one signature", () => {
    const b = cliBox("two-progs");
    cliNames(b.cli, b.dir, b.env, { scan: true, deadline: later() });
    const other = { ...b.cli, prog: "acme-admin" };
    assert.deepEqual(cliNames(other, b.dir, b.env, { scan: true, deadline: later() }), ["build", "d", "deploy", "init", "status"]);
    assert.deepEqual(cliNames(b.cli, b.dir, b.env, { scan: false, deadline: later() }), ["build", "d", "deploy", "init", "status"]);
    assert.deepEqual(cliNames(other, b.dir, b.env, { scan: false, deadline: later() }), ["build", "d", "deploy", "init", "status"]);
  });

  test("SessionStart trusts no entry a day old or dated in the future", () => {
    const b = cliBox("stale");
    cliNames(b.cli, b.dir, b.env, { scan: true, deadline: later() });
    editCache(b, (e) => { e.at = new Date(Date.now() - 25 * 3600_000).toISOString(); });
    assert.equal(cliNames(b.cli, b.dir, b.env, { scan: false, deadline: later() }), null);
    editCache(b, (e) => { e.at = new Date(Date.now() + 3600_000).toISOString(); });
    assert.equal(cliNames(b.cli, b.dir, b.env, { scan: false, deadline: later() }), null);
    editCache(b, (e) => { e.at = new Date().toISOString(); });
    assert.deepEqual(cliNames(b.cli, b.dir, b.env, { scan: false, deadline: later() }), ["build", "d", "deploy", "init", "status"]);
  });

  test("a corrupt cache reads as empty, bad names are dropped, and a bad entry is skipped", () => {
    const b = cliBox("corrupt");
    cliNames(b.cli, b.dir, b.env, { scan: true, deadline: later() });
    editCache(b, (e) => { e.cli.acme = ["init", 5, "bad name!", "status"]; e.cli.other = "x"; });
    assert.deepEqual(cliNames(b.cli, b.dir, b.env, { scan: false, deadline: later() }), ["init", "status"]);
    assert.equal(cliNames({ ...b.cli, prog: "other" }, b.dir, b.env, { scan: false, deadline: later() }), null);
    editCache(b, (e) => { (e as { sig: unknown }).sig = 7; });
    assert.equal(cliNames(b.cli, b.dir, b.env, { scan: false, deadline: later() }), null, "an entry without a string sig");
    writeFileSync(cacheFile(b), JSON.stringify({ v: 1, checkouts: [] }));
    assert.equal(cliNames(b.cli, b.dir, b.env, { scan: false, deadline: later() }), null, "checkouts as an array");
    writeFileSync(cacheFile(b), "{ nope");
    assert.equal(cliNames(b.cli, b.dir, b.env, { scan: false, deadline: later() }), null, "not JSON");
    assert.deepEqual(cliNames(b.cli, b.dir, b.env, { scan: true, deadline: later() }), ["build", "d", "deploy", "init", "status"]);
    assert.ok(JSON.parse(readFileSync(cacheFile(b), "utf8")).checkouts, "rewritten as a good cache");
  });

  test("past the deadline: null and nothing written; no source folder: null", () => {
    const b = cliBox("deadline");
    assert.equal(cliNames(b.cli, b.dir, b.env, { scan: true, deadline: 0 }), null);
    assert.equal(existsSync(cacheFile(b)), false);
    const n = cliBox("no-src", null);
    assert.equal(cliNames(n.cli, n.dir, n.env, { scan: true, deadline: later() }), null);
  });

  test("a bin target outside src/ is read too; dot folders, node_modules and other files are not", () => {
    const b = cliBox("bin-outside", "program.command('init');\nprogram.command('status');\n");
    put(b.dir, "bin/acme.js", "program.command('deploy');\n");
    put(b.dir, "src/node_modules/dep/index.js", "x.command(dynamic);\n");
    put(b.dir, "src/.hidden/x.ts", "x.command(dynamic);\n");
    put(b.dir, "src/notes.md", "x.command(dynamic)\n");
    const cli = { ...b.cli, target: "bin/acme.js" };
    assert.deepEqual(cliNames(cli, b.dir, b.env, { scan: true, deadline: later() }), ["deploy", "init", "status"]);
    const missing = { ...b.cli, target: "dist/none.js" };
    assert.deepEqual(cliNames({ ...missing, prog: "x" }, b.dir, b.env, { scan: true, deadline: later() }), ["init", "status"], "a bin not built yet");
  });

  test("a dynamic registration, a name outside the pattern or over 200 names: [] (not sure)", () => {
    const dyn = cliBox("dynamic", `${CLI_SRC}\nprogram.command(name);\n`);
    const r = cliNames(dyn.cli, dyn.dir, dyn.env, { scan: true, deadline: later() });
    assert.deepEqual(r, []);
    assert.equal(subcommandGone(r, "connect"), false);
    const odd = cliBox("odd-name", `${CLI_SRC}\nprogram.command('-flagish');\n`);
    assert.deepEqual(cliNames(odd.cli, odd.dir, odd.env, { scan: true, deadline: later() }), []);
    const many = Array.from({ length: 201 }, (_, i) => `program.command('c${i}');`).join("\n");
    const big = cliBox("many", many);
    assert.deepEqual(cliNames(big.cli, big.dir, big.env, { scan: true, deadline: later() }), []);
  });

  test(`more than ${MAX_SRC_FILES} source files is past the limit: [] and cached as such`, () => {
    const b = cliBox("many-files");
    for (let i = 0; i <= MAX_SRC_FILES; i++) put(b.dir, `src/gen/f${String(i).padStart(3, "0")}.ts`, "export {};\n");
    assert.deepEqual(cliNames(b.cli, b.dir, b.env, { scan: true, deadline: later() }), []);
    assert.deepEqual(cliNames(b.cli, b.dir, b.env, { scan: false, deadline: later() }), []);
  });

  test("a linked folder or source file in src/ is not followed: []", { skip: process.platform === "win32" }, () => {
    // Windows needs extra rights to make symlinks.
    const b = cliBox("link-dir");
    put(b.dir, "elsewhere/more.ts", "program.command('hidden');\n");
    symlinkSync(join(b.dir, "elsewhere"), join(b.dir, "src", "linked"));
    assert.deepEqual(cliNames(b.cli, b.dir, b.env, { scan: true, deadline: later() }), []);
    const f = cliBox("link-file");
    put(f.dir, "elsewhere/more.ts", "program.command('hidden');\n");
    symlinkSync(join(f.dir, "elsewhere", "more.ts"), join(f.dir, "src", "more.ts"));
    assert.deepEqual(cliNames(f.cli, f.dir, f.env, { scan: true, deadline: later() }), []);
    const o = cliBox("link-other");
    symlinkSync(join(o.dir, "package.json"), join(o.dir, "src", "README"));
    assert.deepEqual(cliNames(o.cli, o.dir, o.env, { scan: true, deadline: later() }), ["build", "d", "deploy", "init", "status"], "a linked non-source file is skipped");
  });
});
