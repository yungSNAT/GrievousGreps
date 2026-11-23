/** Shared fixtures for the Kustomize tests: build a repository from files, list its deploy edges. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";
import { deployFormatOf, extractDeploy, resolveDeploy, type DeployRef } from "../src/graph/deploy.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

export const LITERAL = "LITERAL-VALUE-NEVER-STORED";

async function built(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "gg-kustomize-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const result = await buildGraph(root);
  return { root, result, graph: readGraph(wiringPath(contextDirFor(root)))! };
}

export async function withBuild(files: Record<string, string>, check: (b: Awaited<ReturnType<typeof built>>) => void) {
  const b = await built(files);
  try {
    check(b);
  } finally {
    rmSync(b.root, { recursive: true, force: true });
  }
}

export function refs(graph: GraphV1): string[] {
  const deployIds = new Set(graph.nodes.filter((n) => n.kind === "resource").map((n) => n.id));
  return graph.edges
    .filter((e) => e.relation === "references" && deployIds.has(e.source))
    .map((e) => `${e.source} -> ${e.target}${e.confidence === "inferred" ? " (inferred)" : ""}`)
    .sort((a, b) => a.localeCompare(b));
}

export const DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  template:
    metadata: { labels: { app: api } }
    spec:
      containers:
        - name: api
          image: api
          envFrom: [ { configMapRef: { name: app-config } } ]
`;
export const SERVICE = "apiVersion: v1\nkind: Service\nmetadata: { name: api }\nspec: { selector: { app: api } }\n";

export function everyFile(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? everyFile(join(dir, f)) : [join(dir, f)]));
}

export const deployment = (name: string) =>
  `apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: ${name} }\nspec: { template: { metadata: { labels: { app: ${name} } }, spec: { containers: [ { name: c, image: ${name} } ] } } }\n`;

/** Read files straight into the resolver, as `trail build` would, without writing them. */
export function resolveFiles(files: Record<string, string>) {
  const nodes: NodeV1[] = [];
  const refsOut: DeployRef[] = [];
  for (const [rel, text] of Object.entries(files)) {
    const x = extractDeploy(rel, text, deployFormatOf(rel)!);
    assert.equal(x.skipped, undefined, rel);
    for (const n of x.nodes) nodes.push(n);
    for (const r of x.refs) refsOut.push(r);
  }
  const start = performance.now();
  const out = resolveDeploy(nodes, refsOut, (p) => p in files);
  return { ...out, ms: performance.now() - start };
}
