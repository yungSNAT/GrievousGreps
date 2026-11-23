/**
 * Shared by the route tests: a graph built from fixture files, its route nodes and edges, and
 * Kubernetes fixtures with an Ingress.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";
import type { GraphV1 } from "../src/graph/types.js";
import { checkGraphInvariants } from "../src/graph/invariants.js";


export async function built(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "gg-routes-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const result = await buildGraph(root);
  return { root, result, graph: readGraph(wiringPath(contextDirFor(root)))! };
}

/** Builds `files`, runs `check` on the graph, asserts its invariants and removes the folder. */
export async function withGraph(files: Record<string, string>, check: (graph: Awaited<ReturnType<typeof built>>["graph"]) => void) {
  const { root, graph } = await built(files);
  try {
    check(graph);
    assert.deepEqual(checkGraphInvariants(graph).problems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const routeIds = (graph: GraphV1) => graph.nodes.filter((n) => n.id.includes("#route:")).map((n) => n.id).sort(byCodeUnit);

/** Edges into or out of a route node, as `source -> target`, inferred ones marked. */
export function routeEdges(graph: GraphV1): string[] {
  return graph.edges
    .filter((e) => e.relation === "references" && (e.source.includes("#route:") || e.target.includes("#route:")))
    .map((e) => `${e.source} -> ${e.target}${e.confidence === "inferred" ? " (inferred)" : ""}`)
    .sort(byCodeUnit);
}

// Fixtures are template literals: one token each, so the duplication check reads code only.
export const k8s = (paths: string[], extra = "") => `apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  template:
    metadata: { labels: { app: api } }
    spec: { containers: [ { name: api, image: acme/api:1 } ] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  template:
    metadata: { labels: { app: web } }
    spec: { containers: [ { name: web, image: acme/web:1 } ] }
---
apiVersion: v1
kind: Service
metadata: { name: api }
spec: { selector: { app: api } }
---
apiVersion: v1
kind: Service
metadata: { name: web }
spec: { selector: { app: web } }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: main }
spec:
  rules:
    - http:
        paths:
${paths.join("\n")}
${extra}`;

export const path = (p: string, type: string, svc: string) => `          - { path: ${p}, pathType: ${type}, backend: { service: { name: ${svc}, port: { number: 80 } } } }`;

export const apps = (names: string[], paths: string[]) => `${names.map((n) => `apiVersion: apps/v1
kind: Deployment
metadata: { name: ${n} }
spec:
  template:
    metadata: { labels: { app: ${n} } }
    spec: { containers: [ { name: ${n}, image: acme/${n}:1 } ] }
---
apiVersion: v1
kind: Service
metadata: { name: ${n} }
spec: { selector: { app: ${n} } }
---
`).join("")}apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: main }
spec:
  rules:
    - http:
        paths:
${paths.join("\n")}
`;
