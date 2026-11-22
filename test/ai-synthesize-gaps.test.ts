import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ChatSynthesizer, MAX_INPUT_CHARS } from "../src/ai/synthesize.js";
import type { ChatModel, ChatRequest, ChatResponse, ToolCall } from "../src/ai/llm/types.js";

class FakeChatModel implements ChatModel {
  readonly label = "fake:synthesize-gaps";
  last?: ChatRequest;
  calls = 0;
  constructor(private reply: { text?: string; toolCalls?: ToolCall[] }) {}
  async create(req: ChatRequest): Promise<ChatResponse> {
    this.last = req;
    this.calls++;
    return {
      text: this.reply.text ?? "",
      toolCalls: this.reply.toolCalls ?? [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      stopReason: "tool_calls",
      assistant: { role: "assistant", content: this.reply.text ?? "", toolCalls: this.reply.toolCalls },
    };
  }
}

async function withCapturedError<T>(fn: () => Promise<T>): Promise<{ result: T; err: string[] }> {
  const err: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  const origWarn = console.warn;
  const push = (...args: unknown[]) => {
    err.push(args.map((a) => String(a)).join(" "));
  };
  console.error = push;
  console.log = push;
  console.warn = push;
  try {
    return { result: await fn(), err };
  } finally {
    console.error = origErr;
    console.log = origLog;
    console.warn = origWarn;
  }
}

function userMessage(req: ChatRequest | undefined): string {
  assert.ok(req, "model must have been called");
  const msgs = req.messages as Array<{ role: string; content: unknown }>;
  const user = msgs.find((m) => m.role === "user");
  assert.ok(user, "expected a user message");
  return String(user.content);
}

function systemMessage(req: ChatRequest | undefined): string {
  assert.ok(req);
  const msgs = req.messages as Array<{ role: string; content: unknown }>;
  const sys = msgs.find((m) => m.role === "system");
  assert.ok(sys);
  return String(sys.content);
}

describe("ChatSynthesizer request shape", () => {
  test("no files means no model call and an empty result", async () => {
    const m = new FakeChatModel({ toolCalls: [] });
    const out = await new ChatSynthesizer(m).synthesize([]);
    assert.deepEqual(out, []);
    assert.equal(m.calls, 0);
  });

  test("short input is sent verbatim with the system prompt and record_graph schema", async () => {
    const m = new FakeChatModel({
      toolCalls: [
        {
          id: "1",
          name: "record_graph",
          args: { nodes: [{ name: "A", type: "system", summary: "s", sources: ["a.ts"], links: [] }] },
        },
      ],
    });
    const out = await new ChatSynthesizer(m).synthesize([
      { path: "a.ts", summary: "alpha" },
      { path: "b.ts", summary: "beta" },
    ]);
    assert.equal(out.length, 1);
    const user = userMessage(m.last);
    assert.equal(user, "## a.ts\n\nalpha\n\n## b.ts\n\nbeta");
    assert.ok(!user.includes("(truncated)"));
    const sys = systemMessage(m.last);
    assert.match(sys, /Only link to nodes you actually define in this response\./);
    assert.match(sys, /Respond only via the record_graph tool/);
    const tool = m.last!.tools![0]!;
    assert.equal(tool.name, "record_graph");
    const params = tool.parameters as any;
    const nodeProps = params.properties.nodes.items.properties;
    assert.equal(nodeProps.name.type, "string");
    assert.deepEqual(nodeProps.links.items.properties.relation.enum, [
      "part_of",
      "uses",
      "depends_on",
      "produces",
      "configures",
      "validates",
      "implements",
    ]);
    assert.deepEqual(m.last!.responseFormat, { kind: "tool", name: "record_graph" });
  });

  test("input over MAX_INPUT_CHARS is truncated with a marker", async () => {
    assert.equal(MAX_INPUT_CHARS, 60_000);
    const m = new FakeChatModel({
      toolCalls: [{ id: "1", name: "record_graph", args: { nodes: [{ name: "Big", type: "file" }] } }],
    });
    const big = "y".repeat(MAX_INPUT_CHARS + 5_000);
    const out = await new ChatSynthesizer(m).synthesize([{ path: "big.ts", summary: big }]);
    assert.equal(out[0]!.name, "Big");
    const user = userMessage(m.last);
    assert.ok(user.endsWith("\n… (truncated)"), "must end with truncation marker");
    assert.equal(user.length, MAX_INPUT_CHARS + "\n… (truncated)".length);
    assert.ok(user.startsWith("## big.ts\n\nyyy"));
  });
});

describe("ChatSynthesizer cleaning of nodes", () => {
  test("normalizes fields, drops malformed nodes and links", async () => {
    const m = new FakeChatModel({
      toolCalls: [
        {
          id: "1",
          name: "record_graph",
          args: {
            nodes: [
              null,
              { name: "NoType" },
              { name: 42, type: "system" },
              {
                name: "Engine",
                type: "system",
                summary: "Runs things.",
                sources: ["src/a.ts", 7, "src/b.ts"],
                links: [
                  { to: "Config", relation: "uses", description: "reads settings" },
                  { to: "Config", relation: "configures", description: 99 },
                  { to: "Missing" },
                  null,
                  { relation: "uses" },
                ],
              },
              { name: "Config", type: "concept", summary: 5, sources: "nope", links: "nope" },
            ],
          },
        },
      ],
    });
    const { result, err } = await withCapturedError(() =>
      new ChatSynthesizer(m).synthesize([{ path: "src/a.ts", summary: "x" }]),
    );
    assert.equal(result.length, 2);
    const [engine, config] = result;
    assert.equal(engine!.name, "Engine");
    assert.equal(engine!.type, "system");
    assert.equal(engine!.summary, "Runs things.");
    assert.deepEqual(engine!.sources, ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(engine!.links, [
      { to: "Config", relation: "uses", description: "reads settings" },
      { to: "Config", relation: "configures", description: undefined },
    ]);
    assert.deepEqual(config, { name: "Config", type: "concept", summary: "", sources: [], links: [] });
    assert.ok(!err.some((l) => /empty batch/.test(l)), `unexpected warning: ${err.join(" | ")}`);
  });

  test("prefers the record_graph call over another tool call", async () => {
    const m = new FakeChatModel({
      toolCalls: [
        { id: "0", name: "other_tool", args: { nodes: [{ name: "Wrong", type: "file" }] } },
        { id: "1", name: "record_graph", args: { nodes: [{ name: "Right", type: "file" }] } },
      ],
    });
    const out = await new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]);
    assert.deepEqual(
      out.map((n) => n.name),
      ["Right"],
    );
  });
});

describe("ChatSynthesizer odd payloads", () => {
  test("nodes as a valid JSON string is parsed and warned about without salvage", async () => {
    const nodes = JSON.stringify([{ name: "Parsed", type: "concept", summary: "p", sources: [] }]);
    const m = new FakeChatModel({ toolCalls: [{ id: "1", name: "record_graph", args: { nodes } }] });
    const { result, err } = await withCapturedError(() =>
      new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]),
    );
    assert.deepEqual(
      result.map((n) => n.name),
      ["Parsed"],
    );
    assert.ok(err.some((l) => l.includes(`${nodes.length}-char string`) && l.includes("1 tool call(s)")));
    assert.ok(!err.some((l) => /salvaged/.test(l)));
  });

  test("a JSON string that parses to a non-array yields an empty batch warning", async () => {
    const nodes = JSON.stringify({ name: "Solo", type: "file" });
    const m = new FakeChatModel({ toolCalls: [{ id: "1", name: "record_graph", args: { nodes } }] });
    const { result, err } = await withCapturedError(() =>
      new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]),
    );
    assert.deepEqual(result, []);
    assert.ok(err.some((l) => /empty batch/.test(l) && l.includes(`"nodes" is string, ${nodes.length} chars`)));
  });

  test("salvage skips unbalanced, non-named and escaped-quote objects correctly", async () => {
    const raw =
      '[{"name":"Esc \\"q\\" {brace}","type":"file"},{"type":"no-name"},{"name":"Bad" "type":"x"},' +
      '{"name":"Tail","type":"concept"}} {"name":"open';
    const m = new FakeChatModel({ toolCalls: [{ id: "1", name: "record_graph", args: { nodes: raw } }] });
    const { result, err } = await withCapturedError(() =>
      new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]),
    );
    assert.deepEqual(
      result.map((n) => n.name),
      ['Esc "q" {brace}', "Tail"],
    );
    assert.ok(err.some((l) => /salvaged 2 node\(s\)/.test(l)));
  });

  test("nodes of a non-string, non-array type reports its type", async () => {
    const m = new FakeChatModel({ toolCalls: [{ id: "1", name: "record_graph", args: { nodes: 5 } }] });
    const { result, err } = await withCapturedError(() =>
      new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]),
    );
    assert.deepEqual(result, []);
    assert.ok(err.some((l) => l.includes('"nodes" is number') && l.includes("1 tool call(s)")));
  });

  test("missing nodes key reports undefined", async () => {
    const m = new FakeChatModel({ toolCalls: [{ id: "1", name: "record_graph", args: {} }] });
    const { result, err } = await withCapturedError(() =>
      new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]),
    );
    assert.deepEqual(result, []);
    assert.ok(err.some((l) => l.includes('"nodes" is undefined')));
  });

  test("no tool call and empty text warns and returns nothing", async () => {
    const m = new FakeChatModel({ text: "", toolCalls: [] });
    const { result, err } = await withCapturedError(() =>
      new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]),
    );
    assert.deepEqual(result, []);
    assert.ok(err.some((l) => /synthesize/.test(l)));
    assert.ok(err.some((l) => /0 tool call\(s\)/.test(l)));
  });

  test("tool_choice ignored: nodes recovered from JSON content", async () => {
    const text = JSON.stringify({
      nodes: [{ name: "FromText", type: "system", summary: "t", sources: ["a.ts"], links: [] }],
    });
    const m = new FakeChatModel({ text, toolCalls: [] });
    const { result } = await withCapturedError(() =>
      new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]),
    );
    assert.deepEqual(
      result.map((n) => n.name),
      ["FromText"],
    );
    assert.deepEqual(result[0]!.sources, ["a.ts"]);
  });
});
