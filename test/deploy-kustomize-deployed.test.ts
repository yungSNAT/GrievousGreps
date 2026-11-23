/** Kustomize in the deploy graph: where built objects are deployed, and what patches, generators and images match. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contextDirFor } from "../src/context/node-file.js";
import { DEPLOYMENT, LITERAL, OPS, SERVICE, deployment, everyFile, refs, withBuild } from "./deploy-kustomize-fixtures.js";

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

test("a prefixed kustomization keeps the links between the objects it builds, which Kustomize renames together", async () => {
  await withBuild({
    "app/kustomization.yaml": "namePrefix: p-\nresources: [ deployment.yaml, configmap.yaml, service.yaml, ingress.yaml ]\n",
    "app/deployment.yaml": DEPLOYMENT,
    "app/configmap.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: app-config }\n",
    "app/service.yaml": SERVICE,
    "app/ingress.yaml": "apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata: { name: edge }\nspec: { defaultBackend: { service: { name: api } } }\n",
  }, ({ graph }) => {
    const all = refs(graph);
    for (const edge of [
      "app/deployment.yaml#Deployment/default/api -> app/configmap.yaml#ConfigMap/default/app-config",
      "app/ingress.yaml#Ingress/default/edge -> app/service.yaml#Service/default/api",
      "app/service.yaml#Service/default/api -> app/deployment.yaml#Deployment/default/api",
    ]) assert.ok(all.includes(edge), `${edge}\n${all.join("\n")}`);
  });
});

test("a base that only overlays include is deployed where they put it, not where it is written", async () => {
  await withBuild({
    "web/kustomization.yaml": "resources: [ service.yaml ]\n",
    "web/service.yaml": "apiVersion: v1\nkind: Service\nmetadata: { name: web, namespace: prod }\nspec: { selector: { app: web } }\n",
    "web-staging/kustomization.yaml": "namespace: staging\nresources: [ ../web ]\n",
    "app/kustomization.yaml": "resources: [ deployment.yaml ]\n",
    "app/deployment.yaml": deployment("web"),
    "app-prod/kustomization.yaml": "namespace: prod\nresources: [ ../app ]\n",
  }, ({ graph }) => {
    assert.deepEqual(refs(graph).filter((e) => e.startsWith("web/service.yaml")), []);
  });
});

test("a target selects by the name as written or as it is now, and by the namespace as written or as it is now", async () => {
  await withBuild({
    "base/kustomization.yaml": "namePrefix: b-\nresources: [ d.yaml ]\n",
    "base/d.yaml": deployment("api"),
    "mid/kustomization.yaml": "namePrefix: m-\nresources: [ ../base ]\n",
    "top/kustomization.yaml": "resources: [ ../mid ]\npatches:\n  - path: ops.yaml\n    target: { kind: Deployment, name: b-api }\n",
    "top/ops.yaml": OPS,
    "b2/kustomization.yaml": "resources: [ d.yaml ]\n",
    "b2/d.yaml": deployment("api"),
    "m2/kustomization.yaml": "namespace: prod\nnamePrefix: m-\nresources: [ ../b2 ]\n",
    "t2/kustomization.yaml": "resources: [ ../m2 ]\npatches:\n  - path: ops.yaml\n    target: { kind: Deployment, name: api, namespace: prod }\n",
    "t2/ops.yaml": OPS,
  }, ({ result }) => {
    assert.deepEqual(result.skipped, [{ path: "top/kustomization.yaml", reason: "patch ops.yaml matched no object this kustomization builds" }]);
  });
});

test("an untargeted patch compares group and version too, and a component's own namespace or prefix is reported", async () => {
  await withBuild({
    "k/kustomization.yaml": "resources: [ d.yaml ]\npatches:\n  - path: old.yaml\n",
    "k/d.yaml": deployment("api"),
    "k/old.yaml": "apiVersion: extensions/v1beta1\nkind: Deployment\nmetadata: { name: api }\nspec: { replicas: 2 }\n",
    "base/kustomization.yaml": "resources: [ d.yaml ]\n",
    "base/d.yaml": deployment("api"),
    "ns/kustomization.yaml": "kind: Component\nnamespace: prod\n",
    "over/kustomization.yaml": "resources: [ ../base ]\ncomponents: [ ../ns ]\n",
  }, ({ result, graph }) => {
    assert.deepEqual(result.skipped, [
      { path: "ns/kustomization.yaml", reason: "component namespace not followed for the objects of the kustomizations that list it" },
      { path: "k/kustomization.yaml", reason: "patch old.yaml Deployment api matched no object this kustomization builds" },
    ]);
    assert.ok(!refs(graph).some((e) => e.startsWith("k/old.yaml") && e.includes("-> k/d.yaml")));
  });
});

test("an images entry selects a tagged image pinned by digest", async () => {
  await withBuild({
    Dockerfile: "FROM python:3.12\n",
    "compose.yaml": "services:\n  api: { build: ., image: ghcr.io/acme/api }\n",
    "k/kustomization.yaml": "resources: [ d.yaml ]\nimages: [ { name: nginx, newName: ghcr.io/acme/api } ]\n",
    "k/d.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: pinned }\nspec: { template: { metadata: { labels: { app: pinned } }, spec: { containers: [ { name: c, image: \"nginx:1.25@sha256:abc\" } ] } } }\n",
  }, ({ graph }) => {
    assert.deepEqual(refs(graph).filter((e) => e.includes(" -> compose")), ["k/d.yaml#Deployment/default/pinned -> compose.yaml#service:api (inferred)"]);
  });
});
