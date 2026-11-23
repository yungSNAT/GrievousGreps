/**
 * Routes on a router another file mounts: FastAPI's `include_router` and Flask's `register_blueprint` of an imported
 * router or blueprint (`users` or `users.router`), and Express's `use` of a router another module exports
 * (`module.exports`, `exports.a`, `export default`, `export const`), through ES re-exports. Each file's parse keeps
 * its {@link RouteFacts}; once imports resolve, a mount's child is followed to the file that defines it and its
 * routes get every prefix the mounts above it give, as in one file. Each route stays a node in the file that
 * registers it. A step that does not resolve to one router, or a prefix that is unknown anywhere above it, gives no
 * route: nothing is guessed. A Go mux handed to another file's function is not followed.
 */
import type { RawEdge } from "./extract.js";
import type { Seg } from "./route-paths.js";
import { Scopes } from "./route-scopes.js";
import { MODULE_EXPORTS, prefixesOf, routeEdges, routeName, routeNode, type Import, type Mount, type MountGraph, type RouteFacts } from "./routes.js";
import type { NodeV1 } from "./types.js";

/** How imports resolve, from the resolver's own module maps. */
export interface MountImports {
  /** The repository module a specifier written in `file` names. */
  module(specifier: string, file: string): string | null;
  /** A Python package's submodule `name`. */
  submodule(module: string, name: string): string | null;
  /** Whether a Python module may bind `name` itself: any binding of it, a star import, or a dynamic binding. */
  binds(module: string, name: string): boolean;
  /** Whether a Python module's code binds `name` exactly once, with no star import after it, and binds no name dynamically. */
  once(module: string, name: string): boolean;
  /** The one import binding `local` at the top of `file`. */
  imported(file: string, local: string): Import | null;
  /** What an ES module exports as `name`: one of its own names, or another module's. */
  exported(file: string, name: string): { local: string } | Import | null;
}

type Target = { file: string; key: string } | { module: string } | null;
type Into = Pick<Mount, "parent" | "prefix" | "replaces">;

const MODULE_KEY = Scopes.module("");
const MAX_HOPS = 8;
/** A record's own entry: an import named `toString` is not the prototype's. */
const own = <T>(record: Record<string, T> | undefined, key: string): T | undefined => (record && Object.hasOwn(record, key) ? record[key] : undefined);
export const isJs = (file: string) => /\.[cm]?[jt]sx?$/.test(file);

/** The route nodes, and their `contains` and handler edges, that mounts across files place. */
export function mountedRoutes(facts: ReadonlyMap<string, RouteFacts>, imports: MountImports, taken: (id: string) => boolean): { nodes: NodeV1[]; edges: RawEdge[] } {
  const importOf = (file: string, local: string) => own(facts.get(file)?.requires, local) ?? imports.imported(file, local);
  // What a name bound at the top of `file` is: a router it defines, a whole module, or what an import brings.
  const followLocal = (file: string, local: string, hops: number): Target => {
    // A Python name bound more than once, or in a module that can bind names dynamically, is not followed.
    if (hops > MAX_HOPS || (!isJs(file) && !imports.once(file, local))) return null;
    const key = Scopes.module(local);
    if (facts.get(file)?.objects[key]) return { file, key };
    const imp = importOf(file, local);
    const module = imp ? imports.module(imp.specifier, file) : null;
    if (!imp || !module) return null;
    if (!isJs(file) && imp.name === "") return { module };
    return followExport(module, imp.name, hops + 1);
  };
  const asking = new Set<string>();
  // What `module` gives an import of `name`. A CommonJS module's default import, and a bare `require`, is its whole
  // `module.exports`; `require` of an ES module gives its namespace, never a router.
  const followExport = (module: string, name: string, hops: number): Target => {
    if (hops > MAX_HOPS) return null;
    if (!isJs(module)) {
      const at = `${module}\0${name}`;
      // A package's submodule: what `from pkg import name` gives when the package binds no `name`, or asks itself for it.
      const sub = imports.submodule(module, name);
      const submodule = sub ? { module: sub } : null;
      if (asking.has(at)) return submodule;
      asking.add(at);
      try {
        return followLocal(module, name, hops + 1) ?? (imports.binds(module, name) ? null : submodule);
      } finally {
        asking.delete(at);
      }
    }
    const f = facts.get(module);
    if (f?.opaque) return null;
    if (f?.exports) {
      const local = own(f.exports, name === "default" ? MODULE_EXPORTS : name);
      return local === undefined ? null : followLocal(module, local, hops + 1);
    }
    const ex = name === MODULE_EXPORTS ? null : imports.exported(module, name);
    if (!ex) return null;
    if ("local" in ex) return followLocal(module, ex.local, hops + 1);
    const next = imports.module(ex.specifier, module);
    return next ? followExport(next, ex.name, hops + 1) : null;
  };

  const id = (file: string, key: string) => `${file}\0${key}`;
  const cross = new Map<string, Into[]>();
  for (const [file, f] of facts) {
    for (const m of f.mounts) {
      let to: Target;
      if (m.import) {
        const module = imports.module(m.import.specifier, file);
        to = module ? followExport(module, m.import.name, 1) : null;
      } else if (m.attr || !f.objects[m.child]) {
        // A module-level name, or an import inside a function (a Flask app factory's).
        const scoped = own(f.scoped, m.child);
        const module = scoped ? imports.module(scoped.specifier, file) : null;
        if (scoped) to = !module ? null : scoped.name === "" ? { module } : followExport(module, scoped.name, 1);
        else if (m.child.startsWith(MODULE_KEY)) to = followLocal(file, m.child.slice(MODULE_KEY.length), 0);
        else continue;
        if (m.attr) to = to && "module" in to ? followExport(to.module, m.attr, 1) : null;
      } else continue;
      if (!to || !("key" in to)) continue;
      const list = cross.get(id(to.file, to.key)) ?? [];
      list.push({ parent: m.parent === null ? null : id(file, m.parent), prefix: m.prefix, replaces: m.replaces });
      cross.set(id(to.file, to.key), list);
    }
  }
  const nodes: NodeV1[] = [];
  const edges: RawEdge[] = [];
  if (!cross.size) return { nodes, edges };
  const split = (at: string) => [at.slice(0, at.indexOf("\0")), at.slice(at.indexOf("\0") + 1)] as const;
  const graph: MountGraph = {
    object: (at) => {
      const [file, key] = split(at);
      return facts.get(file)?.objects[key];
    },
    into: (at) => {
      const [file, key] = split(at);
      const own = (facts.get(file)?.mounts ?? []).filter((m) => m.child === key && !m.attr);
      return [...own.map((m) => ({ parent: m.parent === null ? null : id(file, m.parent), prefix: m.prefix, replaces: m.replaces })), ...(cross.get(at) ?? [])];
    },
  };
  const minted = new Set<string>();
  const mint = (base: string) => {
    let next = base;
    for (let k = 2; taken(next) || minted.has(next); k++) next = `${base}~${k}`;
    minted.add(next);
    return next;
  };
  for (const [file, f] of facts) {
    const under = new Map<string, Seg[][]>();
    for (const r of f.routes) {
      if (!under.has(r.via)) under.set(r.via, prefixesOf(graph, id(file, r.via)));
      // Each path once per registration, and none its own file already placed.
      const placed = new Set(r.placed);
      for (const prefix of under.get(r.via)!) {
        const name = routeName(r, prefix);
        if (name === null || placed.has(name)) continue;
        placed.add(name);
        const node = routeNode(file, r, name, mint);
        nodes.push(node);
        edges.push(...routeEdges(file, node.id, r.handler));
      }
    }
  }
  return { nodes, edges };
}
