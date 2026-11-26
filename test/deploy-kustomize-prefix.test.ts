/**
 * Kustomize generators across one build level with `namePrefix` and `nameSuffix` (`src/graph/kustomize.ts`, `buildOf`):
 * a prefix or suffix on the overlay or its leaf bases changes no link, as `kustomize build` matches a reference by the
 * names as written before it renames; a clash counts under a leaf object's renamed name as well. Each case's expectation is what
 * `kustomize build` v5.8.3 on the case's overlay folder renames.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFiles } from "./deploy-kustomize-fixtures.js";

const dep = (name: string, { ref = "app-config", kind = "configMapRef" }: { ref?: string; kind?: string } = {}) =>
  `apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: ${name} }\n`
  + `spec: { template: { metadata: { labels: { app: ${name} } }, spec: { containers: [ { name: c, image: ${name}, envFrom: [ { ${kind}: { name: ${ref} } } ] } ] } } }\n`;
const GEN = "configMapGenerator: [ { name: app-config, literals: [ A=1 ] } ]\n";
const BASE = "resources: [ d.yaml ]\n";
const OV = `resources: [ ../base ]\n${GEN}`;
const CM = "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: app-config }\n";
const B = { "base/kustomization.yaml": BASE, "base/d.yaml": dep("api") };
const prefixed = (prefix: string, extra = "") => ({ "base/kustomization.yaml": `${prefix}${BASE}${extra}`, "base/d.yaml": dep("api") });

/** Each case's files, under the case's folder; the oracle's case letter is in the name. */
const CASES: Record<string, Record<string, string>> = {
  aOvPrefix: { ...B, "overlay/kustomization.yaml": `namePrefix: p-\n${OV}` },
  bBasePrefix: { ...prefixed("namePrefix: b-\n"), "overlay/kustomization.yaml": OV },
  cOvSuffix: { ...B, "overlay/kustomization.yaml": `nameSuffix: -s\n${OV}` },
  dBaseSuffix: { ...prefixed("nameSuffix: -s\n"), "overlay/kustomization.yaml": OV },
  eBothPrefix: { ...prefixed("namePrefix: b-\n"), "overlay/kustomization.yaml": `namePrefix: p-\n${OV}` },
  fOvPrefixOwnFile: { ...B, "overlay/own.yaml": dep("own"), "overlay/kustomization.yaml": `namePrefix: p-\nresources: [ ../base, own.yaml ]\n${GEN}` },
  // Kustomize refuses both: 'merging from generator ... id ... ConfigMap ... app-config'.
  gBasePrefixBaseCm: {
    "base/kustomization.yaml": "namePrefix: b-\nresources: [ d.yaml, cm.yaml ]\n", "base/d.yaml": dep("api"), "base/cm.yaml": CM,
    "overlay/kustomization.yaml": OV,
  },
  hBasePrefixBaseGen: { ...prefixed("namePrefix: b-\n", GEN), "overlay/kustomization.yaml": OV },
  jTwoBasesPrefixes: {
    "b1/kustomization.yaml": `namePrefix: one-\n${BASE}`, "b1/d.yaml": dep("one"), "b2/kustomization.yaml": `namePrefix: two-\n${BASE}`, "b2/d.yaml": dep("two"),
    "overlay/kustomization.yaml": `resources: [ ../b1, ../b2 ]\n${GEN}`,
  },
  kOvPrefixNs: { ...B, "overlay/kustomization.yaml": `namespace: prod\nnamePrefix: p-\n${OV}` },
  mOvPrefixSecret: {
    "base/kustomization.yaml": BASE, "base/d.yaml": dep("api", { ref: "creds", kind: "secretRef" }),
    "overlay/kustomization.yaml": "namePrefix: p-\nresources: [ ../base ]\nsecretGenerator: [ { name: creds, literals: [ A=1 ] } ]\n",
  },
  // A reference spelled with the base's prefix names nothing the overlay generates: Kustomize leaves it as written.
  nRefPrefixed: { "base/kustomization.yaml": `namePrefix: b-\n${BASE}`, "base/d.yaml": dep("api", { ref: "b-app-config" }), "overlay/kustomization.yaml": OV },
  // Kustomize builds this and links both (one-api, two-api); the graph holds both as `api`, so it refuses the build.
  oSameNamePrefixes: {
    "b1/kustomization.yaml": `namePrefix: one-\n${BASE}`, "b1/d.yaml": dep("api"), "b2/kustomization.yaml": `namePrefix: two-\n${BASE}`, "b2/d.yaml": dep("api"),
    "overlay/kustomization.yaml": `resources: [ ../b1, ../b2 ]\n${GEN}`,
  },
};

const to = (c: string, from: string, gen = "configMapGenerator:app-config") => `${c}/${from} -> ${c}/overlay/kustomization.yaml#${gen}`;

test("a name prefix or suffix on an overlay or its leaves changes no generator link", () => {
  const files: Record<string, string> = {};
  for (const [c, fs] of Object.entries(CASES)) for (const [rel, text] of Object.entries(fs)) files[`${c}/${rel}`] = text;
  const { edges, skipped } = resolveFiles(files);
  const links = edges.filter((e) => /#(configMap|secret)Generator:/.test(e.target) && !e.source.endsWith("#kustomization"))
    .map((e) => `${e.source} -> ${e.target}${e.confidence === "extracted" ? "" : ` ${e.confidence}`}`).sort();
  const reasons = skipped.map((s) => `${s.path}: ${s.reason}`);
  assert.deepEqual(links, [
    to("aOvPrefix", "base/d.yaml#Deployment/default/api"),
    to("bBasePrefix", "base/d.yaml#Deployment/default/api"),
    to("cOvSuffix", "base/d.yaml#Deployment/default/api"),
    to("dBaseSuffix", "base/d.yaml#Deployment/default/api"),
    to("eBothPrefix", "base/d.yaml#Deployment/default/api"),
    to("fOvPrefixOwnFile", "base/d.yaml#Deployment/default/api"),
    to("fOvPrefixOwnFile", "overlay/own.yaml#Deployment/default/own"),
    // The base's own generator links in the base's build, as before.
    "hBasePrefixBaseGen/base/d.yaml#Deployment/default/api -> hBasePrefixBaseGen/base/kustomization.yaml#configMapGenerator:app-config",
    to("jTwoBasesPrefixes", "b1/d.yaml#Deployment/default/one"),
    to("jTwoBasesPrefixes", "b2/d.yaml#Deployment/default/two"),
    to("kOvPrefixNs", "base/d.yaml#Deployment/default/api"),
    to("mOvPrefixSecret", "base/d.yaml#Deployment/default/api", "secretGenerator:creds"),
  ].sort());
  for (const c of ["gBasePrefixBaseCm", "hBasePrefixBaseGen"]) {
    assert.ok(reasons.includes(`${c}/overlay/kustomization.yaml: ConfigMap app-config is 2 objects in this build: not linked to its generator`), `${c}\n${reasons.join("\n")}`);
  }
  assert.ok(reasons.includes("oSameNamePrefixes/overlay/kustomization.yaml: configMapGenerator not applied to references, which link objects as written"), reasons.join("\n"));
});

const cm = (name: string) => `apiVersion: v1\nkind: ConfigMap\nmetadata: { name: ${name} }\n`;
const gen = (name: string) => `configMapGenerator: [ { name: ${name}, literals: [ A=1 ] } ]\n`;
/** Kustomize v5.8.3 refuses each overlay: a clash counts under a leaf object's renamed name as well as its written one. */
const RENAMED_CLASHES: Record<string, Record<string, string>> = {
  // 'merging from generator ... Name:"b-x" exists'
  p1: {
    "base/kustomization.yaml": "namePrefix: b-\nresources: [ cm.yaml ]\n", "base/cm.yaml": cm("x"),
    "overlay/own.yaml": dep("own", { ref: "b-x" }), "overlay/kustomization.yaml": `resources: [ ../base, own.yaml ]\n${gen("b-x")}`,
  },
  p3: {
    "base/kustomization.yaml": "nameSuffix: -s\nresources: [ cm.yaml ]\n", "base/cm.yaml": cm("app"),
    "overlay/own.yaml": dep("own", { ref: "app-s" }), "overlay/kustomization.yaml": `resources: [ ../base, own.yaml ]\n${gen("app-s")}`,
  },
  p4: {
    "b1/kustomization.yaml": "namePrefix: one-\nresources: [ cm.yaml ]\n", "b1/cm.yaml": cm("x"),
    "b2/kustomization.yaml": BASE, "b2/d.yaml": dep("two", { ref: "one-x" }),
    "overlay/kustomization.yaml": `resources: [ ../b1, ../b2 ]\n${gen("one-x")}`,
  },
  p5: {
    "base/kustomization.yaml": `namePrefix: b-\n${BASE}${gen("g")}`, "base/d.yaml": dep("api", { ref: "g" }),
    "overlay/own.yaml": dep("own", { ref: "b-g" }), "overlay/kustomization.yaml": `resources: [ ../base, own.yaml ]\n${gen("b-g")}`,
  },
  // 'may not add resource with an already registered id'
  q1: {
    "b1/kustomization.yaml": "namePrefix: one-\nresources: [ cm.yaml ]\n", "b1/cm.yaml": cm("x"),
    "b2/kustomization.yaml": "resources: [ cm.yaml, d.yaml ]\n", "b2/cm.yaml": cm("one-x"), "b2/d.yaml": dep("two"),
    "overlay/kustomization.yaml": `resources: [ ../b1, ../b2 ]\n${GEN}`,
  },
  q2: {
    "base/kustomization.yaml": `namePrefix: b-\n${BASE}`, "base/d.yaml": dep("api"),
    "overlay/own.yaml": dep("b-api"), "overlay/kustomization.yaml": `resources: [ ../base, own.yaml ]\n${GEN}`,
  },
};

test("a leaf object's renamed name clashes as Kustomize counts it, so the overlay links nothing", () => {
  const files: Record<string, string> = {};
  for (const [c, fs] of Object.entries(RENAMED_CLASHES)) for (const [rel, text] of Object.entries(fs)) files[`${c}/${rel}`] = text;
  const { edges } = resolveFiles(files);
  const links = edges.filter((e) => /#(configMap|secret)Generator:/.test(e.target) && !e.source.endsWith("#kustomization"))
    .map((e) => `${e.source} -> ${e.target}`).sort();
  // The base's own generator still links in the base's own build, as in case h.
  assert.deepEqual(links, ["p5/base/d.yaml#Deployment/default/api -> p5/base/kustomization.yaml#configMapGenerator:g"]);
});
