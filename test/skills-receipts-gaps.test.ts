import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findReceipt, markReceiptUsed, receiptPath, writeReceipt } from "../src/skills/receipts.js";
import type { Receipt } from "../src/skills/types.js";
import { tmpRepo } from "./helpers.js";

describe("skill receipt storage", () => {
  const now = new Date("2026-02-03T12:00:00.000Z");
  let root: string;

  before(() => {
    root = tmpRepo("skills-receipts-gaps");
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function receipt(session: string, overrides: Partial<Receipt> = {}): Receipt {
    return {
      v: 1,
      session,
      transcriptPath: join(root, "transcripts", "session.jsonl"),
      toolUseId: "call-1",
      runId: "run-1",
      name: "review-changes",
      at: new Date(now.getTime() - 1_000).toISOString(),
      host: "claude",
      tier: "B",
      consent: "none",
      offerId: null,
      typed: null,
      typedYes: false,
      typedSave: false,
      asked: null,
      stepsTotal: 2,
      stepsVerified: 1,
      verdict: "held",
      usedAt: null,
      ...overrides,
    };
  }

  test("keeps ordinary session IDs and hashes path-like IDs under the default Trail home", () => {
    const home = join(root, "default-home");
    const previous = process.env.TRAIL_HOME;
    mock.timers.enable({ apis: ["Date"], now: now.getTime() });
    try {
      process.env.TRAIL_HOME = home;
      const ordinary = receipt("session-42");
      const imported = receipt(join("restored", ordinary.session), {
        at: now.toISOString(),
        toolUseId: "call-2",
      });
      const hash = createHash("sha256").update(imported.session).digest("hex").slice(0, 16);
      const dir = join(home, "receipts");
      const ordinaryPath = join(dir, "session-42.json");
      const importedPath = join(dir, `h-${hash}.json`);

      assert.equal(receiptPath(ordinary.session), ordinaryPath);
      assert.equal(receiptPath(imported.session), importedPath);

      writeReceipt(ordinary);
      assert.deepEqual(findReceipt(ordinary.runId, ordinary.name), ordinary);

      writeReceipt(imported);
      assert.equal(JSON.parse(readFileSync(ordinaryPath, "utf8")).session, ordinary.session);
      assert.equal(JSON.parse(readFileSync(importedPath, "utf8")).session, imported.session);
      assert.deepEqual(findReceipt(imported.runId, imported.name), imported, "the newest matching receipt wins");
    } finally {
      if (previous === undefined) delete process.env.TRAIL_HOME;
      else process.env.TRAIL_HOME = previous;
      mock.timers.reset();
    }
  });

  test("rejects malformed receipt files but accepts a valid asked scope", () => {
    const env = { TRAIL_HOME: join(root, "validation-home") };
    const r = receipt("validation-session");
    const path = receiptPath(r.session, env);
    const find = () => findReceipt(r.runId, r.name, now, env);
    writeReceipt(r, env);
    assert.deepEqual(find(), r);

    const asked = { ...r, consent: "asked", asked: "this repo" };
    // JSON.stringify(Infinity) produces null; use an overflowing JSON number
    // to exercise the finite-number check after parsing.
    const overflow = JSON.stringify({ ...r, stepsVerified: "OVERFLOW" })
      .replace('"OVERFLOW"', "1e309");
    const malformed = [
      ["null", "null"],
      ["a scalar", '"receipt"'],
      ["an array of otherwise valid receipts", JSON.stringify([r])],
      ["an unknown asked scope", JSON.stringify({ ...asked, asked: "another repo" })],
      ["a numeric string", JSON.stringify({ ...r, stepsTotal: "2" })],
      ["a non-finite verified step count", overflow],
    ];

    for (const [label, json] of malformed) {
      writeFileSync(path, json, "utf8");
      assert.equal(find(), null, `rejects ${label}`);
    }

    writeFileSync(path, JSON.stringify(asked), "utf8");
    assert.deepEqual(find(), asked);
  });

  test("marking a receipt used neither recreates a removed file nor consumes its replacement", () => {
    const env = { TRAIL_HOME: join(root, "consumption-home") };
    const original = receipt("replaceable-session");
    const path = receiptPath(original.session, env);
    const find = () => findReceipt(original.runId, original.name, now, env);
    writeReceipt(original, env);
    assert.deepEqual(find(), original);

    unlinkSync(path);
    markReceiptUsed(original, now, env);
    assert.equal(existsSync(path), false, "a receipt removed after lookup stays removed");
    assert.equal(find(), null);

    const replacement = { ...original, toolUseId: "call-2", at: now.toISOString() };
    writeReceipt(replacement, env);
    markReceiptUsed(original, now, env);
    assert.deepEqual(find(), replacement, "the replacement is still unused");

    markReceiptUsed(replacement, now, env);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).usedAt, now.toISOString());
    assert.equal(find(), null, "a consumed receipt is no longer eligible");
  });
});
