/**
 * util/program.ts: a program named bare is found in PATH's absolute folders only, and every module
 * starts its child processes through it (test/planted-program.test.ts plants programs for real).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { execFileSync, findProgram, spawn, spawnSync } from "../src/util/program.js";

const has = (...files: string[]) => (p: string) => files.includes(p);
const onWindows = (path: string, isFile: (p: string) => boolean, extra: NodeJS.ProcessEnv = {}, cmd = false) =>
  findProgram("git", { platform: "win32", env: { PATH: path, ...extra }, isFile, cmd });

test("findProgram (Windows): PATH order, then PATHEXT's order, .com and .exe only", () => {
  assert.equal(onWindows("C:\\a;C:\\b", has("C:\\a\\git.exe", "C:\\b\\git.exe")), "C:\\a\\git.exe");
  assert.equal(onWindows("C:\\a", has("C:\\a\\git.com", "C:\\a\\git.exe")), "C:\\a\\git.com");
  assert.equal(onWindows("C:\\a", has("C:\\a\\git.com", "C:\\a\\git.exe"), { PATHEXT: ".EXE;.COM" }), "C:\\a\\git.exe", "the person's PATHEXT order");
  assert.equal(onWindows("C:\\a", has("C:\\a\\git.exe"), { PATHEXT: ".COM;.BAT" }), null, "an ending PATHEXT leaves out is not tried");
  assert.equal(onWindows("C:\\a", has("C:\\a\\git.exe"), { Pathext: ".BAT" }), null, "PATHEXT by any spelling");
  assert.equal(findProgram("git", { platform: "win32", env: { Path: "C:\\a" }, isFile: has("C:\\a\\git.exe") }), "C:\\a\\git.exe", "a copied environment's Path");
  const both = { Path: "C:\\a", PATH: "C:\\b" }; // { ...process.env, PATH } on Windows: Node keeps PATH
  assert.equal(findProgram("git", { platform: "win32", env: both, isFile: has("C:\\a\\git.exe", "C:\\b\\git.exe") }), "C:\\b\\git.exe");
});

test("findProgram (Windows): a git.cmd first on PATH is passed over for a later git.exe, and alone is not found", () => {
  assert.equal(onWindows("C:\\a;C:\\b", has("C:\\a\\git.cmd", "C:\\b\\git.exe")), "C:\\b\\git.exe");
  assert.equal(onWindows("C:\\a", has("C:\\a\\git.cmd", "C:\\a\\git.bat")), null);
  assert.equal(onWindows("C:\\a", has("C:\\a\\git.cmd"), {}, true), "C:\\a\\git.cmd", "unless the caller runs .cmd through a shell");
  assert.equal(onWindows("C:\\a", has("C:\\a\\git.bat"), {}, true), null, "never a .bat");
});

test("findProgram: empty and relative PATH entries are never looked in", () => {
  const seen: string[] = [];
  const any = (p: string) => { seen.push(p); return true; };
  assert.equal(onWindows('.;;tools;bin\\x;C:relative;"."', any), null);
  assert.equal(findProgram("git", { platform: "linux", env: { PATH: ".::bin:./x" }, isFile: any }), null);
  assert.deepEqual(seen, []);
  assert.equal(onWindows('"C:\\Program Files\\Git\\cmd"', has("C:\\Program Files\\Git\\cmd\\git.exe")), "C:\\Program Files\\Git\\cmd\\git.exe", "a quoted entry");
});

test("findProgram (POSIX): PATH order; with no PATH, /usr/bin then /bin, as libuv", () => {
  assert.equal(findProgram("git", { platform: "linux", env: { PATH: "/opt/x:/usr/bin" }, isFile: has("/opt/x/git", "/usr/bin/git") }), "/opt/x/git");
  assert.equal(findProgram("git", { platform: "linux", env: {}, isFile: has("/bin/git") }), "/bin/git");
  assert.equal(findProgram("git", { platform: "linux", env: { PATH: "" }, isFile: has("/bin/git") }), null, "an empty PATH is no PATH entry at all");
});

test("findProgram (POSIX): a file that is not executable is passed over", { skip: process.platform === "win32" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "program-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "tool-a"), "#!/bin/sh\n", { mode: 0o644 });
  writeFileSync(join(dir, "tool-b"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(findProgram("tool-a", { env: { PATH: dir } }), null);
  assert.equal(findProgram("tool-b", { env: { PATH: dir } }), join(dir, "tool-b"));
});

test("a program not on PATH: spawnSync reports it, execFileSync and spawn throw, each saying so", () => {
  const env = { ...process.env, PATH: mkdtempSync(join(tmpdir(), "program-empty-")) };
  const r = spawnSync("trail-no-such-program", ["x"], { env, encoding: "utf8" });
  assert.equal(r.status, null);
  assert.equal((r.error as NodeJS.ErrnoException).code, "ENOENT");
  assert.equal(r.error?.message, "trail-no-such-program was not found on PATH");
  assert.throws(() => execFileSync("trail-no-such-program", [], { env }), { code: "ENOENT", message: "trail-no-such-program was not found on PATH" });
  assert.throws(() => spawn("trail-no-such-program", [], { env }), { code: "ENOENT" });
  rmSync(env.PATH, { recursive: true, force: true });
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
