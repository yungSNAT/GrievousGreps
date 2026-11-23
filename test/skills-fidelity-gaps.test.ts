/**
 * Gap tests for src/skills/fidelity.ts: programVerb on its own, and the
 * fidelityOf paths that need no matched calls: handed steps, the block's own
 * check, the skill's check filled with params, `at`, a given repo key, and
 * non-shell tool calls (which are filtered out before any matching).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fidelityCounts, fidelityOf, programVerb } from "../src/skills/fidelity.js";
import type { RunCall } from "../src/trace/types.js";

type Step = { n: number; cmd: string; gated: string | null; bg: boolean; wait: boolean };
const step = (n: number, cmd: string, gated: string | null = null): Step => ({ n, cmd, gated, bg: false, wait: false });

const skillOf = (steps: Step[], check: string | null = null) =>
  ({ steps, check, params: [] }) as unknown as Parameters<typeof fidelityOf>[0];

describe("programVerb", () => {
  test("program and the first word after it that is not a flag", () => {
    assert.equal(programVerb("npm publish --access public"), "npm publish");
    assert.equal(programVerb("git push origin main"), "git push");
    assert.equal(programVerb("npm --silent run build"), "npm run");
  });

  test("git -C / -c take a value that is skipped, not read as the verb", () => {
    assert.equal(programVerb("git -C ../cli push origin main"), "git push");
    assert.equal(programVerb("git -c user.name=dev commit -m release"), "git commit");
  });

  test("only flags after the program: the program alone", () => {
    assert.equal(programVerb("npm --version"), "npm");
    assert.equal(programVerb("git --no-pager"), "git");
  });

  test("no program: null", () => {
    assert.equal(programVerb(""), null);
  });
});

describe("fidelityOf without matched calls", () => {
  const release = [step(1, "npm run build"), step(2, "npm publish --access public", "publish"), step(3, "git push origin main")];
  const filled = release.map((s) => s.cmd);

  test("a gated step handed to the person counts as ran; out-of-range and non-integer hands are ignored", () => {
    const inj = {
      params: {},
      steps: filled,
      handed: [{ n: 2 }, { n: 9 }, { n: 0 }, { n: 1.5 }],
    } as unknown as Parameters<typeof fidelityOf>[1];
    const f = fidelityOf(skillOf(release), inj, []);
    assert.deepEqual(f.ran, [2]);
    assert.deepEqual(f.missing, [1, 3]);
    assert.deepEqual(f.extra, []);
    assert.deepEqual(f.changed, []);
    assert.deepEqual(fidelityCounts(f), { ran: 1, missing: 2, extra: 0, changed: 0 });
  });

  test("the block's own check is never missing as a step", () => {
    const tests = [step(1, "npm ci"), step(2, "npm test")];
    const withCheck = fidelityOf(skillOf(tests), { params: {}, steps: ["npm ci", "npm test"], check: "npm test" } as never, []);
    assert.deepEqual(withCheck.missing, [1]);
    const without = fidelityOf(skillOf(tests), { params: {}, steps: ["npm ci", "npm test"] }, []);
    assert.deepEqual(without.missing, [1, 2]);
  });

  test("the skill's check is filled with the params when the block gives none, and steps come from the skill", () => {
    const versioned = [step(1, "npm run build"), step(2, "npm version {version} --no-git-tag-version")];
    const f = fidelityOf(
      skillOf(versioned, "npm version {version} --no-git-tag-version"),
      { params: { version: "0.22.4" }, steps: [] },
      [],
    );
    assert.deepEqual(f.missing, [1]);
    assert.deepEqual(f.ran, []);
  });

  test("missing params on the block: an empty set is used", () => {
    const f = fidelityOf(skillOf(release), { params: undefined, steps: filled } as never, []);
    assert.deepEqual(f, { ran: [], missing: [1, 2, 3], extra: [], changed: [] });
  });

  test("non-shell tool calls never match, never count as extra, with `at` and a repo key given", () => {
    const at = "2025-03-01T10:00:00.000Z";
    const reads = [
      { id: "toolu_read1", tool: "Read", at: "2025-03-01T10:00:10.000Z", failed: false, kind: "look", cwd: "/w", key: "k" },
      { id: "toolu_edit1", tool: "Edit", at: "2025-03-01T09:00:00.000Z", failed: false, kind: "step", cwd: "/w", key: "k" },
    ] as unknown as RunCall[];
    const f = fidelityOf(
      skillOf(release),
      { params: {}, steps: filled, at } as never,
      reads,
      { repoKey: "github.com/acme/cli", repoRoot: "/w", home: "/h" },
    );
    assert.deepEqual(f, { ran: [], missing: [1, 2, 3], extra: [], changed: [] });
  });

  test("a handed step stays ran even with only non-shell calls in the run", () => {
    const reads = [{ id: "toolu_read2", tool: "Read", at: "2025-03-01T10:00:10.000Z" }] as unknown as RunCall[];
    const f = fidelityOf(
      skillOf(release),
      { params: {}, steps: filled, handed: [{ n: 2 }, { n: 3 }] } as never,
      reads,
    );
    assert.deepEqual(f.ran, [2, 3]);
    assert.deepEqual(f.missing, [1]);
  });
});
