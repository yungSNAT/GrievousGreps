import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  recoverToolArgsFromContent,
  unwrapMarkdownFence,
} from "../src/ai/llm/recover-tool.js";

const graphTool = { toolNames: ["record_graph"], payloadKey: "nodes" };
const authNode = { name: "Auth", summary: "Checks credentials" };

describe("unwrapMarkdownFence", () => {
  test("strips both labeled and unlabeled fences without changing the JSON body", () => {
    const body = '{ "nodes": [] }';
    assert.equal(unwrapMarkdownFence("```JsOn\r\n" + body + "\r\n```"), body);
    assert.equal(unwrapMarkdownFence("```\n" + body + "\n```"), body);
  });

  test("keeps a short JSON body when the closing fence is missing", () => {
    assert.equal(unwrapMarkdownFence("```[]"), "[]");
  });

  test("trims unfenced JSON without stripping literal backticks within it", () => {
    const body = '{"summary":"Use `check` to validate the input"}';
    assert.equal(unwrapMarkdownFence(` \n${body}\t `), body);
  });
});

describe("recoverToolArgsFromContent truncation repair", () => {
  test("recovers complete wrapped nodes despite escaped quotes and brackets in strings", () => {
    const nodes = [
      authNode,
      { name: "Parser", summary: 'Reads a "}" token, a "]" token, and a literal \\.' },
    ];
    const text =
      '```JSON\n{"name":"record_graph","arguments":{"nodes":[' +
      nodes.map((node) => JSON.stringify(node)).join(",") +
      ',{"name":"Draft","summary":"Still writing } and ]';

    assert.deepEqual(recoverToolArgsFromContent(text, graphTool), { nodes });
  });

  test("closes a bare item array after the last complete named node", () => {
    const text = `[${JSON.stringify(authNode)},{"name":"Stor`;
    assert.deepEqual(recoverToolArgsFromContent(text, graphTool), { nodes: [authNode] });
  });

  for (const [kind, unfinishedNode] of [
    ["metadata object", '{"name":"Storage","metadata":{"owner":"Runtime"}'],
    ["link object", '{"name":"Storage","links":[{"target":"Auth"}'],
  ] as const) {
    test(`does not turn a complete ${kind} into a complete node`, () => {
      const withCompleteNode = `{"nodes":[${JSON.stringify(authNode)},${unfinishedNode}`;
      assert.deepEqual(recoverToolArgsFromContent(withCompleteNode, graphTool), {
        nodes: [authNode],
      });

      const withoutCompleteNode = `{"nodes":[${unfinishedNode}`;
      assert.equal(recoverToolArgsFromContent(withoutCompleteNode, graphTool), undefined);
    });
  }

  test("repairs eight unmatched openers but refuses to invent a ninth closer", () => {
    const truncatedReply = (extraWrappers: number) =>
      '{"name":"record_graph","arguments":' +
      '{"args":'.repeat(extraWrappers) +
      `{"nodes":[${JSON.stringify(authNode)},{"name":"Stor`;

    // The named wrapper, payload object, and nodes array add three openers.
    assert.deepEqual(recoverToolArgsFromContent(truncatedReply(5), graphTool), {
      nodes: [authNode],
    });
    assert.equal(recoverToolArgsFromContent(truncatedReply(6), graphTool), undefined);
  });
});
