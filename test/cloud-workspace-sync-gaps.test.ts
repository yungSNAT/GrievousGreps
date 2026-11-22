/**
 * Gaps in workspace-sync: skills and their folder files, secrets left out,
 * working-tree review, removals between syncs, retries, the outbox trim and
 * the background entry points with nothing or everything to do.
 */
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { writeCloud, type Cloud } from "../src/cloud/workspace.js";
import { repoPlace } from "../src/notes/home.js";
import { secretReason } from "../src/notes/secrets.js";
import {
  activityEvent,
  flushActivity,
  inWorkspace,
  learningName,
  learningsPayload,
  maybeSyncInBackground,
  recordActivity,
  records,
  repoSkillName,
  reviewPayload,
  runSyncChild,
  syncIsDue,
  syncRepo,
  workspaceLearnings,
} from "../src/cloud/workspace-sync.js";

const saved = { TRAIL_HOME: process.env.TRAIL_HOME, DO_NOT_TRACK: process.env.DO_NOT_TRACK };
const made: string[] = [];
const TOKEN = "ghp_" + "R8mZ2kQ7vX4nB1pL9sT6wY3cH5jD0fGaUeKo";

function freshHome(): string {
  const home = tmpRepo("wss-home");
  made.push(home);
  process.env.TRAIL_HOME = home;
  return home;
}

function put(file: string, content: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Tester", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function skill(name: string, body: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: "Tag and   publish   the build"\nauthor: Priya\n${extra}---\n${body}\n`;
}

/** A repo with tracked skills, a committed secret learning and an untracked one. */
function makeRepo(tag: string): string {
  const dir = tmpRepo(tag);
  made.push(dir);
  git(dir, "init", "-q", "-b", "main");
  const skills = join(dir, ".claude", "skills");
  put(join(skills, "cut-a-release", "SKILL.md"), skill("cut-a-release", "Steps here."));
  put(join(skills, "cut-a-release", "notes.txt"), "hello\n");
  put(join(skills, "cut-a-release", "logo.bin"), Buffer.from([0, 1, 2, 255]));
  put(join(skills, "cut-a-release", "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(skills, "cut-a-release", "run.sh"), 0o755);
  put(join(skills, "cut-a-release", "node_modules", "x.js"), "module.exports = 1;\n");
  put(join(skills, "ship-docs", "SKILL.md"), skill("ship-docs", "Publish the docs."));
  put(join(skills, "deploy-prod", "SKILL.md"), skill("deploy-prod", `Use token ${TOKEN} to deploy.`));
  put(join(dir, ".trail", "learnings", "leaked-token.md"), `---\ntitle: Leaked token\n---\nThe token is ${TOKEN}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  // Not tracked: never part of what goes up.
  put(join(skills, "cut-a-release", "untracked.txt"), "local only\n");
  put(join(skills, "scratch-pad", "SKILL.md"), skill("scratch-pad", "Mine only."));
  put(join(dir, ".trail", "learnings", "wip-notes.md"), `---\ntitle: Wip\n---\nPassword: https://admin:${TOKEN}@db.example.test\n`);
  return dir;
}

function cloudFor(dir: string, linkedAt = Date.now() - 60_000, extra: Partial<Cloud> = {}): Cloud {
  const key = repoPlace(dir).key;
  return {
    url: "http://acme.test",
    token: "trl_acme",
    user: { name: "Priya", email: "priya@acme.test" },
    workspace: { id: "w1", name: "Acme", slug: "acme", url: "http://acme.test/app/?w=acme", invite_url: "http://acme.test/join/x" },
    repos: [key],
    linkedAt,
    ...extra,
  } as Cloud;
}

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

type Call = { url: string; body: any };
function fakeFetch(calls: Call[], status = 200): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(url), body });
    if (status !== 200) return json({ error: "server down" }, status);
    if (Array.isArray(body.events)) return json({ stored: body.events.length });
    const n = Array.isArray(body.learnings) ? body.learnings.length : 0;
    return json({ repo: body.repo, learnings: n, added: n });
  }) as typeof fetch;
}

before(() => {
  process.env.DO_NOT_TRACK = "1";
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("what a repo sends", () => {
  let repo: string;
  before(() => {
    freshHome();
    repo = makeRepo("wss-repo");
  });

  test("the secret fixtures really hold a secret", () => {
    assert.ok(secretReason(`The token is ${TOKEN}`));
  });

  test("tracked skills go up with their folder files; secrets and untracked ones stay", () => {
    const got = workspaceLearnings(repo);
    assert.ok(got);
    const paths = got.learnings.map((l) => l.path).sort();
    assert.deepEqual(paths, [".claude/skills/cut-a-release/SKILL.md", ".claude/skills/ship-docs/SKILL.md"]);
    const left = got.leftOut.map((l) => l.name).sort();
    assert.deepEqual(left, [".claude/skills/deploy-prod/SKILL.md", "leaked-token.md"]);
    assert.ok(got.leftOut.every((l) => l.ref === "" && l.why.length > 0 && !l.why.includes(TOKEN)));

    const s = got.learnings.find((l) => l.path.includes("cut-a-release"))!;
    assert.equal(s.kind, "skill");
    assert.equal(s.title, "Cut a release");
    assert.equal(s.why, "Tag and publish the build");
    assert.equal(s.author, "Priya");
    assert.equal(s.body, "Steps here.");
    const files = new Map((s.files ?? []).map((f) => [f.path, f]));
    assert.deepEqual([...files.keys()].sort(), ["logo.bin", "notes.txt", "run.sh"]);
    assert.equal(files.get("logo.bin")?.encoding, "base64");
    assert.equal(files.get("logo.bin")?.content, "AAEC/w==");
    assert.equal(files.get("notes.txt")?.content, "hello\n");
    assert.equal(files.get("notes.txt")?.encoding, undefined);
    if (process.platform !== "win32") assert.equal(files.get("run.sh")?.executable, true);
  });

  test("the review page reads the working tree; a sync never does", () => {
    const tree = workspaceLearnings(repo, { tree: true });
    assert.ok(tree?.leftOut.some((l) => l.name === "wip-notes.md"), "an uncommitted learning is read for review");
    assert.ok(!workspaceLearnings(repo)?.leftOut.some((l) => l.name === "wip-notes.md"));
    const review = reviewPayload(repo).map((l) => l.path);
    assert.ok(review.includes(".claude/skills/cut-a-release/SKILL.md"));
    assert.ok(!review.some((p) => p.includes("deploy-prod")));
    assert.deepEqual(learningsPayload(repo)?.map((l) => l.path).sort(), workspaceLearnings(repo)?.learnings.map((l) => l.path).sort());
  });

  test("a folder that is no git checkout sends nothing", () => {
    const plain = tmpRepo("wss-plain");
    made.push(plain);
    assert.equal(learningsPayload(plain), null);
    assert.equal(workspaceLearnings(plain), null);
    assert.deepEqual(reviewPayload(plain), []);
  });
});

describe("syncing a repo", () => {
  let repo: string;
  let home: string;
  let cloud: Cloud;
  before(() => {
    home = freshHome();
    repo = makeRepo("wss-sync");
    cloud = cloudFor(repo);
  });

  test("a repo the workspace doesn't have is refused", async () => {
    const calls: Call[] = [];
    const res = await syncRepo(repo, { ...cloud, repos: ["github.com/other/repo"] }, { fetch: false, fetchImpl: fakeFetch(calls) });
    assert.deepEqual(res, { error: "this repo isn't in your workspace" });
    assert.equal(calls.length, 0);
  });

  test("first sync sends tracked skills and counts what was held back", async () => {
    const calls: Call[] = [];
    const res = await syncRepo(repo, cloud, { fetch: false, fetchImpl: fakeFetch(calls) });
    assert.ok(!("error" in res), JSON.stringify(res));
    assert.equal(res.learnings, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.body.held, 2);
    assert.equal(calls[0]!.body.removed, undefined);
    const sent = JSON.parse(readFileSync(join(home, "workspace-sent.json"), "utf8"));
    assert.deepEqual([...sent[repoPlace(repo).key].skills].sort(), ["cut-a-release", "ship-docs"]);
    assert.equal(syncIsDue(repo), false, "nothing changed since");
  });

  test("a skill deleted on the same branch is sent as removed", async () => {
    git(repo, "rm", "-q", "-r", join(".claude", "skills", "ship-docs"));
    git(repo, "commit", "-q", "-m", "drop ship-docs");
    assert.equal(syncIsDue(repo), true);
    const calls: Call[] = [];
    const res = await syncRepo(repo, cloud, { fetch: false, fetchImpl: fakeFetch(calls) });
    assert.ok(!("error" in res));
    assert.deepEqual(calls[0]!.body.removed, [".claude/skills/ship-docs/SKILL.md"]);
  });

  test("only uses of skills the workspace got are sent", async () => {
    const at = new Date().toISOString();
    const use = (s: string) => ({ repo: cloud.repos[0]!, kind: "skill" as const, skill: s, asker: "Priya", session: "s1", file_count: 0, shown_paths: [], shown_authors: [], at });
    recordActivity(use("cut-a-release"), cloud);
    recordActivity(use("ship-docs"), cloud);
    const calls: Call[] = [];
    assert.equal(await flushActivity(cloud, fakeFetch(calls)), 1);
    assert.deepEqual(calls[0]!.body.events.map((e: { skill: string }) => e.skill), ["cut-a-release"]);
  });

  test("on a detached HEAD a missing file takes nothing down", async () => {
    git(repo, "checkout", "-q", "--detach");
    git(repo, "rm", "-q", "-r", join(".claude", "skills", "cut-a-release"));
    git(repo, "commit", "-q", "-m", "drop on detached");
    const calls: Call[] = [];
    const res = await syncRepo(repo, cloud, { fetch: false, fetchImpl: fakeFetch(calls) });
    assert.ok(!("error" in res));
    assert.equal(calls[0]!.body.removed, undefined);
    git(repo, "checkout", "-q", "main");
  });

  test("a failed sync is retried only after a while", async () => {
    put(join(repo, ".claude", "skills", "new-one", "SKILL.md"), skill("new-one", "Fresh."));
    git(repo, "add", "-A", join(".claude", "skills", "new-one"));
    git(repo, "commit", "-q", "-m", "new skill");
    const calls: Call[] = [];
    const res = await syncRepo(repo, cloud, { fetch: false, fetchImpl: fakeFetch(calls, 500) });
    assert.ok("error" in res);
    const now = Date.now();
    assert.equal(syncIsDue(repo, now), false, "too soon after the failure");
    assert.equal(syncIsDue(repo, now + 6 * 60 * 1000), true, "due once the retry window passed");
  });
});

describe("the outbox and background work", () => {
  test("uses are built field by field", () => {
    assert.equal(activityEvent(null), null);
    assert.equal(activityEvent({ kind: "query" }), null);
    assert.equal(activityEvent({ kind: "skill", skill: "../etc" }), null);
    const e = activityEvent({ kind: "search", repo: "r", files: ["a", "b", 3], saved_tokens: 12.7, query: "secret prompt", at: "x" });
    assert.equal(e?.file_count, 2);
    assert.equal(e?.saved_tokens, 12);
    assert.equal((e as Record<string, unknown>).query, undefined);
    assert.equal(activityEvent({ kind: "check", file_count: -3.5, saved_tokens: 0 })?.file_count, 0);
    assert.equal(activityEvent({ kind: "check", saved_tokens: -1 })?.saved_tokens, undefined);
    assert.equal(learningName("origin/feat:.trail/learnings/a-b.md"), "a-b.md");
    assert.equal(learningName(".trail/learnings/c.md"), "c.md");
    assert.equal(repoSkillName(".claude/skills/cut/SKILL.md"), "cut");
    assert.equal(repoSkillName(".claude/skills/cut/other.md"), "");
  });

  test("a connect-made link records nothing and has no repos in its workspace", () => {
    freshHome();
    const repo = makeRepo("wss-connect");
    const c = cloudFor(repo, Date.now(), { via: "connect" } as Partial<Cloud>);
    assert.equal(records(c, c.repos[0]!), false);
    assert.equal(inWorkspace(repo, c), false);
    assert.equal(inWorkspace(repo, cloudFor(repo)), true);
    assert.equal(inWorkspace(repo, null), false);
  });

  test("an outbox past its size keeps only the newest lines", () => {
    const home = freshHome();
    const repoKey = "github.com/acme/trim";
    const c = { ...cloudFor(tmpRepo("wss-trim-x")), repos: [repoKey] } as Cloud;
    const pad = "p".repeat(560);
    const lines: string[] = [];
    for (let i = 0; i < 2100; i++) lines.push(JSON.stringify({ repo: repoKey, kind: "search", asker: pad, session: `s${i}`, file_count: 0, shown_paths: [], shown_authors: [], at: "x" }));
    writeFileSync(join(home, "outbox.jsonl"), `${lines.join("\n")}\n`);
    recordActivity({ repo: repoKey, kind: "check", asker: "Priya", session: "last", file_count: 1, shown_paths: [], shown_authors: [], at: new Date().toISOString() }, c);
    const kept = readFileSync(join(home, "outbox.jsonl"), "utf8").split("\n").filter(Boolean);
    assert.equal(kept.length, 2000);
    assert.equal(JSON.parse(kept[0]!).session, "s101");
    assert.equal(JSON.parse(kept.at(-1)!).session, "last");
  });

  test("not connected: background sync drops queued uses and does nothing", () => {
    const home = freshHome();
    writeFileSync(join(home, "outbox.jsonl"), '{"kind":"search"}\n');
    writeFileSync(join(home, "workspace-sent.json"), "{}");
    assert.equal(maybeSyncInBackground(home), false);
    assert.equal(existsSync(join(home, "outbox.jsonl")), false);
    assert.equal(existsSync(join(home, "workspace-sent.json")), false);
  });

  test("connected but nothing due: no child is started", () => {
    freshHome();
    const repo = makeRepo("wss-notdue");
    writeCloud({ ...cloudFor(repo), repos: ["github.com/acme/elsewhere"] } as Cloud);
    assert.equal(maybeSyncInBackground(repo), false);
  });

  test("the background child does nothing when not connected", async () => {
    freshHome();
    const repo = makeRepo("wss-child-none");
    const fetchMock = mock.method(globalThis, "fetch", async () => json({}));
    try {
      await runSyncChild(repo);
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      fetchMock.mock.restore();
    }
  });

  test("the background child syncs the repo and sends waiting uses", async () => {
    freshHome();
    const repo = makeRepo("wss-child");
    const c = cloudFor(repo);
    writeCloud(c);
    recordActivity({ repo: c.repos[0]!, kind: "skill", skill: "cut-a-release", asker: "Priya", session: "s1", file_count: 0, shown_paths: [], shown_authors: [], at: new Date().toISOString() });
    const calls: Call[] = [];
    const fake = fakeFetch(calls);
    const fetchMock = mock.method(globalThis, "fetch", fake);
    try {
      await runSyncChild(repo);
    } finally {
      fetchMock.mock.restore();
    }
    const upload = calls.find((x) => Array.isArray(x.body.learnings));
    assert.ok(upload, "learnings were uploaded");
    assert.ok(upload.body.learnings.some((l: { path: string }) => l.path === ".claude/skills/cut-a-release/SKILL.md"));
    const events = calls.find((x) => Array.isArray(x.body.events));
    assert.deepEqual(events?.body.events.map((e: { skill: string }) => e.skill), ["cut-a-release"]);
  });
});
