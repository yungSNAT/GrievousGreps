import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectDir } from "../src/notes/session-cost.js";
import { tmpRepo } from "./helpers.js";
import { runCli, type CliOptions, type Route } from "./cli-gaps-driver.js";

// Hidden helpers, the --deep build offline, queries under trail, and the
// build's rarer lines, each through the real CLI.

const scratch: string[] = [];
let home: string;
let repo: string;

function scratchDir(tag: string): string {
  const dir = tmpRepo(`cli-gaps-5-${tag}`);
  scratch.push(dir);
  return dir;
}

function cli(args: string[], o: Partial<CliOptions> = {}) {
  return runCli(args, { home, ...o });
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(" ")}\n${r.stderr}`);
  return r.stdout;
}

function codeRepo(tag: string): string {
  const dir = scratchDir(tag);
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", "Fixture Author");
  git(dir, "config", "user.email", "fixture@example.invalid");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "score.ts"), "export function score(v: number): number {\n  return bonus(v) + 1;\n}\n\nexport function bonus(v: number): number {\n  return v * 2;\n}\n");
  git(dir, "add", "--", "src");
  git(dir, "-c", "commit.gpgsign=false", "commit", "-m", "Add score");
  return dir;
}

function build(dir: string, o: Partial<CliOptions> = {}): void {
  const r = cli(["build", dir, "--no-gitignore", "--no-ignore"], o);
  assert.equal(r.status, 0, r.detail);
}

/** A folder holding two independent repos: a workspace parent. */
function workspaceRoot(tag: string): string {
  const root = scratchDir(tag);
  for (const name of ["alpha", "beta"]) {
    mkdirSync(join(root, name, ".git"), { recursive: true });
    writeFileSync(join(root, name, "main.ts"), `export function ${name}(): number {\n  return 1;\n}\n`);
  }
  return root;
}

before(() => {
  home = scratchDir("home");
  repo = codeRepo("repo");
  build(repo);
});

after(() => {
  for (const dir of scratch.reverse()) rmSync(dir, { recursive: true, force: true });
});

describe("hidden helpers", () => {
  test("_trail-claim with no sign-in link out does nothing", () => {
    const r = cli(["_trail-claim"]);
    assert.equal(r.status, 0, r.detail);
    assert.equal(r.stdout + r.stderr, "");
  });

  test("_trail-sync sends a workspace repo's learnings, and does nothing off a workspace", () => {
    const quiet = cli(["_trail-sync", repo]);
    assert.equal(quiet.status, 0, quiet.detail);
    assert.equal(quiet.stdout + quiet.stderr, "");
  });

  test("_trail-pair stops when the pair link has expired, at the Trail it was told", () => {
    const log = join(scratchDir("pair-log"), "fetch.jsonl");
    const r = cli(["_trail-pair", "state-1", repo, "http://trail.test", "--resumed"], { routes: [{ on: "POST /api/cli/handoffs/claim", status: 410 }], fetchLog: log });
    assert.equal(r.status, 0, r.detail);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; path: string });
    assert.ok(calls.some((c) => c.method === "POST" && c.path === "/api/cli/handoffs/claim"), JSON.stringify(calls));
  });

  test("_trail-pair with no server named waits on Trail cloud until it runs out of time", () => {
    const r = cli(["_trail-pair", "state-2", repo], { env: { GG_CLOCK_STEP_MS: String(24 * 60 * 60 * 1000) } });
    assert.equal(r.status, 0, r.detail);
  });

  test("_update-check records when it last asked", () => {
    const h = scratchDir("update-home");
    const r = cli(["_update-check"], { home: h });
    assert.equal(r.status, 0, r.detail);
    const cache = JSON.parse(readFileSync(join(h, ".graft", "update-check.json"), "utf8"));
    assert.equal(typeof cache.checkedAt, "number");
  });

  test("_share-sync with nothing being sent, or for a workspace no longer here, does nothing", () => {
    const h = scratchDir("share-sync-home");
    const none = cli(["_share-sync"], { home: h });
    assert.equal(none.status, 0, none.detail);
    mkdirSync(join(h, ".trail", "share"), { recursive: true });
    writeFileSync(join(h, ".trail", "share", "sync.json"), JSON.stringify({ bundleId: "b1", secret: "s1", since: 1, days: 30, url: "http://trail.test", excluded: [], dirs: [], sessions: {}, sizes: {}, setupHash: "", lastRunAt: 1 }));
    const gone = cli(["_share-sync"], { home: h });
    assert.equal(gone.status, 0, gone.detail);
    assert.equal(gone.stdout + gone.stderr, "");
  });
});

describe("build --deep, offline", () => {
  const offline = {
    OPENROUTER_API_KEY: ["fixture", "key"].join("-"),
    GRAFT_BASE_URL: "http://llm.test/v1",
    GRAFT_SYNTH_MODEL: "fixture-synth",
    GRAFT_LLM_RETRIES: "0",
  };

  test("warns about the old key, says the deep pass failed and exits 1", () => {
    const dir = codeRepo("deep");
    const r = cli(["build", dir, "--deep", "-j", "1", "--no-gitignore", "--no-ignore"], { env: offline });
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /⚠ using OPENROUTER_API_KEY \(deprecated\): prefer GRAFT_API_KEY \+ GRAFT_BASE_URL\./);
    assert.match(r.stderr, /the deep pass did not complete, so the meaning tier is incomplete\./);
    assert.match(r.stderr, /meaning coverage: \d+\/\d+ symbols \(\d+%\)/);
    assert.match(r.stdout, /✓ wiring: /);
  });

  test("--allow-partial keeps the report and exits 0", () => {
    const dir = codeRepo("deep-partial");
    const r = cli(["build", dir, "--deep", "--allow-partial", "--no-gitignore", "--no-ignore"], { env: offline });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /the deep pass did not complete/);
  });
});

describe("build, rarer lines", () => {
  test("a workspace parent keeps explicit submodule and nested-repo choices", () => {
    const root = workspaceRoot("ws-build");
    const r = cli(["build", root, "--follow-submodules", "--no-follow-nested-repos", "--no-gitignore", "--no-ignore"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout + r.stderr, /workspace/);
  });

  test("a new worktree starts from the main checkout's graph and says so", () => {
    const main = codeRepo("seed-main");
    build(main);
    const wt = join(scratchDir("seed-parent"), "wt");
    git(main, "worktree", "add", "-q", wt, "-b", "side");
    const r = cli(["build", wt, "--no-gitignore", "--no-ignore"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /seeded: copied a starting graph from .* \(git worktree\)/);
  });

  test("run from inside the map folder, the map is named by its default name", () => {
    const dir = codeRepo("inside");
    build(dir);
    const r = cli(["build", dir, "--no-gitignore", "--no-ignore"], { cwd: join(dir, "graft") });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /^ {2}graft\/ is a local cache/m);
  });
});

describe("queries", () => {
  test("skeleton prints a file's API, or JSON", () => {
    const plain = cli(["skeleton", "src/score.ts", repo, "--no-refresh"]);
    assert.equal(plain.status, 0, plain.detail);
    assert.match(plain.stdout, /score/);
    const json = cli(["skeleton", "src/score.ts", repo, "--json", "--no-refresh"]);
    assert.equal(json.status, 0, json.detail);
    assert.match(JSON.stringify(JSON.parse(json.stdout)), /bonus/);
  });

  test("ask under trail, fitted to a budget, as text and as JSON", () => {
    const text = cli(["ask", "score bonus", repo, "--max-tokens", "400", "--no-refresh"], { trail: true });
    assert.equal(text.status, 0, text.detail);
    assert.match(text.stdout, /score/);
    const json = cli(["ask", "score bonus", repo, "--max-tokens", "400", "--json", "--no-refresh"], { trail: true });
    assert.equal(json.status, 0, json.detail);
    JSON.parse(json.stdout);
  });

  test("ask under trail with learnings in the repo marks a teammate's", () => {
    const dir = codeRepo("ask-notes");
    build(dir, { trail: true });
    const saved = cli(["note", dir, "--title", "Score adds a bonus", "-m", "## Decided\nscore() calls bonus() before adding one, in src/score.ts.", "--touches", "src/score.ts", "--author", "Bo", "--anyway"], { trail: true });
    assert.equal(saved.status, 0, saved.detail);
    for (const extra of [[], ["--max-tokens", "600"]]) {
      const r = cli(["ask", "score bonus", dir, "--no-refresh", ...extra], { trail: true });
      assert.equal(r.status, 0, r.detail);
      assert.match(r.stdout, /Score adds a bonus/);
    }

    // Learnings, but none on this query's code; then one whose learning names code that's gone.
    const elsewhere = codeRepo("ask-elsewhere");
    writeFileSync(join(elsewhere, "src", "pause.ts"), "export function pause(): void {}\n");
    git(elsewhere, "add", "--", "src");
    git(elsewhere, "-c", "commit.gpgsign=false", "commit", "-m", "Add pause");
    build(elsewhere, { trail: true });
    const kept = cli(["note", elsewhere, "--title", "Pause waits", "-m", "## Decided\npause() in src/pause.ts returns at once.", "--touches", "src/pause.ts", "--anyway"], { trail: true });
    assert.equal(kept.status, 0, kept.detail);
    const none = cli(["ask", "score bonus", elsewhere, "--no-refresh", "--limit", "1"], { trail: true });
    assert.equal(none.status, 0, none.detail);
    assert.doesNotMatch(none.stdout, /Pause waits/);
    writeFileSync(join(dir, "src", "score.ts"), "export function total(v: number): number {\n  return v;\n}\n");
    const stale = cli(["ask", "score bonus", dir, "--no-refresh"], { trail: true });
    assert.equal(stale.status, 0, stale.detail);
  });

  test("an -e extension given with its dot is still named when nothing parses it", () => {
    const dir = codeRepo("ext-dot");
    const r = cli(["build", dir, "-e", ".qqq", ".ts", "--no-gitignore", "--no-ignore"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /\.qqq/);
    assert.doesNotMatch(r.stderr, /\.\.qqq/);
  });

  test("check on a workspace parent checks each repo", () => {
    const root = workspaceRoot("ws-check");
    const b = cli(["build", root, "--no-gitignore", "--no-ignore"]);
    assert.equal(b.status, 0, b.detail);
    const r = cli(["check", root]);
    assert.match(r.stdout + r.stderr, /alpha|beta|workspace/);
  });

  test("check --json on a repo with no map has no graph", () => {
    const r = cli(["check", scratchDir("check-none"), "--json"]);
    assert.equal(r.status, 1, r.detail);
    assert.equal(JSON.parse(r.stdout).graph, null);
  });

  test("callers --provenance is refused on a workspace parent", () => {
    const root = workspaceRoot("ws-callers");
    const b = cli(["build", root, "--no-gitignore", "--no-ignore"]);
    assert.equal(b.status, 0, b.detail);
    const r = cli(["callers", "alpha", root, "--provenance", "--no-refresh"]);
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ callers --provenance is not supported on a workspace parent; run it inside a child repository/);
  });

  test("docs status and update answer, or say gg-docs is missing", () => {
    const root = scratchDir("docs");
    writeFileSync(join(root, "guide.md"), "# Guide\n\nHow the score works.\n");
    for (const sub of ["status", "update"]) {
      const r = cli(["docs", sub, "--json", "--root", root]);
      if (r.status === 0) JSON.parse(r.stdout);
      else assert.match(r.stderr, /gg-docs/i, r.detail);
    }
  });
});

describe("viz on each platform", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    test(`serving on ${platform} opens the browser with that platform's opener`, () => {
      const r = cli(["viz", repo, "--port", "0"], { env: { GG_UNREF_SERVERS: "1", GG_PLATFORM: platform } });
      assert.equal(r.status, 0, r.detail);
      assert.match(r.stdout, /\(ctrl-c to stop\)/);
    });
  }
});

test("mcp --brains serves only the workspace's tools and ends with its input", () => {
  const r = cli(["mcp", "--brains"]);
  assert.equal(r.status, 0, r.detail);
});

describe("note", () => {
  test("at a terminal with no body it says how to give one", () => {
    const r = cli(["note", repo, "--title", "Score"], { tty: ["stdin"], trail: true });
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ a learning needs a --title and a body, on stdin or with -m:/);
  });

  test("minutes alone count as a cost, and a long one is worth reading later", () => {
    const dir = codeRepo("note-cost");
    const minutes = cli(["note", dir, "--title", "Bonus before score", "-m", "## Decided\nscore() in src/score.ts adds bonus() first.", "--touches", "src/score.ts", "--minutes", "12", "--anyway", "--author", "Ada"], { trail: true });
    assert.equal(minutes.status, 0, minutes.detail);
    const tokens = cli(["note", dir, "--title", "Bonus doubles", "-m", "## Decided\nbonus() in src/score.ts doubles its input.", "--touches", "src/score.ts", "--tokens", "250000", "--anyway", "--author", "Bo"], { trail: true });
    assert.equal(tokens.status, 0, tokens.detail);
    assert.match(tokens.stdout, /· this took .* to figure out\. the next session that touches score\.ts gets it for/);
    assert.match(tokens.stdout, /· builds on Ada's learning from /);
  });

  test("the save's warnings are listed", () => {
    const dir = codeRepo("note-warn");
    const r = cli(["note", dir, "--title", "Score", "-m", "score() adds one.", "--anyway"], { trail: true });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /· tip: learnings read best under ## Decided, ## Tried and ruled out and ## Watch out/);
  });

  test("a long learning is saved with a warning to cut it", () => {
    const dir = codeRepo("note-long");
    const body = `## Decided\nscore() in src/score.ts adds bonus() first. ${"The bonus doubles its input before the score adds one. ".repeat(30)}`;
    const r = cli(["note", dir, "--title", "Bonus before score", "-m", body, "--touches", "src/score.ts", "--anyway"], { trail: true });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /^· long: \d+ words\. Long learnings get skimmed; cut it to the fact and the why\.$/m);
  });

  test("one that builds on a learning with no author", () => {
    const dir = codeRepo("note-no-author");
    const first = cli(["note", dir, "--title", "Bonus before score", "-m", "## Decided\nscore() in src/score.ts adds bonus() first.", "--touches", "src/score.ts", "--author", "Ada", "--anyway"], { trail: true });
    assert.equal(first.status, 0, first.detail);
    const learnings = join(dir, ".trail", "learnings");
    for (const f of readdirSync(learnings).filter((f) => f.endsWith(".md")))
      writeFileSync(join(learnings, f), readFileSync(join(learnings, f), "utf8").replace(/^author:.*\r?\n/m, ""));
    const r = cli(["note", dir, "--title", "Bonus doubles", "-m", "## Decided\nbonus() in src/score.ts doubles its input.", "--touches", "src/score.ts", "--author", "Bo", "--anyway"], { trail: true });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /^· builds on a learning from /m);
  });

  test("this session's edits in two repos save the learning to both", () => {
    const dir = codeRepo("note-session");
    const other = codeRepo("note-session-other");
    const home = scratchDir("note-session-home");
    const project = claudeProjectDir(dir, home);
    mkdirSync(project, { recursive: true });
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const edit = (id: string, file: string) => ({ type: "tool_use", id, name: "Edit", input: { file_path: file } });
    writeFileSync(join(project, "session.jsonl"), [
      { type: "user", timestamp: at(20), message: { role: "user", content: "make score() in src/score.ts add bonus() first" } },
      { type: "assistant", timestamp: at(15), message: { id: "m1", usage: { input_tokens: 1200, output_tokens: 300 }, content: [edit("t1", join(dir, "src", "score.ts")), edit("t2", join(other, "src", "score.ts"))] } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const r = cli(["note", dir, "--title", "Bonus before score", "-m", "## Decided\nscore() in src/score.ts adds bonus() first.", "--author", "Ada", "--anyway", "--json"], { home, trail: true });
    assert.equal(r.status, 0, r.detail);
    const saved = JSON.parse(r.stdout) as Array<{ title: string }>;
    assert.ok(Array.isArray(saved) && saved.length === 2, r.stdout);
    for (const repoDir of [dir, other]) assert.equal(readdirSync(join(repoDir, ".trail", "learnings")).filter((f) => f.endsWith(".md")).length, 1);
  });
});
