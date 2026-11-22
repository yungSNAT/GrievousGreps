import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpRepo } from "./helpers.js";

const scratch: string[] = [];
const testDir = fileURLToPath(new URL(".", import.meta.url));
const entry = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const scorePath = posix.join("src", "score.ts");
const testPath = posix.join("test", "score.test.ts");
const scoreSource = [
  "export function calculateScore(value: number): number {",
  "  return value + 1;",
  "}",
  "",
  "export function renderScore(value: number): number {",
  "  return calculateScore(value) * 2; // Marker[One]",
  "}",
  "",
].join("\n");

let home: string;
let indexed: string;

function scratchDir(tag: string): string {
  const dir = tmpRepo(`cli-gaps-3-${tag}`);
  scratch.push(dir);
  return dir;
}

// Commander parses on import. Use a fresh process for each invocation so its
// option values, exit code, and detached upkeep jobs cannot leak between tests.
const driver = `
  import { mock } from "node:test";
  import childProcess from "node:child_process";
  import { syncBuiltinESMExports } from "node:module";

  const argv = process.argv;
  process.argv = [process.execPath, ${JSON.stringify(entry)}, ...argv.slice(1)];

  mock.method(globalThis, "fetch", async () => {
    throw new Error("HTTP is disabled in cli-gaps-3");
  });

  const spawn = childProcess.spawn;
  mock.method(childProcess, "spawn", (file, args, options) => {
    if ((Array.isArray(args) ? options : args)?.detached) {
      return new childProcess.ChildProcess();
    }
    return spawn(file, args, options);
  });
  syncBuiltinESMExports();

  // Commander assumes exit never returns. Merely setting exitCode lets it
  // keep parsing after printing --help and can run the command itself.
  const exit = process.exit.bind(process);
  mock.method(process, "exit", (code) => exit(code));
  process.once("exit", () => {
    process.argv = argv;
    mock.restoreAll();
    syncBuiltinESMExports();
  });

  await import("../src/cli.js");
`;

function cli(...args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", driver, "--", ...args],
    {
      cwd: testDir,
      encoding: "utf8",
      input: "",
      timeout: 60_000,
      windowsHide: true,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TRAIL_HOME: join(home, ".trail"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CODEX_HOME: join(home, ".codex"),
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_CACHE_HOME: join(home, "cache"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_STATE_HOME: join(home, "state"),
        CI: "1",
        DO_NOT_TRACK: "1",
        NO_COLOR: "1",
        GIT_TERMINAL_PROMPT: "0",
        npm_config_offline: "true",
        npm_config_cache: join(home, "npm-cache"),
      },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return {
    ...result,
    detail: `${JSON.stringify(args)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  };
}

function git(repo: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
  assert.ifError(r.error);
  assert.equal(r.status, 0, `git ${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function codeRepo(tag: string): string {
  const repo = scratchDir(tag);
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "Fixture Author");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "core.autocrlf", "false");
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "src", "score.ts"), scoreSource);
  writeFileSync(
    join(repo, "test", "score.test.ts"),
    [
      'import { renderScore } from "../src/score";',
      "export function checksScore(): boolean {",
      "  return renderScore(3) === 8; // Marker[One]",
      "}",
      "",
    ].join("\n"),
  );
  git(repo, "add", "--", "src", "test");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "Add score example and its test");
  return repo;
}

function build(repo: string): void {
  const r = cli("build", repo, "--no-gitignore", "--no-ignore");
  assert.equal(r.status, 0, r.detail);
  assert.match(r.stdout, /wiring:/);
}

before(() => {
  home = scratchDir("home");
  indexed = codeRepo("indexed");
  build(indexed);
});

after(() => {
  for (const dir of scratch.reverse()) rmSync(dir, { recursive: true, force: true });
});

describe("graph queries", () => {
  test("callers follows outgoing edges from a symbol scoped to src", () => {
    const r = cli(
      "callers", "renderScore", indexed,
      "--direction", "out", "--depth", "all", "--in", "src", "--no-refresh",
    );
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /\bcalculateScore\b/);
    assert.doesNotMatch(r.stdout, /\bchecksScore\b/);
  });

  test("grep treats brackets literally, ignores case, and excludes matches outside --in", () => {
    const r = cli(
      "grep", "marker[one]", indexed,
      "--fixed", "--ignore-case", "--in", "src", "--no-refresh",
    );
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /score\.ts/);
    assert.match(r.stdout, /Marker\[One\]/);
    assert.doesNotMatch(r.stdout, /score\.test\.ts/);
  });

  test("map emits a JSON map of the indexed source and test directories", () => {
    const r = cli("map", indexed, "--max-dirs", "8", "--json", "--no-refresh");
    assert.equal(r.status, 0, r.detail);
    const map = JSON.parse(r.stdout);
    assert.ok(map && typeof map === "object" && !Array.isArray(map));
    const text = JSON.stringify(map);
    assert.match(text, /\bsrc\b/);
    assert.match(text, /\btest\b/);
  });

  for (const value of ["0", "wide"]) {
    test(`map rejects --max-dirs ${value} before looking for a graph`, () => {
      const r = cli("map", scratchDir("bad-limit"), "--max-dirs", value);
      assert.equal(r.status, 1, r.detail);
      assert.ok(r.stderr.includes(`--max-dirs must be a positive integer, got "${value}"`), r.detail);
      assert.doesNotMatch(r.stderr, /no graph/);
      assert.equal(r.stdout.trim(), "");
    });
  }

  test("map tells the user how to recover when no graph has been built", () => {
    const r = cli("map", scratchDir("no-map"), "--json", "--no-refresh");
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /no graph: run (?:graft|trail) build first/);
    assert.equal(r.stdout.trim(), "");
  });

  test("blast reports a changed implementation and a dependent test", () => {
    const repo = codeRepo("blast");
    build(repo);
    writeFileSync(join(repo, "src", "score.ts"), scoreSource.replace("value + 1", "value + 2"));
    git(repo, "add", "--", scorePath);

    const r = cli(
      "blast", repo, "--depth", "1", "--format", "json", "--tests",
      "--no-owners", "--pr-author", "PR Author", "pr@example.invalid", "--no-refresh",
    );
    assert.equal(r.status, 0, r.detail);
    const report = JSON.stringify(JSON.parse(r.stdout));
    assert.match(report, /score\.ts/);
    assert.ok(report.includes(testPath), r.detail);
  });
});

describe("docs", () => {
  let docsRoot: string;

  before(() => {
    docsRoot = scratchDir("docs");
    writeFileSync(
      join(docsRoot, "ledger.md"),
      "# Lunar ledger\n\nBasalt calibrates the telescope.\nThe quartz reading is confidential.\n",
    );
  });

  // Source checkouts need not have the optional native docs binary.
  function available(r: ReturnType<typeof cli>): boolean {
    if (r.status === 0) return true;
    assert.ok(r.status !== null && r.status > 0, r.detail);
    assert.match(r.stderr, /gg-docs/i);
    assert.match(r.stderr, /not found|missing|not installed|could not find|couldn't find|enoent|no such file|build.*gg-docs/i);
    return false;
  }

  test("search finds the ledger by its heading or explains that gg-docs is unavailable", () => {
    const r = cli("docs", "search", "lunar", "ledger", "--limit", "1", "--root", docsRoot);
    if (available(r)) assert.match(r.stdout, /ledger\.md/);
  });

  test("get returns only the requested line or explains that gg-docs is unavailable", () => {
    const r = cli("docs", "get", "ledger.md", "--from", "3", "--lines", "1", "--root", docsRoot);
    if (available(r)) {
      assert.match(r.stdout, /Basalt calibrates the telescope\./);
      assert.doesNotMatch(r.stdout, /Lunar ledger|quartz reading/);
    }
  });
});

describe("note", () => {
  test("saves rounded explicit costs and keeps only real touches", () => {
    const repo = codeRepo("cost");
    writeFileSync(join(repo, "scratch.ts"), "export const scratch = true;\n");
    const title = "Keep score adjustments in calculateScore";
    const r = cli(
      "note", repo, "--title", title,
      "--body", "## Decided\nApply the offset in calculateScore so callers share the same rule.",
      "--author", "  Ada Fixture  ", "--minutes", "2.6", "--tokens", "127.4",
      "--touches", ` ${scorePath}#calculateScore, scratch.ts, `,
      "--anyway", "--json",
    );
    assert.equal(r.status, 0, r.detail);
    const note = JSON.parse(r.stdout);
    assert.equal(note.title, title);
    assert.equal(note.author, "Ada Fixture");
    assert.equal(note.cost.minutes, 3);
    assert.equal(note.cost.tokens, 127);
    assert.deepEqual(note.touches, [`${scorePath}#calculateScore`]);
    assert.match(readFileSync(join(repo, ".trail", "learnings", basename(note.path)), "utf8"), /callers share the same rule/);
  });

  test("a replacement names the old learning by filename and preserves its file", () => {
    const repo = codeRepo("replace");
    const first = cli(
      "note", repo, "--title", "Centralize the score offset",
      "--body", "## Decided\nLet calculateScore add the original offset.",
      "--touches", scorePath, "--anyway", "--json",
    );
    assert.equal(first.status, 0, first.detail);
    const old = JSON.parse(first.stdout);
    assert.ok(old.id);
    const oldName = basename(old.path);
    const oldPath = join(repo, ".trail", "learnings", oldName);
    const original = readFileSync(oldPath, "utf8");

    const next = cli(
      "note", repo, "--title", "Round the score before returning it",
      "--body", `## Decided\nRound the result in \`${scorePath}\` so all displays agree.`,
      "--replaces", oldName, "--anyway", "--json",
    );
    assert.equal(next.status, 0, next.detail);
    const saved = JSON.parse(next.stdout);
    assert.equal(saved.replaces, old.id);
    assert.notEqual(saved.id, old.id);
    assert.ok(saved.touches.includes(scorePath), next.detail);
    assert.equal(saved.cost?.minutes, undefined);
    assert.equal(saved.cost?.tokens, undefined);
    assert.equal(readFileSync(oldPath, "utf8"), original);
  });

  test("an unknown --replaces target is diagnosed instead of saving a new learning", () => {
    const repo = codeRepo("unknown-learning");
    const r = cli(
      "note", repo, "--title", "A proposed replacement", "--body", "Change the score rule.",
      "--replaces", "does-not-exist.md", "--anyway", "--json",
    );
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /--replaces: no learning named does-not-exist\.md here/);
    assert.equal(r.stdout.trim(), "");
    assert.equal(existsSync(join(repo, ".trail", "learnings")), false);
  });
});

describe("init and keep", () => {
  test("init rejects using a connect code and a pair code together", () => {
    const repo = scratchDir("conflicting-codes");
    const r = cli("init", repo, "--connect", "connect-fixture", "--pair", "pair-fixture");
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /--connect and --pair are two ways in/);
    assert.equal(existsSync(join(repo, ".claude")), false);
    assert.equal(existsSync(join(repo, ".trail")), false);
  });

  test("connect dry-run shows the Claude plan without connecting or writing it", () => {
    const repo = scratchDir("connect-plan");
    const r = cli(
      "init", repo, "--connect", "TRL-7F2A-K9QD",
      "--dry-run", "--agents", "claude", "--no-global", "--no-build",
    );
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /--dry-run: not connecting/);
    assert.match(r.stderr, /settings\.json/);
    assert.equal(existsSync(join(repo, ".claude", "settings.json")), false);
  });

  test("an unreadable Claude memory export warns but does not prevent local setup", () => {
    const repo = codeRepo("memory");
    const missing = join(repo, "missing-memory.txt");
    const r = cli(
      "init", repo, "--agents", "claude", "--yes", "--no-global", "--no-build",
      "--no-statusline", "--plain", "--look-back", "--claude-memory", missing,
    );
    assert.equal(r.status, 0, r.detail);
    assert.ok(r.stderr.includes(`couldn't read ${missing}`), r.detail);
    assert.match(r.stderr, /nothing from your Claude\.ai memory this time/);
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    assert.ok(settings.hooks && Object.keys(settings.hooks).length > 0);
    assert.equal(settings.statusLine, undefined);
  });

  test("keep help explains numbered selections and keeping none without running keep", () => {
    const r = cli("keep", "--help");
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /keep learnings `trail init` found/);
    assert.match(r.stdout, /trail keep 1 3, or trail keep none/);
    assert.equal(r.stderr.trim(), "", r.detail);
  });
});
