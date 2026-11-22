/**
 * Gap coverage for src/app/checkout.ts.
 *
 * Covers the optional parts of a checkout request: no log callback, no token,
 * and an `api` with a trailing slash. It also covers the `/head` fallback when
 * the head commit landed by fast-forward, which leaves no merge commit to diff
 * against, and the token-less path through `redact`.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutPullRequest, redact } from "../src/app/checkout.js";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@e",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@e",
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv });

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function commitFile(work: string, file: string, content: string, msg: string): void {
  writeFileSync(join(work, file), content);
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", msg);
}

/** A fake GitHub: a mirror clone of a work repo shaped by `build`. */
function makeOrigin(repo: string, build: (work: string) => void): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), "graft-gaps-origin-"));
  roots.push(root);
  const work = join(root, "work");
  execFileSync("git", ["init", "--quiet", "-b", "main", work], { stdio: ["ignore", "pipe", "pipe"], env: gitEnv });
  git(work, "config", "user.email", "t@e");
  git(work, "config", "user.name", "t");
  commitFile(work, "base.txt", "base\n", "base");
  build(work);
  execFileSync("git", ["clone", "--quiet", "--mirror", work, join(root, `${repo}.git`)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv,
  });
  return { root, repo };
}

/** Scratch checkouts left behind in tmpdir for a given repo name. */
const leftovers = (repo: string): string[] =>
  readdirSync(tmpdir()).filter((n) => n.startsWith(`graft-app-.-${repo}-`));

describe("redact", () => {
  test("an empty token leaves the text untouched", () => {
    const text = "fatal: could not read from x-access-token:abc";
    assert.equal(redact(text, ""), text);
  });

  test("both the raw token and its basic-auth encoding are replaced", () => {
    const token = "ghs_abc123";
    const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
    const out = redact(`raw ${token} and header Basic ${encoded} and ${token} again`, token);
    assert.equal(out, "raw [token] and header Basic [token] and [token] again");
    assert.ok(!out.includes(token));
    assert.ok(!out.includes(encoded));
  });
});

describe("checkoutPullRequest gaps", () => {
  test("open PR with no token, no log callback and a trailing-slash api lands on the merge ref", () => {
    const repo = "gapsopen";
    const origin = makeOrigin(repo, (work) => {
      git(work, "checkout", "--quiet", "-b", "feature");
      commitFile(work, "feature.txt", "feature\n", "feature");
      git(work, "checkout", "--quiet", "main");
      git(work, "update-ref", "refs/pull/3/head", "refs/heads/feature");
      git(work, "merge", "--quiet", "--no-ff", "-m", "merge", "feature");
      git(work, "update-ref", "refs/pull/3/merge", "HEAD");
      git(work, "reset", "--hard", "--quiet", "HEAD~1");
    });

    const c = checkoutPullRequest({
      owner: ".",
      repo: origin.repo,
      number: 3,
      baseRef: "main",
      token: "",
      api: `file://${origin.root}/`,
    });
    try {
      assert.equal(c.ref, "merge");
      assert.equal(c.base, "refs/graft/base");
      assert.equal(readFileSync(join(c.dir, "feature.txt"), "utf8"), "feature\n");
      const remote = git(c.dir, "remote", "get-url", "origin").trim();
      assert.ok(!remote.includes(`${origin.root}//`), "trailing slash on api is stripped");
      assert.ok(remote.endsWith(`${repo}.git`));
      const diff = git(c.dir, "diff", "--name-only", c.base, "HEAD").trim();
      assert.equal(diff, "feature.txt");
    } finally {
      c.cleanup();
    }
    assert.equal(existsSync(c.dir), false, "cleanup removes the working tree");
  });

  test("merged PR without a log callback still falls back to the head ref with the right basis", () => {
    const repo = "gapsmerged";
    const origin = makeOrigin(repo, (work) => {
      git(work, "checkout", "--quiet", "-b", "feature");
      commitFile(work, "feature.txt", "feature\n", "feature");
      git(work, "checkout", "--quiet", "main");
      git(work, "update-ref", "refs/pull/9/head", "refs/heads/feature");
      commitFile(work, "base.txt", "base\nmore\n", "other work");
      git(work, "merge", "--quiet", "--no-ff", "-m", "Merge pull request #9", "feature");
      git(work, "commit", "--quiet", "--allow-empty", "-m", "after");
      git(work, "branch", "-D", "feature");
    });

    const c = checkoutPullRequest({
      owner: ".",
      repo: origin.repo,
      number: 9,
      baseRef: "main",
      token: "ghs_unused_token",
      api: `file://${origin.root}`,
    });
    try {
      assert.equal(c.ref, "head");
      assert.equal(c.base, "refs/graft/base");
      assert.equal(git(c.dir, "diff", "--name-only", "refs/graft/base...HEAD").trim(), "feature.txt");
      assert.equal(readFileSync(join(c.dir, "base.txt"), "utf8"), "base\n");
    } finally {
      c.cleanup();
    }
    assert.equal(existsSync(c.dir), false);
  });

  test("a fast-forward-merged PR has no diff basis: fails at diff base and cleans up", () => {
    const repo = "gapsfastfwd";
    const origin = makeOrigin(repo, (work) => {
      // An earlier landing on main that is NOT on the head's ancestry path.
      git(work, "checkout", "--quiet", "-b", "early");
      commitFile(work, "early.txt", "early\n", "early");
      git(work, "checkout", "--quiet", "main");
      git(work, "merge", "--quiet", "--no-ff", "-m", "merge early", "early");

      // The PR branch lands by fast-forward: no merge commit brings it in.
      git(work, "checkout", "--quiet", "-b", "feature");
      commitFile(work, "feature.txt", "feature\n", "feature");
      git(work, "checkout", "--quiet", "main");
      git(work, "update-ref", "refs/pull/5/head", "refs/heads/feature");
      git(work, "merge", "--quiet", "--ff-only", "feature");

      // A later merge whose first parent already contains the head commit.
      git(work, "checkout", "--quiet", "-b", "topic");
      commitFile(work, "topic.txt", "topic\n", "topic");
      git(work, "checkout", "--quiet", "main");
      commitFile(work, "base.txt", "base\nlater\n", "later main work");
      git(work, "merge", "--quiet", "--no-ff", "-m", "merge topic", "topic");

      git(work, "branch", "-D", "feature", "early", "topic");
    });

    const logs: string[] = [];
    assert.throws(
      () =>
        checkoutPullRequest({
          owner: ".",
          repo: origin.repo,
          number: 5,
          baseRef: "main",
          token: "",
          api: `file://${origin.root}`,
          log: (m) => logs.push(m),
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^checkout \.\/gapsfastfwd#5 failed at diff base: /);
        assert.match(err.message, /refs\/pull\/5\/merge is gone and refs\/pull\/5\/head gives no diff against main/);
        assert.match(err.message, /within 550 commits/);
        assert.match(err.message, /fast-forward merge/);
        return true;
      },
    );
    assert.deepEqual(logs, [], "nothing is logged as a successful review");
    assert.deepEqual(leftovers(repo), [], "the failed checkout removed its scratch tree");
  });

  test("a missing repository fails at fetch with the token redacted and both attempts named", () => {
    const repo = "gapsmissing";
    const root = mkdtempSync(join(tmpdir(), "graft-gaps-empty-"));
    roots.push(root);
    const token = "ghs_very_secret";
    assert.throws(
      () =>
        checkoutPullRequest({
          owner: ".",
          repo,
          number: 11,
          baseRef: "main",
          token,
          api: `file://${root}`,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^checkout \.\/gapsmissing#11 failed at fetch: /);
        assert.match(err.message, /falling back to refs\/pull\/11\/head: /);
        assert.ok(!err.message.includes(token));
        return true;
      },
    );
    assert.deepEqual(leftovers(repo), []);
  });
});
