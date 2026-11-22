import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  changedDeny,
  checkSkillsUpdate,
  cliUpdate,
  findUpdateReceipt,
  UPDATE_DENY,
  updateGate,
} from "../src/skills/update-gate.js";
import { receiptPath } from "../src/skills/receipts.js";
import { skillsOn } from "../src/skills/settings.js";
import type { UpdateReceipt } from "../src/skills/types.js";
import type { GateCtx } from "../src/trace/skill-session.js";
import type { SkillSessionState } from "../src/trace/types.js";
import { runCli, tmpRepo } from "./helpers.js";

const NOW = new Date("2025-02-03T12:00:00.000Z");
const NAME = "shop-check";
const SESSION = "29c8d39c-42fe-4656-a7cd-030015da48eb";
const OFFER = "fedcba9876543210";
const BASE = `sha256:${"a".repeat(64)}`;
const SHA = "b".repeat(16);
const roots: string[] = [];

before(() => {
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected fetch in an offline update-gate test");
  });
});

after(() => {
  mock.restoreAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(tag: string) {
  const dir = tmpRepo(`update-gate-${tag}`);
  roots.push(dir);
  const trail = join(dir, "trail");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    TRAIL_HOME: trail,
    CLAUDE_CONFIG_DIR: join(dir, ".claude"),
    CODEX_HOME: join(dir, ".codex"),
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_DATA_HOME: join(dir, "data"),
    XDG_CACHE_HOME: join(dir, "cache"),
    XDG_STATE_HOME: join(dir, "state"),
  };
  return { dir, env, receipts: join(trail, "receipts") };
}

function payload(command: unknown) {
  return { tool_name: "Bash", tool_use_id: "toolu_testupdate01", tool_input: { command } };
}

// Intentionally incomplete: the hook must recognize the update command even
// when its required --offer argument is missing.
const incomplete = `trail skills update ${NAME}`;

function hook(tag: string) {
  const { dir, env, receipts } = scratch(tag);
  const transcriptPath = join(dir, `${SESSION}.jsonl`);
  writeFileSync(transcriptPath, "");
  const ctx: GateCtx = {
    sessionId: SESSION,
    sessionHash: "0123456789ab",
    host: "claude",
    tier: "A",
    entry: "interactive",
    permissionMode: null,
    subagent: false,
    fold: true,
    learn: true,
    learnOff: null,
    dir,
    checkout: dir,
    repoKey: "acme/shop",
    transcriptPath,
    env,
    now: NOW,
  };
  const state = { pendingOffer: null } as SkillSessionState;
  const check = (input: unknown, overrides: Partial<GateCtx> = {}) =>
    checkSkillsUpdate(input, { ...ctx, ...overrides }, state, null);
  return { check, receipts };
}

const deny = (reason: string) => ({ permissionDecision: "deny", reason });

describe("the update hook's early decisions", () => {
  test("ignores non-update calls but refuses to read an oversized update", () => {
    const { check, receipts } = hook("commands");
    assert.equal(check(undefined), null);
    assert.equal(check(payload(123)), null);
    assert.equal(check(payload(`trail skills show ${NAME}`)), null);
    const longCommand = `${incomplete} --offer ${"a".repeat(64 * 1024)}`;
    assert.deepEqual(check(payload(longCommand)), deny(UPDATE_DENY.tooLong));
    assert.equal(existsSync(receipts), false);
  });

  test("reports invalid arguments when the update omits its offer ID", () => {
    const { check, receipts } = hook("flags");
    assert.deepEqual(check(payload(incomplete)), deny(UPDATE_DENY.flags));
    assert.deepEqual(check(payload(`${incomplete} --offer`)), deny(UPDATE_DENY.flags));
    assert.equal(existsSync(receipts), false);
  });

  test("checks session eligibility before reporting invalid arguments", () => {
    const { check, receipts } = hook("session");
    const input = payload(incomplete);
    assert.deepEqual(check(input, { subagent: true }), deny(UPDATE_DENY.subagent));
    assert.deepEqual(check(input, { fold: false }), deny(UPDATE_DENY.noPerson));
    assert.deepEqual(check(input, { learn: false }), deny(UPDATE_DENY.noPerson));
    assert.equal(existsSync(receipts), false);
  });

  test("a hook call without a session cannot create a receipt using the default environment", () => {
    const { dir, env, receipts } = scratch("default-env");
    const saved = process.env.TRAIL_HOME;
    process.env.TRAIL_HOME = env.TRAIL_HOME!;
    try {
      assert.equal(updateGate(payload(incomplete), dir), null);
      assert.equal(existsSync(receipts), false);
    } finally {
      if (saved === undefined) delete process.env.TRAIL_HOME;
      else process.env.TRAIL_HOME = saved;
    }
  });

  test("the changed-file denial directs the person to show the affected skill", () => {
    assert.equal(
      changedDeny(NAME),
      `trail · not changed: ${NAME} changed since Trail showed this, so nothing changed. The person can see it with: trail skills show ${NAME}`,
    );
  });
});

const iso = (delta: number) => new Date(NOW.getTime() + delta).toISOString();

function receipt(dir: string, overrides: Partial<UpdateReceipt> = {}): UpdateReceipt {
  return {
    v: 1,
    kind: "update",
    session: SESSION,
    transcriptPath: join(dir, "missing", `${SESSION}.jsonl`),
    toolUseId: "toolu_testupdate01",
    host: "claude",
    offerId: OFFER,
    skillId: NAME,
    name: NAME,
    runId: "abcdef0123456789",
    op: "update",
    baseHash: BASE,
    proposalSha: SHA,
    typed: { offset: 123, lineSha: "c".repeat(64) },
    at: iso(-1000),
    usedAt: null,
    ...overrides,
  };
}

function put(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value));
}

describe("finding an unused update receipt", () => {
  test("returns null when there is no receipts directory", () => {
    const { env } = scratch("no-receipts");
    assert.equal(findUpdateReceipt(OFFER, NAME, NOW, env), null);
  });

  test("chooses the newest matching receipt by timestamp, not filename", () => {
    const { dir, env, receipts } = scratch("newest");
    mkdirSync(receipts, { recursive: true });
    const newest = receipt(dir, { at: iso(-2000), op: "extend" });
    put(join(receipts, "00-older.update.json"), receipt(dir, { session: "older", at: iso(-5000) }));
    put(join(receipts, "10-newest.update.json"), newest);
    put(join(receipts, "20-older.update.json"), receipt(dir, { session: "oldest", at: iso(-6000) }));
    put(join(receipts, "30-used.update.json"), receipt(dir, { at: iso(-1000), usedAt: iso(0) }));
    put(join(receipts, "40-wrong-offer.update.json"), receipt(dir, { offerId: "0123456789abcdef" }));
    put(join(receipts, "50-wrong-name.update.json"), receipt(dir, { name: "other-skill" }));
    put(join(receipts, "60-save.json"), receipt(dir, { at: iso(0) }));
    mkdirSync(join(receipts, "70-directory.update.json"));

    const found = findUpdateReceipt(OFFER, NAME, NOW, env);
    assert.ok(found);
    assert.equal(found.session, newest.session);
    assert.equal(found.at, newest.at);
    assert.equal(found.op, "extend");
    assert.equal(found.usedAt, null);
  });

  test("accepts the exact freshness limits but rejects dates just outside them", () => {
    const { dir, env, receipts } = scratch("freshness");
    mkdirSync(receipts, { recursive: true });
    const path = join(receipts, "one.update.json");

    for (const delta of [-30 * 60_000, 5000]) {
      put(path, receipt(dir, { at: iso(delta) }));
      assert.equal(findUpdateReceipt(OFFER, NAME, NOW, env)?.at, iso(delta));
    }
    for (const at of [iso(-30 * 60_000 - 1), iso(5001), "not-a-date"]) {
      put(path, receipt(dir, { at }));
      assert.equal(findUpdateReceipt(OFFER, NAME, NOW, env), null, at);
    }
  });

  test("rejects receipts with missing or malformed update pins", () => {
    const { dir, env, receipts } = scratch("shape");
    mkdirSync(receipts, { recursive: true });
    const path = join(receipts, "one.update.json");
    const valid = receipt(dir);

    put(path, valid);
    assert.equal(findUpdateReceipt(OFFER, NAME, NOW, env)?.proposalSha, SHA);

    const invalid: [string, unknown][] = [
      ["null", null],
      ["array", [valid]],
      ["wrong kind", { ...valid, kind: "save" }],
      ["offer ID", { ...valid, offerId: 1 }],
      ["skill ID", { ...valid, skillId: undefined }],
      ["name", { ...valid, name: null }],
      ["run ID", { ...valid, runId: undefined }],
      ["split operation", { ...valid, op: "split" }],
      ["base hash", { ...valid, baseHash: undefined }],
      ["proposal SHA", { ...valid, proposalSha: undefined }],
      ["timestamp", { ...valid, at: undefined }],
      ["typed offset", { ...valid, typed: { ...valid.typed, offset: "123" } }],
      ["typed hash", { ...valid, typed: { offset: 123 } }],
      ["use marker", { ...valid, usedAt: false }],
    ];
    for (const [label, value] of invalid) {
      put(path, value);
      assert.equal(findUpdateReceipt(OFFER, NAME, NOW, env), null, label);
    }
    writeFileSync(path, '{"v":1,');
    assert.equal(findUpdateReceipt(OFFER, NAME, NOW, env), null, "truncated JSON");
  });
});

test("the CLI consumes an eligible receipt whose conversation it cannot read", () => {
  const { dir, env, receipts } = scratch("missing-conversation");
  // runCli captures stdio in pipes. Simulate a person's terminal for the
  // separate, person-only setup command, without changing the test runner.
  const setupEnv = { ...env, TERM: "xterm" };
  for (const key of Object.keys(setupEnv)) {
    if (
      /^(?:CLAUDE|CODEX|CURSOR|COPILOT|CI$|CONTINUOUS_INTEGRATION$|GITHUB_ACTIONS$)/i.test(key) &&
      key !== "CLAUDE_CONFIG_DIR" && key !== "CODEX_HOME"
    ) {
      delete (setupEnv as NodeJS.ProcessEnv)[key];
    }
  }
  const terminal = encodeURIComponent(`
    for (const stream of [process.stdin, process.stdout, process.stderr]) {
      Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
    }
    globalThis.fetch = async () => { throw new Error("Unexpected fetch while enabling skills"); };
  `);
  const enabled = runCli(["skills", "on"], {
    home: dir,
    env: {
      ...setupEnv,
      NODE_OPTIONS: [env.NODE_OPTIONS, `--import=data:text/javascript,${terminal}`].filter(Boolean).join(" "),
    },
  });
  assert.equal(enabled.status, 0, enabled.describe());
  assert.equal(skillsOn(env), true);

  mkdirSync(receipts, { recursive: true });
  const path = receiptPath(SESSION, env).replace(/\.json$/, ".update.json");
  put(path, receipt(dir));
  assert.equal(findUpdateReceipt(OFFER, NAME, NOW, env)?.usedAt, null);

  assert.deepEqual(cliUpdate(NAME, OFFER, env, NOW), {
    code: 1,
    lines: [UPDATE_DENY.transcript],
  });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).usedAt, NOW.toISOString());
  assert.equal(findUpdateReceipt(OFFER, NAME, NOW, env), null);
  assert.deepEqual(cliUpdate(NAME, OFFER, env, NOW), {
    code: 1,
    lines: [UPDATE_DENY.noYes],
  });
});
