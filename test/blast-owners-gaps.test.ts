import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachOwners,
  diffAuthors,
  githubHandle,
  isoDay,
  localIdentity,
  mention,
  ownersFor,
  sinceLabel,
} from "../src/blast/owners.js";
import type { BlastReport, ChangedArea, ImpactedModule } from "../src/blast/blast.js";

const DAY = 24 * 60 * 60 * 1000;
// Keep fixture dates inside Git's rolling window, with second precision.
const NOW = Math.floor(Date.now() / 1000) * 1000;
const MAINTAINER = { name: "Module Maintainer", email: "maintainer@example.test" };

interface Author {
  name: string;
  email: string;
}

let scratch: string;

before(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "graft-owners-gaps-")));
});

after(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
});

function git(
  root: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    input: options.input,
  });
}

function repo(tag: string): string {
  const root = join(scratch, tag);
  mkdirSync(root);
  git(root, ["init", "-q", "-b", "main"]);
  return root;
}

function commit(
  root: string,
  author: Author,
  daysAgo: number,
  files: Record<string, string>,
  trailers?: string,
): void {
  for (const [file, contents] of Object.entries(files)) {
    writeFileSync(join(root, file), contents);
  }
  git(root, ["add", "--", ...Object.keys(files)]);
  const date = new Date(NOW - daysAgo * DAY).toISOString();
  git(root, [
    "commit", "--quiet", "--no-gpg-sign", "-m", "Update fixture",
    ...(trailers === undefined ? [] : ["-m", trailers]),
  ], {
    env: {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_COMMITTER_DATE: date,
    },
  });
}

function area(label: string, file: string): ChangedArea {
  return {
    label, labelSource: "symbol", key: file, files: [file], seeds: 1,
    tests: "none", testFiles: [], changedTestFiles: [], reached: 0, behavioural: 1,
    unreached: [], seedNames: [],
  };
}

function moduleAt(label: string, file: string): ImpactedModule {
  return { label, labelSource: "symbol", key: file, files: [file], symbols: [], from: ["edited.ts"] };
}

function reportFor(areas: ChangedArea[], modules: ImpactedModule[]): BlastReport {
  return {
    basis: "fixture", depth: 2, changed: [], unindexed: [], deleted: [], seeds: [], impacted: [],
    areas, modules, testModules: [],
  } as unknown as BlastReport;
}

describe("ownership from local Git history", () => {
  test("applies mailmap and credits a commit touching two requested files only once", () => {
    const root = repo("mailmap");
    const web = { name: "Mira Chen", email: "42+Mira-C@users.noreply.github.com" };
    commit(root, { name: "Mira Laptop", email: "mira@example.test" }, 120, { "a.ts": "// old\n" });
    commit(root, web, 0, {
      ".mailmap": "Mira Chen <42+Mira-C@users.noreply.github.com> <mira@example.test>\n",
      "a.ts": "// current\n",
      "b.ts": "// current\n",
    });

    const clock = mock.method(Date, "now", () => NOW);
    try {
      const owners = ownersFor(root, ["a.ts", "b.ts"]);
      assert.equal(owners.length, 1);
      assert.equal(owners[0].name, "Mira Chen");
      assert.equal(mention(owners[0]), "@Mira-C");
      assert.equal(owners[0].commits, 2);
      assert.equal(owners[0].score, 1.5);
      assert.equal(owners[0].last, NOW);
      assert.deepEqual(ownersFor(root, ["a.ts"], { exclude: ["  MIRA-C  "] }), []);
    } finally {
      clock.mock.restore();
    }
  });

  test("automated accounts are dropped even when only the email or bare account name identifies them", () => {
    const root = repo("bots");
    commit(root, MAINTAINER, 2, { "module.ts": "// maintained\n" });
    commit(root, { name: "Dependency Updates", email: "updates[bot]@example.test" }, 1, {
      "module.ts": "// automatic update\n",
    });
    commit(root, { name: "Renovate", email: "automation@example.test" }, 0, {
      "module.ts": "// another automatic update\n",
    });

    const owners = ownersFor(root, ["module.ts"], { now: NOW });
    assert.deepEqual(owners.map(mention), [MAINTAINER.name]);
    assert.equal(owners[0].commits, 1);
  });

  test("a wide area samples its first 80 sorted paths without reordering the caller's files", () => {
    const root = repo("wide");
    const files = Array.from({ length: 81 }, (_, i) => `part-${String(i).padStart(2, "0")}.ts`);
    const scaffold = { name: "Scaffold Author", email: "scaffold@example.test" };
    const outside = { name: "Outside the Sample", email: "outside@example.test" };
    commit(root, scaffold, 2, Object.fromEntries(files.map((file) => [file, "// scaffold\n"])));
    commit(root, MAINTAINER, 1, { [files[79]]: "// last sampled path\n" });
    commit(root, outside, 0, { [files[80]]: "// first omitted path\n" });

    const reversed = [...files].reverse();
    const opts = { now: NOW, exclude: [scaffold.email] };
    assert.deepEqual(ownersFor(root, reversed, opts).map((o) => o.name), [MAINTAINER.name]);
    assert.equal(reversed[0], files[80]);
    assert.equal(reversed[80], files[0]);
    assert.deepEqual(ownersFor(root, [files[80]], opts).map((o) => o.name), [outside.name]);
  });

  test("history older than the window stays out even after the recent author is excluded", () => {
    const root = repo("old-history");
    commit(root, { name: "Original Author", email: "original@example.test" }, 4 * 365, {
      "module.ts": "// original\n",
    });
    commit(root, MAINTAINER, 1, { "module.ts": "// current\n" });

    assert.deepEqual(ownersFor(root, ["module.ts"], { now: NOW }).map((o) => o.name), [MAINTAINER.name]);
    assert.deepEqual(ownersFor(root, ["module.ts"], { now: NOW, exclude: [MAINTAINER.email] }), []);
  });

  test("the walk includes the 400th matching commit but not the 401st", () => {
    const root = repo("commit-cap");
    const oldest = { name: "Outside the Walk", email: "oldest@example.test" };
    const boundary = { name: "At the Boundary", email: "boundary@example.test" };
    const commands: string[] = [];
    // Use one Git process to plant 401 real, recent commits on the same path.
    for (let i = 0; i < 401; i++) {
      const author = i === 0 ? oldest : i === 1 ? boundary : MAINTAINER;
      commands.push(
        "commit refs/heads/main",
        `mark :${i + 1}`,
        `committer ${author.name} <${author.email}> ${NOW / 1000 - 401 + i} +0000`,
        "data <<MESSAGE",
        `Revision ${i + 1}`,
        "MESSAGE",
      );
      if (i > 0) commands.push(`from :${i}`);
      commands.push("M 100644 inline history.ts", "data <<BODY", `// revision ${i + 1}`, "BODY", "");
    }
    git(root, ["fast-import", "--quiet"], { input: [...commands, "done", ""].join("\n") });

    // Excluding the prolific author makes the cutoff observable independently
    // of the share floor. Both boundary authors would qualify if read.
    const owners = ownersFor(root, ["history.ts"], { now: NOW, exclude: [MAINTAINER.email] });
    assert.deepEqual(owners.map((o) => [o.name, o.commits]), [[boundary.name, 1]]);
  });

  test("equal scores are broken by commit count, then by name, before the per-area cap", () => {
    const root = repo("ties");
    const blair = { name: "Blair", email: "blair@example.test" };
    const zoe = { name: "Zoe", email: "zoe@example.test" };
    commit(root, blair, 120, { "tied.ts": "// first\n" });
    commit(root, zoe, 120, { "tied.ts": "// second\n" });
    commit(root, blair, 120, { "tied.ts": "// third\n" });
    commit(root, zoe, 120, { "tied.ts": "// fourth\n" });
    commit(root, { name: "Aaron", email: "aaron@example.test" }, 0, { "tied.ts": "// recent\n" });

    const owners = ownersFor(root, ["tied.ts"], { now: NOW });
    assert.deepEqual(owners.map((o) => [o.name, o.commits, o.score]), [
      ["Blair", 2, 1],
      ["Zoe", 2, 1],
    ]);
  });
});

describe("reviewer suggestions", () => {
  test("carries a handle across areas, discounts affected modules, and keeps only three reviewers", () => {
    const root = repo("reviewers");
    const laptop = { name: "alex-dev", email: "alex@example.test" };
    const web = { name: "Alex Developer", email: "123+Alex-Dev@users.noreply.github.com" };
    const blair = { name: "Blair", email: "blair@example.test" };
    const casey = { name: "Casey", email: "casey@example.test" };
    const avery = { name: "Avery", email: "avery@example.test" };
    commit(root, laptop, 120, { "edited.ts": "// laptop\n" });
    commit(root, blair, 120, { "other.ts": "// other changed area\n" });
    commit(root, casey, 0, { "current.ts": "// recent changed area\n" });
    commit(root, web, 0, { "dependent.ts": "// web edit\n" });
    commit(root, avery, 0, { "consumer.ts": "// another affected module\n" });

    const edited = area("Edited", "edited.ts");
    const dependent = moduleAt("Dependent", "dependent.ts");
    const report = reportFor(
      [edited, area("Other edit", "other.ts"), area("Current edit", "current.ts")],
      [dependent, moduleAt("Consumer", "consumer.ts")],
    );
    attachOwners(root, report, { now: NOW });

    assert.deepEqual(edited.owners?.map(mention), ["alex-dev"]);
    assert.deepEqual(dependent.owners?.map(mention), ["@Alex-Dev"]);
    assert.deepEqual(report.reviewers?.map(mention), ["@Alex-Dev", "Casey", "Avery"]);
    const alex = report.reviewers?.[0];
    assert.deepEqual(alex?.areas, ["Edited", "Dependent"]);
    assert.equal(alex?.commits, 2);
    assert.equal(alex?.score, 1.5);
    assert.equal(alex?.last, NOW);
  });

  test("a range includes co-author names and addresses, including an address-only trailer", () => {
    const root = repo("coauthors");
    const partner = { name: "Pair Partner", email: "pair@example.test" };
    commit(root, partner, 1, { "module.ts": "// before the PR\n" });
    commit(root, MAINTAINER, 0, { "module.ts": "// pair-programmed change\n" }, [
      "Co-authored-by: Pair Partner <pair@example.test>",
      "Co-authored-by: <second@example.test>",
    ].join("\n"));

    const authors = diffAuthors(root, "HEAD^");
    assert.deepEqual([...authors].sort(), [
      MAINTAINER.name, MAINTAINER.email, partner.name, partner.email, "second@example.test",
    ].sort());
    assert.deepEqual(ownersFor(root, ["module.ts"], { now: NOW, exclude: authors }), []);
    assert.deepEqual(diffAuthors(root, "refs/heads/unavailable-base"), []);
  });

  test("a checkout removed before the ownership pass leaves no suggestions or local identity", () => {
    const missing = join(scratch, "checkout-no-longer-present");
    const edited = area("Edited", "edited.ts");
    const dependent = moduleAt("Dependent", "dependent.ts");
    const report = reportFor([edited], [dependent]);

    attachOwners(missing, report);

    assert.deepEqual(edited.owners, []);
    assert.deepEqual(dependent.owners, []);
    assert.deepEqual(report.reviewers, []);
    assert.deepEqual(localIdentity(missing), []);
  });
});

test("GitHub handles accept trimmed noreply addresses but reject invalid login boundaries", () => {
  assert.equal(githubHandle(" \t123+Reviewer-9@USERS.NOREPLY.GITHUB.COM\n"), "Reviewer-9");
  const maxLength = "a".repeat(39);
  assert.equal(githubHandle(`${maxLength}@users.noreply.github.com`), maxLength);
  for (const login of ["-reviewer", "reviewer-", "reviewer--9", "reviewer_9", `${maxLength}a`]) {
    assert.equal(githubHandle(`${login}@users.noreply.github.com`), null, login);
  }
});

test("default recency labels use the current clock, while the exported date is UTC", () => {
  const instant = Date.parse("2026-01-02T00:15:00+02:00");
  const clock = mock.method(Date, "now", () => instant + DAY);
  try {
    assert.equal(sinceLabel(instant), "yesterday");
    assert.equal(sinceLabel(instant + 2 * DAY), "today");
    assert.equal(isoDay(instant), "2026-01-01");
  } finally {
    clock.mock.restore();
  }
});
