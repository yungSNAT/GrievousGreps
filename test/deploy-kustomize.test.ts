/**
 * Kustomize in the deploy graph (`src/graph/kustomize.ts`): a kustomization links to what it
 * lists (objects, kustomization folders, patch files) and to a name-only node per generator;
 * names are not resolved, so every other edge is what the plain manifests give; every include
 * not followed and every name transform not applied is reported. No generator value is read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contextDirFor } from "../src/context/node-file.js";
import { deployFormatOf } from "../src/graph/deploy.js";
import { DEPLOYMENT, LITERAL, SERVICE, deployment, everyFile, refs, resolveFiles, withBuild } from "./deploy-kustomize-fixtures.js";

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

const APPLIED = "not applied to references, which link objects as written:";

test("kustomization files are named by their file names", () => {
  assert.equal(deployFormatOf("overlays/prod/kustomization.yaml"), "kustomize");
  assert.equal(deployFormatOf("base/Kustomization"), "kustomize");
  assert.equal(deployFormatOf("base/kustomization.yml"), "kustomize");
  assert.equal(deployFormatOf("base/deployment.yaml"), "kubernetes");
});

test("a kustomization links to its base, the objects it lists, its patch files and its generators, and reports what it does not apply", async () => {
  await withBuild(REPO, ({ result, graph }) => {
    assert.deepEqual(refs(graph).filter((e) => e.includes("kustomization")), [
      "base/kustomization.yaml#kustomization -> base/deployment.yaml#Deployment/default/api",
      "base/kustomization.yaml#kustomization -> base/kustomization.yaml#configMapGenerator:app-config",
      "base/kustomization.yaml#kustomization -> base/service.yaml#Service/default/api",
      "overlays/dev/kustomization.yaml#kustomization -> base/kustomization.yaml#kustomization",
      "overlays/prod/kustomization.yaml#kustomization -> base/kustomization.yaml#kustomization",
      "overlays/prod/kustomization.yaml#kustomization -> overlays/prod/kustomization.yaml#secretGenerator:app-secret",
      "overlays/prod/kustomization.yaml#kustomization -> overlays/prod/replicas.yaml#Deployment/default/api",
    ]);
    assert.deepEqual(result.skipped, [
      { path: "base/kustomization.yaml", reason: `${APPLIED} configMapGenerator` },
      { path: "overlays/prod/kustomization.yaml", reason: `${APPLIED} images, secretGenerator, patches` },
      { path: "overlays/prod/kustomization.yaml", reason: "resources https://github.com/acme/shared//deploy?ref=v1 not followed: remote" },
    ]);
  });
});

test("every edge but a kustomization's own is the one the manifests give without any kustomization file", () => {
  const fixtures: Array<Record<string, string>> = [REPO, {
    "a/kustomization.yaml": "namespace: prod\nnamePrefix: p-\nresources: [ deployment.yaml, web.yaml, ../b ]\nconfigMapGenerator: [ { name: app-config, literals: [ a=b ] } ]\n",
    "a/deployment.yaml": DEPLOYMENT,
    "a/web.yaml": "apiVersion: v1\nkind: Service\nmetadata: { name: web }\nspec: { selector: { app: web } }\n",
    "b/kustomization.yaml": "nameSuffix: -b\nresources: [ cfg/configmap.yaml, d.yaml ]\npatches: [ { path: ops.yaml, target: { kind: Deployment } } ]\n",
    "b/cfg/configmap.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: app-config }\n",
    "b/d.yaml": deployment("web"),
    "b/ops.yaml": "- op: add\n  path: /metadata/labels/x\n  value: y\n",
    "raw/service.yaml": SERVICE,
    "raw/ingress.yaml": "apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata: { name: edge }\nspec: { defaultBackend: { service: { name: api } } }\n",
  }];
  const plain = (edges: Array<{ source: string; target: string; confidence?: string }>) =>
    edges.filter((e) => !e.source.includes("kustomization") && !e.target.includes("kustomization")).map((e) => `${e.source} -> ${e.target} ${e.confidence ?? ""}`).sort();
  for (const files of fixtures) {
    const without = Object.fromEntries(Object.entries(files).filter(([p]) => !p.endsWith("kustomization.yaml")));
    const withK = plain(resolveFiles(files).edges);
    assert.ok(withK.length > 0);
    assert.deepEqual(withK, plain(resolveFiles(without).edges));
  }
});

test("no generator literal reaches the graph or its caches", async () => {
  await withBuild(REPO, ({ root }) => {
    for (const f of everyFile(contextDirFor(root))) assert.ok(!readFileSync(f, "utf8").includes(LITERAL), f);
  });
});

test("a malformed kustomization is skipped with a reason", async () => {
  await withBuild({
    "a/kustomization.yaml": "resources: not-a-list\n",
    "b/kustomization.yaml": "resources: [ d.yaml ]\n",
    "b/d.yaml": deployment("api"),
    "c/kustomization.yaml": "? [ x, y ]\n: z\nresources: [ 1 ]\n",
    "e/kustomization.yaml": "apiVersion: v1\nkind: ConfigMap\n",
    "f/kustomization.yaml": "a: &a [1,1,1,1,1,1,1,1,1,1]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]\nresources: *d\n",
  }, ({ result, graph }) => {
    assert.deepEqual(result.skipped.filter((s) => s.path !== "f/kustomization.yaml"), [
      { path: "a/kustomization.yaml", reason: "resources is not a list" },
      { path: "c/kustomization.yaml", reason: "resources entry is not a string" },
      { path: "e/kustomization.yaml", reason: "kind ConfigMap is not Kustomization or Component" },
    ]);
    assert.match(result.skipped.find((s) => s.path === "f/kustomization.yaml")!.reason, /^not valid YAML/);
    assert.deepEqual(refs(graph), ["b/kustomization.yaml#kustomization -> b/d.yaml#Deployment/default/api"]);
  });
});

test("every include or patch file not followed is reported, and a URL's credentials are not", async () => {
  const many = Array.from({ length: 25 }, (_, i) => `  - m${i}.yaml`).join("\n");
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
  - oauth2:SEKRET1@gitlab.com/org/repo
  - github.com/o/r?ref=v1&token=SEKRET2
  - empty.yaml
  - deploy.yaml
components: [ ../comp-missing ]
patches:
  - path: gone.yaml
  - path: ops.yaml
    target: { labelSelector: "a=b" }
`,
    "app/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: web }\nspec: { template: { spec: { containers: [] } } }\n",
    "app/ops.yaml": "- op: replace\n  path: /spec/replicas\n  value: 2\n",
    "app/empty.yaml": "# nothing yet\n",
    "dup/kustomization.yaml": "resources: [ x.yaml ]\n",
    "dup/Kustomization": "resources: [ x.yaml ]\n",
    "dup/x.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: x }\n",
    "helm/kustomization.yaml": "helmCharts: [ { name: x } ]\ncommonLabels: { a: b }\nresources: []\n",
    "many/kustomization.yaml": `resources:\n${many}\n`,
    "loop1/kustomization.yaml": "resources: [ ../loop2 ]\n",
    "loop2/kustomization.yaml": "resources: [ ../loop1 ]\n",
  }, ({ result, graph }) => {
    const reasons = (path: string) => result.skipped.filter((s) => s.path === path).map((s) => s.reason);
    assert.deepEqual(reasons("app/kustomization.yaml"), [
      `${APPLIED} patches`,
      "resources missing.yaml not found",
      "resources ../nowhere not found",
      "resources /etc/k8s not followed: outside the repository",
      "resources ../../outside not followed: outside the repository",
      "resources github.com/acme/base?ref=v1 not followed: remote",
      "resources github.com:acme/x.git not followed: remote",
      "resources https://example.com/x.yaml not followed: remote",
      "resources gitlab.com/org/repo not followed: remote",
      "resources github.com/o/r?ref=v1 not followed: remote",
      "resources empty.yaml gave no Kubernetes objects",
      "resources deploy.yaml listed more than once: followed once",
      "components ../comp-missing not found",
      "patch gone.yaml not found",
    ]);
    assert.ok(!/tok3n|SEKRET/.test(JSON.stringify(result.skipped)));
    assert.deepEqual(reasons("dup/kustomization.yaml"), ["not read: Kustomize refuses a folder with more than one kustomization file"]);
    assert.deepEqual(reasons("dup/Kustomization"), ["not read: Kustomize refuses a folder with more than one kustomization file"]);
    assert.deepEqual(reasons("helm/kustomization.yaml"), ["fields not read: helmCharts, commonLabels"]);
    assert.deepEqual([...reasons("loop1/kustomization.yaml"), ...reasons("loop2/kustomization.yaml")], ["cycle: loop2 includes loop1, which leads back to it"]);
    const m = reasons("many/kustomization.yaml");
    assert.equal(m.length, 21);
    assert.equal(m.at(-1), "and 5 more reports");
    assert.deepEqual(refs(graph).filter((e) => /^(app|dup)\//.test(e)), ["app/kustomization.yaml#kustomization -> app/deploy.yaml#Deployment/default/web"]);
  });
});
