/**
 * Dockerfiles, compose files and Kubernetes manifests in the graph (`src/graph/deploy.ts`):
 * the chain from a function to the Ingress in front of it, what a walk at depth 1 and
 * deeper sees, that no Secret or ConfigMap value reaches anything the build writes, and
 * that a malformed file is reported as skipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";
import { callersOf, impactOfMany } from "../src/graph/traverse.js";
import { ask } from "../src/ask/ask.js";
import { deployFormatOf, extractDeploy } from "../src/graph/deploy.js";
import { checkGraphInvariants } from "../src/graph/invariants.js";
import type { GraphV1 } from "../src/graph/types.js";

const SECRET = "hunter2-SECRET-VALUE";
const CONFIG = "PLAIN-CONFIG-VALUE";
const ENV = "ENV-VALUE-IN-COMPOSE";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "gg-deploy-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const SERVICE = {
  "src/app.py": "def handle(request):\n    return request\n",
  "tools/other.py": "def unused():\n    pass\n",
  Dockerfile: [
    "# syntax=docker/dockerfile:1",
    "FROM python:3.12 AS base",
    "WORKDIR /app",
    "COPY src/ \\",
    "     /app/src/",
    "RUN <<EOF",
    "COPY tools/ /never",
    "EOF",
    "FROM base AS final",
    "COPY --from=base /app /app",
    'CMD ["python", "-m", "src.app"]',
  ].join("\n"),
  "compose.yaml": [
    "services:",
    "  api:",
    "    build: .",
    "    image: acme/api:1.0",
    "    depends_on: [db]",
    "    environment:",
    `      TOKEN: ${ENV}`,
    "    volumes:",
    "      - ./src:/srv/src",
    "      - data:/var/data",
    "    networks: [back]",
    "  db:",
    "    image: postgres:17",
    "volumes:",
    "  data: {}",
    "networks:",
    "  back: {}",
  ].join("\n"),
  "k8s/app.yaml": [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata: { name: api, namespace: shop }",
    "spec:",
    "  template:",
    "    metadata: { labels: { app: api, tier: web } }",
    "    spec:",
    "      containers:",
    "        - name: api",
    "          image: docker.io/acme/api:2.0",
    "          envFrom:",
    "            - configMapRef: { name: app-config }",
    "            - secretRef: { name: app-secret }",
    "---",
    "apiVersion: v1",
    "kind: Service",
    "metadata: { name: api, namespace: shop }",
    "spec: { selector: { app: api } }",
    "---",
    "apiVersion: networking.k8s.io/v1",
    "kind: Ingress",
    "metadata: { name: web, namespace: shop }",
    "spec:",
    "  rules:",
    "    - host: shop.example",
    "      http:",
    "        paths:",
    "          - path: /api",
    "            backend: { service: { name: api } }",
    "---",
    "apiVersion: v1",
    "kind: ConfigMap",
    "metadata: { name: app-config, namespace: shop }",
    `data: { MODE: ${CONFIG} }`,
    "---",
    "apiVersion: v1",
    "kind: Secret",
    "metadata: { name: app-secret, namespace: shop }",
    `stringData: { password: ${SECRET} }`,
  ].join("\n"),
};

async function built(files: Record<string, string>) {
  const root = repo(files);
  const result = await buildGraph(root);
  const graph = readGraph(wiringPath(contextDirFor(root)))!;
  return { root, result, graph };
}

function refs(graph: GraphV1): string[] {
  const deployIds = new Set(graph.nodes.filter((n) => n.kind === "resource").map((n) => n.id));
  return graph.edges
    .filter((e) => e.relation === "references" && deployIds.has(e.source))
    .map((e) => `${e.source} -> ${e.target}${e.confidence === "inferred" ? " (inferred)" : ""}`)
    .sort();
}

test("deployment files are named by their file names", () => {
  assert.deepEqual(
    ["Dockerfile", "api/Dockerfile.prod", "web.dockerfile", "Containerfile", "compose.yaml", "docker-compose.override.yml", "k8s/app.yml", "src/app.py"].map(deployFormatOf),
    ["dockerfile", "dockerfile", "dockerfile", "dockerfile", "compose", "compose", "kubernetes", null],
  );
});

test("a function reaches the Ingress in front of it, through the image, compose and the Deployment", async () => {
  const { root, result, graph } = await built(SERVICE);
  try {
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(refs(graph), [
      "Dockerfile#stage:final -> Dockerfile#stage:base",
      "Dockerfile#stage:base -> src/app.py",
      "compose.yaml#service:api -> Dockerfile#stage:final",
      "compose.yaml#service:api -> compose.yaml#network:back",
      "compose.yaml#service:api -> compose.yaml#service:db",
      "compose.yaml#service:api -> compose.yaml#volume:data",
      "compose.yaml#service:api -> src/app.py",
      "k8s/app.yaml#Deployment/shop/api -> compose.yaml#service:api (inferred)",
      "k8s/app.yaml#Deployment/shop/api -> k8s/app.yaml#ConfigMap/shop/app-config",
      "k8s/app.yaml#Deployment/shop/api -> k8s/app.yaml#Secret/shop/app-secret",
      "k8s/app.yaml#Ingress/shop/web -> k8s/app.yaml#Service/shop/api",
      "k8s/app.yaml#Service/shop/api -> k8s/app.yaml#Deployment/shop/api",
    ].sort());
    assert.deepEqual(checkGraphInvariants(graph).problems, []);
    const handle = graph.nodes.find((n) => n.name === "handle")!;
    assert.deepEqual(callersOf(graph, handle), [], "depth 1 is exact edges only");
    const reached = impactOfMany(graph, [handle], 6, "in");
    const at = (id: string) => reached.find((h) => h.id === id);
    assert.equal(at("Dockerfile#stage:base")?.depth, 1);
    assert.equal(at("compose.yaml#service:api")?.depth, 1, "the bind mount reaches it directly");
    assert.equal(at("k8s/app.yaml#Deployment/shop/api")?.depth, 2);
    assert.equal(at("k8s/app.yaml#Deployment/shop/api")?.inferred, true, "through the image name match");
    assert.equal(at("k8s/app.yaml#Ingress/shop/web")?.depth, 4);
    assert.equal(at("tools/other.py#unused"), undefined);
    const stage = graph.nodes.find((n) => n.id === "Dockerfile#stage:base")!;
    assert.equal(stage.kind, "resource");
    assert.equal(stage.signature, "FROM python:3.12 AS base");
    assert.equal(stage.span, "L2-L8");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function everyFile(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? everyFile(join(dir, f)) : [join(dir, f)]));
}

test("no Secret, ConfigMap or environment value reaches the graph, its caches or ask", async () => {
  const { root } = await built(SERVICE);
  try {
    for (const file of everyFile(contextDirFor(root))) {
      const text = readFileSync(file).toString("latin1");
      for (const value of [SECRET, CONFIG, ENV]) assert.ok(!text.includes(value), `${value} in ${file}`);
    }
    const r = ask(root, "app-secret password", { source: true });
    assert.ok(r.hits.some((h) => h.pointer.startsWith("k8s/app.yaml")), "the Secret is found by name");
    assert.ok(r.hits.every((h) => !h.code?.includes(SECRET)), "and its file's text is never inlined");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed and template files are skipped with a reason; other YAML is ignored", async () => {
  const { root, result, graph } = await built({
    "src/app.py": "def handle():\n    pass\n",
    "Dockerfile.bad": "RUN echo no base\n",
    "k8s/broken.yaml": "apiVersion: v1\nkind: Service\nmetadata: { name: x\n",
    "chart/templates/dep.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Values.name }}\n",
    "k8s/wrong.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: bad }\nspec:\n  template:\n    spec: { containers: x }\n",
    "workflows/ci.yml": "on: push\njobs:\n  test:\n    steps:\n      - run: echo ${{ secrets.TOKEN }}\n",
  });
  try {
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.path, s.reason]));
    assert.deepEqual(Object.keys(reasons).sort(), ["Dockerfile.bad", "chart/templates/dep.yaml", "k8s/broken.yaml", "k8s/wrong.yaml"]);
    assert.equal(reasons["Dockerfile.bad"], "no FROM instruction");
    assert.equal(reasons["chart/templates/dep.yaml"], "a template, not rendered");
    assert.match(reasons["k8s/broken.yaml"], /^not valid YAML: /);
    assert.equal(reasons["k8s/wrong.yaml"], "Deployment bad: containers is not a list");
    assert.equal(result.structuralErrors, 0, "a skip is not a build error");
    assert.deepEqual(graph.nodes.filter((n) => n.kind === "resource"), []);
    assert.ok(!graph.nodes.some((n) => n.path === "workflows/ci.yml"), "a YAML file with no manifest makes no node");
    const again = await buildGraph(root);
    assert.equal(again.reused, again.files, "replayed from the cache");
    assert.deepEqual(again.skipped, result.skipped, "and still reported");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rebuild from the cache gives the same edges, and check sees no drift", async () => {
  const { root, graph } = await built(SERVICE);
  try {
    await buildGraph(root);
    assert.deepEqual(refs(readGraph(wiringPath(contextDirFor(root)))!), refs(graph));
    const check = await checkGraph(root);
    assert.deepEqual([check.added, check.removed, check.changed], [[], [], []]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a compose build context and target pick the Dockerfile's folder and stage", () => {
  const c = extractDeploy("deploy/compose.yml", "services:\n  web:\n    build: { context: .., dockerfile: docker/web.Dockerfile, target: dev }\n", "compose");
  assert.deepEqual(c.refs, [{ from: "deploy/compose.yml#service:web", to: "build", context: ".", dockerfile: "docker/web.Dockerfile", target: "dev" }]);
  const outside = extractDeploy("compose.yml", "services:\n  web:\n    build: ../elsewhere\n    volumes: ['/etc/hosts:/etc/hosts', '../up:/x']\n", "compose");
  assert.deepEqual(outside.refs, [], "a context or mount outside the repository names nothing");
});
