/** Kustomize in the deploy graph: bounds on hostile inputs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deployFormatOf, extractDeploy, resolveDeploy, type DeployRef } from "../src/graph/deploy.js";
import type { NodeV1 } from "../src/graph/types.js";
import { DEPLOYMENT, resolveFiles } from "./deploy-kustomize-fixtures.js";

function reader() {
  const nodes: NodeV1[] = [];
  const refsOut: DeployRef[] = [];
  const read = (rel: string, text: string) => {
    const x = extractDeploy(rel, text, deployFormatOf(rel)!);
    assert.equal(x.skipped, undefined, rel);
    for (const n of x.nodes) nodes.push(n);
    for (const r of x.refs) refsOut.push(r);
  };
  return { nodes, refsOut, read };
}

test("a cycle between kustomizations is reported once and a long chain stays linear", { timeout: 120_000 }, () => {
  const { nodes, refsOut, read } = reader();
  const N = 20_000;
  for (let i = 0; i < N; i++) {
    read(`k${i}/kustomization.yaml`, `namePrefix: p-\nresources: [ d.yaml, ../k${(i + 1) % N} ]\n`);
    read(`k${i}/d.yaml`, `apiVersion: v1\nkind: ConfigMap\nmetadata: { name: c${i} }\n`);
  }
  const start = performance.now();
  const { edges, skipped } = resolveDeploy(nodes, refsOut, (p) => p.endsWith("/kustomization.yaml") || p.endsWith("/d.yaml"));
  const ms = performance.now() - start;
  assert.ok(ms < 10_000, `took ${ms.toFixed(0)} ms`);
  assert.equal(skipped.filter((s) => s.reason.startsWith("cycle")).length, 1);
  assert.equal(edges.filter((e) => e.source.endsWith("#kustomization")).length, 2 * N);
});

test("an include listed many times is followed once and reported once", { timeout: 60_000 }, () => {
  const { skipped, edges } = resolveFiles({
    "base/kustomization.yaml": "resources: [ deployment.yaml ]\n",
    "base/deployment.yaml": DEPLOYMENT,
    "root/kustomization.yaml": `resources:\n${Array.from({ length: 50_000 }, () => "  - ../base").join("\n")}\n`,
  });
  assert.deepEqual(skipped, [{ path: "root/kustomization.yaml", reason: "resources ../base listed more than once: followed once" }]);
  assert.deepEqual(edges.filter((e) => e.source === "root/kustomization.yaml#kustomization").map((e) => e.target), ["base/kustomization.yaml#kustomization"]);
});

test("links from kustomizations stop at a bound, which is reported", { timeout: 120_000 }, () => {
  const { nodes, refsOut, read } = reader();
  read("big/d.yaml", Array.from({ length: 2000 }, (_, i) => `apiVersion: v1\nkind: ConfigMap\nmetadata: { name: c${i} }\n`).join("---\n"));
  for (let i = 0; i < 1001; i++) read(`k${i}/kustomization.yaml`, "resources: [ ../big/d.yaml ]\n");
  const { edges, skipped } = resolveDeploy(nodes, refsOut, (p) => p.endsWith(".yaml"));
  assert.ok(skipped.some((s) => s.reason === "Kustomize links omitted from here on after 2000000"));
  assert.ok(edges.filter((e) => e.source.endsWith("#kustomization")).length <= 2_000_000);
});

test("a patch file listed many times is followed once, so it cannot use up the link bound", { timeout: 120_000 }, () => {
  const { nodes, refsOut, read } = reader();
  read("big/d.yaml", Array.from({ length: 2000 }, (_, i) => `apiVersion: v1\nkind: ConfigMap\nmetadata: { name: c${i} }\n`).join("---\n"));
  read("a/kustomization.yaml", `patches:\n${Array.from({ length: 1001 }, () => "  - path: ../big/d.yaml").join("\n")}\n`);
  read("z/kustomization.yaml", "resources: [ d.yaml ]\n");
  read("z/d.yaml", DEPLOYMENT);
  const { edges, skipped } = resolveDeploy(nodes, refsOut, (p) => p.endsWith(".yaml"));
  assert.ok(skipped.some((s) => s.path === "a/kustomization.yaml" && s.reason === "patch ../big/d.yaml listed more than once: followed once"));
  assert.ok(!skipped.some((s) => s.reason.startsWith("Kustomize links omitted")));
  assert.ok(edges.some((e) => e.source === "z/kustomization.yaml#kustomization" && e.target === "z/d.yaml#Deployment/default/api"));
});
