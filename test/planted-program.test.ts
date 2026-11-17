/**
 * Trail runs inside checkouts other people wrote. A program it starts by name (git, gh, claude,
 * npm) must be the person's own, from PATH, never one the checkout holds: given a bare name, Node
 * on Windows looks in the working folder before PATH, and a relative PATH entry such as `.` does
 * the same anywhere. Each stand-in planted here leaves a mark if it runs.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { getNpmViewVersion } from "../src/cli-meta.js";
import { claudeBin } from "../src/init/claude-call.js";
import { isGitWorkTree } from "../src/init-guard.js";
import { ghReady } from "../src/notes/pr-reviews.js";
import { spawnSync as trailSpawnSync } from "../src/util/program.js";

const win = process.platform === "win32";

function tempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A git repository whose origin is on GitHub, as a cloned one would be. */
function clonedRepo(t: TestContext): string {
  const dir = tempDir(t, "planted-repo-");
  for (const args of [["init", "-q"], ["remote", "add", "origin", "https://github.com/example/example.git"]]) {
    assert.equal(spawnSync("git", args, { cwd: dir }).status, 0);
  }
  return dir;
}

/** Plants a stand-in for each program in `dir` and puts `.` first on PATH; returns the folder the marks go to. */
function plant(t: TestContext, dir: string, names: string[]): string {
  const marks = tempDir(t, "planted-marks-");
  const saved = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS, npm_config_offline: process.env.npm_config_offline, NoDefaultCurrentDirectoryInExePath: process.env.NoDefaultCurrentDirectoryInExePath };
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  process.env.PATH = `.${delimiter}${process.env.PATH ?? ""}`;
  process.env.npm_config_offline = "true"; // the real npm, if it runs, answers from its cache, not the registry
  delete process.env.NoDefaultCurrentDirectoryInExePath; // set, Windows would skip the working folder and hide the defect
  if (!win) {
    for (const name of names) writeFileSync(join(dir, name), `#!/bin/sh\n: > '${join(marks, `ran-${name}`)}'\n`, { mode: 0o755 });
    return marks;
  }
  // A copy of node named git.exe (and so on), which leaves its mark through a --require hook and
  // stops; the hook does nothing in a process of any other name, such as npm's node. A .cmd is
  // planted for npm, which Trail starts through cmd.exe.
  const hook = join(marks, "hook.cjs");
  writeFileSync(hook, `const path = require("path");
const name = path.basename(process.execPath, ".exe").toLowerCase();
if (${JSON.stringify(names)}.includes(name)) { require("fs").writeFileSync(path.join(${JSON.stringify(marks)}, "ran-" + name), ""); process.exit(0); }
`);
  process.env.NODE_OPTIONS = `--require "${hook.replace(/\\/g, "/")}"`;
  for (const name of names) {
    if (name === "npm") writeFileSync(join(dir, "npm.cmd"), `@type nul > "${join(marks, "ran-npm")}"\r\n`);
    else copyFileSync(process.execPath, join(dir, `${name}.exe`));
  }
  return marks;
}

const ran = (marks: string) => readdirSync(marks).filter((f) => f.startsWith("ran-"));

/** Runs `fn` with the process in `dir`, as when someone runs trail inside a checkout. */
function inside<T>(dir: string, fn: () => T): T {
  const back = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(back);
  }
}

test("git planted in the repository never runs: isGitWorkTree uses the person's git", (t) => {
  const repo = clonedRepo(t);
  const marks = plant(t, repo, ["git"]);
  const workTree = isGitWorkTree(repo);
  assert.deepEqual(ran(marks), [], "the planted git ran");
  assert.equal(workTree, true);
});

test("gh planted in the repository never runs: ghReady asks the person's gh", (t) => {
  const repo = clonedRepo(t);
  const marks = plant(t, repo, ["gh"]);
  ghReady(repo);
  assert.deepEqual(ran(marks), [], "the planted gh ran");
});

test("claude planted in the working folder never runs: claudeBin looks on PATH only", (t) => {
  const repo = clonedRepo(t);
  const marks = plant(t, repo, ["claude"]);
  // No claude on PATH, so the only one to find is the planted one. On Windows the stand-in is
  // node, which answers `claude --version` before its hook loads: it leaves no mark, but
  // claudeBin then names it.
  process.env.PATH = `.${delimiter}${tempDir(t, "planted-path-")}`;
  const bin = inside(repo, () => claudeBin(tempDir(t, "planted-home-")));
  assert.deepEqual(ran(marks), [], "the planted claude ran");
  assert.equal(bin, null, "the planted claude was taken for the person's");
});

test("cmd.exe planted in the working folder never runs as the shell, even with ComSpec unset", { skip: !win }, (t) => {
  const repo = clonedRepo(t);
  const marks = plant(t, repo, ["cmd"]);
  const comspec = process.env.ComSpec;
  t.after(() => { process.env.ComSpec = comspec; });
  delete process.env.ComSpec; // Node then starts a bare cmd.exe
  const r = inside(repo, () => trailSpawnSync("echo shell-ran", [], { shell: true, encoding: "utf8" }));
  assert.deepEqual(ran(marks), [], "the planted cmd.exe ran");
  assert.match(String(r.stdout), /shell-ran/);
});

test("npm planted in the working folder never runs: the update check's npm comes from PATH", (t) => {
  const repo = clonedRepo(t);
  const marks = plant(t, repo, ["npm"]);
  inside(repo, () => getNpmViewVersion("@equitybot/grievousgreps", 30_000));
  assert.deepEqual(ran(marks), [], "the planted npm ran");
});
