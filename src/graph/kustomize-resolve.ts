/**
 * Kustomize resolution: what each kustomization builds, where its objects are deployed and
 * under what names, and what its patches, generators and images link to. Reading the files
 * is in `kustomize.ts`.
 */
import type { EdgeV1, NodeV1 } from "./types.js";
import { compileGlob, globMatches } from "./deploy-glob.js";
import {
  KUSTOMIZATION_FILES, imageRepo, pushTo, reasonText, under,
  type DeployRef, type KustomizePatch, type KustomizeRef,
} from "./deploy.js";

/** Objects every kustomization's build may list in total, the characters of their built names, and match steps for patches, generators and images. */
const MAX_MEMBERS = 200_000;
const MAX_NAME_CHARS = 20_000_000;
const MAX_STEPS = 2_000_000;
/** Reports kept for one kustomization file before a count of the rest. */
const MAX_REPORTS = 20;

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
  let steps = 0;
  const step = (k: KustomizeRef, n: number) => {
    steps += n;
    // Pushed directly, so the per-file report cap cannot hide it; once, by the step that passes the bound.
    if (steps > MAX_STEPS && steps - n <= MAX_STEPS) ctx.skipped.push({ path: fileOf(k), reason: `name, patch, generator and image links omitted from here on after ${MAX_STEPS} match steps` });
    return steps <= MAX_STEPS;
  };
  // Where each built object is deployed: a kustomization no other kustomization includes is a build of its own.
  const included = new Set<KustomizeRef>();
  for (const k of ks) for (const kid of kids.get(k) ?? []) included.add(kid);
  /** Each built object's builds: the root kustomization and the namespace it is deployed to there. */
  const placedAt = new Map<string, Array<{ root: KustomizeRef; ns: string }>>();
  const deployedObjects = new Map<string, string[]>();
  const deployedLabels = new Map<string, Labels[]>();
  /** Per root: the objects it builds by kind, namespace and each name a reference may use (as written, as built, or any name between). */
  const byName = new Map<KustomizeRef, Map<string, Set<string>>>();
  // An object a build reaches many ways (a diamond of includes) is recorded once per root, namespace and built name.
  const seen = new Set<string>();
  const once = (key: string) => !seen.has(key) && !!seen.add(key);
  for (const root of ks) {
    if (root.component || included.has(root)) continue;
    const built = members.get(root) ?? [];
    let walk = 0;
    for (const m of built) walk += m.depth + (refsFrom.get(m.id)?.length ?? 0) + 1;
    if (!step(root, walk)) {
      report(root, `objects of this and later builds not linked after ${MAX_STEPS} match steps`);
      break;
    }
    const names = new Map<string, Set<string>>();
    byName.set(root, names);
    for (const m of built) {
      if (m.generated) continue;
      const key = `${m.kind}/${m.cur.ns}/${m.cur.name}`;
      if (!once(`n\0${m.id}\0${root.from}\0${key}`)) continue;
      const known = new Set([m.cur.name]);
      for (let id: Id | undefined = m.before; id; id = id.prev) known.add(id.name);
      for (const n of known) {
        const ids = names.get(`${m.kind}\0${m.cur.ns}\0${n}`);
        if (ids) ids.add(m.id);
        else names.set(`${m.kind}\0${m.cur.ns}\0${n}`, new Set([m.id]));
      }
      if (once(`p\0${m.id}\0${root.from}\0${m.cur.ns}`)) pushTo(placedAt, m.id, { root, ns: m.cur.ns });
      if (once(`d\0${m.id}\0${key}`)) pushTo(deployedObjects, key, m.id);
      if (once(`l\0${m.id}\0${m.cur.ns}`)) for (const r of refsFrom.get(m.id) ?? []) if (r.to === "labels") pushTo(deployedLabels, m.cur.ns, { ...r, ns: m.cur.ns });
    }
    // Inside a build a reference links only when it names one object; Kustomize narrows a tie by where each was built, which is not read here.
    for (const m of built) {
      if (m.generated) continue;
      for (const r of refsFrom.get(m.id) ?? []) {
        if (r.to !== "object") continue;
        const n = names.get(`${r.kind}\0${m.cur.ns}\0${r.name}`)?.size ?? 0;
        if (n > 1) report(root, `ambiguous name ${r.kind} ${r.name}, not linked: ${n} objects`);
      }
    }
  }
  // Past the bound, and in a component no kustomization includes, objects a kustomization lists but no build placed are deployed nowhere.
  const unplaced = (k: KustomizeRef) => {
    for (const m of members.get(k) ?? []) if (!placedAt.has(m.id)) placedAt.set(m.id, []);
  };
  for (const k of ks) {
    if (k.component && !included.has(k)) {
      report(k, "component included by no kustomization: its objects are not linked");
      unplaced(k);
    } else if (steps > MAX_STEPS) unplaced(k);
  }
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
  const linkedTo = new Set<string>();
  const tied = new Map<string, { k: KustomizeRef; kind: string; name: string; n: number }>();
  const earlier = (m: Member) => {
    const out: string[] = [];
    for (let id: Id | undefined = m.before; id; id = id.prev) out.push(id.name);
    return out;
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
    const generated = new Map<string, Set<string>>();
    for (const g of built) {
      if (!g.generated) continue;
      for (const name of [g.cur.name, ...earlier(g)]) {
        const at = generated.get(`${g.kind}\0${g.cur.ns}\0${name}`);
        if (at) at.add(g.id);
        else generated.set(`${g.kind}\0${g.cur.ns}\0${name}`, new Set([g.id]));
      }
    }
    for (const m of built) {
      if (m.generated) continue;
      for (const r of refsFrom.get(m.id) ?? []) {
        if (r.to !== "object") continue;
        const gs = generated.get(`${r.kind}\0${m.cur.ns}\0${r.name}`);
        if (!gs) continue;
        if (!step(k, gs.size)) break linking;
        // Kustomize renames the reference in the lowest build that holds the object, so a single candidate in any build is the one meant.
        const key = `${m.id}\0${r.kind}\0${r.name}`;
        if (gs.size === 1) {
          for (const g of gs) ctx.add(m.id, g);
          linkedTo.add(key);
        } else if (!tied.has(key)) tied.set(key, { k, kind: r.kind, name: r.name, n: gs.size });
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
  for (const [key, t] of tied) if (!linkedTo.has(key)) report(t.k, `ambiguous name ${t.kind} ${t.name}, not linked: ${t.n} objects`);
  for (const [k, n] of reports) if (n > MAX_REPORTS) ctx.skipped.push({ path: fileOf(k), reason: `and ${n - MAX_REPORTS} more reports` });
  // An object is deployed as built where a kustomization builds it, else as written.
  const asBuilt = (id: string) => placedAt.has(id);
  let lookups = 0;
  /** Charges a lookup over built objects; past the bound such lookups give nothing, reported once. */
  const charge = (from: string, n: number) => {
    lookups += n;
    if (lookups > MAX_STEPS && lookups - n <= MAX_STEPS) ctx.skipped.push({ path: from.slice(0, from.indexOf("#")), reason: `object links omitted from here on after ${MAX_STEPS} lookups` });
    return lookups <= MAX_STEPS;
  };
  const deployed = (from: string, kind: string, d: string, name: string, out: Set<string>) => {
    const built = deployedObjects.get(`${kind}/${d}/${name}`) ?? [];
    if (built.length && !charge(from, built.length)) return false;
    for (const id of built) out.add(id);
    for (const id of ctx.objects.get(`${kind}/${d}/${name}`) ?? []) if (!asBuilt(id)) out.add(id);
    return true;
  };
  return {
    objects(from, kind, ns, name) {
      const out = new Set<string>();
      const where = placedAt.get(from);
      if (!where) return deployed(from, kind, ns, name, out) ? [...out] : [];
      if (!charge(from, where.length)) return [];
      for (const { root, ns: d } of where) {
        // Kustomize renames a reference to an object of the same build to that object's built name; 2 or more such objects were reported.
        const same = byName.get(root)?.get(`${kind}\0${d}\0${name}`);
        if (same) {
          if (same.size === 1) for (const id of same) out.add(id);
        } else if (!deployed(from, kind, d, name, out)) return [];
      }
      return [...out];
    },
    labels(from, ns) {
      const where = placedAt.get(from);
      const out: Labels[] = [];
      for (const d of where ? new Set(where.map((w) => w.ns)) : [ns]) {
        const built = deployedLabels.get(d) ?? [];
        if (built.length && !charge(from, built.length)) return [];
        for (const l of built) out.push(l);
        for (const l of ctx.labels.get(d) ?? []) if (!asBuilt(l.from)) out.push(l);
      }
      return out;
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
