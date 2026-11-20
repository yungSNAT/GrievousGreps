import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDeploy } from "../src/graph/deploy.js";
import { impactOfMany } from "../src/graph/traverse.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const LIMIT_MS = 3000;

function quick<T>(what: string, run: () => T): T {
  const start = performance.now();
  const out = run();
  const ms = performance.now() - start;
  assert.ok(ms < LIMIT_MS, `${what} took ${ms.toFixed(0)} ms`);
  return out;
}

test("a Dockerfile line ending in a long run of spaces is read in linear time", { timeout: 120_000 }, () => {
  const x = quick("extractDeploy", () => extractDeploy("Dockerfile", `FROM python:3.12\nRUN ${" ".repeat(300_000)}x\n`, "dockerfile"));
  assert.equal(x.skipped, undefined);
});

test("a Dockerfile with 20,000 stages or 80,000 COPY lines is read in linear time", { timeout: 300_000 }, () => {
  const stages = quick("20,000 stages", () => extractDeploy("Dockerfile", Array.from({ length: 20_000 }, (_, i) => `FROM python:3.12 AS s${i}`).join("\n"), "dockerfile"));
  assert.equal(stages.nodes.filter((n) => n.kind === "resource").length, 20_000);
  const copies = quick("80,000 COPY lines", () => extractDeploy("Dockerfile", `FROM python:3.12\n${"COPY src/ /app/\n".repeat(80_000)}`, "dockerfile"));
  assert.equal(copies.refs.length, 1);
});

test("an incoming walk over a file with 80,000 symbols stays linear", { timeout: 300_000 }, () => {
  const n = (id: string, kind: NodeV1["kind"], path: string): NodeV1 => ({
    id, name: id, kind, path, span: "L1-L1", signature: null, exported: true, origin: "ast", body_hash: "", summary_state: "pending", summary: null, crux: null,
  });
  const nodes = [n("big.py", "file", "big.py"), n("Dockerfile#stage:0", "resource", "Dockerfile")];
  for (let i = 0; i < 80_000; i++) nodes.push(n(`big.py#f${i}`, "function", "big.py"));
  const graph: GraphV1 = {
    meta: { version: 1, nodeCount: nodes.length, edgeCount: 1, languages: [] },
    nodes,
    edges: [{ source: "Dockerfile#stage:0", target: "big.py", relation: "references", confidence: "extracted" }],
  };
  const hits = quick("impactOfMany", () => impactOfMany(graph, [nodes[2]], 2, "in"));
  assert.deepEqual(hits.map((h) => h.id), ["Dockerfile#stage:0"]);
});
