import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative, sep } from "node:path";
import {
  forgetLearning,
  initDraftCommand,
  lessonCommand,
} from "../src/skills/cli-skills-1b.js";
import { everyRepoDir, writeEveryRepo } from "../src/notes/every-repo.js";
import { guardrailLearning } from "../src/notes/guardrails.js";
import { repoPlace } from "../src/notes/home.js";
import { parseNote } from "../src/notes/notes.js";
import { repoNotesDir } from "../src/notes/repo-notes-dir.js";
import { keepLessonCli } from "../src/skills/lesson-gate.js";
import { skillsDir } from "../src/skills/store-fs.js";
import { WALLS } from "../src/trace/walls.js";
import { tmpRepo } from "./helpers.js";

const NOW = new Date("2026-10-17T10:00:00Z");
const guard = () =>
  guardrailLearning("timeout-missing", "every repo", '"timeout: command not found" on 6 days', NOW);

describe("phase 1b CLI commands", () => {
  let scratch: string;
  let restoreFetch: (() => void) | undefined;

  before(() => {
    scratch = tmpRepo("cli-skills-1b-gaps");
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("These CLI commands should not make HTTP requests");
    });
    restoreFetch = () => fetchMock.mock.restore();
  });

  after(() => {
    try {
      restoreFetch?.();
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  });

  function workspace(name: string) {
    const root = join(scratch, name);
    const cwd = join(root, "work");
    const home = join(root, "home");
    const trailHome = join(home, ".trail");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(trailHome, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TRAIL_HOME: trailHome,
    };
    return { cwd, trailHome, env };
  }

  function checkout(name: string) {
    const w = workspace(name);
    const opts = { cwd: w.cwd, env: w.env, stdio: "pipe" as const };
    execFileSync("git", ["init", "--quiet"], opts);
    // This URL supplies an identity; Git never contacts it.
    execFileSync("git", ["remote", "add", "origin", `https://example.invalid/trail/${name}.git`], opts);
    const { key } = repoPlace(w.cwd, w.env);
    assert.ok(key, "the checkout has a repository key");
    return { ...w, key };
  }

  test("lesson reports a missing offer as a single held line", () => {
    const { env } = workspace("no-offers");
    const offer = "missing-offer";
    const held = keepLessonCli(null, offer, env, NOW);
    assert.equal(held.code, 1);
    assert.ok(held.line.trim(), "the lesson gate explains why nothing was saved");
    assert.deepEqual(lessonCommand(null, offer, env, NOW), {
      code: 1,
      lines: [held.line],
    });
    assert.equal(existsSync(skillsDir(env)), false);
  });

  test("draft print reports a missing pending item in a fresh checkout", () => {
    const { cwd, env } = checkout("init-draft");
    assert.deepEqual(initDraftCommand(99, cwd, env, NOW), {
      code: 1,
      lines: ["✗ no item 99 waits for an answer in this repo · look back again: trail init --look-back"],
    });
  });

  test("forget by guardrail name recognizes the catalog title even after the file is renamed", () => {
    const { cwd, env, trailHome } = workspace("renamed-guardrail");
    const template = WALLS.find((wall) => wall.guardrail?.fileName === "no-timeout.md")?.guardrail;
    assert.ok(template);
    const path = writeEveryRepo({ ...guard(), title: template.title }, "my-portability-rule.md", env);
    const active = parseNote(readFileSync(path, "utf8"), path);
    assert.ok(active?.id);
    assert.equal(active.status, "active");

    const out = forgetLearning("no-timeout", cwd, env);
    assert.equal(out?.code, 0);
    assert.match(out.lines[0]!, /always-follow learning forgotten/);
    assert.deepEqual(out.dropped, {
      what: "guardrail",
      name: "my-portability-rule",
      back: `change status: retired to status: active in ${relative(trailHome, path).split(sep).join("/")} under your Trail home`,
    });

    const retired = readFileSync(path, "utf8");
    const note = parseNote(retired, path);
    assert.equal(note?.status, "retired");
    assert.equal(note?.id, active.id);
    assert.equal(note?.title, active.title);
    assert.equal(forgetLearning("no-timeout", cwd, env), null, "the name only finds kept guardrails");
    const again = forgetLearning(active.id, cwd, env);
    assert.equal(again?.code, 0);
    assert.match(again.lines[0]!, /was already forgotten/);
    assert.equal(again.dropped, undefined);
    assert.equal(readFileSync(path, "utf8"), retired);
  });

  test("forget by id searches the current repo's personal notes as well as every-repo notes", () => {
    const { cwd, env, key } = checkout("repo-learning");
    const original = writeEveryRepo(guard(), "no-timeout.md", env);
    const text = readFileSync(original, "utf8");
    const note = parseNote(text, original);
    assert.ok(note?.id);

    const dir = repoNotesDir(key, env);
    mkdirSync(dir, { recursive: true });
    const local = join(dir, "no-timeout.md");
    renameSync(original, local);

    const out = forgetLearning(note.id, cwd, env);
    assert.equal(out?.code, 0);
    assert.match(out.lines[0]!, /file stays, marked retired/);
    assert.equal(parseNote(readFileSync(local, "utf8"), local)?.status, "retired");
    assert.deepEqual(readdirSync(everyRepoDir(env)), []);
  });

  test("forget by id ignores oversized notes, non-Markdown files, and Markdown-named directories", () => {
    const { cwd, env } = workspace("ignored-learnings");
    const path = writeEveryRepo(guard(), "no-timeout.md", env);
    const text = readFileSync(path, "utf8");
    const note = parseNote(text, path);
    assert.ok(note?.id);

    const dir = everyRepoDir(env);
    const oversized = `${text}\n${"x".repeat(64 * 1024)}\n`;
    writeFileSync(path, oversized);
    const backup = join(dir, "backup.txt");
    writeFileSync(backup, text);
    mkdirSync(join(dir, "directory.md"));

    assert.deepEqual(forgetLearning(note.id, cwd, env), {
      code: 1,
      lines: [`✗ no learning called ${note.id} here`],
    });
    assert.equal(readFileSync(path, "utf8"), oversized);
    assert.equal(readFileSync(backup, "utf8"), text);
  });

  test("forget reports no match if the learning disappears between stat and read", () => {
    const { cwd, env } = workspace("vanishing-learning");
    const file = "no-timeout.md";
    const path = writeEveryRepo(guard(), file, env);
    const note = parseNote(readFileSync(path, "utf8"), path);
    assert.ok(note?.id);

    const listedPath = join(everyRepoDir(env), file);
    const readFile = fs.readFileSync;
    const read = mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === listedPath) unlinkSync(listedPath);
      return readFile(...args);
    });

    try {
      syncBuiltinESMExports();
      assert.deepEqual(forgetLearning(note.id, cwd, env), {
        code: 1,
        lines: [`✗ no learning called ${note.id} here`],
      });
    } finally {
      read.mock.restore();
      syncBuiltinESMExports();
    }

    assert.deepEqual(readdirSync(everyRepoDir(env)), [], "forget did not recreate the file");
  });

  test("forget moves only the matching skill lesson and reports how to restore it", () => {
    const { cwd, env } = workspace("skill-lesson");
    const skill = "review-changes";
    const dir = join(skillsDir(env), skill, "lessons");
    mkdirSync(dir, { recursive: true });
    const id = "ls-ab12cd";
    const file = "review-scope.md";
    const saved = `---\nid: "${id}"\n---\nCheck the scope of the changes first.\n`;
    const other = "---\nid: ls-abcdef\n---\nLook for missing tests.\n";
    writeFileSync(join(dir, file), saved);
    writeFileSync(join(dir, "other.md"), other);

    assert.deepEqual(forgetLearning(id, cwd, env), {
      code: 0,
      lines: [`✓ learning ${id} forgotten · it no longer rides with ${skill}`],
      dropped: {
        what: "lesson",
        name: id,
        back: `in your Trail home, move skills/${skill}/lessons/.forgotten/${file} up one folder`,
      },
    });
    assert.equal(existsSync(join(dir, file)), false);
    assert.equal(readFileSync(join(dir, ".forgotten", file), "utf8"), saved);
    assert.equal(readFileSync(join(dir, "other.md"), "utf8"), other);
    assert.deepEqual(forgetLearning(id, cwd, env), {
      code: 1,
      lines: [`✗ no learning called ${id}`],
    });
    assert.equal(forgetLearning(skill, cwd, env), null, "a skill name is left for the caller");
  });
});
