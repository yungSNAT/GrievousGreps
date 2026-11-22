/**
 * Gaps in src/init/review-screen.ts: foldTarget (a preference that only repeats a skill's step, and the cases that
 * never fold), repoNameOf's fallback, shipBranchesOf with no check, the job phrases, a guardrail from an unknown
 * wall, the PR list words, the quoted preference, numbering by kind, plural counts in --yes's line, the folded
 * line after a keep, and the offers-off line with no date.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  foldTarget,
  repoNameOf,
  shipBranchesOf,
  jobPhrase,
  countSentence,
  numbered,
  screenLines,
  relayItemLine,
  yesLine,
  afterKeepLines,
  dayWords,
  INIT_COPY,
  type ScreenFacts,
} from "../src/init/review-screen.js";
import { onlyRepeats } from "../src/skills/follow-learnings.js";
import type { InitItem } from "../src/init/types.js";

function item(over: Record<string, unknown>): InitItem {
  return {
    kind: "preference",
    key: "pref|x",
    title: "a learning",
    description: "",
    scope: "personal",
    applies: "this repo only",
    count: { days: 2 },
    evidence: [],
    ticked: false,
    n: 1,
    plainName: "",
    ...over,
  } as unknown as InitItem;
}

function facts(over: Partial<ScreenFacts> = {}): ScreenFacts {
  return {
    lookBack: {
      sessions: [],
      days: 0,
      from: null,
      to: null,
      parent: null,
      alreadyKept: { here: 0, elsewhere: [] },
      errors: [],
    } as unknown as ScreenFacts["lookBack"],
    model: "none",
    why: null,
    tokens: 0,
    calls: 0,
    offers: "on",
    offersOffAt: null,
    repoName: "widgets",
    agent: false,
    skills: true,
    lookedBack: false,
    ...over,
  };
}

const CMDS = ["npm test"];
const CANDIDATES = [
  "npm test",
  "run npm test",
  "always run npm test",
  "run `npm test`",
  "Always run npm test",
  "use npm test",
  "run npm test before pushing",
];

function skillItem(n: number, steps: string[] | null): InitItem {
  return item({
    kind: "skill",
    key: "repo|job:tests",
    title: "run-tests",
    n,
    skill: steps ? { compiled: { steps: steps.map((cmd) => ({ cmd })), check: "" } } : {},
  });
}

describe("foldTarget", () => {
  const title = CANDIDATES.find((t) => onlyRepeats(t, CMDS));

  test("a personal preference that only repeats a skill's step folds into that skill", () => {
    assert.ok(title, "one of the candidate titles repeats `npm test`");
    const skill = skillItem(1, CMDS);
    const pref = item({ title, n: 2 });
    assert.equal(foldTarget(pref, [skill, pref]), skill);
  });

  test("no fold: no skill with compiled steps, a repo or every-repo preference, no title, not a preference", () => {
    assert.ok(title);
    const bare = skillItem(1, null);
    const pref = item({ title, n: 2 });
    assert.equal(foldTarget(pref, [bare, pref]), null);
    const skill = skillItem(1, CMDS);
    assert.equal(foldTarget(item({ title, scope: "repo" }), [skill]), null);
    assert.equal(foldTarget(item({ title, applies: "every repo" }), [skill]), null);
    assert.equal(foldTarget(item({ title: "" }), [skill]), null);
    assert.equal(foldTarget(skill, [skill]), null);
  });

  test("the screen says where a folded preference goes, under the preference", () => {
    assert.ok(title);
    const skill = skillItem(1, CMDS);
    const pref = item({ title, n: 2 });
    const lines = screenLines([skill, pref], { cursor: 0, open: null }, facts());
    const hint = "         Kept with skill 1, it goes into that skill as a learning, since a step of it already does this.";
    const at = lines.indexOf(hint);
    assert.ok(at > 0, lines.join("\n"));
    assert.ok(lines.slice(0, at).some((l) => l.includes(`2  "${title.replace(/"/g, "'")}"`)), lines.join("\n"));
    assert.equal(lines.filter((l) => l === hint).length, 1);
  });
});

describe("names and phrases", () => {
  test("repoNameOf takes the key's last part, or the key itself when it has none", () => {
    assert.equal(repoNameOf("github.com/acme/widgets"), "widgets");
    assert.equal(repoNameOf("github.com/acme/widgets/"), "widgets");
    assert.equal(repoNameOf("/"), "/");
    assert.equal(repoNameOf(""), "");
  });

  test("shipBranchesOf reads refs/heads names, at most three, none from no check", () => {
    assert.deepEqual(shipBranchesOf(null), []);
    assert.deepEqual(shipBranchesOf(undefined), []);
    assert.deepEqual(
      shipBranchesOf("git ls-remote origin refs/heads/main refs/heads/main refs/heads/prod refs/heads/qa refs/heads/dev"),
      ["main", "prod", "qa"],
    );
  });

  test("job phrases for release, ship, and the rest", () => {
    const k = (job: string, skill?: unknown) => ({ key: `repo|job:${job}`, skill } as Pick<InitItem, "key" | "skill">);
    assert.equal(jobPhrase(k("release"), "widgets"), "publish widgets to npm");
    assert.equal(jobPhrase(k("release", { compiled: { steps: [], check: "gh release view" } }), "widgets"), "release widgets");
    assert.equal(jobPhrase(k("ship", { compiled: { steps: [], check: "git ls-remote origin refs/heads/main" } }), "widgets"), "ship widgets to main");
    assert.equal(jobPhrase(k("ship", { branches: ["main", "prod"] }), "widgets"), "ship widgets to main and prod");
    assert.equal(jobPhrase(k("ship"), "widgets"), "ship widgets");
    assert.equal(jobPhrase(k("tests"), "widgets"), "run widgets's tests");
    assert.equal(jobPhrase(k("pr-green"), "widgets"), "get a PR's checks green");
    assert.equal(jobPhrase(k("run-local"), "widgets"), "run widgets locally");
    assert.equal(jobPhrase(k("deploy"), "widgets"), "deploy widgets");
  });

  test("dayWords is empty for no day", () => {
    assert.equal(dayWords(null), "");
    assert.equal(dayWords("2026-07-03"), "Jul 3");
  });
});

describe("count sentences", () => {
  test("a guardrail from an unknown wall falls back to the plain words", () => {
    const g = item({ kind: "guardrail", key: "g|x", guardrail: { cls: "no-such-wall" }, count: { days: 3 } });
    assert.equal(countSentence(g, "widgets"), "Claude ran into this error on 3 days.");
  });

  test("a skill's and a preference's counts", () => {
    assert.equal(countSentence(skillItem(1, CMDS), "widgets"), "Claude worked out how to run widgets's tests from scratch on 2 different days.");
    assert.equal(countSentence(item({ count: { days: 4 } }), "widgets"), "You said this on 4 days.");
  });

  test("PR reviews: one, two, more than three, none", () => {
    const r = (prs?: number[]) => item({ kind: "review", key: "r|x", review: prs ? { prs } : undefined });
    assert.equal(countSentence(r([4]), "w"), "From PR #4.");
    assert.equal(countSentence(r([7, 9]), "w"), "From PR #7 and #9.");
    assert.equal(countSentence(r([1, 2, 3]), "w"), "From PR #1, #2 and #3.");
    assert.equal(countSentence(r([1, 2, 3, 4, 5]), "w"), "From PR #1, #2, #3 +2.");
    assert.equal(countSentence(r(), "w"), "From PR .");
  });

  test("team and Claude.ai rows have their own sentences", () => {
    assert.equal(countSentence(item({ kind: "session" }), "w"), INIT_COPY.sessionCount);
    assert.equal(countSentence(item({ kind: "claude" }), "w"), INIT_COPY.claudeCount);
    assert.equal(countSentence(item({ kind: "claudeai" }), "w"), INIT_COPY.claudeAiCount);
  });
});

describe("numbering and relay lines", () => {
  test("numbered sorts by kind and numbers from 1", () => {
    const out = numbered([
      { kind: "claudeai" as const, id: "a" },
      { kind: "preference" as const, id: "b" },
      { kind: "skill" as const, id: "c" },
      { kind: "review" as const, id: "d" },
      { kind: "guardrail" as const, id: "e" },
    ]);
    assert.deepEqual(out.map((x) => [x.n, x.id]), [[1, "c"], [2, "e"], [3, "b"], [4, "d"], [5, "a"]]);
  });

  test("a preference is quoted with its double quotes made single; other kinds are not quoted", () => {
    const pref = relayItemLine(item({ title: 'say "hi" first', n: 3 }), "w").split("\n");
    assert.equal(pref[0], `3. "say 'hi' first" (learning in your own words, this repo only)`);
    const rev = relayItemLine(item({ kind: "review", title: "keep PRs small", n: 4, review: { prs: [12] } }), "w").split("\n");
    assert.equal(rev[0], "4. keep PRs small (from pull requests)");
    assert.equal(rev[1], "   From PR #12.");
    const sess = relayItemLine(item({ kind: "session", title: "x", n: 5 }), "w");
    assert.match(sess, /^5\. x \(from your past sessions\)/);
    const cl = relayItemLine(item({ kind: "claude", title: "y", n: 6 }), "w");
    assert.match(cl, /^6\. y \(from what your Claude keeps\)/);
  });
});

describe("--yes and after a keep", () => {
  test("yesLine counts each kind, one or many", () => {
    const items = [{ kind: "skill" as const }, { kind: "preference" as const }, { kind: "preference" as const }];
    assert.equal(
      yesLine(items, false),
      "found 1 skill, 0 always-follow learnings and 2 learnings. Kept only the learnings in your own words. To pick the rest: trail init --look-back",
    );
    assert.match(yesLine([{ kind: "guardrail" as const }], true), /^found 0 skills, 1 always-follow learning and 0 learnings\. Kept nothing: an agent ran this\./);
  });

  test("a folded preference, one not kept, and offers off with no date", () => {
    const pref = item({ title: 'run "npm test"' });
    const other = item({ title: "tabs" });
    const lines = afterKeepLines(
      { kept: [pref], refused: [], notKept: [other], folded: [{ item: pref, skill: "run-tests" }], how: "enter" } as never,
      facts({ offers: "off", offersOffAt: null }),
    );
    assert.deepEqual(lines, [
      "✓ kept 1, just for you · in ~/.trail, never committed, never uploaded",
      `· "run 'npm test'" went into run-tests as a learning, since a step of it already does that`,
      `Not kept: "tabs". Trail won't bring it up again.`,
      "skill offers are off (you turned them off on an earlier day) · trail skills offers on",
    ]);
  });

  test("kept in the repo and for you, several not kept, offers off on a day, skills off hides offers", () => {
    const a = item({ title: "a", scope: "repo" });
    const b = item({ title: "b" });
    const r = { kept: [a, b], refused: [], notKept: [item({ title: "c" }), item({ kind: "review", title: "d" })], how: "enter" } as never;
    const lines = afterKeepLines(r, facts({ offers: "off", offersOffAt: "2026-03-09" }));
    assert.equal(lines[0], "✓ kept 2 · 1 just for you in ~/.trail, never uploaded · 1 added to this repo's .trail/learnings (commit it to share)");
    assert.equal(lines[1], `Not kept: "c", d. Trail won't bring them up again.`);
    assert.equal(lines[2], "skill offers are off (you turned them off on Mar 9) · trail skills offers on");
    assert.equal(afterKeepLines(r, facts({ skills: false })).length, 2);
  });
});
