import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { OpenAIChatModel, ProviderResponseError } from "../src/ai/llm/openai.js";
import type { ChatRequest } from "../src/ai/llm/types.js";

const ENV_KEYS = ["GRAFT_LLM_RETRIES", "GRAFT_LLM_FORCED_RESCUES"] as const;
const savedEnv: Record<string, string | undefined> = {};

before(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.GRAFT_LLM_FORCED_RESCUES;
});
after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

let seq = 0;
const uniq = (tag: string) => `${tag}-${++seq}-${process.pid}`;
const noSleep = async () => {};

function scripted(steps: unknown[]) {
  const calls: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (p: any) => {
          calls.push(p);
          const s = steps[Math.min(calls.length - 1, steps.length - 1)];
          if (s instanceof Error) throw s;
          return s;
        },
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
}

const textReply = (content: unknown) => ({
  choices: [{ message: { content, tool_calls: [] }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
});
const callReply = (...pairs: Array<[string, string]>) => ({
  choices: [
    {
      message: {
        content: null,
        tool_calls: pairs.map(([name, args], i) => ({ id: `c${i}`, type: "function", function: { name, arguments: args } })),
      },
      finish_reason: "tool_calls",
    },
  ],
});
const errored = (message?: unknown, code?: unknown) => ({ error: { message, code } });
const apiErr = (msg: string) => new OpenAI.APIError(400, { message: msg }, msg, new Headers());

const recordTool = { name: "record", description: "d", parameters: { type: "object" } };
const toolReq = (): ChatRequest => ({
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
  ],
  tools: [recordTool],
  responseFormat: { kind: "tool", name: "record" },
});
const jsonReq = (): ChatRequest => ({ messages: [{ role: "user", content: "grade" }], responseFormat: { kind: "json" } });
const FORCED_RECORD = { type: "function", function: { name: "record" } };

function model(client: OpenAI, name = uniq("m"), extra: Record<string, unknown> = {}) {
  return new OpenAIChatModel({ apiKey: "x", model: name, baseUrl: "https://gw.example/v1", client, sleep: noSleep, ...extra });
}

describe("constructor", () => {
  test("label defaults to openai:<model> and honours an explicit label; builds its own client", () => {
    const a = new OpenAIChatModel({ apiKey: "k", model: "gpt-q", baseUrl: "http://127.0.0.1:9/v1", headers: { "X-Title": "t" } });
    assert.equal(a.label, "openai:gpt-q");
    const b = new OpenAIChatModel({ apiKey: "k", model: "gpt-q", label: "custom" });
    assert.equal(b.label, "custom");
  });
});

describe("message and response mapping", () => {
  test("tool/assistant messages, plain tools without forcing", async () => {
    const { client, calls } = scripted([textReply("ok")]);
    await model(client).create({
      messages: [
        { role: "system", content: "s", cacheBreakpoint: true },
        { role: "tool", content: "result" },
        { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "f", args: undefined as any }] },
        { role: "assistant", content: "hi", providerRaw: { provider: "anthropic", raw: { x: 1 } } },
      ],
      tools: [recordTool],
    });
    const p = calls[0];
    assert.equal(p.messages[0].content[0].cache_control.type, "ephemeral");
    assert.deepEqual(p.messages[1], { role: "tool", tool_call_id: "", content: "result" });
    assert.equal(p.messages[2].content, null);
    assert.deepEqual(p.messages[2].tool_calls, [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }]);
    assert.deepEqual(p.messages[3], { role: "assistant", content: "hi" });
    assert.equal(p.tools.length, 1);
    assert.equal(p.tool_choice, undefined);
  });

  test("non-function calls are dropped, bad arguments parse to {}, missing usage is zero", async () => {
    const { client } = scripted([
      {
        choices: [
          {
            message: {
              content: "t",
              tool_calls: [
                { id: "a", type: "function", function: { name: "f", arguments: "not json" } },
                { id: "b", type: "function", function: { name: "g", arguments: "" } },
                { id: "c", type: "custom", custom: { name: "h", input: "" } },
              ],
            },
          },
        ],
      },
    ]);
    const res = await model(client).create({ messages: [{ role: "user", content: "hi" }] });
    assert.deepEqual(
      res.toolCalls.map((c) => [c.name, c.args]),
      [
        ["f", {}],
        ["g", {}],
      ],
    );
    assert.deepEqual(res.usage, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
    assert.equal(res.stopReason, null);
    assert.equal(res.assistant.toolCalls?.length, 2);
    assert.equal(res.assistant.providerRaw?.provider, "openai");
  });

  test("an unrecognised content shape throws a descriptive error", async () => {
    const { client } = scripted([textReply(42)]);
    await assert.rejects(() => model(client).create({ messages: [{ role: "user", content: "hi" }] }), /Unsupported message\.content type from provider: number/);
  });

  test("json mode with caller tools keeps the caller's calls and hides emit_json", async () => {
    const { client, calls } = scripted([callReply(["lookup", '{"q":1}'], ["emit_json", '{"ok":1}'])]);
    const res = await model(client).create({ ...jsonReq(), tools: [{ name: "lookup", description: "d", parameters: { type: "object" } }] });
    assert.deepEqual(calls[0].tools.map((t: any) => t.function.name), ["lookup", "emit_json"]);
    assert.equal(res.text, '{"ok":1}');
    assert.deepEqual(res.toolCalls.map((c) => c.name), ["lookup"]);
  });
});

describe("200 bodies that are not completions", () => {
  test("an errored body is retried with backoff and then succeeds", async () => {
    process.env.GRAFT_LLM_RETRIES = "3";
    const sleeps: number[] = [];
    const { client, calls } = scripted([errored("upstream down", 502), textReply("ok")]);
    const m = model(client, uniq("m"), { sleep: async (ms: number) => void sleeps.push(ms) });
    const res = await m.create({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.text, "ok");
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [500]);
  });

  test("the typed error carries the provider's message and code once retries are spent", async () => {
    process.env.GRAFT_LLM_RETRIES = "0";
    const { client } = scripted([errored("boom", "upstream_error")]);
    const err = await model(client)
      .create({ messages: [{ role: "user", content: "hi" }] })
      .then(() => null, (e) => e);
    assert.ok(err instanceof ProviderResponseError);
    assert.equal(err.message, "boom");
    assert.equal(err.code, "upstream_error");
    assert.equal(err.status, 200);
    assert.equal(err.retryable, true);
    assert.equal(err.name, "ProviderResponseError");
  });

  test("blank message and non-scalar code fall back; empty choices and null bodies are typed too", async () => {
    process.env.GRAFT_LLM_RETRIES = "0";
    const req = { messages: [{ role: "user" as const, content: "hi" }] };
    const a = scripted([errored("   ", { nested: true })]);
    await assert.rejects(
      () => model(a.client).create(req),
      (e: any) => e instanceof ProviderResponseError && e.message === "the provider returned an error body with no choices" && e.code === undefined,
    );
    const b = scripted([{ choices: [] }]);
    await assert.rejects(() => model(b.client).create(req), /successful response with no choices/);
    const c = scripted([null]);
    await assert.rejects(() => model(c.client).create(req), ProviderResponseError);
  });
});

describe("structured rung ladder", () => {
  test("prose on the forced rung falls to required and marks the endpoint for later instances", async () => {
    const spy = mock.method(console, "error", () => {});
    try {
      const name = uniq("prose");
      const first = scripted([textReply("I cannot do that"), callReply(["record", '{"z":1}'])]);
      const res = await model(first.client, name).create(toolReq());
      assert.deepEqual(first.calls.map((c) => c.tool_choice), [FORCED_RECORD, "required"]);
      assert.deepEqual(res.toolCalls[0].args, { z: 1 });
      assert.equal(spy.mock.callCount(), 1);
      assert.match(String(spy.mock.calls[0].arguments[0]), new RegExp(`openai:${name}.*forced tool_choice`));

      const second = scripted([textReply('{"name":"record","parameters":"{\\"q\\":3}"}')]);
      const res2 = await model(second.client, name).create(toolReq());
      assert.equal(second.calls.length, 1);
      assert.equal(second.calls[0].tool_choice, "auto");
      const msgs = second.calls[0].messages;
      assert.equal(msgs.length, 3);
      assert.equal(msgs[0].content, "sys");
      assert.match(msgs[1].content, /Answer by calling the record tool/);
      assert.equal(msgs[2].content, "go");
      assert.deepEqual(res2.toolCalls, [{ id: "from-content", name: "record", args: { q: 3 } }]);
      assert.deepEqual(res2.assistant.toolCalls, [{ id: "from-content", name: "record", args: { q: 3 } }]);
      assert.equal(spy.mock.callCount(), 1); // logged once per endpoint + model
    } finally {
      spy.mock.restore();
    }
  });

  test("multiple tools skip 'required'; the payload is picked out of an emulated array", async () => {
    const spy = mock.method(console, "error", () => {});
    try {
      const { client, calls } = scripted([
        textReply("nope"),
        textReply('[{"name":"b","args":{"x":1}},{"name":"a","arguments":"{\\"y\\":2}"}]'),
      ]);
      const res = await model(client).create({
        messages: [{ role: "user", content: "go" }],
        tools: [
          { name: "a", description: "d", parameters: { type: "object" } },
          { name: "b", description: "d", parameters: { type: "object" } },
        ],
        responseFormat: { kind: "tool", name: "a" },
      });
      assert.deepEqual(calls.map((c) => c.tool_choice), [{ type: "function", function: { name: "a" } }, "auto"]);
      assert.equal(calls[1].messages[0].role, "system"); // inserted first when caller sent none
      assert.deepEqual(res.toolCalls, [{ id: "from-content", name: "a", args: { y: 2 } }]);
    } finally {
      spy.mock.restore();
    }
  });

  test("a sentence-wrapped call is accepted on the forced rung; nesting stops at the depth limit", async () => {
    const wrapped = scripted([textReply('Here you go: {"name":"record","parameters":{"a":1}} thanks')]);
    const r1 = await model(wrapped.client).create(toolReq());
    assert.equal(wrapped.calls.length, 1);
    assert.deepEqual(r1.toolCalls, [{ id: "from-content", name: "record", args: { a: 1 } }]);

    const inner = { name: "record", parameters: { k: 1 } };
    const deep = { name: "record", parameters: { name: "record", parameters: { name: "record", parameters: inner } } };
    const nested = scripted([textReply(JSON.stringify(deep))]);
    const r2 = await model(nested.client).create(toolReq());
    assert.deepEqual(r2.toolCalls[0].args, inner);
  });

  test("no recognisable payload on any rung passes the raw reply through", async () => {
    const spy = mock.method(console, "error", () => {});
    try {
      const { client, calls } = scripted([
        textReply('{"name":"record","parameters":"not json"}'),
        textReply('{"name":"record","parameters":[1,2]}'),
        textReply('{"name":"other","parameters":{"a":1}}'),
      ]);
      const res = await model(client).create(toolReq());
      assert.equal(calls.length, 3);
      assert.deepEqual(calls.map((c) => c.tool_choice), [FORCED_RECORD, "required", "auto"]);
      assert.equal(res.toolCalls.length, 0);
      assert.equal(res.text, '{"name":"other","parameters":{"a":1}}');
    } finally {
      spy.mock.restore();
    }
  });

  test("json mode lifts objects, arrays and fenced JSON out of content", async () => {
    const a = scripted([textReply('Sure: {"ok": true} done')]);
    const ra = await model(a.client).create(jsonReq());
    assert.equal(ra.text, '{"ok":true}');
    assert.equal(ra.assistant.content, '{"ok":true}');
    assert.equal(a.calls.length, 1);

    const b = scripted([textReply("values: [1, 2] end")]);
    assert.equal((await model(b.client).create(jsonReq())).text, "[1,2]");

    const c = scripted([textReply('```json\n{"a": 1}\n```')]);
    assert.equal((await model(c.client).create(jsonReq())).text, '{"a":1}');
  });

  test("json mode with prose on every rung returns the prose untouched", async () => {
    const spy = mock.method(console, "error", () => {});
    try {
      const { client, calls } = scripted([textReply(null), textReply("{ broken"), textReply("just words")]);
      const res = await model(client).create(jsonReq());
      assert.equal(calls.length, 3);
      assert.equal(res.text, "just words");
    } finally {
      spy.mock.restore();
    }
  });

  test("a non-provider error on a forced rung is rethrown at once", async () => {
    const { client, calls } = scripted([new Error("socket hang up")]);
    await assert.rejects(() => model(client).create(toolReq()), /socket hang up/);
    assert.equal(calls.length, 1);
  });
});

describe("forced rescues", () => {
  const rescueSteps = () => [errored("upstream down"), errored("upstream down"), callReply(["record", '{"a":1}'])];

  test("two rescues downgrade the endpoint; a forced success in between resets the count", async () => {
    process.env.GRAFT_LLM_RETRIES = "0";
    const spy = mock.method(console, "error", () => {});
    try {
      const name = uniq("rescue");
      const rescue = async () => {
        const s = scripted(rescueSteps());
        const res = await model(s.client, name).create(toolReq());
        assert.deepEqual(s.calls.map((c) => c.tool_choice), [FORCED_RECORD, "required", "auto"]);
        assert.deepEqual(res.toolCalls[0].args, { a: 1 });
      };
      await rescue();
      const ok = scripted([callReply(["record", '{"f":1}'])]);
      await model(ok.client, name).create(toolReq());
      assert.equal(ok.calls.length, 1);
      await rescue();
      assert.equal(spy.mock.callCount(), 0); // count was reset by the forced success
      await rescue();
      assert.equal(spy.mock.callCount(), 1);

      const after = scripted([callReply(["record", '{"b":2}'])]);
      const res = await model(after.client, name).create(toolReq());
      assert.equal(after.calls.length, 1);
      assert.equal(after.calls[0].tool_choice, "auto");
      assert.deepEqual(res.toolCalls[0].args, { b: 2 });
      assert.equal(spy.mock.callCount(), 1);
    } finally {
      spy.mock.restore();
    }
  });

  test("GRAFT_LLM_FORCED_RESCUES=1 downgrades after a single rescue", async () => {
    process.env.GRAFT_LLM_RETRIES = "0";
    process.env.GRAFT_LLM_FORCED_RESCUES = "1";
    const spy = mock.method(console, "error", () => {});
    try {
      const name = uniq("one");
      const s = scripted(rescueSteps());
      await model(s.client, name).create(toolReq());
      assert.equal(spy.mock.callCount(), 1);
      const next = scripted([callReply(["record", "{}"])]);
      await model(next.client, name).create(toolReq());
      assert.equal(next.calls.length, 1);
    } finally {
      delete process.env.GRAFT_LLM_FORCED_RESCUES;
      spy.mock.restore();
    }
  });
});

describe("400 compatibility fallbacks", () => {
  test("reasoning refusal turns reasoning off and keeps the forced tool", async () => {
    const { client, calls } = scripted([
      apiErr("Function tools with reasoning_effort are not supported for gpt-5 in /v1/chat/completions."),
      callReply(["record", '{"r":1}']),
    ]);
    const res = await model(client).create(toolReq());
    assert.equal(calls[1].reasoning_effort, "none");
    assert.deepEqual(calls[1].tool_choice, FORCED_RECORD);
    assert.deepEqual(res.toolCalls[0].args, { r: 1 });
  });

  test("DeepSeek thinking refusal: reasoning off first, then the string tool_choice", async () => {
    const msg = "Thinking mode does not support this tool_choice";
    const { client, calls } = scripted([apiErr(msg), apiErr(msg), callReply(["record", "{}"])]);
    await model(client).create(toolReq());
    assert.equal(calls.length, 3);
    assert.equal(calls[1].reasoning_effort, "none");
    assert.equal(calls[2].tool_choice, "required");
  });

  test("all four incompatibilities in a row end with a final unguarded call", async () => {
    const { client, calls } = scripted([
      apiErr("Function tools with reasoning_effort are not supported"),
      apiErr("Invalid tool_choice type: 'object'. Supported string values: none, auto, required"),
      apiErr("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."),
      apiErr("Unsupported value: 'temperature' does not support 0 with this model."),
      callReply(["record", '{"done":true}']),
    ]);
    const res = await model(client).create({ ...toolReq(), maxTokens: 50, temperature: 0 });
    assert.equal(calls.length, 5);
    const last = calls[4];
    assert.equal(last.reasoning_effort, "none");
    assert.equal(last.tool_choice, "required");
    assert.equal(last.max_completion_tokens, 50);
    assert.equal("max_tokens" in last, false);
    assert.equal("temperature" in last, false);
    assert.deepEqual(res.toolCalls[0].args, { done: true });
  });

  test("an unrelated 400, or a matching one with nothing to drop, is rethrown", async () => {
    const a = scripted([apiErr("model not found")]);
    await assert.rejects(() => model(a.client).create({ messages: [{ role: "user", content: "hi" }] }), OpenAI.APIError);
    assert.equal(a.calls.length, 1);
    const b = scripted([apiErr("'max_tokens' is not supported with this model. Use 'max_completion_tokens'")]);
    await assert.rejects(() => model(b.client).create({ messages: [{ role: "user", content: "hi" }] }), OpenAI.APIError);
    assert.equal(b.calls.length, 1);
  });
});
