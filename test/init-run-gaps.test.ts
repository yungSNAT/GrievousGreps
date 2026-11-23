import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginLookBack, claudeAiLine, finishLookBack, mayCallClaude } from "../src/init/run.js";
import { candidateId } from "../src/init/candidates.js";
import { readInitRecord } from "../src/init/init-record.js";
import { leadWords } from "../src/init/keep-answer.js";
import type { LookBackResult } from "../src/init/look-back-mine.js";
import type { InitCandidate } from "../src/init/types.js";
import { repoPlace } from "../src/notes/home.js";
import { tmpRepo } from "./helpers.js";

describe("init look-back gaps", () => {
  let root: string;
  let repo: string;
  let trail: string;
  let env: NodeJS.ProcessEnv;
  const saved = new Map<string, string | undefined>();
  const deps = {
    stdinTTY: false,
    stdoutTTY: false,
    pid: 4243,
    ps: () => [
      { pid: 1, ppid: 0, comm: "init", args: "init" },
      { pid: 4243, ppid: 1, comm: "node", args: "node trail init" },
    ],
  };

  before(() => {
    root = tmpRepo("init-run-gaps");
    repo = join(root, "checkout");
    const home = join(root, "home");
    trail = join(root, "trail");
    for (const dir of [repo, home, trail]) mkdirSync(dir);

    execFileSync("git", ["init", "--quiet"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/init-run-gaps.git"], { cwd: repo });
    writeFileSync(join(trail, "settings.json"), JSON.stringify({ v: 1, skills: "on" }));

    env = {
      HOME: home,
      USERPROFILE: home,
      TRAIL_HOME: trail,
      DO_NOT_TRACK: "1",
      TRAIL_NO_FETCH: "1",
    };
    // Some of the record and telemetry helpers also consult the process environment.
    for (const key of ["TRAIL_HOME", "DO_NOT_TRACK", "TRAIL_NO_FETCH"]) {
      saved.set(key, process.env[key]);
      process.env[key] = env[key]!;
    }
    mock.method(globalThis, "fetch", async () => {
      throw new Error("init look-back test must not fetch");
    });
  });

  after(() => {
    mock.restoreAll();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("--plain and the look-back opt-out deny model calls even for an eligible person", () => {
    const off = { ...env, TRAIL_NO_LOOK_BACK: "1" };
    const { reads } = beginLookBack(repo, { env: off, deps });
    const person = { ...reads.person, ok: true, tty: true, claudeAncestor: false };

    assert.equal(mayCallClaude(env, { plain: true }, deps, person), false);
    assert.equal(mayCallClaude(off, { plain: false }, deps, person), false);
  });

  test("Claude.ai export copy distinguishes an empty file, no new facts, and personal offers", () => {
    assert.match(claudeAiLine(0, 0), /found nothing in that file/);
    assert.match(claudeAiLine(7, 0), /none of the 7.*nothing to offer/);
    assert.match(claudeAiLine(7, 2), /offers 2 of the 7.*about code, just for you/);
  });

  test("a disabled look-back still reports an empty export but has nothing to finish", async () => {
    const { reads, lines } = beginLookBack(repo, {
      env: { ...env, TRAIL_NO_LOOK_BACK: "1" },
      deps,
      again: true,
      claudeExport: "",
    });
    assert.equal(reads.lb, null);
    assert.equal(reads.claudeAi.length, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /found nothing in that file/);

    const said: string[] = [];
    const result = await finishLookBack(repo, reads, { yes: false, say: (line) => said.push(line) });
    assert.deepEqual(result, { kept: 0, inRepo: false, team: 0 });
    assert.deepEqual(said, []);
  });

  test("an agent's --yes writes numbered skill offers without keeping them", async () => {
    const agentEnv = { ...env, CLAUDECODE: "1" };
    const repoKey = repoPlace(repo, agentEnv).key;
    // Supply the miner's presentation data without starting a worker or model.
    const { reads } = beginLookBack(repo, {
      env: { ...agentEnv, TRAIL_NO_LOOK_BACK: "1" },
      deps,
    });

    function skill(key: string, plainName: string, rank: number, days: number): InitCandidate {
      return {
        id: candidateId("skill", key),
        kind: "skill",
        key,
        plainName,
        nameWords: leadWords(plainName.replaceAll("-", " ")),
        count: { days, from: "2026-09-01", to: "2026-09-10" },
        scope: "repo",
        applies: repoKey,
        typed: false,
        ticked: false,
        evidence: [],
        rank,
      };
    }

    const candidates = [
      skill("tests", "run-project-tests", 1, 5),
      skill("release", "publish-package", 2, 4),
    ];
    const mined: LookBackResult = {
      sessions: [],
      skipped: [],
      days: 5,
      from: "2026-09-01",
      to: "2026-09-10",
      parent: 0,
      candidates,
      alreadyKept: { here: 0, elsewhere: [] },
      howtos: [],
      ms: 10,
      errors: [],
    };

    let land!: (result: LookBackResult) => void;
    const lb = new Promise<LookBackResult>((resolve) => { land = resolve; });
    const said: string[] = [];
    const now = new Date();
    const finishing = finishLookBack(repo, { ...reads, env: agentEnv, lb }, {
      yes: true,
      now,
      say: (line) => said.push(line),
    });
    await Promise.resolve();
    land(mined);
    const result = await finishing;

    assert.equal(result.kept, 0);
    assert.equal(result.inRepo, false);
    assert.equal(result.team, 0);
    assert.deepEqual(result.skills, candidates.map((c) => ({
      id: c.id,
      name: c.plainName,
      title: c.plainName,
      days: c.count.days,
    })));
    assert.ok(said.includes("· still looking back at your past sessions…"));

    const record = readInitRecord(repoKey, agentEnv);
    const run = record.runs.at(-1);
    assert.ok(run);
    assert.equal(run.at, now.toISOString());
    assert.equal(run.screen, "relay");
    assert.equal(run.model, "none");
    assert.equal(run.modelWhy, "agent");
    assert.deepEqual(run.shown, candidates.map((c) => c.id));
    assert.deepEqual(run.kept, []);
    assert.equal(record.pendingFrom, run.id);

    // These fixtures have no compiled skill to replay, so inspect the pending
    // rows on disk before the record reader filters them.
    const written = readdirSync(trail, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => JSON.parse(readFileSync(join(entry.parentPath, entry.name), "utf8")) as {
        repo?: string;
        pendingFrom?: string;
        shownAt?: string;
        pending?: Array<{ id: string; n: number }>;
      })
      .find((entry) => entry.repo === repoKey && entry.pendingFrom === run.id);
    assert.ok(written, "the init record on disk links pending offers to this run");
    assert.equal(written.shownAt, now.toISOString());
    assert.ok(written.pending);
    assert.deepEqual(
      written.pending.map(({ id, n }) => ({ id, n })),
      candidates.map((c, index) => ({ id: c.id, n: index + 1 })),
    );
    for (const row of written.pending) {
      assert.equal(Object.hasOwn(row, "title"), false, "display titles are returned, not persisted");
    }
  });
});
