/**
 * util/program.ts: a program named bare is found in PATH's absolute folders only, and every module
 * starts its child processes through it (test/planted-program.test.ts plants programs for real).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { openBrowser } from "../src/util/browser.js";
import { execFileSync, findProgram, spawn, spawnSync } from "../src/util/program.js";

const has = (...files: string[]) => (p: string) => files.includes(p);
/** Folders as given: these cases name folders that need not exist. */
const asGiven = (dir: string) => dir;
const onWindows = (path: string, isFile: (p: string) => boolean, extra: NodeJS.ProcessEnv = {}, cmd = false) =>
  findProgram("git", { platform: "win32", env: { PATH: path, ...extra }, isFile, realpath: asGiven, cmd });

test("findProgram (Windows): PATH order, then PATHEXT's order, .com and .exe only", () => {
  assert.equal(onWindows("C:\\a;C:\\b", has("C:\\a\\git.exe", "C:\\b\\git.exe")), "C:\\a\\git.exe");
  assert.equal(onWindows("C:\\a", has("C:\\a\\git.com", "C:\\a\\git.exe")), "C:\\a\\git.com");
  assert.equal(onWindows("C:\\a", has("C:\\a\\git.com", "C:\\a\\git.exe"), { PATHEXT: ".EXE;.COM" }), "C:\\a\\git.exe", "the person's PATHEXT order");
  assert.equal(onWindows("C:\\a", has("C:\\a\\git.exe"), { PATHEXT: ".COM;.BAT" }), null, "an ending PATHEXT leaves out is not tried");
  assert.equal(onWindows("C:\\a", has("C:\\a\\git.exe"), { Pathext: ".BAT" }), null, "PATHEXT by any spelling");
  assert.equal(findProgram("git", { platform: "win32", env: { Path: "C:\\a" }, isFile: has("C:\\a\\git.exe"), realpath: asGiven }), "C:\\a\\git.exe", "a copied environment's Path");
  const both = { Path: "C:\\a", PATH: "C:\\b" }; // { ...process.env, PATH } on Windows: Node keeps PATH
  assert.equal(findProgram("git", { platform: "win32", env: both, isFile: has("C:\\a\\git.exe", "C:\\b\\git.exe"), realpath: asGiven }), "C:\\b\\git.exe");
});

test("findProgram (Windows): a git.cmd first on PATH is passed over for a later git.exe, and alone is not found", () => {
  assert.equal(onWindows("C:\\a;C:\\b", has("C:\\a\\git.cmd", "C:\\b\\git.exe")), "C:\\b\\git.exe");
  assert.equal(onWindows("C:\\a", has("C:\\a\\git.cmd", "C:\\a\\git.bat")), null);
  assert.equal(onWindows("C:\\a", has("C:\\a\\git.cmd"), {}, true), "C:\\a\\git.cmd", "unless the caller runs .cmd through a shell");
  assert.equal(onWindows("C:\\a", has("C:\\a\\git.bat"), {}, true), null, "never a .bat");
  const named = (name: string) => findProgram(name, { platform: "win32", env: { PATH: "C:\\a" }, isFile: has("C:\\a\\cmd.exe"), realpath: asGiven });
  assert.equal(named("cmd.exe"), "C:\\a\\cmd.exe", "a name that already has its ending");
  assert.equal(named("CMD.EXE"), "C:\\a\\CMD.EXE");
});

test("findProgram: empty and relative PATH entries are never looked in", () => {
  const seen: string[] = [];
  const any = (p: string) => { seen.push(p); return true; };
  assert.equal(onWindows('.;;tools;bin\\x;C:relative;"."', any), null);
  assert.equal(findProgram("git", { platform: "linux", env: { PATH: ".::bin:./x" }, isFile: any, realpath: asGiven }), null);
  assert.deepEqual(seen, []);
  assert.equal(onWindows('"C:\\Program Files\\Git\\cmd"', has("C:\\Program Files\\Git\\cmd\\git.exe")), "C:\\Program Files\\Git\\cmd\\git.exe", "a quoted entry");
});

test("findProgram (POSIX): PATH order; with no PATH, /usr/bin then /bin, as libuv", () => {
  assert.equal(findProgram("git", { platform: "linux", env: { PATH: "/opt/x:/usr/bin" }, isFile: has("/opt/x/git", "/usr/bin/git"), realpath: asGiven }), "/opt/x/git");
  assert.equal(findProgram("git", { platform: "linux", env: {}, isFile: has("/bin/git"), realpath: asGiven }), "/bin/git");
  assert.equal(findProgram("git", { platform: "linux", env: { PATH: "" }, isFile: has("/bin/git"), realpath: asGiven }), null, "an empty PATH is no PATH entry at all");
});

test("findProgram (POSIX): a file that is not executable is passed over", { skip: process.platform === "win32" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "program-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "tool-a"), "#!/bin/sh\n", { mode: 0o644 });
  writeFileSync(join(dir, "tool-b"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(findProgram("tool-a", { env: { PATH: dir } }), null);
  assert.equal(findProgram("tool-b", { env: { PATH: dir } }), join(dir, "tool-b"));
});

const win = process.platform === "win32";
/** A runnable `trail-tool` in `dir` (an empty .exe is enough for the lookup on Windows); its path. */
function tool(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, win ? "trail-tool.exe" : "trail-tool");
  writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
  return file;
}
/** A temporary folder by its real path (the runner's temp folder can be a symlink or a short name). */
function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "program-tree-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** `fn` with this process in `dir`. */
function inside<T>(dir: string, fn: () => T): T {
  const was = process.cwd();
  process.chdir(dir);
  try { return fn(); } finally { process.chdir(was); }
}
const find = (path: string, cwd?: string) => findProgram("trail-tool", { env: { PATH: path }, cwd });

test("findProgram: a PATH folder at or under the working folder is passed over, by real path", (t) => {
  const top = scratch(t);
  const repo = join(top, "repo");
  const bin = tool(join(repo, "tools"));
  mkdirSync(join(repo, "sub"));
  assert.equal(find(join(repo, "tools"), repo), null, "under the child's working folder");
  assert.equal(find(join(repo, "tools"), join(repo, "tools")), null, "the child's working folder itself");
  assert.equal(inside(repo, () => find(join(repo, "tools"))), null, "under this process's working folder");
  assert.equal(find(join(repo, "tools"), join(repo, "sub")), bin, "elsewhere in the checkout: the person's own entry, used");
  symlinkSync(join(repo, "tools"), join(top, "link"), "junction");
  assert.equal(find(join(top, "link"), repo), null, "a link whose real folder is under the working folder");
  symlinkSync(repo, join(top, "repo-link"), "junction");
  assert.equal(find(join(repo, "tools"), join(top, "repo-link")), null, "a working folder given through a link");
});

test("findProgram: a folder the checkout links outside is still the checkout's: the entry as listed counts too", (t) => {
  const top = scratch(t);
  const repo = join(top, "repo");
  mkdirSync(repo);
  const other = join(top, "elsewhere");
  mkdirSync(other);
  tool(join(top, "outside-bin"));
  symlinkSync(join(top, "outside-bin"), join(repo, "tools"), "junction");
  assert.equal(find(join(repo, "tools"), repo), null, "a folder in the checkout that links outside it");
  mkdirSync(join(repo, "node_modules"));
  symlinkSync(join(top, "outside-bin"), join(repo, "node_modules", ".bin"), "junction");
  assert.equal(find(join(repo, "node_modules", ".bin"), other), null, "node_modules/.bin as a link to an outside folder");
  const pkg = join(top, "pkg");
  mkdirSync(pkg);
  tool(join(top, "outside-modules", ".bin"));
  symlinkSync(join(top, "outside-modules"), join(pkg, "node_modules"), "junction");
  assert.equal(find(join(pkg, "node_modules", ".bin"), other), null, "node_modules itself as a link");
  symlinkSync(repo, join(top, "repo-link"), "junction");
  assert.equal(find(join(top, "repo-link", "tools"), join(top, "repo-link")), null, "both reached through a link to the checkout");
  assert.equal(find(join(repo, "tools", "..", "tools"), repo), null, "an entry with .. in it");
});

test("findProgram: Yarn's own bin folder (BERRY_BIN_FOLDER) is passed over", (t) => {
  const top = scratch(t);
  const berry = join(top, "xfs-1234", "bin");
  tool(berry);
  const later = tool(join(top, "later"));
  const env = { PATH: [berry, join(top, "later")].join(win ? ";" : ":"), BERRY_BIN_FOLDER: berry };
  assert.equal(findProgram("trail-tool", { env, cwd: join(top, "elsewhere") }), later);
});

test("findProgram (Windows): letter case and separators do not bring a skipped folder back", { skip: !win }, (t) => {
  const top = scratch(t);
  const repo = join(top, "repo");
  tool(join(repo, "tools"));
  assert.equal(find(join(repo, "tools").toUpperCase(), repo), null);
  assert.equal(find(join(repo, "tools"), repo.toLowerCase().replace(/\\/g, "/")), null);
  tool(join(top, "Pkg", "Node_Modules", ".Bin"));
  assert.equal(find(join(top, "Pkg", "Node_Modules", ".Bin"), join(top, "elsewhere")), null, "Node_Modules\\.Bin as created");
  tool(join(top, "pkg2", "node_modules", ".bin"));
  assert.equal(find(join(top, "PKG2", "NODE_MODULES", ".BIN")), null, "NODE_MODULES\\.BIN as listed");
});

test("findProgram: a node_modules/.bin folder is passed over wherever it is, a link to one too", (t) => {
  const top = scratch(t);
  const other = join(top, "elsewhere");
  mkdirSync(other);
  const nm = join(top, "pkg", "node_modules", ".bin");
  tool(nm);
  assert.equal(find(nm, other), null, "an ancestor's or another tree's node_modules/.bin, as npx adds");
  symlinkSync(nm, join(top, "tools"), "junction");
  assert.equal(find(join(top, "tools"), other), null, "a link to a node_modules/.bin");
  const plain = tool(join(top, "lib", ".bin"));
  assert.equal(find(join(top, "lib", ".bin"), other), plain, "a .bin folder outside node_modules is used");
  const later = tool(join(top, "later"));
  assert.equal(find([nm, join(top, "later")].join(win ? ";" : ":"), other), later, "a later entry is still found");
});

test("findProgram: a filesystem root or the home folder as the working folder skips nothing", (t) => {
  const top = scratch(t);
  const bin = tool(join(top, "tools"));
  assert.equal(find(join(top, "tools"), parse(top).root), bin, "a service started in / or C:\\");
  const home = win ? "USERPROFILE" : "HOME";
  const was = process.env[home];
  process.env[home] = top;
  t.after(() => { if (was === undefined) delete process.env[home]; else process.env[home] = was; });
  assert.equal(find(join(top, "tools"), top), bin, "trail run in the home folder still finds ~/tools");
});

test("a program not on PATH: spawnSync reports it, execFileSync and spawn throw, each saying so", () => {
  const env = { ...process.env, PATH: mkdtempSync(join(tmpdir(), "program-empty-")) };
  const r = spawnSync("trail-no-such-program", ["x"], { env, encoding: "utf8" });
  assert.equal(r.status, null);
  assert.equal((r.error as NodeJS.ErrnoException).code, "ENOENT");
  assert.equal(r.error?.message, "trail-no-such-program was not found on PATH outside the working folder and its subfolders");
  assert.throws(() => execFileSync("trail-no-such-program", [], { env }), { code: "ENOENT", message: "trail-no-such-program was not found on PATH outside the working folder and its subfolders" });
  assert.throws(() => spawn("trail-no-such-program", [], { env }), { code: "ENOENT" });
  rmSync(env.PATH, { recursive: true, force: true });
});

test("spawnSync(name, undefined, options) looks the name up in that options' PATH, as Node reads them", (t) => {
  const dir = scratch(t);
  copyFileSync(process.execPath, join(dir, win ? "trail-node.exe" : "trail-node"));
  const r = spawnSync("trail-node", undefined as unknown as string[], { env: { ...process.env, PATH: dir }, input: "process.exit(6)" });
  assert.equal(r.error, undefined);
  assert.equal(r.status, 6);
});

test("openBrowser with no opener on PATH: the URL printed is the fallback, nothing throws", { skip: win }, async (t) => {
  const path = process.env.PATH;
  const off = process.env.GRAFT_NO_BROWSER;
  t.after(() => {
    process.env.PATH = path;
    if (off !== undefined) process.env.GRAFT_NO_BROWSER = off;
  });
  delete process.env.GRAFT_NO_BROWSER;
  process.env.PATH = scratch(t);
  openBrowser("http://127.0.0.1:9/");
  await new Promise((done) => setTimeout(done, 200)); // an 'error' event from a child would land here
});

test("an absolute path and a shell command line pass through as given", () => {
  assert.equal(spawnSync(process.execPath, ["-e", "process.exit(3)"]).status, 3);
  const r = spawnSync(`"${process.execPath}" -e "process.exit(4)"`, [], { shell: true });
  assert.equal(r.status, 4);
});

/** Each src file that takes anything but types from child_process, and how. */
function childProcessImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const isChildProcess = (node: ts.Node | undefined) => !!node && ts.isStringLiteralLike(node) && /^(node:)?child_process$/.test(node.text);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && isChildProcess(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined;
      const typesOnly = !!clause?.isTypeOnly || (!clause?.name && !!named && named.every((e) => e.isTypeOnly));
      if (!typesOnly) found.push(`import at line ${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    } else if (ts.isExportDeclaration(node) && isChildProcess(node.moduleSpecifier) && !node.isTypeOnly) {
      found.push("re-export");
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) && isChildProcess(node.arguments[0])) {
      found.push(`${node.expression.getText()}() at line ${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test("only util/program.ts takes child_process: every other module starts programs through it", () => {
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const offenders: string[] = [];
  for (const name of readdirSync(src, { recursive: true, encoding: "utf8" })) {
    const rel = name.replace(/\\/g, "/");
    if (!rel.endsWith(".ts") || rel === "util/program.ts") continue;
    for (const how of childProcessImports(join(src, name))) offenders.push(`${rel}: ${how}`);
  }
  assert.deepEqual(offenders, []);
  assert.equal(childProcessImports(join(src, "util", "program.ts")).length, 2, "the scan sees program.ts's own import and re-export");
});
