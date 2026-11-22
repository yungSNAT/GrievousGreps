/**
 * Gap tests for src/notes/memory-notes.ts: reading Claude Code's memory notes,
 * turning them into titles and bodies, picking team candidates, and finishing
 * a memory read (cancel, keep none, keep some).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finishMemoryRead,
  memoryBody,
  memoryCandidates,
  memoryDirs,
  memoryNotes,
  memoryTitle,
  offeredBefore,
  readMemoryNote,
  readsAsLearning,
  saveMemoryCandidates,
  type MemoryCandidate,
} from "../src/notes/memory-notes.js";
import { tmpRepo } from "./helpers.js";

const scratch: string[] = [];
const savedEnv = { TRAIL_HOME: process.env.TRAIL_HOME, DO_NOT_TRACK: process.env.DO_NOT_TRACK };

before(() => {
  const trailRoot = mkdtempSync(join(tmpdir(), "memnotes-trail-"));
  scratch.push(trailRoot);
  process.env.TRAIL_HOME = join(trailRoot, ".trail");
  process.env.DO_NOT_TRACK = "1";
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function scratchDir(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `memnotes-${tag}-`));
  scratch.push(d);
  return d;
}

function gitRepo(tag: string): string {
  const repo = tmpRepo(tag);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  return repo;
}

function note(front: Record<string, string>, body: string): string {
  const lines = Object.entries(front).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body}\n`;
}

describe("readMemoryNote", () => {
  test("the MEMORY.md index, a missing file, no frontmatter and an empty body are not notes", () => {
    const dir = scratchDir("read-null");
    writeFileSync(join(dir, "MEMORY.md"), note({ name: "index" }, "- [[a]]"));
    writeFileSync(join(dir, "plain.md"), "just text, no frontmatter\n");
    writeFileSync(join(dir, "empty.md"), "---\nname: empty\n---\n   \n");
    assert.equal(readMemoryNote(join(dir, "MEMORY.md")), null);
    assert.equal(readMemoryNote(join(dir, "missing.md")), null);
    assert.equal(readMemoryNote(join(dir, "plain.md")), null);
    assert.equal(readMemoryNote(join(dir, "empty.md")), null);
  });

  test("quoted fields are unquoted, a bad JSON escape kept as written, an unknown type is other", () => {
    const dir = scratchDir("read-fields");
    const path = join(dir, "quoted.md");
    writeFileSync(
      path,
      note(
        { name: '"Bad \\q escape"', description: "'Single quoted words'", type: "Something", modified: "2025-03-04T10:00:00Z" },
        "The body.",
      ),
    );
    const n = readMemoryNote(path);
    assert.ok(n);
    assert.equal(n.name, "Bad \\q escape");
    assert.equal(n.description, "Single quoted words");
    assert.equal(n.type, "other");
    assert.equal(n.updated, "2025-03-04");
    assert.equal(n.body, "The body.");
  });

  test("a note with no name takes its file name, a valid JSON string is decoded, no modified uses the file's date", () => {
    const dir = scratchDir("read-defaults");
    const path = join(dir, "build-steps.md");
    writeFileSync(path, note({ description: '"Run \\"npm test\\" first"', type: "Reference" }, "Body text"));
    const n = readMemoryNote(path);
    assert.ok(n);
    assert.equal(n.name, "build-steps");
    assert.equal(n.description, 'Run "npm test" first');
    assert.equal(n.type, "reference");
    assert.match(n.updated, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("memoryTitle", () => {
  test("a long name of words is cut at a word near 90 characters with an ellipsis", () => {
    const name = Array(30).fill("alpha").join(" ");
    const t = memoryTitle({ name, description: "" });
    assert.equal(t, "Alpha " + Array(13).fill("alpha").join(" ") + "…");
    assert.ok(t.length <= 90);
  });

  test("a slug name uses the description's first clause, else the slug as words", () => {
    assert.equal(memoryTitle({ name: "retry-limit", description: "Retries stay at 4. Because the gateway is slow." }), "Retries stay at 4");
    assert.equal(memoryTitle({ name: "deploy_steps", description: "" }), "Deploy steps");
    assert.equal(memoryTitle({ name: "x", description: "use pnpm; never npm" }), "Use pnpm");
  });
});

describe("memoryBody and readsAsLearning", () => {
  test("links become words, headings bold, How to apply goes under Watch out", () => {
    const out = memoryBody({ body: "# Retries\nSee [[gateway-notes]].\n\n**How to apply:** keep it at 4." });
    assert.match(out, /^## Decided\n\*\*Retries\*\*\nSee gateway-notes\./);
    assert.match(out, /\n\n## Watch out\nkeep it at 4\.$/);
  });

  test("a long body is clipped at a line break with an ellipsis", () => {
    const line = "This line explains one more detail about the build.";
    const body = Array(60).fill(line).join("\n");
    const out = memoryBody({ body });
    assert.ok(out.endsWith("\n…"));
    assert.ok(!out.includes("## Watch out"));
    assert.ok(out.length < body.length);
    assert.ok(out.split("\n").slice(1, -1).every((l) => l === line), "cut at a whole line");
  });

  test("status write-ups and long notes without a Why are not learnings", () => {
    assert.equal(readsAsLearning("**Status:** shipped"), false);
    assert.equal(readsAsLearning("Work is done but not merged yet."), false);
    const long = Array(200).fill("word").join(" ");
    assert.equal(readsAsLearning(long), false);
    assert.equal(readsAsLearning(`${long}\n**Why:** reasons`), true);
    assert.equal(readsAsLearning("Short fact."), true);
  });
});

describe("memoryNotes and memoryCandidates", () => {
  test("no memory folder means no notes", () => {
    const repo = gitRepo("memnotes-none");
    const home = scratchDir("home-none");
    assert.deepEqual(memoryNotes(repo, home), []);
    assert.deepEqual(memoryCandidates(repo, { home }), []);
  });

  test("only project/reference notes tied to code, not secret, not repeated, are offered", () => {
    const repo = gitRepo("memnotes-cands");
    const home = scratchDir("home-cands");
    writeFileSync(join(repo, "retry.ts"), "export const MAX = 4;\n");
    const dirs = memoryDirs(repo, home);
    assert.ok(dirs.length >= 1);
    const dir = dirs[0]!;
    assert.ok(dir.endsWith("memory"));
    mkdirSync(dir, { recursive: true });
    const desc = "Retries in retry.ts stay at 4 because the gateway times out";
    writeFileSync(
      join(dir, "retry.md"),
      note({ name: "retry-limit", description: desc, type: "project", modified: "2026-01-05" }, "Retries stay at 4.\n\n**Why:** the gateway times out after 30 seconds."),
    );
    writeFileSync(join(dir, "dup.md"), note({ name: "retry-dup", description: desc, type: "project", modified: "2026-01-01" }, "Same as retry.ts."));
    writeFileSync(join(dir, "feedback.md"), note({ name: "fb", description: "Keep retry.ts small", type: "feedback", modified: "2026-01-04" }, "Small please."));
    writeFileSync(join(dir, "user.md"), note({ name: "me", description: "Likes tea", type: "user", modified: "2026-01-04" }, "Tea."));
    writeFileSync(join(dir, "status.md"), note({ name: "st", description: "retry.ts work", type: "project", modified: "2026-01-03" }, "**Status** shipped retry.ts"));
    writeFileSync(
      join(dir, "secret.md"),
      note({ name: "sec", description: "Where retry.ts gets keys", type: "reference", modified: "2026-01-02" }, "retry.ts reads AWS_SECRET_ACCESS_KEY from the env."),
    );
    writeFileSync(join(dir, "nocode.md"), note({ name: "pr-size", description: "The team prefers tiny pull requests", type: "project", modified: "2026-01-02" }, "Tiny ones."));
    writeFileSync(join(dir, "MEMORY.md"), "- [[retry-limit]]\n");

    const notes = memoryNotes(repo, home);
    assert.equal(notes.length, 7);
    assert.equal(notes[0]!.name, "retry-limit", "newest first");
    assert.equal(notes.at(-1)!.name, "retry-dup");

    const cands = memoryCandidates(repo, { home });
    assert.equal(cands.length, 1);
    const c = cands[0]!;
    assert.equal(c.title, desc);
    assert.equal(c.forTeam, true);
    assert.deepEqual(c.touches, ["retry.ts"]);
    assert.equal(c.path, join(dir, "retry.md"));
    assert.equal(c.updated, "2026-01-05");
    assert.match(c.body, /\*\*Why:\*\* the gateway times out/);

    const offered = new Set([`${c.path}@${c.updated}`]);
    const again = memoryCandidates(repo, { home, offered });
    assert.ok(!again.some((x) => x.path === c.path), "an offered, unchanged note isn't offered again");
  });
});

describe("saving and finishing a memory read", () => {
  const team = (repo: string): MemoryCandidate => ({
    title: "Retries stay at four",
    body: "## Decided\nRetries stay at 4.",
    forTeam: true,
    touches: [],
    path: join(repo, "mem", "team.md"),
    updated: "2026-01-05",
  });
  const personal = (repo: string): MemoryCandidate => ({
    title: "Prefer small diffs",
    body: "## Decided\nKeep diffs small.",
    forTeam: false,
    touches: [],
    path: join(repo, "mem", "mine.md"),
    updated: "2026-01-06",
  });

  test("a team candidate is saved in the repo with where it came from", () => {
    const repo = gitRepo("memnotes-save");
    const [n] = saveMemoryCandidates(repo, [team(repo)], "Tester", "2026-02-01");
    assert.ok(n);
    assert.ok(n.path.startsWith(join(repo, ".trail")));
    const text = readFileSync(n.path, "utf8");
    assert.match(text, /From Claude Code's memory of this repo, last updated/);
    assert.match(text, /Retries stay at 4\./);
  });

  test("cancelling saves and marks nothing", async () => {
    const repo = gitRepo("memnotes-cancel");
    const res = await finishMemoryRead(repo, [team(repo)], async () => null);
    assert.equal(res.cancelled, true);
    assert.deepEqual(res.saved, []);
    assert.deepEqual(res.kept, []);
    assert.equal(offeredBefore(repo).size, 0);
  });

  test("keeping none still marks every candidate offered", async () => {
    const repo = gitRepo("memnotes-none-kept");
    const cands = [team(repo), personal(repo)];
    const res = await finishMemoryRead(repo, cands, async () => []);
    assert.equal(res.cancelled, false);
    assert.deepEqual(res.saved, []);
    const offered = offeredBefore(repo);
    assert.ok(offered.has(`${cands[0]!.path}@2026-01-05`));
    assert.ok(offered.has(`${cands[1]!.path}@2026-01-06`));
  });

  test("with no screen only team candidates are kept; no candidates writes no mark", async () => {
    const repo = gitRepo("memnotes-auto");
    const res = await finishMemoryRead(repo, [personal(repo), team(repo)]);
    assert.deepEqual(res.kept.map((c) => c.title), ["Retries stay at four"]);
    assert.equal(res.saved.length, 1);
    assert.ok(existsSync(res.saved[0]!.path));

    const empty = gitRepo("memnotes-empty");
    const none = await finishMemoryRead(empty, [], async () => {
      throw new Error("keep must not be asked with no candidates");
    });
    assert.equal(none.cancelled, false);
    assert.deepEqual(none.saved, []);
    assert.equal(offeredBefore(empty).size, 0);
  });
});
