/**
 * Gap tests for src/cloud/team-file.ts: reading, trusting, writing and announcing
 * a repo's `.trail/workspace.json`.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTeamFile, teamWorkspace, writeTeamFile, teamLine, teamSignInLine } from "../src/cloud/team-file.js";
import { serverUrl, trailUrl } from "../src/cloud/workspace.js";

let root: string;
let home: string;
let env: NodeJS.ProcessEnv;
let trail: string;
let counter = 0;

function freshRepo(withTrail = true, git = false): string {
  const dir = join(root, `repo-${counter++}`);
  mkdirSync(dir, { recursive: true });
  if (git) spawnSync("git", ["init", "-q", dir]);
  if (withTrail) mkdirSync(join(dir, ".trail"), { recursive: true });
  return dir;
}

function writeRaw(dir: string, value: unknown): void {
  mkdirSync(join(dir, ".trail"), { recursive: true });
  writeFileSync(join(dir, ".trail", "workspace.json"), JSON.stringify(value, null, 2) + "\n");
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "team-file-gaps-")));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  env = { ...process.env, TRAIL_HOME: join(home, ".trail"), HOME: home, USERPROFILE: home };
  const url = trailUrl(env);
  const normalized = serverUrl(url);
  assert.ok(normalized, "the default Trail address is a valid server URL");
  trail = normalized as string;
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readTeamFile", () => {
  test("returns null when the file is missing", () => {
    const dir = freshRepo();
    assert.equal(readTeamFile(dir), null);
  });

  test("returns null for an invalid slug or a missing trail", () => {
    const dir = freshRepo();
    writeRaw(dir, { trail, workspace: "Not A Slug!", name: "Team" });
    assert.equal(readTeamFile(dir), null);
    writeRaw(dir, { workspace: "team", name: "Team" });
    assert.equal(readTeamFile(dir), null);
    writeRaw(dir, { trail, workspace: 42, name: "Team" });
    assert.equal(readTeamFile(dir), null);
  });

  test("collapses whitespace in the name and caps it at 80 characters", () => {
    const dir = freshRepo();
    writeRaw(dir, { trail, workspace: "acme-team", name: "  Acme\n\t  Team  " });
    const f = readTeamFile(dir);
    assert.ok(f);
    assert.equal(f.name, "Acme Team");
    assert.equal(f.workspace, "acme-team");
    assert.equal(f.trail, trail);

    writeRaw(dir, { trail, workspace: "acme-team", name: "x".repeat(200) });
    assert.equal(readTeamFile(dir)?.name, "x".repeat(80));
  });

  test("falls back to the slug when the name is missing, blank or not a string", () => {
    const dir = freshRepo();
    writeRaw(dir, { trail, workspace: "acme" });
    assert.equal(readTeamFile(dir)?.name, "acme");
    writeRaw(dir, { trail, workspace: "acme", name: "   \n  " });
    assert.equal(readTeamFile(dir)?.name, "acme");
    writeRaw(dir, { trail, workspace: "acme", name: 17 });
    assert.equal(readTeamFile(dir)?.name, "acme");
  });
});

describe("teamWorkspace", () => {
  test("trusts the file when it names the Trail this laptop signs in to", () => {
    const dir = freshRepo();
    writeRaw(dir, { trail, workspace: "acme", name: "Acme" });
    assert.deepEqual(teamWorkspace(dir, env), { trail, workspace: "acme", name: "Acme" });
  });

  test("ignores a file pointing at a different Trail", () => {
    const dir = freshRepo();
    writeRaw(dir, { trail: "https://elsewhere.example.org", workspace: "acme", name: "Acme" });
    assert.equal(teamWorkspace(dir, env), null);
  });

  test("returns null when there is no file", () => {
    const dir = freshRepo();
    assert.equal(teamWorkspace(dir, env), null);
  });

  test("uses process.env by default", () => {
    const dir = freshRepo();
    writeRaw(dir, { trail: serverUrl(trailUrl(process.env)), workspace: "acme", name: "Acme" });
    assert.equal(teamWorkspace(dir)?.workspace, "acme");
  });
});

describe("writeTeamFile", () => {
  test("does nothing in a repo without .trail", () => {
    const dir = freshRepo(false);
    assert.equal(writeTeamFile(dir, { url: trail, workspace: { slug: "acme", name: "Acme" } } as never), false);
    assert.equal(existsSync(join(dir, ".trail")), false);
  });

  test("refuses an invalid slug or an invalid address", () => {
    const dir = freshRepo();
    assert.equal(writeTeamFile(dir, { url: trail, workspace: { slug: "Bad Slug", name: "X" } } as never), false);
    assert.equal(writeTeamFile(dir, { url: "not a url", workspace: { slug: "acme", name: "X" } } as never), false);
    assert.equal(existsSync(join(dir, ".trail", "workspace.json")), false);
  });

  test("writes once, skips when unchanged, rewrites when the name changes", () => {
    const dir = freshRepo();
    const cloud = { url: trail, workspace: { slug: "acme", name: "Acme" } };
    assert.equal(writeTeamFile(dir, cloud as never), true);
    const written = JSON.parse(readFileSync(join(dir, ".trail", "workspace.json"), "utf8"));
    assert.deepEqual(written, { trail, workspace: "acme", name: "Acme" });

    assert.equal(writeTeamFile(dir, cloud as never), false);

    assert.equal(writeTeamFile(dir, { url: trail, workspace: { slug: "acme", name: "Acme Corp" } } as never), true);
    assert.equal(readTeamFile(dir)?.name, "Acme Corp");

    assert.equal(writeTeamFile(dir, { url: trail, workspace: { slug: "other", name: "Acme Corp" } } as never), true);
    assert.equal(readTeamFile(dir)?.workspace, "other");
  });

  test("returns false instead of throwing on a malformed cloud", () => {
    const dir = freshRepo();
    assert.equal(writeTeamFile(dir, { url: trail } as never), false);
    assert.equal(existsSync(join(dir, ".trail", "workspace.json")), false);
  });
});

describe("teamLine and teamSignInLine", () => {
  test("teamLine names the workspace and the login command", () => {
    const line = teamLine("Acme", "acme");
    assert.match(line, /their workspace Acme has/);
    assert.ok(line.includes("`trail login --workspace acme`"));
  });

  test("offers the sign-in in a repo whose team file is trusted and not signed in", () => {
    const dir = freshRepo(true, true);
    writeRaw(dir, { trail, workspace: "acme", name: "Acme  Team" });
    const line = teamSignInLine(dir, env);
    assert.equal(line, teamLine("Acme Team", "acme"));
  });

  test("says nothing without a team file or with an untrusted one", () => {
    const dir = freshRepo(true, true);
    assert.equal(teamSignInLine(dir, env), "");
    writeRaw(dir, { trail: "https://elsewhere.example.org", workspace: "acme", name: "Acme" });
    assert.equal(teamSignInLine(dir, env), "");
  });
});
