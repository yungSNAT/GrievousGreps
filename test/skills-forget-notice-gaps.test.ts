import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  forgetNoticeAtStop, forgotPath, noteAgentForget, takeForgets, withForgetNotice,
} from "../src/skills/forget-notice.js";
import type { Dropped } from "../src/skills/forget-notice.js";

const NOW = "2020-06-15T12:00:00.000Z";
const now = new Date(NOW);
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 16 * 1024;

function atOffset(ms: number): string {
  return new Date(now.getTime() + ms).toISOString();
}

function skill(name: string, at = NOW): Dropped {
  return { at, what: "skill", name, back: `trail skills restore ${name}` };
}

function jsonl(...rows: unknown[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

describe("forget notice queue", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "forget-gaps-"));
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function sandbox(tag: string): NodeJS.ProcessEnv {
    const env = { TRAIL_HOME: join(root, tag) };
    mkdirSync(dirname(forgotPath(env)), { recursive: true });
    return env;
  }

  test("creates the queue, then appends a bounded, single-line entry", () => {
    const env = sandbox("append");
    const first = skill("release-npm");
    noteAgentForget(first, env, now);
    noteAgentForget({
      what: "skill",
      name: `deploy-web\n${"x".repeat(100)}`,
      back: `trail skills restore deploy-web\r\n${"y".repeat(250)}`,
    }, env, now);

    const entries = takeForgets(env, now);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], first);
    const second = entries[1]!;
    assert.equal(second.at, NOW);
    assert.equal(second.what, "skill");
    assert.match(second.name, /^deploy-web/);
    assert.match(second.back, /^trail skills restore deploy-web/);
    assert.doesNotMatch(second.name + second.back, /[\r\n]/);
    assert.ok(second.name.length <= 60);
    assert.ok(second.back.length <= 200);
    assert.equal(existsSync(forgotPath(env)), false);
  });

  test("an invalid clock reading leaves an existing queue unchanged", () => {
    const env = sandbox("invalid-clock");
    const path = forgotPath(env);
    const first = skill("release-npm");
    const original = jsonl(first);
    writeFileSync(path, original);

    noteAgentForget(skill("deploy-web"), env, new Date(Number.NaN));

    assert.equal(readFileSync(path, "utf8"), original);
    assert.deepEqual(takeForgets(env, now), [first]);
  });

  test("does not append at the byte limit or consume records beyond it", () => {
    const env = sandbox("byte-limit");
    const path = forgotPath(env);
    const first = skill("release-npm");
    const prefix = jsonl(first);
    writeFileSync(path, prefix + " ".repeat(MAX_BYTES - Buffer.byteLength(prefix)));
    assert.equal(statSync(path).size, MAX_BYTES);

    noteAgentForget(skill("deploy-web"), env, now);
    assert.equal(statSync(path).size, MAX_BYTES, "a full queue should not grow");

    appendFileSync(path, `\n${jsonl(skill("beyond-limit"))}`);
    assert.deepEqual(takeForgets(env, now), [first]);
    assert.equal(existsSync(path), false);
  });

  test("takes only well-formed entries inside the age and clock-skew bounds", () => {
    const env = sandbox("validation");
    const path = forgotPath(env);
    const oldest = skill("oldest-allowed", atOffset(-DAY_MS));
    const newest = skill("newest-allowed", atOffset(60_000));
    const current = skill("current");

    writeFileSync(path, jsonl(
      oldest,
      null,
      42,
      { ...current, what: 1 },
      { ...current, what: "bookmark" },
      { ...current, name: null },
      { ...current, name: "" },
      { ...current, back: 1 },
      { ...current, back: "" },
      { ...current, at: now.getTime() },
      { ...current, at: "not a date" },
      skill("too-old", atOffset(-DAY_MS - 1)),
      skill("too-far-ahead", atOffset(60_001)),
      newest,
    ) + " \nnot json\n" + jsonl(current));

    assert.deepEqual(takeForgets(env, now), [oldest, newest, current]);
    assert.equal(existsSync(path), false);
    assert.deepEqual(takeForgets(env, now), []);
  });

  test("a failed claim preserves the queue for a later Stop", () => {
    const env = sandbox("claim-collision");
    const path = forgotPath(env);
    const entry = skill("release-npm");
    writeFileSync(path, jsonl(entry));

    const collision = `${path}.${process.pid}.8.taken`;
    mkdirSync(collision);
    const random = mock.method(Math, "random", () => 0.5);
    try {
      assert.deepEqual(takeForgets(env, now), []);
    } finally {
      random.mock.restore();
    }

    assert.equal(readFileSync(path, "utf8"), jsonl(entry));
    assert.ok(statSync(collision).isDirectory());
    rmSync(collision, { recursive: true });
    assert.deepEqual(takeForgets(env, now), [entry]);
  });

  test("a directory in place of the queue produces no notice and its contents survive", () => {
    const env = sandbox("directory");
    const path = forgotPath(env);
    mkdirSync(path);
    writeFileSync(join(path, "keep.txt"), "not part of the queue");

    assert.deepEqual(takeForgets(env, now), []);
    assert.equal(existsSync(path), false);
    const claimed = readdirSync(dirname(path)).filter((name) => name.endsWith(".taken"));
    assert.equal(claimed.length, 1);
    assert.equal(
      readFileSync(join(dirname(path), claimed[0]!, "keep.txt"), "utf8"),
      "not part of the queue",
    );
  });

  test("an existing block or a continued turn defers the notice, which is then appended once", () => {
    const env = sandbox("deferred");
    const path = forgotPath(env);
    const original = jsonl(skill("release-npm"));
    writeFileSync(path, original);

    const opts = { env, now, active: false, stopNotice: true };
    const blocked = { block: "An offer already needs an answer." };
    const existing = { notice: "Skills were updated." };
    assert.deepEqual(withForgetNotice(blocked, opts), blocked);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.deepEqual(withForgetNotice(existing, { ...opts, active: true }), existing);
    assert.equal(readFileSync(path, "utf8"), original);

    assert.deepEqual(withForgetNotice(existing, opts), {
      notice: `${existing.notice}\ntrail: an agent ran trail forget: the skill release-npm (bring it back: trail skills restore release-npm)`,
    });
    assert.equal(existsSync(path), false);
    assert.deepEqual(withForgetNotice(existing, opts), existing);
  });

  test("the Stop entry point uses the Trail clock and the host's notice capability", () => {
    const env = {
      ...sandbox("stop-facts"),
      TRAIL_TEST_NOW: NOW,
      TRAIL_HOST_FACTS: JSON.stringify({ stopNotice: true }),
    };
    writeFileSync(forgotPath(env), jsonl(skill("expired", atOffset(-2 * DAY_MS)), skill("release-npm")));

    assert.deepEqual(forgetNoticeAtStop({}, env), {
      notice: "trail: an agent ran trail forget: the skill release-npm (bring it back: trail skills restore release-npm)",
    });
    assert.deepEqual(forgetNoticeAtStop({}, env), {});
  });

  test("a host without Stop notices gets a block naming the last three drops and counting the rest", () => {
    const env = sandbox("stop-block");
    const guardrail: Dropped = {
      at: NOW,
      what: "guardrail",
      name: "no-timeout",
      back: `change status: retired to status: active in ${join("learnings", "no-timeout.md")}`,
    };
    writeFileSync(forgotPath(env), jsonl(
      skill("oldest-drop"),
      skill("release-npm"),
      skill("deploy-web"),
      guardrail,
    ));

    const opts = { env, now, active: false, stopNotice: false };
    const out = withForgetNotice({}, opts);
    assert.equal(out.notice, undefined);
    assert.ok(out.block);
    assert.match(out.block, /^\[trail\] /);
    assert.ok(out.block.includes('tell them once: "an agent ran trail forget:'));
    assert.ok(out.block.includes("the skill release-npm (bring it back: trail skills restore release-npm)"));
    assert.ok(out.block.includes("the skill deploy-web (bring it back: trail skills restore deploy-web)"));
    assert.ok(out.block.endsWith(`the always-follow learning no-timeout (bring it back: ${guardrail.back}) and 1 more"`));
    assert.doesNotMatch(out.block, /oldest-drop|[\r\n]/);
    assert.deepEqual(withForgetNotice({}, opts), {});
  });
});
