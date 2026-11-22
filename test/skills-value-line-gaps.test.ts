import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { withLock } from "../src/util/private-fs.js";
import {
  markValueSaid,
  noteValue,
  VALUE_LOCK_MS,
  valueCounts,
  valueLine,
  valuePath,
} from "../src/skills/value-line.js";

const SHOP = "github.com/acme/shop";
const NOW = new Date(2026, 9, 22, 12);
const TODAY = "2026-10-22";

interface SavedRepo {
  saidAt: string | null;
  days: Record<string, { g: number; w: number }>;
}

function writeValueText(env: NodeJS.ProcessEnv, text: string): void {
  const path = valuePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function seedRepos(env: NodeJS.ProcessEnv, repos: Record<string, unknown>): void {
  writeValueText(env, JSON.stringify({ v: 1, repos }));
}

function savedRepos(env: NodeJS.ProcessEnv): Record<string, SavedRepo> {
  return JSON.parse(readFileSync(valuePath(env), "utf8")).repos;
}

describe("weekly value bookkeeping", () => {
  let scratch: string | undefined;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "value-line-gaps-"));
  });

  after(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  function box(tag: string): NodeJS.ProcessEnv {
    assert.ok(scratch);
    const home = mkdtempSync(join(scratch, `${tag}-`));
    return { HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, "trail") };
  }

  test("one known error came with its fix; the next fix makes the line plural", () => {
    const env = box("wall-fixes");
    mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
    try {
      noteValue(SHOP, { wallFixes: 1 }, env);
      assert.match(valueLine([SHOP], env) ?? "", /\b1 known error came with its fix\.$/);

      noteValue(SHOP, { wallFixes: 1 }, env);
      assert.match(valueLine([SHOP], env) ?? "", /\b2 known errors came with their fix\.$/);
    } finally {
      mock.timers.reset();
    }
  });

  test("repo keys are case-insensitive, but labels and dot segments are refused", () => {
    const env = box("repo-key");
    noteValue("github.com/acme/../shop", { wallFixes: 9 }, env, NOW);
    assert.equal(markValueSaid("my project", env, NOW), false);
    assert.equal(existsSync(valuePath(env)), false);

    noteValue("GitHub.COM/Acme/Shop", { wallFixes: 1 }, env, NOW);
    assert.deepEqual(Object.keys(savedRepos(env)), [SHOP]);
    assert.equal(valueCounts([SHOP, "GITHUB.COM/ACME/SHOP"], env, NOW).wallFixes, 1);
  });

  test("truncated JSON reads as empty and the next Stop writes usable counts", () => {
    const env = box("truncated");
    const truncated = '{"v":1,"repos":{';
    writeValueText(env, truncated);

    assert.equal(valueLine([SHOP], env, NOW), null);
    assert.equal(readFileSync(valuePath(env), "utf8"), truncated, "a read does not rewrite the file");

    noteValue(SHOP, { guardrailStops: 2 }, env, NOW);
    assert.deepEqual(savedRepos(env)[SHOP], {
      saidAt: null,
      days: { [TODAY]: { g: 2, w: 0 } },
    });
    assert.equal(valueCounts([SHOP], env, NOW).guardrailStops, 2);
  });

  test("malformed day entries are dropped without losing valid counts", () => {
    const env = box("malformed-days");
    seedRepos(env, {
      [SHOP]: {
        saidAt: "not a day",
        days: {
          [TODAY]: { g: 4, w: 1 },
          "2026-10-21": [{ g: 100, w: 100 }],
          "2026-10-20 extra": { g: 100, w: 100 },
          "2026-10-19": { g: -1, w: 1.5 },
          "2026-10-16": { g: 2, w: 0 },
          "2026-10-15": { g: 50, w: 50 },
        },
      },
    });

    assert.deepEqual(valueCounts([SHOP], env, NOW), {
      skills: [],
      guardrailStops: 6,
      wallFixes: 1,
    });

    noteValue(SHOP, { wallFixes: 2 }, env, NOW);
    const repo = savedRepos(env)[SHOP]!;
    assert.equal(repo.saidAt, null);
    assert.equal(Object.hasOwn(repo.days, "2026-10-21"), false);
    assert.equal(Object.hasOwn(repo.days, "2026-10-20 extra"), false);
    assert.deepEqual(repo.days["2026-10-19"], { g: 0, w: 0 });
    assert.deepEqual(repo.days[TODAY], { g: 4, w: 3 });
  });

  test("adding a 51st repo evicts the least recently active and retains 14 local days", () => {
    const env = box("prune");
    const oldest = "local/least-recent";
    const recentlySaid = "local/recently-said";
    const peers = Object.fromEntries(
      Array.from({ length: 48 }, (_, i) => [
        `local/project-${i}`,
        { saidAt: null, days: { "2026-10-20": { g: 1, w: 0 } } },
      ]),
    );
    seedRepos(env, {
      [oldest]: { saidAt: null, days: { "2026-10-10": { g: 1, w: 0 } } },
      [recentlySaid]: {
        saidAt: "2026-10-21",
        days: {
          "2026-10-08": { g: 3, w: 0 },
          "2026-10-09": { g: 1, w: 0 },
        },
      },
      ...peers,
    });

    noteValue(SHOP, { wallFixes: 1 }, env, NOW);

    const repos = savedRepos(env);
    assert.equal(Object.keys(repos).length, 50);
    assert.equal(Object.hasOwn(repos, oldest), false);
    assert.deepEqual(repos[recentlySaid], {
      saidAt: "2026-10-21",
      days: { "2026-10-09": { g: 1, w: 0 } },
    });
    assert.deepEqual(repos[SHOP]?.days[TODAY], { g: 0, w: 1 });
  });

  test("a busy lock drops a count and refuses a mark; a later mark succeeds", () => {
    const env = box("busy");
    noteValue(SHOP, { guardrailStops: 1 }, env, NOW);
    const path = valuePath(env);
    const original = readFileSync(path, "utf8");

    const held = withLock(path, () => {
      noteValue(SHOP, { guardrailStops: 4 }, env, NOW);
      assert.equal(markValueSaid(SHOP, env, NOW), false);
      assert.equal(readFileSync(path, "utf8"), original);
    }, VALUE_LOCK_MS);
    assert.equal(held.ok, true, "the outer lock was acquired");

    assert.equal(markValueSaid(SHOP, env, NOW), true);
    assert.deepEqual(savedRepos(env)[SHOP], {
      saidAt: TODAY,
      days: { [TODAY]: { g: 1, w: 0 } },
    });
  });

  test("neither a Stop nor a weekly mark writes through a linked state folder", () => {
    const env = box("linked-state");
    assert.ok(scratch);
    const target = mkdtempSync(join(scratch, "link-target-"));
    const path = valuePath(env);
    const state = dirname(path);
    const targetFile = join(target, basename(path));
    const original = JSON.stringify({ v: 1, repos: {} });
    writeFileSync(targetFile, original, "utf8");
    mkdirSync(dirname(state), { recursive: true });
    symlinkSync(target, state, process.platform === "win32" ? "junction" : "dir");

    noteValue(SHOP, { wallFixes: 1 }, env, NOW);
    assert.equal(markValueSaid(SHOP, env, NOW), false);
    assert.equal(readFileSync(targetFile, "utf8"), original);
  });

  test("a file in place of the state directory prevents a mark without replacing the file", () => {
    const env = box("blocked-state");
    const state = dirname(valuePath(env));
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, "keep this file", "utf8");

    assert.equal(markValueSaid(SHOP, env, NOW), false);
    assert.equal(readFileSync(state, "utf8"), "keep this file");
  });
});
