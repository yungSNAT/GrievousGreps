/**
 * Gap tests for src/trace/wall-state.ts: readWalls refusing files that are not small plain files, dropping entries
 * of the wrong shape (seen, fixed, lessons, worked, read), cleaning a class that is not an object, capping lesson
 * ids, and noteWalls persisting only well-shaped entries.
 */
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readWalls, noteWalls, wallsPath, lessonWorkedEpochs, wallDays } from "../src/trace/wall-state.js";
import { WALL_CLASSES } from "../src/notes/learning-fields.js";
import type { WallClass } from "../src/trace/types.js";

void mock;

const dirs: string[] = [];
const CLS = WALL_CLASSES[0] as WallClass;
const CLS2 = (WALL_CLASSES[1] ?? WALL_CLASSES[0]) as WallClass;

function makeEnv(tag: string): NodeJS.ProcessEnv {
  const d = mkdtempSync(join(tmpdir(), `walls-${tag}-`));
  dirs.push(d);
  return { ...process.env, TRAIL_HOME: d };
}

function writeWalls(env: NodeJS.ProcessEnv, text: string): string {
  const p = wallsPath(env);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}

const SEEN = { d: "2024-03-01", sh: "0123456789ab", epoch: 3, repo: "github.com/acme/cli", program: "npm" };
const DELTA = [{ kind: "env", name: "NODE_ENV" }];

function validFile(): Record<string, unknown> {
  return {
    v: 1,
    read: { "0123456789ab": "1024:1700000000000.5" },
    classes: { [CLS]: { seen: [SEEN], fixed: [], lessons: {} } },
  };
}

describe("wall-state gaps", () => {
  before(() => {
    process.env.TZ = process.env.TZ ?? process.env.TZ;
  });

  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("wallsPath names walls.json", () => {
    const env = makeEnv("path");
    assert.ok(wallsPath(env).endsWith("walls.json"));
  });

  test("a small valid file is read; the same content padded past 512 KB is refused", () => {
    const env = makeEnv("big");
    const text = JSON.stringify(validFile());
    writeWalls(env, text);
    const ok = readWalls(env);
    assert.equal(ok.read["0123456789ab"], "1024:1700000000000.5");
    assert.deepEqual(ok.classes[CLS]?.seen, [SEEN]);

    const p = writeWalls(env, text + " ".repeat(600 * 1024));
    assert.ok(statSync(p).size > 512 * 1024);
    assert.deepEqual(readWalls(env), { v: 1, read: {}, classes: {} });
  });

  test("a directory where walls.json should be reads as empty", () => {
    const env = makeEnv("dir");
    const p = wallsPath(env);
    mkdirSync(p, { recursive: true });
    assert.deepEqual(readWalls(env), { v: 1, read: {}, classes: {} });
  });

  test("bad JSON, a wrong version or a missing read map read as empty", () => {
    const env = makeEnv("bad");
    writeWalls(env, "{not json");
    assert.deepEqual(readWalls(env), { v: 1, read: {}, classes: {} });
    writeWalls(env, JSON.stringify({ ...validFile(), v: 2 }));
    assert.deepEqual(readWalls(env), { v: 1, read: {}, classes: {} });
    writeWalls(env, JSON.stringify({ v: 1, read: [], classes: {} }));
    assert.deepEqual(readWalls(env), { v: 1, read: {}, classes: {} });
  });

  test("entries of the wrong shape are dropped and a non-object class is cleaned to empty", () => {
    const env = makeEnv("shape");
    const goodWorked = { sh: "abcdefabcdef", epoch: 1, d: "2024-02-29" };
    const file = {
      v: 1,
      read: {
        "0123456789ab": "10:20",
        "XYZ": "10:20",
        "aaaaaaaaaaaa": "text",
        "bbbbbbbbbbbb": 5,
      },
      classes: {
        [CLS]: {
          seen: [
            SEEN,
            { ...SEEN, d: "2024-02-31" },
            { ...SEEN, d: "yesterday" },
            { ...SEEN, sh: "0123456789AB" },
            { ...SEEN, sh: 12 },
            { ...SEEN, epoch: -1 },
            { ...SEEN, epoch: 1.5 },
            { ...SEEN, repo: "GitHub.com/Acme" },
            { ...SEEN, repo: "a".repeat(201) },
            { ...SEEN, repo: 7 },
            { ...SEEN, program: "npm install" },
            { ...SEEN, program: null },
            "not an object",
            null,
            { ...SEEN, d: "2024-01-15", sh: "111111111111" },
          ],
          fixed: [
            { ...SEEN, delta: DELTA },
            { ...SEEN, delta: [] },
            { ...SEEN, delta: [{ kind: "shell", name: "x" }] },
            { ...SEEN, delta: [{ kind: "flag", name: "rm -rf /" }] },
            { ...SEEN, delta: Array.from({ length: 9 }, () => ({ kind: "flag", name: "--force" })) },
            { ...SEEN, delta: "env" },
            { ...SEEN, sh: "nope", delta: DELTA },
            { ...SEEN, sh: "222222222222", delta: [{ kind: "flag", name: "--force" }, { kind: "wrapper", name: "sudo" }] },
          ],
          lessons: {
            "l-abcdef": { worked: [goodWorked, { ...goodWorked, sh: "short" }, { ...goodWorked, epoch: 1e6 }, { ...goodWorked, d: "2024-13-01" }, "x", null] },
            "bad-id": { worked: [goodWorked] },
            "l-123456": "not an object",
            "ls-1234567": { worked: "nope" },
          },
        },
        [CLS2]: CLS2 === CLS ? undefined : ["an", "array"],
        "not-a-class": { seen: [SEEN] },
      },
    };
    writeWalls(env, JSON.stringify(file));
    const w = readWalls(env);

    assert.deepEqual(w.read, { "0123456789ab": "10:20" });
    assert.deepEqual(Object.keys(w.classes).includes("not-a-class"), false);

    const c = w.classes[CLS]!;
    assert.deepEqual(c.seen, [{ ...SEEN, d: "2024-01-15", sh: "111111111111" }, SEEN], "valid only, oldest first");
    assert.equal(c.fixed.length, 2);
    assert.deepEqual(c.fixed[0], { ...SEEN, delta: DELTA });
    assert.deepEqual(c.fixed[1]!.delta, [{ kind: "flag", name: "--force" }, { kind: "wrapper", name: "sudo" }]);
    assert.deepEqual(Object.keys(c.lessons), ["l-abcdef"]);
    assert.deepEqual(c.lessons["l-abcdef"], { worked: [goodWorked] });

    if (CLS2 !== CLS) assert.deepEqual(w.classes[CLS2], { seen: [], fixed: [], lessons: {} });

    assert.equal(lessonWorkedEpochs(w, CLS, "l-abcdef", new Date(2024, 5, 1)), 1);
    assert.deepEqual(wallDays(w, CLS, new Date(2024, 5, 1)), ["2024-01-15", "2024-03-01"]);
  });

  test("more than 60 lesson ids keeps the 60 that worked most recently", () => {
    const env = makeEnv("cap");
    const lessons: Record<string, unknown> = {};
    const ids: string[] = [];
    for (let i = 0; i < 61; i++) {
      const id = `l-${(0x100000 + i).toString(16)}`;
      ids.push(id);
      const d = i === 5 ? "2023-01-01" : new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
      lessons[id] = { worked: [{ sh: "abcdefabcdef", epoch: i, d }] };
    }
    writeWalls(env, JSON.stringify({ v: 1, read: {}, classes: { [CLS]: { seen: [], fixed: [], lessons } } }));
    const got = readWalls(env).classes[CLS]!.lessons;
    assert.equal(Object.keys(got).length, 60);
    assert.equal(ids[5]! in got, false, "the oldest-working lesson is dropped");
    assert.ok(ids[0]! in got);
    assert.ok(ids[60]! in got);
  });

  test("noteWalls writes only well-shaped seen, fixed, worked and read entries", () => {
    const env = makeEnv("note");
    noteWalls({
      seen: [
        { cls: CLS, ...SEEN, program: "npm install" },
        { cls: CLS, ...SEEN, sh: "BADBADBADBAD" },
        { cls: "nope" as WallClass, ...SEEN },
      ],
      fixed: [
        { cls: CLS, ...SEEN, delta: [{ kind: "wrapper", name: "sudo -E" }] },
        { cls: CLS, ...SEEN, epoch: -4, delta: [{ kind: "env", name: "X" }] },
      ],
      worked: [
        { cls: CLS, lessonId: "l-abcdef", sh: "abcdefabcdef", epoch: 2, d: "2024-03-02" },
        { cls: CLS, lessonId: "l-abcdef", sh: "abcdefabcdef", epoch: 2, d: "2024-03-02" },
        { cls: CLS, lessonId: "l-abcdef", sh: "nothex", epoch: 3, d: "2024-03-02" },
        { cls: CLS, lessonId: "l-abcdef", sh: "abcdefabcdef", epoch: 4, d: "2024-02-30" },
        { cls: CLS, lessonId: "lesson-1", sh: "abcdefabcdef", epoch: 5, d: "2024-03-02" },
      ],
      read: { "0123456789ab": "1:2", "short": "1:2", "cccccccccccc": "free text" },
    }, env);
    assert.ok(existsSync(wallsPath(env)));
    const w = readWalls(env);
    const c = w.classes[CLS]!;
    assert.deepEqual(c.seen, [SEEN], "program keyed to its first word");
    assert.deepEqual(c.fixed, [{ ...SEEN, delta: [{ kind: "wrapper", name: "sudo" }] }]);
    assert.deepEqual(c.lessons, { "l-abcdef": { worked: [{ sh: "abcdefabcdef", epoch: 2, d: "2024-03-02" }] } });
    assert.deepEqual(w.read, { "0123456789ab": "1:2" });
    assert.deepEqual(Object.keys(w.classes), [CLS]);
  });

  test("noteWalls with nothing valid leaves no class behind", () => {
    const env = makeEnv("none");
    noteWalls({ seen: [{ cls: CLS, ...SEEN, d: "2024-02-30" }], worked: [{ cls: CLS, lessonId: "l-abcdef", sh: "x", epoch: 0, d: "2024-01-01" }] }, env);
    assert.deepEqual(readWalls(env), { v: 1, read: {}, classes: {} });
  });
});
