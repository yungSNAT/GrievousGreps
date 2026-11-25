import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { runCli, type CliOptions, type Route } from "./cli-gaps-driver.js";
import { cacheDir } from "../src/util/state.js";
import { sessionDir } from "../src/claude/state.js";

// trail team, trail check, trail status and the sign-in paths the other
// cli-gaps files leave: teammates' branches come from this clone's branch cache.

const SERVER = "http://trail.test";
const KEY = "github.com/acme/widgets";
const scratch: string[] = [];

function scratchDir(tag: string): string {
  const dir = tmpRepo(`cli-gaps-team-${tag}`);
  scratch.push(dir);
  return dir;
}

function trail(args: string[], o: Partial<CliOptions> & { home: string }) {
  return runCli(args, { trail: true, ...o });
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(" ")}\n${r.stderr}`);
  return r.stdout;
}

function commitAll(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

function widgetsRepo(tag: string, remote = true): string {
  const dir = scratchDir(tag);
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", "Ada Fixture");
  git(dir, "config", "user.email", "ada@example.invalid");
  if (remote) git(dir, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "gear.ts"), "export function turn(n: number): number {\n  return n * 2;\n}\n");
  commitAll(dir, "Add gear");
  return dir;
}

function workspace(slug: string, name: string) {
  return { id: `ws-${slug}`, name, slug, url: `${SERVER}/w/${slug}`, invite_url: `${SERVER}/join/${slug}` };
}

const token = (slug: string) => ["fixture", "token", slug].join("-");

function cloud(slug: string, name: string, repos: string[], url = SERVER) {
  return { url, token: token(slug), user: { name: "Ada", email: "ada@example.invalid" }, workspace: workspace(slug, name), repos, linkedAt: 1_700_000_000_000 };
}

function homeWith(tag: string, clouds: ReturnType<typeof cloud>[]): string {
  const home = scratchDir(tag);
  if (clouds.length) {
    mkdirSync(join(home, ".trail"), { recursive: true });
    const [first, ...others] = clouds.map((c, i) => ({ ...c, linkedAt: c.linkedAt - i }));
    writeFileSync(join(home, ".trail", "cloud.json"), JSON.stringify(others.length ? { ...first, others } : first));
  }
  return home;
}

/** Save a learning through the CLI, as the given author. */
function note(dir: string, home: string, title: string, author: string, extra: string[] = []): void {
  const r = trail(["note", dir, "--title", title, "-m", `## Decided\n${title}: turn() in src/gear.ts doubles its input.`, "--touches", "src/gear.ts", "--author", author, "--anyway", ...extra], { home });
  assert.equal(r.status, 0, r.detail);
}

/** Teammates' pushed branches, as the background refresh leaves them in this clone's cache. */
function branchCache(dir: string, branches: Array<{ ref: string; author: string; files: string[]; learnings?: Array<{ name: string; text: string }> }>): void {
  const path = join(cacheDir(dir), "trail-branches.json");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ fetchedAt: Date.now(), base: "origin/main", branches: branches.map((b) => ({ at: Date.now() - 60_000, learnings: [], ...b })) }));
}

after(() => {
  for (const dir of scratch.reverse()) rmSync(dir, { recursive: true, force: true });
});

describe("team, from this clone", () => {
  test("names who wrote learnings and where teammates' branches overlap", () => {
    const dir = widgetsRepo("local");
    const home = homeWith("local-home", []);
    note(dir, home, "Gear turns twice", "Ada");
    note(dir, home, "A gear note with a title well over forty characters long", "Bo", ["--always-follow"]);
    branchCache(dir, [
      { ref: "origin/ada-gear", author: "Ada", files: ["src/gear.ts", "src/a.ts", "src/b.ts", ".trail/x.md"] },
      { ref: "origin/bo-gear", author: "Bo", files: ["src/gear.ts", "src/a.ts", "src/b.ts"] },
      { ref: "origin/cy-docs", author: "Cy", files: ["README.md"] },
      { ref: "origin/bo-again", author: "Bo", files: ["src/gear.ts"] },
    ]);
    const r = trail(["team", dir, "--days", "x"], { home });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /^this week in acme\/widgets · from this clone$/m);
    assert.match(r.stdout, /^2 people · 2 new learnings$/m);
    assert.match(r.stdout, /^ {2}Ada +Gear turns twice +1 learning$/m);
    assert.match(r.stdout, /^ {2}Bo +A gear note with a title well over fort… +1 learning$/m);
    // Wrapped at 66 columns; the push time reads "today 14:20" or "Oct 7".
    const overlap = r.stdout.slice(r.stdout.indexOf("\noverlap\n")).replace(/\n {4}/g, " ");
    assert.match(overlap, /● Ada's ada-gear \(pushed [^)]+\) and Bo's bo-gear \(pushed [^)]+\) both change src\/gear\.ts, src\/a\.ts and 1 more/);
    assert.match(overlap, /● Ada's ada-gear \(pushed [^)]+\) and Bo's bo-again \(pushed [^)]+\) both change src\/gear\.ts\n/);
    assert.doesNotMatch(overlap, /Cy/);

    const json = trail(["team", dir, "--json"], { home });
    assert.equal(json.status, 0, json.detail);
    const t = JSON.parse(json.stdout);
    assert.equal(t.learnings, 2);
    assert.deepEqual(t.members.map((m: { name: string }) => m.name).sort(), ["Ada", "Bo"]);
    assert.ok(t.overlaps.length >= 1);
  });

  test("one person, one learning, outside git", () => {
    const dir = scratchDir("local-plain");
    const home = homeWith("local-plain-home", []);
    const r = trail(["team", dir, "--days", "3"], { home });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /^the last 3 days in /m);
  });
});

describe("team, from the workspace", () => {
  test("a repo the workspace hasn't got shows the whole workspace, over the days asked for", () => {
    const dir = widgetsRepo("ws-team");
    const home = homeWith("ws-team-home", [cloud("acme", "Acme", [])]);
    const log = join(scratchDir("ws-team-log"), "fetch.jsonl");
    const view = { workspace: "Acme", repo: "", days: 14, people: 1, sessions: 1, new_learnings: 2, reused: 0, members: [{ name: "Ada", topics: ["gears"], learnings: 1, reused: 0 }], overlaps: [] };
    const r = trail(["team", dir, "--days", "14"], { home, routes: [{ on: "GET /api/cli/team", status: 200, body: view }], fetchLog: log });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /^the last 14 days in Acme$/m);
    assert.match(r.stdout, /^1 person · 1 session · 2 new learnings · reused 0×$/m);
    assert.match(r.stdout, /^ {2}Ada +gears +1 learning$/m);
    const call = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]!) as { path: string };
    assert.doesNotMatch(call.path, /repo=/, "a repo the workspace doesn't have isn't asked about");
  });

  test("from outside git, the newest workspace answers", () => {
    const home = homeWith("ws-team-nogit-home", [cloud("acme", "Acme", [])]);
    const view = { workspace: "Acme", repo: "", days: 7, people: 0, sessions: 0, new_learnings: 0, reused: 0, members: [], overlaps: [] };
    const r = trail(["team", scratchDir("ws-team-nogit")], { home, routes: [{ on: "GET /api/cli/team", status: 200, body: view }] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /^this week in Acme$/m);
  });
});

describe("check, on this machine", () => {
  test("a branch with nothing changed has nothing to check", () => {
    const dir = widgetsRepo("check-none");
    const r = trail(["check", dir, "--base", "main"], { home: homeWith("check-none-home", []) });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /· nothing to check: no changes against main/);
  });

  test("one changed file against one learning, with a teammate's branch on the same file", () => {
    const dir = widgetsRepo("check-one");
    const home = homeWith("check-one-home", []);
    note(dir, home, "Gear turns twice", "Bo");
    commitAll(dir, "Keep the learning");
    git(dir, "checkout", "-q", "-b", "change");
    writeFileSync(join(dir, "src", "gear.ts"), "export function turn(n: number): number {\n  return n * 3;\n}\n");
    commitAll(dir, "Turn three times");
    branchCache(dir, [{ ref: "origin/bo-gear", author: "Bo", files: ["src/gear.ts"] }]);
    const r = trail(["check", dir, "--base", "main"], { home });
    assert.match(r.stdout, /^checking 1 changed file against 1 learning and 0 skills$/m);
    assert.match(r.stdout, /bo-gear/);
  });

  test("a diff over 400 KB is checked only in part, and says so", () => {
    const dir = widgetsRepo("check-big");
    git(dir, "checkout", "-q", "-b", "big");
    writeFileSync(join(dir, "src", "big.ts"), Array.from({ length: 12_000 }, (_, i) => `export const value${i} = ${i}; // padding line for a large diff`).join("\n"));
    commitAll(dir, "Add a big file");
    const r = trail(["check", dir, "--base", "main"], { home: homeWith("check-big-home", []) });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /⚠ the diff is over 400 KB; only the first 400 KB is checked/);
  });
});

describe("status", () => {
  function sessionFile(dir: string, id: string, savedTokens: number, ageDays = 0): void {
    const d = sessionDir(dir);
    mkdirSync(d, { recursive: true });
    const p = join(d, `${id}.json`);
    writeFileSync(p, JSON.stringify({ savedTokens }));
    if (ageDays) {
      const t = (Date.now() - ageDays * 24 * 60 * 60 * 1000) / 1000;
      utimesSync(p, t, t);
    }
  }

  test("tokens saved this week, learnings on branches and just for you, and a repo not in the workspace", () => {
    const dir = widgetsRepo("status-full");
    const home = homeWith("status-full-home", [cloud("acme", "Acme", ["github.com/acme/api", "github.com/acme/web"])]);
    const b = trail(["build", dir], { home });
    assert.equal(b.status, 0, b.detail);
    note(dir, home, "Gear turns twice", "Ada");
    note(dir, home, "My own gear habit", "Ada", ["--personal"]);
    const learning = readdirSync(join(dir, ".trail", "learnings")).find((f) => f.endsWith(".md"))!;
    const text = readFileSync(join(dir, ".trail", "learnings", learning), "utf8").replace("Gear turns twice", "Gear on Bo's branch");
    branchCache(dir, [{ ref: "origin/bo-gear", author: "Bo", files: ["src/gear.ts"], learnings: [{ name: "bo-gear-note.md", text }] }]);
    sessionFile(dir, "s1", 1_250_000);
    sessionFile(dir, "s2", 40_000, 30);
    const r = trail(["status", dir], { home });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /^learnings +1 added to this repo, in \.trail\/learnings\/ · 1 on teammates' branches · 1 just for you, on this machine$/m);
    assert.match(r.stdout, /^workspace +Acme · 2 repos, not this one \(trail workspace add\) · http:\/\/trail\.test\/w\/acme$/m);
    assert.match(r.stdout, /^this week +~1\.3M tokens saved$/m);
  });

  test("thousands of tokens read as k, and fewer as they are", () => {
    for (const [saved, shown] of [[212_345, "212k"], [640, "640"]] as const) {
      const dir = widgetsRepo(`status-${shown}`);
      const home = homeWith(`status-${shown}-home`, []);
      note(dir, home, "Gear turns twice", "Ada");
      sessionFile(dir, "s1", saved);
      mkdirSync(join(sessionDir(dir), "s2.json"));
      const r = trail(["status", dir], { home });
      assert.equal(r.status, 0, r.detail);
      assert.match(r.stdout, new RegExp(`^this week +~${shown} tokens saved$`, "m"));
    }
  });
});

describe("sign-in, the rarer paths", () => {
  const claimed: Route = {
    on: "POST /api/cli/login-codes/claim",
    status: 200,
    body: { token: token("acme"), user: { name: "Ada", email: "ada@example.invalid" }, workspace: workspace("acme", "Acme"), repos: [KEY] },
  };

  test("--code with no --server goes to Trail cloud; the same workspace at a new address is said", () => {
    const dir = widgetsRepo("code-cloud");
    const home = homeWith("code-cloud-home", [cloud("acme", "Acme", [], "http://old.trail.test")]);
    const r = trail(["login", dir, "--code", "TRL-ABCD"], { home, routes: [claimed] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /· this laptop is also signed in to workspace Acme/);
    assert.match(r.stdout, /✓ this laptop is signed in to Trail workspace Acme/);
  });

  test("--code shares the learnings of the repos it knows in the workspace", () => {
    const dir = widgetsRepo("code-share");
    const home = homeWith("code-share-home", []);
    note(dir, home, "Gear turns twice", "Ada");
    commitAll(dir, "Keep the learning");
    const r = trail(["login", dir, "--code", "TRL-ABCD", "--server", SERVER], { home, routes: [claimed, { on: "PUT /api/cli/learnings", status: 200, body: { repo: KEY, learnings: 1, added: 1 } }] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /✓ shared 1 learning from 1 repo/);
  });

  test("--code shares two repos' learnings, counted in the plural", () => {
    const dir = widgetsRepo("code-share-two");
    // Its own first commit: Trail tells repos apart by it, and the same files in the same second would make the same one.
    const gadgets = scratchDir("code-share-gadgets");
    git(gadgets, "init", "--initial-branch=main");
    git(gadgets, "config", "user.name", "Bo Fixture");
    git(gadgets, "config", "user.email", "bo@example.invalid");
    git(gadgets, "remote", "add", "origin", "https://github.com/acme/gadgets.git");
    mkdirSync(join(gadgets, "src"));
    writeFileSync(join(gadgets, "src", "gear.ts"), "export function turn(n: number): number {\n  return n * 3;\n}\n");
    git(gadgets, "add", "-A");
    git(gadgets, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Add gadget gear");
    const home = homeWith("code-share-two-home", []);
    for (const d of [dir, gadgets]) {
      note(d, home, "Gear turns twice", "Ada");
      commitAll(d, "Keep the learning");
    }
    const both: Route = { ...claimed, body: { ...(claimed.body as object), repos: [KEY, "github.com/acme/gadgets"] } };
    const r = trail(["login", dir, "--code", "TRL-ABCD", "--server", SERVER], { home, routes: [both, { on: "PUT /api/cli/learnings", status: 200, body: { learnings: 2, added: 2 } }] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /✓ shared 4 learnings from 2 repos/);
  });

  test("--server with no --workspace: a repo already in that workspace is signed in", () => {
    const dir = widgetsRepo("server-no-slug");
    const home = homeWith("server-no-slug-home", [cloud("acme", "Acme", [KEY])]);
    const r = trail(["login", dir, "--server", SERVER], { home });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /^✓ already signed in to workspace Acme · http:\/\/trail\.test\/w\/acme$/m);
  });

  test("--global with a Codex config that can't be written leaves Codex as it was", () => {
    const dir = widgetsRepo("code-codex");
    const home = homeWith("code-codex-home", []);
    writeFileSync(join(home, ".codex"), "not a folder\n");
    const r = trail(["login", dir, "--code", "TRL-ABCD", "--server", SERVER, "--global"], { home, routes: [claimed] });
    assert.equal(r.status, 0, r.detail);
    assert.equal(readFileSync(join(home, ".codex"), "utf8"), "not a folder\n");
  });

  test("the repo's workspace file picks the workspace; outside git the newest connection answers", () => {
    const dir = widgetsRepo("team-file");
    mkdirSync(join(dir, ".trail"), { recursive: true });
    writeFileSync(join(dir, ".trail", "workspace.json"), JSON.stringify({ trail: "https://team.trailhq.com", workspace: "acme", name: "Acme" }));
    const r = trail(["login", dir], { home: homeWith("team-file-home", []) });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /· sign in to acme: /);

    const plain = trail(["login", scratchDir("login-nogit")], { home: homeWith("login-nogit-home", [cloud("acme", "Acme", [])]) });
    assert.equal(plain.status, 0, plain.detail);
    assert.match(plain.stderr, /✓ already signed in to workspace Acme/);
  });
});

describe("workspace, the rarer paths", () => {
  test("outside git there is no repo line; with several workspaces and none holding this repo, any is named", () => {
    const meRoute: Route = { on: "GET /api/cli/me", status: 200, body: { user: { name: "Ada", email: "ada@example.invalid" }, workspace: workspace("acme", "Acme"), repos: [] } };
    const outside = trail(["workspace", scratchDir("ws-nogit")], { home: homeWith("ws-nogit-home", [cloud("acme", "Acme", [])]), routes: [meRoute] });
    assert.equal(outside.status, 0, outside.detail);
    assert.doesNotMatch(outside.stdout, /not in the workspace/);

    const dir = widgetsRepo("ws-several-none");
    const r = trail(["workspace", dir], { home: homeWith("ws-several-none-home", [cloud("acme", "Acme", []), cloud("globex", "Globex", [])]), routes: [meRoute] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /not in any of your workspaces · trail workspace add --to <slug> shares its learnings/);
  });

  test("a learning that looks like it holds a secret is named as left out", () => {
    const dir = widgetsRepo("ws-secret");
    const home = homeWith("ws-secret-home", [cloud("acme", "Acme", [KEY])]);
    // Built from parts so no scanner reads this file as holding one.
    const secret = ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
    note(dir, home, "Gear credentials", "Ada");
    const file = readdirSync(join(dir, ".trail", "learnings")).find((f) => f.endsWith(".md"))!;
    const p = join(dir, ".trail", "learnings", file);
    writeFileSync(p, readFileSync(p, "utf8") + `\nThe deploy used ${secret} once.\n`);
    commitAll(dir, "Keep the learning");
    const meRoute: Route = { on: "GET /api/cli/me", status: 200, body: { user: { name: "Ada", email: "ada@example.invalid" }, workspace: workspace("acme", "Acme"), repos: [{ key: KEY, name: "widgets", learnings: 0, added_by: "Ada" }] } };
    const r = trail(["workspace", dir], { home, routes: [meRoute] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /· left out: .*looks like it holds a secret/);

    const added: Route = { on: "POST /api/cli/repos", status: 200, body: { repos: [{ key: KEY, name: "widgets", learnings: 0, added_by: "Ada" }] } };
    const add = trail(["workspace", "add", dir], { home: homeWith("ws-secret-add-home", [cloud("acme", "Acme", [])]), routes: [added, { on: "PUT /api/cli/learnings", status: 200, body: { repo: KEY, learnings: 0, added: 0 } }] });
    assert.equal(add.status, 0, add.detail);
    assert.match(add.stderr, /· left out: .*looks like it holds a secret/);
  });
});

describe("counts and names, the other way round", () => {
  test("one person with two learnings, one with no author, and many overlapping branches", () => {
    const dir = widgetsRepo("local-counts");
    const home = homeWith("local-counts-home", []);
    note(dir, home, "Gear turns twice", "Ada");
    note(dir, home, "Gear rounds down", "Ada", ["--always-follow"]);
    const r = trail(["team", dir], { home });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /^1 person · 2 new learnings$/m);
    assert.match(r.stdout, /^ {2}Ada +Gear .+2 learnings$/m);

    // A learning with no author is someone's.
    const file = readdirSync(join(dir, ".trail", "learnings")).find((f) => f.endsWith(".md"))!;
    const p = join(dir, ".trail", "learnings", file);
    writeFileSync(p, readFileSync(p, "utf8").replace(/^author:.*\r?\n/m, ""));
    const authors = ["Bo", "Cy", "Di", "Ed", "Flo", "Gus"];
    branchCache(dir, authors.map((a) => ({ ref: `origin/${a.toLowerCase()}-gear`, author: a, files: ["src/gear.ts"] })));
    const json = trail(["team", dir, "--json"], { home });
    assert.equal(json.status, 0, json.detail);
    const t = JSON.parse(json.stdout);
    assert.ok(t.members.some((m: { name: string }) => m.name === "someone"), json.stdout);
    assert.equal(t.overlaps.length, 5, "at most five overlaps");
  });

  test("a member with several learnings, from the workspace", () => {
    const dir = widgetsRepo("ws-plural");
    const home = homeWith("ws-plural-home", [cloud("acme", "Acme", [KEY])]);
    const view = { workspace: "Acme", repo: "widgets", days: 7, people: 1, sessions: 2, new_learnings: 2, reused: 1, members: [{ name: "Ada", topics: [], learnings: 2, reused: 1 }], overlaps: [] };
    const r = trail(["team", dir], { home, routes: [{ on: "GET /api/cli/team", status: 200, body: view }] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /^ {2}Ada +2 learnings +reused 1×$/m);
  });

  test("check over two changed files and two learnings", () => {
    const dir = widgetsRepo("check-two");
    const home = homeWith("check-two-home", []);
    note(dir, home, "Gear turns twice", "Bo");
    note(dir, home, "Gear rounds down", "Cy", ["--always-follow"]);
    commitAll(dir, "Keep the learnings");
    git(dir, "checkout", "-q", "-b", "change");
    writeFileSync(join(dir, "src", "gear.ts"), "export function turn(n: number): number {\n  return n * 3;\n}\n");
    writeFileSync(join(dir, "src", "cog.ts"), "export const teeth = 12;\n");
    commitAll(dir, "Turn three times");
    const r = trail(["check", dir, "--base", "main"], { home });
    assert.match(r.stdout, /^checking 2 changed files against 2 learnings and 0 skills$/m);
  });

  test("status: three workspaces, a session with nothing saved, and one that can't be read", () => {
    const dir = widgetsRepo("status-more");
    const home = homeWith("status-more-home", [cloud("acme", "Acme", [KEY]), cloud("globex", "Globex", []), cloud("initech", "Initech", [])]);
    note(dir, home, "Gear turns twice", "Ada");
    const d = sessionDir(dir);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "empty.json"), "{}");
    let linked = true;
    try {
      symlinkSync(join(d, "missing-target.json"), join(d, "gone.json"));
    } catch {
      linked = false; // no symlinks for this account (Windows without the privilege)
    }
    const r = trail(["status", dir], { home });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /· 2 more workspaces \(trail workspace\)$/m);
    assert.match(r.stdout, /^this week +nothing saved yet$/m);
    assert.ok(linked || process.platform === "win32", "the unreadable session needs a symlink");
  });

  test("a learning on a teammate's branch that looks like it holds a secret is named with its branch", () => {
    const dir = widgetsRepo("ws-secret-branch");
    const home = homeWith("ws-secret-branch-home", [cloud("acme", "Acme", [KEY])]);
    const secret = ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
    note(dir, home, "Gear deploy", "Bo");
    const file = readdirSync(join(dir, ".trail", "learnings")).find((f) => f.endsWith(".md"))!;
    const text = readFileSync(join(dir, ".trail", "learnings", file), "utf8") + `\nThe deploy used ${secret} once.\n`;
    rmSync(join(dir, ".trail", "learnings", file));
    branchCache(dir, [{ ref: "origin/bo-gear", author: "Bo", files: ["src/gear.ts"], learnings: [{ name: "bo-gear-deploy.md", text }] }]);
    const meRoute: Route = { on: "GET /api/cli/me", status: 200, body: { user: { name: "Ada", email: "ada@example.invalid" }, workspace: workspace("acme", "Acme"), repos: [{ key: KEY, name: "widgets", learnings: 0, added_by: "Ada" }] } };
    const r = trail(["workspace", dir], { home, routes: [meRoute] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /· left out: .* \(on origin\/bo-gear\): looks like it holds a secret/);
  });
});
