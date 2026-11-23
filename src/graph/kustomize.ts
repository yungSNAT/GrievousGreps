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
import type { EdgeV1, NodeV1 } from "./types.js";
import { compileGlob, globMatches } from "./deploy-glob.js";
import {
  KUSTOMIZATION_FILES, Skip, imageRepo, isObj, js, list, obj, pushTo, reasonText, resource, str, strict, under,
  type DeployRef, type KustomizePatch, type KustomizeRef, type Lines,
} from "./deploy.js";

/** Objects every kustomization's build may list in total, the characters of their built names, and match steps for patches, generators and images. */
const MAX_MEMBERS = 200_000;
const MAX_NAME_CHARS = 20_000_000;
const MAX_STEPS = 2_000_000;
/** Reports kept for one kustomization file before a count of the rest. */
const MAX_REPORTS = 20;

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

// ── Resolution ──────────────────────────────────────────────────────────────

/** A namespace and name a built object has had, and the one it had before (the last is the object as written). */
interface Id {
  ns: string;
  name: string;
  prev?: Id;
}

/** An object a kustomization builds: its namespace and name after this kustomization's transforms, and those before them. */
interface Member {
  id: string;
  kind: string;
  apiVersion: string;
  cur: { ns: string; name: string };
  /** The namespace and name as written. */
  orig: { ns: string; name: string };
  before: Id;
  /** Ids in `before`. */
  depth: number;
  /** A generator's ConfigMap or Secret: in patches and generator links only. */
  generated: boolean;
}

type Labels = Extract<DeployRef, { to: "labels" }>;

interface Context {
  nodes: NodeV1[];
  refs: DeployRef[];
  fileExists: (path: string) => boolean;
  objects: Map<string, string[]>;
  labels: Map<string, Labels[]>;
  built: Map<string, string[]>;
  add: (source: string, target: string, confidence?: EdgeV1["confidence"]) => void;
  skipped: { path: string; reason: string }[];
}

/**
 * The objects a reference or selector may name: those deployed in a namespace the referring
 * object is deployed in. An object a kustomization builds is deployed where each
 * kustomization that builds it puts it, under the name it gives; any other object is
 * deployed as written. So two objects meet only where both are deployed.
 */
export interface DeployedView {
  objects(from: string, kind: string, ns: string, name: string): string[];
  labels(from: string, ns: string): Labels[];
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

/** Whether Kustomize's `images` entry `name` selects `image`: the same name, then at most a tag and a digest. */
function imageMatches(image: string, name: string): boolean {
  return image.startsWith(name) && /^(:[A-Za-z0-9_.{}-]*)?(@[A-Za-z0-9+._-]+(:[A-Za-z0-9=_-]+)?)?$/.test(image.slice(name.length));
}

/** Whether any id a member had before this kustomization's transforms passes `test`. */
function anyId(m: Member, test: (id: Id) => boolean): boolean {
  for (let id: Id | undefined = m.before; id; id = id.prev) if (test(id)) return true;
  return false;
}

export function linkKustomize(ctx: Context): DeployedView {
  const asWritten: DeployedView = {
    objects: (_from, kind, ns, name) => ctx.objects.get(`${kind}/${ns}/${name}`) ?? [],
    labels: (_from, ns) => ctx.labels.get(ns) ?? [],
  };
  const all = ctx.refs.filter((r): r is KustomizeRef => r.to === "kustomize").sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  if (!all.length) return asWritten;
  const fileOf = (k: KustomizeRef) => k.from.slice(0, -"#kustomization".length);
  const reports = new Map<KustomizeRef, number>();
  const reported = new Set<string>();
  const report = (k: KustomizeRef, reason: string) => {
    // A report repeated for one kustomization (a component under several parents, an include listed twice) is kept once.
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
  // A file used only as a patch is not an object of the cluster: drop it from the object and selector lookups, in one pass.
  const listed = new Set<string>();
  for (const k of ks) for (const e of k.entries) listed.add(under(k.dir, e.path) ?? "");
  const dropped = new Set<string>();
  for (const k of ks) {
    for (const p of k.patches) {
      const local = p.path === undefined ? null : under(k.dir, p.path);
      if (local === null || listed.has(local)) continue;
      listed.add(local);
      for (const n of objectsIn.get(local) ?? []) dropped.add(n.id);
    }
  }
  if (dropped.size) {
    for (const [key, ids] of ctx.objects) if (ids.some((id) => dropped.has(id))) ctx.objects.set(key, ids.filter((id) => !dropped.has(id)));
    for (const [ns, ls] of ctx.labels) if (ls.some((l) => dropped.has(l.from))) ctx.labels.set(ns, ls.filter((l) => !dropped.has(l.from)));
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
  const apiVersions = new Map<string, string>();
  const refsFrom = new Map<string, DeployRef[]>();
  for (const r of ctx.refs) {
    if (r.to === "api") apiVersions.set(r.from, r.apiVersion);
    else if (r.to === "object" || r.to === "image" || r.to === "labels") pushTo(refsFrom, r.from, r);
  }
  const members = buildMembers(ks, kids, files, apiVersions, report);
  // A component's own namespace and name transforms change only its own objects here, not its parent's.
  for (const k of ks) {
    const fields = [k.namespace ? "namespace" : "", k.prefix ? "namePrefix" : "", k.suffix ? "nameSuffix" : ""].filter(Boolean);
    if (k.component && fields.length) report(k, `component ${fields.join(", ")} not followed for the objects of the kustomizations that list it`);
  }
  // Where each built object is deployed: a kustomization no other kustomization includes is a build of its own.
  const included = new Set<KustomizeRef>();
  for (const k of ks) for (const kid of kids.get(k) ?? []) included.add(kid);
  /** Each built object's builds: the root kustomization and the namespace it is deployed to there. */
  const placedAt = new Map<string, Array<{ root: KustomizeRef; ns: string }>>();
  const deployedObjects = new Map<string, string[]>();
  const deployedLabels = new Map<string, Labels[]>();
  /** Per root: the objects it builds by kind, namespace and each name a reference may use (as written, or as built). */
  const byName = new Map<KustomizeRef, Map<string, string[]>>();
  const placed = new Set<string>();
  for (const root of ks) {
    if (root.component || included.has(root)) continue;
    const names = new Map<string, string[]>();
    byName.set(root, names);
    for (const m of members.get(root) ?? []) {
      if (m.generated) continue;
      const key = `${m.kind}/${m.cur.ns}/${m.cur.name}`;
      pushTo(names, `${m.kind}\0${m.cur.ns}\0${m.cur.name}`, m.id);
      if (m.orig.name !== m.cur.name) pushTo(names, `${m.kind}\0${m.cur.ns}\0${m.orig.name}`, m.id);
      pushTo(placedAt, m.id, { root, ns: m.cur.ns });
      if (placed.has(`${m.id}\0${key}`)) continue;
      placed.add(`${m.id}\0${key}`);
      pushTo(deployedObjects, key, m.id);
      for (const r of refsFrom.get(m.id) ?? []) if (r.to === "labels") pushTo(deployedLabels, m.cur.ns, { ...r, ns: m.cur.ns });
    }
  }
  let steps = 0;
  const step = (k: KustomizeRef, n: number) => {
    steps += n;
    // Pushed directly, so the per-file report cap cannot hide it.
    if (steps > MAX_STEPS) ctx.skipped.push({ path: fileOf(k), reason: `name, patch, generator and image links omitted from here on after ${MAX_STEPS} match steps` });
    return steps <= MAX_STEPS;
  };
  /**
   * The kustomizations whose objects a component's patches and images change: through
   * components that list components, the first that are not; with the steps taken.
   */
  const scopes = (k: KustomizeRef): [KustomizeRef[], number] => {
    if (!k.component || !parents.has(k)) return [[k], 1];
    const out = new Set<KustomizeRef>();
    const seen = new Set<KustomizeRef>([k]);
    const todo = [...parents.get(k)!];
    let n = 0;
    while (todo.length) {
      const p = todo.pop()!;
      n++;
      if (seen.has(p)) continue;
      seen.add(p);
      if (!p.component || !parents.has(p)) out.add(p);
      else for (const q of parents.get(p)!) todo.push(q);
    }
    return [[...out], n];
  };
  linking: for (const k of ks) {
    const built = members.get(k) ?? [];
    let refCount = 0;
    let genIds = 0;
    for (const m of built) {
      if (m.generated) genIds += m.depth + 1;
      else refCount += refsFrom.get(m.id)?.length ?? 0;
    }
    if (!step(k, built.length + refCount + genIds + 1)) break;
    // A workload links to the generated ConfigMaps and Secrets it names in the namespace it is built into.
    const generated = new Map<string, string[]>();
    for (const g of built) {
      if (!g.generated) continue;
      pushTo(generated, `${g.kind}\0${g.cur.ns}\0${g.cur.name}`, g.id);
      for (let id: Id | undefined = g.before; id; id = id.prev) pushTo(generated, `${g.kind}\0${g.cur.ns}\0${id.name}`, g.id);
    }
    for (const m of built) {
      if (m.generated) continue;
      for (const r of refsFrom.get(m.id) ?? []) {
        const gs = r.to === "object" ? generated.get(`${r.kind}\0${m.cur.ns}\0${r.name}`) : undefined;
        if (!gs) continue;
        if (!step(k, gs.length)) break linking;
        for (const g of gs) ctx.add(m.id, g);
      }
    }
    // A component's patches and images change the objects of each kustomization that lists it.
    const [into, walked] = scopes(k);
    if (!step(k, walked)) break;
    for (const scope of into) {
      const objs = members.get(scope) ?? [];
      if (k.images.length) {
        let imageRefs = 0;
        for (const m of objs) if (!m.generated) imageRefs += refsFrom.get(m.id)?.length ?? 0;
        if (!step(k, imageRefs * k.images.length)) break linking;
        for (const m of objs) {
          if (m.generated) continue;
          const renamed = new Set<string>();
          for (const r of refsFrom.get(m.id) ?? []) {
            if (r.to !== "image" || r.built) continue;
            for (const i of k.images) if (imageMatches(r.image, i.name)) renamed.add(imageRepo(i.newName));
          }
          for (const name of renamed) {
            const builders = ctx.built.get(name) ?? [];
            if (!step(k, builders.length)) break linking;
            for (const b of builders) ctx.add(m.id, b, "inferred");
          }
        }
      }
      for (const p of k.patches) {
        if (!patch(k, p, objs, { objectsIn, report, step, ctx, apiVersions })) break linking;
      }
    }
  }
  for (const [k, n] of reports) if (n > MAX_REPORTS) ctx.skipped.push({ path: fileOf(k), reason: `and ${n - MAX_REPORTS} more reports` });
  // An object is deployed as built where a kustomization builds it, else as written.
  const asBuilt = (id: string) => placedAt.has(id);
  return {
    objects(from, kind, ns, name) {
      const where: Array<{ root?: KustomizeRef; ns: string }> = placedAt.get(from) ?? [{ ns }];
      return where.flatMap(({ root, ns: d }) => [
        // Kustomize renames a reference to an object of the same build to that object's built name.
        ...((root && byName.get(root)?.get(`${kind}\0${d}\0${name}`)) ?? []),
        ...(deployedObjects.get(`${kind}/${d}/${name}`) ?? []),
        ...(ctx.objects.get(`${kind}/${d}/${name}`) ?? []).filter((id) => !asBuilt(id)),
      ]);
    },
    labels(from, ns) {
      return [...new Set((placedAt.get(from) ?? [{ ns }]).map((w) => w.ns))].flatMap((d) => [
        ...(deployedLabels.get(d) ?? []),
        ...(ctx.labels.get(d) ?? []).filter((l) => !asBuilt(l.from)),
      ]);
    },
  };
}

/** Each kustomization's objects, children first; a cycle or a size bound is reported. */
function buildMembers(ks: KustomizeRef[], kids: Map<KustomizeRef, KustomizeRef[]>, files: Map<KustomizeRef, NodeV1[]>,
  apiVersions: Map<string, string>, report: (k: KustomizeRef, reason: string) => void): Map<KustomizeRef, Member[]> {
  const members = new Map<KustomizeRef, Member[]>();
  const open = new Set<KustomizeRef>();
  /** Includes that close a cycle, left out of the build. */
  const cut = new Map<KustomizeRef, Set<KustomizeRef>>();
  let total = 0;
  let chars = 0;
  const finish = (k: KustomizeRef) => {
    const out: Member[] = [];
    let full = "";
    const push = (m: Member) => {
      if (++total > MAX_MEMBERS) full = `${MAX_MEMBERS} built objects`;
      else if ((chars += m.cur.name.length) > MAX_NAME_CHARS) full = `${MAX_NAME_CHARS} characters of built names`;
      else out.push(m);
      return !full;
    };
    const cur = (id: { ns: string; name: string }) => ({ ns: k.namespace ?? id.ns, name: `${k.prefix}${id.name}${k.suffix}` });
    for (const n of files.get(k) ?? []) {
      const [, kind, ns, name] = OBJECT_ID.exec(n.id.slice(n.path.length + 1))!;
      const before = { ns, name };
      if (!push({ id: n.id, kind, apiVersion: apiVersions.get(n.id) ?? "", cur: cur(before), orig: before, before, depth: 1, generated: false })) break;
    }
    for (const g of full ? [] : k.generators) {
      const before = { ns: g.namespace ?? "default", name: g.name };
      if (!push({ id: g.id, kind: g.kind, apiVersion: "v1", cur: cur(before), orig: before, before, depth: 1, generated: true })) break;
    }
    const left = cut.get(k);
    for (const kid of full ? [] : kids.get(k) ?? []) {
      if (left?.has(kid)) continue;
      for (const m of members.get(kid) ?? []) {
        // The kid's result is the newest id this kustomization's patches see; it adds one only when the kid changed it.
        const same = m.cur.ns === m.before.ns && m.cur.name === m.before.name;
        const before = same ? m.before : { ...m.cur, prev: m.before };
        const changed = (k.namespace !== undefined && k.namespace !== m.cur.ns) || k.prefix !== "" || k.suffix !== "";
        if (!push({ ...m, cur: changed ? cur(m.cur) : m.cur, before, depth: same ? m.depth : m.depth + 1 })) break;
      }
      if (full) break;
    }
    if (full) report(k, `name, patch and generator links omitted after ${full}`);
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
          const c = cut.get(top.k) ?? new Set<KustomizeRef>();
          cut.set(top.k, c.add(kid));
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

interface PatchContext {
  objectsIn: Map<string, NodeV1[]>;
  report: (k: KustomizeRef, reason: string) => void;
  step: (k: KustomizeRef, n: number) => boolean;
  ctx: Context;
  apiVersions: Map<string, string>;
}

/** Each patch target's field matchers, compiled once however many kustomizations list its component. */
const matchers = new WeakMap<object, Array<((name: string) => boolean) | null>>();

const groupOf = (apiVersion: string) => (apiVersion.includes("/") ? apiVersion.slice(0, apiVersion.lastIndexOf("/")) : "");
const versionOf = (apiVersion: string) => apiVersion.slice(apiVersion.lastIndexOf("/") + 1);

/**
 * Link a kustomization to the objects one patch changes, and the patch's objects to them.
 * A patch sees each object by the namespaces and names it had before the transforms of the
 * kustomization whose objects it changes. With a target, every patch object links to every object the target selects
 * (Kustomize ignores the patch's own name then); without one, each patch object links to
 * the objects of its kind, name and namespace (`default` when it gives none). False once the
 * step bound is reached.
 */
function patch(k: KustomizeRef, p: KustomizePatch, built: Member[], pc: PatchContext): boolean {
  const { objectsIn, report, step, ctx, apiVersions } = pc;
  const label = `patch ${p.path ? shown(p.path) : "inline"}`;
  if (p.invalid) {
    report(k, `${label} is not valid YAML: not followed`);
    return true;
  }
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
  const ownIds = new Set(own.map((n) => n.id));
  const link = (from: string[], matches: Member[]) => {
    for (const m of matches) {
      if (ownIds.has(m.id)) continue;
      ctx.add(k.from, m.id);
      for (const id of from) ctx.add(id, m.id);
    }
  };
  const ids = built.reduce((n, m) => n + m.depth, 0);
  if (p.target) {
    // Every target field is a regular expression in Kustomize, matched whole.
    const t = p.target;
    let compiled = matchers.get(t);
    if (!compiled) matchers.set(t, (compiled = [t.kind, t.name, t.namespace, t.group, t.version].map(namePattern)));
    const [kind, name, namespace, group, version] = compiled;
    if (t.selector || !kind || !name || !namespace || !group || !version) {
      report(k, `${label} target ${t.selector ? "selects by label or annotation" : "uses a regular expression"}: not followed`);
      return true;
    }
    if (!step(k, built.length + ids + 1)) return false;
    // Kustomize selects by the name as written or as it is now, and separately by the namespace as written or as it is now.
    const matches = built.filter((m) => kind(m.kind) && group(groupOf(m.apiVersion)) && version(versionOf(m.apiVersion))
      && (name(m.orig.name) || name(m.before.name)) && (namespace(m.orig.ns) || namespace(m.before.ns)));
    if (!matches.some((m) => !ownIds.has(m.id))) report(k, `${label} matched no object this kustomization builds`);
    if (!step(k, own.length * matches.length + 1)) return false;
    link(own.map((n) => n.id), matches);
    return true;
  }
  const wanted = [
    ...own.map((n) => {
      const [, kind, ns, name] = OBJECT_ID.exec(n.id.slice(n.path.length + 1))!;
      return { id: n.id as string | undefined, kind, name, ns, apiVersion: apiVersions.get(n.id) };
    }),
    ...(p.objects ?? []).map((o) => ({ id: undefined, kind: o.kind, name: o.name, ns: o.namespace ?? "default", apiVersion: o.apiVersion })),
  ];
  if (!wanted.length) {
    report(k, `${label} names no object and has no target`);
    return true;
  }
  if (!step(k, wanted.length * (built.length + ids + 1))) return false;
  for (const w of wanted) {
    // Kustomize compares group, version and kind, and any namespace and name the object has had.
    const sameApi = (m: Member) => w.apiVersion === undefined || m.apiVersion === "" || m.apiVersion === w.apiVersion;
    const matches = built.filter((m) => w.kind === m.kind && sameApi(m) && anyId(m, (id) => id.name === w.name && id.ns === w.ns));
    if (!matches.some((m) => !ownIds.has(m.id))) report(k, `${label} ${w.kind} ${w.name} matched no object this kustomization builds`);
    link(w.id ? [w.id] : [], matches);
  }
  return true;
}
