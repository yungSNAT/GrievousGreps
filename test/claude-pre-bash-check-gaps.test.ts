import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  branchConflicts,
  shipCheck,
  shipReason,
  SHIP_CHECK_LEAD,
  type ShipConflict,
} from "../src/claude/pre-bash-check.js";

// A preload module the child `node <cli> check --json` runs before its entry:
// it prints a canned `trail check --json` answer and exits, so the real CLI
// (and the network) are never involved.
const PRELOAD = `
import { writeSync } from 'node:fs';
const out = process.env.FAKE_CHECK_OUT;
if (out !== undefined) {
  writeSync(1, out);
} else {
  writeSync(1, JSON.stringify({
    findings: [{
      file: process.cwd(),
      verdict: 'conflict',
      summary: [process.env.TRAIL_NO_FETCH, process.env.TRAIL_NO_HOOKS, process.env.TRAIL_INVOKED_AS].join('|'),
      source: { title: process.argv.slice(2).join(' ') },
    }],
  }));
}
process.exit(0);
`;

let scratch: string;
let repo: string;
let nodeOptions: string;

function envWith(out: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: nodeOptions };
  if (out === undefined) delete env.FAKE_CHECK_OUT;
  else env.FAKE_CHECK_OUT = out;
  return env;
}

function withProcessEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const findings = {
  findings: [
    { file: "src/a.ts", line: 3, verdict: "conflict", summary: "uses sync IO", source: { title: "No sync IO", author: "ann", path: "learnings/no-sync-io.md" } },
    { file: "src/b.ts", verdict: "aligned", summary: "fine", source: { title: "Other" } },
    { file: "src/c.ts", verdict: "conflict", summary: "retries forever", source: { title: "Bounded retries" } },
  ],
};

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "pre-bash-check-gaps-"));
  repo = mkdtempSync(join(scratch, "repo-"));
  const preload = join(scratch, "fake-check.mjs");
  writeFileSync(preload, PRELOAD);
  nodeOptions = `--import ${pathToFileURL(preload).href}`;
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("branchConflicts", () => {
  test("keeps only the findings whose verdict is conflict", () => {
    const got = branchConflicts(repo, envWith(JSON.stringify(findings)));
    assert.ok(got);
    assert.equal(got.length, 2);
    assert.deepEqual(got.map((f) => f.file), ["src/a.ts", "src/c.ts"]);
    assert.equal(got[0].source.path, "learnings/no-sync-io.md");
  });

  test("a report without findings means no conflicts", () => {
    assert.deepEqual(branchConflicts(repo, envWith("{}")), []);
    assert.deepEqual(branchConflicts(repo, envWith('  {"findings":[]}\n')), []);
  });

  test("output that is not a JSON object means the check couldn't say", () => {
    assert.equal(branchConflicts(repo, envWith("nothing to report")), null);
    assert.equal(branchConflicts(repo, envWith("")), null);
  });

  test("malformed JSON fails open with null", () => {
    assert.equal(branchConflicts(repo, envWith("{ not json")), null);
  });

  test("runs `check --json` in the dir, with no fetch, no hooks and the trail name", () => {
    const got = branchConflicts(repo, envWith(undefined));
    assert.ok(got);
    assert.equal(got.length, 1);
    assert.equal(basename(got[0].file), basename(repo));
    assert.equal(got[0].summary, "1|1|trail");
    assert.equal(got[0].source.title, "check --json");
  });

  test("uses process.env when no env is given", () => {
    const got = withProcessEnv(
      { NODE_OPTIONS: nodeOptions, FAKE_CHECK_OUT: JSON.stringify(findings) },
      () => branchConflicts(repo),
    );
    assert.ok(got);
    assert.deepEqual(got.map((f) => f.summary), ["uses sync IO", "retries forever"]);
  });
});

describe("shipReason", () => {
  const one: ShipConflict = {
    file: "src/a.ts",
    line: 7,
    verdict: "conflict",
    summary: "blocks the loop",
    source: { title: "No sync IO", author: "ann", path: "learnings/team/no-sync-io.md" },
  };

  test("a single conflict before a PR, as a warning by default", () => {
    const r = shipReason([one], "gh pr create --fill");
    const lines = r.split("\n");
    assert.equal(lines[0], `${SHIP_CHECK_LEAD} 1 conflict with the team's learnings before opening this PR:`);
    assert.equal(lines[1], "- src/a.ts:7: blocks the loop (No sync IO, ann)");
    assert.match(lines[2], /^It goes ahead;/);
    assert.match(lines[2], /--replaces no-sync-io\.md/);
  });

  test("several conflicts before a push, as a stop, with no source details", () => {
    const bare: ShipConflict = { file: "x.ts", verdict: "conflict", summary: "s", source: {} };
    const r = shipReason([bare, bare], "git push origin main", true);
    const lines = r.split("\n");
    assert.match(lines[0], /2 conflicts with the team's learnings before this push:$/);
    assert.equal(lines[1], "- x.ts: s");
    assert.match(lines[3], /^Fix the change/);
    assert.doesNotMatch(r, /--replaces/);
  });

  test("lists at most five conflicts and calls anything else a commit", () => {
    const many = Array.from({ length: 7 }, (_, i): ShipConflict => ({ file: `f${i}.ts`, verdict: "conflict", summary: "x", source: {} }));
    const lines = shipReason(many, "git commit -m wip").split("\n");
    assert.match(lines[0], /7 conflicts .* before this commit:$/);
    assert.equal(lines.filter((l) => l.startsWith("- ")).length, 5);
  });
});

describe("shipCheck", () => {
  const conflict: ShipConflict = { file: "src/a.ts", verdict: "conflict", summary: "bad", source: { title: "Rule" } };
  const trailEnv = (): NodeJS.ProcessEnv => ({ ...process.env, TRAIL_INVOKED_AS: "trail" });

  test("warns once per set of conflicts in a session, then lets it through", () => {
    const env = trailEnv();
    const input = { session_id: `warn-${Date.now()}` };
    const first = shipCheck(input, repo, "git commit -m x", () => [conflict], env);
    assert.ok(first && "warn" in first);
    assert.match(first.warn, /^trail check found 1 conflict/);
    assert.equal(shipCheck(input, repo, "git commit -m x", () => [conflict], env), null);
  });

  test("denies once when stops is on", () => {
    const env = trailEnv();
    const input = { sessionId: `stop-${Date.now()}` };
    const first = shipCheck(input, repo, "git push", () => [conflict], env, true);
    assert.ok(first && "permissionDecision" in first);
    assert.equal(first.permissionDecision, "deny");
    assert.match(first.reason, /before this push/);
  });

  test("no conflicts or an unknown result means no decision", () => {
    const env = trailEnv();
    assert.equal(shipCheck({}, repo, "git commit", () => [], env), null);
    assert.equal(shipCheck({}, repo, "git commit", () => null, env), null);
  });

  test("uses the real branch check and process.env by default", () => {
    const got = withProcessEnv(
      {
        NODE_OPTIONS: nodeOptions,
        FAKE_CHECK_OUT: JSON.stringify(findings),
        TRAIL_INVOKED_AS: "trail",
      },
      () => shipCheck({ conversation_id: `default-${Date.now()}` }, repo, "gh pr create"),
    );
    assert.ok(got && "warn" in got);
    assert.match(got.warn, /2 conflicts with the team's learnings before opening this PR/);
    assert.match(got.warn, /- src\/a\.ts:3: uses sync IO \(No sync IO, ann\)/);
  });
});
