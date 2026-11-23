import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterList, findList, initOnly, linesFrom } from "../src/init/keep-list.js";
import { KEEP_LINE, RELAY_LINE } from "../src/init/relay.js";
import { tmpRepo } from "./helpers.js";

let scratch: string;

before(() => {
  scratch = tmpRepo("keep-list-gaps");
});

after(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function transcript(name: string, lines: string[]) {
  const path = join(scratch, `${name}.jsonl`);
  let next = 0;
  const offsets = lines.map((line) => {
    const offset = next;
    next += Buffer.byteLength(line) + 1;
    return offset;
  });
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return { path, offsets };
}

function assistant(...content: unknown[]): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
}

function text(value: string) {
  return { type: "text", text: value };
}

function bash(id: string, command: string): string {
  return assistant({ type: "tool_use", name: "Bash", id, input: { command } });
}

function result(id: string, content: unknown, isSidechain = false): string {
  return JSON.stringify({
    type: "user",
    isSidechain,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  });
}

function person(content: string): string {
  return JSON.stringify({
    type: "user",
    userType: "external",
    isSidechain: false,
    message: { role: "user", content },
  });
}

const isInit = (command: string) => /^trail\s+init\b/.test(command);
const listText = `${RELAY_LINE}\n1. Keep the café note\n${KEEP_LINE}`;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("reading transcript windows", () => {
  test("keeps byte offsets and drops partial lines at either edge of a tail window", () => {
    const path = join(scratch, "window.jsonl");
    const first = person("Earlier café conversation");
    const second = assistant(text("Résumé for the next session"));
    const fragment = '{"type":"assistant"';
    const body = `${first}\n${second}\n${fragment}`;
    writeFileSync(path, body, "utf8");

    const secondOffset = Buffer.byteLength(`${first}\n`);
    const secondLine = { line: second, offset: secondOffset };
    const size = Buffer.byteLength(body);

    assert.deepEqual(linesFrom(path, {}), [{ line: first, offset: 0 }, secondLine]);
    assert.deepEqual(linesFrom(path, { bytes: size - (secondOffset - 4) }), [secondLine]);
    assert.deepEqual(
      linesFrom(path, { from: secondOffset, bytes: Buffer.byteLength(`${second}\n`) }),
      [secondLine],
    );
    assert.deepEqual(linesFrom(path, { bytes: Buffer.byteLength(fragment) }), []);
    assert.deepEqual(linesFrom(path, { from: size }), []);
    assert.equal(linesFrom(path, { from: size + 1 }), null);
    assert.equal(linesFrom(path, { from: secondOffset + 0.5 }), null);
  });

  test("an unavailable transcript cannot supply a list or an answer", () => {
    const path = join(scratch, "missing.jsonl");
    assert.equal(linesFrom(path, {}), null);
    assert.equal(findList(path, isInit, { offset: 0 }), null);
    assert.equal(afterList(path, { via: "handover", offset: 0 }), null);
  });
});

describe("recognizing init lists", () => {
  test("accepts standalone init commands, including npx after a leading cd", () => {
    assert.equal(initOnly("trail init"), true);
    assert.equal(initOnly("cd project && npx @trailhq/trail-code init"), true);
    assert.equal(initOnly("npx @nanonets/graft init"), true);

    for (const command of [
      "trail init | head",
      "trail init > saved.txt",
      "trail init && trail init",
      "trail init; echo done",
      "echo 'trail init'",
    ]) {
      assert.equal(initOnly(command), false, command);
    }
  });

  test("does not mistake echoed or unpaired tool output for a list", () => {
    const command = "echo 'trail init'";
    const classify = mock.fn(isInit);
    const { path } = transcript("copied-output", [
      bash("echo", command),
      result("echo", listText),
      result("unknown-call", listText),
    ]);

    assert.deepEqual(findList(path, classify, null), { list: null, cut: null });
    assert.deepEqual(classify.mock.calls.map((call) => call.arguments), [[command]]);
  });

  test("uses the newest clean list and joins text blocks without stringifying other blocks", () => {
    const blocks = [
      text(RELAY_LINE),
      text("2. Save the résumé"),
      null,
      "not a content block",
      { type: "image", source: { type: "base64", media_type: "image/png", data: "" } },
      text(KEEP_LINE),
    ];
    const { path, offsets } = transcript("structured-output", [
      bash("old", "trail init"),
      result("old", listText),
      JSON.stringify({ type: "progress", data: { type: "tool_result" } }),
      '{"type":"user","message":{"content":[{"type":"tool_result"',
      bash("new", "trail init"),
      result("new", blocks),
      result("new", listText, true),
    ]);

    assert.deepEqual(findList(path, isInit, null), {
      list: {
        via: "init-call",
        offset: offsets[5],
        text: [RELAY_LINE, "2. Save the résumé", "", "", "", KEEP_LINE].join("\n"),
      },
      cut: null,
    });
  });

  test("reports later cut output without replacing a clean list or a newer handover", () => {
    const { path, offsets } = transcript("cut-output", [
      bash("clean", "trail init"),
      result("clean", listText),
      bash("piped", "trail init | head"),
      result("piped", listText),
      person("Please show the handed-over list."),
      bash("unsupported", "trail init"),
      result("unsupported", { text: listText }),
    ]);

    assert.deepEqual(findList(path, isInit, null), {
      list: { via: "init-call", offset: offsets[1], text: listText },
      cut: offsets[6],
    });
    assert.deepEqual(findList(path, isInit, { offset: offsets[4] }), {
      list: { via: "handover", offset: offsets[4], text: "" },
      cut: offsets[6],
    });

    const call = bash("retry", "trail init");
    const retryOffset = statSync(path).size + Buffer.byteLength(`${call}\n`);
    appendFileSync(path, `${call}\n${result("retry", listText)}\n`, "utf8");

    assert.deepEqual(findList(path, isInit, { offset: offsets[4] }), {
      list: { via: "init-call", offset: retryOffset, text: listText },
      cut: null,
    });
  });
});

describe("reading the reply and answer after a list", () => {
  test("uses the newest typed answer and hashes the raw line and the reply up to it", () => {
    const answerText = "Actually, keep none.";
    const answer = person(answerText);
    const { path, offsets } = transcript("changed-answer", [
      person("Start with the café project."),
      bash("init", "trail init"),
      result("init", listText),
      assistant(text("1. Keep the café note")),
      person("Can you show item 1 in full?"),
      assistant(text("It explains the release process.")),
      answer,
      assistant(text("Understood; nothing will be kept.")),
    ]);

    const found = findList(path, isInit, null);
    assert.ok(found?.list);
    assert.equal(found.cut, null);
    assert.deepEqual(found.list, { via: "init-call", offset: offsets[2], text: listText });

    const reply = "1. Keep the café note\nIt explains the release process.";
    assert.deepEqual(afterList(path, found.list), {
      reply,
      replySha: sha256(reply),
      typed: { offset: offsets[6], lineSha: sha256(answer), text: answerText },
      tampered: false,
    });
  });

  test("does not count a typed line before the agent shows the handed-over list", () => {
    const { path, offsets } = transcript("handover-answer", [
      person("Please show the list."),
      assistant(text("   ")),
      person("Is it ready?"),
      assistant(text("1. Save the résumé")),
    ]);
    const list = { via: "handover", offset: offsets[0] } as const;

    assert.deepEqual(afterList(path, list), {
      reply: "",
      replySha: sha256(""),
      typed: null,
      tampered: false,
    });

    const answerText = "Keep item 1.";
    const answer = person(answerText);
    const offset = statSync(path).size;
    appendFileSync(path, `${answer}\n`, "utf8");

    const reply = "   \n1. Save the résumé";
    assert.deepEqual(afterList(path, list), {
      reply,
      replySha: sha256(reply),
      typed: { offset, lineSha: sha256(answer), text: answerText },
      tampered: false,
    });
  });
});
