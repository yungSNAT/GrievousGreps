/**
 * Kustomize in the deploy graph (`src/graph/kustomize.ts`): a kustomization links to what it
 * lists and patches, an `images` rename joins a workload to the compose service that builds
 * the new name, a generator gives a name-only node, deployed names and namespaces resolve,
 * and every include not followed is reported. No generator value is read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contextDirFor } from "../src/context/node-file.js";
import { impactOfMany } from "../src/graph/traverse.js";
import { checkGraphInvariants } from "../src/graph/invariants.js";
import { deployFormatOf } from "../src/graph/deploy.js";
import { DEPLOYMENT, LITERAL, SERVICE, everyFile, refs, withBuild } from "./deploy-kustomize-fixtures.js";

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
