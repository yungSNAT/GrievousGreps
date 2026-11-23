import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promptSkills } from "../src/claude/prompt-skills.js";
import { repoName } from "../src/notes/home.js";
import { lineSha } from "../src/skills/receipts.js";
import {
  DENY, dialectUse, isSplitOffer, personLine, replyBefore, tamperDeny, verifySave,
} from "../src/skills/save-verify.js";
import { readRunSheet } from "../src/trace/runs.js";
import { skillsGate, type GateCtx } from "../src/trace/skill-session.js";
import { typedSha } from "../src/trace/typed.js";
import type { PendingOffer, RunSheet, SkillSessionState } from "../src/trace/types.js";
import { tmpRepo } from "./helpers.js";

const iso = (seconds: number) =>
  new Date(Date.parse("2026-10-20T10:00:00.000Z") + seconds * 1000).toISOString();

let scratch: string;
let env: NodeJS.ProcessEnv;

before(() => {
  scratch = tmpRepo("save-verify-gaps");
  const home = join(scratch, "home");
  mkdirSync(home);
  env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TRAIL_HOME: join(home, "trail"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    TRAIL_TEST_NOW: iso(71),
  };
  delete env.CI;
  mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected HTTP request in save verification");
  });
});

after(() => {
  mock.restoreAll();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

type Row = string | Record<string, unknown>;

function transcript(rows: Row[], dir = scratch, id = randomUUID()) {
  const path = join(dir, `${id}.jsonl`);
  const offsets: number[] = [];
  let end = 0;
  const lines = rows.map((row) => {
    const line = typeof row === "string" ? row : JSON.stringify(row);
    offsets.push(end);
    end += Buffer.byteLength(line) + 1;
    return line;
  });
  writeFileSync(path, lines.join("\n") + "\n");
  return { path, offsets, lines, end };
}

const user = (content: unknown, at = 70) => ({
  type: "user", timestamp: iso(at), message: { role: "user", content },
});
const assistant = (content: unknown, at = 69) => ({
  type: "assistant", timestamp: iso(at), message: { role: "assistant", content },
});
const text = (value: string) => [{ type: "text", text: value }];

describe("transcript evidence", () => {
  test("personLine checks the words and reports the exact line at a byte offset", () => {
    const ask = "save this as a skill";
    const tx = transcript([
      assistant(text("Vérification terminée.")),
      user(ask),
      { ...user(ask), isSidechain: true },
    ]);
    const said: string[] = [];
    const check = (offset: number, sha: string, mustBe: (value: string) => boolean) =>
      personLine(tx.path, offset, sha, mustBe, env, (value) => said.push(value));

    assert.equal(check(tx.offsets[1]!, typedSha("different words"), () => true), null);
    assert.equal(check(tx.offsets[1]!, typedSha(ask), () => false), null);
    assert.equal(check(tx.offsets[2]!, typedSha(ask), () => true), null);
    assert.deepEqual(said, []);

    const proof = {
      typed: { offset: tx.offsets[1], lineSha: lineSha(tx.lines[1]!) },
      at: Date.parse(iso(70)),
    };
    assert.deepEqual(check(tx.offsets[1]!, typedSha(ask), (s) => s === ask), proof);
    assert.deepEqual(said, [ask]);
    assert.deepEqual(personLine(tx.path, tx.offsets[1]!, typedSha(ask), (s) => s === ask, env), proof);
  });

  test("missing, truncated and non-object rows cannot supply consent", () => {
    const tx = transcript(["null", "false", "42", '"yes"', "[]", '{"type":"user"']);
    for (const offset of [...tx.offsets, tx.end + 100]) {
      assert.equal(personLine(tx.path, offset, typedSha("yes"), () => true, env), null,
        `transcript offset ${offset}`);
    }
  });

  test("Claude reply lookup skips bookkeeping, sidechains and replies without visible text", () => {
    const reply = "The package is published. Keep this as a skill?";
    const tx = transcript([
      assistant(text(reply)),
      assistant([{ type: "thinking", thinking: "Check the version again." }]),
      { ...assistant(text("Unrelated sidechain reply")), isSidechain: true },
      { type: "system", subtype: "turn_duration", durationMs: 100 },
      '{"type":',
      user("yes"),
    ]);
    assert.equal(replyBefore(tx.path, tx.offsets[5]!, env), reply);
  });

  test("Codex reply lookup skips damaged rows and unhashed user messages, but stops at a tool call", () => {
    const codex = (type: string, payload: object) => ({ timestamp: iso(70), type, payload });
    const reply = "The package is published.";
    const rows = [
      codex("response_item", {
        type: "message", role: "assistant", phase: "final_answer",
        content: [{ type: "output_text", text: reply }],
      }),
      codex("event_msg", { type: "agent_message", message: reply, phase: "final_answer" }),
      codex("event_msg", { type: "user_message", message: "Unconfirmed input", images: [] }),
      '{"type":',
    ];
    const how = dialectUse("codex", null);
    const answer = codex("event_msg", { type: "user_message", message: "yes", images: [] });
    const plain = transcript([...rows, answer]);
    assert.equal(replyBefore(plain.path, plain.offsets.at(-1)!, env, how), reply);

    const withCall = transcript([
      ...rows,
      codex("response_item", {
        type: "function_call", name: "exec_command", call_id: "call-check",
        arguments: JSON.stringify({ cmd: "npm view acme-cli version" }),
      }),
      answer,
    ]);
    assert.equal(replyBefore(withCall.path, withCall.offsets.at(-1)!, env, how), null);
  });
});

test("a missing run gets the host-specific refusal, without any verified steps", () => {
  const ctx = {
    env, fold: true, learn: true, subagent: false, sessionHash: "empty-session",
    host: "claude", tier: "A",
  } as GateCtx;
  const st = { sessionHash: ctx.sessionHash } as SkillSessionState;
  const cmd = { name: "publish-package", runId: `r-${"0".repeat(32)}`, flags: [] };

  assert.deepEqual(verifySave(cmd, ctx, st, null), {
    deny: DENY.run, consent: "none", offerId: null, typed: null,
    stepsTotal: 0, stepsVerified: 0, verdict: "held",
  });
  const unreadable = verifySave(cmd, { ...ctx, host: "cursor", tier: "D" }, st, null);
  assert.equal(unreadable.deny, DENY.unreadable);
  assert.equal(unreadable.stepsVerified, 0);
});

test("a recorded write to Trail's own files blocks verification", () => {
  const ctx = { env, fold: true, subagent: false } as GateCtx;
  const st = { tampered: "skills.json" } as SkillSessionState;
  const cmd = { name: "publish-package", runId: `r-${"0".repeat(32)}`, flags: [] };
  const reason = "trail · not saved: this session changed Trail's own files (skills.json), so Trail can't trust its record of what ran.";
  assert.equal(tamperDeny("skills.json"), reason);
  const result = verifySave(cmd, ctx, st, null);
  assert.equal(result.deny, reason);
  assert.equal(result.verdict, "held");
  assert.equal(result.compiled, undefined);
});

describe("verification against a folded release", () => {
  let ctx: GateCtx;
  let sheet: RunSheet;
  let name: string;
  let history: Row[];

  before(() => {
    const checkout = join(scratch, "release-gaps");
    mkdirSync(checkout);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: checkout, env });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/release-gaps.git"],
      { cwd: checkout, env });
    writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "acme-cli", version: "1.4.3" }));

    const sessionId = randomUUID();
    const projects = join(env.CLAUDE_CONFIG_DIR!, "projects", checkout.replace(/[^a-zA-Z0-9-]/g, "-"));
    mkdirSync(projects, { recursive: true });
    const rows = [user("can you pull and publish 1.4.3", 0)];
    const bash = (id: string, at: number, command: string, output: string) => [
      assistant([{ type: "tool_use", id, name: "Bash", input: { command } }], at),
      user([{ type: "tool_result", tool_use_id: id, content: output, is_error: false }], at + 1),
    ];
    const ask = "save this as a skill";
    let parentUuid: string | null = null;
    history = [
      ...rows,
      ...bash("toolu_pull", 5, "git pull --ff-only origin beta", "Already up to date."),
      ...bash("toolu_build", 10, "npm run build", "built"),
      ...bash("toolu_publish", 15, "npm publish acme-cli-1.4.3.tgz --access public", "+ acme-cli@1.4.3"),
      ...bash("toolu_view", 20, "npm view acme-cli version", "1.4.3"),
      assistant(text("Published 1.4.3: npm shows it."), 25),
      user(ask),
    ].map((row) => {
      const uuid = randomUUID();
      const entry = {
        ...row, cwd: checkout, sessionId, uuid, parentUuid, userType: "external", isSidechain: false,
      };
      parentUuid = uuid;
      return entry;
    });
    const tx = transcript(history, projects, sessionId);
    const payload = {
      hook_event_name: "UserPromptSubmit", session_id: sessionId, transcript_path: tx.path,
      cwd: checkout, permission_mode: "default", prompt: ask,
    };
    const gate = skillsGate(payload, checkout, env);
    if (!gate.ok) assert.fail(`skills gate refused the release fixture: ${JSON.stringify(gate)}`);
    ctx = { ...gate.ctx, fold: true, learn: true };
    const prompted = promptSkills(payload, checkout, env, {
      track: () => {},
      gate: () => ({ ok: true as const, ctx }),
    });
    const add = /trail skills add ([a-z0-9-]+) --run (r-[\w-]+)/.exec(prompted.context ?? "");
    assert.ok(add, `expected a save command: ${prompted.context ?? "(no context)"}`);
    name = add[1]!;
    const savedSheet = readRunSheet(add[2]!, env);
    assert.ok(savedSheet);
    sheet = savedSheet;
  });

  function state(overrides: Partial<SkillSessionState> = {}): SkillSessionState {
    return {
      sessionHash: ctx.sessionHash, scopeKeys: [sheet.repoKey], pendingOffer: null,
      saveRequest: null, ...overrides,
    } as SkillSessionState;
  }

  function command(skillName: string) {
    return { name: skillName, runId: sheet.id, flags: [] };
  }

  function occupy(skillName: string) {
    const folder = join(env.TRAIL_HOME!, "skills", skillName);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"),
      `---\nname: ${skillName}\ndescription: An existing publishing workflow.\n---\n\nCheck the package version.\n`);
  }

  function exchange(afterShow: boolean, offerName = name) {
    const answer = "yes";
    const tail = afterShow
      ? [
          assistant(text("I can show you the draft."), 80),
          user("show me", 81),
          assistant(text("The draft is ready. Would you like to open the changelog?"), 89),
          user(answer, 90),
        ]
      : [assistant(text("I have a draft of the release workflow."), 80), user(answer, 90)];
    const tx = transcript([...history, ...tail]);
    const yes = { answer: "yes", sha: typedSha(answer), offset: tx.offsets.at(-1)!, at: iso(90) };
    const typedAfter = afterShow
      ? [{ answer: "show", sha: typedSha("show me"), offset: tx.offsets.at(-3)!, at: iso(81) }, yes]
      : [yes];
    const offer = {
      name: offerName, runId: sheet.id, offerId: "offer-release", moment: "repeated",
      shownAt: iso(80), typedAfter, yes: { typedSha: yes.sha, at: yes.at },
      skillSha: "0".repeat(64),
    } as PendingOffer;
    return {
      offer,
      context: { ...ctx, transcriptPath: tx.path, now: new Date(iso(91)) },
      proof: { offset: yes.offset, lineSha: lineSha(tx.lines.at(-1)!) },
    };
  }

  test("an out-of-scope run names zero, one, or up to three of the session's repos", () => {
    const prefix = sheet.repoKey.slice(0, sheet.repoKey.lastIndexOf("/") + 1);
    const keys = ["storefront", "docs", "catalog", "payments"].map((slug) => prefix + slug);
    const [a, b, c] = keys.map(repoName);
    for (const [scopeKeys, here] of [
      [[], ""],
      [[keys[0]!], `, and this session works in ${a}`],
      [[keys[0]!, ...keys], `, and this session works in ${a}, ${b} and ${c}`],
    ] as const) {
      const result = verifySave(command(name), ctx, state({ scopeKeys: [...scopeKeys] }), null);
      assert.equal(result.deny,
        `trail · not saved: that run was done in ${repoName(sheet.repoKey)}${here}, so Trail can't keep it from here.`);
      assert.equal(result.consent, "none");
    }
  });

  test("a direct yes cannot be used to claim a different name", () => {
    const { offer, context, proof } = exchange(false);
    const result = verifySave(command("unrelated-workflow"), context, state({ pendingOffer: offer }), null);
    assert.equal(result.deny,
      `trail · not saved: the offer was for the name ${name}. Run: trail skills add ${name} --run ${sheet.id}`);
    assert.equal(result.consent, "offer-yes");
    assert.equal(result.offerId, offer.offerId);
    assert.deepEqual(result.typed, proof);
  });

  test("after 'show me', a yes to a now-occupied name gets the first free numbered alternative", () => {
    const base = "publish-acme";
    occupy(base);
    occupy(`${base}-2`);
    const { offer, context, proof } = exchange(true, base);
    const result = verifySave(command(`${base}-01`), context, state({ pendingOffer: offer }), null);
    assert.equal(result.deny,
      `trail · not saved: the offer was for the name ${base}. Run: trail skills add ${base}-3 --run ${sheet.id}`);
    assert.equal(result.consent, "offer-yes");
    assert.deepEqual(result.typed, proof);
  });

  test("an occupied offer with no free numbered alternative suggests <other>", () => {
    const base = "package-release";
    occupy(base);
    for (let n = 2; n <= 20; n++) occupy(`${base}-${n}`);

    const { offer, context, proof } = exchange(false, base);
    const result = verifySave(command("unrelated-release"), context, state({ pendingOffer: offer }), null);
    assert.equal(result.deny,
      `trail · not saved: the offer was for the name ${base}. Run: trail skills add <other> --run ${sheet.id}`);
    assert.equal(result.consent, "offer-yes");
    assert.deepEqual(result.typed, proof);
  });

  test("an offer's recorded yes does not replace a qualifying check of the release", () => {
    // The npm view call passed as an npm-view check, but the run is still open when it is saved,
    // so the sheet records no qualifying check; that, not a missing npm view, is what refuses it.
    assert.equal(sheet.end, "open");
    assert.equal(sheet.checkIndex, null);
    const view = sheet.calls.find((c) => c.check?.family === "npm-view");
    assert.deepEqual(view?.check, { family: "npm-view", passed: true, facts: { version: "1.4.3", pkg: "acme-cli" } });
    const { offer, context, proof } = exchange(true);
    // Offer consent compiles in the repeated moment. The compiler refuses this
    // run before verifySave checks which question the person's yes answered.
    const result = verifySave(command(name), context, state({ pendingOffer: offer }), null);
    assert.deepEqual(result, {
      deny: "trail · not saved: nothing in the run checked that the job worked.",
      consent: "offer-yes",
      offerId: offer.offerId,
      typed: proof,
      stepsTotal: 0,
      stepsVerified: 0,
      verdict: "held",
    });
  });

  test("only an update that splits out the offered name counts as a split offer", () => {
    const { offer, context } = exchange(false);
    const split = { ...offer, moment: "update", fold: { op: "split", splitName: name } } as PendingOffer;
    assert.equal(isSplitOffer(null), false);
    assert.equal(isSplitOffer(offer), false);
    assert.equal(isSplitOffer({ ...split, fold: undefined }), false);
    assert.equal(isSplitOffer({ ...split, name: "different-workflow" }), false);
    assert.equal(isSplitOffer(split), true);

    const result = verifySave(command("different-workflow"), context, state({ pendingOffer: split }), null);
    assert.equal(result.consent, "offer-yes");
    assert.equal(result.deny,
      `trail · not saved: the offer was for the name ${name}. Run: trail skills add ${name} --run ${sheet.id}`);

    const update = verifySave(command("different-workflow"), context,
      state({ pendingOffer: { ...split, fold: undefined } }), null);
    assert.equal(update.consent, "none");
    assert.equal(update.offerId, null);
    assert.equal(update.typed, null);
    assert.equal(update.verdict, "held");
  });
});
