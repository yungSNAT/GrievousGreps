import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicChatModel } from "../src/ai/llm/anthropic.js";

function fakeAnthropic(resp: unknown) {
  const box: { params?: any; calls: number } = { calls: 0 };
  const client = {
    messages: {
      create: async (params: any) => {
        box.calls++;
        box.params = params;
        return resp;
      },
    },
  } as unknown as Anthropic;
  return { client, box };
}

function anthResp(over: Partial<any> = {}): any {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-x",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 },
    ...over,
  };
}

describe("AnthropicChatModel constructor", () => {
  test("default label is provider:model and a real SDK client is built when none is injected", () => {
    const m = new AnthropicChatModel({ apiKey: "not-a-real-key", model: "claude-test", baseUrl: "http://127.0.0.1:9" });
    assert.equal(m.label, "anthropic:claude-test");
    const client = (m as any).client;
    assert.ok(client instanceof Anthropic);
    assert.equal(typeof client.messages.create, "function");
  });

  test("explicit label overrides the default", () => {
    const { client } = fakeAnthropic(anthResp());
    const m = new AnthropicChatModel({ apiKey: "x", model: "claude-test", label: "custom", client });
    assert.equal(m.label, "custom");
  });
});

describe("AnthropicChatModel.create message translation", () => {
  test("tool results after an assistant turn open a new user turn and coalesce, keeping each result's cache breakpoint", async () => {
    const { client, box } = fakeAnthropic(anthResp());
    const m = new AnthropicChatModel({ apiKey: "x", model: "claude-x", client });
    await m.create({
      messages: [
        { role: "system", content: "sys", cacheBreakpoint: true },
        { role: "user", content: "do it" },
        {
          role: "assistant",
          content: "calling",
          toolCalls: [
            { id: "t1", name: "lookup", args: { q: 1 } },
            { id: "t2", name: "lookup", args: { q: 2 } },
          ],
        },
        { role: "tool", content: "r1", toolCallId: "t1" },
        { role: "tool", content: "r2", cacheBreakpoint: true } as any,
      ],
    });
    const p = box.params;
    assert.deepEqual(p.system, [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
    assert.equal(p.messages.length, 3);
    assert.equal(p.messages[0].role, "user");
    assert.deepEqual(p.messages[0].content, [{ type: "text", text: "do it" }]);

    const asst = p.messages[1];
    assert.equal(asst.role, "assistant");
    assert.deepEqual(asst.content, [
      { type: "text", text: "calling" },
      { type: "tool_use", id: "t1", name: "lookup", input: { q: 1 } },
      { type: "tool_use", id: "t2", name: "lookup", input: { q: 2 } },
    ]);

    const results = p.messages[2];
    assert.equal(results.role, "user");
    assert.equal(results.content.length, 2);
    assert.equal(results.content[0].type, "tool_result");
    assert.equal(results.content[0].tool_use_id, "t1");
    assert.deepEqual(results.content[0].content, [{ type: "text", text: "r1" }]);
    assert.equal(results.content[0].cache_control, undefined);
    assert.equal(results.content[1].type, "tool_result");
    assert.deepEqual(results.content[1].cache_control, { type: "ephemeral" });
    assert.equal(p.max_tokens, 4096);
    assert.equal(p.tools, undefined);
    assert.equal(p.tool_choice, undefined);
  });

  test("tool result as the very first message starts its own user turn", async () => {
    const { client, box } = fakeAnthropic(anthResp());
    const m = new AnthropicChatModel({ apiKey: "x", model: "claude-x", client });
    await m.create({ messages: [{ role: "tool", content: "lonely", toolCallId: "z" }] });
    assert.equal(box.params.messages.length, 1);
    assert.equal(box.params.messages[0].role, "user");
    assert.equal(box.params.messages[0].content[0].tool_use_id, "z");
    assert.equal(box.params.system, undefined);
  });

  test("assistant with anthropic providerRaw replays verbatim; foreign providerRaw is reconstructed", async () => {
    const { client, box } = fakeAnthropic(anthResp());
    const m = new AnthropicChatModel({ apiKey: "x", model: "claude-x", client });
    const raw = { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "sig" }] };
    await m.create({
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "rebuilt", providerRaw: { provider: "anthropic", raw } },
        { role: "user", content: "b" },
        { role: "assistant", content: "", toolCalls: [{ id: "c", name: "n", args: {} }], providerRaw: { provider: "openai", raw: { x: 1 } } },
        { role: "assistant", content: "" },
      ],
      maxTokens: 123,
    });
    const msgs = box.params.messages;
    assert.equal(msgs[1], raw);
    assert.deepEqual(msgs[3], { role: "assistant", content: [{ type: "tool_use", id: "c", name: "n", input: {} }] });
    assert.deepEqual(msgs[4], { role: "assistant", content: [] });
    assert.equal(box.params.max_tokens, 123);
  });

  test("temperature is never forwarded", async () => {
    const { client, box } = fakeAnthropic(anthResp());
    const m = new AnthropicChatModel({ apiKey: "x", model: "claude-x", client });
    await m.create({ messages: [{ role: "user", content: "hi", cacheBreakpoint: true }], temperature: 0.5 });
    assert.equal("temperature" in box.params, false);
    assert.deepEqual(box.params.messages[0].content[0].cache_control, { type: "ephemeral" });
  });
});

describe("AnthropicChatModel.create response formats", () => {
  const tools = [{ name: "record", description: "rec", parameters: { type: "object", properties: {} } }];

  test("json mode appends emit_json, forces it, and returns its input as text", async () => {
    const { client, box } = fakeAnthropic(
      anthResp({
        content: [
          { type: "tool_use", id: "u1", name: "emit_json", input: { correct: true } },
          { type: "tool_use", id: "u2", name: "record", input: { a: 1 } },
        ],
        stop_reason: "tool_use",
      }),
    );
    const m = new AnthropicChatModel({ apiKey: "x", model: "claude-x", client });
    const res = await m.create({ messages: [{ role: "user", content: "grade" }], tools, responseFormat: { kind: "json" } });
    assert.deepEqual(box.params.tools.map((t: any) => t.name), ["record", "emit_json"]);
    assert.deepEqual(box.params.tools[0].input_schema, tools[0].parameters);
    assert.deepEqual(box.params.tool_choice, { type: "tool", name: "emit_json" });
    assert.equal(res.text, '{"correct":true}');
    assert.deepEqual(res.toolCalls, [{ id: "u2", name: "record", args: { a: 1 } }]);
    assert.equal(res.stopReason, "tool_use");
    assert.deepEqual(res.assistant.toolCalls, [{ id: "u2", name: "record", args: { a: 1 } }]);
  });

  test("json mode without tools and without an emit_json call keeps plain text", async () => {
    const { client, box } = fakeAnthropic(anthResp({ content: [{ type: "text", text: "{\"x\":1}" }] }));
    const m = new AnthropicChatModel({ apiKey: "x", model: "claude-x", client });
    const res = await m.create({ messages: [{ role: "user", content: "g" }], responseFormat: { kind: "json" } });
    assert.deepEqual(box.params.tools.map((t: any) => t.name), ["emit_json"]);
    assert.equal(res.text, '{"x":1}');
    assert.deepEqual(res.toolCalls, []);
    assert.equal(res.assistant.toolCalls, undefined);
  });

  test("tool mode forces the named tool and returns parsed tool calls", async () => {
    const { client, box } = fakeAnthropic(
      anthResp({ content: [{ type: "text", text: "pre " }, { type: "tool_use", id: "u", name: "record", input: { n: [1] } }] }),
    );
    const m = new AnthropicChatModel({ apiKey: "x", model: "claude-x", client });
    const res = await m.create({ messages: [{ role: "user", content: "go" }], tools, responseFormat: { kind: "tool", name: "record" } });
    assert.deepEqual(box.params.tool_choice, { type: "tool", name: "record" });
    assert.equal(box.params.tools.length, 1);
    assert.equal(res.text, "pre ");
    assert.deepEqual(res.toolCalls, [{ id: "u", name: "record", args: { n: [1] } }]);
  });

  test("text mode with tools offers them without forcing; ignores unknown blocks", async () => {
    const { client, box } = fakeAnthropic(
      anthResp({
        content: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "text", text: "a" }, { type: "text", text: "b" }],
        stop_reason: null,
        usage: { input_tokens: 7, output_tokens: 1 },
      }),
    );
    const m = new AnthropicChatModel({ apiKey: "x", model: "claude-x", client });
    const res = await m.create({ messages: [{ role: "user", content: "hi" }], tools });
    assert.equal(box.params.tools.length, 1);
    assert.equal(box.params.tool_choice, undefined);
    assert.equal(res.text, "ab");
    assert.equal(res.stopReason, null);
    assert.deepEqual(res.usage, { input: 7, output: 1, cacheRead: 0, cacheCreate: 0 });
    assert.equal(res.assistant.providerRaw?.provider, "anthropic");
    assert.equal((res.assistant.providerRaw?.raw as any).content.length, 3);
  });

  test("usage maps cache fields through", async () => {
    const { client, box } = fakeAnthropic(anthResp());
    const m = new AnthropicChatModel({ apiKey: "x", model: "claude-x", client });
    const res = await m.create({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(box.calls, 1);
    assert.equal(box.params.model, "claude-x");
    assert.deepEqual(res.usage, { input: 10, output: 5, cacheRead: 2, cacheCreate: 3 });
    assert.equal(res.stopReason, "end_turn");
  });
});
