/**
 * Routes on a router another file mounts: FastAPI's `include_router` and Flask's `register_blueprint` of an imported
 * router or blueprint (`users` or `users.router`), and Express's `use` of a router another module exports
 * (`module.exports`, `exports.a`, `export default`, `export const`), through re-exports. Each file's parse keeps
 * its {@link RouteFacts}; once imports resolve, a mount's child is followed to the file that defines it and its
 * routes get every prefix the mounts above it give, as in one file. Each route stays a node in the file that
 * registers it. A step that does not resolve to one router, or a prefix that is unknown anywhere above it, gives no
 * route: nothing is guessed. A Go mux handed to another file's function is not followed.
 */
import type { RawEdge } from "./extract.js";
import type { Seg } from "./route-paths.js";
import { Scopes } from "./route-scopes.js";
import { prefixesOf, routeEdges, routeNode, type Import, type Mount, type MountGraph, type RouteFacts } from "./routes.js";
import type { NodeV1 } from "./types.js";

/** How imports resolve, from the resolver's own module maps. */
export interface MountImports {
  /** The repository module a specifier written in `file` names. */
  module(specifier: string, file: string): string | null;
  /** A Python package's submodule `name`. */
  submodule(module: string, name: string): string | null;
  /** The one import binding `local` at the top of `file`. */
  imported(file: string, local: string): Import | null;
  /** What an ES module exports as `name`: one of its own names, or another module's. */
  exported(file: string, name: string): { local: string } | Import | null;
}

type Target = { file: string; key: string } | { module: string } | null;
type Into = Pick<Mount, "parent" | "prefix" | "replaces">;

const MODULE_KEY = Scopes.module("");
const MAX_HOPS = 8;
export const isJs = (file: string) => /\.[cm]?[jt]sx?$/.test(file);

/** The route nodes, and their `contains` and handler edges, that mounts across files place. */
export function mountedRoutes(facts: ReadonlyMap<string, RouteFacts>, imports: MountImports, taken: (id: string) => boolean): { nodes: NodeV1[]; edges: RawEdge[] } {
  const importOf = (file: string, local: string) => facts.get(file)?.requires?.[local] ?? imports.imported(file, local);
  // What a name bound at the top of `file` is: a router it defines, a whole module, or what an import brings.
  const followLocal = (file: string, local: string, hops: number): Target => {
    if (hops > MAX_HOPS) return null;
    const key = Scopes.module(local);
    if (facts.get(file)?.objects[key]) return { file, key };
    const imp = importOf(file, local);
    const module = imp ? imports.module(imp.specifier, file) : null;
    if (!imp || !module) return null;
    if (!isJs(file) && imp.name === "") return { module };
    return followExport(module, imp.name, hops + 1);
  };
  // What `module` gives an import of `name`; in Python a package's submodule when nothing in it binds the name.
  const followExport = (module: string, name: string, hops: number): Target => {
    if (hops > MAX_HOPS) return null;
    if (!isJs(module)) {
      const sub = followLocal(module, name, hops + 1) ?? imports.submodule(module, name);
      return typeof sub === "string" ? { module: sub } : sub;
    }
    const common = facts.get(module)?.exports?.[name];
    const ex = common === undefined ? imports.exported(module, name) : { local: common };
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
      } else if ((m.attr || !f.objects[m.child]) && m.child.startsWith(MODULE_KEY)) {
        to = followLocal(file, m.child.slice(MODULE_KEY.length), 0);
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
      for (const prefix of under.get(r.via)!) {
        const node = routeNode(file, r, prefix, mint);
        if (!node) continue;
        nodes.push(node);
        edges.push(...routeEdges(file, node.id, r.handler));
      }
    }
  }
  return { nodes, edges };
}
