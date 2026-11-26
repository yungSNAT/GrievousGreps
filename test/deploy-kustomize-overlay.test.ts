/**
 * Kustomize generators across one build level (`src/graph/kustomize.ts`, `linkGenerated`): an overlay listing leaf
 * base folders links a workload in a base or in its own files to the overlay
 * generator its ConfigMap or Secret reference names, when the overlay's build holds exactly one object of that kind,
 * name and namespace. Each case's expectation is what `kustomize build` v5.8.3 on the case's overlay folder renames.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { refs, resolveFiles, withBuild } from "./deploy-kustomize-fixtures.js";

const dep = (name: string, { ref = "app-config", ns, kind = "configMapRef" }: { ref?: string; ns?: string; kind?: string } = {}) =>
  `apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: ${name}${ns ? `, namespace: ${ns}` : ""} }\n`
  + `spec: { template: { metadata: { labels: { app: ${name} } }, spec: { containers: [ { name: c, image: ${name}, envFrom: [ { ${kind}: { name: ${ref} } } ] } ] } } }\n`;
const GEN = "configMapGenerator: [ { name: app-config, literals: [ A=1 ] } ]\n";
const genIn = (ns: string) => `configMapGenerator: [ { name: app-config, namespace: ${ns}, literals: [ A=1 ] } ]\n`;
const BASE = "resources: [ d.yaml ]\n";
const OV = `resources: [ ../base ]\n${GEN}`;
const CM = "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: app-config }\n";

/** Each case's files, under the case's folder. */
const CASES: Record<string, Record<string, string>> = {
  plain: { "base/kustomization.yaml": BASE, "base/d.yaml": dep("api"), "overlay/kustomization.yaml": OV },
  ovns: { "base/kustomization.yaml": BASE, "base/d.yaml": dep("api"), "overlay/kustomization.yaml": `namespace: prod\n${OV}` },
  basens: { "base/kustomization.yaml": `namespace: a\n${BASE}`, "base/d.yaml": dep("api"), "overlay/kustomization.yaml": OV },
  basensGenns: { "base/kustomization.yaml": `namespace: a\n${BASE}`, "base/d.yaml": dep("api"), "overlay/kustomization.yaml": `resources: [ ../base ]\n${genIn("a")}` },
  basegen: { "base/kustomization.yaml": BASE + GEN, "base/d.yaml": dep("api"), "overlay/kustomization.yaml": OV },
  baseobj: { "base/kustomization.yaml": "resources: [ d.yaml, cm.yaml ]\n", "base/d.yaml": dep("api"), "base/cm.yaml": CM, "overlay/kustomization.yaml": OV },
  twobases: {
    "b1/kustomization.yaml": BASE, "b1/d.yaml": dep("one"), "b2/kustomization.yaml": BASE, "b2/d.yaml": dep("two"),
    "overlay/kustomization.yaml": `resources: [ ../b1, ../b2 ]\n${GEN}`,
  },
  ownfile: { "base/kustomization.yaml": BASE, "base/d.yaml": dep("api"), "overlay/own.yaml": dep("own"), "overlay/kustomization.yaml": `resources: [ ../base, own.yaml ]\n${GEN}` },
  objns: { "base/kustomization.yaml": BASE, "base/d.yaml": dep("api", { ns: "x" }), "overlay/kustomization.yaml": OV },
  objnsGenns: { "base/kustomization.yaml": BASE, "base/d.yaml": dep("api", { ns: "x" }), "overlay/kustomization.yaml": `resources: [ ../base ]\n${genIn("x")}` },
  ovnsGenns: { "base/kustomization.yaml": BASE, "base/d.yaml": dep("api"), "overlay/kustomization.yaml": `namespace: prod\nresources: [ ../base ]\n${genIn("other")}` },
  twice: { "base/kustomization.yaml": BASE, "base/d.yaml": dep("api"), "overlay/kustomization.yaml": `resources: [ ../base, ../base ]\n${GEN}` },
  secret: {
    "base/kustomization.yaml": BASE, "base/d.yaml": dep("api", { ref: "creds", kind: "secretRef" }),
    "overlay/kustomization.yaml": "resources: [ ../base ]\nsecretGenerator: [ { name: creds, literals: [ A=1 ] } ]\n",
  },
  ownobjElsewhere: {
    "base/kustomization.yaml": BASE, "base/d.yaml": dep("api"),
    "overlay/cm.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: app-config, namespace: other }\n",
    "overlay/kustomization.yaml": `resources: [ ../base, cm.yaml ]\n${GEN}`,
  },
  basensOvns: { "base/kustomization.yaml": `namespace: a\n${BASE}`, "base/d.yaml": dep("api"), "overlay/kustomization.yaml": `namespace: prod\n${OV}` },
  basesField: { "base/kustomization.yaml": BASE, "base/d.yaml": dep("api"), "overlay/kustomization.yaml": `bases: [ ../base ]\n${GEN}` },
  basegenOther: {
    "base/kustomization.yaml": `${BASE}configMapGenerator: [ { name: other, literals: [ B=2 ] } ]\n`, "base/d.yaml": dep("api"),
    "overlay/kustomization.yaml": OV,
  },
  // Kustomize refuses a base folder that holds the overlay ('cycle detected: candidate root ... contains visited root').
  ancestor: { "base/kustomization.yaml": BASE, "base/d.yaml": dep("api"), "base/overlay/kustomization.yaml": `resources: [ .. ]\n${GEN}` },
  grandparent: { "top/kustomization.yaml": BASE, "top/d.yaml": dep("api"), "top/mid/overlay/kustomization.yaml": `resources: [ ../.. ]\n${GEN}` },
  baseGenClash: {
    "b1/kustomization.yaml": `${BASE}configMapGenerator: [ { name: x, literals: [ A=1 ] } ]\n`, "b1/d.yaml": dep("one"),
    "b2/kustomization.yaml": `${BASE}configMapGenerator: [ { name: x, literals: [ B=2 ] } ]\n`, "b2/d.yaml": dep("two"),
    "overlay/kustomization.yaml": `resources: [ ../b1, ../b2 ]\n${GEN}`,
  },
  emptybaseOwn: { "base/kustomization.yaml": "resources: []\n", "overlay/d.yaml": dep("api"), "overlay/kustomization.yaml": `resources: [ ../base, d.yaml ]\n${GEN}` },
};

function caseLinks() {
  const files: Record<string, string> = {};
  for (const [c, fs] of Object.entries(CASES)) for (const [rel, text] of Object.entries(fs)) files[`${c}/${rel}`] = text;
  const { edges, skipped } = resolveFiles(files);
  return {
    links: edges.filter((e) => /#(configMap|secret)Generator:/.test(e.target) && !e.source.endsWith("#kustomization"))
      .map((e) => `${e.source} -> ${e.target}${e.confidence === "extracted" ? "" : ` ${e.confidence}`}`).sort(),
    reasons: skipped.map((s) => `${s.path}: ${s.reason}`),
  };
}

const to = (c: string, from: string, gen = "configMapGenerator:app-config") => `${c}/${from} -> ${c}/overlay/kustomization.yaml#${gen}`;

test("an overlay's generator links from the workloads its build renames, base and own, and from no other", () => {
  const { links, reasons } = caseLinks();
  assert.deepEqual(links, [
    // A base's own generator links in the base's build, as before.
    "basegen/base/d.yaml#Deployment/default/api -> basegen/base/kustomization.yaml#configMapGenerator:app-config",
    to("basensGenns", "base/d.yaml#Deployment/default/api"),
    to("basensOvns", "base/d.yaml#Deployment/default/api"),
    to("basegenOther", "base/d.yaml#Deployment/default/api"),
    to("basesField", "base/d.yaml#Deployment/default/api"),
    to("emptybaseOwn", "overlay/d.yaml#Deployment/default/api"),
    to("objnsGenns", "base/d.yaml#Deployment/x/api"),
    to("ovns", "base/d.yaml#Deployment/default/api"),
    to("ovnsGenns", "base/d.yaml#Deployment/default/api"),
    to("ownfile", "base/d.yaml#Deployment/default/api"),
    to("ownfile", "overlay/own.yaml#Deployment/default/own"),
    to("ownobjElsewhere", "base/d.yaml#Deployment/default/api"),
    to("plain", "base/d.yaml#Deployment/default/api"),
    to("secret", "base/d.yaml#Deployment/default/api", "secretGenerator:creds"),
    to("twobases", "b1/d.yaml#Deployment/default/one"),
    to("twobases", "b2/d.yaml#Deployment/default/two"),
  ].sort());
  // Kustomize refuses a generator whose name the build already holds; the overlay says why it links nothing.
  for (const c of ["basegen", "baseobj"]) {
    assert.ok(reasons.includes(`${c}/overlay/kustomization.yaml: ConfigMap app-config is 2 objects in this build: not linked to its generator`), `${c}\n${reasons.join("\n")}`);
  }
  // A clash between 2 bases' generators fails the overlay's build too, though each base builds on its own.
  assert.ok(reasons.includes("baseGenClash/overlay/kustomization.yaml: ConfigMap x is 2 objects in this build: not linked to its generator"), reasons.join("\n"));
  for (const k of ["ancestor/base/overlay", "grandparent/top/mid/overlay"]) {
    assert.ok(reasons.includes(`${k}/kustomization.yaml: configMapGenerator not applied to references, which link objects as written`), `${k}\n${reasons.join("\n")}`);
  }
  // Outside this transform (a base listed twice): the generator stays unapplied. Prefixes and suffixes: deploy-kustomize-prefix.test.ts.
  for (const c of ["twice"]) {
    assert.ok(reasons.includes(`${c}/overlay/kustomization.yaml: configMapGenerator not applied to references, which link objects as written`), `${c}\n${reasons.join("\n")}`);
  }
  for (const c of ["plain", "ownfile", "twobases", "basens", "objns"]) {
    assert.ok(!reasons.some((r) => r.startsWith(`${c}/overlay/`) && r.includes("configMapGenerator")), `${c}\n${reasons.join("\n")}`);
  }
});

test("on disk, trail build links a base workload to its overlay's generator", async () => {
  await withBuild(CASES.ownfile, ({ graph }) => {
    const links = refs(graph).filter((r) => r.includes("Generator:") && !r.includes("#kustomization ->"));
    assert.deepEqual(links, [
      "base/d.yaml#Deployment/default/api -> overlay/kustomization.yaml#configMapGenerator:app-config",
      "overlay/own.yaml#Deployment/default/own -> overlay/kustomization.yaml#configMapGenerator:app-config",
    ]);
  });
});
