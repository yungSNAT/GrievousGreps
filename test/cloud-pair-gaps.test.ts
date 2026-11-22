import { test, describe, before, after, mock } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { BRAND_ENV } from "../src/brand.js";
import { foundLine, PairRun, type PhaseId } from "../src/cloud/pair.js";
import { writeNote } from "../src/notes/notes.js";
import { tmpRepo } from "./helpers.js";

const BASE = "http://trail.test";
const CONNECT_URL = `${BASE}/connect/pair-test`;
const PROGRESS = "/api/cli/handoffs/progress";
const VERSION = "1.2.3";
const NOTE_TITLE = "Keep retries bounded";

type Tokens = NonNullable<Parameters<PairRun["tokensDone"]>[0]>;
type Learning = Parameters<PairRun["learning"]>[0];
type FoundSkill = NonNullable<Parameters<PairRun["finish"]>[1]>[number];

interface RepoInfo {
  key: string;
  name: string;
}

interface Payload {
  state?: string;
  pair?: string;
  repo?: RepoInfo | null;
  repos?: (RepoInfo & { learnings: number })[];
  agent?: string;
  phases?: { id: PhaseId; status: string; count: string }[];
  log?: string[];
  findings?: Record<string, unknown>;
  found?: Record<string, unknown>[];
  replaceFound?: boolean;
  done?: boolean;
}

function stubTrail(t: TestContext, features?: string[]) {
  const calls: { url: URL; method?: string; body: Payload }[] = [];
  mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Payload;
    calls.push({ url, method: init?.method, body });
    if (url.origin !== BASE) return new Response(null, { status: 404 });
    if (url.pathname === PROGRESS) return Response.json({ ok: true });
    if (calls.length === 1 && body.pair) {
      return Response.json({ url: CONNECT_URL, features });
    }
    return new Response(null, { status: 404 });
  });
  t.after(() => mock.restoreAll());

  return {
    calls,
    progress: () => calls.filter(({ url }) => url.pathname === PROGRESS).map(({ body }) => body),
  };
}

async function startRun(repo: string): Promise<PairRun> {
  const run = await PairRun.start(repo, "  aCmE-123  ", {
    agent: "claude",
    version: VERSION,
    fetchImpl: globalThis.fetch,
  });
  if (!(run instanceof PairRun)) assert.fail(`Pairing failed: ${run.error}`);
  return run;
}

function assertPhase(body: Payload, id: PhaseId, status: string, count: string): void {
  const phase = body.phases?.find((p) => p.id === id);
  assert.ok(phase, `expected a report for phase ${id}`);
  assert.equal(phase.status, status);
  assert.equal(phase.count, count);
}

const draft = {
  title: "Check the retry budget",
  body: "Read the retry configuration before changing the worker.",
  touches: [],
} as Learning;

test("foundLine counts team learnings, team skills, and machine skills separately", () => {
  assert.equal(foundLine(0, 0), "Found 0 learnings for your team");
  assert.equal(foundLine(1, 0), "Found 1 learning for your team");
  assert.equal(foundLine(0, 1), "Found 1 skill for your team");
  assert.equal(foundLine(0, 2, 0), "Found 2 skills for your team");
  assert.equal(foundLine(1, 2, 1), "Found 1 learning and 2 skills for your team, and 1 skill kept on this machine");
  assert.equal(foundLine(3, 1, 2), "Found 3 learnings and 1 skill for your team, and 2 skills kept on this machine");
});

describe("PairRun progress", () => {
  const dirs: string[] = [];
  const savedEnv = new Map<string, string | undefined>();
  let repo: string;
  let plain: string;

  function scratch(tag: string): string {
    const dir = tmpRepo(tag);
    dirs.push(dir);
    return dir;
  }

  before(() => {
    const env = {
      [BRAND_ENV]: "trail",
      DO_NOT_TRACK: "1",
      TRAIL_HOME: scratch("pair-gaps-home"),
      TRAIL_TEST_SERVER: BASE,
      TRAIL_NO_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "file",
    };
    for (const [key, value] of Object.entries(env)) {
      savedEnv.set(key, process.env[key]);
      process.env[key] = value;
    }

    plain = scratch("pair-gaps-plain");
    repo = scratch("pair-gaps-repo");
    const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Sam Test");
    git("config", "user.email", "sam@example.test");
    git("remote", "add", "origin", "https://github.com/acme/pair-fixture.git");
    writeNote(repo, {
      title: NOTE_TITLE,
      body: "## Decided\nUse at most four retries.",
      author: "Sam Test",
      date: "2026-01-15",
      touches: [],
    });
    git("add", "-A", "-f");
    git("commit", "-q", "-m", "Record the retry decision");
  });

  after(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of dirs.reverse()) rmSync(dir, { recursive: true, force: true });
  });

  test("start registers only the current repo and reports the installed version", async (t) => {
    const trail = stubTrail(t, []);
    const run = await startRun(repo);
    await run.flush();

    assert.equal(run.url, CONNECT_URL);
    assert.equal(trail.calls.length, 2);
    const [registration, install] = trail.calls;
    assert.ok(registration && install);
    assert.equal(registration.url.origin, BASE);
    assert.equal(registration.method, "POST");
    assert.equal(registration.body.pair, "ACME-123");
    assert.ok(run.state);
    assert.equal(registration.body.state, run.state);
    assert.equal(registration.body.repo?.key, "github.com/acme/pair-fixture");
    assert.ok(registration.body.repo.name);
    assert.deepEqual(registration.body.repos, [{ ...registration.body.repo, learnings: 1 }]);

    assert.equal(install.url.pathname, PROGRESS);
    assert.equal(install.body.state, run.state);
    assert.equal(install.body.agent, "claude");
    assert.deepEqual(install.body.log, [`Installed Trail-code ${VERSION}`]);
    assertPhase(install.body, "install", "done", VERSION);
    assertPhase(install.body, "files", "todo", "");
  });

  test("without Git or live support, finish sends an empty review and no draft", async (t) => {
    const trail = stubTrail(t);
    const run = await startRun(plain);
    run.learning(draft, "Sam Test");
    await run.finish(plain);

    const registration = trail.calls[0]?.body;
    assert.equal(registration?.repo, null);
    assert.deepEqual(registration?.repos, []);

    const progress = trail.progress();
    const reviews = progress.filter((body) => Object.hasOwn(body, "found"));
    assert.equal(reviews.length, 1);
    const review = reviews[0]!;
    assert.deepEqual(review.found, []);
    assert.equal(Object.hasOwn(review, "replaceFound"), false);
    assert.deepEqual(review.log, ["Found 0 learnings for your team"]);
    assertPhase(review, "learnings", "done", "0");
    assert.equal(progress.at(-1)?.done, true);
  });

  test("phase completion retains the previous count when no new count is supplied", async (t) => {
    const trail = stubTrail(t);
    const run = await startRun(repo);
    run.phase("files", "running", "12 files", "Mapped 12 files");
    run.phase("files", "done");
    await run.flush();

    const reports = trail.progress().slice(1);
    assert.equal(reports.length, 2);
    const [running, done] = reports;
    assert.ok(running && done);
    assertPhase(running, "files", "running", "12 files");
    assert.deepEqual(running.log, ["Mapped 12 files"]);
    assertPhase(done, "files", "done", "12 files");
    assertPhase(done, "prs", "todo", "");
    assert.equal(Object.hasOwn(done, "log"), false);
  });

  const measurements: { label: string; tokens: Tokens | null; count: string; log?: string }[] = [
    { label: "skipped", tokens: null, count: "skipped" },
    {
      label: "one file and no PR",
      tokens: { pct: 70, files: 1 } as Tokens,
      count: "~70% fewer tokens",
      log: "One lookup used ~70% fewer tokens than reading 1 file (estimate)",
    },
    {
      label: "the last PR across several files",
      tokens: { pct: 42, files: 3, pr: { number: 17 } } as Tokens,
      count: "~42% fewer tokens",
      log: "Your last PR, #17: one lookup used ~42% fewer tokens than reading 3 files (estimate)",
    },
  ];

  for (const { label, tokens, count, log } of measurements) {
    test(`reports the token step: ${label}`, async (t) => {
      const trail = stubTrail(t);
      const run = await startRun(repo);
      run.tokensDone(tokens);
      if (tokens) run.findings({ tokens, sessions: 0, teammates: [], agents: ["claude", "codex"] });
      else run.findings({ tokens: null, sessions: 0 });
      await run.flush();

      const reports = trail.progress().slice(1);
      assert.equal(reports.length, 2);
      const [measurement, findings] = reports;
      assert.ok(measurement && findings);
      assertPhase(measurement, "tokens", "done", count);
      if (log) assert.deepEqual(measurement.log, [log]);
      else assert.equal(Object.hasOwn(measurement, "log"), false);
      assert.deepEqual(
        findings.findings,
        tokens ? { tokens, sessions: 0, teammates: [], agents: ["claude", "codex"] } : { sessions: 0 },
      );
    });
  }

  test("live progress gives way to the final review, which only names machine skills", async (t) => {
    const trail = stubTrail(t, ["live_found"]);
    const run = await startRun(repo);
    run.learning(draft, "Sam Test");
    await run.flush();

    const live = trail.progress().filter((body) => Object.hasOwn(body, "found"));
    assert.equal(live.length, 1);
    assert.equal(live[0]?.found?.length, 1);
    const item = live[0]?.found?.[0];
    assert.ok(item);
    const hash = createHash("sha256").update(`live:${draft.title}\n${draft.body}`).digest("hex");
    assert.equal(item.hash, hash);
    assert.equal(item.path, `live/${hash.slice(0, 16)}`);
    assert.equal(item.kind, "decision");
    assert.equal(item.title, draft.title);
    assert.equal(item.author, "Sam Test");
    assert.equal(item.body, draft.body);

    await run.finish(repo, [
      { id: "ci-check", name: "check-ci", title: "  Check\n CI before pushing  ", days: 1, body: "Private CI steps" } as FoundSkill,
      { id: "logs", name: "read-logs", title: "Read the worker logs", days: 3, body: "Private log steps" } as FoundSkill,
      { id: "untitled", name: "untitled", title: " \n ", days: 2 } as FoundSkill,
    ]);

    const progress = trail.progress();
    const replacements = progress.filter((body) => body.replaceFound === true);
    assert.equal(replacements.length, 1);
    const review = replacements[0]!;
    assert.deepEqual(review.log, ["Found 1 learning for your team, and 2 skills kept on this machine"]);
    assertPhase(review, "learnings", "done", "3");
    assert.equal(review.found?.length, 3);
    const [decision, ci, logs] = review.found!;
    assert.ok(decision && ci && logs);
    assert.equal(decision.kind, "decision");
    assert.equal(decision.title, NOTE_TITLE);
    assert.equal(ci.kind, "skill");
    assert.equal(ci.path, "~/.trail/skills/check-ci");
    assert.equal(ci.title, "Check CI before pushing");
    assert.equal(ci.why, "kept on this machine · came up on 1 day");
    assert.equal(ci.body, "");
    assert.equal(logs.kind, "skill");
    assert.equal(logs.title, "Read the worker logs");
    assert.equal(logs.why, "kept on this machine · came up on 3 days");
    assert.equal(logs.body, "");
    assert.equal(progress.at(-1)?.done, true);
  });
});
