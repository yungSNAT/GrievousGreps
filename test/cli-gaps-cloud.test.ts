import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cloud, connectHome, fixtureRepo, fixtureToken as token, runCli, scratchFolders, SERVER, workspace, type CliOptions, type Route } from "./cli-gaps-driver.js";

// `trail login`, `logout`, `workspace`, `team` and `status` against a stand-in
// Trail: the driver answers each request from the routes a test gives it.

const KEY = "github.com/acme/widgets";
const scratchDir = scratchFolders("cli-gaps-cloud");
let repo: string;

function trail(args: string[], o: Partial<CliOptions> & { home: string }) {
  return runCli(args, { trail: true, ...o });
}

function widgetsRepo(tag: string): string {
  const code = "export function turn(n: number): number {\n  return n * 2;\n}\n";
  return fixtureRepo(scratchDir(tag), { author: ["Ada Fixture", "ada@example.invalid"], remote: "https://github.com/acme/widgets.git", file: "gear.ts", code, message: "Add gear" });
}

/** A home connected to these workspaces, newest first. */
const homeWith = (tag: string, clouds: Array<ReturnType<typeof cloud>>) => connectHome(scratchDir(tag), clouds);

function savedClouds(home: string): Array<{ workspace: { slug: string }; repos: string[] }> {
  const p = join(home, ".trail", "cloud.json");
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, "utf8"));
  const { others, ...first } = raw;
  return [first, ...(others ?? [])];
}

function me(slug: string, name: string, repos: Array<{ key: string; name: string; learnings: number; added_by: string }>) {
  return { user: { name: "Ada", email: "ada@example.invalid" }, workspace: workspace(slug, name), repos };
}

const claimed = (slug: string, name: string): Route => ({
  on: "POST /api/cli/login-codes/claim",
  status: 200,
  body: { token: token(slug), user: { name: "Ada", email: "ada@example.invalid" }, workspace: workspace(slug, name), repos: [KEY] },
});

before(() => {
  repo = widgetsRepo("repo");
});

describe("login", () => {
  test("--server must be a URL", () => {
    const r = trail(["login", repo, "--server", "trail.acme"], { home: homeWith("login-bad-server", []) });
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ --server takes a URL, like https:\/\/trail\.acme\.internal/);
  });

  test("--code signs in, keeps the connection and tells the agent how to say so", () => {
    const home = homeWith("login-code", []);
    mkdirSync(join(home, ".claude"));
    const r = trail(["login", repo, "--code", " TRL-ABCD ", "--server", SERVER], { home, routes: [claimed("acme", "Acme")] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /✓ this laptop is signed in to Trail workspace Acme · http:\/\/trail\.test\/w\/acme/);
    assert.match(r.stdout, /\[trail\] Tell the user, in one line, .*run this again with --global\. Don't repeat the code\./);
    assert.deepEqual(savedClouds(home).map((c) => c.workspace.slug), ["acme"]);
  });

  test("--code --global, signed in elsewhere already, says so and wires the agents installed here", () => {
    const home = homeWith("login-code-global", [cloud("old", "Old Co", [])]);
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".cursor"));
    mkdirSync(join(home, ".codex"));
    const r = trail(["login", repo, "--code", "TRL-ABCD", "--server", SERVER, "--global"], { home, routes: [claimed("acme", "Acme")] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /· this laptop is also signed in to workspace Old Co; each repo goes to one of them \(trail workspace\)/);
    assert.match(r.stdout, /Claude Code, Codex and Cursor here have its brand, skills and learnings from their next session\./);
    assert.deepEqual(savedClouds(home).map((c) => c.workspace.slug).sort(), ["acme", "old"]);
    assert.ok(existsSync(join(home, ".codex", "config.toml")), "Codex gets its user-level trail server");
  });

  test("a spent --code is refused and nothing is saved", () => {
    const home = homeWith("login-code-spent", []);
    const r = trail(["login", repo, "--code", "TRL-ABCD", "--server", SERVER], { home, routes: [{ on: "POST /api/cli/login-codes/claim", status: 410 }] });
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ that sign-in code was already used or has expired/);
    assert.deepEqual(savedClouds(home), []);
  });

  test("a repo that goes to one workspace isn't signed in to another", () => {
    const home = homeWith("login-other", [cloud("acme", "Acme", [KEY])]);
    const r = trail(["login", repo, "--workspace", "Globex"], { home });
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ this repo goes to workspace Acme · run trail logout --workspace acme, then trail login --workspace globex/);
  });

  test("signed in already, it says where, and --global wires the agents", () => {
    const home = homeWith("login-already", [cloud("acme", "Acme", [KEY])]);
    mkdirSync(join(home, ".claude"));
    const r = trail(["login", repo, "--global"], { home });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /✓ already signed in to workspace Acme · http:\/\/trail\.test\/w\/acme/);
  });

  test("run by an agent, it prints the link to hand on and doesn't wait", () => {
    const home = homeWith("login-agent", []);
    const r = trail(["login", repo, "--workspace", "Acme"], { home });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /· sign in to acme: https:\/\/team\.trailhq\.com\/\S+/);
    assert.match(r.stdout, /\[trail\] Give the user this link to click/);
  });

  describe("at a terminal it waits for the sign-in", () => {
    const tty: CliOptions["tty"] = ["stdout"];
    const registered: Route = { on: "POST /api/cli/handoffs", status: 200, body: { url: `${SERVER}/connect` } };

    test("and, signed in, wires the agents with --global", () => {
      const home = homeWith("login-wait-ok", []);
      mkdirSync(join(home, ".claude"));
      const ok: Route = { on: "POST /api/cli/handoffs/claim", status: 200, body: { token: token("acme"), user: { name: "Ada", email: "ada@example.invalid" }, workspace: workspace("acme", "Acme"), repos: [KEY] } };
      const r = trail(["login", repo, "--global"], { home, tty, routes: [ok, registered] });
      assert.equal(r.status, 0, r.detail);
      assert.match(r.stderr, /· sign in to Trail in your browser:\n {2}https:\/\/team\.trailhq\.com\/\S+/);
      assert.match(r.stderr, /· waiting for you to sign in · ctrl-c stops/);
      assert.deepEqual(savedClouds(home).map((c) => c.workspace.slug), ["acme"]);
    });

    test("and an expired link is an error", () => {
      const home = homeWith("login-wait-expired", []);
      const r = trail(["login", repo], { home, tty, routes: [{ on: "POST /api/cli/handoffs/claim", status: 410 }, registered] });
      assert.equal(r.status, 1, r.detail);
      assert.match(r.stderr, /✗ that sign-in link was already used or has expired · run trail login again for a new link/);
    });

    test("and, out of time, says the link stays good", () => {
      const home = homeWith("login-wait-late", []);
      const r = trail(["login", repo], { home, tty, routes: [{ on: "POST /api/cli/handoffs/claim", status: 200, body: { pending: true } }, registered], env: { GG_CLOCK_STEP_MS: String(11 * 60 * 1000) } });
      assert.equal(r.status, 0, r.detail);
      assert.match(r.stderr, /· not signed in yet · the link stays good for a day/);
      assert.deepEqual(savedClouds(home), []);
    });
  });
});

describe("logout", () => {
  test("an unknown --workspace is refused", () => {
    const home = homeWith("logout-unknown", [cloud("acme", "Acme", [])]);
    const r = trail(["logout", "--workspace", "globex"], { home });
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ not connected to a workspace "globex" · trail workspace lists them/);
    assert.equal(savedClouds(home).length, 1);
  });

  test("--workspace drops that one and keeps the other", () => {
    const home = homeWith("logout-one-of-two", [cloud("acme", "Acme", []), cloud("globex", "Globex", [])]);
    const r = trail(["logout", "--workspace", "globex"], { home });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /✓ disconnected from workspace Globex · learnings stay in your repos' \.trail\//);
    assert.deepEqual(savedClouds(home).map((c) => c.workspace.slug), ["acme"]);
  });

  test("--workspace for the only one disconnects the machine", () => {
    const home = homeWith("logout-only", [cloud("acme", "Acme", [])]);
    const r = trail(["logout", "--workspace", "acme"], { home });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /✓ disconnected from workspace Acme/);
    assert.deepEqual(savedClouds(home), []);
  });

  test("with no workspace it says so; with several it names them all", () => {
    const none = trail(["logout"], { home: homeWith("logout-none", []) });
    assert.equal(none.status, 0, none.detail);
    assert.match(none.stderr, /· not connected to a workspace/);

    const home = homeWith("logout-all", [cloud("acme", "Acme", []), cloud("globex", "Globex", [])]);
    const all = trail(["logout"], { home });
    assert.equal(all.status, 0, all.detail);
    assert.match(all.stderr, /✓ disconnected from workspaces Acme, Globex · learnings stay/);
    assert.deepEqual(savedClouds(home), []);
  });
});

describe("workspace", () => {
  const meRoute = (slug: string, name: string, repos: Parameters<typeof me>[2]): Route => ({ on: "GET /api/cli/me", status: 200, body: me(slug, name, repos) });

  test("not connected, it says how to connect", () => {
    const r = trail(["workspace", repo], { home: homeWith("ws-none", []) });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /· not connected to a workspace\n· Claude offers a link once this repo has learnings, or run trail login/);
  });

  test("lists the workspace's repos and offers to add this one", () => {
    const home = homeWith("ws-list", [cloud("acme", "Acme", [])]);
    const r = trail(["workspace", repo], { home, routes: [meRoute("acme", "Acme", [{ key: "github.com/acme/api", name: "api", learnings: 1, added_by: "Bo" }, { key: "github.com/acme/web", name: "web", learnings: 3, added_by: "" }])] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /^Acme · http:\/\/trail\.test\/w\/acme$/m);
    assert.match(r.stdout, /^invite {2}http:\/\/trail\.test\/join\/acme$/m);
    assert.match(r.stdout, /✓ api +1 learning · added by Bo/);
    assert.match(r.stdout, /✓ web +3 learnings$/m);
    assert.match(r.stdout, /· acme\/widgets +not in the workspace · trail workspace add shares its learnings/);
    assert.deepEqual(savedClouds(home)[0]!.repos, ["github.com/acme/api", "github.com/acme/web"]);
  });

  test("--json is what Trail answered", () => {
    const home = homeWith("ws-json", [cloud("acme", "Acme", [KEY])]);
    const r = trail(["workspace", repo, "--json"], { home, routes: [meRoute("acme", "Acme", [{ key: KEY, name: "widgets", learnings: 2, added_by: "Ada" }])] });
    assert.equal(r.status, 0, r.detail);
    assert.equal(JSON.parse(r.stdout).workspace.slug, "acme");
  });

  test("with several workspaces, each is named and an unreachable one is an error", () => {
    const home = homeWith("ws-several", [cloud("acme", "Acme", [KEY]), cloud("globex", "Globex", [KEY])]);
    // Both workspaces answer with the same `me`: the second has the repo too, but it goes to the newest.
    const r = trail(["workspace", repo], { home, routes: [meRoute("acme", "Acme", [{ key: KEY, name: "widgets", learnings: 2, added_by: "Ada" }])] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /^Acme \(acme\) · /m);
    assert.match(r.stdout, /· goes to another workspace from here/);

    const json = trail(["workspace", repo, "--json"], { home, routes: [meRoute("acme", "Acme", [])] });
    assert.equal(json.status, 0, json.detail);
    assert.equal(JSON.parse(json.stdout).workspaces.length, 2);

    const down = trail(["workspace", repo], { home });
    assert.equal(down.status, 1, down.detail);
    assert.match(down.stderr, /✗ Acme: couldn't reach Trail/);
    assert.match(down.stderr, /✗ Globex: couldn't reach Trail/);
    assert.equal(down.stdout, "");
  });

  test("a repo in the workspace lists no left-out learnings when it has none", () => {
    const home = homeWith("ws-in", [cloud("acme", "Acme", [KEY])]);
    const r = trail(["workspace", repo], { home, routes: [meRoute("acme", "Acme", [{ key: KEY, name: "widgets", learnings: 0, added_by: "Ada" }])] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /✓ widgets +0 learnings · added by Ada/);
    assert.doesNotMatch(r.stdout, /not in the workspace|left out/);
  });
});

describe("workspace add", () => {
  test("needs a connection, a git repo and one workspace to add to", () => {
    const none = trail(["workspace", "add", repo], { home: homeWith("add-none", []) });
    assert.equal(none.status, 1, none.detail);
    assert.match(none.stderr, /✗ not connected to a workspace · run trail login/);

    const one = homeWith("add-one", [cloud("acme", "Acme", [])]);
    const plain = trail(["workspace", "add", scratchDir("add-not-git")], { home: one });
    assert.equal(plain.status, 1, plain.detail);
    assert.match(plain.stderr, /✗ not a git repository/);

    const unknown = trail(["workspace", "add", repo, "--to", "globex"], { home: one });
    assert.equal(unknown.status, 1, unknown.detail);
    assert.match(unknown.stderr, /✗ not connected to a workspace "globex" · trail workspace lists them/);

    const two = homeWith("add-two", [cloud("acme", "Acme", []), cloud("globex", "Globex", [])]);
    const pick = trail(["workspace", "add", repo], { home: two });
    assert.equal(pick.status, 1, pick.detail);
    assert.match(pick.stderr, /✗ this machine is in 2 workspaces · pick one: trail workspace add --to <acme\|globex>/);
  });

  test("a repo that goes to another workspace isn't moved", () => {
    const home = homeWith("add-moved", [cloud("acme", "Acme", [KEY]), cloud("globex", "Globex", [])]);
    const r = trail(["workspace", "add", repo, "--to", "globex"], { home });
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ acme\/widgets already goes to workspace Acme · trail logout --workspace acme first to send it to Globex/);
  });

  test("Trail refusing the repo is an error", () => {
    const home = homeWith("add-refused", [cloud("acme", "Acme", [])]);
    const r = trail(["workspace", "add", repo], { home, routes: [{ on: "POST /api/cli/repos", status: 403, body: { error: "only admins add repos" } }] });
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ only admins add repos/);
  });

  test("added, its learnings go up now, or in the background when Trail doesn't take them", () => {
    const added: Route = { on: "POST /api/cli/repos", status: 200, body: { repos: [{ key: KEY, name: "widgets", learnings: 0, added_by: "Ada" }] } };
    const home = homeWith("add-ok", [cloud("acme", "Acme", [])]);
    const r = trail(["workspace", "add", repo], { home, routes: [added, { on: "PUT /api/cli/learnings", status: 200, body: { repo: KEY, learnings: 0, added: 0 } }] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /✓ added acme\/widgets to Acme · shared 0 learnings\n· http:\/\/trail\.test\/w\/acme/);
    assert.deepEqual(savedClouds(home)[0]!.repos, [KEY]);

    const later = trail(["workspace", "add", repo], { home: homeWith("add-later", [cloud("acme", "Acme", [])]), routes: [added] });
    assert.equal(later.status, 0, later.detail);
    assert.match(later.stderr, /✓ added acme\/widgets to Acme · its learnings go up in the background \(couldn't reach Trail\)/);
  });
});

describe("team", () => {
  const teamView = {
    workspace: "Acme",
    repo: "widgets",
    days: 7,
    people: 2,
    sessions: 5,
    new_learnings: 1,
    reused: 4,
    members: [
      { name: "Ada", topics: ["gears", "billing"], learnings: 1, reused: 3 },
      { name: "Bo", topics: ["docs"], learnings: 0, reused: 0 },
    ],
    overlaps: [{ kind: "files", text: "Ada and Bo both change src/gear.ts this week, on branches that have not been merged into the main line yet" }],
    url: `${SERVER}/w/acme/team`,
  };

  test("with no workspace, it reads this clone: who wrote learnings lately", () => {
    const home = homeWith("team-local", []);
    const r = trail(["team", repo, "--days", "3"], { home });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /^the last 3 days in acme\/widgets · from this clone$/m);
    assert.match(r.stdout, /^0 people · 0 new learnings$/m);
    assert.match(r.stdout, /reuse and the team page, across your repos, are in a Trail workspace/);
    const json = trail(["team", repo, "--json"], { home });
    assert.equal(json.status, 0, json.detail);
    assert.deepEqual(JSON.parse(json.stdout), { days: 7, learnings: 0, members: [], overlaps: [] });
  });

  test("from the workspace: the week, who did what, and where work overlaps", () => {
    const home = homeWith("team-cloud", [cloud("acme", "Acme", [KEY])]);
    const r = trail(["team", repo], { home, routes: [{ on: "GET /api/cli/team", status: 200, body: teamView }] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /^this week in widgets$/m);
    assert.match(r.stdout, /^2 people · 5 sessions · 1 new learning · reused 4×$/m);
    assert.match(r.stdout, /^ {2}Ada +gears, billing +1 learning +reused 3×$/m);
    assert.match(r.stdout, /^ {2}Bo +docs$/m);
    assert.match(r.stdout, /\noverlap\n {2}● Ada and Bo both change/);
    assert.match(r.stdout, /\n {4}\S/, "a long overlap wraps with an indent");
    assert.match(r.stdout, /team page: http:\/\/trail\.test\/w\/acme\/team/);

    const json = trail(["team", repo, "--json"], { home, routes: [{ on: "GET /api/cli/team", status: 200, body: teamView }] });
    assert.equal(json.status, 0, json.detail);
    assert.equal(JSON.parse(json.stdout).people, 2);
  });

  test("an error from Trail fails the command", () => {
    const home = homeWith("team-down", [cloud("acme", "Acme", [KEY])]);
    const r = trail(["team", repo], { home });
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ couldn't reach Trail/);
  });
});

describe("status", () => {
  test("nothing built, nothing connected, and the workspace side on", () => {
    const r = trail(["status", scratchDir("status-empty")], { home: homeWith("status-empty-home", []), env: { TRAIL_CLOUD: "1" } });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /^code map +✗ not built · run trail build$/m);
    assert.match(r.stdout, /^workspace +not signed in · run trail login to share learnings with your team$/m);
    assert.match(r.stdout, /^this week +nothing saved yet$/m);
  });

  test("a built map that's behind the code, a connect-only workspace, and --json", () => {
    const dir = widgetsRepo("status-built");
    const home = homeWith("status-built-home", [cloud("acme", "Acme", [], { via: "connect" })]);
    const b = trail(["build", dir], { home });
    assert.equal(b.status, 0, b.detail);
    writeFileSync(join(dir, "src", "gear.ts"), "export function turn(n: number): number {\n  return n * 3;\n}\nexport function stop(): void {}\n");
    const r = trail(["status", dir], { home });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /^code map +⚠ \d+ nodes · behind the code, refreshed on the next query$/m);
    assert.match(r.stdout, /^workspace +Acme · gets a summary of the repos you run trail init --connect in · /m);

    const json = trail(["status", dir, "--json"], { home });
    assert.equal(json.status, 0, json.detail);
    const s = JSON.parse(json.stdout);
    assert.equal(s.codeMap.inSync, false);
    assert.equal(s.workspace.name, "Acme");
  });

  test("several workspaces, this repo in one", () => {
    const dir = widgetsRepo("status-several");
    const home = homeWith("status-several-home", [cloud("acme", "Acme", [KEY]), cloud("globex", "Globex", [])]);
    const r = trail(["status", dir], { home });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stdout, /^workspace +Acme · 1 repo, this one included · http:\/\/trail\.test\/w\/acme · 1 more workspace \(trail workspace\)$/m);
  });
});
