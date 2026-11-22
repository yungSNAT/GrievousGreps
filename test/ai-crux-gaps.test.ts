import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import {
  ChatCruxSummarizer,
  classifyCruxMiss,
  formatCruxMiss,
  formatCruxMissDetail,
  resolveTargetId,
  type NodeCrux,
  type FileCruxInput,
} from "../src/ai/crux.js";
import type { ChatModel, ChatResponse } from "../src/ai/llm/types.js";

function resp(partial: { text?: string; toolCalls?: { name: string; args: unknown }[]; stopReason?: string | null }): ChatResponse {
  return {
    text: partial.text ?? "",
    toolCalls: partial.toolCalls ?? [],
    stopReason: partial.stopReason ?? null,
  } as unknown as ChatResponse;
}

interface FakeModel {
  model: ChatModel;
  requests: any[];
}

function fakeModel(reply: ChatResponse): FakeModel {
  const requests: any[] = [];
  const model = {
    async create(req: unknown) {
      requests.push(req);
      return reply;
    },
  } as unknown as ChatModel;
  return { model, requests };
}

/** Silence the "tool_choice ignored" warnings while a test runs. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const w = mock.method(console, "warn", () => {});
  const e = mock.method(console, "error", () => {});
  try {
    return await fn();
  } finally {
    w.mock.restore();
    e.mock.restore();
  }
}

const input = (nodes: FileCruxInput["nodes"], source = "class A {\n  run() { return 1; }\n}\n"): FileCruxInput => ({
  path: "src/a.ts",
  source,
  nodes,
});

describe("classifyCruxMiss", () => {
  test("text that is not a tool payload and no tool calls is unparseable", () => {
    const miss = classifyCruxMiss(resp({ text: "Sorry, I cannot help with that.", stopReason: "stop" }), []);
    assert.deepEqual(miss, { kind: "unparseable", finishReason: "stop" });
  });

  test("no tool calls and blank text is empty-toolCalls", () => {
    const miss = classifyCruxMiss(resp({ text: "   ", stopReason: null }), []);
    assert.deepEqual(miss, { kind: "empty-toolCalls", finishReason: null });
  });

  test("a truncated stop reason (any case) wins over other classes", () => {
    assert.deepEqual(classifyCruxMiss(resp({ stopReason: "MAX_TOKENS" }), []), {
      kind: "truncated",
      finishReason: "MAX_TOKENS",
    });
    assert.deepEqual(classifyCruxMiss(resp({ stopReason: "length" }), []), {
      kind: "truncated",
      finishReason: "length",
    });
  });

  test("summaries under unrequested ids are id-mismatch with the first id", () => {
    const parsed: NodeCrux[] = [
      { id: "other#x", summary: "does x", crux_start: 0, crux_end: 0 },
      { id: "other#y", summary: "does y", crux_start: 0, crux_end: 0 },
    ];
    const miss = classifyCruxMiss(resp({ stopReason: "tool_use" }), parsed, ["a.ts#run"]);
    assert.deepEqual(miss, { kind: "id-mismatch", finishReason: "tool_use", returned: 2, firstId: "other#x" });
  });

  test("matching ids with blank summaries are empty-parsed; a real summary is no miss", () => {
    const blank: NodeCrux[] = [{ id: "a.ts#run", summary: "  ", crux_start: 0, crux_end: 0 }];
    assert.deepEqual(classifyCruxMiss(resp({ stopReason: "stop" }), blank, ["a.ts#run"]), {
      kind: "empty-parsed",
      finishReason: "stop",
    });
    const good: NodeCrux[] = [{ id: "anything", summary: "runs it", crux_start: 1, crux_end: 2 }];
    // Without `requested`, any id counts.
    assert.equal(classifyCruxMiss(resp({}), good), null);
  });
});

describe("formatCruxMiss / formatCruxMissDetail", () => {
  test("formats finish_reason null/empty as 'null' and id-mismatch distinctly", () => {
    assert.equal(
      formatCruxMiss("unparseable", null),
      "model returned no usable symbol summaries [unparseable, finish_reason=null]",
    );
    assert.equal(
      formatCruxMiss("truncated", ""),
      "model returned no usable symbol summaries [truncated, finish_reason=null]",
    );
    assert.equal(
      formatCruxMiss("id-mismatch", "stop"),
      "model returned summaries but no id matched a requested target [id-mismatch, finish_reason=stop]",
    );
  });

  test("detail is empty for non-mismatch, missing id, or null", () => {
    assert.equal(formatCruxMissDetail(null), "");
    assert.equal(formatCruxMissDetail(undefined), "");
    assert.equal(formatCruxMissDetail({ kind: "unparseable", finishReason: null }), "");
    assert.equal(formatCruxMissDetail({ kind: "id-mismatch", finishReason: null }), "");
  });

  test("detail shows the id, defaults returned to 1, and clips long ids", () => {
    assert.equal(
      formatCruxMissDetail({ kind: "id-mismatch", finishReason: null, firstId: "x#y" }),
      'first of 1 returned id(s): "x#y"',
    );
    const long = "z".repeat(250);
    const out = formatCruxMissDetail({ kind: "id-mismatch", finishReason: "stop", returned: 3, firstId: long });
    assert.equal(out, `first of 3 returned id(s): ${JSON.stringify("z".repeat(200) + "…")}`);
  });
});

describe("resolveTargetId", () => {
  const req = ["a.cs#Level", "a.cs#Level.Max", "b.cs#Run"];

  test("exact and trimmed matches", () => {
    assert.equal(resolveTargetId("b.cs#Run", req), "b.cs#Run");
    assert.equal(resolveTargetId("  b.cs#Run \n", req), "b.cs#Run");
  });

  test("an echoed row starting with the id picks the longest requested id", () => {
    assert.equal(resolveTargetId("a.cs#Level.Max | variable | lines L58-L58", req), "a.cs#Level.Max");
    assert.equal(resolveTargetId("a.cs#Level | variable | lines L5-L9 | int Level", req), "a.cs#Level");
  });

  test("a leading id= is stripped, bare or echoed", () => {
    assert.equal(resolveTargetId("id= b.cs#Run", req), "b.cs#Run");
    assert.equal(resolveTargetId("id=b.cs#Run | method | lines L1-L3", req), "b.cs#Run");
  });

  test("a whole current-layout row ending in id=<id> resolves", () => {
    assert.equal(resolveTargetId("method | lines L1-L3 | void Run() | id=b.cs#Run", req), "b.cs#Run");
  });

  test("unrelated ids resolve to null", () => {
    assert.equal(resolveTargetId("c.cs#Nope", req), null);
    assert.equal(resolveTargetId("id=c.cs#Nope | x", req), null);
  });
});

describe("ChatCruxSummarizer", () => {
  test("no nodes: returns [] without calling the model and clears lastMiss", async () => {
    const fm = fakeModel(resp({}));
    const s = new ChatCruxSummarizer(fm.model);
    s.lastMiss = { kind: "truncated", finishReason: "length" };
    assert.deepEqual(await s.describeFile(input([])), []);
    assert.equal(fm.requests.length, 0);
    assert.equal(s.lastMiss, null);
  });

  test("parses the record_symbols call, resolves decorated ids and normalizes numbers", async () => {
    const fm = fakeModel(
      resp({
        stopReason: "tool_use",
        toolCalls: [
          { name: "other_tool", args: { symbols: [] } },
          {
            name: "record_symbols",
            args: {
              symbols: [
                { id: "method | lines L2-L2 | id=src/a.ts#run", summary: "  Runs the thing.  ", crux_start: 2.7, crux_end: "x" },
                { id: 42, summary: "dropped" },
                { id: "src/a.ts#A", summary: 5, crux_start: Infinity, crux_end: 3 },
              ],
            },
          },
        ],
      }),
    );
    const s = new ChatCruxSummarizer(fm.model);
    const out = await s.describeFile(
      input([
        { id: "src/a.ts#A", kind: "class", signature: null, startLine: 1, endLine: 3 },
        { id: "src/a.ts#run", kind: "method", signature: "run()", startLine: 2, endLine: 2 },
      ]),
    );
    assert.deepEqual(out, [
      { id: "src/a.ts#run", summary: "Runs the thing.", crux_start: 2, crux_end: 0 },
      { id: "src/a.ts#A", summary: "", crux_start: 0, crux_end: 3 },
    ]);
    assert.equal(s.lastMiss, null);

    assert.equal(fm.requests.length, 1);
    const req = fm.requests[0];
    assert.deepEqual(req.responseFormat, { kind: "tool", name: "record_symbols" });
    const user = req.messages[1].content as string;
    assert.ok(user.startsWith("FILE: src/a.ts\n\n1\tclass A {"));
    assert.ok(user.includes("TARGETS (2 — return all 2, one entry per id):"));
    assert.ok(user.includes("- class | lines L1-L3 | id=src/a.ts#A"), "no signature segment when null");
    assert.ok(user.includes("- method | lines L2-L2 | run() | id=src/a.ts#run"));
  });

  test("clips a huge source file before numbering it", async () => {
    const fm = fakeModel(resp({ toolCalls: [{ name: "record_symbols", args: { symbols: [] } }] }));
    const s = new ChatCruxSummarizer(fm.model);
    const big = "x".repeat(20_000);
    await s.describeFile(input([{ id: "f#a", kind: "function", signature: null, startLine: 1, endLine: 1 }], big));
    const user = fm.requests[0].messages[1].content as string;
    assert.ok(user.includes("2\t… (truncated)"));
    assert.ok(!user.includes("x".repeat(18_001)));
    // A tool call came back but with no symbols: not "empty-toolCalls", so unparseable.
    assert.deepEqual(s.lastMiss, { kind: "unparseable", finishReason: null });
  });

  test("recovers a JSON payload placed in content when tool_choice is ignored", async () => {
    const payload = JSON.stringify({ symbols: [{ id: "f#a", summary: "Adds numbers.", crux_start: 1, crux_end: 1 }] });
    const fm = fakeModel(resp({ text: payload, stopReason: "stop" }));
    const s = new ChatCruxSummarizer(fm.model);
    const out = await quiet(() =>
      s.describeFile(input([{ id: "f#a", kind: "function", signature: "a()", startLine: 1, endLine: 1 }])),
    );
    assert.deepEqual(out, [{ id: "f#a", summary: "Adds numbers.", crux_start: 1, crux_end: 1 }]);
    assert.equal(s.lastMiss, null);
  });

  test("prose with no payload yields [] and an unparseable miss", async () => {
    const fm = fakeModel(resp({ text: "I would rather describe this in prose.", stopReason: "stop" }));
    const s = new ChatCruxSummarizer(fm.model);
    const out = await quiet(() =>
      s.describeFile(input([{ id: "f#a", kind: "function", signature: null, startLine: 1, endLine: 1 }])),
    );
    assert.deepEqual(out, []);
    assert.deepEqual(s.lastMiss, { kind: "unparseable", finishReason: "stop" });
  });

  test("array tool args fall back to content; unmatched ids report id-mismatch", async () => {
    const fm = fakeModel(
      resp({
        toolCalls: [{ name: "record_symbols", args: [1, 2] }],
        text: JSON.stringify({ symbols: [{ id: "zzz#q", summary: "Wrong one.", crux_start: 0, crux_end: 0 }] }),
        stopReason: "stop",
      }),
    );
    const s = new ChatCruxSummarizer(fm.model);
    const out = await quiet(() =>
      s.describeFile(input([{ id: "f#a", kind: "function", signature: null, startLine: 1, endLine: 1 }])),
    );
    assert.deepEqual(out, [{ id: "zzz#q", summary: "Wrong one.", crux_start: 0, crux_end: 0 }]);
    assert.deepEqual(s.lastMiss, { kind: "id-mismatch", finishReason: "stop", returned: 1, firstId: "zzz#q" });
    assert.equal(formatCruxMissDetail(s.lastMiss), 'first of 1 returned id(s): "zzz#q"');
  });
});
