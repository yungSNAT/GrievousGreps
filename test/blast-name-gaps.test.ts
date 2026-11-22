import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { applyNames, ChatNamer, sanitize, type Cluster } from "../src/blast/name.js";
import type { BlastReport } from "../src/blast/blast.js";
import type { ChatModel, ChatRequest, ChatResponse } from "../src/ai/llm/types.js";
import type { GraphV1 } from "../src/graph/types.js";
import { tmpRepo } from "./helpers.js";

function namesCall(args: unknown): ChatResponse["toolCalls"] {
  return [{ id: "names-1", name: "record_names", args }];
}

function modelReply(toolCalls: ChatResponse["toolCalls"]) {
  return {
    label: "fake:blast-name-gaps",
    create: mock.fn(async (_request: ChatRequest): Promise<ChatResponse> => ({
      text: "",
      toolCalls,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      stopReason: "tool_calls",
      assistant: { role: "assistant", content: "", toolCalls },
    })),
  } satisfies ChatModel;
}

describe("ChatNamer's naming tool", () => {
  test("requests one structured answer and tells the model when to decline", async () => {
    const file = join("src", "sessions", "renew.ts");
    const model = modelReply(namesCall({
      names: [{ key: "session", name: "Session Renewal Gate" }],
    }));

    const names = await new ChatNamer(model).name([
      { key: "session", files: [file], symbols: ["renewSession"] },
    ]);

    assert.equal(names.get("session"), "Session Renewal Gate");
    assert.equal(model.create.mock.callCount(), 1);
    const [request] = model.create.mock.calls[0].arguments;
    assert.equal(request.temperature, 0);
    assert.equal(request.maxTokens, 1024);
    assert.deepEqual(request.responseFormat, { kind: "tool", name: "record_names" });
    assert.deepEqual(request.tools?.map((tool) => tool.name), ["record_names"]);

    const tool = request.tools?.[0];
    assert.ok(tool);
    assert.equal(tool.parameters.type, "object");
    assert.deepEqual(tool.parameters.required, ["names"]);
    assert.equal(tool.parameters.additionalProperties, false);
    const { names: arraySchema } = tool.parameters.properties as {
      names: {
        type: string;
        items: { required: string[]; additionalProperties: boolean };
      };
    };
    assert.equal(arraySchema.type, "array");
    assert.deepEqual(arraySchema.items.required, ["key", "name"]);
    assert.equal(arraySchema.items.additionalProperties, false);

    const system = request.messages.find((message) => message.role === "system")?.content;
    assert.equal(typeof system, "string");
    assert.match(system as string, /Name the RESPONSIBILITY, not the mechanics/);
    assert.match(system as string, /answer exactly "mixed"/);
    assert.equal(
      request.messages.find((message) => message.role === "user")?.content,
      `key: session\n  files: ${file}\n  symbols: renewSession`,
    );
  });

  test("skips unusable rows without losing clean names from the same reply", async () => {
    const clusters: Cluster[] = [
      "blank", "unlabelled", "punctuation", "cross-cutting", "session", "media",
    ].map((key) => ({
      key, files: [join("src", `${key}.ts`)], symbols: [],
    }));
    const model = modelReply(namesCall({
      names: [
        null,
        { name: "Orphan Name" },
        { key: "unlabelled" },
        { key: "blank", name: "" },
        { key: "punctuation", name: "<>|[]#" },
        { key: "cross-cutting", name: " \r\n`mIxEd`\t" },
        { key: "session", name: '  "Session"\r\n| Renewal\tGate  ' },
        { key: "media", name: "Mixed Media Playback" },
      ],
    }));

    assert.deepEqual(await new ChatNamer(model).name(clusters), new Map([
      ["session", "Session Renewal Gate"],
      ["media", "Mixed Media Playback"],
    ]));
  });

  for (const [scenario, toolCalls] of [
    ["no tool call", []],
    ["a tool call with no arguments", namesCall(undefined)],
    ["arguments with no names field", namesCall({})],
  ] satisfies [string, ChatResponse["toolCalls"]][]) {
    test(`${scenario} supplies no labels`, async () => {
      const model = modelReply(toolCalls);
      const names = await new ChatNamer(model).name([
        { key: "assets", files: [join("src", "bundle.ts")], symbols: ["bundle"] },
      ]);

      assert.equal(model.create.mock.callCount(), 1);
      assert.equal(names.size, 0);
    });
  }
});

describe("sanitize", () => {
  test("removes label and table delimiters without joining words across line breaks", () => {
    assert.equal(
      sanitize(" \t<['`Session`']>\r\n(Refresh)|\n{Gate}# "),
      "Session Refresh Gate",
    );
    assert.equal(sanitize("<>\"'`|(){}[]#\r\n\t"), "");
  });

  test("keeps the useful start of an overlong label within the display limit", () => {
    const label = sanitize('"Session Renewal Gate" For Every Active Client In The Workspace');

    assert.match(label, /^Session Renewal Gate\b/);
    assert.ok(label.length <= 31, `label is too long: ${label}`);
    assert.ok(!label.includes("Workspace"));
  });
});

describe("applyNames on a wide diff", () => {
  let root: string | undefined;
  let contextDir: string;

  before(() => {
    root = tmpRepo("blast-name-gaps");
    contextDir = join(root, "graft");
    mkdirSync(contextDir);
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("names at most twelve clusters per call and caches the last batch too", async () => {
    const features = Array.from({ length: 14 }, (_, i) => ({
      file: join("src", `feature-${i + 1}`, "routes.ts"),
      symbol: `routeFeature${i + 1}`,
      label: `Feature ${i + 1} Routing`,
    }));
    const graph: GraphV1 = {
      meta: { version: 1, generated: "", root: "." } as GraphV1["meta"],
      nodes: features.map(({ file }, i) => ({
        id: file, name: "routes.ts", kind: "file", path: file, span: "L1-L9",
        signature: null, exported: true, origin: "ast", body_hash: `body-${i}`, chars: 10,
      })) as GraphV1["nodes"],
      edges: [],
    };
    const makeReport = (): BlastReport => ({
      basis: "origin/main...HEAD", depth: 2, changed: [], unindexed: [], deleted: [],
      seeds: [], impacted: [], testModules: [], areas: [],
      modules: features.map(({ file, symbol }) => ({
        key: file,
        label: symbol,
        labelSource: "symbol",
        files: [file],
        from: [],
        symbols: [{
          id: `${file}#${symbol}`, name: symbol, kind: "function", path: file,
          span: "L1-L2", relation: "calls", depth: 1,
        }],
      })),
    });
    const labelBySymbol = new Map(features.map(({ symbol, label }) => [symbol, label]));
    const name = mock.fn(async (clusters: Cluster[]) => {
      const answer = new Map<string, string>();
      for (const cluster of clusters) {
        const label = labelBySymbol.get(cluster.symbols[0]);
        if (label) answer.set(cluster.key, label);
      }
      return answer;
    });
    const opts = { contextDir, namer: { name } };
    const expectedLabels = features.map(({ label }) => [label, "named"]);
    const files = features.map(({ file }) => file);

    const cold = makeReport();
    assert.deepEqual(await applyNames(graph, cold, opts), { named: 14, cached: 0, declined: 0 });
    assert.deepEqual(
      name.mock.calls.map(({ arguments: [batch] }) => batch.map((cluster) => cluster.files[0])),
      [files.slice(0, 12), files.slice(12)],
    );
    assert.deepEqual(cold.modules.map(({ label, labelSource }) => [label, labelSource]), expectedLabels);

    const warm = makeReport();
    assert.deepEqual(await applyNames(graph, warm, opts), { named: 0, cached: 14, declined: 0 });
    assert.equal(name.mock.callCount(), 2, "neither batch should reach the namer again");
    assert.deepEqual(warm.modules.map(({ label, labelSource }) => [label, labelSource]), expectedLabels);
  });
});
