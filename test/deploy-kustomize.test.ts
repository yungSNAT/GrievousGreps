/**
 * Kustomize in the deploy graph (`src/graph/kustomize.ts`): a kustomization links to what it
 * lists and patches, an `images` rename joins a workload to the compose service that builds
 * the new name, a generator gives a name-only node, deployed names and namespaces resolve,
 * and every include not followed is reported. No generator value is read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";
import { impactOfMany } from "../src/graph/traverse.js";
import { checkGraphInvariants } from "../src/graph/invariants.js";
import { deployFormatOf, extractDeploy, resolveDeploy, resource, type DeployRef, type KustomizeRef } from "../src/graph/deploy.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const LITERAL = "LITERAL-VALUE-NEVER-STORED";

async function built(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "gg-kustomize-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const result = await buildGraph(root);
  return { root, result, graph: readGraph(wiringPath(contextDirFor(root)))! };
}

async function withBuild(files: Record<string, string>, check: (b: Awaited<ReturnType<typeof built>>) => void) {
  const b = await built(files);
  try {
    check(b);
  } finally {
    rmSync(b.root, { recursive: true, force: true });
  }
}

function refs(graph: GraphV1): string[] {
  const deployIds = new Set(graph.nodes.filter((n) => n.kind === "resource").map((n) => n.id));
  return graph.edges
    .filter((e) => e.relation === "references" && deployIds.has(e.source))
    .map((e) => `${e.source} -> ${e.target}${e.confidence === "inferred" ? " (inferred)" : ""}`)
    .sort((a, b) => a.localeCompare(b));
}

const DEPLOYMENT = `apiVersion: apps/v1
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
const SERVICE = "apiVersion: v1\nkind: Service\nmetadata: { name: api }\nspec: { selector: { app: api } }\n";

const REPO: Record<string, string> = {
  "src/app.py": "def handle():\n    return 1\n",
  Dockerfile: "FROM python:3.12\nCOPY src/ /app/src/\n",
  "compose.yaml": "services:\n  api: { build: ., image: ghcr.io/acme/api }\n",
  "base/kustomization.yaml": `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
configMapGenerator:
  - name: app-config
    literals: [ "MODE=${LITERAL}" ]
`,
  "base/deployment.yaml": DEPLOYMENT,
  "base/service.yaml": SERVICE,
  "overlays/prod/kustomization.yaml": `resources:
  - ../../base
  - https://github.com/acme/shared//deploy?ref=v1
patches:
  - path: replicas.yaml
images:
  - name: api
    newName: ghcr.io/acme/api
    newTag: "2.0"
secretGenerator:
  - name: app-secret
    literals: [ "password=${LITERAL}" ]
`,
  "overlays/prod/replicas.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: api }\nspec: { replicas: 3 }\n",
  "overlays/dev/kustomization.yaml": "resources: [ ../../base ]\n",
};

test("kustomization files are named by their file names", () => {
  assert.equal(deployFormatOf("overlays/prod/kustomization.yaml"), "kustomize");
  assert.equal(deployFormatOf("base/Kustomization"), "kustomize");
  assert.equal(deployFormatOf("base/kustomization.yml"), "kustomize");
  assert.equal(deployFormatOf("base/deployment.yaml"), "kubernetes");
});

test("an overlay reaches its base and what it patches, an image rename joins the compose build, and generators link by name", async () => {
  await withBuild(REPO, ({ result, graph }) => {
    assert.deepEqual(result.skipped, [
      { path: "overlays/prod/kustomization.yaml", reason: "resources https://github.com/acme/shared//deploy?ref=v1 not followed: remote" },
    ]);
    assert.deepEqual(refs(graph).filter((e) => /ustomization|Generator|replicas|inferred/.test(e)), [
      "base/deployment.yaml#Deployment/default/api -> base/kustomization.yaml#configMapGenerator:app-config",
      "base/deployment.yaml#Deployment/default/api -> compose.yaml#service:api (inferred)",
      "base/kustomization.yaml#kustomization -> base/deployment.yaml#Deployment/default/api",
      "base/kustomization.yaml#kustomization -> base/kustomization.yaml#configMapGenerator:app-config",
      "base/kustomization.yaml#kustomization -> base/service.yaml#Service/default/api",
      "overlays/dev/kustomization.yaml#kustomization -> base/kustomization.yaml#kustomization",
      "overlays/prod/kustomization.yaml#kustomization -> base/deployment.yaml#Deployment/default/api",
      "overlays/prod/kustomization.yaml#kustomization -> base/kustomization.yaml#kustomization",
      "overlays/prod/kustomization.yaml#kustomization -> overlays/prod/kustomization.yaml#secretGenerator:app-secret",
      "overlays/prod/kustomization.yaml#kustomization -> overlays/prod/replicas.yaml#Deployment/default/api",
      "overlays/prod/replicas.yaml#Deployment/default/api -> base/deployment.yaml#Deployment/default/api",
    ]);
    assert.deepEqual(checkGraphInvariants(graph).problems, []);
    const node = graph.nodes.find((n) => n.id === "overlays/prod/kustomization.yaml#kustomization")!;
    assert.equal(node.name, "overlays/prod");
    assert.equal(node.signature, "Kustomization overlays/prod");
    const handle = graph.nodes.find((n) => n.name === "handle")!;
    const reached = impactOfMany(graph, [handle], 8, "in");
    assert.ok(reached.some((h) => h.id === "overlays/prod/kustomization.yaml#kustomization"), "blast reaches the overlay");
    assert.ok(reached.some((h) => h.id === "base/service.yaml#Service/default/api"), "and the Service through the renamed image");
  });
});

function everyFile(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? everyFile(join(dir, f)) : [join(dir, f)]));
}

test("no generator literal reaches the graph or its caches", async () => {
  await withBuild(REPO, ({ root }) => {
    for (const f of everyFile(contextDirFor(root))) assert.ok(!readFileSync(f, "utf8").includes(LITERAL), f);
  });
});

test("a malformed kustomization is skipped with a reason; an image rename without a compose build links nothing", async () => {
  await withBuild({
    "a/kustomization.yaml": "resources: not-a-list\n",
    "b/kustomization.yaml": "resources: [ d.yaml ]\nimages: [ { name: api, newName: elsewhere/api } ]\n",
    "b/d.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: api }\nspec: { template: { metadata: { labels: { app: api } }, spec: { containers: [ { name: api, image: api } ] } } }\n",
    "c/kustomization.yaml": "? [ x, y ]\n: z\nresources: [ 1 ]\n",
    "e/kustomization.yaml": "apiVersion: v1\nkind: ConfigMap\n",
    "f/kustomization.yaml": "a: &a [1,1,1,1,1,1,1,1,1,1]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]\nresources: *d\n",
  }, ({ result, graph }) => {
    const skipped = result.skipped.filter((s) => s.path !== "f/kustomization.yaml");
    assert.deepEqual(skipped, [
      { path: "a/kustomization.yaml", reason: "resources is not a list" },
      { path: "c/kustomization.yaml", reason: "resources entry is not a string" },
      { path: "e/kustomization.yaml", reason: "kind ConfigMap is not Kustomization or Component" },
    ]);
    assert.match(result.skipped.find((s) => s.path === "f/kustomization.yaml")!.reason, /^not valid YAML/);
    assert.deepEqual(refs(graph), ["b/kustomization.yaml#kustomization -> b/d.yaml#Deployment/default/api"]);
  });
});

test("every include or patch not followed is reported, and a URL's credentials are not", async () => {
  await withBuild({
    "app/kustomization.yaml": `resources:
  - deploy.yaml
  - missing.yaml
  - ../nowhere
  - /etc/k8s
  - ../../outside
  - github.com/acme/base?ref=v1
  - git@github.com:acme/x.git
  - https://user:tok3n@example.com/x.yaml
  - empty.yaml
components: [ ../comp-missing ]
patches:
  - path: gone.yaml
  - path: ops.yaml
    target: { kind: Deployment, name: web }
  - path: ops.yaml
    target: { labelSelector: "a=b" }
  - patch: |
      - op: replace
        path: /x
        value: 1
`,
    "app/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: web }\nspec: { template: { spec: { containers: [] } } }\n",
    "app/ops.yaml": "- op: replace\n  path: /spec/replicas\n  value: 2\n",
    "app/empty.yaml": "# nothing yet\n",
  }, ({ result, graph }) => {
    const path = "app/kustomization.yaml";
    assert.deepEqual(result.skipped, [
      "resources missing.yaml not found",
      "resources ../nowhere not found",
      "resources /etc/k8s not followed: outside the repository",
      "resources ../../outside not followed: outside the repository",
      "resources github.com/acme/base?ref=v1 not followed: remote",
      "resources github.com:acme/x.git not followed: remote",
      "resources https://example.com/x.yaml not followed: remote",
      "resources empty.yaml gave no Kubernetes objects",
      "components ../comp-missing not found",
      "patch gone.yaml not found",
      "patch ops.yaml target selects by label or annotation: not followed",
      "patch inline names no object and has no target",
    ].map((reason) => ({ path, reason })));
    assert.ok(!JSON.stringify(result.skipped).includes("tok3n"));
    assert.deepEqual(refs(graph), ["app/kustomization.yaml#kustomization -> app/deploy.yaml#Deployment/default/web"]);
  });
});

test("namespace, namePrefix and nameSuffix give the deployed names that other objects use", async () => {
  await withBuild({
    "base/kustomization.yaml": "resources: [ deployment.yaml, service.yaml ]\n",
    "base/deployment.yaml": DEPLOYMENT,
    "base/service.yaml": SERVICE,
    "prod/kustomization.yaml": "namespace: prod\nnamePrefix: prod-\nnameSuffix: -v2\nresources: [ ../base ]\n",
    "edge/ingress.yaml": `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: edge, namespace: prod }
spec: { defaultBackend: { service: { name: prod-api-v2 } } }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: edge, namespace: staging }
spec: { defaultBackend: { service: { name: prod-api-v2 } } }
---
apiVersion: v1
kind: Service
metadata: { name: metrics, namespace: prod }
spec: { selector: { app: api } }
`,
  }, ({ graph }) => {
    assert.deepEqual(refs(graph).filter((e) => e.startsWith("edge/")), [
      "edge/ingress.yaml#Ingress/prod/edge -> base/service.yaml#Service/default/api (inferred)",
      "edge/ingress.yaml#Service/prod/metrics -> base/deployment.yaml#Deployment/default/api (inferred)",
    ]);
  });
});

test("bases, components, inline and targeted patches link to the objects they change", async () => {
  await withBuild({
    "base/kustomization.yaml": "resources: [ deployment.yaml, service.yaml ]\n",
    "base/deployment.yaml": DEPLOYMENT,
    "base/service.yaml": SERVICE,
    "comp/kustomization.yaml": "apiVersion: kustomize.config.k8s.io/v1alpha1\nkind: Component\nresources: [ extra.yaml ]\npatches:\n  - path: probe.yaml\n",
    "comp/extra.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: extra }\n",
    "comp/probe.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: api }\nspec: { minReadySeconds: 5 }\n",
    "over/kustomization.yaml": `bases: [ ../base ]
components: [ ../comp ]
namePrefix: x-
patchesStrategicMerge:
  - |
    apiVersion: apps/v1
    kind: Deployment
    metadata: { name: api }
    spec: { replicas: 2 }
patches:
  - path: ops.yaml
    target: { kind: Service, name: "a.*" }
  - path: ops.yaml
    target: { kind: Service, name: "(api|web)" }
`,
    "over/ops.yaml": "- op: add\n  path: /metadata/labels/x\n  value: y\n",
  }, ({ result, graph }) => {
    assert.deepEqual(result.skipped, [{ path: "over/kustomization.yaml", reason: "patch ops.yaml target uses a regular expression: not followed" }]);
    assert.deepEqual(refs(graph).filter((e) => /ustomization|probe/.test(e)), [
      "base/kustomization.yaml#kustomization -> base/deployment.yaml#Deployment/default/api",
      "base/kustomization.yaml#kustomization -> base/service.yaml#Service/default/api",
      "comp/kustomization.yaml#kustomization -> base/deployment.yaml#Deployment/default/api",
      "comp/kustomization.yaml#kustomization -> comp/extra.yaml#ConfigMap/default/extra",
      "comp/kustomization.yaml#kustomization -> comp/probe.yaml#Deployment/default/api",
      "comp/probe.yaml#Deployment/default/api -> base/deployment.yaml#Deployment/default/api",
      "over/kustomization.yaml#kustomization -> base/deployment.yaml#Deployment/default/api",
      "over/kustomization.yaml#kustomization -> base/kustomization.yaml#kustomization",
      "over/kustomization.yaml#kustomization -> base/service.yaml#Service/default/api",
      "over/kustomization.yaml#kustomization -> comp/kustomization.yaml#kustomization",
    ]);
  });
});

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

test("review cases: patch documents, namespaces, local dotted folders, unread fields, credentials, report counts", async () => {
  const many = Array.from({ length: 25 }, (_, i) => `  - m${i}.yaml`).join("\n");
  await withBuild({
    "base/kustomization.yml": "resources: [ deployment.yaml, service.yaml ]\n",
    "base/deployment.yaml": DEPLOYMENT,
    "base/service.yaml": SERVICE,
    "ns/kustomization.yaml": "resources: [ a.yaml ]\npatches:\n  - path: p.yaml\n",
    "ns/a.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: api, namespace: a }\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata: { name: api, namespace: b }\n",
    "ns/p.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: api, namespace: a }\nspec: { replicas: 2 }\n",
    "multi/kustomization.yaml": `resources: [ ../base ]
patchesStrategicMerge: [ two.yaml ]
patches:
  - path: frag.yaml
    target: { kind: Service, name: api }
patchesJson6902:
  - path: ops.yaml
    target: { kind: "Deploy.*", name: api }
`,
    "multi/frag.yaml": "apiVersion: v1\nkind: Service\nmetadata: { name: frag }\nspec: { type: NodePort }\n",
    "multi/two.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: api }\nspec: { replicas: 2, template: { metadata: { labels: { app: api } } } }\n---\napiVersion: v1\nkind: Service\nmetadata: { name: api }\nspec: { type: NodePort }\n",
    "multi/ops.yaml": "- op: replace\n  path: /spec/replicas\n  value: 3\n",
    "config.d/kustomization.yaml": "resources: [ ../base ]\npatches:\n  - path: patches.d/ops.yaml\n    target: { kind: Service, name: api }\n",
    "config.d/patches.d/ops.yaml": "- op: add\n  path: /metadata/labels/x\n  value: y\n",
    "edge2/ingress.yaml": "apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata: { name: edge2 }\nspec: { defaultBackend: { service: { name: frag } } }\n---\napiVersion: v1\nkind: Service\nmetadata: { name: sel }\nspec: { selector: { app: api } }\n",
    "top/kustomization.yaml": "resources: [ ../config.d ]\n",
    "dup/kustomization.yaml": "resources: [ x.yaml ]\n",
    "dup/Kustomization": "resources: [ x.yaml ]\n",
    "dup/x.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: x }\n",
    "helm/kustomization.yaml": "helmCharts: [ { name: x } ]\ncommonLabels: { a: b }\nresources: []\n",
    "comp/kustomization.yaml": "kind: Component\npatches: [ { path: c.yaml } ]\n",
    "comp/c.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: api }\nspec: { paused: true }\n",
    "o1/kustomization.yaml": "resources: [ ../base ]\ncomponents: [ ../comp ]\n",
    "o2/kustomization.yaml": "resources: [ ../base ]\ncomponents: [ ../comp ]\n",
    "creds/kustomization.yaml": "resources:\n  - oauth2:SEKRET1@gitlab.com/org/repo\n  - github.com/o/r?ref=v1&token=SEKRET2\n",
    "many/kustomization.yaml": `resources:\n${many}\n`,
  }, ({ result, graph }) => {
    const reasons = (path: string) => result.skipped.filter((s) => s.path === path).map((s) => s.reason);
    assert.deepEqual(result.skipped.map((s) => s.path).filter((p) => !/^(dup|helm|creds|many)\//.test(p)), []);
    assert.deepEqual(reasons("dup/kustomization.yaml"), ["not read: Kustomize refuses a folder with more than one kustomization file"]);
    assert.deepEqual(reasons("dup/Kustomization"), ["not read: Kustomize refuses a folder with more than one kustomization file"]);
    assert.deepEqual(reasons("helm/kustomization.yaml"), ["fields not read: helmCharts, commonLabels"]);
    assert.deepEqual(reasons("creds/kustomization.yaml"), [
      "resources gitlab.com/org/repo not followed: remote",
      "resources github.com/o/r?ref=v1 not followed: remote",
    ]);
    assert.ok(!JSON.stringify(result.skipped).includes("SEKRET"));
    const m = reasons("many/kustomization.yaml");
    assert.equal(m.length, 21);
    assert.equal(m.at(-1), "and 5 more reports");
    const all = refs(graph);
    assert.deepEqual(all.filter((e) => e.startsWith("ns/")), [
      "ns/kustomization.yaml#kustomization -> ns/a.yaml#Deployment/a/api",
      "ns/kustomization.yaml#kustomization -> ns/a.yaml#Deployment/b/api",
      "ns/kustomization.yaml#kustomization -> ns/p.yaml#Deployment/a/api",
      "ns/p.yaml#Deployment/a/api -> ns/a.yaml#Deployment/a/api",
    ]);
    assert.deepEqual(all.filter((e) => e.startsWith("multi/")), [
      "multi/frag.yaml#Service/default/frag -> base/service.yaml#Service/default/api",
      "multi/kustomization.yaml#kustomization -> base/deployment.yaml#Deployment/default/api",
      "multi/kustomization.yaml#kustomization -> base/kustomization.yml#kustomization",
      "multi/kustomization.yaml#kustomization -> base/service.yaml#Service/default/api",
      "multi/kustomization.yaml#kustomization -> multi/frag.yaml#Service/default/frag",
      "multi/kustomization.yaml#kustomization -> multi/two.yaml#Deployment/default/api",
      "multi/kustomization.yaml#kustomization -> multi/two.yaml#Service/default/api",
      "multi/two.yaml#Deployment/default/api -> base/deployment.yaml#Deployment/default/api",
      "multi/two.yaml#Service/default/api -> base/service.yaml#Service/default/api",
    ]);
    assert.ok(all.includes("top/kustomization.yaml#kustomization -> config.d/kustomization.yaml#kustomization"));
    assert.ok(all.includes("config.d/kustomization.yaml#kustomization -> base/service.yaml#Service/default/api"));
    // Files used only as patches are no target of selectors or references.
    assert.ok(!all.some((e) => / -> multi\//.test(e) && !e.startsWith("multi/")), all.join("\n"));
    assert.deepEqual(all.filter((e) => e.startsWith("edge2/")), ["edge2/ingress.yaml#Service/default/sel -> base/deployment.yaml#Deployment/default/api (inferred)"]);
    assert.deepEqual(all.filter((e) => e.startsWith("comp/")), [
      "comp/c.yaml#Deployment/default/api -> base/deployment.yaml#Deployment/default/api",
      "comp/kustomization.yaml#kustomization -> base/deployment.yaml#Deployment/default/api",
      "comp/kustomization.yaml#kustomization -> comp/c.yaml#Deployment/default/api",
    ]);
    assert.deepEqual(all.filter((e) => e.startsWith("dup/")), []);
    assert.ok(!all.some((e) => e.startsWith("base/service.yaml#Service/default/api -> multi/")));
  });
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

const deployment = (name: string, more = "") =>
  `apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: ${name}${more} }\nspec: { template: { metadata: { labels: { app: ${name} } }, spec: { containers: [ { name: c, image: ${name} } ] } } }\n`;
const OPS = "- op: add\n  path: /metadata/labels/x\n  value: y\n";

test("two objects meet only where both are deployed: a moved Service or Ingress keeps no link from where it was written", async () => {
  await withBuild({
    "a/kustomization.yaml": "namespace: prod\nresources: [ deployment.yaml, web.yaml ]\n",
    "a/deployment.yaml": DEPLOYMENT,
    "a/web.yaml": "apiVersion: v1\nkind: Service\nmetadata: { name: web }\nspec: { selector: { app: web } }\n",
    "b/kustomization.yaml": "namespace: staging\nresources: [ service.yaml, ingress.yaml ]\n",
    "b/service.yaml": "apiVersion: v1\nkind: Service\nmetadata: { name: api, namespace: prod }\nspec: { selector: { app: api } }\n",
    "b/ingress.yaml": "apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata: { name: edge, namespace: prod }\nspec: { defaultBackend: { service: { name: web } } }\n",
    "c/kustomization.yaml": "namespace: prod\nresources: [ service.yaml, ingress.yaml ]\n",
    "c/service.yaml": "apiVersion: v1\nkind: Service\nmetadata: { name: api2, namespace: other }\nspec: { selector: { app: api } }\n",
    "c/ingress.yaml": "apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata: { name: edge2, namespace: other }\nspec: { defaultBackend: { service: { name: web } } }\n",
    "other/web.yaml": "apiVersion: v1\nkind: Service\nmetadata: { name: web, namespace: prod }\nspec: { selector: { app: none } }\n",
    "raw/ingress.yaml": "apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata: { name: edge3, namespace: prod }\nspec: { defaultBackend: { service: { name: web } } }\n",
  }, ({ graph }) => {
    const all = refs(graph);
    // b moves both to staging, where nothing is deployed.
    assert.deepEqual(all.filter((e) => e.startsWith("b/") && !e.startsWith("b/kustomization")), []);
    // c moves both into prod, where a deployed the Deployment and the Service web.
    assert.ok(all.includes("c/service.yaml#Service/other/api2 -> a/deployment.yaml#Deployment/default/api (inferred)"), all.join("\n"));
    assert.ok(all.includes("c/ingress.yaml#Ingress/other/edge2 -> a/web.yaml#Service/default/web (inferred)"), all.join("\n"));
    // An object no kustomization builds meets both Services named web in prod: the one written there and the one deployed there.
    assert.deepEqual(all.filter((e) => e.startsWith("raw/ingress")), [
      "raw/ingress.yaml#Ingress/prod/edge3 -> a/web.yaml#Service/default/web (inferred)",
      "raw/ingress.yaml#Ingress/prod/edge3 -> other/web.yaml#Service/prod/web (inferred)",
    ]);
  });
});

test("a patch target's group and version select, and a target names an object as it is before this kustomization's own prefix", async () => {
  await withBuild({
    "k/kustomization.yaml": `resources: [ d.yaml ]
patches:
  - path: ops.yaml
    target: { group: extensions, version: v1beta1, kind: Deployment, name: api }
  - path: ops.yaml
    target: { group: apps, version: v1, kind: Deployment, name: api }
  - path: ops.yaml
    target: { group: "", version: "", kind: Deployment, name: api }
`,
    "k/d.yaml": deployment("api"),
    "k/ops.yaml": OPS,
    "base/kustomization.yaml": "namePrefix: b-\nresources: [ d.yaml ]\n",
    "base/d.yaml": deployment("api"),
    "mid/kustomization.yaml": "namePrefix: m-\nresources: [ ../base ]\n",
    "top/kustomization.yaml": "namePrefix: t-\nresources: [ ../mid ]\npatches:\n  - path: ops.yaml\n    target: { kind: Deployment, name: t-m-b-api }\n  - path: mid.yaml\n",
    "top/ops.yaml": OPS,
    "top/mid.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: b-api }\nspec: { replicas: 2 }\n",
  }, ({ result, graph }) => {
    assert.deepEqual(result.skipped, [
      { path: "k/kustomization.yaml", reason: "patch ops.yaml matched no object this kustomization builds" },
      { path: "top/kustomization.yaml", reason: "patch ops.yaml matched no object this kustomization builds" },
    ]);
    assert.ok(refs(graph).includes("top/mid.yaml#Deployment/default/b-api -> base/d.yaml#Deployment/default/api"));
  });
});

test("an untargeted patch matches its namespace exactly, and reports each object it names that matches nothing", async () => {
  await withBuild({
    "k/kustomization.yaml": "resources: [ a.yaml, b.yaml ]\npatches:\n  - path: explicit.yaml\n  - path: unset.yaml\n  - path: two.yaml\n",
    "k/a.yaml": deployment("api"),
    "k/b.yaml": deployment("api", ", namespace: prod"),
    "k/explicit.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: api, namespace: default }\nspec: { replicas: 2 }\n",
    "k/unset.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: api }\nspec: { replicas: 2 }\n",
    "k/two.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: api, namespace: prod }\nspec: { replicas: 2 }\n---\napiVersion: v1\nkind: Service\nmetadata: { name: missing }\nspec: { type: NodePort }\n",
  }, ({ result, graph }) => {
    assert.deepEqual(result.skipped, [{ path: "k/kustomization.yaml", reason: "patch two.yaml Service missing matched no object this kustomization builds" }]);
    assert.deepEqual(refs(graph).filter((e) => /^k\/(explicit|unset|two)/.test(e)), [
      "k/explicit.yaml#Deployment/default/api -> k/a.yaml#Deployment/default/api",
      "k/two.yaml#Deployment/prod/api -> k/b.yaml#Deployment/prod/api",
      "k/unset.yaml#Deployment/default/api -> k/a.yaml#Deployment/default/api",
    ]);
  });
});

test("generated objects: a patch may change one, and a workload links to one only in its own namespace", async () => {
  await withBuild({
    "g/kustomization.yaml": "configMapGenerator: [ { name: cfg, literals: [ a=b ] } ]\npatches:\n  - path: cfg.yaml\n",
    "g/cfg.yaml": `apiVersion: v1\nkind: ConfigMap\nmetadata: { name: cfg }\ndata: { a: ${LITERAL} }\n`,
    "ns/kustomization.yaml": "resources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, namespace: prod, literals: [ a=b ] } ]\n",
    "ns/d.yaml": DEPLOYMENT,
    "same/kustomization.yaml": "resources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, literals: [ a=b ] } ]\n",
    "same/d.yaml": DEPLOYMENT,
  }, ({ result, graph, root }) => {
    assert.deepEqual(result.skipped, []);
    const all = refs(graph);
    assert.ok(all.includes("g/cfg.yaml#ConfigMap/default/cfg -> g/kustomization.yaml#configMapGenerator:cfg"), all.join("\n"));
    assert.ok(!all.some((e) => e.startsWith("ns/d.yaml")), all.join("\n"));
    assert.ok(all.includes("same/d.yaml#Deployment/default/api -> same/kustomization.yaml#configMapGenerator:app-config"), all.join("\n"));
    // A patch's values are never kept.
    for (const f of everyFile(contextDirFor(root))) assert.ok(!readFileSync(f, "utf8").includes(LITERAL), f);
  });
});

test("a component's patches and image renames reach the objects of the kustomization that lists it, through a component that lists it", async () => {
  await withBuild({
    Dockerfile: "FROM python:3.12\n",
    "compose.yaml": "services:\n  api: { build: ., image: ghcr.io/acme/api }\n",
    "base/kustomization.yaml": "resources: [ deployment.yaml ]\n",
    "base/deployment.yaml": deployment("api"),
    "inner/kustomization.yaml": "kind: Component\npatches:\n  - path: p.yaml\n",
    "inner/p.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: api }\nspec: { replicas: 2 }\n",
    "outer/kustomization.yaml": "kind: Component\ncomponents: [ ../inner ]\nimages: [ { name: api, newName: ghcr.io/acme/api } ]\n",
    "over/kustomization.yaml": "resources: [ ../base ]\ncomponents: [ ../outer ]\n",
  }, ({ result, graph }) => {
    assert.deepEqual(result.skipped, []);
    const all = refs(graph);
    assert.ok(all.includes("inner/p.yaml#Deployment/default/api -> base/deployment.yaml#Deployment/default/api"), all.join("\n"));
    assert.ok(all.includes("base/deployment.yaml#Deployment/default/api -> compose.yaml#service:api (inferred)"), all.join("\n"));
  });
});

test("an images entry selects an image by its name as written, not as a registry would read it", async () => {
  const workload = (name: string, image: string) =>
    `apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: ${name} }\nspec: { template: { metadata: { labels: { app: ${name} } }, spec: { containers: [ { name: c, image: "${image}" } ] } } }\n`;
  await withBuild({
    Dockerfile: "FROM python:3.12\n",
    "compose.yaml": "services:\n  api: { build: ., image: ghcr.io/acme/api }\n",
    "k/kustomization.yaml": "resources: [ d.yaml ]\nimages: [ { name: nginx, newName: ghcr.io/acme/api } ]\n",
    "k/d.yaml": [workload("full", "docker.io/library/nginx:1.25"), workload("short", "nginx:1.25"), workload("digest", "nginx@sha256:abc")].join("---\n"),
  }, ({ graph }) => {
    assert.deepEqual(refs(graph).filter((e) => e.includes(" -> compose")), [
      "k/d.yaml#Deployment/default/digest -> compose.yaml#service:api (inferred)",
      "k/d.yaml#Deployment/default/short -> compose.yaml#service:api (inferred)",
    ]);
  });
});

test("an inline patch that is not valid YAML is reported, and a folder with an unreadable second kustomization file is refused", async () => {
  await withBuild({
    "k/kustomization.yaml": "resources: [ d.yaml ]\npatches:\n  - patch: \"kind: [unclosed\"\n    target: { kind: Deployment, name: api }\n",
    "k/d.yaml": deployment("api"),
    "base/kustomization.yaml": "resources: [ d.yaml ]\n",
    "base/Kustomization": "resources: [ : bad\n",
    "base/d.yaml": deployment("api"),
    "over/kustomization.yaml": "resources: [ ../base ]\n",
  }, ({ result, graph }) => {
    const reasons = (path: string) => result.skipped.filter((s) => s.path === path).map((s) => s.reason);
    assert.deepEqual(reasons("k/kustomization.yaml"), ["patch inline is not valid YAML: not followed"]);
    assert.deepEqual(reasons("base/kustomization.yaml"), ["not read: Kustomize refuses a folder with more than one kustomization file"]);
    assert.deepEqual(reasons("over/kustomization.yaml"), ["resources ../base not read: its folder has more than one kustomization file"]);
    assert.deepEqual(refs(graph).filter((e) => e.startsWith("over/") || e.startsWith("base/kustomization")), []);
  });
});

/** Read files straight into the resolver, as `trail build` would, without writing them. */
function resolveFiles(files: Record<string, string>) {
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
