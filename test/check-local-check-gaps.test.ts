import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import {
  addedText,
  checkLocally,
  inHunk,
  parseTrailDiff,
  selectTrailCheckCandidates,
  splitIdentifier,
  trailCheckFiles,
  trailDiffTerms,
  trailTerms,
} from "../src/check/local-check.js";
import { learningId } from "../src/notes/learning-fields.js";
import { listNotes, type Note } from "../src/notes/notes.js";
import type { Skill } from "../src/skills/skills.js";
import { tmpRepo } from "./helpers.js";

// Diff headers and learning touches use Git's repo-relative paths on all OSes.
const transport = posix.join("src", "transport");
const requestFile = posix.join(transport, "request.ts");
const now = new Date("2026-10-15T00:00:00Z");

function diffFor(file: string, ...lines: string[]): string {
  return [`--- a/${file}`, `+++ b/${file}`, ...lines].join("\n");
}

function note(slug: string, fields: Partial<Note> = {}): Note {
  const name = `2026-10-12-${slug}.md`;
  return {
    id: learningId(name),
    path: join(".trail", "learnings", name),
    title: slug,
    author: "Maya",
    date: "2026-10-12",
    scope: "repo",
    touches: [],
    body: "",
    ...fields,
  } as Note;
}

function skill(name: string, body: string, description = ""): Skill {
  return { name, body, description, takeaways: [] } as Skill;
}

test("identifier splitting handles acronyms, Unicode case boundaries, and empty underscore chunks", () => {
  assert.deepEqual(splitIdentifier("__déjàVu_HTTPServer_cacheID_XML__"), [
    "déjà", "Vu", "HTTP", "Server", "cache", "ID", "XML",
  ]);
  assert.deepEqual(splitIdentifier("___"), []);
});

test("terms keep useful identifier parts in first-seen order without repeating them", () => {
  const text = `being between them then was with func import HTTPServer max_retries
    retries cache2 p9 123 déjà ${"z".repeat(41)} httpServer`;
  assert.deepEqual(trailTerms(text), ["httpserver", "http", "server", "max", "retries", "cache2"]);
  assert.deepEqual(trailTerms(text, 2), ["httpserver", "http"]);
});

test("diff terms prioritize identifiers, then frequency, then first occurrence", () => {
  const added = ["latency latency latency bucket_name shard2", "shard2 bandwidth bandwidth"];
  assert.deepEqual(trailDiffTerms(added, 0), ["shard2", "bucket", "name", "latency", "bandwidth"]);
  assert.deepEqual(trailDiffTerms(added, 4), ["shard2", "bucket", "name", "latency"]);
});

test("diff parsing counts blank context and keeps header-like additions inside the hunk", () => {
  const deleted = posix.join(transport, "legacy.ts");
  const modeOnly = "build.ts";
  const diff = [
    `--- a/${requestFile}\t2026-10-12`,
    `+++ b/${requestFile}\t2026-10-13`,
    "@@ -4,3 +8,4 @@",
    " // transport settings",
    "", // Some diff producers omit the leading space on blank context.
    "-const maxRetries = 4;",
    "\\ No newline at end of file",
    "+const maxRetries = 10;",
    "+++ diagnostic marker",
    `diff --git a/${deleted} b/${deleted}`,
    `--- a/${deleted}`,
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-export const legacy = true;",
  ].join("\r\n");

  const parsed = parseTrailDiff(diff);
  assert.deepEqual(parsed.map((f) => f.path), [requestFile, deleted]);
  const [edited, removed] = parsed;
  assert.deepEqual(edited!.lines, [
    { new: 8, op: " ", text: "// transport settings" },
    { new: 9, op: " ", text: "" },
    { new: 0, op: "-", text: "const maxRetries = 4;" },
    { new: 10, op: "+", text: "const maxRetries = 10;" },
    { new: 11, op: "+", text: "++ diagnostic marker" },
  ]);
  assert.deepEqual(addedText(edited!), ["const maxRetries = 10;", "++ diagnostic marker"]);
  assert.equal(inHunk(edited!, 11), true);
  assert.equal(inHunk(edited!, 12), false);
  assert.deepEqual(removed!.hunks, [{ start: 0, len: 0 }]);
  assert.deepEqual(addedText(removed!), []);

  assert.deepEqual(
    trailCheckFiles([` ./${requestFile} `, " ", modeOnly, `./${modeOnly}`], parsed),
    [requestFile, modeOnly, deleted],
  );
});

test("diff parsing skips malformed hunk headers and recovers at the next file", () => {
  const newFile = posix.join(transport, "flags.ts");
  const parsed = parseTrailDiff([
    "@@ -1 +1 @@", // No file header yet.
    `--- a/${requestFile}`,
    `+++ b/${requestFile}`,
    "@@ -4,typo +4 @@",
    "+not part of a valid hunk",
    "@@ -7,2 +7,2 @@",
    "-const enabled = false;",
    "+const enabled = true;",
    // The preceding hunk was cut short, but the next file is still readable.
    `diff --git a/${newFile} b/${newFile}`,
    "--- /dev/null",
    `+++ b/${newFile}`,
    "@@ -0,0 +1 @@",
    "+export const experiment = true;",
  ].join("\n"));

  assert.deepEqual(parsed.map((f) => f.path), [requestFile, newFile]);
  assert.deepEqual(parsed[0]!.hunks, [{ start: 7, len: 2 }]);
  assert.deepEqual(addedText(parsed[0]!), ["const enabled = true;"]);
  assert.deepEqual(parsed[1]!.hunks, [{ start: 1, len: 1 }]);
  assert.deepEqual(parsed[1]!.lines, [{ new: 1, op: "+", text: "export const experiment = true;" }]);
});

test("candidate selection ranks exact touches above folder and wording matches", () => {
  const exact = note("Transport limits", { touches: [`./${requestFile}#sendRequest`] });
  const nearby = note("Queue settings", { touches: [posix.join(transport, "response.ts")] });
  const byWords = note("Retry batch design");
  const oneTerm = note("Retry budget");
  const otherRootFile = note("Logging", { touches: ["logger.ts"] });
  const pathSkill = skill("request-policy", `See ${requestFile} for the implementation.`);
  const wordSkill = skill("queue-policy", "Batch retry requests.");
  const oneTermSkill = skill("retry-policy", "Retry transient failures.");

  const candidates = selectTrailCheckCandidates(
    [" ", requestFile, "index.ts"],
    ["retries", "batching"],
    [
      { note: otherRootFile, textScore: 0 },
      { note: byWords, textScore: 0.2 },
      { note: nearby, textScore: 0 },
      { note: oneTerm, textScore: 1 / 9 },
      { note: exact, textScore: 0 },
    ],
    [
      { skill: wordSkill, textScore: 0.2 },
      { skill: oneTermSkill, textScore: 1 / 9 },
      { skill: pathSkill, textScore: 0 },
    ],
    now,
  );

  assert.deepEqual(candidates.map((c) => c.kind === "note" ? c.note.title : c.skill.name), [
    exact.title, nearby.title, byWords.title, pathSkill.name, wordSkill.name,
  ]);
});

test("candidate selection reserves at most six of its 25 slots for skills", () => {
  const notes = Array.from({ length: 26 }, (_, i) => ({
    note: note(`transport-learning-${i}`, { touches: [requestFile] }),
    textScore: i / 100,
  }));
  const skills = Array.from({ length: 8 }, (_, i) => ({
    skill: skill(`transport-skill-${i}`, `Guidance for ${requestFile}`),
    textScore: i / 100,
  }));

  const candidates = selectTrailCheckCandidates([requestFile], [], notes, skills, now);
  assert.deepEqual(
    candidates.slice(0, 19).map((c) => c.kind === "note" && c.note.title),
    notes.slice(7).reverse().map(({ note }) => note.title),
  );
  assert.deepEqual(
    candidates.slice(19).map((c) => c.kind === "skill" && c.skill.name),
    skills.slice(2).reverse().map(({ skill }) => skill.name),
  );
});

test("a watch-out flags a numeric replacement, but does not pair lines across context", () => {
  const warning = note("Retry warning", {
    touches: [requestFile],
    body: "## Watch out\n- Avoid setting maxRetries to 10.",
  });
  const check = (...lines: string[]) => checkLocally({
    diff: diffFor(requestFile, "@@ -20,2 +20,2 @@", ...lines),
    files: [],
    notes: [warning],
    skills: [],
    asker: "Maya",
  });
  const remove = "-const maxRetries = 4;";
  const add = "+const maxRetries = 10;";
  const context = " // request defaults";

  const paired = check(context, remove, add);
  assert.equal(paired.files, 1);
  assert.equal(paired.findings.length, 1);
  const finding = paired.findings[0]!;
  assert.equal(finding.verdict, "conflict");
  assert.equal(finding.file, requestFile);
  assert.equal(finding.line, 21);
  assert.equal(finding.summary, "sets maxRetries to 10, which Maya's learning warned about");
  assert.equal(finding.source.quote, "Avoid setting maxRetries to 10.");

  const separated = check(remove, context, add);
  assert.equal(separated.notes, 1);
  assert.deepEqual(separated.findings, []);
});

test("a personal learning without a source path still produces a quoted lead", () => {
  const warning = note("Retry warning", {
    path: "",
    author: "",
    date: "",
    scope: "personal",
    touches: [requestFile],
    body: "## Watch out\n- Avoid setting maxRetries to 10.",
  });
  const result = checkLocally({
    diff: diffFor(requestFile, "@@ -7 +7 @@", "-const maxRetries = 4;", "+const maxRetries = 10;"),
    files: [],
    notes: [warning],
    skills: [],
    now,
  });

  assert.equal(result.findings.length, 1);
  const finding = result.findings[0]!;
  assert.equal(finding.verdict, "lead");
  assert.equal(finding.why, "a learning just for you");
  assert.equal(finding.summary, "sets maxRetries to 10, which a learning warned about");
  assert.equal(finding.source.quote, "Avoid setting maxRetries to 10.");
  assert.equal(finding.source.path, undefined);
  assert.equal(finding.replacedBy, undefined);
});

test("skill findings cap the summary and quote without losing the citation", () => {
  const file = posix.join("src", "cache.ts");
  const quote = "Always prefer bounded cache eviction when processing bursts of mixed " +
    "workload traffic to keep memory usage stable across busy workers " +
    "and preserve capacity for requests while background jobs drain their " +
    "queues without competing for the same resources during peak hours";
  const policy = skill(
    "cache-policy",
    `${quote.replace("bounded cache", "bounded \tcache")} every weekday.`,
    `Guidance for ${file}`,
  );

  const result = checkLocally({
    diff: diffFor(file, "@@ -0,0 +1 @@", "+const boundedCacheEviction = true;"),
    files: [],
    notes: [],
    skills: [policy],
  });

  assert.equal(result.findings.length, 1);
  const finding = result.findings[0]!;
  assert.equal(finding.verdict, "follows");
  assert.equal(finding.line, undefined);
  assert.equal(finding.summary, "follows skill cache-policy: Always prefer bounded cache eviction when processing bursts of");
  assert.equal(finding.source.kind, "skill");
  assert.equal(finding.source.name, policy.name);
  assert.equal(finding.source.quote, quote);
});

describe("checking base-branch and working-tree learnings", () => {
  const learningDir = posix.join(".trail", "learnings");
  let repo: string | undefined;
  let notes: Note[];
  let basePaths: Set<string>;

  before(() => {
    const dir = repo = tmpRepo("local-check-base-learnings");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Maya");
    git("config", "user.email", "maya@example.test");

    const learnings = join(dir, ".trail", "learnings");
    mkdirSync(learnings, { recursive: true });
    const oldName = "2026-10-12-keep-four-maya.md";
    writeFileSync(join(learnings, oldName), [
      "---", "title: Keep four retries", "author: Maya", "date: 2026-10-12",
      `touches: [${JSON.stringify(requestFile)}]`, "---", "",
      "## Decided", "- Keep maxRetries at 4.", "",
    ].join("\n"));
    git("add", "-f", "--", posix.join(learningDir, oldName));
    git("commit", "-qm", "Record the retry decision");
    basePaths = new Set(git("ls-tree", "-r", "--name-only", "HEAD").trim().split(/\r?\n/));

    writeFileSync(join(learnings, "2026-10-14-retry-warning-kumar.md"), [
      "---", "title: Ten retry warning", "author: Kumar", "date: 2026-10-14",
      `touches: [${JSON.stringify(requestFile)}]`, "---", "",
      "## Watch out", "- Avoid setting maxRetries to 10.", "",
    ].join("\n"));

    const loaded = listNotes(dir);
    const old = loaded.find((n) => n.title === "Keep four retries");
    const fresh = loaded.find((n) => n.title === "Ten retry warning");
    assert.ok(old, "the base learning is readable");
    assert.ok(fresh, "the working-tree learning is readable");
    notes = [old, fresh];
  });

  after(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  test("an exact-file warning outside the base branch is a lead, not a conflict", () => {
    const committed = mock.fn((n: Note) => basePaths.has(posix.join(learningDir, basename(n.path))));
    const result = checkLocally({
      diff: diffFor(requestFile, "@@ -7 +7 @@", "-const maxRetries = 4;", "+const maxRetries = 10;"),
      files: [requestFile],
      notes,
      skills: [],
      now,
      committed,
    });

    assert.equal(result.notes, 2);
    assert.deepEqual(result.findings.map((f) => [f.verdict, f.source.title]), [
      ["conflict", "Keep four retries"],
      ["lead", "Ten retry warning"],
    ]);
    const [conflict, lead] = result.findings;
    assert.equal(conflict!.line, 7);
    assert.equal(conflict!.summary, "changes maxRetries from 4 to 10");
    assert.equal(lead!.why, "not on the base branch yet");
    assert.equal(lead!.source.quote, "Avoid setting maxRetries to 10.");
  });
});
