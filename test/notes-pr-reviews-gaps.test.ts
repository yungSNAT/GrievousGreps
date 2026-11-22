import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  beginReviewRead,
  commentedCode,
  findReviewLearnings,
  ghReady,
  repoDocs,
  revertCommits,
  reviewDigest,
  reviewedPRs,
  reviewWords,
  saveReviewFindings,
  type ReviewFinding,
} from "../src/notes/pr-reviews.js";
import { listNotes } from "../src/notes/notes.js";
import { tmpRepo } from "./helpers.js";

const scratch: string[] = [];
const mergedAt = "2025-02-03T12:00:00Z";
const member = { authorAssociation: "MEMBER", author: { login: "reviewer" } };

before(() => {
  mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
});

after(() => {
  mock.restoreAll();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function temp(tag: string): string {
  const dir = tmpRepo(`pr-reviews-${tag}`);
  scratch.push(dir);
  return dir;
}

function git(repo: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
}

function answer(merged: unknown[], closed: unknown[] = []) {
  return { data: { repository: { merged: { nodes: merged }, closed: { nodes: closed } } } };
}

// With process.execPath as gh, Node runs the local "api" or "auth" script named
// by the first argument. This needs neither a shell wrapper nor a PATH change.
function stubApi(repo: string, output: string, status = 0): void {
  writeFileSync(join(repo, "api"), `
    const args = process.argv.slice(2);
    if (args[0] !== "graphql" || process.env.GH_PROMPT_DISABLED !== "1"
        || !args.includes("owner={owner}") || !args.includes("name={repo}")
        || !args.includes("merged=40") || !args.includes("closed=25")
        || !args.some((arg) => arg.startsWith("query=") && arg.includes("reviewThreads"))) {
      process.exitCode = 2;
    } else {
      process.stdout.write(${JSON.stringify(output)});
      process.exitCode = ${status};
    }
  `);
}

describe("cleaning review text", () => {
  test("removes comments, including nested and unfinished ones, and drops quoted replies", () => {
    const raw = [
      "  Keep\t the transaction. <!-- hidden",
      "comment -->",
      "    > Quoted reply with ![private](private.png)",
      "<!<!---->--hidden after the inner comment is removed-->",
      "See ![example](example.png) for the   failure.",
      "<!-- unfinished comment",
      "also hidden",
    ].join("\n");

    assert.equal(reviewWords(raw), "Keep the transaction. See [image] for the failure.");
    assert.equal(reviewWords(" \n > only a quote\n<!-- hidden -->"), null);
    assert.equal(reviewWords(""), null);
  });

  test("adds an ellipsis only when the cleaned comment exceeds 800 characters", () => {
    const boundary = "Keep ".repeat(159) + "going";
    assert.equal(reviewWords(`  ${boundary}\n<!-- not counted -->`), boundary);
    assert.equal(reviewWords(`${boundary} further`), `${boundary}…`);
  });

  test("uses the tail of the diff without hunk headers or empty code", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `+const value${i} = ${i};`);
    const hunk = ["@@ -1,2 +1,4 @@", ...rows.slice(0, 4), "@@ -10,2 +12,6 @@", ...rows.slice(4)];
    assert.equal(commentedCode(hunk.join("\n")), rows.slice(-8).join("\n"));
    const tail = "keep!".repeat(100);
    assert.equal(commentedCode(`@@ -1 +1 @@\n-discard ${tail}`), tail);
    assert.equal(commentedCode("@@ -1 +1 @@"), undefined);
    assert.equal(commentedCode(" \n\t "), undefined);
    assert.equal(commentedCode(undefined), undefined);
  });
});

describe("reading GitHub's review data", () => {
  test("keeps team discussion and builds a digest with thread context", () => {
    const migration = "db/migrate.ts";
    const rollback = "db/rollback.ts";
    const resolved = "db/resolved.ts";
    const current = "db/current.ts";
    const { prs, merged } = reviewedPRs(answer([{
      number: 23,
      title: "Pin migration order",
      mergedAt,
      author: { login: "pr-author" },
      body: "  Run\t this first. <!-- template -->\n\n\nSee ![plan](plan.png).  ",
      comments: { nodes: [
        null,
        { ...member, body: "Use one transaction." },
        { ...member, body: "> quoted only" },
        member,
        { author: { login: "stranger" }, body: "Missing association." },
        { authorAssociation: "CONTRIBUTOR", body: "External suggestion." },
        { ...member, author: { __typename: "Bot" }, body: "Automated summary." },
      ] },
      reviews: { nodes: [
        null,
        member,
        { ...member, author: { login: "pr-author" }, body: "Self review." },
        { ...member, author: { login: "checks[BoT]" }, body: "Automated review." },
        { authorAssociation: "OWNER", author: null, body: "Document the rollback." },
      ] },
      reviewThreads: { nodes: [
        null,
        {},
        {
          isOutdated: true,
          path: migration,
          comments: { nodes: [
            null,
            { ...member, body: "Lock before copying.", diffHunk: "@@ -1 +1 @@\n+lock();" },
            { ...member, path: rollback, body: "Keep the down migration." },
            { ...member, body: "<!-- blank -->" },
            { ...member, author: { login: "pr-author" }, body: "Done." },
            { authorAssociation: "NONE", body: "Outside the team." },
          ] },
        },
        {
          isResolved: true,
          path: resolved,
          comments: { nodes: [{ authorAssociation: "COLLABORATOR", body: "Verify the old schema." }] },
        },
        {
          comments: { nodes: [
            { ...member, body: "Missing a file." },
            { ...member, path: current, body: "Test with an empty table." },
          ] },
        },
      ] },
    }]));

    assert.equal(merged, 1);
    assert.equal(prs.length, 1);
    const pr = prs[0]!;
    // Stripping the HTML comment leaves the preceding space before the newline.
    assert.equal(pr.description, "Run this first. \nSee [image].");
    assert.deepEqual(pr.comments, [
      { text: "Use one transaction.", where: "comment" },
      { text: "Document the rollback.", where: "review" },
      { path: migration, text: "Lock before copying.", actedOn: true, where: "thread", code: "+lock();" },
      { path: rollback, text: "Keep the down migration.", actedOn: true, where: "thread" },
      { path: resolved, text: "Verify the old schema.", actedOn: true, where: "thread" },
      { path: current, text: "Test with an empty table.", actedOn: false, where: "thread" },
    ]);

    const digest = reviewDigest(prs);
    assert.deepEqual(digest.read, [pr]);
    const lines = digest.text.split("\n");
    assert.equal(lines[0], "=== PR #23 (merged, 2025-02-03): Pin migration order");
    assert.ok(digest.text.includes("\n[description] Run this first. \nSee [image].\n"));
    assert.ok(lines.includes("[comment] Use one transaction."));
    assert.ok(lines.includes("[review] Document the rollback."));
    assert.ok(digest.text.includes(`[code in ${migration}]\n+lock();\n[on ${migration}, acted on] Lock before copying.`));
    assert.ok(lines.includes(`[on ${current}] Test with an empty table.`));
    assert.ok(!lines.includes(`[code in ${current}]`));
  });

  test("omits untrusted closed descriptions and budgets the digest by whole PRs", () => {
    const rationale = "Keep migration steps backward compatible. ".repeat(45).trim();
    const title = "Migration cleanup ".repeat(9).trim();
    const { merged, prs } = reviewedPRs(answer([
      null,
      { number: 1, mergedAt, body: "Too short." },
      { number: 2, mergedAt, body: rationale, author: { login: "release[bot]" } },
      { number: 3, mergedAt, body: " <!-- nothing visible --> " },
      { mergedAt, body: rationale },
      { number: 4, body: rationale },
      { number: 5, mergedAt, body: rationale, title },
    ], [
      { number: 6, closedAt: "2025-02-04T12:00:00Z", body: rationale, comments: { nodes: [
        { ...member, body: "Leave the old schema in place." },
      ] } },
      { number: 7, closedAt: "2025-02-05T12:00:00Z", body: rationale, authorAssociation: "COLLABORATOR" },
      { number: 8, closedAt: "2025-02-06T12:00:00Z", body: rationale },
      { number: 9, closedAt: "2025-02-07T12:00:00Z", mergedAt, body: rationale, authorAssociation: "OWNER" },
    ]));

    assert.equal(merged, 6);
    assert.deepEqual(prs.map((pr) => [pr.number, pr.kind]), [
      [7, "closed"], [6, "closed"], [5, "merged"],
    ]);
    assert.equal(prs[0]!.description, `${rationale.slice(0, 1200)}…`);
    assert.equal(prs[1]!.description, undefined);
    assert.equal(prs[1]!.title, "");
    assert.equal(prs[1]!.comments[0]!.text, "Leave the old schema in place.");
    assert.equal(prs[2]!.title, title.slice(0, 120));

    const first = reviewDigest(prs.slice(0, 1));
    assert.match(first.text, /^=== PR #7 \(closed without merging, 2025-02-05\):/);
    const limited = reviewDigest(prs, first.text.length);
    assert.equal(limited.text, first.text);
    assert.deepEqual(limited.read.map((pr) => pr.number), [7]);
    assert.deepEqual(reviewDigest(prs, 1).read.map((pr) => pr.number), [7]);
    assert.deepEqual(reviewDigest(prs).read.map((pr) => pr.number), [7, 6, 5]);
  });

  test("accepts the legacy pullRequests shape and handles missing repository data", () => {
    assert.deepEqual(reviewedPRs(null), { merged: 0, prs: [] });
    assert.deepEqual(reviewedPRs({ data: { repository: {} } }), { merged: 0, prs: [] });

    const { merged, prs } = reviewedPRs({ data: { repository: { pullRequests: { nodes: [{
      number: 12,
      mergedAt,
      reviews: { nodes: [{ ...member, body: "Check the lock order." }] },
    }] } } } });
    assert.equal(merged, 1);
    assert.equal(prs[0]!.number, 12);
    assert.equal(prs[0]!.description, undefined);
    assert.deepEqual(prs[0]!.comments, [{ where: "review", text: "Check the lock order." }]);
  });
});

describe("local context for reviews", () => {
  test("picks the first contributor guide and the latest ADRs, skipping blank files", () => {
    const repo = temp("docs");
    const adr = join(repo, "docs", "adr");
    mkdirSync(adr, { recursive: true });
    const policy = "Keep changes reversible. ".repeat(300).trim();
    writeFileSync(join(repo, "CONTRIBUTING.md"), `\n${policy}\n`);
    writeFileSync(join(repo, "docs", "CONTRIBUTING.md"), "Secondary guide.");
    for (let n = 1; n <= 14; n++) {
      writeFileSync(join(adr, `${String(n).padStart(2, "0")}.md`), n === 4 ? " \n\t" : `Decision ${n}`);
    }
    writeFileSync(join(adr, "99.txt"), "Not a markdown decision.");

    const docs = repoDocs(repo);
    assert.deepEqual(docs[0], { id: "doc CONTRIBUTING.md", text: policy.slice(0, 6000) });
    assert.equal(docs.length, 12);
    assert.deepEqual(docs[1], { id: "doc docs/adr/03.md", text: "Decision 3" });
    assert.deepEqual(docs.at(-1), { id: "doc docs/adr/14.md", text: "Decision 14" });
    assert.ok(!docs.some(({ id }) => /(?:01\.md|02\.md|04\.md|99\.txt|docs\/CONTRIBUTING\.md)$/.test(id)));
  });

  test("reads revert subjects and reasons, not unrelated commits", () => {
    const repo = temp("reverts");
    git(repo, "init", "-q");
    assert.equal(revertCommits(repo), "");
    git(repo, "commit", "--allow-empty", "-qm", "Change the migration order");
    git(repo, "commit", "--allow-empty", "-qm", 'Revert "Change the migration order"', "-m", "Old clients still need the previous order.");
    git(repo, "commit", "--allow-empty", "-qm", "Update unrelated documentation");

    const reverts = revertCommits(repo);
    assert.match(reverts, /^[a-f0-9]+ \d{4}-\d{2}-\d{2} Revert "Change the migration order"/);
    assert.match(reverts, /Old clients still need the previous order\./);
    assert.doesNotMatch(reverts, /Update unrelated documentation/);
  });
});

describe("reading reviews through a local gh stand-in", () => {
  test("counts all merged PRs but skips Claude when nothing is newer than since", async () => {
    const repo = temp("since");
    stubApi(repo, JSON.stringify(answer([
      { number: 23, mergedAt, comments: { nodes: [{ ...member, body: "Test the upgrade first." }] } },
      { number: 22, mergedAt: "2025-02-02T12:00:00Z", comments: { nodes: [{ ...member, body: "Keep compatibility." }] } },
    ])));

    const result = await findReviewLearnings(repo, { gh: process.execPath, since: mergedAt });
    assert.equal(result.reason, "no_reviews");
    assert.equal(result.prs, 2);
    assert.equal(result.reviewed, 0);
    assert.equal(result.read, 0);
    assert.deepEqual(result.findings, []);
  });

  for (const { name, output, status } of [
    { name: "malformed JSON", output: "{not JSON", status: 0 },
    { name: "a nonzero exit", output: JSON.stringify(answer([{ number: 4, mergedAt }])), status: 1 },
  ]) {
    test(`reports no_gh for ${name}`, async () => {
      const repo = temp("bad-response");
      stubApi(repo, output, status);
      const result = await findReviewLearnings(repo, { gh: process.execPath, model: "test-model" });
      assert.equal(result.reason, "no_gh");
      assert.equal(result.model, "test-model");
      assert.equal(result.prs, 0);
      assert.deepEqual(result.findings, []);
    });
  }

  test("reports no_gh when the configured executable is missing", async () => {
    const repo = temp("missing-gh");
    const result = await findReviewLearnings(repo, { gh: join(repo, "missing-gh") });
    assert.equal(result.reason, "no_gh");
    assert.equal(result.read, 0);
    assert.deepEqual(result.findings, []);
  });

  test("a contributor-doc note permits a read, but a saved PR learning suppresses it", async () => {
    const repo = temp("team-note");
    git(repo, "init", "-q");
    assert.equal(ghReady(repo, process.execPath), false);
    git(repo, "remote", "add", "origin", "https://github.com/example/example.git");
    const auth = join(repo, "auth");
    writeFileSync(auth, "process.exitCode = 1;");
    assert.equal(ghReady(repo, process.execPath), false);
    writeFileSync(auth, `
      process.exitCode =
        process.argv[2] === "token" && process.env.GH_PROMPT_DISABLED === "1" ? 0 : 1;
    `);
    stubApi(repo, JSON.stringify(answer([])));
    assert.equal(ghReady(repo, process.execPath), true);
    assert.equal(beginReviewRead(repo, { TRAIL_NO_FETCH: "1" }, process.execPath), null);

    const docsFinding: ReviewFinding = {
      title: "Document backout steps",
      body: "Write down how to back out a change before shipping it.",
      prs: [],
      last: "0000-00-00",
      quotes: [],
      touches: [],
    };
    const [docsNote] = saveReviewFindings(repo, [docsFinding], "Teammate", "2025-02-06");
    assert.match(docsNote!.body, /_From this repo's docs\._/);

    const read = beginReviewRead(repo, {}, process.execPath, 15_000);
    assert.ok(read);
    assert.equal(read.done, false);
    assert.equal((await read.result).reason, "no_reviews");
    assert.equal(read.done, true);

    const prFinding: ReviewFinding = {
      ...docsFinding,
      title: "Roll back migrations as a unit",
      body: "Keep the down migration in the same change.",
      prs: [23, 22],
      last: "2025-02-03",
    };
    saveReviewFindings(repo, [prFinding], "Teammate", "2025-02-06");
    const saved = listNotes(repo, { branches: false }).find((note) => note.title === prFinding.title);
    assert.equal(saved?.scope, "repo");
    assert.match(saved.body, /_From PRs #23, #22 here,/);
    assert.equal(beginReviewRead(repo, {}, process.execPath), null);
  });
});
