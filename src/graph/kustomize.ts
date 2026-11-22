/**
 * Kustomize in the deploy graph. A kustomization file gives a node linked to the objects in
 * the files it lists, the kustomizations in the folders it lists (`resources`, `bases`,
 * `components`) and the objects its patches change, and a name-only node for each generated
 * ConfigMap or Secret that the workloads it builds link to. An `images` rename links each
 * workload it builds to the compose service that builds the new name (`inferred`), and
 * `namespace`, `namePrefix` and `nameSuffix` give the objects it builds their deployed names
 * as further lookup keys. Every include or patch not followed (remote, outside the
 * repository, missing, a cycle, a label selector) is reported with the file, never dropped.
 * No generator value and no patch value is kept: only kinds and names.
 */
import { posix } from "node:path";
import { parseAllDocuments, type Document } from "yaml";
import type { EdgeV1, NodeV1 } from "./types.js";
import { compileGlob, globMatches } from "./deploy-glob.js";
import {
  Skip, imageRepo, isObj, js, list, obj, pushTo, reasonText, resource, str, strict, under,
  type DeployRef, type KustomizePatch, type KustomizeRef, type Lines,
} from "./deploy.js";

/** Objects every kustomization's build may list in total, and match steps for patches, generators and images. */
const MAX_MEMBERS = 200_000;
const MAX_STEPS = 2_000_000;
/** Reports kept for one kustomization file before a count of the rest. */
const MAX_REPORTS = 20;

/** Fields that add objects or change names or selectors, which the graph does not follow: each present one is reported. */
const UNREAD = ["helmCharts", "helmChartInflationGenerator", "generators", "transformers", "replacements", "vars", "crds", "configurations", "commonLabels", "labels"];

const GENERATORS = [["configMapGenerator", "ConfigMap"], ["secretGenerator", "Secret"]] as const;

/** The kinds and names an inline patch's documents give; a JSON 6902 patch or bad YAML gives none. */
function patchObjects(text: string): NonNullable<KustomizePatch["objects"]> {
  const out: NonNullable<KustomizePatch["objects"]> = [];
  try {
    for (const d of parseAllDocuments(text, { uniqueKeys: false, logLevel: "error" })) {
      if (d.errors.length) continue;
      const v = d.toJS();
      const meta = isObj(v) ? v.metadata : undefined;
      if (!(isObj(v) && typeof v.kind === "string" && isObj(meta) && typeof meta.name === "string")) continue;
      out.push({ kind: v.kind, name: meta.name, ...(typeof meta.namespace === "string" ? { namespace: meta.namespace } : {}) });
    }
  } catch {
    // too many aliases: no names
  }
  return out;
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
    for (const key of ["kind", "name", "namespace"] as const) {
      const v = str(o[key], `${what}.${key}`);
      if (v !== undefined) out[key] = v;
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
      patches.push({ ...(path ? { path } : {}), ...(typeof o.patch === "string" ? { objects: patchObjects(o.patch) } : {}), ...(t ? { target: t } : {}) });
    }
  }
  for (const p of list(top.patchesStrategicMerge, "patchesStrategicMerge")) {
    if (typeof p !== "string") throw new Skip("patchesStrategicMerge entry is not a string");
    // An entry is a file path, or the patch itself written inline.
    patches.push(/[\n{]/.test(p) ? { objects: patchObjects(p) } : { path: p });
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
  for (const [field, genKind] of GENERATORS) {
    list(top[field], field).forEach((x, i) => {
      // Only the name: literals, env files and file contents are never read.
      const name = strict(obj(x, `${field} entry`).name, `${field} name`);
      const id = `${rel}#${field}:${name}`;
      if (generators.some((g) => g.id === id)) return;
      generators.push({ kind: genKind, name, id });
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

// ── Resolution ──────────────────────────────────────────────────────────────

/** An object a kustomization builds, with the transforms from it down to the object's file. */
interface Member {
  id: string;
  kind: string;
  ns: string;
  name: string;
  prefix: string;
  suffix: string;
  namespace?: string;
}

interface Context {
  nodes: NodeV1[];
  refs: DeployRef[];
  fileExists: (path: string) => boolean;
  objects: Map<string, string[]>;
  labels: Map<string, Array<Extract<DeployRef, { to: "labels" }>>>;
  built: Map<string, string[]>;
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

/**
 * An anchored Kustomize name pattern made of name characters, `.` and `.*`, as a glob
 * matcher; null for any other regular expression, which is then reported, not run.
 */
function namePattern(pattern: string | undefined): ((name: string) => boolean) | null {
  if (pattern === undefined) return () => true;
  if (!/^(?:[A-Za-z0-9_-]|\.\*?)*$/.test(pattern)) return null;
  const glob = compileGlob(pattern.replace(/\.(\*?)/g, (_, star: string) => (star ? "*" : "?")));
  return glob ? (name) => !name.includes("/") && globMatches(glob, name) : null;
}

export function linkKustomize(ctx: Context): void {
  const all = ctx.refs.filter((r): r is KustomizeRef => r.to === "kustomize").sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  if (!all.length) return;
  const fileOf = (k: KustomizeRef) => k.from.slice(0, -"#kustomization".length);
  const reports = new Map<KustomizeRef, number>();
  const report = (k: KustomizeRef, reason: string) => {
    const n = (reports.get(k) ?? 0) + 1;
    reports.set(k, n);
    if (n <= MAX_REPORTS) ctx.skipped.push({ path: fileOf(k), reason: reasonText(reason) });
  };
  // Kustomize refuses a folder holding more than one kustomization file.
  const perDir = new Map<string, KustomizeRef[]>();
  for (const k of all) pushTo(perDir, k.dir, k);
  const ks = all.filter((k) => perDir.get(k.dir)!.length === 1);
  const refused = new Set(all.filter((k) => perDir.get(k.dir)!.length > 1).map((k) => k.dir));
  for (const k of all) if (perDir.get(k.dir)!.length > 1) report(k, "not read: Kustomize refuses a folder with more than one kustomization file");
  const byDir = new Map(ks.map((k) => [k.dir, k]));
  for (const k of ks) if (k.unread.length) report(k, `fields not read: ${k.unread.join(", ")}`);
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
  // A file used only as a patch is not an object of the cluster: drop it from the object and selector lookups.
  const listed = new Set<string>();
  for (const k of ks) for (const e of k.entries) listed.add(under(k.dir, e.path) ?? "");
  for (const k of ks) {
    for (const p of k.patches) {
      const local = p.path === undefined ? null : under(k.dir, p.path);
      if (local === null || listed.has(local)) continue;
      listed.add(local);
      for (const n of objectsIn.get(local) ?? []) unlist(n, ctx);
    }
  }
  const kids = new Map<KustomizeRef, KustomizeRef[]>();
  const files = new Map<KustomizeRef, NodeV1[]>();
  const parents = new Map<KustomizeRef, KustomizeRef[]>();
  for (const k of ks) {
    const own: KustomizeRef[] = [];
    const objs: NodeV1[] = [];
    for (const e of k.entries) {
      const t = follow(k, e.field, e.path);
      if (!t) continue;
      if (Array.isArray(t)) {
        for (const n of t) objs.push(n);
        for (const n of t) ctx.add(k.from, n.id);
      } else {
        own.push(t);
        ctx.add(k.from, t.from);
        if (e.field === "components") pushTo(parents, t, k);
      }
    }
    kids.set(k, own);
    files.set(k, objs);
  }
  const members = buildMembers(ks, kids, files, report);
  let steps = 0;
  const step = (k: KustomizeRef, n: number) => {
    steps += n;
    // Pushed directly, so the per-file report cap cannot hide it.
    if (steps > MAX_STEPS) ctx.skipped.push({ path: fileOf(k), reason: `name, patch, generator and image links omitted from here on after ${MAX_STEPS} match steps` });
    return steps <= MAX_STEPS;
  };
  const refsFrom = new Map<string, DeployRef[]>();
  for (const r of ctx.refs) if (r.to === "object" || r.to === "image" || r.to === "labels") pushTo(refsFrom, r.from, r);
  const aliased = new Set<string>();
  linking: for (const k of ks) {
    const built = members.get(k) ?? [];
    aliases(built, refsFrom, aliased, ctx);
    if (!step(k, built.length * (k.generators.length + k.images.length + 1))) break;
    for (const m of built) {
      for (const r of refsFrom.get(m.id) ?? []) {
        if (r.to === "object") {
          for (const g of k.generators) if (g.kind === r.kind && g.name === r.name) ctx.add(m.id, g.id);
        } else if (r.to === "image" && !r.built) {
          for (const i of k.images) {
            if (imageRepo(r.image) !== imageRepo(i.name)) continue;
            for (const b of ctx.built.get(imageRepo(i.newName)) ?? []) ctx.add(m.id, b, "inferred");
          }
        }
      }
    }
    // A component's patches change the objects of each kustomization that lists it.
    const scopes = k.component && parents.has(k) ? parents.get(k)! : [k];
    for (const scope of scopes) {
      for (const p of k.patches) {
        if (!patch(k, scope, p, members.get(scope) ?? [], { objectsIn, report, step, ctx })) break linking;
      }
    }
  }
  for (const [k, n] of reports) if (n > MAX_REPORTS) ctx.skipped.push({ path: fileOf(k), reason: `and ${n - MAX_REPORTS} more reports` });
}

/** Remove a patch file's object from the object and selector lookups. */
function unlist(n: NodeV1, ctx: Context): void {
  const local = n.id.slice(n.path.length + 1);
  const ids = ctx.objects.get(local);
  if (ids) ctx.objects.set(local, ids.filter((id) => id !== n.id));
  const ns = OBJECT_ID.exec(local)![2];
  const labels = ctx.labels.get(ns);
  if (labels) ctx.labels.set(ns, labels.filter((l) => l.from !== n.id));
}

/** Each kustomization's objects, children first; a cycle or the size bound is reported. */
function buildMembers(ks: KustomizeRef[], kids: Map<KustomizeRef, KustomizeRef[]>, files: Map<KustomizeRef, NodeV1[]>,
  report: (k: KustomizeRef, reason: string) => void): Map<KustomizeRef, Member[]> {
  const members = new Map<KustomizeRef, Member[]>();
  const open = new Set<KustomizeRef>();
  let total = 0;
  const finish = (k: KustomizeRef) => {
    const out: Member[] = [];
    const push = (m: Member) => {
      if (++total > MAX_MEMBERS) return false;
      out.push(m);
      return true;
    };
    let full = false;
    for (const n of files.get(k) ?? []) {
      const [, kind, ns, name] = OBJECT_ID.exec(n.id.slice(n.path.length + 1))!;
      if ((full = !push({ id: n.id, kind, ns, name, prefix: k.prefix, suffix: k.suffix, ...(k.namespace ? { namespace: k.namespace } : {}) }))) break;
    }
    for (const kid of full ? [] : kids.get(k) ?? []) {
      for (const m of members.get(kid) ?? []) {
        const namespace = k.namespace ?? m.namespace;
        if ((full = !push({ ...m, prefix: k.prefix + m.prefix, suffix: m.suffix + k.suffix, ...(namespace ? { namespace } : {}) }))) break;
      }
      if (full) break;
    }
    if (full) report(k, `name, patch and generator links omitted after ${MAX_MEMBERS} built objects`);
    members.set(k, out);
  };
  // Depth first without recursion, so a long chain of kustomizations cannot exhaust the stack.
  for (const root of ks) {
    if (members.has(root)) continue;
    const stack: Array<{ k: KustomizeRef; i: number }> = [{ k: root, i: 0 }];
    open.add(root);
    while (stack.length) {
      const top = stack.at(-1)!;
      const list = kids.get(top.k) ?? [];
      if (top.i < list.length) {
        const kid = list[top.i++];
        if (open.has(kid)) {
          report(top.k, `cycle: ${top.k.dir} includes ${kid.dir}, which leads back to it`);
          list.splice(--top.i, 1);
        } else if (!members.has(kid)) {
          open.add(kid);
          stack.push({ k: kid, i: 0 });
        }
        continue;
      }
      finish(top.k);
      open.delete(top.k);
      stack.pop();
    }
  }
  return members;
}

/** Deployed names and namespaces as further keys for object and selector links. */
function aliases(built: Member[], refsFrom: Map<string, DeployRef[]>, aliased: Set<string>, ctx: Context): void {
  const once = (key: string) => !aliased.has(key) && Boolean(aliased.add(key));
  for (const m of built) {
    const ns = m.namespace ?? m.ns;
    const key = `${m.kind}/${ns}/${m.prefix}${m.name}${m.suffix}`;
    if (key !== `${m.kind}/${m.ns}/${m.name}` && once(`${key}\0${m.id}`)) pushTo(ctx.objects, key, m.id);
    if (ns === m.ns || !once(`labels\0${ns}\0${m.id}`)) continue;
    for (const r of refsFrom.get(m.id) ?? []) if (r.to === "labels") pushTo(ctx.labels, ns, { ...r, ns });
  }
}

interface PatchContext {
  objectsIn: Map<string, NodeV1[]>;
  report: (k: KustomizeRef, reason: string) => void;
  step: (k: KustomizeRef, n: number) => boolean;
  ctx: Context;
}

/**
 * Link a kustomization to the objects one patch changes, and the patch's objects to them:
 * with a target, every patch object to every object the target selects (Kustomize ignores
 * the patch's own name then); without one, each patch object to the objects of its kind,
 * name and namespace. False once the step bound is reached.
 */
function patch(k: KustomizeRef, scope: KustomizeRef, p: KustomizePatch, built: Member[], pc: PatchContext): boolean {
  const { objectsIn, report, step, ctx } = pc;
  const label = `patch ${p.path ? shown(p.path) : "inline"}`;
  let own: NodeV1[] = [];
  if (p.path) {
    const local = under(k.dir, p.path);
    if (local === null) {
      report(k, `${label} not followed: ${outside(p.path) ? "remote" : "outside the repository"}`);
      return true;
    }
    own = objectsIn.get(local) ?? [];
    // A JSON 6902 patch file holds operations, not objects: its target says what it changes.
    if (!own.length && !ctx.fileExists(local)) {
      report(k, `${label} ${outside(p.path) ? "not followed: remote" : "not found"}`);
      if (!p.target || outside(p.path)) return true;
    }
  }
  for (const n of own) ctx.add(k.from, n.id);
  /** The names a patch may use for a member: as written, as the kustomizations below this one leave it, and as deployed. */
  const names = (m: Member) => {
    const deployed = `${m.prefix}${m.name}${m.suffix}`;
    const below = deployed.startsWith(scope.prefix) && deployed.endsWith(scope.suffix)
      ? deployed.slice(scope.prefix.length, deployed.length - scope.suffix.length) : deployed;
    return [m.name, below, deployed];
  };
  const link = (from: string[], matches: Member[]) => {
    for (const m of matches) {
      if (from.includes(m.id)) continue;
      ctx.add(k.from, m.id);
      for (const id of from) ctx.add(id, m.id);
    }
  };
  if (p.target) {
    // Every target field is a regular expression in Kustomize; `group` and `version` are not compared (a superset).
    const t = p.target;
    const [kind, name, namespace] = [namePattern(t.kind), namePattern(t.name), namePattern(t.namespace)];
    if (t.selector || !kind || !name || !namespace) {
      report(k, `${label} target ${t.selector ? "selects by label or annotation" : "uses a regular expression"}: not followed`);
      return true;
    }
    if (!step(k, built.length * 3)) return false;
    const matches = built.filter((m) => kind(m.kind) && names(m).some(name) && [m.ns, m.namespace ?? m.ns].some(namespace));
    const ownIds = new Set(own.map((n) => n.id));
    if (!matches.some((m) => !ownIds.has(m.id))) report(k, `${label} matched no object this kustomization builds`);
    if (!step(k, own.length * matches.length)) return false;
    link(own.map((n) => n.id), matches);
    return true;
  }
  const wanted = [
    ...own.map((n) => {
      const [, kind, ns, name] = OBJECT_ID.exec(n.id.slice(n.path.length + 1))!;
      return { id: n.id as string | undefined, kind, name, namespace: ns as string | undefined };
    }),
    ...(p.objects ?? []).map((o) => ({ id: undefined, ...o })),
  ];
  if (!wanted.length) {
    report(k, `${label} names no object and has no target`);
    return true;
  }
  if (!step(k, built.length * wanted.length * 3)) return false;
  let matched = false;
  for (const w of wanted) {
    // An object written without a namespace is keyed `default`: it then matches any namespace.
    const anyNs = w.namespace === undefined || w.namespace === "default";
    const matches = built.filter((m) => w.kind === m.kind && names(m).includes(w.name) && (anyNs || [m.ns, m.namespace].includes(w.namespace)));
    matched ||= matches.some((m) => m.id !== w.id);
    link(w.id ? [w.id] : [], matches);
  }
  if (!matched) report(k, `${label} matched no object this kustomization builds`);
  return true;
}
