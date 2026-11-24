/**
 * Kustomize in the deploy graph: structure only. A kustomization file gives a node linked to
 * the objects in the files it lists, the kustomizations in the folders it lists (`resources`,
 * `bases`, `components`), the objects in the patch files it lists, and a name-only node for
 * each generated ConfigMap or Secret. In a leaf build (files only) a workload's reference also
 * links to the generator it names, as `kustomize build` renames it. Otherwise names are not
 * resolved: `namespace`, `namePrefix`, `nameSuffix`, `images`, generator names and patches are
 * not applied to references, which link objects as written; each kustomization using them says
 * so in a report. Every include
 * or patch not followed (remote, outside the repository, missing, a cycle) is reported with
 * the file, never dropped. No generator value and no patch value is kept.
 */
import { posix } from "node:path";
import { isScalar, type Document } from "yaml";
import type { EdgeV1, NodeV1 } from "./types.js";
import {
  KUSTOMIZATION_FILES, Skip, isObj, js, list, obj, pushTo, reasonText, resource, str, strict, under,
  type DeployRef, type KustomizeRef, type Lines, type Obj,
} from "./deploy.js";

/** Fields that add objects or change names or selectors, which the graph does not follow: each present one is reported. */
const UNREAD = ["helmCharts", "helmChartInflationGenerator", "generators", "transformers", "replacements", "vars", "crds", "configurations", "commonLabels", "labels"];

/** Fields whose names, namespaces or changes are not applied to references: each present one is reported. */
const UNAPPLIED = ["namespace", "namePrefix", "nameSuffix", "images", "configMapGenerator", "secretGenerator", "patches", "patchesJson6902", "patchesStrategicMerge"];

const GENERATORS = [["configMapGenerator", "ConfigMap"], ["secretGenerator", "Secret"]] as const;

/** Edges from kustomizations in total, and reports kept for one kustomization file before a count of the rest. */
const MAX_LINKS = 2_000_000;
const MAX_REPORTS = 20;

/**
 * The kustomization a file named like one holds: a single non-empty document, a mapping whose
 * `kind`, if any, is Kustomization or Component and whose `apiVersion`, if any, is Kustomize's.
 * Null for any other such file (Kubernetes objects, a Flux `Kustomization`, nothing), which is
 * read as a manifest candidate, as before.
 */
export function kustomizationIn(docs: Document[]): { d: Document; top: Obj } | null {
  // An empty document, as a trailing `---` gives, holds nothing.
  const full = docs.filter((x) => x.contents !== null && !(isScalar(x.contents) && x.contents.value === null));
  if (full.length !== 1) return null;
  const top = js(full[0]);
  if (!isObj(top)) return null;
  const { kind, apiVersion } = top;
  const ours = (kind === undefined || kind === "Kustomization" || kind === "Component")
    && (apiVersion === undefined || (typeof apiVersion === "string" && apiVersion.startsWith("kustomize.config.k8s.io/")));
  return ours ? { d: full[0], top } : null;
}

export function kustomize(rel: string, { d, top }: { d: Document; top: Obj }, lines: Lines): { nodes: NodeV1[]; refs: DeployRef[] } {
  const kind = top.kind === "Component" ? "Component" : "Kustomization";
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
    if (!/[\r\n\u0085\u2028\u2029{]/.test(p)) patches.push(p);
  }
  const nodes: NodeV1[] = [];
  const generators: string[] = [];
  const generated: KustomizeRef["generated"] = [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const [field, genKind] of GENERATORS) {
    const items = (d.get(field, true) as { items?: unknown[] } | undefined)?.items;
    list(top[field], field).forEach((x, i) => {
      // Only the name, namespace and behavior: literals, env files and file contents are never read.
      const entry = obj(x, `${field} entry`);
      const name = strict(entry.name, `${field} name`);
      const id = `${rel}#${field}:${name}`;
      const behavior = str(entry.behavior, `${field} behavior`);
      if (behavior !== "merge" && behavior !== "replace") generated.push({ id, kind: genKind, name, ns: str(entry.namespace, `${field} namespace`) ?? null });
      if (seen.has(id)) return;
      seen.add(id);
      generators.push(id);
      names.push(name);
      nodes.push(resource(rel, `${field}:${name}`, name, lines(d, items?.[i]), `${genKind} ${name} (generated)`, [name]));
    });
  }
  const namespace = str(top.namespace, "namespace") ?? null;
  const words = [dir, str(top.namePrefix, "namePrefix"), str(top.nameSuffix, "nameSuffix"), namespace, ...names];
  nodes.unshift(resource(rel, "kustomization", dir, lines(d, d.contents), `${kind} ${dir}`, words.filter((w): w is string => !!w)));
  const present = (f: string) => top[f] !== undefined && top[f] !== null;
  return { nodes, refs: [{
    from, to: "kustomize", dir, entries, patches, generators, generated, namespace, component: kind === "Component",
    unread: UNREAD.filter(present), unapplied: UNAPPLIED.filter(present),
  }] };
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
function shown(raw: string): string {
  const p = raw.replace(/^git::/i, "");
  const q = p.indexOf("?");
  const base = (q < 0 ? p : p.slice(0, q)).replace(/^((?:[a-z][a-z0-9+.-]*:)?\/\/)?[^/@\s]+@/i, "$1");
  const kept = q < 0 ? [] : p.slice(q + 1).split("&").filter((x) => /^(ref|version)=/.test(x));
  return kept.length ? `${base}?${kept.join("&")}` : base;
}

/** Whether a path a kustomization names is remote, may be (a first segment like a host name), or is in the repository (null). */
function outside(raw: string): "remote" | "host" | null {
  const p = raw.replace(/^git::/i, "");
  if (p !== raw || /^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /^[^/@\s]+@/.test(p) || /\?(ref|version|depth|timeout|submodules)=/.test(p)) return "remote";
  // A go-getter address names its host first: `github.com/org/repo/path`; so may a local folder such as `config.d/`.
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(p) ? "host" : null;
}

/** The repository path a kustomization's path names; null for a `git::` address, which Kustomize reads as remote, or a Windows drive path. */
const local_ = (dir: string, p: string) => (/^git::|^[a-z]:[\\/]/i.test(p) ? null : under(dir, p));

/** Why a path a kustomization names gave nothing to link. */
function missing(field: string, p: string, local: string | null, fileExists: (path: string) => boolean): string {
  const why = outside(p);
  if (local === null || why === "remote") return `${field} ${shown(p)} not followed: ${why === "remote" ? "remote" : "outside the repository"}`;
  if (KUSTOMIZATION_FILES.some((f) => fileExists(`${local}/${f}`))) return `${field} ${shown(p)} not read: no kustomization was read from its folder`;
  if (fileExists(local)) return `${field} ${shown(p)} gave no Kubernetes objects`;
  return `${field} ${shown(p)} not found${why !== "host" ? "" : field === "patch" ? ", or remote: not followed" : ", or a remote base: not followed"}`;
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
  const objectsIn = new Map<string, NodeV1[]>();
  for (const n of ctx.nodes) {
    if (n.kind === "resource" && n.origin === "deploy" && OBJECT_ID.test(n.id.slice(n.path.length + 1))) pushTo(objectsIn, n.path, n);
  }
  const leaves = new Map<KustomizeRef, NodeV1[]>();
  for (const k of ks) {
    const members = leafMembers(k, byDir, objectsIn);
    if (members) leaves.set(k, members);
    for (const f of k.unread) report(k, `${f} not read`);
    for (const f of k.unapplied) {
      if (!(members && GENERATORS.some(([g]) => g === f))) report(k, `${f} not applied to references, which link objects as written`);
    }
  }
  /** Each path's local target: a kustomization folder, objects in a file, or a report. A local path wins over a remote reading. */
  const follow = (k: KustomizeRef, field: string, p: string): KustomizeRef | NodeV1[] | null => {
    const local = local_(k.dir, p);
    const target = local === null ? undefined : byDir.get(local) ?? objectsIn.get(local);
    if (target) return target;
    if (local !== null && refused.has(local)) report(k, `${field} ${shown(p)} not read: its folder has more than one kustomization file`);
    else report(k, missing(field, p, local, ctx.fileExists));
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
      const local = local_(k.dir, p);
      const objs = local === null ? undefined : objectsIn.get(local);
      if (!objs) {
        // A patch file with no objects, such as a JSON 6902 op list, has nothing to link.
        if (local === null || !ctx.fileExists(local)) report(k, missing("patch", p, local, ctx.fileExists));
      } else if (seen.has(objs)) report(k, `patch ${shown(p)} listed more than once: followed once`);
      else {
        seen.add(objs);
        if (!link(k, objs.map((n) => n.id))) break linking;
      }
    }
    if (!link(k, k.generators)) break linking;
  }
  if (links <= MAX_LINKS) linkGenerated(ctx, leaves, report, () => ++links <= MAX_LINKS);
  reportCycles(ks, kids, report);
  for (const [k, n] of reports) if (n > MAX_REPORTS) ctx.skipped.push({ path: fileOf(k), reason: `and ${n - MAX_REPORTS} more reports` });
}

/**
 * The objects a leaf build holds, or null when it is not one. A leaf kustomization lists files only, each once and in or
 * below its folder (no folder, no component, nothing remote or missing), and has no patch and no field the graph does not read, so the objects in its
 * files and its generators are all its build holds, and no reference in them is rewritten by anything but its own
 * name transforms. It is the lowest build of each object it lists, where Kustomize renames references.
 */
function leafMembers(k: KustomizeRef, byDir: Map<string, KustomizeRef>, objectsIn: Map<string, NodeV1[]>): NodeV1[] | null {
  if (k.component || k.patches.length || k.unread.length || k.unapplied.some((f) => f.startsWith("patches"))) return null;
  const members: NodeV1[] = [];
  const seen = new Set<string>();
  for (const e of k.entries) {
    const local = local_(k.dir, e.path);
    // Kustomize refuses a file outside the kustomization's folder, and an object listed twice: no build, no rename.
    if (local === null || seen.has(local) || !(k.dir === "." || local.startsWith(`${k.dir}/`))) return null;
    const objs = byDir.has(local) ? undefined : objectsIn.get(local);
    if (!objs) return null;
    seen.add(local);
    members.push(...objs);
  }
  return members;
}

/**
 * Link each workload in a leaf build to the generator its ConfigMap or Secret reference names. Kustomize renames a
 * reference in the lowest build holding an object of that kind, name and namespace (no namespace reads as `default`,
 * and the kustomization's `namespace` replaces every object's), so the link is made only when that build holds exactly
 * one such object and it is generated. A generated name that the build holds more than once is reported, not linked.
 * Generator entries with `behavior: merge` or `replace` change an existing object and make none.
 */
function linkGenerated(ctx: Context, leaves: Map<KustomizeRef, NodeV1[]>, report: (k: KustomizeRef, reason: string) => void, charge: () => boolean): void {
  const wanted = new Map<string, Array<Extract<DeployRef, { to: "object" }>>>();
  for (const r of ctx.refs) if (r.to === "object" && GENERATORS.some(([, kind]) => kind === r.kind)) pushTo(wanted, r.from, r);
  for (const [k, members] of leaves) {
    if (!k.generated.length) continue;
    const ns = (n: string | null) => k.namespace ?? n ?? "default";
    const at = (kind: string, n: string, name: string) => `${kind}\0${n}\0${name}`;
    const held = new Map<string, { generated: string[]; written: number }>();
    const entry = (key: string) => held.get(key) ?? held.set(key, { generated: [], written: 0 }).get(key)!;
    for (const g of k.generated) entry(at(g.kind, ns(g.ns), g.name)).generated.push(g.id);
    for (const n of members) {
      const m = OBJECT_ID.exec(n.id.slice(n.path.length + 1));
      if (m && held.has(at(m[1], ns(m[2]), m[3]))) entry(at(m[1], ns(m[2]), m[3])).written++;
    }
    for (const n of members) {
      for (const r of wanted.get(n.id) ?? []) {
        const c = held.get(at(r.kind, ns(r.ns), r.name));
        if (!c) continue;
        if (c.generated.length > 1 || c.written > 0) {
          report(k, `${r.kind} ${r.name} is ${c.generated.length + c.written} objects in this build: not linked to its generator`);
        } else if (!charge()) {
          ctx.skipped.push({ path: k.from.slice(0, -"#kustomization".length), reason: `Kustomize links omitted from here on after ${MAX_LINKS}` });
          return;
        } else ctx.add(n.id, c.generated[0]);
      }
    }
  }
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
