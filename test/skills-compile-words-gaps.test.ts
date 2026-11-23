/**
 * Gaps in compile-words: ship names from deploy remotes and said places, the null-job name, report and tests names,
 * free names, ask phrases from a typed request, description trimming, and the "show me" draft lines.
 */
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import {
  askedJob, askedWords, askPhrases, carriedSteps, describe as describeSkill, draftText, elsewhereLines, freeName,
  goodName, jobWords, monthDay, proposeName, pushShows, refusalWords, repoName, stableBranches, toolCheckWords,
} from "../src/skills/compile-words.js";
import { programOf } from "../src/trace/shell.js";
import type { RunCall, RunSheet } from "../src/trace/types.js";
import type { CompiledSkill, SkillStep } from "../src/skills/types.js";

void before; void after; void mock;

const REPO = "github.com/acme/shop";
const sheet = (over: Record<string, unknown>) =>
  ({ repoKey: REPO, job: null, jobWords: [], calls: [], startedAt: "2026-10-18T10:00:00", endedAt: "2026-10-18T10:30:00", checked: true, ...over }) as unknown as RunSheet;
const step = (n: number, cmd: string, over: Partial<SkillStep> = {}) => ({ n, cmd, gated: null, bg: false, wait: false, ...over }) as unknown as SkillStep;
const call = (id: string, cmd: string, failed = false) => ({ id, cmd, failed }) as unknown as RunCall;

describe("ship names", () => {
  test("two places the person named make a ship-then name with ff asks", () => {
    const w = jobWords(sheet({ job: "ship", jobWords: ["beta", "prod"] }), [], { calls: [] });
    assert.equal(w.base, "ship-beta-then-prod");
    assert.equal(w.title, "Ship shop: beta, then prod");
    assert.equal(w.lead, "Ships shop to beta, then fast-forwards prod");
    assert.deepEqual(w.asks, ["push to beta", "ff to prod", "fast-forward prod", "promote to prod", "deploy to prod", "update prod", "ship it"]);
    assert.deepEqual(w.statusAsks, ["is it live", "is prod updated", "did it deploy"]);
  });

  test("one place named makes ship-<place>", () => {
    const w = jobWords(sheet({ job: "ship", jobWords: ["beta"] }), [], { calls: [] });
    assert.equal(w.base, "ship-beta");
    assert.equal(w.title, "Ship shop to beta");
    assert.deepEqual(w.asks, ["push to beta", "deploy to beta", "update beta", "ship it"]);
    assert.deepEqual(w.statusAsks, ["is it live", "is beta updated", "did it deploy"]);
  });

  test("no place at all is a plain ship", () => {
    const w = jobWords(sheet({ job: "ship", jobWords: [] }), [], { calls: [] });
    assert.equal(w.base, "ship");
    assert.deepEqual(w.asks, ["ship it", "deploy it"]);
  });

  test("pushes to deploy remotes, from the calls or the steps, name the places in order", () => {
    const calls = [call("c1", "git push staging HEAD:main"), call("c2", "git push prod HEAD:main")];
    const w = jobWords(sheet({ job: "ship" }), [], { calls });
    assert.equal(w.base, "ship-staging-then-prod");
    assert.equal(w.asks[0], "push to staging");
    assert.equal(w.asks[w.asks.length - 1], "ship it");
    const fromSteps = jobWords(sheet({ job: "ship" }), [step(1, "git push -u prod HEAD:main")]);
    assert.equal(fromSteps.base, "ship-prod");
    assert.equal(fromSteps.asks[0], "push to prod");
    assert.ok(fromSteps.asks.includes("ship it"));
  });

  test("stableBranches reads remotes past options, skips failed calls, else the said places", () => {
    assert.deepEqual(stableBranches([call("a", "git push -o ci.skip live main")], []), ["live"]);
    assert.deepEqual(stableBranches([call("a", "git -C app push production HEAD:main")], []), ["production"]);
    assert.deepEqual(stableBranches([call("a", "git push prod HEAD:main", true)], ["staging", "prod", "beta"]), ["beta", "staging", "prod"]);
    assert.deepEqual(stableBranches([], []), []);
  });
});

describe("askedJob", () => {
  test("a registry publish is a release unless checked another way", () => {
    assert.equal(askedJob(null, [step(1, "npm publish")], [], null), "release");
    assert.equal(askedJob(null, [step(1, "cargo publish")], [], "npm-view"), "release");
    assert.equal(askedJob(undefined, [step(1, "npm publish")], [], "http" as never), null);
  });
  test("a push to a deploy remote is a ship; nothing is null", () => {
    assert.equal(askedJob(null, [step(1, "git push prod HEAD:main")], [call("c", "git push prod HEAD:main")], null), "ship");
    assert.equal(askedJob(null, [step(1, "make build")], [], null), null);
  });
});

describe("other job words", () => {
  test("release with and without a registry", () => {
    const npm = jobWords(sheet({ job: "release" }), [step(1, "pnpm publish --access public")]);
    assert.equal(npm.base, "release-npm");
    assert.equal(npm.title, "Release shop to npm");
    assert.ok(npm.asks.includes("ship to npm"));
    const helper = jobWords(sheet({ job: "release" }), [step(1, "./release.sh")], { helperText: "twine upload dist/*" });
    assert.equal(helper.base, "release-pypi");
    const bare = jobWords(sheet({ job: "release" }), [step(1, "./release.sh")]);
    assert.equal(bare.base, "release");
    assert.equal(bare.lead, "Releases shop");
  });

  test("tests: plain, or tagged by the words the person said", () => {
    assert.equal(jobWords(sheet({ job: "tests", jobWords: ["tests"] }), []).base, "run-tests");
    const e2e = jobWords(sheet({ job: "tests", jobWords: ["e2e", "tests"] }), []);
    assert.equal(e2e.base, "e2e-tests");
    assert.deepEqual(e2e.asks, ["e2e tests", "run the e2e tests"]);
  });

  test("report with two, one or no words", () => {
    const two = jobWords(sheet({ job: "report", jobWords: ["new", "users", "report"] }), []);
    assert.equal(two.base, "new-users-report");
    assert.equal(two.title, "New users report for shop");
    const one = jobWords(sheet({ job: "report", jobWords: ["report", "signups"] }), []);
    assert.equal(one.base, "signups-report");
    assert.equal(one.title, "Signups report for shop");
    assert.equal(one.lead, "Reads the signups numbers for shop");
    assert.deepEqual(one.asks, ["signups"]);
    const none = jobWords(sheet({ job: "report", jobWords: ["report"], repoKey: "" }), []);
    assert.equal(none.base, "report");
    assert.equal(none.title, "Report for this repo");
  });

  test("run-local", () => {
    assert.equal(jobWords(sheet({ job: "run-local" }), []).base, "run-locally");
  });

  test("no job: named for the main program, skipping waits, with the asked phrases", () => {
    const prog = programOf("make build")!;
    const w = jobWords(sheet({}), [step(1, "sleep 5", { wait: true }), step(2, "make build")], { asked: ["build the site"] });
    assert.equal(w.title, `Run ${prog} in shop`);
    assert.deepEqual(w.asks, ["build the site"]);
    assert.equal(w.dontUse, "Jobs other than this one.");
    const main = programOf("terraform apply")!;
    const m = jobWords(sheet({}), [step(1, "make build")], { main: "terraform apply" });
    assert.equal(m.title, `Run ${main} in shop`);
    const empty = jobWords(sheet({}), []);
    assert.equal(empty.base, "these-commands");
    assert.equal(empty.title, "Run these commands in shop");
    assert.deepEqual(empty.asks, []);
  });
});

describe("names", () => {
  test("goodName rejects built-ins, ids and bad shapes", () => {
    assert.equal(goodName("deploy-docs"), true);
    for (const n of ["trail", "ls-abcdef", "l-0123abcd", "deploy-", "a--b", "12", "x"]) assert.equal(goodName(n), false, n);
  });

  test("freeName: base, then -repo, then numbers, then a fallback", () => {
    assert.equal(freeName("trail", REPO, () => false), "run-trail");
    assert.equal(freeName("deploy", REPO, (n) => n === "deploy"), "deploy-shop");
    assert.equal(freeName("deploy", REPO, (n) => n === "deploy" || n === "deploy-shop"), "deploy-2");
    assert.equal(freeName("deploy", REPO, () => true), `deploy-${REPO.length}`);
    assert.equal(repoName("a/b/"), "b");
  });

  test("proposeName uses the job's base", () => {
    assert.equal(proposeName(sheet({ job: "tests" }), [], () => false), "run-tests");
    assert.equal(proposeName(sheet({ job: "tests" }), [], (n) => n === "run-tests"), "run-tests-shop");
  });
});

describe("asks", () => {
  test("askPhrases keeps 2 to 5 word clauses, at most 2, without values or scope", () => {
    assert.deepEqual(askPhrases("rebuild docs site, upload docs bundle, refresh search index"), ["rebuild docs site", "upload docs bundle"]);
    assert.deepEqual(askPhrases("deploy v1.2.3 to staging server"), ["deploy staging server"]);
    assert.deepEqual(askPhrases("run lint fix, run lint fix"), ["run lint fix"]);
    assert.deepEqual(askPhrases("run the smoke tests for every repo"), ["run smoke tests"]);
    assert.deepEqual(askPhrases("deploy"), []);
    assert.deepEqual(askPhrases(null), []);
  });

  test("questions never share a lead", () => {
    assert.equal(askedWords(["how many users", "is it live"]), "how many users, or is it live");
    assert.equal(askedWords(["deploy to prod"]), "to deploy to prod");
  });

  test("describe trims asks to fit 300 characters", () => {
    const end = "2026-10-18T12:00:00";
    assert.equal(describeSkill("Builds shop", end, []), "Builds shop, from the steps that worked on Oct 18.");
    assert.equal(describeSkill("Builds shop", "nope", []), "Builds shop, from the steps that worked on an earlier day.");
    const lead = `Builds ${"x".repeat(200)}`;
    const asks = ["publish", "release", "bump the version of the package", "redo the publish of the package", "ship to npm again"];
    const d = describeSkill(lead, end, asks);
    assert.ok(d.length <= 300, String(d.length));
    assert.match(d, /Use when asked to publish/);
    assert.ok(!d.includes("ship to npm again"));
    const huge = describeSkill(`Builds ${"y".repeat(290)}`, end, ["publish"]);
    assert.ok(huge.length <= 300);
    assert.ok(huge.startsWith("Builds yyy"));
    assert.equal(monthDay("2026-03-05T12:00:00"), "Mar 5");
  });
});

describe("draftText", () => {
  const base = (over: Record<string, unknown>) => ({
    name: "deploy-docs", meta: {}, steps: [step(1, "npm run build")], check: "", checkIsStep: false, helpers: [], params: [],
    leftOut: { failed: 0, lookOnly: 0, duplicates: 0, plumbing: 0, work: 0 }, ...over,
  }) as unknown as CompiledSkill;
  const lines = (c: CompiledSkill, s: RunSheet) => draftText(c, s).split("\n");

  test("ready probes, waits, params, left out and elsewhere", () => {
    const ready = ["git status --porcelain", "git rev-parse --abbrev-ref HEAD = main", "command -v jq", "test -f .env", "git rev-parse --verify origin/main", "curl -s localhost"].join(" ; ");
    const c = base({
      meta: { ready, "check-first": "gh auth status", applies: "every repo" },
      steps: [
        step(1, "npm run build"), step(2, "npm run serve", { bg: true }),
        step(3, 's=$SECONDS; until [ "$(gh run view --json status -q .status)" = "completed" ]; do sleep 5; done', { wait: true }),
        step(4, "s=$SECONDS; until curl -sf localhost:3000 >/dev/null 2>&1; do sleep 2; done", { wait: true }),
        step(5, "s=$SECONDS; while pgrep -f deploy >/dev/null 2>&1; do sleep 2; done", { wait: true }),
        step(6, "sleep 10", { wait: true }),
      ],
      check: "curl -sf https://docs.example.test", checkShows: "ok",
      params: [
        { name: "branch", shape: "branch", seen: ["main"], default: "$(git branch --show-current)" },
        { name: "tag", shape: "word", seen: ["v1"], default: "latest" },
        { name: "msg", shape: "word", seen: [] },
      ],
      leftOut: { failed: 1, lookOnly: 0, duplicates: 2, plumbing: 0, work: 0 },
      elsewhere: Array.from({ length: 7 }, (_, i) => ({ cmd: `ls ${i}`, where: "outside any repo" })),
      followed: "uses pnpm",
    });
    const l = lines(c, sheet({}));
    assert.equal(l[0], "deploy-docs · copied from the run that just worked (Oct 18, 10:00 to 10:30)");
    for (const want of [
      "  check first  gh auth status",
      "  ready        no uncommitted changes (git status --porcelain)",
      "  ready        on main (git rev-parse --abbrev-ref HEAD)",
      "  ready        jq is installed (command -v jq)",
      "  ready        .env is there (test -f .env)",
      "  ready        origin/main exists (git rev-parse --verify origin/main)",
      "  ready        curl -s localhost",
      "  2  npm run serve (in the background)",
      "  3  wait up to 5 min until gh run view --json status -q .status shows completed",
      "  4  wait up to 5 min until curl -sf localhost:3000 works",
      "  5  wait up to 5 min while pgrep -f deploy still works",
      "  6  sleep 10",
      "  check  curl -sf https://docs.example.test shows ok",
      "  {branch}  from what you type, or git branch --show-current; it was main this time",
      "  {tag}  from what you type, or latest as last time",
      "  {msg}  from what you type",
      "  left out  10 commands: 1 that failed, 2 repeats, 7 that ran outside this repo",
      "  elsewhere  ls 5 (outside any repo)",
      "  elsewhere  and 1 more",
      "  learnings  uses pnpm",
      "  just for you, in every repo · nothing is shared or uploaded",
    ]) assert.ok(l.includes(want), `missing: ${want}\n${l.join("\n")}`);
    assert.ok(!l.includes("  elsewhere  ls 6 (outside any repo)"));
  });

  test("carried runs, a step check, a tool check and no check", () => {
    const c = base({
      steps: [step(1, "npm run build"), step(2, "npm test")], check: "npm test", checkIsStep: true,
      carried: { compactions: 2, startedAt: "2026-10-17T09:00:00", steps: [1, 2] },
    });
    const l = lines(c, sheet({ checked: false }));
    assert.equal(l[0], "deploy-docs · copied from the run that just ran (Oct 17, 09:00 to Oct 18, 10:30)");
    assert.ok(l.includes("  compaction  the job ran across 2 compactions: steps 1 and 2 ran before the last one, the rest after"));
    assert.ok(l.includes("  check  step 2 passing is the check"));
    assert.ok(l.includes("  just for you, in this repo · nothing is shared or uploaded"));
    const tool = lines(base({ meta: { "check-tool": "mcp__vercel__get_deployment" }, check: "read the deployment" }), sheet({}));
    assert.ok(tool.includes("  check  read the deployment: it should show READY"));
    const none = lines(base({ carried: { compactions: 1, startedAt: "2026-10-18T10:00:00", steps: [] } }), sheet({}));
    assert.ok(none.includes("  check  none: no check ran in the run this came from"));
    assert.ok(none.includes("  compaction  the job ran across a compaction: every step ran after it"));
  });
});

describe("small words", () => {
  test("refusals", () => {
    assert.equal(refusalWords("judgement", "sweep"), "going through PRs takes judgement each time, so Trail doesn't keep it as fixed steps");
    assert.equal(refusalWords("too-long", "overflow"), "the run had more commands than Trail keeps for one job");
    assert.equal(refusalWords("too-long", "15"), "the job takes 15 steps, and a skill holds at most 12");
    assert.equal(refusalWords("never-save", "bug: no name"), "the skill file came out wrong (no name)");
    assert.equal(refusalWords("no-check", "version").startsWith("the check reads a version"), true);
    assert.equal(refusalWords("multi-line", "uses a heredoc: `cat <<EOF`"), "a step uses a heredoc: `cat <<EOF`");
  });

  test("pushShows and toolCheckWords name params", () => {
    assert.equal(pushShows("main", [{ name: "branch", seen: ["main"] }] as never), '{branch} moved: git prints old..new -> {branch}, not "Everything up-to-date"');
    assert.equal(pushShows(undefined, []), 'the branch moved: git prints old..new, not "Everything up-to-date"');
    const params = [{ name: "commit", shape: "sha", seen: ["abcdef1"] }] as never;
    assert.equal(toolCheckWords("mcp__vercel__get_deployment", { sha: "abcdef1234" } as never, params), "read the Vercel deployment for {commit} with get_deployment");
    assert.equal(toolCheckWords("mcp__vercel__get_deployment", { branch: "main" } as never, []), "read the Vercel deployment for the newest commit on main with get_deployment");
  });

  test("elsewhereLines and carriedSteps", () => {
    const calls = [
      { id: "a", cmd: null, truncated: true, key: null },
      { id: "b", cmd: null, key: "github.com/acme/other" },
      { id: "c", cmd: "ls", key: REPO },
      { id: "d", cmd: "ls", key: REPO },
    ] as unknown as RunCall[];
    assert.deepEqual(elsewhereLines(calls, REPO, (x) => x), [
      { cmd: "a command too long to show", where: "outside any repo" },
      { cmd: "a command Trail can't show (it held a secret)", where: "in other" },
      { cmd: "ls", where: "in a folder Trail couldn't follow" },
    ]);
    const s = sheet({ joined: [{ calls: 2 }], calls: [{ id: "a" }, { id: "b" }, { id: "c" }], startedAt: "x" });
    const steps = [step(1, "a", { from: ["a"] } as never), step(2, "b", { from: ["a", "c"] } as never), step(3, "c")];
    assert.deepEqual(carriedSteps(s, steps), { compactions: 1, startedAt: "x", steps: [1] });
  });
});
