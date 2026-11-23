import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkFamilyOf, classifyCheck, fallbackOnly, type RunFacts } from "../src/trace/checks.js";

const SHA = "a1b2c3d";
const facts: RunFacts = { versions: [], shas: [SHA], pushedBranches: [] };
const exitedZero = { failed: false, isError: false };

function check(cmd: string, output: string) {
  return classifyCheck(cmd, output, exitedZero, facts, null);
}

describe("GitHub check commands", () => {
  test("records an explicit PR number and also checks the current branch's PR", () => {
    assert.deepEqual(check("gh pr checks 42", "build\tpass\t24s\nlint\tskipping\t0s\n"), {
      family: "gh-checks", passed: true, facts: { pr: "42" },
    });
    assert.deepEqual(check("gh pr checks", "build\tpass\t24s\nlint\tpending\t0s\n"), {
      family: "gh-checks", passed: false, facts: {},
    });
  });

  test("recognizes watch and view commands for a specific workflow run", () => {
    assert.deepEqual(
      check("gh run watch 123456 --exit-status", "Run CI (123456) completed with 'success'\n"),
      { family: "gh-checks", passed: true, facts: {} },
    );
    assert.deepEqual(
      check("gh run view --repo=example/widgets 123456 --json status,conclusion",
        '{"status":"completed","conclusion":"success"}'),
      { family: "gh-checks", passed: true, facts: {} },
    );
  });
});

const INSPECT = "vercel inspect https://widgets.example.test";
const STATUSES = `gh api repos/example/widgets/commits/${SHA}/statuses`;

describe("one-shot deploy status", () => {
  test("reads a labeled status even when more deployment details follow it", () => {
    assert.deepEqual(check(INSPECT, "  status: Ready\r\n  target: production\r\n"), {
      family: "deploy", passed: true, facts: { state: "Ready" },
    });
  });

  test("reads the status glyph in a deployment list row", () => {
    const row = "  2m  https://widgets.example.test  ● Ready  Production  4s\n";
    assert.deepEqual(check("vercel ls", row), {
      family: "deploy", passed: true, facts: { state: "Ready" },
    });
  });

  test("reads the quoted state printed by jq and retains the commit from the command", () => {
    assert.deepEqual(check(`${STATUSES} | jq '.[0].state'`, '"success"\n\n'), {
      family: "deploy", passed: true, facts: { sha: SHA, state: "success" },
    });
  });

  test("a pending context prevents a commit's statuses from passing", () => {
    const output = JSON.stringify([
      { context: "deploy/web", state: "success" },
      { context: "deploy/worker", state: "pending" },
    ]);
    assert.deepEqual(check(STATUSES, output), {
      family: "deploy", passed: false, facts: { sha: SHA },
    });
  });

  test("empty output does not prove a deployment is ready", () => {
    assert.deepEqual(check(INSPECT, "\n  \n"), {
      family: "deploy", passed: false, facts: {},
    });
  });
});

const POLL = `for attempt in 1 2 3; do ${INSPECT}; sleep 2; done`;

describe("deploy polling", () => {
  test("uses the last reported state, not earlier attempts or words in a trailing URL", () => {
    const output = [
      "  status: ● Building",
      "  status: ● Ready",
      "  url: https://widgets.example.test/building",
      "",
    ].join("\r\n");
    assert.deepEqual(check(POLL, output), {
      family: "deploy", passed: true, facts: { state: "Ready" },
    });
  });

  test("reports a terminal poll failure, but no state when only URLs were printed", () => {
    assert.deepEqual(check(POLL, "  status: ● Building\n  status: ● Canceled\n"), {
      family: "deploy", passed: false, facts: { state: "Canceled" },
    });
    assert.deepEqual(check(POLL, "https://widgets.example.test/ready\n"), {
      family: "deploy", passed: false, facts: {},
    });
  });

  test("a later one-shot status read takes precedence over polling semantics", () => {
    const output = "  status: ● Building\n  status: ● Ready\n";
    assert.deepEqual(check(POLL, output), {
      family: "deploy", passed: true, facts: { state: "Ready" },
    });
    assert.deepEqual(check(`${POLL}; ${INSPECT}`, output), {
      family: "deploy", passed: false, facts: {},
    });
  });

  test("a later push takes precedence only when it can prove the job", () => {
    const cmd = `${POLL}; git push origin main`;
    assert.equal(checkFamilyOf(cmd, "ship"), "push");
    assert.equal(checkFamilyOf(cmd, null), "deploy");
  });
});

describe("fallback commands", () => {
  test("distinguishes a top-level success fallback from quoted text and a retry", () => {
    assert.equal(fallbackOnly('npm test || echo "Tests failed"'), true);
    assert.equal(fallbackOnly('npm test -- --testNamePattern="read || write"'), false);
    assert.equal(fallbackOnly("npm test || npm run test:retry"), false);
  });

  test("a fallback makes the test check non-passing without discarding its count", () => {
    const output = "# tests 3\n# pass 3\n# fail 0\n";
    assert.deepEqual(check("npm test", output), {
      family: "tests", passed: true, facts: { passedCount: 3 },
    });
    assert.deepEqual(check("npm test || true", output), {
      family: "tests", passed: false, facts: { passedCount: 3 },
    });
  });
});
