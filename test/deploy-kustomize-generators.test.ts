/**
 * Kustomize generators in a standalone leaf build (`src/graph/kustomize.ts`, `linkGenerated`): a workload in a
 * kustomization that lists valid local files only (no folders, components, patches, generator options, merge/replace
 * strategies or helm-generated opt-outs) links to the generator its ConfigMap or Secret reference names when that
 * standalone build holds exactly one object of that kind, name and namespace and it is generated without a repeated
 * generator node id. Each case's expectation is what `kustomize build` on that leaf renames: an enclosing overlay above
 * a leaf can still patch or transform references after accumulation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contextDirFor } from "../src/context/node-file.js";
import { DEPLOYMENT, everyFile, refs, resolveFiles, withBuild } from "./deploy-kustomize-fixtures.js";

const CONFIGMAP = "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: app-config }\n";
const GEN = "configMapGenerator: [ { name: app-config, literals: [ a=b ] } ]\n";

/** Edges into generators, and the reports, for a set of files. */
function generatorLinks(files: Record<string, string>) {
  const { edges, skipped } = resolveFiles(files);
  return {
    links: edges.filter((e) => /#(configMap|secret)Generator:/.test(e.target) && !e.source.endsWith("#kustomization"))
      .map((e) => `${e.source} -> ${e.target}${e.confidence === "extracted" ? "" : ` ${e.confidence}`}`).sort(),
    reasons: skipped.map((s) => `${s.path}: ${s.reason}`),
  };
}

test("a workload in a leaf build links to the generator its reference names, and the generator is not reported as unapplied", () => {
  const { links, reasons } = generatorLinks({ "app/kustomization.yaml": `resources: [ d.yaml ]\n${GEN}`, "app/d.yaml": DEPLOYMENT });
  assert.deepEqual(links, ["app/d.yaml#Deployment/default/api -> app/kustomization.yaml#configMapGenerator:app-config"]);
  assert.deepEqual(reasons, []);
});

test("namespaces decide the match: none reads as default, the kustomization's replaces every object's, a generator elsewhere is no candidate", () => {
  const { links } = generatorLinks({
    "other/kustomization.yaml": "resources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, namespace: other, literals: [ a=b ] } ]\n",
    "other/d.yaml": DEPLOYMENT,
    "set/kustomization.yaml": "namespace: prod\nnamePrefix: p-\nresources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, namespace: other, literals: [ a=b ] } ]\n",
    "set/d.yaml": DEPLOYMENT,
    "dflt/kustomization.yaml": "resources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, namespace: default, literals: [ a=b ] } ]\n",
    "dflt/d.yaml": DEPLOYMENT,
    "writ/kustomization.yaml": "resources: [ d.yaml, cm.yaml ]\nconfigMapGenerator: [ { name: app-config, namespace: other, literals: [ a=b ] } ]\n",
    "writ/d.yaml": DEPLOYMENT,
    "writ/cm.yaml": CONFIGMAP,
    // An empty namespace is none, on the kustomization and on a generator entry.
    "emptyk/kustomization.yaml": 'namespace: ""\nresources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, namespace: other, literals: [ a=b ] } ]\n',
    "emptyk/d.yaml": DEPLOYMENT,
    "emptyg/kustomization.yaml": 'resources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, namespace: "", literals: [ a=b ] } ]\n',
    "emptyg/d.yaml": DEPLOYMENT,
  });
  assert.deepEqual(links, [
    "dflt/d.yaml#Deployment/default/api -> dflt/kustomization.yaml#configMapGenerator:app-config",
    "emptyg/d.yaml#Deployment/default/api -> emptyg/kustomization.yaml#configMapGenerator:app-config",
    "set/d.yaml#Deployment/default/api -> set/kustomization.yaml#configMapGenerator:app-config",
  ]);
});

test("a name the build holds twice links no generator and is reported; a merge generator makes no object", () => {
  const { links, reasons } = generatorLinks({
    "two/kustomization.yaml": `resources: [ d.yaml, cm.yaml ]\n${GEN}`,
    "two/d.yaml": DEPLOYMENT,
    "two/cm.yaml": CONFIGMAP,
    "merge/kustomization.yaml": "resources: [ d.yaml, cm.yaml ]\nconfigMapGenerator: [ { name: app-config, behavior: merge, literals: [ a=b ] } ]\n",
    "merge/d.yaml": DEPLOYMENT,
    "merge/cm.yaml": CONFIGMAP,
  });
  assert.deepEqual(links, []);
  assert.ok(reasons.includes("two/kustomization.yaml: ConfigMap app-config is 2 objects in this build: not linked to its generator"), reasons.join("\n"));
  assert.ok(!reasons.some((r) => r.startsWith("merge/") && r.includes("not linked")), reasons.join("\n"));
});

test("every Secret reference of a CronJob's pod links to its generator", () => {
  const job = `apiVersion: batch/v1
kind: CronJob
metadata: { name: job }
spec:
  schedule: "* * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          imagePullSecrets: [ { name: pull } ]
          containers:
            - name: c
              image: x
              env: [ { name: A, valueFrom: { secretKeyRef: { name: creds, key: a } } } ]
          volumes:
            - name: v
              secret: { secretName: vol }
            - name: p
              projected: { sources: [ { secret: { name: proj } } ] }
`;
  const gens = ["pull", "creds", "vol", "proj"].map((n) => `{ name: ${n}, literals: [ a=b ] }`).join(", ");
  const { links } = generatorLinks({ "job/kustomization.yaml": `resources: [ j.yaml ]\nsecretGenerator: [ ${gens} ]\n`, "job/j.yaml": job });
  assert.deepEqual(links, ["creds", "proj", "pull", "vol"].map((n) => `job/j.yaml#CronJob/default/job -> job/kustomization.yaml#secretGenerator:${n}`));
});

test("only a leaf build links: a folder, a component, a patch or an unread field leaves references as written", () => {
  const { links, reasons } = generatorLinks({
    // Another app's generator is never linked from a build above both (each app is its own leaf).
    "root/kustomization.yaml": "resources: [ ../app1, ../app2 ]\n",
    "app1/kustomization.yaml": `namePrefix: app1-\nresources: [ deploy/deployment.yaml ]\n${GEN}`,
    "app1/deploy/deployment.yaml": DEPLOYMENT,
    "app2/kustomization.yaml": "namePrefix: app2-\nresources: [ deploy/deployment.yaml, config/configmap.yaml ]\n",
    "app2/deploy/deployment.yaml": DEPLOYMENT,
    "app2/config/configmap.yaml": CONFIGMAP,
    "over/kustomization.yaml": `resources: [ ../base, d.yaml ]\n${GEN}`,
    "over/d.yaml": DEPLOYMENT,
    "base/kustomization.yaml": "resources: []\n",
    "pat/kustomization.yaml": `resources: [ d.yaml ]\npatches: [ { path: p.yaml } ]\n${GEN}`,
    "pat/d.yaml": DEPLOYMENT,
    "pat/p.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: other }\nspec: { replicas: 2 }\n",
    "rep/kustomization.yaml": `resources: [ d.yaml ]\nreplacements: []\n${GEN}`,
    "rep/d.yaml": DEPLOYMENT,
    "comp/kustomization.yaml": `apiVersion: kustomize.config.k8s.io/v1alpha1\nkind: Component\nresources: [ d.yaml ]\n${GEN}`,
    "comp/d.yaml": DEPLOYMENT,
    // Kustomize refuses to build a file outside the kustomization's folder, or an object listed twice.
    "out/k/kustomization.yaml": `resources: [ ../shared/d.yaml ]\n${GEN}`,
    "out/shared/d.yaml": DEPLOYMENT,
    "twice/kustomization.yaml": `resources: [ d.yaml, ./d.yaml ]\n${GEN}`,
    "twice/d.yaml": DEPLOYMENT,
    "same/kustomization.yaml": `resources: [ d.yaml, e.yaml ]\n${GEN}`,
    "same/d.yaml": DEPLOYMENT,
    "same/e.yaml": DEPLOYMENT,
  });
  assert.deepEqual(links, ["app1/deploy/deployment.yaml#Deployment/default/api -> app1/kustomization.yaml#configMapGenerator:app-config"]);
  for (const k of ["over", "pat", "rep", "comp", "out/k", "twice", "same"]) {
    assert.ok(reasons.includes(`${k}/kustomization.yaml: configMapGenerator not applied to references, which link objects as written`), k);
  }
});

test("generator options and helm-generated annotations keep a kustomization out of leaf linking", () => {
  const helmDep = DEPLOYMENT.replace("metadata: { name: api }", 'metadata: { name: api, annotations: { "internal.config.kubernetes.io/helm-generated": "true" } }');
  const helmCm = CONFIGMAP.replace("metadata: { name: app-config }", 'metadata: { name: app-config, annotations: { "internal.config.kubernetes.io/helm-generated": "true" } }');
  const { links, reasons } = generatorLinks({
    // Modified c4 (F1): entry options.annotations keeps generator in other whilst workload moves to prod.
    "optentry/kustomization.yaml": 'namespace: prod\nnamePrefix: p-\nresources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, namespace: other, literals: [ a=b ], options: { annotations: { "internal.config.kubernetes.io/helm-generated": "true" } } } ]\n',
    "optentry/d.yaml": DEPLOYMENT,
    // Top-level generatorOptions (both helm-generated annotation and other options).
    "opttop/kustomization.yaml": 'namespace: prod\nresources: [ d.yaml ]\ngeneratorOptions: { annotations: { "internal.config.kubernetes.io/helm-generated": "true" } }\nconfigMapGenerator: [ { name: app-config, namespace: other, literals: [ a=b ] } ]\n',
    "opttop/d.yaml": DEPLOYMENT,
    "opthash/kustomization.yaml": "resources: [ d.yaml ]\ngeneratorOptions: { disableNameSuffixHash: true }\nconfigMapGenerator: [ { name: app-config, literals: [ a=b ] } ]\n",
    "opthash/d.yaml": DEPLOYMENT,
    "secopt/kustomization.yaml": "resources: [ d.yaml ]\nsecretGenerator: [ { name: app-secret, literals: [ a=b ], options: { disableNameSuffixHash: true } } ]\n",
    "secopt/d.yaml": DEPLOYMENT.replace("configMapRef: { name: app-config }", "secretRef: { name: app-secret }"),
    // Manifest holding helm-generated keeps its own namespace whilst the generator moves to prod.
    "helmdep/kustomization.yaml": "namespace: prod\nresources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, namespace: other, literals: [ a=b ] } ]\n",
    "helmdep/d.yaml": helmDep,
    "helmcm/kustomization.yaml": "namespace: prod\nresources: [ d.yaml, cm.yaml ]\nconfigMapGenerator: [ { name: app-config, namespace: other, literals: [ a=b ] } ]\n",
    "helmcm/d.yaml": DEPLOYMENT,
    "helmcm/cm.yaml": helmCm,
  });
  assert.deepEqual(links, []);
  for (const k of ["optentry", "opttop", "opthash", "helmdep", "helmcm"]) {
    assert.ok(reasons.includes(`${k}/kustomization.yaml: configMapGenerator not applied to references, which link objects as written`), k);
  }
  assert.ok(reasons.includes("secopt/kustomization.yaml: secretGenerator not applied to references, which link objects as written"));
});

test("a generator id repeated across namespaces keeps its structural edge and makes no workload link", () => {
  const blueDep = DEPLOYMENT.replace("metadata: { name: api }", "metadata: { name: api, namespace: blue }");
  const redDep = DEPLOYMENT.replace("metadata: { name: api }", "metadata: { name: api, namespace: red }");
  const { edges, skipped } = resolveFiles({
    // F2: same-named generator entries in red then blue share one node id; neither blue nor red links.
    "rep/kustomization.yaml": "resources: [ blue.yaml, red.yaml ]\nconfigMapGenerator:\n  - { name: app-config, namespace: red, literals: [ a=1 ] }\n  - { name: app-config, namespace: blue, literals: [ a=2 ] }\n",
    "rep/blue.yaml": blueDep,
    "rep/red.yaml": redDep,
    "overns/kustomization.yaml": "namespace: prod\nresources: [ blue.yaml ]\nconfigMapGenerator:\n  - { name: app-config, namespace: red, literals: [ a=1 ] }\n  - { name: app-config, namespace: blue, literals: [ a=2 ] }\n",
    "overns/blue.yaml": blueDep,
    // Same name across ConfigMap and Secret has distinct generator ids, so both still link.
    "both/kustomization.yaml": "resources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, literals: [ a=b ] } ]\nsecretGenerator: [ { name: app-config, literals: [ a=b ] } ]\n",
    "both/d.yaml": DEPLOYMENT.replace("envFrom: [ { configMapRef: { name: app-config } } ]", "envFrom: [ { configMapRef: { name: app-config } }, { secretRef: { name: app-config } } ]"),
  });
  assert.ok(edges.some((e) => e.source === "rep/kustomization.yaml#kustomization" && e.target === "rep/kustomization.yaml#configMapGenerator:app-config"));
  const genLinks = edges.filter((e) => /#(configMap|secret)Generator:/.test(e.target) && !e.source.endsWith("#kustomization"))
    .map((e) => `${e.source} -> ${e.target}`).sort();
  assert.deepEqual(genLinks, [
    "both/d.yaml#Deployment/default/api -> both/kustomization.yaml#configMapGenerator:app-config",
    "both/d.yaml#Deployment/default/api -> both/kustomization.yaml#secretGenerator:app-config",
  ]);
  const reasons = skipped.map((s) => `${s.path}: ${s.reason}`);
  assert.ok(reasons.includes("rep/kustomization.yaml: ConfigMap app-config has more than one generator entry: not linked to its generator"), reasons.join("\n"));
  assert.ok(reasons.includes("overns/kustomization.yaml: ConfigMap app-config is 2 objects in this build: not linked to its generator"), reasons.join("\n"));
});

test("only valid literals or existing local files with create behavior make a leaf; components entries never do", () => {
  const { links, reasons } = generatorLinks({
    "filesok/kustomization.yaml": 'resources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, behavior: create, files: [ app.env, "cfg=sub/a.txt" ] } ]\n',
    "filesok/d.yaml": DEPLOYMENT,
    "filesok/app.env": "A=1\n",
    "filesok/sub/a.txt": "x",
    "secok/kustomization.yaml": 'resources: [ d.yaml ]\nsecretGenerator: [ { name: creds, type: Opaque, literals: [ a=b ] } ]\n',
    "secok/d.yaml": DEPLOYMENT.replace("configMapRef: { name: app-config }", "secretRef: { name: creds }"),
    // F3: missing file, directory file, outside file, duplicate file key, envs, invalid/duplicate literals.
    "missing/kustomization.yaml": "resources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, files: [ missing.env ] } ]\n",
    "missing/d.yaml": DEPLOYMENT,
    "dirfile/kustomization.yaml": "resources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, files: [ sub ] } ]\n",
    "dirfile/d.yaml": DEPLOYMENT,
    "dirfile/sub/a.txt": "x",
    "outf/k/kustomization.yaml": "resources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, files: [ ../shared/a.txt ] } ]\n",
    "outf/k/d.yaml": DEPLOYMENT,
    "outf/shared/a.txt": "x",
    "dupkey/kustomization.yaml": "resources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, files: [ a/x.txt, b/x.txt ] } ]\n",
    "dupkey/d.yaml": DEPLOYMENT,
    "dupkey/a/x.txt": "1",
    "dupkey/b/x.txt": "2",
    "envs/kustomization.yaml": "resources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, envs: [ present.env ] } ]\n",
    "envs/d.yaml": DEPLOYMENT,
    "envs/present.env": "A=1\n",
    "badlit/kustomization.yaml": "resources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, literals: [ bad ] } ]\n",
    "badlit/d.yaml": DEPLOYMENT,
    "duplit/kustomization.yaml": "resources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, literals: [ a=1, a=2 ] } ]\n",
    "duplit/d.yaml": DEPLOYMENT,
    // Merge or replace strategy disqualifies the leaf, whether its target is missing or present.
    "mergemiss/kustomization.yaml": "resources: [ d.yaml ]\nconfigMapGenerator: [ { name: other, behavior: merge, literals: [ a=b ] }, { name: app-config, literals: [ a=b ] } ]\n",
    "mergemiss/d.yaml": DEPLOYMENT,
    "mergehit/kustomization.yaml": "resources: [ d.yaml, cm.yaml ]\nconfigMapGenerator: [ { name: other, behavior: merge, literals: [ a=b ] }, { name: app-config, literals: [ a=b ] } ]\n",
    "mergehit/d.yaml": DEPLOYMENT,
    "mergehit/cm.yaml": CONFIGMAP.replace("app-config", "other"),
    "repmiss/kustomization.yaml": "resources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, behavior: replace, literals: [ a=b ] } ]\n",
    "repmiss/d.yaml": DEPLOYMENT,
    // E1: components pointing to a file is refused by kustomize build, so never a leaf.
    "compfile/kustomization.yaml": `components: [ d.yaml ]\n${GEN}`,
    "compfile/d.yaml": DEPLOYMENT,
    // F4: a standalone leaf beneath an overlay still links when built on its own.
    "f4/leaf/kustomization.yaml": `resources: [ d.yaml ]\n${GEN}`,
    "f4/leaf/d.yaml": DEPLOYMENT,
    "f4/over/kustomization.yaml": 'resources: [ ../leaf ]\npatches: [ { target: { kind: Deployment, name: api }, patch: "- op: replace\\n  path: /spec/template/spec/containers/0/envFrom/0/configMapRef/name\\n  value: other" } ]\n',
  });
  assert.deepEqual(links, [
    "f4/leaf/d.yaml#Deployment/default/api -> f4/leaf/kustomization.yaml#configMapGenerator:app-config",
    "filesok/d.yaml#Deployment/default/api -> filesok/kustomization.yaml#configMapGenerator:app-config",
    "secok/d.yaml#Deployment/default/api -> secok/kustomization.yaml#secretGenerator:creds",
  ]);
  for (const k of ["missing", "dirfile", "outf/k", "dupkey", "envs", "badlit", "duplit", "mergemiss", "mergehit", "repmiss", "compfile"]) {
    assert.ok(reasons.includes(`${k}/kustomization.yaml: configMapGenerator not applied to references, which link objects as written`), k);
  }
});

test("on disk, a directory in files: is refused and no file key or literal reaches the graph or caches", async () => {
  await withBuild({
    "dir/kustomization.yaml": "resources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, files: [ sub ] } ]\n",
    "dir/d.yaml": DEPLOYMENT,
    "dir/sub/extra.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: other }\n",
    "ok/kustomization.yaml": 'resources: [ d.yaml ]\nconfigMapGenerator: [ { name: app-config, literals: [ "LITKEY=SECRET_LIT_VAL" ], files: [ "KEYSECRET=app.env" ] } ]\n',
    "ok/d.yaml": DEPLOYMENT,
    "ok/app.env": "A=SECRET_FILE_VAL\n",
  }, ({ root, result, graph }) => {
    const genEdges = refs(graph).filter((e) => /#(configMap|secret)Generator:/.test(e) && !e.includes("#kustomization ->"));
    assert.deepEqual(genEdges, ["ok/d.yaml#Deployment/default/api -> ok/kustomization.yaml#configMapGenerator:app-config"]);
    assert.ok(result.skipped.some((s) => s.path === "dir/kustomization.yaml" && s.reason.startsWith("configMapGenerator not applied")));
    for (const f of everyFile(contextDirFor(root))) {
      const text = readFileSync(f, "utf8");
      for (const secret of ["SECRET_LIT_VAL", "LITKEY", "KEYSECRET", "SECRET_FILE_VAL"]) assert.ok(!text.includes(secret), `${f}: ${secret}`);
    }
  });
});
