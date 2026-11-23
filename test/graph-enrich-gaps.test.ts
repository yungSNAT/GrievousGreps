import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { enrichGraph } from "../src/graph/enrich.js";
import { formatCruxMiss, type CruxSummarizer, type FileCruxInput } from "../src/ai/crux.js";
import type { NodeV1 } from "../src/graph/types.js";

const file = "counter.ts";
const incrementLine = "  increment() { this.value += 2; }";
const currentLine = "  current() { return this.value; }";
const source = [
  "class Counter {",
  "  private value = 0;",
  incrementLine,
  "  reset() { this.value = 0; }",
  currentLine,
  "}",
].join("\n");

function methodNode(name: string, bodyHash: string, line: number): NodeV1 {
  return {
    id: `${file}#${name}`,
    name,
    kind: "method",
    path: file,
    span: `L${line}-L${line}`,
    signature: `${name}()`,
    exported: true,
    origin: "ast",
    body_hash: bodyHash,
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

function fixture() {
  const changed = methodNode("increment", "increment-v2", 3);
  const fresh = methodNode("reset", "reset-v1", 4);
  const unchanged = methodNode("current", "current-v1", 5);
  const oldChanged: NodeV1 = {
    ...changed,
    body_hash: "increment-v1",
    summary_state: "ready",
    summary: "Increase the counter by one.",
    crux: { span: "L3-L3", code: "  increment() { this.value += 1; }" },
  };
  const oldUnchanged: NodeV1 = {
    ...unchanged,
    summary_state: "ready",
    summary: "Read the current count.",
    crux: { span: "L5-L5", code: currentLine },
  };
  return {
    nodes: [changed, fresh, unchanged],
    changed,
    fresh,
    unchanged,
    oldChanged,
    oldUnchanged,
    prior: new Map([
      [oldChanged.id, oldChanged],
      [oldUnchanged.id, oldUnchanged],
    ]),
    sources: new Map([[file, source]]),
  };
}

function assertMeaning(
  node: NodeV1,
  state: NodeV1["summary_state"],
  summary: NodeV1["summary"],
  crux: NodeV1["crux"],
): void {
  assert.equal(node.summary_state, state, `${node.id} state`);
  assert.equal(node.summary, summary, `${node.id} summary`);
  assert.deepEqual(node.crux, crux, `${node.id} crux`);
}

describe("enrichGraph cache and dirty nodes", () => {
  let restoreFetch: (() => void) | undefined;

  before(() => {
    const fetchStub = mock.method(globalThis, "fetch", async () => {
      throw new Error("Unexpected HTTP request in an offline enrichment test");
    });
    restoreFetch = () => fetchStub.mock.restore();
  });

  after(() => {
    restoreFetch?.();
  });

  test("a plain build keeps changed summaries as stale and counts untouched nodes as pending", async () => {
    const { nodes, changed, fresh, unchanged, oldChanged, oldUnchanged, prior, sources } = fixture();
    // An unchanged body is not a cache hit if the previous build never summarized it.
    prior.set(fresh.id, { ...fresh });

    const stats = await enrichGraph(nodes, prior, sources);

    assert.deepEqual(stats, {
      cached: 1,
      computed: 0,
      stale: 1,
      pending: 1,
      errors: [],
      failedFiles: 0,
      skippedFiles: 0,
    });
    assertMeaning(changed, "stale", oldChanged.summary, oldChanged.crux);
    assert.equal(changed.body_hash, "increment-v2");
    assertMeaning(fresh, "pending", null, null);
    assertMeaning(unchanged, "ready", oldUnchanged.summary, oldUnchanged.crux);
  });

  test("a deep build batches stale and new nodes, then retries only the omitted node", async () => {
    const { nodes, changed, fresh, unchanged, oldUnchanged, prior, sources } = fixture();
    const calls: FileCruxInput[] = [];
    const summarizer: CruxSummarizer = {
      async describeFile(input) {
        calls.push(input);
        if (calls.length === 1) {
          return [{
            id: changed.id,
            summary: "Increase the counter by two.",
            crux_start: 3,
            crux_end: 3,
          }];
        }
        return [{
          id: fresh.id,
          summary: "Reset the count to zero.",
          crux_start: 0,
          crux_end: 0,
        }];
      },
    };

    const stats = await enrichGraph(nodes, prior, sources, { summarizer });

    assert.deepEqual(calls.map((call) => call.nodes.map((node) => node.id)), [
      [changed.id, fresh.id],
      [fresh.id],
    ]);
    for (const call of calls) {
      assert.equal(call.path, file);
      assert.equal(call.source, source);
    }
    assert.equal(stats.cached, 1);
    assert.equal(stats.computed, 2);
    assert.equal(stats.stale, 0);
    assert.equal(stats.pending, 0);
    assert.equal(stats.failedFiles, 0);
    assert.deepEqual(stats.errors, []);
    assertMeaning(changed, "ready", "Increase the counter by two.", {
      span: "L3-L3",
      code: incrementLine,
    });
    assertMeaning(fresh, "ready", "Reset the count to zero.", null);
    assertMeaning(unchanged, "ready", oldUnchanged.summary, oldUnchanged.crux);
  });

  test("a complete miss after retry preserves the stale hint and leaves the new node pending", async () => {
    const { nodes, changed, fresh, oldChanged, prior, sources } = fixture();
    const requests: string[][] = [];
    const summarizer: CruxSummarizer = {
      async describeFile({ nodes }) {
        requests.push(nodes.map((node) => node.id));
        return [];
      },
    };

    const stats = await enrichGraph(nodes, prior, sources, { summarizer });

    assert.deepEqual(requests, [
      [changed.id, fresh.id],
      [changed.id, fresh.id],
    ]);
    assert.equal(stats.computed, 0);
    assert.equal(stats.stale, 1);
    assert.equal(stats.pending, 1);
    assert.equal(stats.failedFiles, 1);
    assert.equal(stats.fatal, undefined);
    assert.deepEqual(stats.errors, [`${file}: ${formatCruxMiss("empty-toolCalls", null)}`]);
    assertMeaning(changed, "stale", oldChanged.summary, oldChanged.crux);
    assertMeaning(fresh, "pending", null, null);
  });
});
