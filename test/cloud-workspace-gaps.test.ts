/** Gaps in the workspace module: stored connections, clearing them, and how calls to Trail answer on failure. */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { trailHome } from "../src/notes/home.js";
import { ensurePrivateDir } from "../src/util/private-file.js";
import {
  readClouds,
  readCloud,
  writeCloud,
  clearCloud,
  cloudForRepo,
  cloudEnabled,
  trailUrl,
  useServer,
  DEFAULT_TRAIL_URL,
  TEST_SERVER_ENV,
  fetchMe,
  fetchTeam,
  shareAllowed,
  claimHandoff,
  claimLoginCode,
  postHandoffProgress,
  registerHandoff,
  isError,
  type Cloud,
} from "../src/cloud/workspace.js";

process.env.DO_NOT_TRACK = "1";

const mk = (slug: string, id: string, linkedAt: number, repos: string[]): Cloud => ({
  url: "http://trail.test",
  token: `trl_${slug}`,
  user: { name: "A", email: "a@x.test" },
  workspace: { id, name: slug, slug, url: `http://trail.test/${slug}`, invite_url: "" },
  repos,
  linkedAt,
});

type Call = { url: string; init?: RequestInit };
function fakeFetch(status: number, body: string, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status });
  }) as typeof fetch;
}
function throwingFetch(err: Error): typeof fetch {
  return (async () => {
    throw err;
  }) as typeof fetch;
}

describe("stored connections", () => {
  let dir: string;
  let n = 0;
  const envFor = (): NodeJS.ProcessEnv => {
    const home = join(dir, `h${n++}`);
    return { ...process.env, TRAIL_HOME: home, HOME: home, USERPROFILE: home, TRAIL_CLOUD: "" };
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cloud-ws-gaps-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("two workspaces are both kept, newest first, and each repo finds its own", () => {
    const env = envFor();
    assert.equal(cloudEnabled(env), false);
    writeCloud(mk("old", "w1", 100, ["github.com/a/one"]), env);
    writeCloud(mk("new", "w2", 200, ["github.com/a/two", "github.com/a/one"]), env);
    const all = readClouds(env);
    assert.deepEqual(all.map((c) => c.workspace.slug), ["new", "old"]);
    assert.equal(readCloud(env)?.workspace.slug, "new");
    assert.equal(cloudEnabled(env), true);
    assert.equal(cloudForRepo("github.com/a/one", env)?.workspace.slug, "new");
    assert.equal(cloudForRepo("github.com/a/two", env)?.token, "trl_new");
    assert.equal(cloudForRepo("github.com/a/none", env), null);
    const raw = JSON.parse(readFileSync(join(trailHome(env), "cloud.json"), "utf8")) as { workspace: { slug: string }; others: unknown[] };
    assert.equal(raw.workspace.slug, "new");
    assert.equal(raw.others.length, 1);
  });

  test("re-linking the same workspace replaces it instead of adding one", () => {
    const env = envFor();
    writeCloud(mk("ws", "w1", 100, ["r1"]), env);
    writeCloud({ ...mk("ws", "w1", 300, ["r2"]), url: "http://other.test" }, env);
    const all = readClouds(env);
    assert.equal(all.length, 1);
    assert.deepEqual(all[0].repos, ["r2"]);
  });

  test("an `others` that isn't a list, and broken entries, are ignored", () => {
    const env = envFor();
    const home = trailHome(env);
    ensurePrivateDir(home);
    writeFileSync(join(home, "cloud.json"), JSON.stringify({ ...mk("solo", "w1", 5, ["r"]), others: "nope" }));
    assert.deepEqual(readClouds(env).map((c) => c.workspace.slug), ["solo"]);

    writeFileSync(
      join(home, "cloud.json"),
      JSON.stringify({ ...mk("top", "w1", 5, ["r"]), others: [mk("two", "w2", 9, []), { token: "", url: "x" }, { ...mk("bad", "w3", 1, []), url: "ftp://x" }] }),
    );
    assert.deepEqual(readClouds(env).map((c) => c.workspace.slug), ["two", "top"]);

    writeFileSync(join(home, "cloud.json"), "42");
    assert.deepEqual(readClouds(env), []);
    assert.equal(readCloud(env), null);
  });

  test("clearing one workspace keeps the rest; clearing all removes the file", () => {
    const env = envFor();
    assert.equal(clearCloud(env), false);
    writeCloud(mk("a", "w1", 100, []), env);
    writeCloud(mk("b", "w2", 200, []), env);
    const p = join(trailHome(env), "cloud.json");
    assert.equal(clearCloud(env, "missing"), false);
    assert.equal(readClouds(env).length, 2);
    assert.equal(clearCloud(env, "b"), true);
    assert.deepEqual(readClouds(env).map((c) => c.workspace.slug), ["a"]);
    assert.equal(clearCloud(env, "a"), true);
    assert.equal(existsSync(p), false);

    writeCloud(mk("c", "w3", 1, []), env);
    writeCloud(mk("d", "w4", 2, []), env);
    assert.equal(clearCloud(env), true);
    assert.equal(existsSync(p), false);
    assert.deepEqual(readClouds(env), []);
  });
});

describe("where sign-in goes", () => {
  test("a local test server is taken, a remote one isn't, and --server wins", () => {
    assert.equal(trailUrl({ [TEST_SERVER_ENV]: "http://stand-in.test///" }), "http://stand-in.test");
    assert.equal(trailUrl({ [TEST_SERVER_ENV]: "https://evil.example.com" }), DEFAULT_TRAIL_URL);
    assert.equal(trailUrl({}), DEFAULT_TRAIL_URL);
    useServer("https://self.example.com");
    try {
      assert.equal(trailUrl({ [TEST_SERVER_ENV]: "http://localhost:3000" }), "https://self.example.com");
    } finally {
      useServer(null);
    }
    assert.equal(trailUrl({ [TEST_SERVER_ENV]: "http://localhost:3000" }), "http://localhost:3000");
  });
});

describe("calls", () => {
  const c = mk("ws", "w1", 1, []);

  test("a successful call sends the token and gives back the body", async () => {
    const calls: Call[] = [];
    const me = await fetchMe(c, fakeFetch(200, JSON.stringify({ user: { name: "A", email: "" }, workspace: c.workspace, repos: [] }), calls));
    assert.ok(!isError(me));
    assert.equal(me.workspace.slug, "ws");
    assert.equal(calls[0].url, "http://trail.test/api/cli/me");
    const headers = calls[0].init!.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer trl_ws");
    assert.equal(calls[0].init!.method, "GET");
    assert.equal(calls[0].init!.body, undefined);
  });

  test("an empty answer is a null body", async () => {
    const r = await fetchMe(c, fakeFetch(200, ""));
    assert.equal(r, null);
  });

  test("an error answer carries Trail's message, or the status when it isn't JSON", async () => {
    const withMsg = await fetchMe(c, fakeFetch(400, JSON.stringify({ error: "bad repo" })));
    assert.deepEqual(withMsg, { error: "bad repo", status: 400 });
    const html = await fetchMe(c, fakeFetch(502, "<html>gateway</html>"));
    assert.deepEqual(html, { error: "Trail answered 502", status: 502 });
    const nonString = await fetchMe(c, fakeFetch(500, JSON.stringify({ error: { code: 1 } })));
    assert.deepEqual(nonString, { error: "Trail answered 500", status: 500 });
  });

  test("an unreachable Trail and a timeout are told apart", async () => {
    const off = await fetchMe(c, throwingFetch(new TypeError("fetch failed")));
    assert.deepEqual(off, { error: "couldn't reach Trail" });
    const t = new Error("timed out");
    t.name = "TimeoutError";
    assert.deepEqual(await fetchMe(c, throwingFetch(t)), { error: "Trail didn't answer in time" });
    const a = new Error("aborted");
    a.name = "AbortError";
    assert.deepEqual(await fetchMe(c, throwingFetch(a)), { error: "Trail didn't answer in time" });
  });

  test("fetchTeam puts days and repo in the query", async () => {
    const calls: Call[] = [];
    await fetchTeam(c, { repo: "github.com/a/b", days: 30 }, fakeFetch(200, "{}", calls));
    await fetchTeam(c, {}, fakeFetch(200, "{}", calls));
    const q1 = new URL(calls[0].url).searchParams;
    assert.equal(q1.get("days"), "30");
    assert.equal(q1.get("repo"), "github.com/a/b");
    const q2 = new URL(calls[1].url).searchParams;
    assert.equal(q2.get("days"), "7");
    assert.equal(q2.has("repo"), false);
  });

  test("shareAllowed reads each answer", async () => {
    assert.equal(await shareAllowed(c, fakeFetch(200, JSON.stringify({ ok: true }))), true);
    assert.equal(await shareAllowed(c, fakeFetch(200, JSON.stringify({}))), false);
    assert.equal(await shareAllowed(c, fakeFetch(403, "")), false);
    const ended = await shareAllowed(c, fakeFetch(401, ""));
    assert.ok(isError(ended));
    assert.equal(ended.status, 401);
    assert.match(ended.error, /sign-in to ws has ended/);
    for (const s of [404, 405, 503]) {
      const r = await shareAllowed(c, fakeFetch(s, ""));
      assert.deepEqual(r, { error: "this Trail doesn't take shared sessions yet", status: s });
    }
    assert.deepEqual(await shareAllowed(c, fakeFetch(500, JSON.stringify({ error: "boom" }))), { error: "boom", status: 500 });
  });

  test("claimHandoff: a token, still pending, expired or unsupported", async () => {
    const ok = await claimHandoff("http://t.test", "s", fakeFetch(200, JSON.stringify({ token: "trl_x", workspace: c.workspace })));
    assert.ok("cloud" in ok);
    assert.deepEqual(ok.cloud.user, { name: "", email: "" });
    assert.deepEqual(ok.cloud.repos, []);
    assert.deepEqual(await claimHandoff("http://t.test", "s", fakeFetch(202, JSON.stringify({ pending: true }))), { pending: true });
    assert.equal((await claimHandoff("http://t.test", "s", fakeFetch(410, ""))) .hasOwnProperty("reason"), true);
    assert.deepEqual(await claimHandoff("http://t.test", "s", fakeFetch(410, "")), { error: "that sign-in link was already used or has expired", reason: "expired" });
    assert.equal(((await claimHandoff("http://t.test", "s", fakeFetch(405, ""))) as { reason: string }).reason, "unsupported");
    assert.deepEqual(await claimHandoff("http://t.test", "s", fakeFetch(500, "")), { pending: true });
  });

  test("claimLoginCode: each refusal says why", async () => {
    const ok = await claimLoginCode("http://t.test", "TRL-A", fakeFetch(200, JSON.stringify({ token: "trl_y", workspace: c.workspace, repos: ["r"], user: { name: "B", email: "b" } })));
    assert.ok("cloud" in ok);
    assert.deepEqual(ok.cloud.repos, ["r"]);
    assert.equal(ok.cloud.user.name, "B");
    const reason = async (status: number, body = "") => ((await claimLoginCode("http://t.test", "x", fakeFetch(status, body))) as { reason: string }).reason;
    assert.equal(await reason(410), "expired");
    assert.equal(await reason(400), "invalid");
    assert.equal(await reason(404), "unsupported");
    assert.equal(await reason(500), "offline");
    assert.equal(await reason(200, JSON.stringify({ token: "t" })), "offline");
    const off = await claimLoginCode("http://t.test", "x", throwingFetch(new TypeError("no")));
    assert.deepEqual(off, { error: "couldn't reach Trail (couldn't reach Trail)", reason: "offline" });
  });

  test("postHandoffProgress and registerHandoff", async () => {
    assert.equal(await postHandoffProgress("http://t.test", { state: "s" }, fakeFetch(200, "{}")), "ok");
    assert.equal(await postHandoffProgress("http://t.test", { state: "s" }, fakeFetch(409, "")), "reviewed");
    assert.equal(await postHandoffProgress("http://t.test", { state: "s" }, fakeFetch(410, "")), "gone");
    assert.equal(await postHandoffProgress("http://t.test", { state: "s" }, fakeFetch(500, "")), "error");
    const calls: Call[] = [];
    const r = await registerHandoff("http://t.test", { state: "s", repo: null, repos: [], author: "" }, fakeFetch(200, JSON.stringify({ url: "http://t.test/go" }), calls));
    assert.deepEqual(r, { url: "http://t.test/go" });
    assert.equal(JSON.parse(String(calls[0].init!.body)).state, "s");
    const bad = await registerHandoff("http://t.test", { state: "s", repo: null, repos: [], author: "" }, fakeFetch(503, ""));
    assert.deepEqual(bad, { error: "Trail answered 503", status: 503 });
  });
});
