import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { keepItems, prefLine, prefTitle, type KeepPlace } from "../src/init/keep.js";
import { readInitRecord, updateInitRecord } from "../src/init/init-record.js";
import { dayWords } from "../src/init/review-screen.js";
import type { InitItem } from "../src/init/types.js";
import { guardrailLearning } from "../src/notes/guardrails.js";
import { repoPlace } from "../src/notes/home.js";
import { newLearningId } from "../src/notes/learning-fields.js";
import { trailHome } from "../src/notes/trail-home.js";
import { recordInitClosed } from "../src/skills/offers.js";
import { WALLS } from "../src/trace/walls.js";
import { tmpRepo } from "./helpers.js";

const now = new Date(2025, 3, 18, 12);
const first = "2025-01-09";
const last = "2025-01-23";
const allReposWall = WALLS.find((wall) =>
  wall.guardrail && guardrailLearning(wall.cls, "every repo", "", now).applies === "every repo"
)!;

function suggestion(kind: InitItem["kind"], n: number, extra: Partial<InitItem> = {}): InitItem {
  const id = `${kind[0]}-${n.toString(16).padStart(12, "0")}`;
  return {
    id, n, kind, key: `${kind}:${id}`,
    plainName: `${kind} ${n}`, title: `${kind} ${n}`, description: "",
    nameWords: [kind, String(n)], applies: "every repo", scope: "personal",
    count: { days: 1, from: first, to: first },
    ...extra,
  } as InitItem;
}

function guardrail(n: number, extra: Partial<InitItem> = {}, wall = allReposWall): InitItem {
  return suggestion("guardrail", n, {
    key: `guardrail:${wall.cls}`,
    plainName: wall.words,
    guardrail: { cls: wall.cls },
    ...extra,
  });
}

function localGuardrail(n: number, repoKey: string, extra: Partial<InitItem> = {}): InitItem {
  // The catalog can make a guardrail apply everywhere even when given a repo key.
  const wall = WALLS.find((entry) =>
    entry.guardrail && guardrailLearning(entry.cls, repoKey, "", now).applies !== "every repo"
  );
  assert.ok(wall, "the catalog has a guardrail that can be kept for one repo");
  return guardrail(n, { ...extra, applies: repoKey }, wall);
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  });
}

function markdownUnder(dir: string): string[] {
  return filesUnder(dir).filter((path) => path.endsWith(".md"));
}

function onlyMarkdown(dir: string): string {
  const paths = markdownUnder(dir);
  assert.equal(paths.length, 1, `expected one learning under ${dir}`);
  return paths[0]!;
}

const homeKeys = [
  "HOME", "USERPROFILE", "TRAIL_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "XDG_STATE_HOME", "XDG_CACHE_HOME",
] as const;

// Repo-personal writes resolve the home from process.env, not the passed env.
function withHome<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const previous = homeKeys.map((key) => process.env[key]);
  for (const key of homeKeys) process.env[key] = env[key]!;
  try {
    return fn();
  } finally {
    for (const [i, key] of homeKeys.entries()) {
      const value = previous[i];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function persistedInitRecord(env: NodeJS.ProcessEnv): ReturnType<typeof readInitRecord> {
  // Assert what keep wrote for the in-memory suggestions, before the record
  // reader validates IDs for use in a subsequent init.
  const records = filesUnder(env.HOME!).filter((path) => path.endsWith(".json")).flatMap((path) => {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return [];
    }
    if (!value || typeof value !== "object" || !("closed" in value)
      || !("pendingFrom" in value) || !("deferred" in value)) return [];
    return [value as ReturnType<typeof readInitRecord>];
  });
  assert.equal(records.length, 1, "one init record was written");
  return records[0]!;
}

describe("init keep: write and record gaps", () => {
  let root: string;
  let restoreFetch: () => void;

  before(() => {
    root = tmpRepo("init-keep-gaps");
    const fetch = mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
    restoreFetch = () => fetch.mock.restore();
  });

  after(() => {
    restoreFetch?.();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function scratchEnv(): NodeJS.ProcessEnv {
    const home = mkdtempSync(join(root, "home-"));
    const trail = join(home, "trail");
    mkdirSync(trail);
    return {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TRAIL_HOME: trail,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"),
    };
  }

  function checkout(env: NodeJS.ProcessEnv): KeepPlace {
    const dir = mkdtempSync(join(root, "checkout-"));
    for (const args of [
      ["init", "-q"],
      ["remote", "add", "origin", `https://example.invalid/keep-tests/${basename(dir)}.git`],
    ]) {
      const git = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
      if (git.error) throw git.error;
      assert.equal(git.status, 0, git.stderr);
    }
    const repoKey = repoPlace(dir, env).key;
    assert.ok(repoKey, "the checkout has a repo key");
    return { dir, repoKey };
  }

  test("default keep context saves an every-repo guardrail with its original date", () => {
    const env = scratchEnv();
    const picked = guardrail(1);
    const result = withHome(env, () => keepItems([picked], [picked], "yes"));
    assert.deepEqual(result, { kept: [picked], notKept: [], refused: [] });

    const path = onlyMarkdown(join(trailHome(env), "learnings"));
    const note = readFileSync(path, "utf8");
    assert.match(note, /^date:[ \t]*['"]?2025-01-09['"]?[ \t]*\r?$/m);
    assert.ok(note.replace(/\s+/g, " ").includes(`on 1 days, ${dayWords(first)}`));
  });

  test("TTY keeps accumulate undo entries until shown, including a repo-personal write", () => {
    const env = scratchEnv();
    const place = checkout(env);
    const global = guardrail(1, { count: { days: 2, from: first, to: last } });
    const local = localGuardrail(2, place.repoKey, {
      count: { days: 1, from: "", to: "" },
    });

    assert.deepEqual(keepItems([global], [global], "tty", env, now, place), {
      kept: [global], notKept: [], refused: [],
    });
    const shared = join(trailHome(env), "learnings");
    const path = onlyMarkdown(shared);
    const sharedNote = readFileSync(path, "utf8");
    assert.ok(sharedNote.replace(/\s+/g, " ").includes(`on 2 days, ${dayWords(first)} to ${dayWords(last)}`));

    const firstNotice = readInitRecord(place.repoKey, env).notice;
    assert.deepEqual(firstNotice, {
      run: "ir-0000",
      at: now.toISOString(),
      shownAt: null,
      items: [{
        kind: "guardrail", name: global.plainName,
        id: newLearningId(basename(path)), forget: global.plainName,
      }],
    });

    const beforeWrite = new Set([...markdownUnder(env.HOME!), ...markdownUnder(place.dir)]);
    const runId = "ir-0017";
    const result = withHome(env, () => keepItems([local], [local], "tty", env, now, { ...place, runId }));
    assert.deepEqual(result, { kept: [local], notKept: [], refused: [] });

    // Count dated learnings, not all Markdown created alongside the note.
    const newLearnings = [...markdownUnder(env.HOME!), ...markdownUnder(place.dir)]
      .filter((candidate) => !beforeWrite.has(candidate))
      .map((candidate) => readFileSync(candidate, "utf8"))
      .filter((text) => /^date:/m.test(text));
    assert.equal(newLearnings.length, 1, "the repo-personal keep added one dated learning");
    assert.match(newLearnings[0]!, /^date:[ \t]*['"]?2025-04-18['"]?[ \t]*\r?$/m);
    assert.equal(onlyMarkdown(shared), path, "the local keep did not add an every-repo learning");
    assert.equal(readFileSync(path, "utf8"), sharedNote, "the local keep did not change the shared learning");

    const notice = readInitRecord(place.repoKey, env).notice;
    assert.equal(notice?.run, runId);
    assert.equal(notice?.shownAt, null);
    assert.equal(notice?.items.length, 2);
    assert.deepEqual(notice?.items[0], firstNotice?.items[0]);
    assert.equal(notice?.items[1]?.kind, "guardrail");
    assert.equal(notice?.items[1]?.forget, local.plainName);
    assert.ok(notice?.items[1]?.id);
    assert.notEqual(notice?.items[1]?.id, firstNotice?.items[0]?.id);
  });

  test("yes writes the selected guardrail without closing the unselected skill", () => {
    const env = scratchEnv();
    const place = checkout(env);
    const accepted = guardrail(1);
    const waiting = suggestion("skill", 2, { applies: place.repoKey });

    assert.deepEqual(keepItems([accepted], [accepted, waiting], "yes", env, now, place), {
      kept: [accepted], notKept: [waiting], refused: [],
    });
    const note = readFileSync(onlyMarkdown(join(trailHome(env), "learnings")), "utf8");
    assert.match(note, /^date:[ \t]*['"]?2025-01-09['"]?[ \t]*\r?$/m);
    const record = persistedInitRecord(env);
    assert.deepEqual(record.closed, []);
    assert.equal(record.notice, null);
  });

  test("unavailable items are refused, not counted as declined or given undo entries", () => {
    const env = scratchEnv();
    const place = { ...checkout(env), reviews: new Map() };
    const missingSkill = suggestion("skill", 1);
    const uncompiled = suggestion("skill", 2, {
      skill: {} as NonNullable<InitItem["skill"]>,
    });
    const missingGuardrail = suggestion("guardrail", 3);
    const personalPref = suggestion("preference", 4, { applies: place.repoKey });
    const repoPref = suggestion("preference", 5, { applies: place.repoKey, scope: "repo" });
    const globalPref = suggestion("preference", 6, {
      pref: { refs: [] } as NonNullable<InitItem["pref"]>,
    });
    const review = suggestion("review" as InitItem["kind"], 7);
    const declined = guardrail(8);
    const picked = [missingGuardrail, personalPref, missingSkill, repoPref, globalPref, uncompiled, review];

    assert.equal(prefLine(personalPref, env), null);
    assert.equal(prefLine(globalPref, env), null);

    assert.deepEqual(keepItems(picked, [...picked, declined], "tty", env, now, place), {
      kept: [],
      notKept: [declined],
      refused: [missingSkill, uncompiled, missingGuardrail, personalPref, repoPref, globalPref, review]
        .map((item) => ({ item, why: "gone" })),
    });
    const record = persistedInitRecord(env);
    assert.deepEqual(record.closed, [declined.id]);
    assert.equal(record.notice, null);
    assert.deepEqual([...markdownUnder(env.HOME!), ...markdownUnder(place.dir)], []);
  });

  test("a repo-personal guardrail cannot be written into a different process home", () => {
    const env = scratchEnv();
    const processHome = scratchEnv();
    const place = checkout(env);
    const local = localGuardrail(1, place.repoKey);

    assert.notEqual(trailHome(env), trailHome(processHome));
    assert.deepEqual(withHome(processHome, () => keepItems([local], [local], "tty", env, now, place)), {
      kept: [], notKept: [], refused: [{ item: local, why: "failed" }],
    });
    assert.deepEqual([...markdownUnder(env.HOME!), ...markdownUnder(processHome.HOME!), ...markdownUnder(place.dir)], []);
    const record = readInitRecord(place.repoKey, env);
    assert.deepEqual(record.closed, []);
    assert.equal(record.notice, null);
  });

  test("an obstructed learning directory refuses the write without replacing the obstruction", () => {
    const env = scratchEnv();
    const place = checkout(env);
    const blocked = join(trailHome(env), "learnings");
    mkdirSync(trailHome(env), { recursive: true });
    writeFileSync(blocked, "not a directory\n");
    const item = guardrail(1);

    assert.deepEqual(keepItems([item], [item], "tty", env, now, place), {
      kept: [], notKept: [], refused: [{ item, why: "failed" }],
    });
    assert.equal(readFileSync(blocked, "utf8"), "not a directory\n");
    const record = readInitRecord(place.repoKey, env);
    assert.deepEqual(record.closed, []);
    assert.equal(record.notice, null);
  });

  test("TTY still closes the declined skill if its offer history cannot be updated", () => {
    const env = scratchEnv();
    const place = checkout(env);
    const declined = suggestion("skill", 1, { applies: place.repoKey });
    recordInitClosed(place.repoKey, declined.key, env, now);

    // A directory in place of the offer-state file is a portable obstruction.
    const offerFiles = filesUnder(trailHome(env));
    assert.ok(offerFiles.length > 0, "closing a skill writes offer history");
    for (const path of offerFiles) {
      rmSync(path);
      mkdirSync(path);
    }

    updateInitRecord(place.repoKey, (record) => {
      record.pendingFrom = "ir-0019";
      record.deferred = [declined.id];
    }, env);
    assert.deepEqual(keepItems([], [declined], "tty", env, now, place), {
      kept: [], notKept: [declined], refused: [],
    });
    const record = persistedInitRecord(env);
    assert.deepEqual(record.closed, [declined.id]);
    assert.deepEqual(record.deferred, []);
    assert.equal(record.pendingFrom, null);
    assert.equal(record.notice, null);
    for (const path of offerFiles) assert.deepEqual(readdirSync(path), []);
  });

  test("preference titles recognize a tab at the cut and drop trailing punctuation", () => {
    const word = "x".repeat(117);
    assert.equal(prefTitle(`${word},;\tthen run the linter`), `${word}…`);
  });
});
