import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { runCli, type CliOptions } from "./cli-gaps-driver.js";

const scratch: string[] = [];
let home: string;
let repo: string;

function scratchDir(tag: string): string {
  const dir = tmpRepo(`cli-gaps-4-${tag}`);
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
  writeFileSync(join(dir, "src", "score.ts"), "export function score(v: number): number {\n  return v + 1;\n}\n");
  git(dir, "add", "--", "src");
  git(dir, "-c", "commit.gpgsign=false", "commit", "-m", "Add score");
  return dir;
}

function build(dir: string): void {
  const r = cli(["build", dir, "--no-gitignore", "--no-ignore"]);
  assert.equal(r.status, 0, r.detail);
}

before(() => {
  home = scratchDir("home");
  repo = codeRepo("repo");
  build(repo);
});

after(() => {
  for (const dir of scratch.reverse()) rmSync(dir, { recursive: true, force: true });
});

describe("telemetry", () => {
  test("status, enable, debug and disable each say what they did and keep the choice", () => {
    const h = scratchDir("telemetry-home");
    const state = join(h, ".graft", "telemetry.json");

    const status = cli(["telemetry"], { home: h });
    assert.equal(status.status, 0, status.detail);
    assert.match(status.stdout, /^telemetry: off: /m);

    const on = cli(["telemetry", "enable"], { home: h });
    assert.equal(on.status, 0, on.detail);
    assert.match(on.stdout, /telemetry: on, anonymous and aggregate-only\. `graft telemetry status` for details\./);
    assert.equal(JSON.parse(readFileSync(state, "utf8")).enabled, true);

    const debug = cli(["telemetry", "debug"], { home: h });
    assert.equal(debug.status, 0, debug.detail);
    assert.match(debug.stdout, /telemetry: nothing queued\./);

    const off = cli(["telemetry", "disable"], { home: h });
    assert.equal(off.status, 0, off.detail);
    assert.match(off.stdout, /telemetry: off\. Nothing further will be recorded or sent\./);
    const saved = JSON.parse(readFileSync(state, "utf8"));
    assert.equal(saved.enabled, false);
    assert.ok(saved.noticeShownAt, "turning it off also marks the notice as shown");
  });

  test("an unknown action fails and lists the ones there are", () => {
    const r = cli(["telemetry", "maybe"]);
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ unknown action "maybe": expected status, enable, disable, or debug/);
    assert.equal(r.stdout, "");
  });
});

test("version prints the installed version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const r = cli(["version"]);
  assert.equal(r.status, 0, r.detail);
  assert.ok(r.stdout.includes(pkg.version), r.detail);
});

describe("summary", () => {
  test("shows the view in force, sets one, and names TRAIL_SUMMARY when that chose it", () => {
    const h = scratchDir("summary-home");
    const first = cli(["summary"], { home: h });
    assert.equal(first.status, 0, first.detail);
    assert.match(first.stdout, /^\[graft\] summary: full\. The next prompt and edit use it; nothing to restart\./m);

    const set = cli(["summary", "one-line"], { home: h, trail: true });
    assert.equal(set.status, 0, set.detail);
    assert.match(set.stdout, /^\[trail\] summary: one-line\. /m);
    assert.doesNotMatch(set.stdout, /from TRAIL_SUMMARY/);

    const fromEnv = cli(["summary"], { home: scratchDir("summary-env"), env: { TRAIL_SUMMARY: "one-line" } });
    assert.equal(fromEnv.status, 0, fromEnv.detail);
    assert.match(fromEnv.stdout, /summary: one-line \(from TRAIL_SUMMARY\)\./);
  });
});

describe("notices before a command", () => {
  test("a person at a terminal is told graft is now trail, once a day", () => {
    const h = scratchDir("rename-home");
    const env = { CI: undefined, PATH: dirname(process.execPath) };
    const first = cli(["summary"], { home: h, tty: ["stderr"], env });
    assert.equal(first.status, 0, first.detail);
    assert.match(first.stderr, /· graft is now trail\. this ran trail summary, and graft keeps working \(shown once a day\)/);
    assert.match(first.stderr, /run npm link in your GrievousGreps folder to get the trail command too/);

    const again = cli(["summary"], { home: h, tty: ["stderr"], env });
    assert.equal(again.status, 0, again.detail);
    assert.doesNotMatch(again.stderr, /graft is now trail/);
  });

  test("a newer release in the update cache is announced", () => {
    const h = scratchDir("nudge-home");
    mkdirSync(join(h, ".graft"), { recursive: true });
    writeFileSync(join(h, ".graft", "update-check.json"), JSON.stringify({ latest: "999.0.0", checkedAt: Date.now() }));
    const r = cli(["summary"], { home: h });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /⬆ graft \S+ → 999\.0\.0 available: run `graft upgrade`/);
  });

  test("the first command where telemetry can run discloses it, once", () => {
    const h = scratchDir("first-run-home");
    const env = { CI: undefined, DO_NOT_TRACK: undefined, GRAFT_TELEMETRY: "1", GRAFT_POSTHOG_KEY: ["fixture", "key"].join("-") };
    const first = cli(["summary"], { home: h, env });
    assert.equal(first.status, 0, first.detail);
    assert.match(first.stderr, /no code, no file paths, no queries/);
    assert.ok(JSON.parse(readFileSync(join(h, ".graft", "telemetry.json"), "utf8")).noticeShownAt);

    const again = cli(["summary"], { home: h, env });
    assert.equal(again.status, 0, again.detail);
    assert.doesNotMatch(again.stderr, /no code, no file paths, no queries/);
  });

  test("trail in a repo an older graft wired says how to move it over", () => {
    const old = scratchDir("stranded");
    mkdirSync(join(old, ".git"));
    mkdirSync(join(old, ".claude", "helpers"), { recursive: true });
    writeFileSync(join(old, ".claude", "helpers", "graft-hooks.cjs"), "require('@nanonets/graft');\n");
    const r = cli(["summary"], { cwd: old, trail: true, tty: ["stderr"], env: { CI: undefined, PATH: dirname(process.execPath) } });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /this repo's agent hooks were set up by an older graft and can't find trail\. run trail init here once/);
  });
});

describe("build flags", () => {
  test("a --concurrency that isn't a number stops the build", () => {
    const r = cli(["build", repo, "--concurrency", "many"]);
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ --concurrency must be a number, got "many"/);
    assert.doesNotMatch(r.stdout, /wiring:/);
  });

  test("a --synth-concurrency that isn't a number stops the build", () => {
    const r = cli(["build", repo, "--synth-concurrency", "lots"]);
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ --synth-concurrency must be a number, got "lots"/);
    assert.doesNotMatch(r.stdout, /wiring:/);
  });

  test("an extension with no parser is named, with the supported set, and the build goes on", () => {
    const r = cli(["build", repo, "--no-gitignore", "--no-ignore", "-e", "zzz", ".ts"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /⚠ -e "\.zzz": no parser registered for this extension, so it is ignored\./);
    assert.match(r.stderr, /supported: .*\.ts/);
    assert.match(r.stdout, /✓ wiring:/);
  });

  test("--deep with no key falls back to the structural build and says how to add one", () => {
    const r = cli(["build", repo, "--deep", "--no-gitignore", "--no-ignore"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /⚠ no API key set, so falling back to the structural build/);
    assert.match(r.stdout, /✓ wiring:/);
    assert.doesNotMatch(r.stdout, /meaning:/);
  });

  test("without --no-gitignore the map is said to be git-ignored", () => {
    const r = cli(["build", repo]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /is git-ignored \(added automatically\), a local cache; teammates run `graft build`/);
  });
});

describe("check", () => {
  test("a repo with no map fails and says to build", () => {
    const r = cli(["check", scratchDir("never-built")]);
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stdout, /graft check: NO GRAPH\n\nNo code map found\. Run `graft build` first\./);
  });

  test("a built repo reports the deep layer as not built and the wiring graph's state", () => {
    const r = cli(["check", repo]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /deep layer: not built \(run `graft build --deep` for concept nodes\); the wiring graph is the source of truth/);
  });

  test("--json gives both layers", () => {
    const r = cli(["check", repo, "--json"]);
    assert.equal(r.status, 0, r.detail);
    const out = JSON.parse(r.stdout);
    assert.ok("context" in out && out.graph && typeof out.graph === "object");
  });
});

describe("stats", () => {
  test("prints the session mix, or the same as JSON", () => {
    const plain = cli(["stats", repo]);
    assert.equal(plain.status, 0, plain.detail);
    assert.ok(plain.stdout.trim().length > 0);
    const json = cli(["stats", repo, "--json"]);
    assert.equal(json.status, 0, json.detail);
    JSON.parse(json.stdout);
  });
});

describe("viz", () => {
  test("an unknown tab is refused before the repo is looked at", () => {
    const r = cli(["viz", scratchDir("viz-none"), "--tabs", "code,graph"]);
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ --tabs takes a comma-separated subset of context, code, outline, not "graph"/);
  });

  test("an empty tab list is refused", () => {
    const r = cli(["viz", repo, "--tabs", " , "]);
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ --tabs takes a comma-separated subset of context, code, outline$/m);
  });

  test("a repo with no context graph is told to build one", () => {
    const r = cli(["viz", scratchDir("viz-empty"), "--no-open"]);
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ no context graph at .*: run `graft build --deep` first/);
  });

  // Run from source, the prebuilt viewer the page is made from isn't there (it is built
  // into dist/): the export says which file it needed and writes nothing.
  test("--export from a checkout with no built viewer names the missing file", () => {
    const out = join(scratchDir("viz-out"), "page");
    const r = cli(["viz", repo, "--export", out, "--title", "PR 1", "--tabs", "code"]);
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /ENOENT.*viewer[\\/]index\.html/);
    assert.ok(!existsSync(join(out, "index.html")));
  });

  test("serving prints the address and opens the browser, or carries on when it can't", () => {
    for (const env of [{ GG_UNREF_SERVERS: "1" }, { GG_UNREF_SERVERS: "1", GG_DETACHED_THROWS: "1" }]) {
      const r = cli(["viz", repo, "--port", "0"], { env });
      assert.equal(r.status, 0, r.detail);
      assert.match(r.stdout, /graft viz → http:\/\/\S+ {2}\(ctrl-c to stop\)/);
    }
    const quiet = cli(["viz", repo, "--port", "0", "--no-open"], { env: { GG_UNREF_SERVERS: "1" } });
    assert.equal(quiet.status, 0, quiet.detail);
    assert.match(quiet.stdout, /\(ctrl-c to stop\)/);
  });
});

describe("note flags", () => {
  test("a --minutes that isn't a number is refused", () => {
    const r = cli(["note", repo, "--title", "Score rounding", "-m", "## Decided\nscore adds one.", "--minutes", "soon"]);
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ --minutes takes a number, got "soon"/);
  });
});

describe("uninstall", () => {
  test("without -y it only lists what it would remove, and says --no-global skips machine-wide entries", () => {
    const r = cli(["uninstall", repo]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /Dry run: nothing was touched\. Re-run with -y to remove\./);
    assert.match(r.stderr, /Entries marked \[machine-wide\] affect every project; --no-global skips them\./);
    const local = cli(["uninstall", repo, "--no-global"]);
    assert.equal(local.status, 0, local.detail);
    assert.doesNotMatch(local.stderr, /machine-wide/);
  });

  test("-y removes the map and says so", () => {
    const dir = codeRepo("uninstall");
    build(dir);
    const r = cli(["uninstall", dir, "-y", "--no-global"]);
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /✓ graft fully removed\. `graft init` re-wires from scratch\./);
    assert.ok(!existsSync(join(dir, "graft")));
  });
});
