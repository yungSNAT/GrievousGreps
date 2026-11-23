/**
 * Kustomize in the deploy graph. A kustomization file gives a node linked to the objects in
 * the files it lists, the kustomizations in the folders it lists (`resources`, `bases`,
 * `components`) and the objects its patches change, and a name-only node for each generated
 * ConfigMap or Secret that the workloads it builds link to. An `images` rename links each
 * workload it builds to the compose service that builds the new name (`inferred`), and
 * `namespace`, `namePrefix` and `nameSuffix` decide where and under what name the objects it
 * builds are deployed: objects are matched where they are deployed. Every include or patch not followed (remote, outside the
 * repository, missing, a cycle, a label selector) is reported with the file, never dropped.
 * No generator value and no patch value is kept: only kinds and names.
 */
import { posix } from "node:path";
import { parseAllDocuments, type Document } from "yaml";
import type { NodeV1 } from "./types.js";
import {
  Skip, isObj, js, list, obj, resource, str, strict,
  type DeployRef, type KustomizePatch, type KustomizeRef, type Lines,
} from "./deploy.js";

/** Fields that add objects or change names or selectors, which the graph does not follow: each present one is reported. */
const UNREAD = ["helmCharts", "helmChartInflationGenerator", "generators", "transformers", "replacements", "vars", "crds", "configurations", "commonLabels", "labels"];

const GENERATORS = [["configMapGenerator", "ConfigMap"], ["secretGenerator", "Secret"]] as const;

/** The kinds and names an inline patch's documents give (a JSON 6902 patch gives none), or `invalid` when its YAML does not parse. */
function inlinePatch(text: string): Pick<KustomizePatch, "objects" | "invalid"> {
  const objects: NonNullable<KustomizePatch["objects"]> = [];
  try {
    for (const d of parseAllDocuments(text, { uniqueKeys: false, logLevel: "error" })) {
      if (d.errors.length) return { invalid: true };
      const v = d.toJS();
      const meta = isObj(v) ? v.metadata : undefined;
      if (!(isObj(v) && typeof v.kind === "string" && isObj(meta) && typeof meta.name === "string")) continue;
      objects.push({
        kind: v.kind, name: meta.name,
        ...(typeof meta.namespace === "string" ? { namespace: meta.namespace } : {}),
        ...(typeof v.apiVersion === "string" ? { apiVersion: v.apiVersion } : {}),
      });
    }
  } catch {
    return { invalid: true }; // too many aliases
  }
  return { objects };
}

export function kustomize(rel: string, docs: Document[], lines: Lines): { nodes: NodeV1[]; refs: DeployRef[] } {
  if (docs.length !== 1) throw new Skip("a kustomization is one YAML document");
  const d = docs[0];
  const top = obj(js(d), "the file");
  const kind = str(top.kind, "kind") ?? "Kustomization";
  if (kind !== "Kustomization" && kind !== "Component") throw new Skip(`kind ${kind} is not Kustomization or Component`);
  const dir = posix.dirname(rel);
  const from = `${rel}#kustomization`;
  const entries = (["resources", "bases", "components"] as const).flatMap((field) =>
    list(top[field], field).map((x) => ({ field, path: strict(x, `${field} entry`) })));
  const target = (t: unknown, what: string): KustomizePatch["target"] => {
    if (t === undefined || t === null) return undefined;
    const o = obj(t, what);
    const out: NonNullable<KustomizePatch["target"]> = {};
    // An empty field selects anything, as one left out does.
    for (const key of ["kind", "name", "namespace", "group", "version"] as const) {
      const v = str(o[key], `${what}.${key}`);
      if (v) out[key] = v;
    }
    if (o.labelSelector != null || o.annotationSelector != null) out.selector = true;
    return out;
  };
  const patches: KustomizePatch[] = [];
  for (const field of ["patches", "patchesJson6902"] as const) {
    for (const p of list(top[field], field)) {
      const o = obj(p, `${field} entry`);
      const path = str(o.path, `${field} path`);
      if (o.patch !== undefined && o.patch !== null && typeof o.patch !== "string") throw new Skip(`${field} patch is not a string`);
      const t = target(o.target, `${field} target`);
      patches.push({ ...(path ? { path } : {}), ...(typeof o.patch === "string" ? inlinePatch(o.patch) : {}), ...(t ? { target: t } : {}) });
    }
  }
  for (const p of list(top.patchesStrategicMerge, "patchesStrategicMerge")) {
    if (typeof p !== "string") throw new Skip("patchesStrategicMerge entry is not a string");
    // An entry is a file path, or the patch itself written inline.
    patches.push(/[\n{]/.test(p) ? inlinePatch(p) : { path: p });
  }
  const images = list(top.images, "images").flatMap((x) => {
    const o = obj(x, "images entry");
    const name = strict(o.name, "images name");
    const newName = str(o.newName, "images newName");
    return newName ? [{ name, newName }] : [];
  });
  const nodes: NodeV1[] = [];
  const refs: DeployRef[] = [];
  const generators: KustomizeRef["generators"] = [];
  const generated = new Set<string>();
  for (const [field, genKind] of GENERATORS) {
    list(top[field], field).forEach((x, i) => {
      // Only the name and namespace: literals, env files and file contents are never read.
      const o = obj(x, `${field} entry`);
      const name = strict(o.name, `${field} name`);
      const namespace = str(o.namespace, `${field} namespace`);
      const id = `${rel}#${field}:${name}`;
      if (generated.has(id)) return;
      generated.add(id);
      generators.push({ kind: genKind, name, id, ...(namespace ? { namespace } : {}) });
      nodes.push(resource(rel, `${field}:${name}`, name, lines(d, d.getIn([field, i], true)), `${genKind} ${name} (generated)`, [name]));
      refs.push({ from, to: "id", id });
    });
  }
  const prefix = str(top.namePrefix, "namePrefix") ?? "";
  const suffix = str(top.nameSuffix, "nameSuffix") ?? "";
  const namespace = str(top.namespace, "namespace");
  const words = [dir, prefix, suffix, namespace ?? "", ...generators.map((g) => g.name)].filter(Boolean);
  nodes.unshift(resource(rel, "kustomization", dir, lines(d, d.contents), `${kind} ${dir}`, words));
  const unread = UNREAD.filter((f) => top[f] !== undefined && top[f] !== null);
  refs.push({ from, to: "kustomize", dir, component: kind === "Component", entries, patches, prefix, suffix, ...(namespace ? { namespace } : {}), images, generators, unread });
  return { nodes, refs };
}
