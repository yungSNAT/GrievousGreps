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

const APPLIED = "not applied to references, which link objects as written";

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
      { path: "base/kustomization.yaml", reason: `configMapGenerator ${APPLIED}` },
      ...["images", "secretGenerator", "patches"].map((f) => ({ path: "overlays/prod/kustomization.yaml", reason: `${f} ${APPLIED}` })),
      { path: "overlays/prod/kustomization.yaml", reason: "resources https://github.com/acme/shared//deploy?ref=v1 not followed: remote" },
    ]);
  });
});

/** Files with kustomizations, manifests named like them (one document, 2 documents, extensionless) and plain manifests. */
const MIXED: Record<string, string> = {
  "Dockerfile": "FROM python:3.12\nCOPY src/ /app/src/\n",
  "compose.yaml": "services:\n  api: { build: ., image: ghcr.io/acme/api }\n",
  "a/kustomization.yaml": "namespace: prod\nnamePrefix: p-\nresources: [ deployment.yaml, web.yaml, ../b ]\nconfigMapGenerator: [ { name: app-config, literals: [ a=b ] } ]\nimages: [ { name: api, newName: ghcr.io/acme/api } ]\n",
  "a/deployment.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: api }\nspec:\n  template:\n    metadata: { labels: { app: api } }\n    spec:\n      containers:\n        - name: api\n          image: api\n          envFrom: [ { configMapRef: { name: app-config } } ]\n",
  "a/web.yaml": "apiVersion: v1\nkind: Service\nmetadata: { name: web }\nspec: { selector: { app: web } }\n",
  "b/kustomization.yaml": "nameSuffix: -b\nresources: [ cfg/configmap.yaml, d.yaml ]\npatches: [ { path: ops.yaml, target: { kind: Deployment } } ]\n",
  "b/cfg/configmap.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: app-config }\n",
  "b/d.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: web }\nspec: { template: { metadata: { labels: { app: web } }, spec: { containers: [ { name: c, image: web } ] } } }\n",
  "b/ops.yaml": "- op: add\n  path: /metadata/labels/x\n  value: y\n",
  "raw/service.yaml": "apiVersion: v1\nkind: Service\nmetadata: { name: api }\nspec: { selector: { app: api } }\n",
  "raw/ingress.yaml": "apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata: { name: edge }\nspec: { defaultBackend: { service: { name: api } } }\n",
  "cfg/kustomization.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: app-config }\n",
  "two/kustomization.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: two }\nspec: { template: { metadata: { labels: { app: two } }, spec: { containers: [ { name: c, image: two, envFrom: [ { configMapRef: { name: two-config } } ] } ] } } }\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: { name: two-config }\n",
  "cm/Kustomization": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: app-config }\n"
};

/** The edges main gives for MIXED, recorded once at cd23a7e (before Kustomize) with its own deployFormatOf, extractDeploy and resolveDeploy. */
const MAIN_EDGES = [
  "a/deployment.yaml#Deployment/default/api -> b/cfg/configmap.yaml#ConfigMap/default/app-config inferred",
  "a/deployment.yaml#Deployment/default/api -> cfg/kustomization.yaml#ConfigMap/default/app-config inferred",
  "a/web.yaml#Service/default/web -> b/d.yaml#Deployment/default/web inferred",
  "compose.yaml#service:api -> Dockerfile#stage:0 extracted",
  "raw/ingress.yaml#Ingress/default/edge -> raw/service.yaml#Service/default/api extracted",
  "raw/service.yaml#Service/default/api -> a/deployment.yaml#Deployment/default/api inferred",
  "two/kustomization.yaml#Deployment/default/two -> two/kustomization.yaml#ConfigMap/default/two-config extracted"
];

test("every edge but a kustomization's own is the one main gives for the same files", () => {
  const head = resolveFiles(MIXED).edges.filter((e) => !e.source.endsWith("#kustomization")).map((e) => `${e.source} -> ${e.target} ${e.confidence ?? ""}`).sort();
  assert.deepEqual(head, MAIN_EDGES);
});

test("a file named kustomization.yaml that holds Kubernetes objects, a Flux Kustomization or nothing is read as a manifest; empty documents around a kustomization are ignored", async () => {
  await withBuild({
    "app/deploy.yaml": DEPLOYMENT,
    "cfg/kustomization.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: app-config }\n",
    "two/kustomization.yaml": `${deployment("web").replace("image: web", "image: web, envFrom: [ { configMapRef: { name: web-config } } ]")}---\napiVersion: v1\nkind: ConfigMap\nmetadata: { name: web-config }\n`,
    "flux/kustomization.yaml": "apiVersion: kustomize.toolkit.fluxcd.io/v1\nkind: Kustomization\nmetadata: { name: apps }\nspec: { path: ./apps }\n",
    "empty/kustomization.yaml": "# nothing yet\n",
    "root/kustomization.yaml": "resources: [ ../flux, ../empty, ../cfg, ../trail, ../lead ]\n",
    "trail/kustomization.yaml": "resources: [ d.yaml ]\n---\n",
    "trail/d.yaml": deployment("t"),
    "lead/kustomization.yaml": "---\nresources: [ d.yaml ]\n",
    "lead/d.yaml": deployment("l"),
  }, ({ result, graph }) => {
    assert.deepEqual(result.skipped, ["../flux", "../empty", "../cfg"].map((p) => ({ path: "root/kustomization.yaml", reason: `resources ${p} not read: no kustomization was read from its folder` })));
    const all = refs(graph);
    assert.ok(all.includes("app/deploy.yaml#Deployment/default/api -> cfg/kustomization.yaml#ConfigMap/default/app-config (inferred)"), all.join("\n"));
    assert.ok(all.includes("two/kustomization.yaml#Deployment/default/web -> two/kustomization.yaml#ConfigMap/default/web-config"), all.join("\n"));
    assert.ok(graph.nodes.some((n) => n.id === "flux/kustomization.yaml#Kustomization/default/apps"));
    assert.deepEqual(graph.nodes.filter((n) => n.id.endsWith("#kustomization")).map((n) => n.id).sort(),
      ["lead/kustomization.yaml#kustomization", "root/kustomization.yaml#kustomization", "trail/kustomization.yaml#kustomization"]);
    for (const k of ["trail/kustomization.yaml#kustomization -> trail/d.yaml#Deployment/default/t", "lead/kustomization.yaml#kustomization -> lead/d.yaml#Deployment/default/l"]) assert.ok(all.includes(k), all.join("\n"));
  });
});

test("an extensionless Kustomization that is not one stays unread, a git:: or drive path never names a local one, a CR-only inline patch is not a path, and each unread field has its own report", () => {
  const { edges, skipped } = resolveFiles({
    "app/deploy.yaml": DEPLOYMENT,
    "cm/Kustomization": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: app-config }\n",
    "g/kustomization.yaml": 'resources: [ "git::https://github.com/o/r//p", "git::github.com/o/r", "git::github.com/o/r/d.yaml", "C:/k8s/base" ]\npatchesStrategicMerge:\n  - "apiVersion: v1\\rkind: ConfigMap\\rmetadata:\\r  name: x\\rdata:\\r  k: SENTINEL7"\n  - "kind: ConfigMap\\Ldata:\\L  k: SENTINEL8"\n  - "kind: ConfigMap\\Pdata:\\P  k: SENTINEL9"\n  - "kind: ConfigMap\\Ndata:\\N  k: SENTINELA"\n  - GIT::github.com/o/r/d.yaml\n  - C:\\k8s\\p.yaml\n',
    "g/git::https:/github.com/o/r/p/kustomization.yaml": "resources: []\n",
    "g/git::github.com/o/r/kustomization.yaml": "resources: [ d.yaml ]\n",
    "g/git::github.com/o/r/d.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: local }\n",
    "g/GIT::github.com/o/r/d.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: upper }\n",
    "g/C:\\k8s\\p.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: drive }\n",
    "u/kustomization.yaml": "helmCharts: [ x ]\nhelmChartInflationGenerator: [ x ]\ngenerators: [ x ]\ntransformers: [ x ]\nreplacements: [ x ]\nvars: [ x ]\ncrds: [ x ]\nconfigurations: [ x ]\ncommonLabels: [ x ]\nlabels: [ x ]\n",
  });
  assert.deepEqual(edges.filter((e) => e.target.startsWith("cm/") || e.source === "g/kustomization.yaml#kustomization"), []);
  assert.deepEqual(skipped.filter((s) => s.path === "g/kustomization.yaml").map((s) => s.reason), [
    `patchesStrategicMerge ${APPLIED}`,
    "resources https://github.com/o/r//p not followed: remote",
    "resources github.com/o/r not followed: remote",
    "resources github.com/o/r/d.yaml not followed: remote",
    "resources C:/k8s/base not followed: outside the repository",
    "patch github.com/o/r/d.yaml not followed: remote",
    "patch C:\\k8s\\p.yaml not followed: outside the repository",
  ]);
  assert.deepEqual(skipped.filter((s) => s.path === "u/kustomization.yaml").map((s) => s.reason), ["helmCharts not read", "helmChartInflationGenerator not read", "generators not read", "transformers not read", "replacements not read", "vars not read", "crds not read", "configurations not read", "commonLabels not read", "labels not read"]);
  assert.ok(!/SENTINEL/.test(JSON.stringify(skipped)));
});

test("no generator literal reaches the graph or its caches", async () => {
  await withBuild(REPO, ({ root }) => {
    for (const f of everyFile(contextDirFor(root))) assert.ok(!readFileSync(f, "utf8").includes(LITERAL), f);
  });
});

test("a malformed kustomization is skipped with a reason, and a file of several documents that is not one is left alone, as on main", async () => {
  await withBuild({
    "a/kustomization.yaml": "resources: not-a-list\n",
    "b/kustomization.yaml": "resources: [ d.yaml ]\n",
    "b/d.yaml": deployment("api"),
    "c/kustomization.yaml": "? [ x, y ]\n: z\nresources: [ 1 ]\n",
    "e/kustomization.yaml": "apiVersion: v1\nkind: ConfigMap\n",
    "g/kustomization.yaml": "resources: [ d.yaml ]\n---\n{}\n",
    "h/kustomization.yaml": "resources: [ d.yaml ]\n---\n''\n",
    "i/kustomization.yaml": "- a\n---\n- b\n",
    "j/kustomization.yaml": "name: x\n---\nname: y\n",
    "f/kustomization.yaml": "a: &a [1,1,1,1,1,1,1,1,1,1]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]\nresources: *d\n",
  }, ({ result, graph }) => {
    assert.deepEqual(result.skipped.filter((s) => s.path !== "f/kustomization.yaml"), [
      { path: "a/kustomization.yaml", reason: "resources is not a list" },
      { path: "c/kustomization.yaml", reason: "resources entry is not a string" },
      { path: "e/kustomization.yaml", reason: "ConfigMap at line 1 has no metadata.name" },
      { path: "g/kustomization.yaml", reason: "a kustomization is one YAML document" },
      { path: "h/kustomization.yaml", reason: "a kustomization is one YAML document" },
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
  - /etc/k8s
  - ../../outside
  - github.com/acme/base?ref=v1
  - git@github.com:acme/x.git
  - https://user:tok3n@example.com/x.yaml
  - oauth2:SEKRET1@gitlab.com/org/repo
  - github.com/o/r?ref=v1&token=SEKRET2
  - git::https://user:tok3n@github.com/o/r//p?ref=v1
  - git::https://user:tok3n@github.com/o/r//p
  - config.d/x.yaml
  - ../bad
  - empty.yaml
  - deploy.yaml
components: [ ../comp-missing ]
patches:
  - path: gone.yaml
  - path: ops.yaml
    target: { labelSelector: "a=b" }
  - path: deploy.yaml
  - path: cfg.d/p.yaml
`,
    "bad/kustomization.yaml": "resources: not-a-list\n",
    "app/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: web }\nspec: { template: { spec: { containers: [] } } }\n",
    "app/ops.yaml": "- op: replace\n  path: /spec/replicas\n  value: 2\n",
    "app/empty.yaml": "# nothing yet\n",
    "dup/kustomization.yaml": "resources: [ x.yaml ]\nconfigMapGenerator: [ { name: g } ]\n",
    "dup/Kustomization": "resources: [ x.yaml ]\n",
    "dup/x.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: x }\n",
    "helm/kustomization.yaml": "helmCharts: [ { name: x } ]\ncommonLabels: { a: b }\nresources: []\n",
    "many/kustomization.yaml": `resources:\n${many}\n`,
    "loop1/kustomization.yaml": "resources: [ ../loop2 ]\n",
    "loop2/kustomization.yaml": "resources: [ ../loop1 ]\n",
  }, ({ result, graph }) => {
    const reasons = (path: string) => result.skipped.filter((s) => s.path === path).map((s) => s.reason);
    assert.deepEqual(reasons("app/kustomization.yaml"), [
      `patches ${APPLIED}`,
      "resources missing.yaml not found",
      "resources /etc/k8s not followed: outside the repository",
      "resources ../../outside not followed: outside the repository",
      "resources github.com/acme/base?ref=v1 not followed: remote",
      "resources github.com:acme/x.git not followed: remote",
      "resources https://example.com/x.yaml not followed: remote",
      "resources gitlab.com/org/repo not followed: remote",
      "resources github.com/o/r?ref=v1 not followed: remote",
      "resources https://github.com/o/r//p?ref=v1 not followed: remote",
      "resources https://github.com/o/r//p not followed: remote",
      "resources config.d/x.yaml not found, or a remote base: not followed",
      "resources ../bad not read: no kustomization was read from its folder",
      "resources empty.yaml gave no Kubernetes objects",
      "resources deploy.yaml listed more than once: followed once",
      "components ../comp-missing not found",
      "patch gone.yaml not found",
      "patch ops.yaml gave no Kubernetes objects",
      "patch deploy.yaml listed more than once: followed once",
      "patch cfg.d/p.yaml not found, or remote: not followed",
    ]);
    assert.ok(!/tok3n|SEKRET/.test(JSON.stringify(result.skipped)));
    assert.deepEqual(reasons("dup/kustomization.yaml"), ["not read: Kustomize refuses a folder with more than one kustomization file"]);
    assert.deepEqual(reasons("dup/Kustomization"), ["not read: Kustomize refuses a folder with more than one kustomization file"]);
    assert.deepEqual(reasons("helm/kustomization.yaml"), ["helmCharts not read", "commonLabels not read"]);
    assert.deepEqual([...reasons("loop1/kustomization.yaml"), ...reasons("loop2/kustomization.yaml")], ["cycle: loop2 includes loop1, which leads back to it"]);
    const m = reasons("many/kustomization.yaml");
    assert.equal(m.length, 21);
    assert.equal(m.at(-1), "and 5 more reports");
    assert.deepEqual(refs(graph).filter((e) => /^(app|dup)\//.test(e)), ["app/kustomization.yaml#kustomization -> app/deploy.yaml#Deployment/default/web"]);
  });
});
