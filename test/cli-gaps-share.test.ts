import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cloud, connectHome, fixtureSecret, fixtureToken as token, git, runCli, scratchFolders, SERVER, type CliOptions, type Route } from "./cli-gaps-driver.js";
import { claudeProjectDir } from "../src/notes/session-cost.js";

// `trail share-session` paths the share-session tests leave: the prompts at a
// terminal, signing in on the way, and the replies Trail can give.

const ID = "5a1e0c2d-1111-4222-8333-944455556666";
const BUNDLE = "0b0b0b0b-1111-4222-8333-944455556666";
const scratchDir = scratchFolders("cli-gaps-share");

/** A home with these connections and one Claude Code session in `repo`, a git checkout of acme/widgets. */
function setup(tag: string, clouds: Array<ReturnType<typeof cloud>>): { home: string; repo: string } {
  const home = connectHome(scratchDir(`${tag}-home`), clouds);
  const repo = scratchDir(tag);
  git(repo, "init", "--initial-branch=main");
  git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  const folder = claudeProjectDir(repo, home);
  mkdirSync(folder, { recursive: true });
  const at = new Date().toISOString();
  const lines = [
    { type: "user", timestamp: at, sessionId: ID, cwd: repo, message: { role: "user", content: "why does the gear turn twice?" } },
    { type: "assistant", timestamp: at, message: { id: "msg_01", role: "assistant", content: [{ type: "text", text: "turn() doubles its input." }] } },
    { type: "custom-title", customTitle: "Gear turns twice", sessionId: ID },
  ];
  writeFileSync(join(folder, `${ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { home, repo };
}

function share(args: string[], o: Partial<CliOptions> & { home: string; cwd: string }) {
  return runCli(["share-session", ...args], { trail: true, ...o });
}

const allowed: Route = { on: "GET /api/cli/shared-sessions/allowed", status: 200, body: { ok: true } };
const posted: Route = { on: "POST /api/cli/shared-sessions", status: 200, body: { id: "x", gz_bytes: 100 } };
const refused: Route = { on: "POST /api/cli/shared-sessions", status: 500, body: { error: "Trail is busy" } };
const tty: CliOptions["tty"] = ["stdin", "stderr"];

function copies(home: string): string[] {
  const root = join(home, ".trail", "share");
  return existsSync(root) ? readdirSync(root).filter((n) => n !== "sync" && n !== "sync.json") : [];
}

describe("which connection may share", () => {
  test("this repo's workspace is asked first; an error from one and a no from the other is an error", () => {
    const { home, repo } = setup("two", [cloud("acme", "Acme", [], { url: "http://a.trail.test" }), cloud("globex", "Globex", ["github.com/acme/widgets"], { url: "http://b.trail.test" })]);
    const log = join(scratchDir("two-log"), "fetch.jsonl");
    const r = share(["--list"], {
      home,
      cwd: repo,
      fetchLog: log,
      routes: [
        { on: "GET /api/cli/shared-sessions/allowed", host: "b.trail.test", status: 500, body: { error: "Trail is down" } },
        { on: "GET /api/cli/shared-sessions/allowed", host: "a.trail.test", status: 200, body: { ok: false } },
      ],
    });
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ couldn't check with Trail · Trail is down/);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2);
  });

  describe("not signed in, at a terminal, it signs in on the way", () => {
    const registered: Route = { on: "POST /api/cli/handoffs", status: 200, body: { url: `${SERVER}/connect` } };
    const claimed: Route = {
      on: "POST /api/cli/handoffs/claim",
      status: 200,
      body: { token: token("acme"), user: { name: "Ada", email: "ada@example.invalid" }, workspace: cloud("acme", "Acme", []).workspace, repos: [] },
    };

    test("and goes on once signed in", () => {
      const { home, repo } = setup("signin", []);
      const r = share(["--list"], { home, cwd: repo, tty: ["stdout"], routes: [claimed, registered, allowed] });
      assert.equal(r.status, 0, r.detail);
      assert.match(r.stderr, /· share-session is for the Trail team: sign in to Trail first/);
      assert.match(r.stderr, /✓ signed in to workspace Acme/);
      assert.match(r.stdout, /Gear turns twice/);
      assert.match(r.stdout, /· send one: trail share-session <number>/);
    });

    test("and stops on an expired link, or when it's out of time", () => {
      const { home, repo } = setup("signin-expired", []);
      const expired = share(["--list"], { home, cwd: repo, tty: ["stdout"], routes: [{ on: "POST /api/cli/handoffs/claim", status: 410 }, registered] });
      assert.equal(expired.status, 1, expired.detail);
      assert.match(expired.stderr, /✗ that sign-in link was already used or has expired · run trail share-session again for a new link/);

      const late = setup("signin-late", []);
      const r = share(["--list"], { home: late.home, cwd: late.repo, tty: ["stdout"], routes: [{ on: "POST /api/cli/handoffs/claim", status: 200, body: { pending: true } }, registered], env: { GG_CLOCK_STEP_MS: String(11 * 60 * 1000) } });
      assert.equal(r.status, 1, r.detail);
      assert.match(r.stderr, /· not signed in yet · run trail share-session again once you have/);
    });
  });
});

describe("options", () => {
  test("--days must be 1 to 365, and an unknown session is named", () => {
    const { home, repo } = setup("opts", [cloud("acme", "Acme", [])]);
    const days = share(["--days", "0"], { home, cwd: repo, routes: [allowed] });
    assert.equal(days.status, 1, days.detail);
    assert.match(days.stderr, /✗ --days takes a whole number of days, 1 to 365/);
    const pick = share(["9"], { home, cwd: repo, routes: [allowed] });
    assert.equal(pick.status, 1, pick.detail);
    assert.match(pick.stderr, /✗ no session "9" here · trail share-session --list shows them/);
  });
});

describe("one session, at a terminal", () => {
  test("a no sends nothing, a yes sends it, and Trail's error is said", () => {
    const { home, repo } = setup("one", [cloud("acme", "Acme", [])]);
    const no = share(["1"], { home, cwd: repo, tty, input: "n\n", routes: [allowed, posted] });
    assert.equal(no.status, 0, no.detail);
    assert.match(no.stderr, /· nothing sent/);

    const yes = share(["1"], { home, cwd: repo, tty, input: "y\n", routes: [allowed, posted] });
    assert.equal(yes.status, 0, yes.detail);
    assert.match(yes.stderr, /✓ sent 5a1e0c2d to the Trail team/);

    const err = share(["1"], { home, cwd: repo, tty, input: "yes\n", routes: [allowed, refused] });
    assert.equal(err.status, 1, err.detail);
    assert.match(err.stderr, /✗ couldn't send it · Trail is busy/);
  });
});

describe("the whole Claude, at a terminal", () => {
  test("a no deletes the copy; a bad answer is asked again", () => {
    const { home, repo } = setup("whole-no", [cloud("acme", "Acme", [])]);
    const r = share(["--once"], { home, cwd: repo, tty, input: "maybe\nn\n", routes: [allowed] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /· scrubbing sessions: \d+ of \d+/);
    assert.match(r.stderr, /· answer y, n, or folder numbers from the list/);
    assert.match(r.stderr, /· nothing sent, and the copy is deleted/);
    assert.deepEqual(copies(home), []);
  });

  test("leaving a folder out, then yes, sends the rest and keeps sending with --global's hook", () => {
    const { home, repo } = setup("whole-leave", [cloud("acme", "Acme", [])]);
    const r = share(["--global"], { home, cwd: repo, tty, answers: ["1", "y"], routes: [allowed, posted] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /✓ sent your Claude to the Trail team/);
    assert.match(r.stderr, /· and from now on: each Claude Code session you start, in any folder, sends what changed since/);
    assert.match(r.stderr, /· added one hook to .* so this runs in every folder/);

    // Sending: the next run says how it stands, with the last background run's outcome.
    const syncFile = join(home, ".trail", "share", "sync.json");
    const s = JSON.parse(readFileSync(syncFile, "utf8"));
    writeFileSync(syncFile, JSON.stringify({ ...s, lastRun: { at: Date.now(), error: "Trail is busy" } }));
    const failed = share([], { home, cwd: repo, routes: [allowed] });
    assert.equal(failed.status, 0, failed.detail);
    assert.match(failed.stdout, /✗ the last run, .*, stopped: Trail is busy\. The next session you start tries again/);
    assert.match(failed.stdout, /its hook is in .*, so this runs in every folder/);
    writeFileSync(syncFile, JSON.stringify({ ...s, lastRun: { at: Date.now(), sent: 0 } }));
    const quiet = share([], { home, cwd: repo, routes: [allowed] });
    assert.equal(quiet.status, 0, quiet.detail);
    assert.match(quiet.stdout, /· last run .*: nothing new to send/);
  });

  test("a later yes sends the rest of a copy that stopped part way, or a no keeps it", () => {
    const { home, repo } = setup("whole-resume", [cloud("acme", "Acme", [])]);
    const shown = share(["--once"], { home, cwd: repo, routes: [allowed] });
    assert.equal(shown.status, 0, shown.detail);
    const stopped = share(["--once", "--yes"], { home, cwd: repo, routes: [allowed, refused] });
    assert.equal(stopped.status, 1, stopped.detail);
    assert.match(stopped.stderr, /· 0 of \d+ went; run trail share-session again to send the rest/);

    const no = share(["--once"], { home, cwd: repo, tty, input: "n\n", routes: [allowed] });
    assert.equal(no.status, 0, no.detail);
    assert.match(no.stdout, /An earlier send stopped with \d+ of \d+ items left/);
    assert.match(no.stderr, /· nothing sent/);

    const again = share(["--once"], { home, cwd: repo, tty, input: "y\n", routes: [allowed, refused] });
    assert.equal(again.status, 1, again.detail);
    assert.match(again.stderr, /✗ couldn't send it · Trail is busy/);
  });
});

describe("--yes on a copy just shown", () => {
  test("a --leave-out that isn't folder numbers sends nothing; valid ones leave those out", () => {
    const { home, repo } = setup("leave", [cloud("acme", "Acme", [])]);
    const shown = share(["--once"], { home, cwd: repo, routes: [allowed] });
    assert.equal(shown.status, 0, shown.detail);
    const bad = share(["--once", "--yes", "--leave-out", "x"], { home, cwd: repo, routes: [allowed, posted] });
    assert.equal(bad.status, 1, bad.detail);
    assert.match(bad.stderr, /✗ --leave-out takes folder numbers from the summary, like "3 7"; nothing sent/);
    const ok = share(["--once", "--yes", "--leave-out", "1"], { home, cwd: repo, routes: [allowed, posted] });
    assert.equal(ok.status, 0, ok.detail);
    assert.match(ok.stderr, /✓ sent your Claude to the Trail team/);
  });
});

describe("--delete", () => {
  test("Trail's error is said; a deletion with no copies here, or while sending, stops the sending", () => {
    const { home, repo } = setup("delete", [cloud("acme", "Acme", [])]);
    const code = `${BUNDLE}.${fixtureSecret}`;
    const err = share(["--delete", code], { home, cwd: repo, routes: [allowed, { on: "DELETE /api/cli/shared-sessions/bundles/", status: 500, body: { error: "Trail is busy" } }] });
    assert.equal(err.status, 1, err.detail);
    assert.match(err.stderr, /✗ couldn't delete it · Trail is busy/);

    const deleted: Route = { on: "DELETE /api/cli/shared-sessions/bundles/", status: 200, body: { deleted: 1 } };
    const none = share(["--delete", code], { home, cwd: repo, routes: [allowed, deleted] });
    assert.equal(none.status, 0, none.detail);
    assert.match(none.stderr, /✓ deleted 1 item from the Trail team/);

    mkdirSync(join(home, ".trail", "share"), { recursive: true });
    const syncFile = join(home, ".trail", "share", "sync.json");
    writeFileSync(syncFile, JSON.stringify({ bundleId: BUNDLE, secret: fixtureSecret, since: Date.now(), days: 30, url: SERVER, excluded: [], dirs: [], sessions: {}, sizes: {}, setupHash: "", lastRunAt: 0 }));
    const syncing = share(["--delete", code], { home, cwd: repo, routes: [allowed, deleted] });
    assert.equal(syncing.status, 0, syncing.detail);
    assert.ok(JSON.parse(readFileSync(syncFile, "utf8")).stoppedAt, "the sending stops");
  });

  test("the background send names each session's repo", () => {
    const { home, repo } = setup("sync-repo", [cloud("acme", "Acme", [])]);
    // A session that has gone quiet: an hour since it was written.
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(join(claudeProjectDir(repo, home), `${ID}.jsonl`), hourAgo, hourAgo);
    mkdirSync(join(home, ".trail", "share"), { recursive: true });
    writeFileSync(join(home, ".trail", "share", "sync.json"), JSON.stringify({ bundleId: BUNDLE, secret: fixtureSecret, since: Date.now() - 86_400_000, days: 30, url: SERVER, excluded: [], dirs: [], sessions: {}, sizes: {}, setupHash: "", lastRunAt: 0 }));
    const log = join(home, "fetch.jsonl");
    const r = runCli(["_share-sync"], { home, cwd: repo, trail: true, routes: [posted], fetchLog: log });
    assert.equal(r.status, 0, r.detail);
    const sent = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { path: string; body: { repo?: string } });
    assert.ok(sent.some((s) => s.path === "/api/cli/shared-sessions" && s.body.repo === "github.com/acme/widgets"), JSON.stringify(sent.map((s) => [s.path, s.body?.repo, (s.body as { kind?: string })?.kind, (s.body as { session_id?: string })?.session_id])));
  });

  test("--stop with no hook to take out says only that it stopped", () => {
    const { home, repo } = setup("stop-no-hook", [cloud("acme", "Acme", [])]);
    mkdirSync(join(home, ".trail", "share"), { recursive: true });
    const syncFile = join(home, ".trail", "share", "sync.json");
    writeFileSync(syncFile, JSON.stringify({ bundleId: BUNDLE, secret: fixtureSecret, since: Date.now(), days: 30, url: SERVER, excluded: [], dirs: [], sessions: {}, sizes: {}, setupHash: "", lastRunAt: 0 }));
    const r = share(["--stop"], { home, cwd: repo });
    assert.equal(r.status, 0, r.detail);
    assert.equal(r.stderr, `✓ stopped: nothing more is sent\n· what already went stays with the Trail team until you take it back: trail share-session --delete ${BUNDLE}.${fixtureSecret}\n`);
    assert.ok(JSON.parse(readFileSync(syncFile, "utf8")).stoppedAt);
  });
});

test("a Trail home outside the home folder is shown by its full path", () => {
  const { home, repo } = setup("outside", [cloud("acme", "Acme", [])]);
  const elsewhere = scratchDir("outside-trail");
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, "cloud.json"), readFileSync(join(home, ".trail", "cloud.json")));
  const r = share(["--once"], { home, cwd: repo, routes: [allowed], env: { TRAIL_HOME: elsewhere } });
  assert.equal(r.status, 0, r.detail);
  assert.ok(r.stdout.includes(elsewhere), r.detail);
});

describe("more answers at a terminal", () => {
  test("a folder with no sessions says so when one is picked", () => {
    const { home } = setup("pick-none", [cloud("acme", "Acme", [])]);
    const r = share(["1"], { home, cwd: scratchDir("pick-none-cwd"), routes: [allowed] });
    assert.equal(r.status, 1, r.detail);
    assert.match(r.stderr, /✗ no Claude Code sessions for this folder yet/);
  });

  test("yes sends it all at once", () => {
    const { home, repo } = setup("whole-yes", [cloud("acme", "Acme", [])]);
    const r = share(["--once"], { home, cwd: repo, tty, answers: ["y"], routes: [allowed, posted] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /✓ sent your Claude to the Trail team/);
    assert.doesNotMatch(r.stderr, /from now on/);
  });

  test("leaving a folder out, then no, deletes the copy", () => {
    const { home, repo } = setup("whole-leave-no", [cloud("acme", "Acme", [])]);
    const r = share(["--once"], { home, cwd: repo, tty, answers: ["1", "n"], routes: [allowed] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /Send the rest\? \[y\/N\]/);
    assert.match(r.stderr, /· nothing sent, and the copy is deleted/);
  });

  test("--global with a Claude settings file that isn't JSON says the hook couldn't go in", () => {
    const { home, repo } = setup("whole-bad-settings", [cloud("acme", "Acme", [])]);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{ not json");
    const r = share(["--global"], { home, cwd: repo, tty, answers: ["y"], routes: [allowed, posted] });
    assert.equal(r.status, 0, r.detail);
    assert.match(r.stderr, /✗ couldn't add its hook to .* \(the file isn't valid JSON\), so this runs only in repos where trail is set up/);
  });
});
