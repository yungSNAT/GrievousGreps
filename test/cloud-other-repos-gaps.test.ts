/**
 * Gap tests for src/cloud/other-repos.ts: which of the laptop's other repos are
 * offered, how duplicates merge, what is skipped, where Trail's own known repos
 * come in, the cap on how many go to the page, and the default home and env.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_ENV } from "../src/brand.js";
import { writeNote } from "../src/notes/notes.js";
import { machinePayload, otherRepos, OTHER_REPOS_MAX } from "../src/cloud/other-repos.js";
import { tmpRepo } from "./helpers.js";

const ENV_KEYS = ["TRAIL_HOME", BRAND_ENV, "DO_NOT_TRACK", "TRAIL_NO_FETCH", "HOME", "USERPROFILE"];
const saved: Record<string, string | undefined> = {};
const cleanup: string[] = [];

function git(d: string, args: string[]) {
  spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: d });
}

/** A git checkout whose origin is github.com/acme/<name>. */
function gitRepo(name: string): string {
  const dir = tmpRepo(name);
  cleanup.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Priya Raman"]);
  git(dir, ["config", "user.email", "priya@acme.test"]);
  git(dir, ["remote", "add", "origin", `https://github.com/acme/${name}.git`]);
  return dir;
}

function scratch(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), tag));
  cleanup.push(d);
  return d;
}

/** A Trail home that knows no repos yet. */
function freshTrailHome(): NodeJS.ProcessEnv {
  process.env.TRAIL_HOME = scratch("gaps-trail-home-");
  return { ...process.env };
}

/** A Claude Code project folder with `n` sessions that started in `cwd`, last touched `at`. */
function sessions(home: string, folder: string, cwd: string | null, n: number, at: Date): void {
  const dir = join(home, ".claude", "projects", folder);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const f = join(dir, `s${i}.jsonl`);
    const line = cwd === null
      ? { type: "user", message: { role: "user", content: "hi" } }
      : { type: "user", cwd, message: { role: "user", content: "hi" } };
    writeFileSync(f, JSON.stringify(line) + "\n");
    utimesSync(f, at, at);
  }
}

describe("otherRepos gaps", () => {
  before(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.DO_NOT_TRACK = "1";
    process.env.TRAIL_NO_FETCH = "1";
    process.env[BRAND_ENV] = "trail";
  });

  after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  });

  test("a laptop without Claude Code and with no known repos offers nothing", () => {
    const env = freshTrailHome();
    const home = scratch("gaps-empty-home-");
    assert.deepEqual(otherRepos("github.com/acme/billing", home, env), []);
  });

  test("folders are skipped when they can't name a repo, and one repo's folders merge", () => {
    const env = freshTrailHome();
    const home = tmpRepo("gaps-home");
    cleanup.push(home);
    const web = gitRepo("web");
    const api = gitRepo("api");
    const billing = gitRepo("billing");
    mkdirSync(join(web, "src"));

    // Three folders for the same repo: counts add up, the newest wins.
    sessions(home, "web-a", web, 2, new Date("2026-10-01T00:00:00Z"));
    sessions(home, "web-b", join(web, "src"), 3, new Date("2026-10-10T00:00:00Z"));
    sessions(home, "web-c", web, 1, new Date("2026-09-01T00:00:00Z"));
    sessions(home, "api", api, 1, new Date("2026-10-05T00:00:00Z"));
    // The repo being connected is never offered.
    sessions(home, "billing", billing, 7, new Date("2026-10-30T00:00:00Z"));
    // A session with no cwd, one in the home folder, one in a deleted folder.
    sessions(home, "nocwd", null, 2, new Date("2026-10-30T00:00:00Z"));
    sessions(home, "home", home, 2, new Date("2026-10-30T00:00:00Z"));
    sessions(home, "gone", join(home, "deleted"), 2, new Date("2026-10-30T00:00:00Z"));
    // A plain file among the project folders, a folder without transcripts,
    // and a folder whose only ".jsonl" is itself a folder.
    writeFileSync(join(home, ".claude", "projects", "notes.txt"), "not a folder");
    mkdirSync(join(home, ".claude", "projects", "empty"), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", "empty", "readme.md"), "hi");
    mkdirSync(join(home, ".claude", "projects", "dirjsonl", "a.jsonl"), { recursive: true });

    const got = otherRepos("github.com/acme/billing", home, env);
    assert.deepEqual(got.map((r) => [r.key, r.sessions]), [["github.com/acme/web", 6], ["github.com/acme/api", 1]]);
    const w = got[0]!;
    assert.equal(w.name, "acme/web");
    assert.equal(w.checkout, web);
    assert.equal(w.lastUsed, Date.parse("2026-10-10T00:00:00Z"));
    assert.equal(got[1]!.checkout, api);
    assert.equal(got[1]!.lastUsed, Date.parse("2026-10-05T00:00:00Z"));

    const sent = machinePayload(got);
    assert.equal(sent[0]!.last_used, "2026-10-10T00:00:00.000Z");
    assert.equal(JSON.stringify(sent).includes(web), false);
  });

  test("repos Trail already knows are offered with no sessions, except the one being connected", () => {
    const env = freshTrailHome();
    const docs = gitRepo("docs");
    writeNote(docs, { title: "A learning of docs", body: "## Decided\nYes.", author: "Sam", date: "2026-10-07", touches: [] });
    const home = scratch("gaps-known-home-");

    const got = otherRepos("github.com/acme/billing", home, { ...env });
    const found = got.find((r) => r.key === "github.com/acme/docs");
    assert.ok(found, `docs should be offered, got ${JSON.stringify(got.map((r) => r.key))}`);
    assert.equal(found.sessions, 0);
    assert.equal(found.checkout, docs);
    assert.equal(found.name, "acme/docs");
    assert.ok(found.lastUsed > 0, "a known repo carries when Trail last saw it");

    assert.equal(otherRepos("github.com/acme/docs", home, { ...env }).some((r) => r.key === "github.com/acme/docs"), false);
  });

  test("a known repo with sessions too adds them up under one entry", () => {
    const env = freshTrailHome();
    const ops = gitRepo("ops");
    writeNote(ops, { title: "A learning of ops", body: "## Decided\nYes.", author: "Sam", date: "2026-10-07", touches: [] });
    const home = scratch("gaps-both-home-");
    sessions(home, "ops", ops, 4, new Date("2020-01-01T00:00:00Z"));

    const got = otherRepos("github.com/acme/billing", home, { ...env });
    const ops1 = got.filter((r) => r.key === "github.com/acme/ops");
    assert.equal(ops1.length, 1);
    assert.equal(ops1[0]!.sessions, 4);
    // Trail saw it just now, which is newer than the old sessions.
    assert.ok(ops1[0]!.lastUsed > Date.parse("2020-01-01T00:00:00Z"));
  });

  test("at most OTHER_REPOS_MAX go to the page, most recently used first", () => {
    const env = freshTrailHome();
    const home = scratch("gaps-many-home-");
    const total = OTHER_REPOS_MAX + 2;
    for (let i = 0; i < total; i++) {
      const name = `svc${String(i).padStart(2, "0")}`;
      const dir = gitRepo(name);
      sessions(home, name, dir, 1, new Date(Date.UTC(2026, 0, 1 + i)));
    }
    const got = otherRepos("github.com/acme/billing", home, env);
    assert.equal(got.length, OTHER_REPOS_MAX);
    assert.equal(got[0]!.key, `github.com/acme/svc${String(total - 1).padStart(2, "0")}`);
    assert.equal(got[got.length - 1]!.key, "github.com/acme/svc02");
    assert.equal(got.some((r) => r.key === "github.com/acme/svc00" || r.key === "github.com/acme/svc01"), false);
    for (let i = 1; i < got.length; i++) assert.ok(got[i - 1]!.lastUsed > got[i]!.lastUsed);
  });

  test("by default it looks in the user's home and Trail's environment", () => {
    freshTrailHome();
    const home = scratch("gaps-default-home-");
    const app = gitRepo("app");
    sessions(home, "app", app, 2, new Date("2026-10-15T00:00:00Z"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const got = otherRepos("github.com/acme/billing");
      assert.deepEqual(got.map((r) => [r.key, r.sessions]), [["github.com/acme/app", 2]]);
      assert.equal(got[0]!.checkout, app);
    } finally {
      for (const k of ["HOME", "USERPROFILE"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  test("the page gets no last_used when it's unknown", () => {
    const sent = machinePayload([{ key: "github.com/acme/x", name: "acme/x", checkout: join(tmpdir(), "x"), lastUsed: 0, sessions: 3 }]);
    assert.deepEqual(sent, [{ key: "github.com/acme/x", name: "acme/x", sessions: 3 }]);
  });
});
