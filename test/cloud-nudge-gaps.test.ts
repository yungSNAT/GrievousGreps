/**
 * Gaps in src/cloud/nudge.ts: the background wait's outcomes, the link worded
 * for a signed-in person, the hook's notice, the connected news, a paired
 * setup settled, and the small wording helpers.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_ENV, brand } from "../src/brand.js";
import { writeNote } from "../src/notes/notes.js";
import {
  clearPending,
  cloudLines,
  connectUrl,
  hookNotice,
  linkedNews,
  linkLines,
  LINK_WORDS,
  loginLines,
  loginLink,
  nudgeLines,
  NUDGE_WORDS,
  pairSettled,
  pendingPair,
  pickerRepos,
  rememberPair,
  sessionKey,
  waitForConnect,
} from "../src/cloud/nudge.js";
import { tmpRepo } from "./helpers.js";

const KEYS = ["DO_NOT_TRACK", BRAND_ENV, "TRAIL_TEST_SERVER", "TRAIL_NO_FETCH", "TRAIL_HOME", "CLAUDE_CODE_SESSION_ID"];
const saved: Record<string, string | undefined> = {};
const cleanup: string[] = [];
const SERVER = "http://trail.test";

before(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.DO_NOT_TRACK = "1";
  process.env[BRAND_ENV] = "trail";
  process.env.TRAIL_TEST_SERVER = SERVER;
  process.env.TRAIL_NO_FETCH = "1";
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

after(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

function freshHome(): void {
  const home = mkdtempSync(join(tmpdir(), "nudge-gaps-home-"));
  cleanup.push(home);
  process.env.TRAIL_HOME = home;
}

function repo(remote: string | null): string {
  const dir = tmpRepo("nudge-gaps");
  cleanup.push(dir);
  const git = (args: string[]) => spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Priya Raman"]);
  git(["config", "user.email", "priya@acme.test"]);
  if (remote) git(["remote", "add", "origin", remote]);
  writeNote(dir, { title: "Keep payment retries at 4", body: "## Decided\nFour retries.", author: "Sam", date: "2026-10-07", touches: [] });
  git(["add", "-A", "-f"]);
  git(["commit", "-q", "-m", "learning"]);
  return dir;
}

const ws = { slug: "acme", name: "Acme", url: "http://trail.test/w/acme" };

/** A Trail where the person has signed in and the billing repo is in the workspace. */
const connected = (paths: string[] = []) =>
  (async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === "/api/cli/handoffs") return new Response(JSON.stringify({ url: `${SERVER}/connect` }), { status: 200 });
    if (path === "/api/cli/handoffs/claim") return new Response(JSON.stringify({ token: "trl_test", user: { name: "Priya", email: "p@acme.test" }, workspace: ws, repos: [] }), { status: 200 });
    if (path === "/api/cli/me") return new Response(JSON.stringify({ user: { name: "Priya", email: "p@acme.test" }, workspace: ws, repos: [{ key: "github.com/acme/billing", name: "acme/billing", learnings: 1, added_by: "Priya" }] }), { status: 200 });
    if (path === "/api/cli/learnings") return new Response(JSON.stringify({ learnings: 1, added: 0 }), { status: 200 });
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof fetch;

/** A Trail answering every claim with `status` and `body`. */
const claimAnswers = (status: number, body: unknown) =>
  (async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/cli/handoffs") return new Response(JSON.stringify({ url: `${SERVER}/connect` }), { status: 200 });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;

async function connect(dir: string) {
  loginLink(dir, process.env, Date.now(), SERVER);
  return waitForConnect({ fetchImpl: connected(), sleep: async () => {} });
}

describe("waitForConnect", () => {
  test("with no link out there is nothing to wait for", async () => {
    freshHome();
    assert.equal(await waitForConnect({ fetchImpl: claimAnswers(202, { pending: true }), sleep: async () => {} }), null);
  });

  test("a sign-in saves the workspace and leaves the news for the next command, once", async () => {
    freshHome();
    const dir = repo("https://github.com/acme/billing.git");
    const paths: string[] = [];
    loginLink(dir, process.env, Date.now(), SERVER);
    const got = await waitForConnect({ fetchImpl: connected(paths), sleep: async () => {} });
    assert.ok(got && "cloud" in got, "connected");
    assert.ok(paths.includes("/api/cli/handoffs/claim"));
    const news = linkedNews();
    assert.ok(news, "news left");
    assert.match(news!, /✓ connected to workspace Acme/);
    assert.match(news!, /http:\/\/trail\.test\/w\/acme/);
    assert.doesNotMatch(news!, /End your reply|Tell the user/, "worded for the person");
    assert.equal(linkedNews(), null, "told once");
  });

  test("a link Trail no longer takes is dropped, so the next login makes a new one", async () => {
    freshHome();
    const dir = repo("https://github.com/acme/billing.git");
    const first = loginLink(dir, process.env, Date.now(), SERVER);
    const got = await waitForConnect({ fetchImpl: claimAnswers(410, { error: "gone" }), sleep: async () => {} });
    assert.ok(got && "error" in got);
    assert.notEqual(loginLink(dir, process.env, Date.now(), SERVER), first);
  });

  test("a wait that runs out keeps the link for the next one", async () => {
    freshHome();
    const dir = repo("https://github.com/acme/billing.git");
    const first = loginLink(dir, process.env, Date.now(), SERVER);
    const got = await waitForConnect({ fetchImpl: claimAnswers(202, { pending: true }), sleep: async () => {}, waitMs: 0 });
    assert.ok(got && !("cloud" in got) && !("error" in got));
    assert.equal(loginLink(dir, process.env, Date.now(), SERVER), first, "same link still out");
  });

  test("a link forgotten while waiting (trail logout) ends the wait", async () => {
    freshHome();
    const dir = repo("https://github.com/acme/billing.git");
    const first = loginLink(dir, process.env, Date.now(), SERVER);
    const got = await waitForConnect({ fetchImpl: claimAnswers(202, { pending: true }), sleep: async () => clearPending(), waitMs: 60 * 60_000 });
    assert.equal(got, null);
    assert.notEqual(loginLink(dir, process.env, Date.now(), SERVER), first);
  });
});

describe("cloudLines and hookNotice", () => {
  test("the connected news comes first, with a line for the agent", async () => {
    freshHome();
    const dir = repo("https://github.com/acme/billing.git");
    await connect(dir);
    const lines = cloudLines(dir, { command: "note", agent: true, startWait: () => {} });
    assert.match(lines[0]!, /^✓ connected to workspace Acme/);
    assert.match(lines.join("\n"), /\[trail\] Tell the user once/);
    assert.doesNotMatch(cloudLines(dir, { command: "note", agent: true, startWait: () => {} }).join("\n"), /connected to workspace/, "told once");
  });

  test("signed in, a repo no workspace has gets a link to add it, once a session", async () => {
    freshHome();
    const billing = repo("https://github.com/acme/billing.git");
    await connect(billing);
    assert.ok(linkedNews(), "consume the news");
    const dir = repo("https://github.com/acme/payments.git");
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: "sess-1" };
    let waits = 0;
    const startWait = () => void waits++;
    const lines = cloudLines(dir, { command: "ask", agent: false, env, startWait });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /isn't on Trail yet · add it: http:\/\/trail\.test\/connect\?state=/);
    assert.equal(waits, 1);
    assert.deepEqual(cloudLines(dir, { command: "ask", agent: false, env, startWait }), [], "same session");
    assert.equal(waits, 2, "the link out keeps being waited on");

    const agent = cloudLines(dir, { command: "check", agent: true, env: { ...env, CLAUDE_CODE_SESSION_ID: "sess-2" }, startWait });
    assert.match(agent[0]!, /End your reply with this line, word for word: \[Add .* to Trail\]/);
    const url = (s: string) => s.match(/http:\/\/trail\.test\/connect\?state=[^\s)]+/)![0];
    assert.equal(url(agent[0]!), url(lines[0]!), "the same link, for the same repo");

    const notice = hookNotice(dir, "a teammate's learning", { session: "sess-3", startWait });
    assert.ok(notice);
    assert.ok(notice!.startsWith(`${brand()} · a teammate's learning · `));
    assert.match(notice!, /isn't on Trail yet/);
    assert.equal(hookNotice(dir, "again", { session: "sess-3", startWait }), null, "once a session");
  });

  test("the hook passes the connected news on as it is", async () => {
    freshHome();
    const dir = repo("https://github.com/acme/billing.git");
    await connect(dir);
    const notice = hookNotice(dir, "why", { startWait: () => {} });
    assert.ok(notice);
    assert.match(notice!, /^✓ connected to workspace Acme/);
    assert.doesNotMatch(notice!, /why/);
  });

  test("a repo with no remote gets nothing", async () => {
    freshHome();
    const billing = repo("https://github.com/acme/billing.git");
    await connect(billing);
    linkedNews();
    const local = repo(null);
    assert.deepEqual(cloudLines(local, { command: "note", agent: true, startWait: () => {} }), []);
    assert.equal(hookNotice(local, "why", { session: "s", startWait: () => {} }), null);
  });

  test("under another brand nothing is said", (t) => {
    process.env[BRAND_ENV] = "graft";
    try {
      if (brand() === "trail") return t.skip("no other brand");
      freshHome();
      const dir = repo("https://github.com/acme/billing.git");
      assert.deepEqual(cloudLines(dir, { command: "note", agent: true }), []);
      assert.equal(linkedNews(), null);
    } finally {
      process.env[BRAND_ENV] = "trail";
    }
  });
});

describe("a paired setup", () => {
  test("settles only for its own state", () => {
    freshHome();
    const t0 = Date.UTC(2026, 9, 26, 9);
    rememberPair("a".repeat(32), "/r", SERVER, undefined, t0);
    pairSettled("b".repeat(32), "over");
    assert.equal(pendingPair()?.state, "a".repeat(32), "another state changes nothing");
    pairSettled("a".repeat(32), "timed_out", undefined, undefined, t0 + 1000);
    assert.equal(pendingPair()?.waitUntil, t0 + 1000);
    pairSettled("a".repeat(32), "over");
    assert.equal(pendingPair(), null);
    assert.equal(linkedNews(), null, "over leaves no news");
  });

  test("connected leaves the news for the next prompt", () => {
    freshHome();
    rememberPair("a".repeat(32), "/r", SERVER);
    pairSettled("a".repeat(32), "linked", { workspace: "Acme", url: ws.url, repos: 1, learnings: 3 });
    assert.equal(pendingPair(), null);
    const news = linkedNews()!;
    assert.match(news, /✓ connected to workspace Acme/);
    assert.match(news, /shared 3 learnings from 1 repo ·/);
  });
});

describe("wording helpers", () => {
  test("sessionKey takes Claude Code's id, trimmed, and is null without one", () => {
    freshHome();
    const dir = repo(null);
    assert.equal(sessionKey(dir, { ...process.env, CLAUDE_CODE_SESSION_ID: "  abc  " }), "abc");
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SESSION_ID;
    assert.equal(sessionKey(dir, env), null);
  });

  test("connectUrl names the workspace when given one", () => {
    assert.equal(connectUrl("s t", SERVER), `${SERVER}/connect?state=s%20t`);
    assert.equal(connectUrl("st", SERVER, "a b"), `${SERVER}/connect?state=st&ws=a%20b`);
  });

  test("nudgeLines and linkLines word for a person or an agent", () => {
    assert.deepEqual(nudgeLines(NUDGE_WORDS[0], "U", false), [`· ${NUDGE_WORDS[0]}: ${LINK_WORDS} at U`]);
    const a = nudgeLines(NUDGE_WORDS[1], "U", true);
    assert.equal(a.length, 2);
    assert.match(a[0]!, /\[sign in to Trail\]\(U\)/);
    assert.deepEqual(linkLines("acme/x", "U", false), ["· acme/x isn't on Trail yet · add it: U"]);
    assert.match(linkLines("acme/x", "U", true)[0]!, /\[Add acme\/x to Trail\]\(U\)/);
  });

  test("loginLines says where it signs in to", () => {
    assert.equal(loginLines("U")[0], "· sign in: U");
    const l = loginLines("U", "Acme");
    assert.equal(l[0], "· sign in to Acme: U");
    assert.match(l[1]!, /signs this laptop in to Trail to Acme/);
  });

  test("loginLink keeps a link for the same Trail and makes a new one for another", () => {
    freshHome();
    const dir = repo("https://github.com/acme/billing.git");
    const a = loginLink(dir, process.env, Date.now(), SERVER);
    assert.equal(loginLink(dir, process.env, Date.now(), SERVER), a);
    const b = loginLink(dir, process.env, Date.now(), "http://other.test", "acme");
    assert.ok(b.startsWith("http://other.test/connect?state="));
    assert.ok(b.endsWith("&ws=acme"));
    assert.notEqual(new URL(b).searchParams.get("state"), new URL(a).searchParams.get("state"));
  });

  test("pickerRepos lists nothing without a known repo", () => {
    freshHome();
    assert.deepEqual(pickerRepos(undefined), []);
    assert.deepEqual(pickerRepos("github.com/nobody/nothing"), []);
  });
});
