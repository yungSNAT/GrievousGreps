/**
 * Gap tests for src/skills/anchors-wide.ts. They cover how CI targets and `--ref`
 * values are read, the branch check against a real git checkout, compose calls
 * and files, CLI calls through npx, npm exec and node, and `cd` handling.
 */
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { composeServices, wideAnchorsOf, wideGone, type WideAnchor } from "../src/skills/anchors-wide.js";
import type { ParsedSkill } from "../src/skills/types.js";

void mock;

function skill(cmds: string[]): ParsedSkill {
  return {
    name: "x", description: "", meta: { trail: "s-000001", scope: "personal", asks: "", version: "1" },
    steps: cmds.map((cmd, i) => ({ n: i + 1, cmd, gated: null, bg: false, wait: false })),
    check: null, checkShows: null, ifFails: [], dontUse: "", params: [], hash: "sha256:x",
  } as ParsedSkill;
}

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function dir(tag: string): string {
  const d = tmpRepo(`wide-gaps-${tag}`);
  mkdirSync(d, { recursive: true });
  made.push(d);
  return d;
}
function put(top: string, rel: string, text: string): void {
  mkdirSync(join(top, rel, ".."), { recursive: true });
  writeFileSync(join(top, rel), text);
}
const kinds = (a: WideAnchor[]) => a.map((x) => `${x.kind}:${x.name}#${x.step}`);
const withWhere = (a: WideAnchor[]) => a.map((x) => `${x.kind}:${x.name}#${x.step}@${x.where}`);
const anchors = (top: string, cmds: string[]) => kinds(wideAnchorsOf(skill(cmds), top, {}));
const goneIn = (top: string, cmds: string[], env: NodeJS.ProcessEnv = {}) =>
  kinds(wideGone(skill(cmds), top, env, { scan: true, deadline: Date.now() + 10_000 }));

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

describe("finding CI anchors", () => {
  let top: string;
  before(() => { top = dir("ci-find"); mkdirSync(join(top, ".git"), { recursive: true }); });

  test("gh workflow and gh run calls name a CI file; ids, paths, params and other repos don't", () => {
    const cmds = [
      "gh workflow run deploy.yml",
      "gh workflow view -R acme/other lint.yml",
      "gh workflow run 12345",
      "gh workflow run .github/workflows/x.yml",
      "gh workflow run \"$WF\"",
      "gh run list --workflow=build.yml",
      "gh run watch --workflow nightly",
      "gh run list -w lint",
      "gh workflow run -f env=prod --ref main -- release",
      "gh workflow view --json name Smoke",
      "gh workflow run",
      "gh run watch -w other",
      "gh pr list",
      "gh workflow run deploy.yml",
    ];
    const out = wideAnchorsOf(skill(cmds), top, {});
    assert.deepEqual(kinds(out), [
      "ci-file:deploy.yml#1", "ci-file:build.yml#6", "ci-file:nightly#7",
      "ci-file:lint#8", "ci-file:release#9", "ci-file:Smoke#10",
    ]);
    assert.ok(out.every((a) => a.where === "GitHub Actions"));
  });

  test("GH_REPO anywhere in the skill means no CI anchor is read", () => {
    assert.deepEqual(anchors(top, ["GH_REPO=acme/x gh workflow run deploy.yml"]), []);
  });

  test("an empty checkout yields nothing from either export", () => {
    assert.deepEqual(wideAnchorsOf(skill(["gh workflow run a.yml"]), ""), []);
    assert.deepEqual(wideGone(skill(["gh workflow run a.yml"]), "", {}, { scan: false }), []);
  });
});

describe("folders a step runs in", () => {
  let top: string;
  before(() => {
    top = dir("cd");
    mkdirSync(join(top, ".git"), { recursive: true });
    mkdirSync(join(top, "sub", "deeper"), { recursive: true });
    mkdirSync(join(top, "nested", ".git"), { recursive: true });
  });

  test("a cd into a subfolder is followed, and later steps are not known", () => {
    assert.deepEqual(anchors(top, ["cd sub && gh workflow run a.yml", "gh workflow run b.yml"]), ["ci-file:a.yml#1"]);
    assert.deepEqual(anchors(top, ["cd sub/deeper && gh workflow run a.yml"]), ["ci-file:a.yml#1"]);
  });

  test("a nested repo, a param, a parent folder, home or an absolute path: not judged", () => {
    assert.deepEqual(anchors(top, ["cd nested && gh workflow run a.yml"]), []);
    assert.deepEqual(anchors(top, ["cd \"$DIR\" && gh workflow run a.yml"]), []);
    assert.deepEqual(anchors(top, ["cd .. && gh workflow run a.yml"]), []);
    assert.deepEqual(anchors(top, ["cd ~/x && gh workflow run a.yml"]), []);
    assert.deepEqual(anchors(top, ["cd /tmp && gh workflow run a.yml"]), []);
  });

  test("a cd partway through a step stops reading the rest", () => {
    assert.deepEqual(anchors(top, ["gh workflow run a.yml; cd sub; gh workflow run b.yml", "gh workflow run c.yml"]),
      ["ci-file:a.yml#1"]);
  });
});

describe("compose calls", () => {
  test("services are read from compose.yaml or a literal -f file; unknown flags and other files are not", () => {
    const top = dir("compose-find");
    put(top, "compose.yaml", "services:\n  web:\n    image: x\n");
    put(top, "other.yml", "services:\n  worker:\n    image: y\n");
    const cmds = [
      "docker compose up -d web db",
      "docker-compose -f other.yml run --rm worker echo hi",
      "docker compose --env-file .env.prod up api",
      "docker compose up --mystery api",
      "docker compose -f a.yml -f b.yml up api",
      "docker compose -f ../outside.yml up api",
      "docker compose -p shop logs -t -f queue",
      "docker compose build web",
      "docker compose up \"$SVC\"",
      "docker compose -f .github/workflows/x.yml up api",
    ];
    assert.deepEqual(withWhere(wideAnchorsOf(skill(cmds), top, {})), [
      "service:web#1@compose.yaml", "service:db#1@compose.yaml",
      "service:worker#2@other.yml", "service:queue#7@compose.yaml",
    ]);
  });

  test("no compose file in the folder: nothing to anchor", () => {
    const top = dir("compose-none");
    assert.deepEqual(anchors(top, ["docker compose up web"]), []);
  });

  test("a service is gone only when the compose file is the one used and lacks it", () => {
    const top = dir("compose-gone");
    put(top, "compose.yaml", "services:\n  web:\n    image: x\n  db:\n    image: y\n");
    assert.deepEqual(goneIn(top, ["docker compose up web cache"]), ["service:cache#1"]);
    assert.deepEqual(goneIn(top, ["docker compose up web cache"], { COMPOSE_FILE: "x.yml" }), [], "COMPOSE_FILE in env");
    assert.deepEqual(goneIn(top, ["COMPOSE_FILE=x.yml docker compose up cache"]), [], "COMPOSE_FILE in the skill");
    put(top, ".env", "export COMPOSE_FILE=other.yml\n");
    assert.deepEqual(goneIn(top, ["docker compose up cache"]), [], ".env names another file");
    rmSync(join(top, ".env"));
    put(top, "compose.override.yaml", "services:\n  cache:\n    image: z\n");
    assert.deepEqual(goneIn(top, ["docker compose up cache"]), [], "an override may add it");
    assert.deepEqual(goneIn(top, ["docker compose -f compose.yaml up cache"]), ["service:cache#1"], "a literal -f ignores overrides");
  });
});

describe("composeServices", () => {
  test("reads the keys one indent under services", () => {
    const s = composeServices("version: '3'\nservices:\n  web:\n    image: x\n\n  # note\n  \"api\":\n    image: y\n  'db': {}\nvolumes:\n  data:\n");
    assert.deepEqual([...(s ?? [])].sort(), ["api", "db", "web"]);
  });

  test("returns null when it can't be sure", () => {
    assert.equal(composeServices("include:\n  - a.yml\nservices:\n  web: {}\n"), null);
    assert.equal(composeServices("x: &a\n  b: 1\nservices:\n  web:\n    <<: *a\n"), null);
    assert.equal(composeServices("services:\n  web: {}\nservices:\n  db: {}\n"), null);
    assert.equal(composeServices("services: {web: {}}\n"), null);
    assert.equal(composeServices("name: x\n"), null);
    assert.equal(composeServices("services:\n\tweb: {}\n"), null);
    assert.equal(composeServices("services:\n    web:\n      image: x\n  db: {}\n"), null);
    assert.equal(composeServices("services:\n  - web\n"), null);
  });
});

describe("CLI calls", () => {
  let top: string;
  before(() => {
    top = dir("cli");
    mkdirSync(join(top, ".git"), { recursive: true });
    put(top, "package.json", JSON.stringify({ name: "@acme/cli", bin: { acme: "dist/cli.js" } }));
  });

  test("the bin, npx and npm exec name a subcommand; flags first, other programs and odd words don't", () => {
    const cmds = [
      "acme deploy",
      "npx acme status",
      "npm exec -y acme build",
      "npx --yes",
      "node --inspect dist/cli.js lint",
      "node other.js login",
      "acme --verbose sync",
      "other deploy",
      "npx -q",
      "acme X",
      "node",
    ];
    const out = wideAnchorsOf(skill(cmds), top, {});
    assert.deepEqual(kinds(out), ["subcommand:deploy#1", "subcommand:status#2", "subcommand:build#3"]);
    assert.ok(out.every((a) => a.where === "acme"));
  });

  test("node with the bin's target names the bin's subcommand", () => {
    assert.deepEqual(withWhere(wideAnchorsOf(skill(["node dist/cli.js connect"]), top, {})), ["subcommand:connect#1@acme"]);
  });
});

describe("judging CI files in a real checkout", () => {
  let top: string;
  let env: NodeJS.ProcessEnv;
  before(() => {
    top = dir("ci-git");
    git(top, "init", "-q", "-b", "main");
    git(top, "commit", "-q", "--allow-empty", "-m", "init");
    git(top, "remote", "add", "origin", "https://example.invalid/acme/shop.git");
    git(top, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(top, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    put(top, ".github/workflows/ci.yml", "name: CI\non: push\n");
    env = { HOME: join(top, "home"), TRAIL_HOME: join(top, "trail") };
  });

  test("on the default branch at the fetched commit, a missing file or name is gone", () => {
    assert.deepEqual(goneIn(top, ["gh workflow run deploy.yml", "gh workflow run Deploy", "gh workflow run ci", "gh workflow run CI"], env),
      ["ci-file:deploy.yml#1", "ci-file:Deploy#2"]);
  });

  test("--ref naming this branch judges; another, an unreadable or a missing value does not", () => {
    assert.deepEqual(goneIn(top, ["gh workflow run deploy.yml --ref=main"], env), ["ci-file:deploy.yml#1"]);
    assert.deepEqual(goneIn(top, ["gh workflow run deploy.yml --ref refs/heads/main"], env), ["ci-file:deploy.yml#1"]);
    assert.deepEqual(goneIn(top, ["gh workflow run deploy.yml --ref=v1.x"], env), []);
    assert.deepEqual(goneIn(top, ["gh workflow run deploy.yml --ref=\"$BR\""], env), []);
    assert.deepEqual(goneIn(top, ["gh workflow run deploy.yml -r"], env), []);
    assert.deepEqual(goneIn(top, ["gh workflow run deploy.yml --ref \"$BR\""], env), []);
  });

  test("GH_REPO in the environment points gh elsewhere: not judged", () => {
    assert.deepEqual(goneIn(top, ["gh workflow run deploy.yml"], { ...env, GH_REPO: "acme/other" }), []);
  });

  test("a detached HEAD is not on the default branch: not judged", () => {
    const d = dir("ci-detached");
    git(d, "init", "-q", "-b", "main");
    git(d, "commit", "-q", "--allow-empty", "-m", "init");
    git(d, "remote", "add", "origin", "https://example.invalid/acme/shop.git");
    git(d, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(d, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    put(d, ".github/workflows/ci.yml", "name: CI\n");
    assert.deepEqual(goneIn(d, ["gh workflow run deploy.yml"]), ["ci-file:deploy.yml#1"]);
    git(d, "checkout", "-q", "--detach");
    assert.deepEqual(goneIn(d, ["gh workflow run deploy.yml"]), []);
  });
});
