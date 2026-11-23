/**
 * Kustomize in the deploy graph: structure only. A kustomization file gives a node linked to
 * the objects in the files it lists, the kustomizations in the folders it lists (`resources`,
 * `bases`, `components`), the objects in the patch files it lists, and a name-only node for
 * each generated ConfigMap or Secret. Names are not resolved: `namespace`, `namePrefix`,
 * `nameSuffix`, `images`, generator names and patches are not applied to references, which
 * link objects as written; each kustomization using them says so in a report. Every include
 * or patch not followed (remote, outside the repository, missing, a cycle) is reported with
 * the file, never dropped. No generator value and no patch value is kept.
 */
import { posix } from "node:path";
import type { Document } from "yaml";
import type { EdgeV1, NodeV1 } from "./types.js";
import {
  KUSTOMIZATION_FILES, Skip, js, list, obj, pushTo, reasonText, resource, str, strict, under,
  type DeployRef, type KustomizeRef, type Lines,
} from "./deploy.js";

/** Fields that add objects or change names or selectors, which the graph does not follow: each present one is reported. */
const UNREAD = ["helmCharts", "helmChartInflationGenerator", "generators", "transformers", "replacements", "vars", "crds", "configurations", "commonLabels", "labels"];

/** Fields whose names, namespaces or changes are not applied to references: each present one is reported. */
const UNAPPLIED = ["namespace", "namePrefix", "nameSuffix", "images", "configMapGenerator", "secretGenerator", "patches", "patchesJson6902", "patchesStrategicMerge"];

const GENERATORS = [["configMapGenerator", "ConfigMap"], ["secretGenerator", "Secret"]] as const;

/** Edges from kustomizations in total, and reports kept for one kustomization file before a count of the rest. */
const MAX_LINKS = 2_000_000;
const MAX_REPORTS = 20;

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
  const patches: string[] = [];
  for (const field of ["patches", "patchesJson6902"] as const) {
    for (const p of list(top[field], field)) {
      const path = str(obj(p, `${field} entry`).path, `${field} path`);
      if (path) patches.push(path);
    }
  }
  for (const p of list(top.patchesStrategicMerge, "patchesStrategicMerge")) {
    if (typeof p !== "string") throw new Skip("patchesStrategicMerge entry is not a string");
    // An entry is a file path, or the patch itself written inline.
    if (!/[\n{]/.test(p)) patches.push(p);
  }
  const nodes: NodeV1[] = [];
  const refs: DeployRef[] = [];
  const names = new Set<string>();
  for (const [field, genKind] of GENERATORS) {
    list(top[field], field).forEach((x, i) => {
      // Only the name: literals, env files and file contents are never read.
      const name = strict(obj(x, `${field} entry`).name, `${field} name`);
      const id = `${rel}#${field}:${name}`;
      if (names.has(`${field}:${name}`)) return;
      names.add(`${field}:${name}`);
      nodes.push(resource(rel, `${field}:${name}`, name, lines(d, d.getIn([field, i], true)), `${genKind} ${name} (generated)`, [name]));
      refs.push({ from, to: "id", id });
    });
  }
  const words = [dir, str(top.namePrefix, "namePrefix"), str(top.nameSuffix, "nameSuffix"), str(top.namespace, "namespace"), ...[...names].map((n) => n.slice(n.indexOf(":") + 1))];
  nodes.unshift(resource(rel, "kustomization", dir, lines(d, d.contents), `${kind} ${dir}`, words.filter((w): w is string => !!w)));
  const present = (f: string) => top[f] !== undefined && top[f] !== null;
  refs.push({ from, to: "kustomize", dir, entries, patches, unread: UNREAD.filter(present), unapplied: UNAPPLIED.filter(present) });
  return { nodes, refs };
}

interface Context {
  nodes: NodeV1[];
  refs: DeployRef[];
  fileExists: (path: string) => boolean;
  add: (source: string, target: string, confidence?: EdgeV1["confidence"]) => void;
  skipped: { path: string; reason: string }[];
}

const OBJECT_ID = /^([A-Za-z]+)\/([^/]+)\/(.+)$/;

/** An include as written, for a report: user information and every query parameter but `ref` and `version` removed. */
function shown(p: string): string {
  const q = p.indexOf("?");
  const base = (q < 0 ? p : p.slice(0, q)).replace(/^((?:[a-z][a-z0-9+.-]*:)?\/\/)?[^/@\s]+@/i, "$1");
  const kept = q < 0 ? [] : p.slice(q + 1).split("&").filter((x) => /^(ref|version)=/.test(x));
  return kept.length ? `${base}?${kept.join("&")}` : base;
}

/** Why a path a kustomization names cannot be followed, or null when it is in the repository. */
function outside(p: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /^[^/@\s]+@/.test(p) || /\?(ref|version|depth|timeout|submodules)=/.test(p)) return "remote";
  // A go-getter address names its host first: `github.com/org/repo/path`.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(p)) return "remote";
  return null;
}

/** Link each kustomization to what it lists, and report what is not followed. */
export function linkKustomize(ctx: Context): void {
  const all = ctx.refs.filter((r): r is KustomizeRef => r.to === "kustomize").sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  if (!all.length) return;
  const fileOf = (k: KustomizeRef) => k.from.slice(0, -"#kustomization".length);
  const reports = new Map<KustomizeRef, number>();
  const reported = new Set<string>();
  const report = (k: KustomizeRef, reason: string) => {
    // A report repeated for one kustomization is kept once.
    if (reported.has(`${k.from}\0${reason}`)) return;
    reported.add(`${k.from}\0${reason}`);
    const n = (reports.get(k) ?? 0) + 1;
    reports.set(k, n);
    if (n <= MAX_REPORTS) ctx.skipped.push({ path: fileOf(k), reason: reasonText(reason) });
  };
  // Kustomize refuses a folder holding more than one kustomization file, read or not.
  const perDir = new Map<string, KustomizeRef[]>();
  for (const k of all) pushTo(perDir, k.dir, k);
  const refused = new Set<string>();
  for (const [dir, here] of perDir) {
    const read = new Set(here.map(fileOf));
    const present = KUSTOMIZATION_FILES.map((f) => (dir === "." ? f : `${dir}/${f}`)).filter((f) => read.has(f) || ctx.fileExists(f));
    if (here.length > 1 || present.length > 1) refused.add(dir);
  }
  for (const k of all) if (refused.has(k.dir)) report(k, "not read: Kustomize refuses a folder with more than one kustomization file");
  const ks = all.filter((k) => !refused.has(k.dir));
  const byDir = new Map(ks.map((k) => [k.dir, k]));
  for (const k of ks) {
    if (k.unread.length) report(k, `fields not read: ${k.unread.join(", ")}`);
    if (k.unapplied.length) report(k, `not applied to references, which link objects as written: ${k.unapplied.join(", ")}`);
  }
  const objectsIn = new Map<string, NodeV1[]>();
  for (const n of ctx.nodes) {
    if (n.kind === "resource" && n.origin === "deploy" && OBJECT_ID.test(n.id.slice(n.path.length + 1))) pushTo(objectsIn, n.path, n);
  }
  /** Each path's local target: a kustomization folder, objects in a file, or a report. A local path wins over a remote reading. */
  const follow = (k: KustomizeRef, field: string, p: string): KustomizeRef | NodeV1[] | null => {
    const local = under(k.dir, p);
    const target = local === null ? undefined : byDir.get(local) ?? objectsIn.get(local);
    if (target) return target;
    if (local !== null && refused.has(local)) report(k, `${field} ${shown(p)} not read: its folder has more than one kustomization file`);
    else if (local !== null && ctx.fileExists(local)) report(k, `${field} ${shown(p)} gave no Kubernetes objects`);
    else if (local === null || outside(p)) report(k, `${field} ${shown(p)} not followed: ${outside(p) ? "remote" : "outside the repository"}`);
    else report(k, `${field} ${shown(p)} not found`);
    return null;
  };
  let links = 0;
  const link = (k: KustomizeRef, targets: string[]) => {
    links += targets.length;
    if (links > MAX_LINKS) {
      // Pushed directly, so the per-file report cap cannot hide it.
      ctx.skipped.push({ path: fileOf(k), reason: `Kustomize links omitted from here on after ${MAX_LINKS}` });
      return false;
    }
    for (const t of targets) ctx.add(k.from, t);
    return true;
  };
  const kids = new Map<KustomizeRef, KustomizeRef[]>();
  linking: for (const k of ks) {
    const own: KustomizeRef[] = [];
    kids.set(k, own);
    const seen = new Set<KustomizeRef | NodeV1[]>();
    for (const e of k.entries) {
      const t = follow(k, e.field, e.path);
      if (!t) continue;
      if (seen.has(t)) {
        report(k, `${e.field} ${shown(e.path)} listed more than once: followed once`);
        continue;
      }
      seen.add(t);
      if (Array.isArray(t)) {
        if (!link(k, t.map((n) => n.id))) break linking;
      } else {
        own.push(t);
        if (!link(k, [t.from])) break linking;
      }
    }
    for (const p of k.patches) {
      const local = under(k.dir, p);
      const objs = local === null ? undefined : objectsIn.get(local);
      if (objs) {
        if (!link(k, objs.map((n) => n.id))) break linking;
      } else if (local === null || outside(p)) report(k, `patch ${shown(p)} not followed: ${outside(p) ? "remote" : "outside the repository"}`);
      else if (!ctx.fileExists(local)) report(k, `patch ${shown(p)} not found`);
    }
  }
  reportCycles(ks, kids, report);
  for (const [k, n] of reports) if (n > MAX_REPORTS) ctx.skipped.push({ path: fileOf(k), reason: `and ${n - MAX_REPORTS} more reports` });
}

/** Report each include that leads back to the kustomization listing it; depth first without recursion, so a long chain cannot exhaust the stack. */
function reportCycles(ks: KustomizeRef[], kids: Map<KustomizeRef, KustomizeRef[]>, report: (k: KustomizeRef, reason: string) => void): void {
  const done = new Set<KustomizeRef>();
  const open = new Set<KustomizeRef>();
  for (const root of ks) {
    if (done.has(root)) continue;
    const stack: Array<{ k: KustomizeRef; i: number }> = [{ k: root, i: 0 }];
    open.add(root);
    while (stack.length) {
      const top = stack.at(-1)!;
      const list = kids.get(top.k) ?? [];
      if (top.i < list.length) {
        const kid = list[top.i++];
        if (open.has(kid)) report(top.k, `cycle: ${top.k.dir} includes ${kid.dir}, which leads back to it`);
        else if (!done.has(kid)) {
          open.add(kid);
          stack.push({ k: kid, i: 0 });
        }
        continue;
      }
      done.add(top.k);
      open.delete(top.k);
      stack.pop();
    }
  }
}
