/**
 * Kustomize generators in a leaf build (`src/graph/kustomize.ts`, `linkGenerated`): a workload in a kustomization that
 * lists files only links to the generator its ConfigMap or Secret reference names when that build holds exactly one
 * object of that kind, name and namespace and it is generated. Each case's expectation is what `kustomize build`
 * renames: the reference takes the generated name (`app-config-<hash>`) or keeps its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEPLOYMENT, resolveFiles } from "./deploy-kustomize-fixtures.js";

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
