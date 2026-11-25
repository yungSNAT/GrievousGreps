import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectDir } from "../src/notes/session-cost.js";
import { tmpRepo } from "./helpers.js";
import { runCli, type CliOptions, type Route } from "./cli-gaps-driver.js";

// `init`, `init --pair` and `init --connect` through the real CLI: the picker and
// the just-me question at a terminal, a stand-in Trail, and the summary's rarer lines.

const SERVER = "http://trail.test";
const scratch: string[] = [];

function scratchDir(tag: string): string {
  const dir = tmpRepo(`cli-gaps-init-${tag}`);
  scratch.push(dir);
  return dir;
}

function cli(args: string[], o: Partial<CliOptions> = {}) {
  return runCli(args, { home: o.home ?? scratchDir("home"), ...o });
}

function trail(args: string[], o: Partial<CliOptions> = {}) {
  return cli(args, { trail: true, ...o });
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(" ")}\n${r.stderr}`);
  return r.stdout;
}

function codeRepo(tag: string): string {
  const dir = scratchDir(tag);
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", "Ada");
  git(dir, "config", "user.email", "ada@example.invalid");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "gear.ts"), "export function turn(v: number): number {\n  return v * 2;\n}\n");
  git(dir, "add", "--", "src");
  git(dir, "-c", "commit.gpgsign=false", "commit", "-m", "Add gear");
  return dir;
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

/** No CI and no Do Not Track, with a telemetry key: the picker offers its telemetry row. */
const TELEMETRY_ASKS: Record<string, string | undefined> = {
  CI: undefined, GITHUB_ACTIONS: undefined, GITLAB_CI: undefined, BUILDKITE: undefined, CIRCLECI: undefined,
  TEAMCITY_VERSION: undefined, JENKINS_URL: undefined, TF_BUILD: undefined, BUILD_NUMBER: undefined,
  DO_NOT_TRACK: undefined, GRAFT_POSTHOG_KEY: ["fixture", "key"].join("-"),
};

const ok = (on: string, body: unknown = {}): Route => ({ on, status: 200, body });

after(() => {
  for (const dir of scratch.reverse()) rmSync(dir, { recursive: true, force: true });
});

describe("which agents", () => {
  test("--list-agents prints every agent id and writes nothing", () => {
    const repo = scratchDir("list");
    const r = cli(["init", repo, "--list-agents"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /^claude$/m);
    assert.match(r.stdout, /^cursor$/m);
    assert.deepEqual(readdirSync(repo), []);
  });

  test("--agents auto --dry-run with no agent installed names none", () => {
    const repo = codeRepo("auto-dry");
    const r = cli(["init", repo, "--agents", "auto", "--dry-run"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /--agents auto: repo files for Claude Code, Cursor, Codex and OpenCode; laptop settings for none \(no agent found here\)/);
    assert.equal(existsSync(join(repo, ".claude")), false);
  });

  test("--agents auto --dry-run --global plans the laptop settings of an agent installed here", () => {
    const repo = codeRepo("auto-global");
    const home = scratchDir("auto-global-home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const r = cli(["init", repo, "--agents", "auto", "--dry-run", "--global"], { home });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /laptop settings for /);
    assert.doesNotMatch(r.stderr, /no agent found here/);
  });

  test("--all-agents --dry-run plans every agent", () => {
    const repo = codeRepo("all-dry");
    const r = cli(["init", repo, "--all-agents", "--dry-run"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /cursor/i);
    assert.match(r.stderr, /claude/i);
    assert.equal(existsSync(join(repo, ".cursor")), false);
  });

  test("the picker at a terminal: every agent unticked writes nothing", () => {
    const repo = scratchDir("none-picked");
    const r = cli(["init", repo, "--no-build"], { tty: ["stdin", "stderr"], input: "a a\r" });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /· no agents selected, nothing written/);
    assert.equal(existsSync(join(repo, ".claude")), false);
  });

  test("the picker at a terminal: q cancels and nothing is written", () => {
    const repo = scratchDir("picker-cancel");
    const r = cli(["init", repo, "--no-build"], { tty: ["stdin", "stderr"], input: "q" });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /· cancelled, nothing written/);
    assert.equal(existsSync(join(repo, ".claude")), false);
  });

  test("the picker at a terminal records the telemetry answer before wiring", () => {
    const repo = scratchDir("picker-consent");
    const home = scratchDir("picker-consent-home");
    const r = cli(["init", repo, "--no-build", "--no-global"], { home, tty: ["stdin", "stderr"], input: "\r", env: TELEMETRY_ASKS });
    assert.equal(r.status, 0, r.detail);
    assert.ok(existsSync(join(repo, ".claude", "settings.json")), r.detail);
    const state = JSON.parse(readFileSync(join(home, ".graft", "telemetry.json"), "utf8"));
    assert.equal(state.enabled, false, r.detail);
    assert.equal(typeof state.noticeShownAt, "string");
  });
});

describe("just me or the team", () => {
  test("--just-me and --team together are refused", () => {
    const repo = codeRepo("both");
    const r = trail(["init", repo, "--agents", "claude", "--just-me", "--team", "--no-build"]);
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ --just-me and --team are the two answers to one question: give one/);
    assert.equal(existsSync(join(repo, ".claude")), false);
  });

  test("asked at a terminal: closing the input cancels", () => {
    const repo = codeRepo("ask-cancel");
    const r = trail(["init", repo, "--agents", "claude", "--no-build", "--no-global"], { tty: ["stdin", "stderr"], input: "" });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /· cancelled, nothing written/);
    assert.equal(existsSync(join(repo, ".claude")), false);
  });

  test("asked at a terminal: just me keeps init's files out of git", () => {
    const repo = codeRepo("ask-me");
    const home = scratchDir("ask-me-home");
    const r = trail(["init", repo, "--agents", "claude", "cursor", "--no-build", "--no-global", "--plain"], { home, tty: ["stdin", "stderr"], input: "2\n" });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /· just for you: git sees nothing trail added/);
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /\.trail/);
    assert.match(exclude, /\.cursor/);
    assert.equal(git(repo, "status", "--porcelain"), "");

    // Run again with no answer to give: the repo stays just for this person.
    const again = trail(["init", repo, "--agents", "claude", "--no-build", "--no-global", "--plain"], { home });
    assert.equal(again.status, 0, again.detail);
    assert.match(again.stderr, /· just for you: git sees nothing trail added/);
    assert.match(again.stderr, /- removed cursor \(agent not selected\)/);
  });

  test("--just-me names a file init changes that git already tracks", () => {
    const repo = codeRepo("me-tracked");
    mkdirSync(join(repo, ".trail"));
    writeFileSync(join(repo, ".trail", "hook.cjs"), "// an older shim\n");
    git(repo, "add", "--", ".trail");
    git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "Shim");
    const r = trail(["init", repo, "--agents", "claude", "--just-me", "--no-build", "--no-global", "--plain"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /⚠ git tracks \.trail[\\/]hook\.cjs, so trail's change to it shows in git status: leave it out of your commits/);
  });
});

describe("--pair", () => {
  test("a --server that isn't a URL stops it", () => {
    const repo = codeRepo("pair-server");
    const r = trail(["init", repo, "--pair", "PAIR-CODE-1", "--server", "trail.acme", "--agents", "claude", "--no-build"]);
    assert.equal(r.status, 1, r.detail);
    assert.equal(existsSync(join(repo, ".claude")), false);
  });

  test("a pair code that isn't one is refused", () => {
    const repo = codeRepo("pair-code");
    const r = trail(["init", repo, "--pair", "no", "--server", SERVER, "--agents", "claude", "--no-build"]);
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ --pair takes the code from Trail's onboarding page, got "no"/);
  });

  test("Trail not answering in time stops it, saying where", () => {
    const repo = codeRepo("pair-timeout");
    const r = trail(["init", repo, "--pair", "PAIR-CODE-1", "--server", SERVER, "--agents", "claude", "--no-build"], {
      routes: [{ on: "POST /api/cli/handoffs", status: 0, timeout: true }],
    });
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ Trail at http:\/\/trail\.test didn't answer in time, so Trail's page can't follow this setup\./);
    assert.equal(existsSync(join(repo, ".claude")), false);
  });

  test("Trail turning the run down still sets up here", () => {
    const repo = codeRepo("pair-refused");
    const r = trail(["init", repo, "--pair", "PAIR-CODE-1", "--server", SERVER, "--agents", "claude", "--no-build", "--no-global", "--plain"], {
      routes: [{ on: "POST /api/cli/handoffs", status: 403, body: { error: "that pair code is spent" } }],
    });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /⚠ couldn't tell Trail about this run \(that pair code is spent\); setting up here anyway/);
    assert.ok(existsSync(join(repo, ".claude", "settings.json")), r.detail);
  });

  test("a paired run reports each step to Trail's page and hands over", () => {
    const repo = codeRepo("pair-ok");
    const home = scratchDir("pair-ok-home");
    const log = join(home, "fetch.jsonl");
    const r = trail(["init", repo, "--pair", "PAIR-CODE-1", "--server", SERVER, "--no-agents", "--no-global", "--plain", "--look-back"], {
      home,
      fetchLog: log,
      routes: [ok("POST /api/cli/handoffs/progress"), ok("POST /api/cli/handoffs", { url: `${SERVER}/pair/abc` })],
    });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /· Trail's page is following along · http:\/\/trail\.test\/pair\/abc/);
    assert.match(r.stderr, /✓ Trail has what it found · review it in the browser: http:\/\/trail\.test\/pair\/abc/);
    assert.match(r.stderr, /\[trail\] Tell the user, in one line/);
    const sent = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { path: string; body: Record<string, unknown> });
    assert.equal(sent[0]!.path, "/api/cli/handoffs");
    assert.ok(sent.some((s) => s.body?.agent === "claude"), JSON.stringify(sent));
    assert.ok(sent.some((s) => s.body?.done === true), JSON.stringify(sent));
    assert.ok(sent.some((s) => Array.isArray(s.body?.log) && String(s.body.log).startsWith("Mapped ")), JSON.stringify(sent));
  });
});

describe("what init says", () => {
  test("--claude-memory - reads the export from stdin", () => {
    const repo = codeRepo("memory-stdin");
    const r = trail(["init", repo, "--agents", "claude", "--yes", "--no-build", "--no-global", "--plain", "--claude-memory", "-"], {
      input: "I prefer tabs over spaces in TypeScript code.\n",
    });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /Claude\.ai knows about you|found nothing in that file/);
  });

  test("--verbose on a workspace parent wires each child and names it", () => {
    const root = workspaceRoot("verbose-ws");
    const r = cli(["init", root, "--agents", "claude", "--verbose", "--no-build", "--no-global"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /· workspace: wiring .+ and 2 child repo\(s\): alpha, beta/);
    assert.match(r.stderr, /^· alpha\/$/m);
    assert.match(r.stderr, /^· beta\/$/m);
  });

  test("--verbose with --agents auto sums up the laptop", () => {
    const repo = codeRepo("verbose-auto");
    const r = cli(["init", repo, "--agents", "auto", "--verbose", "--no-build"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /^✓ /m);
  });

  test("a built graph is counted, with its languages", () => {
    const repo = codeRepo("graph-built");
    const r = cli(["init", repo, "--agents", "claude", "--no-global"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /✓ graph built · \d+ nodes, \d+ edges from \d+ files? · languages: .*typescript/);
  });

  test("a workspace whose graph is built already says so", () => {
    const root = workspaceRoot("graph-ready-ws");
    const b = cli(["build", root, "--no-gitignore", "--no-ignore"]);
    assert.equal(b.status, 0, b.detail);
    const r = cli(["init", root, "--agents", "claude", "--no-global"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /^✓ graph ready$/m);
  });

  test("--verbose builds the graph itself, and says an .mcp.json it can't read is left alone", () => {
    const repo = codeRepo("mcp-bad");
    writeFileSync(join(repo, ".mcp.json"), "{ not json");
    const r = cli(["init", repo, "--agents", "claude", "--verbose", "--no-global"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /⚠ \.mcp\.json: .+ left unchanged \(not valid JSON\); add the graft server manually/);
    assert.match(r.stderr, /✓ built the graph \(graft build\)/);
    assert.equal(readFileSync(join(repo, ".mcp.json"), "utf8"), "{ not json");
  });

  test("--verbose again: the server is registered already, and an agent dropped is removed file by file", () => {
    const repo = codeRepo("mcp-again");
    const home = scratchDir("mcp-again-home");
    const first = cli(["init", repo, "--agents", "claude", "cursor", "--no-build", "--no-global"], { home });
    assert.equal(first.status, 0, first.detail);
    const r = cli(["init", repo, "--agents", "claude", "--verbose", "--no-build", "--no-global"], { home });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /· mcp claude: .+ \(already registered\)/);
    assert.match(r.stderr, /^- removed .+: agent not selected$/m);
  });

  test("every agent's files: the commit line folds past five", () => {
    const repo = codeRepo("all-commit");
    const r = cli(["init", repo, "--all-agents", "--no-build", "--no-global"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /· commit .+ \+\d+ more to share it: graft\/ stays local and git-ignored/);
  });

  test("learnings from more than one person, one with no author", () => {
    const repo = codeRepo("learnings");
    const home = scratchDir("learnings-home");
    for (const [title, author] of [["Gear turns twice", "Ada"], ["Gear rounds down", "Bo"]]) {
      const n = trail(["note", repo, "--title", title!, "-m", `## Decided\n${title}: turn() in src/gear.ts doubles its input.`, "--touches", "src/gear.ts", "--author", author!, "--anyway"], { home });
      assert.equal(n.status, 0, n.detail);
    }
    const dir = join(repo, ".trail", "learnings");
    const file = readdirSync(dir).find((f) => f.endsWith(".md"))!;
    writeFileSync(join(dir, file), readFileSync(join(dir, file), "utf8").replace(/^author:.*\r?\n/m, ""));
    git(repo, "add", "--", ".trail");
    git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "Learnings");
    const r = trail(["init", repo, "--agents", "claude", "--yes", "--no-build", "--no-global", "--plain"], { home });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /✓ learnings {2}2 in \.trail\/learnings\/, from 2 people/);
  });
});

describe("--connect", () => {
  const connected = ok("POST /api/public/cli/connect", { token: "fixture-workspace-pass", workspace: { id: "w1", name: "Acme", slug: "acme" }, user: { id: "u1", name: "Ada" } });

  test("at a terminal, the summary Trail didn't take says how to send it again", () => {
    const repo = codeRepo("connect-tty");
    const r = trail(["init", repo, "--connect", "TRL-7F2A-K9QD", "--server", SERVER, "--agents", "claude", "--no-build", "--no-global", "--team", "--plain"], {
      tty: ["stdin", "stderr"],
      routes: [connected, ok("POST /api/cli/onboarding/events"), { on: "POST /api/cli/repos/summary", status: 500 }],
    });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /✓ connected to workspace Acme/);
    assert.match(r.stderr, /· couldn't send the summary to Trail this time · with a new code from http:\/\/trail\.test\/welcome\/code/);
    assert.doesNotMatch(r.stderr, /Claude Code gets your team's learnings/);
  });

  test("a summary with no learnings and no teammates counts them in the plural", () => {
    const repo = codeRepo("connect-plural");
    const r = trail(["init", repo, "--connect", "TRL-7F2A-K9QD", "--server", SERVER, "--agents", "claude", "--no-build", "--no-global", "--plain"], {
      routes: [connected, ok("POST /api/cli/onboarding/events"), ok("POST /api/cli/repos/summary")],
    });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /✓ sent Acme a summary: .*0 learnings, 0 teammate branches on your files/);
  });

  test("an init that sets nothing up still flushes what it told Trail", () => {
    // Run from the home folder: init refuses, after the code is claimed.
    const home = scratchDir("connect-home");
    const log = join(home, "fetch.jsonl");
    const r = trail(["init", home, "--connect", "TRL-7F2A-K9QD", "--server", SERVER, "--no-build"], {
      home,
      fetchLog: log,
      routes: [connected, ok("POST /api/cli/onboarding/events")],
    });
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✓ connected to workspace Acme/);
    assert.match(readFileSync(log, "utf8"), /"stage":"connected"/);
    assert.equal(existsSync(join(home, ".claude", "settings.json")), false);
  });

  test("a workspace parent with no Claude Code: Trail hears it was mapped and that nothing was learned", () => {
    const root = workspaceRoot("connect-ws");
    const home = scratchDir("connect-ws-home");
    const log = join(home, "fetch.jsonl");
    const r = trail(["init", root, "--connect", "TRL-7F2A-K9QD", "--server", SERVER, "--agents", "cursor", "--no-build", "--no-global"], {
      home,
      fetchLog: log,
      routes: [connected, ok("POST /api/cli/onboarding/events"), ok("POST /api/cli/repos/summary")],
    });
    assert.equal(r.status, 0, r.detail);
    const stages = readFileSync(log, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { body: { stage?: string } }).body.stage);
    assert.ok(stages.includes("mapped"), stages.join(","));
    assert.ok(stages.includes("learned"), stages.join(","));
    assert.doesNotMatch(r.stderr, /Claude Code gets your team's learnings/);
  });

  test("connected again: Claude Code's entry is already there, so nothing to restart", () => {
    const repo = codeRepo("connect-again");
    const home = scratchDir("connect-again-home");
    const routes = [connected, ok("POST /api/cli/onboarding/events"), ok("POST /api/cli/repos/summary")];
    const args = ["init", repo, "--connect", "TRL-7F2A-K9QD", "--server", SERVER, "--agents", "claude", "--no-build", "--plain"];
    const first = trail(args, { home, routes });
    assert.equal(first.status, 0, first.detail);
    assert.match(first.stderr, /✓ Claude Code gets your team's learnings and skills in every project/);
    const again = trail(args, { home, routes });
    assert.equal(again.status, 0, again.detail);
    assert.match(again.stderr, /✓ sent Acme a summary/);
    assert.doesNotMatch(again.stderr, /Claude Code gets your team's learnings/);
  });
});

describe("more of what init says", () => {
  test("asked at a terminal: enter shares trail with the team", () => {
    const repo = codeRepo("ask-team");
    const r = trail(["init", repo, "--agents", "claude", "--no-build", "--no-global", "--plain"], { tty: ["stdin", "stderr"], input: "\n" });
    assert.equal(r.status, 0, r.detail);
    assert.doesNotMatch(r.stderr, /just for you/);
    assert.match(r.stderr, /· commit .+ once: after that, teammates' Claude reads your learnings/);
  });

  test("a graph built with -e keeps its extensions in init's language line", () => {
    const repo = codeRepo("graph-ext");
    const b = cli(["build", repo, "-e", ".ts", "--no-gitignore", "--no-ignore"]);
    assert.equal(b.status, 0, b.detail);
    const r = cli(["init", repo, "--agents", "claude", "--no-global"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /^✓ graph ready · \d+ nodes, \d+ edges/m);
  });

  test("a build's warnings are passed on", () => {
    const repo = codeRepo("graph-warn");
    writeFileSync(join(repo, "ledger.cob"), "       IDENTIFICATION DIVISION.\n");
    const r = cli(["init", repo, "--agents", "claude", "--no-global"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /^⚠ unindexed source extensions: \.cob \(COBOL, 1 file: no parser\)/m);
    assert.match(r.stderr, /✓ graph built · /);
  });

  test("--verbose with no Claude Code builds the graph for the other agents", () => {
    const repo = codeRepo("verbose-cursor");
    const r = cli(["init", repo, "--agents", "cursor", "--verbose", "--no-global"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /✓ built the graph \(graft build\)/);
  });

  test("--verbose names a .claude/settings.json it can't read", () => {
    const repo = codeRepo("settings-bad");
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(repo, ".claude", "settings.json"), "{ not json");
    const r = cli(["init", repo, "--agents", "claude", "--verbose", "--no-build", "--no-global"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /^⚠ .*\.claude\/settings\.json/m);
    assert.equal(readFileSync(join(repo, ".claude", "settings.json"), "utf8"), "{ not json");
  });

  test("Claude Code's notes and a Claude.ai export, kept with no one to ask", () => {
    const repo = codeRepo("kept");
    const home = scratchDir("kept-home");
    writeFileSync(join(repo, "src", "retry.ts"), "export const MAX = 4;\n");
    const project = claudeProjectDir(repo, home);
    mkdirSync(join(project, "memory"), { recursive: true });
    writeFileSync(join(project, "memory", "retry.md"), "---\nname: retry-budget\ndescription: Retries stay at 4 because the gateway times out at 30 s\ntype: project\n---\n\nKeep MAX at 4 in src/retry.ts.\n");
    writeFileSync(join(project, "memory", "gear.md"), "---\nname: gear-doubles\ndescription: turn() in src/gear.ts doubles its input on purpose\ntype: project\n---\n\nKeep the doubling in src/gear.ts.\n");
    const exported = join(home, "claude-ai.txt");
    writeFileSync(exported, "**Work context**\n\n- The user builds the gear API in TypeScript and deploys it with npm run release.\n- Retries in src/retry.ts stay at 4 because the gateway times out after 30 seconds.\n");
    const r = trail(["init", repo, "--agents", "claude", "--yes", "--no-build", "--no-global", "--plain", "--claude-memory", exported], { home });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /✓ kept 2 of the 2 notes your Claude keeps about this repo/);
    assert.match(r.stderr, /✓ kept 2 things Claude\.ai knows about you, just for you/);
    assert.match(r.stderr, /→ 2 team learnings in \.trail\/learnings\/ aren't committed yet\. Ask the user: "Commit the 2 so your teammates' Claude starts from them\? \(yes \/ no\)"/);
  });
});

describe("uninstall", () => {
  test("a folder init never touched has nothing to remove", () => {
    const repo = scratchDir("uninstall-none");
    const r = cli(["uninstall", repo]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /· nothing to remove: no graft wiring found here/);
  });

  test("machine-wide entries are marked, and a file it can't read is left as-is", () => {
    const repo = codeRepo("uninstall-bad");
    const home = scratchDir("uninstall-bad-home");
    const init = cli(["init", repo, "--agents", "claude", "cursor", "--no-build", "--global"], { home });
    assert.equal(init.status, 0, init.detail);
    writeFileSync(join(repo, ".cursor", "mcp.json"), "{ not json");

    const plan = cli(["uninstall", repo], { home });
    assert.equal(plan.status, 0, plan.detail);
    assert.match(plan.stderr, / \[machine-wide\]/);
    assert.match(plan.stderr, /⚠ would remove: .+: not valid JSON, left untouched \(remove the graft entry by hand\)/);

    const r = cli(["uninstall", repo, "-y", "--keep-cache"], { home });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /⚠ 1 file\(s\) could not be removed and were left as-is: see above\./);
    assert.equal(readFileSync(join(repo, ".cursor", "mcp.json"), "utf8"), "{ not json");
  });
});
