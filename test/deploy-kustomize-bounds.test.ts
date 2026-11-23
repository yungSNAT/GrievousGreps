/** Kustomize in the deploy graph: size and step bounds on hostile inputs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deployFormatOf, extractDeploy, resolveDeploy, resource, type DeployRef, type KustomizeRef } from "../src/graph/deploy.js";
import type { NodeV1 } from "../src/graph/types.js";
import { DEPLOYMENT, OPS, deployment, resolveFiles } from "./deploy-kustomize-fixtures.js";

test("a cycle between kustomizations is reported once and a long chain stays bounded", { timeout: 120_000 }, () => {
  const nodes: NodeV1[] = [];
  const refsOut: DeployRef[] = [];
  const read = (rel: string, text: string) => {
    const x = extractDeploy(rel, text, deployFormatOf(rel)!);
    assert.equal(x.skipped, undefined, rel);
    for (const n of x.nodes) nodes.push(n);
    for (const r of x.refs) refsOut.push(r);
  };
  const N = 20_000;
  for (let i = 0; i < N; i++) {
    read(`k${i}/kustomization.yaml`, `namePrefix: p-\nresources: [ d.yaml, ../k${(i + 1) % N} ]\n`);
    read(`k${i}/d.yaml`, `apiVersion: v1\nkind: ConfigMap\nmetadata: { name: c${i} }\n`);
  }
  const start = performance.now();
  // Every file read exists, and no folder holds a second kustomization file.
  const { edges, skipped } = resolveDeploy(nodes, refsOut, (p) => p.endsWith("/kustomization.yaml") || p.endsWith("/d.yaml"));
  const ms = performance.now() - start;
  assert.ok(ms < 20_000, `took ${ms.toFixed(0)} ms`);
  assert.equal(skipped.filter((s) => s.reason.startsWith("cycle")).length, 1);
  // Whichever size bound the chain reaches first stops it.
  assert.ok(skipped.some((s) => /^name, patch and generator links omitted after (200000 built objects|20000000 characters of built names)$/.test(s.reason)));
  assert.equal(edges.filter((e) => e.source.endsWith("#kustomization")).length, 2 * N);
});

test("the match-step bound is reported past the per-file cap, with the count of the other reports", () => {
  const nodes: NodeV1[] = [];
  const refsOut: DeployRef[] = [];
  const read = (rel: string, text: string) => {
    const x = extractDeploy(rel, text, deployFormatOf(rel)!);
    for (const n of x.nodes) nodes.push(n);
    for (const r of x.refs) refsOut.push(r);
  };
  read("k/d.yaml", Array.from({ length: 2000 }, (_, i) => `apiVersion: v1\nkind: ConfigMap\nmetadata: { name: c${i} }\n`).join("---\n"));
  const missing = Array.from({ length: 25 }, (_, i) => `  - m${i}.yaml`).join("\n");
  const inline = Array.from({ length: 600 }, () => '  - "{ apiVersion: v1, kind: ConfigMap, metadata: { name: c0 } }"').join("\n");
  read("k/kustomization.yaml", `resources:\n  - d.yaml\n${missing}\npatchesStrategicMerge:\n${inline}\n`);
  const { skipped } = resolveDeploy(nodes, refsOut, (p) => p === "k/d.yaml");
  const reasons = skipped.filter((s) => s.path === "k/kustomization.yaml").map((s) => s.reason);
  assert.ok(reasons.includes("name, patch, generator and image links omitted from here on after 2000000 match steps"), reasons.join("\n"));
  assert.equal(reasons.at(-1), "and 5 more reports");
});

test("hostile inputs stay bounded: long built names, and many patches over components whose parents build nothing", { timeout: 120_000 }, () => {
  // One object under a long chain of long prefixes: few objects, very long names.
  const chain: Record<string, string> = {};
  const N = 400;
  const prefix = "p".repeat(1000);
  for (let i = 0; i < N; i++) chain[`k${i}/kustomization.yaml`] = `namePrefix: ${prefix}\nresources: [ ${i === N - 1 ? "d.yaml" : `../k${i + 1}`} ]\n`;
  chain[`k${N - 1}/d.yaml`] = "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: c }\n";
  const long = resolveFiles(chain);
  assert.ok(long.skipped.some((s) => s.reason === "name, patch and generator links omitted after 20000000 characters of built names"), JSON.stringify(long.skipped.slice(0, 3)));
  assert.ok(long.ms < 20_000, `took ${long.ms.toFixed(0)} ms`);

  const fan: Record<string, string> = {};
  const P = 2000;
  fan["comp/kustomization.yaml"] = `kind: Component\npatches:\n${Array.from({ length: P }, () => "  - path: ops.yaml\n    target: { kind: Deployment }").join("\n")}\n`;
  fan["comp/ops.yaml"] = OPS;
  for (let i = 0; i < P; i++) fan[`o${i}/kustomization.yaml`] = "components: [ ../comp ]\n";
  const empty = resolveFiles(fan);
  assert.ok(empty.skipped.some((s) => s.reason === "name, patch, generator and image links omitted from here on after 2000000 match steps"));
});

test("hostile inputs stay near linear: many generators and references, many patch objects and labels, many repeated back-edges", { timeout: 120_000 }, () => {
  // Built as the reader would give them, without parsing 60,000 YAML documents.
  const R = 20_000;
  const nodes: NodeV1[] = [];
  const refsOut: DeployRef[] = [];
  const object = (rel: string, name: string, app: string) => {
    const n = resource(rel, `Deployment/default/${name}`, name, [1, 1], `Deployment ${name}`, [name]);
    nodes.push(n);
    refsOut.push({ from: n.id, to: "api", apiVersion: "apps/v1" }, { from: n.id, to: "labels", ns: "default", labels: { app } });
    return n.id;
  };
  const kustomization = (dir: string, entries: KustomizeRef["entries"], more: Partial<KustomizeRef> = {}): KustomizeRef => {
    nodes.push(resource(`${dir}/kustomization.yaml`, "kustomization", dir, [1, 1], `Kustomization ${dir}`, [dir]));
    return { from: `${dir}/kustomization.yaml#kustomization`, to: "kustomize", dir, component: false, entries, patches: [], prefix: "", suffix: "", images: [], generators: [], unread: [], ...more };
  };
  // One workload naming R generated ConfigMaps of its kustomization.
  const api = object("k/d.yaml", "api", "api");
  for (let i = 0; i < R; i++) refsOut.push({ from: api, to: "object", kind: "ConfigMap", ns: "default", name: `g${i}` });
  const generators = Array.from({ length: R }, (_, i) => ({ kind: "ConfigMap" as const, name: `g${i}`, id: `k/kustomization.yaml#configMapGenerator:g${i}` }));
  for (const g of generators) nodes.push(resource("k/kustomization.yaml", `configMapGenerator:${g.name}`, g.name, [1, 1], `ConfigMap ${g.name} (generated)`, [g.name]));
  // R patch objects, and R other workloads with labels in the same namespace.
  for (let i = 0; i < R; i++) object("k/p.yaml", `w${i}`, "w");
  for (let i = 0; i < R; i++) object("w/d.yaml", `x${i}`, "x");
  refsOut.push(kustomization("k", [{ field: "resources", path: "d.yaml" }], { generators, patches: [{ path: "p.yaml" }] }));
  // A cycle closed R times.
  refsOut.push(kustomization("a", [{ field: "resources", path: "../b" }]));
  refsOut.push(kustomization("b", Array.from({ length: R }, () => ({ field: "resources" as const, path: "../a" }))));
  const start = performance.now();
  const { edges } = resolveDeploy(nodes, refsOut, (p) => p.endsWith(".yaml"));
  const ms = performance.now() - start;
  assert.ok(edges.some((e) => e.source === api && e.target === "k/kustomization.yaml#configMapGenerator:g0"));
  assert.ok(ms < 10_000, `resolving took ${ms.toFixed(0)} ms`);
});

test("objects after the step bound are still deployed where their kustomizations put them", () => {
  const configMaps = Array.from({ length: 2000 }, (_, i) => `apiVersion: v1\nkind: ConfigMap\nmetadata: { name: c${i} }\n`).join("---\n");
  const inline = Array.from({ length: 600 }, () => '  - "{ apiVersion: v1, kind: ConfigMap, metadata: { name: c0 } }"').join("\n");
  const { edges, skipped } = resolveFiles({
    "a/kustomization.yaml": "namespace: prod\nresources: [ deployment.yaml ]\n",
    "a/deployment.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: api }\nspec: { template: { metadata: { labels: { app: api } }, spec: { containers: [] } } }\n",
    "k/kustomization.yaml": `resources: [ d.yaml ]\npatchesStrategicMerge:\n${inline}\n`,
    "k/d.yaml": configMaps,
    "zb/kustomization.yaml": "namespace: staging\nresources: [ service.yaml ]\n",
    "zb/service.yaml": "apiVersion: v1\nkind: Service\nmetadata: { name: api, namespace: prod }\nspec: { selector: { app: api } }\n",
  });
  assert.ok(skipped.some((s) => s.reason === "name, patch, generator and image links omitted from here on after 2000000 match steps"));
  assert.deepEqual(edges.filter((e) => e.source.startsWith("zb/service.yaml")), []);
});

test("image renames charge each compose service they link to", () => {
  // 300 workloads, 100 renames of their image, each new name built by 100 compose services.
  const nodes: NodeV1[] = [];
  const refsOut: DeployRef[] = [];
  for (let j = 0; j < 100; j++) {
    for (let i = 0; i < 100; i++) {
      const n = resource("compose.yaml", `service:s${j}-${i}`, `s${j}-${i}`, [1, 1], `service s${j}-${i}`, []);
      nodes.push(n);
      refsOut.push({ from: n.id, to: "image", image: `x${j}`, built: true });
    }
  }
  for (let i = 0; i < 300; i++) {
    const n = resource("k/d.yaml", `Deployment/default/w${i}`, `w${i}`, [1, 1], `Deployment w${i}`, []);
    nodes.push(n);
    refsOut.push({ from: n.id, to: "image", image: "api", built: false });
  }
  nodes.push(resource("k/kustomization.yaml", "kustomization", "k", [1, 1], "Kustomization k", []));
  const k: KustomizeRef = {
    from: "k/kustomization.yaml#kustomization", to: "kustomize", dir: "k", component: false, entries: [{ field: "resources", path: "d.yaml" }],
    patches: [], prefix: "", suffix: "", images: Array.from({ length: 100 }, (_, j) => ({ name: "api", newName: `x${j}` })), generators: [], unread: [],
  };
  refsOut.push(k);
  const { skipped } = resolveDeploy(nodes, refsOut, (p) => p.endsWith(".yaml"));
  assert.ok(skipped.some((s) => s.reason === "name, patch, generator and image links omitted from here on after 2000000 match steps"));
});

test("an include listed many times is followed once and reported once", { timeout: 60_000 }, () => {
  const { skipped, edges } = resolveFiles({
    "base/kustomization.yaml": "resources: [ deployment.yaml, configmap.yaml ]\n",
    "base/deployment.yaml": DEPLOYMENT,
    "base/configmap.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: app-config }\n",
    "root/kustomization.yaml": `resources:\n${Array.from({ length: 50_000 }, () => "  - ../base").join("\n")}\n`,
  });
  assert.deepEqual(skipped, [{ path: "root/kustomization.yaml", reason: "resources ../base listed more than once: followed once" }]);
  assert.equal(edges.filter((e) => e.source === "base/deployment.yaml#Deployment/default/api" && e.target === "base/configmap.yaml#ConfigMap/default/app-config").length, 1);
});

test("generator links charge each generated object a workload names", { timeout: 60_000 }, () => {
  const files: Record<string, string> = {
    "root/kustomization.yaml": `resources:\n  - d.yaml\n${Array.from({ length: 1500 }, (_, i) => `  - ../b${i}`).join("\n")}\n`,
    "root/d.yaml": Array.from({ length: 1500 }, (_, i) => deployment(`w${i}`).replace("image: w", "envFrom: [ { configMapRef: { name: cfg } } ], image: w")).join("---\n"),
  };
  for (let i = 0; i < 1500; i++) files[`b${i}/kustomization.yaml`] = "configMapGenerator: [ { name: cfg, literals: [ a=b ] } ]\n";
  const { skipped } = resolveFiles(files);
  assert.ok(skipped.some((s) => s.reason === "name, patch, generator and image links omitted from here on after 2000000 match steps"));
});

test("a diamond whose branches rename one base stays near linear and links once", { timeout: 120_000 }, () => {
  const files: Record<string, string> = {
    "base/kustomization.yaml": "resources: [ deployment.yaml, configmap.yaml ]\n",
    "base/deployment.yaml": DEPLOYMENT,
    "base/configmap.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: app-config }\n",
    "root/kustomization.yaml": `resources:\n${Array.from({ length: 10_000 }, (_, i) => `  - ../m${i}`).join("\n")}\n`,
  };
  for (let i = 0; i < 10_000; i++) files[`m${i}/kustomization.yaml`] = `namePrefix: m${i}-\nresources: [ ../base ]\n`;
  const { edges, skipped, ms } = resolveFiles(files);
  assert.deepEqual(skipped, []);
  assert.equal(edges.filter((e) => e.source === "base/deployment.yaml#Deployment/default/api" && e.target === "base/configmap.yaml#ConfigMap/default/app-config").length, 1);
  assert.ok(ms < 10_000, `${ms} ms`);
});
