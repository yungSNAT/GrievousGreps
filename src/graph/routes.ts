/**
 * HTTP routes as graph nodes, so an Ingress path can reach the handler that serves it.
 *
 * A route is read only when its full path is known in its own file: registered on an
 * application object (FastAPI, Flask, Express, a Go `net/http` mux), or on a router that
 * file mounts (`include_router`, `register_blueprint`, `use`). A router mounted only from
 * another file or under a prefix that is not a plain string, a path that is not a plain
 * string literal, a segment that is partly a parameter or uses an unknown converter, a Go
 * pattern with a host, or an object or handler bound more than once in its scope or taken
 * as a parameter gives no route or edge: nothing is guessed. Each route is a `resource` node
 * named `<METHODS> <path>` (`ANY` for every method), with `{name}` for a one-segment parameter
 * (`{name:int}` when a converter restricts it), `{name...}` for the rest of the path and a
 * trailing `/` kept where the framework treats it as part of the path. Its signature,
 * `route <framework> <name>`, says whose converters and rest rules `deploy.ts` matches an
 * Ingress path with.
 */
import { contentHash } from "../util/id.js";
import { isTestPath } from "../util/paths.js";
import type { SyntaxNode } from "./depth-parser.js";
import type { Language, RawEdge } from "./extract.js";
import type { NodeV1 } from "./types.js";
import { canonical, expressSeg, fastapiSeg, flaskSeg, goPattern, segments, type Framework, type RoutePath, type Seg } from "./route-paths.js";
import { descendants, Scopes } from "./route-scopes.js";

export interface Obj {
  app: boolean;
  own: Seg[];
  /** Bindings of the name in its scope; a route on a name bound twice is not read. */
  count: number;
  /** A Go mux handed to another handler: served under a prefix this file does not show. */
  mounted?: true;
}

/** Objects, mounts and routes name a binding by its `Scopes` key. */
export interface Mount {
  /** Null when a parameter: the child then gives no routes. */
  parent: string | null;
  child: string;
  /** Null when the prefix is not known: the child then gives no routes at all. */
  prefix: Seg[] | null;
  /** Flask: a `url_prefix` given at registration replaces the blueprint's own. */
  replaces?: true;
  /** The child is this attribute of the module `child` binds: `include_router(users.router)`. */
  attr?: string;
  /** The child is what this import gives, required where it is mounted (`child` is then empty). */
  import?: Import;
}

interface Found {
  at: SyntaxNode;
  via: string;
  framework: Framework;
  /** Empty for every method. */
  methods: string[];
  path: RoutePath;
  /** A handler name to resolve, when it means the file's own single top-level binding. */
  handler: string | null;
  /** The handler is the decorated definition itself. */
  decorated?: true;
}

interface Read {
  objects: Map<string, Obj>;
  mounts: Mount[];
  routes: Found[];
  scopes: Scopes;
  /** JavaScript: top-level `require` bindings, and the local name `module.exports` gives each exported name. */
  requires?: Record<string, Import>;
  exports?: Record<string, string>;
}

/** An import: `name` is `default` for a whole CommonJS module or a default export, and empty for a whole Python module. */
export interface Import {
  specifier: string;
  name: string;
}

/** A route on an object whose prefixes its own file does not show, waiting for a mount in another file. */
export interface RouteFact {
  via: string;
  framework: Framework;
  methods: string[];
  path: RoutePath;
  from: number;
  to: number;
  handler?: { targetId: string } | Import;
}

/**
 * What another file's mount needs to know about this one, kept with the file's cached parse: its objects and mounts
 * by `Scopes` key, the routes it could not place, and for JavaScript its CommonJS imports and exports.
 */
export interface RouteFacts {
  objects: Record<string, Obj>;
  mounts: Mount[];
  routes: RouteFact[];
  requires?: Record<string, Import>;
  exports?: Record<string, string>;
}

const MAX_PREFIXES = 8;

// ── Syntax ──────────────────────────────────────────────────────────────────

/** A plain quoted string with no escape, prefix or interpolation. */
function literal(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "raw_string_literal") return /^`([^`]*)`$/.exec(node.text)?.[1] ?? null;
  if (node.type !== "string" && node.type !== "interpreted_string_literal") return null;
  return /^(['"])([^'"\\\n]*)\1$/.exec(node.text)?.[2] ?? null;
}

// ── Python: FastAPI and Flask ───────────────────────────────────────────────

const PY_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const PY_CTORS: Record<string, { app: boolean; prefix?: string; flask: boolean }> = {
  FastAPI: { app: true, flask: false },
  APIRouter: { app: false, prefix: "prefix", flask: false },
  Flask: { app: true, flask: true },
  Blueprint: { app: false, prefix: "url_prefix", flask: true },
};

function pyArgs(call: SyntaxNode): { positional: SyntaxNode[]; keyword: Map<string, SyntaxNode> } {
  const positional: SyntaxNode[] = [];
  const keyword = new Map<string, SyntaxNode>();
  for (const a of call.childForFieldName("arguments")?.namedChildren ?? []) {
    if (a.type === "keyword_argument") {
      const name = a.childForFieldName("name")?.text;
      const value = a.childForFieldName("value");
      if (name && value) keyword.set(name, value);
    } else if (a.type !== "comment") positional.push(a);
  }
  return { positional, keyword };
}

/** A name's binding where `at` uses it, when the file binds it exactly once there. */
function once(scopes: Scopes, at: SyntaxNode, name: string): string | null {
  const key = scopes.use(at, name);
  return scopes.count(key) === 1 ? key : null;
}

function readPython(root: SyntaxNode): Read | null {
  // Names bound to the frameworks' classes and modules, wherever the file imports them.
  const imports: Array<{ at: SyntaxNode; local: string; ctor: string | null }> = [];
  for (const st of descendants(root)) {
    const from = st.type === "import_from_statement" ? st.childForFieldName("module_name")?.text ?? "" : null;
    if (from !== null && !/^(fastapi|flask)(\.|$)/.test(from)) continue;
    if (from === null && st.type !== "import_statement") continue;
    for (const n of from === null ? st.namedChildren : st.namedChildren.slice(1)) {
      const name = n.type === "aliased_import" ? n.childForFieldName("name")?.text : n.text;
      const local = n.type === "aliased_import" ? n.childForFieldName("alias")?.text : n.text;
      if (!name || !local) continue;
      if (from !== null && Object.hasOwn(PY_CTORS, name)) imports.push({ at: st, local, ctor: name });
      if (from === null && (name === "fastapi" || name === "flask")) imports.push({ at: st, local, ctor: null });
    }
  }
  if (!imports.length) return null;
  const scopes = new Scopes(root, "python");
  const classes = new Map<string, string>();
  const modules = new Set<string>();
  for (const i of imports) {
    const key = scopes.binding(i.at, i.local);
    if (key !== null && i.ctor) classes.set(key, i.ctor);
    else if (key !== null) modules.add(key);
  }
  const ctorOf = (call: SyntaxNode): string | null => {
    const f = call.childForFieldName("function");
    if (f?.type === "identifier") return classes.get(once(scopes, call, f.text) ?? "") ?? null;
    const mod = f?.type === "attribute" ? f.childForFieldName("object") : null;
    if (mod?.type !== "identifier" || !modules.has(once(scopes, call, mod.text) ?? "")) return null;
    const attr = f!.childForFieldName("attribute")?.text ?? "";
    return Object.hasOwn(PY_CTORS, attr) ? attr : null;
  };
  const prefix = (node: SyntaxNode | undefined, flask: boolean): Seg[] | null => {
    if (!node) return [];
    const s = literal(node);
    return s === null ? null : segments(s, flask ? flaskSeg : fastapiSeg)?.segs ?? null;
  };

  const objects = new Map<string, Obj>();
  const flaskKeys = new Set<string>();
  const mounts: Mount[] = [];
  const decorated: SyntaxNode[] = [];
  for (const n of descendants(root)) {
    if (n.type === "assignment") {
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      const ctor = left?.type === "identifier" && right?.type === "call" ? ctorOf(right) : null;
      const key = ctor ? scopes.binding(n, left!.text) : null;
      if (!ctor || key === null) continue;
      const spec = PY_CTORS[ctor];
      const own = spec.prefix ? prefix(pyArgs(right!).keyword.get(spec.prefix), spec.flask) : [];
      if (own) objects.set(key, { app: spec.app, own, count: scopes.count(key) });
      if (spec.flask) flaskKeys.add(key);
    } else if (n.type === "call") {
      const f = n.childForFieldName("function");
      if (f?.type !== "attribute") continue;
      const parent = f.childForFieldName("object");
      const method = f.childForFieldName("attribute")?.text;
      if (parent?.type !== "identifier") continue;
      const { positional, keyword } = pyArgs(n);
      const childNode = method === "mount" ? positional[1] : positional[0];
      // `users.router`: the attribute of a module, for a mount in another file to resolve.
      const module = childNode?.type === "attribute" ? childNode.childForFieldName("object") : null;
      const attr = module?.type === "identifier" ? childNode!.childForFieldName("attribute")?.text : undefined;
      const child = childNode?.type === "identifier" ? scopes.use(n, childNode.text) : attr ? scopes.use(n, module!.text) : null;
      if (child === null) continue;
      let p: Seg[] | null;
      let replaces = false;
      if (method === "include_router" || method === "register_blueprint") {
        const flask = method === "register_blueprint";
        replaces = flask && keyword.has("url_prefix");
        p = prefix(keyword.get(flask ? "url_prefix" : "prefix"), flask);
      } else if (method === "mount") {
        const s = literal(positional[0]);
        p = s === null ? null : segments(s, fastapiSeg)?.segs ?? null;
      } else continue;
      const into = scopes.use(n, parent.text);
      mounts.push({ parent: into, child, prefix: into === null ? null : p, ...(replaces ? { replaces: true as const } : {}), ...(attr ? { attr } : {}) });
    } else if (n.type === "decorated_definition") decorated.push(n);
  }
  const routes: Found[] = [];
  for (const n of decorated) {
    const def = n.childForFieldName("definition");
    const handler = def?.type === "function_definition" ? def.childForFieldName("name")?.text ?? null : null;
    if (!handler) continue;
    for (const d of n.namedChildren) {
      const call = d.type === "decorator" ? d.namedChildren[0] : null;
      const f = call?.type === "call" ? call.childForFieldName("function") : null;
      const viaNode = f?.type === "attribute" ? f.childForFieldName("object") : null;
      const method = f?.childForFieldName("attribute")?.text ?? "";
      const via = viaNode?.type === "identifier" ? scopes.use(n, viaNode.text) : null;
      if (!call || via === null) continue;
      const flask = flaskKeys.has(via);
      const { positional, keyword } = pyArgs(call);
      let methods: string[];
      if (PY_METHODS.has(method)) methods = [method.toUpperCase()];
      else if ((flask && method === "route") || (!flask && method === "api_route")) {
        const listed = keyword.get("methods");
        const names = listed ? (listed.type === "list" || listed.type === "tuple" ? listed.namedChildren.map(literal) : [null]) : ["GET"];
        if (names.some((m) => m === null || !/^[A-Za-z]+$/.test(m))) continue;
        // An empty list: Flask still answers OPTIONS by default; FastAPI then matches every method.
        methods = names.length ? (names as string[]).map((m) => m.toUpperCase()) : flask ? ["OPTIONS"] : [];
      } else continue;
      const raw = literal(positional[0] ?? keyword.get(flask ? "rule" : "path"));
      const path = raw === null ? null : segments(raw, flask ? flaskSeg : fastapiSeg);
      if (path) routes.push({ at: n, via, framework: flask ? "flask" : "fastapi", methods, path, handler, decorated: true });
    }
  }
  return { objects, mounts, routes, scopes };
}

// ── JavaScript and TypeScript: Express ──────────────────────────────────────

const JS_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
const JS_FUNCTIONS = new Set(["arrow_function", "function_expression", "function", "generator_function"]);

function readExpress(root: SyntaxNode, lang: Language): Read | null {
  // `import` from "express", and `require("express")` wherever it is called, by the node that binds each name.
  const found: Array<{ at: SyntaxNode; local: string; router: boolean }> = [];
  const fromExpress = (n: SyntaxNode | null | undefined) => literal(n) === "express";
  for (const st of descendants(root)) {
    if (st.type === "import_statement" && fromExpress(st.childForFieldName("source"))) {
      const clause = st.namedChildren.find((c) => c.type === "import_clause");
      for (const c of clause?.namedChildren ?? []) {
        if (c.type === "identifier") found.push({ at: st, local: c.text, router: false });
        for (const s of c.type === "named_imports" ? c.namedChildren : []) {
          if (s.childForFieldName("name")?.text === "Router") found.push({ at: st, local: (s.childForFieldName("alias") ?? s.childForFieldName("name"))!.text, router: true });
        }
      }
    }
    if (st.type !== "variable_declarator") continue;
    const value = st.childForFieldName("value");
    const required = value?.type === "call_expression" && value.childForFieldName("function")?.text === "require"
      && fromExpress(value.childForFieldName("arguments")?.namedChildren[0]);
    if (!required) continue;
    const name = st.childForFieldName("name");
    if (name?.type === "identifier") found.push({ at: st, local: name.text, router: false });
    for (const p of name?.type === "object_pattern" ? name.namedChildren : []) {
      if (p.type === "shorthand_property_identifier_pattern" && p.text === "Router") found.push({ at: st, local: "Router", router: true });
      const v = p.type === "pair_pattern" && p.childForFieldName("key")?.text === "Router" ? p.childForFieldName("value") : null;
      if (v?.type === "identifier") found.push({ at: st, local: v.text, router: true });
    }
  }
  if (!found.length) return null;
  const scopes = new Scopes(root, lang);
  const express = new Set<string>();
  const routers = new Set<string>();
  for (const f of found) {
    const key = scopes.binding(f.at, f.local, true);
    if (key !== null) (f.router ? routers : express).add(key);
  }
  const made = (value: SyntaxNode | null): Omit<Obj, "count"> | null => {
    const f = value?.type === "call_expression" ? value.childForFieldName("function") : null;
    const key = f?.type === "identifier" ? once(scopes, value!, f.text) : null;
    if (key && express.has(key)) return { app: true, own: [] };
    if (key && routers.has(key)) return { app: false, own: [] };
    const obj = f?.type === "member_expression" ? f.childForFieldName("object") : null;
    const via = obj?.type === "identifier" ? once(scopes, value!, obj.text) : null;
    return via && express.has(via) && f!.childForFieldName("property")?.text === "Router" ? { app: false, own: [] } : null;
  };

  const objects = new Map<string, Obj>();
  const fns = new Set<string>();
  const uses: Array<{ at: SyntaxNode; parent: string | null; args: SyntaxNode[] }> = [];
  const routes: Found[] = [];
  const requires: Record<string, Import> = {};
  const cjsExports: Record<string, string> = {};
  for (const n of descendants(root)) {
    if (n.type === "variable_declarator") readRequire(n, scopes, requires);
    if (n.type === "assignment_expression") readCommonExport(n, cjsExports);
    if (n.type === "variable_declarator" || n.type === "assignment_expression") {
      const declarator = n.type === "variable_declarator";
      const name = n.childForFieldName(declarator ? "name" : "left");
      const value = n.childForFieldName(declarator ? "value" : "right");
      const key = name?.type === "identifier" ? scopes.binding(n, name.text) : null;
      if (key === null) continue;
      const m = made(value);
      if (m) objects.set(key, { ...m, count: scopes.count(key) });
      if (value && JS_FUNCTIONS.has(value.type)) fns.add(key);
    } else if (n.type === "function_declaration") {
      const key = scopes.binding(n, n.childForFieldName("name")?.text ?? "");
      if (key !== null) fns.add(key);
    } else if (n.type === "call_expression") {
      const f = n.childForFieldName("function");
      const parentNode = f?.type === "member_expression" ? f.childForFieldName("object") : null;
      const method = f?.childForFieldName("property")?.text ?? "";
      if (parentNode?.type !== "identifier") continue;
      const parent = scopes.use(n, parentNode.text);
      const args = (n.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "comment");
      if (method === "use") uses.push({ at: n, parent, args });
      else if (JS_METHODS.has(method) && args.length >= 2 && parent !== null) {
        const raw = literal(args[0]);
        // Express matches with or without a trailing slash by default.
        const path = raw === null ? null : segments(raw, expressSeg);
        const last = args[args.length - 1];
        if (path) {
          routes.push({ at: n, via: parent, framework: "express", methods: method === "all" ? [] : [method.toUpperCase()], path: { segs: path.segs, trailing: false }, handler: last.type === "identifier" ? last.text : null });
        }
      }
    }
  }
  // `use`'s first argument: a plain string path, a router or a function (no path), or unknown.
  const usePath = (at: SyntaxNode, arg: SyntaxNode | undefined): Seg[] | null | "none" => {
    if (arg?.type === "string") {
      const s = literal(arg);
      return s === null ? null : segments(s, expressSeg)?.segs ?? null;
    }
    if (arg?.type === "identifier") {
      const key = scopes.use(at, arg.text);
      return key !== null && (objects.has(key) || (fns.has(key) && scopes.count(key) === 1)) ? "none" : null;
    }
    return arg && (arg.type === "call_expression" || JS_FUNCTIONS.has(arg.type)) ? "none" : null;
  };
  const mounts: Mount[] = [];
  for (const u of uses) {
    // A lone argument is a router or middleware: `use` takes a path only before one.
    const first = u.args.length === 1 ? "none" : usePath(u.at, u.args[0]);
    const path = first === "none" ? [] : first;
    for (const a of u.args.slice(first === "none" ? 0 : 1)) {
      const prefix = u.parent === null ? null : path;
      // `use("/x", require("./x"))`: the module's export, for route-mounts.ts to follow.
      const specifier = requireOf(a);
      if (specifier !== null) mounts.push({ parent: u.parent, child: "", import: { specifier, name: "default" }, prefix });
      const child = a.type === "identifier" ? scopes.use(u.at, a.text) : null;
      if (child !== null) mounts.push({ parent: u.parent, child, prefix });
    }
  }
  return { objects, mounts, routes, scopes, requires, exports: cjsExports };
}

/** `const x = require("./x")` (the whole module, as `default`) or `const { a, b: c } = require("./x")`, at the top level. */
function readRequire(n: SyntaxNode, scopes: Scopes, out: Record<string, Import>): void {
  const specifier = requireOf(n.childForFieldName("value"));
  const name = n.childForFieldName("name");
  if (specifier === null || !name) return;
  const bind = (local: string, imported: string) => {
    if (scopes.binding(n, local) === Scopes.module(local)) out[local] = { specifier, name: imported };
  };
  if (name.type === "identifier") bind(name.text, "default");
  for (const p of name.type === "object_pattern" ? name.namedChildren : []) {
    if (p.type === "shorthand_property_identifier_pattern") bind(p.text, p.text);
    const key = p.type === "pair_pattern" ? p.childForFieldName("key") : null;
    const v = p.type === "pair_pattern" ? p.childForFieldName("value") : null;
    if (key?.type === "property_identifier" && v?.type === "identifier") bind(v.text, key.text);
  }
}

/** The plain string a `require(...)` call names. */
function requireOf(n: SyntaxNode | null): string | null {
  const args = n?.type === "call_expression" && n.childForFieldName("function")?.text === "require" ? n.childForFieldName("arguments")?.namedChildren ?? [] : [];
  return args.length === 1 ? literal(args[0]) : null;
}

/** `module.exports = x` (as `default`), `module.exports = { a, b: c }`, and `exports.a = x` or `module.exports.a = x`. */
function readCommonExport(n: SyntaxNode, out: Record<string, string>): void {
  const left = n.childForFieldName("left");
  const right = n.childForFieldName("right");
  if (left?.type !== "member_expression" || !right) return;
  const target = left.text.replace(/\s+/g, "");
  if (target === "module.exports") {
    if (right.type === "identifier") out.default = right.text;
    for (const p of right.type === "object" ? right.namedChildren : []) {
      if (p.type === "shorthand_property_identifier") out[p.text] = p.text;
      const v = p.type === "pair" ? p.childForFieldName("value") : null;
      if (p.type === "pair" && p.childForFieldName("key")?.type === "property_identifier" && v?.type === "identifier") out[p.childForFieldName("key")!.text] = v.text;
    }
    return;
  }
  const named = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(target);
  if (named && right.type === "identifier") out[named[1]] = right.text;
}

// ── Go: net/http ────────────────────────────────────────────────────────────

/** The default mux's key: no Go identifier holds a space. */
const DEFAULT_MUX = "http DefaultServeMux";

function readGo(root: SyntaxNode, goImports: ReadonlyMap<string, string>): Read | null {
  const http = [...goImports].find(([, path]) => path === "net/http")?.[0];
  if (!http || http === "_" || http === ".") return null;
  const scopes = new Scopes(root, "go");
  // `http` bound at the top level of the file is not the package anywhere in it.
  if (scopes.count(Scopes.module(http))) return null;
  const pkg = (at: SyntaxNode, n: SyntaxNode | null | undefined) => n?.type === "identifier" && n.text === http && scopes.use(at, http) === Scopes.module(http);
  const objects = new Map<string, Obj>([[DEFAULT_MUX, { app: true, own: [], count: 1 }]]);
  const routes: Found[] = [];
  const isNewMux = (at: SyntaxNode, v: SyntaxNode | undefined) => {
    const f = v?.type === "call_expression" ? v.childForFieldName("function") : null;
    return f?.type === "selector_expression" && pkg(at, f.childForFieldName("operand")) && f.childForFieldName("field")?.text === "NewServeMux";
  };
  const handles: SyntaxNode[] = [];
  for (const n of descendants(root)) {
    if (n.type === "short_var_declaration" || n.type === "assignment_statement" || n.type === "var_spec") {
      const names = n.type === "var_spec"
        ? n.namedChildren.filter((c) => c.type === "identifier")
        : n.childForFieldName("left")?.namedChildren ?? [];
      const values = (n.type === "var_spec" ? n.childForFieldName("value") : n.childForFieldName("right"))?.namedChildren ?? [];
      names.forEach((name, i) => {
        const key = name.type === "identifier" && isNewMux(n, values[i]) ? scopes.binding(n, name.text) : null;
        if (key !== null) objects.set(key, { app: true, own: [], count: scopes.count(key) });
      });
    } else if (n.type === "call_expression") {
      const f = n.childForFieldName("function");
      const method = f?.type === "selector_expression" ? f.childForFieldName("field")?.text : undefined;
      if (method === "Handle" || method === "HandleFunc") handles.push(n);
    }
  }
  for (const n of handles) {
    const f = n.childForFieldName("function")!;
    const operand = f.childForFieldName("operand")!;
    const via = pkg(n, operand) ? DEFAULT_MUX : operand.type === "identifier" ? scopes.use(n, operand.text) : null;
    const args = (n.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "comment");
    for (const id of args[1] ? descendants(args[1]) : []) {
      const mux = id.type === "identifier" ? objects.get(scopes.use(id, id.text) ?? "") : undefined;
      if (mux) mux.mounted = true;
    }
    const raw = literal(args[0]);
    const pattern = raw === null ? null : goPattern(raw);
    if (via === null || !pattern || args.length !== 2) continue;
    let h: SyntaxNode | null | undefined = args[1];
    if (f.childForFieldName("field")!.text === "Handle") {
      const conv = h.type === "call_expression" ? h.childForFieldName("function") : null;
      const wrapped = conv?.type === "selector_expression" && pkg(n, conv.childForFieldName("operand")) && conv.childForFieldName("field")?.text === "HandlerFunc";
      h = wrapped ? h.childForFieldName("arguments")?.namedChildren[0] : null;
    }
    routes.push({ at: n, via, framework: "go", ...pattern, handler: h?.type === "identifier" ? h.text : null });
  }
  return { objects, mounts: [], routes, scopes };
}

// ── Nodes ───────────────────────────────────────────────────────────────────

/** Objects and the mounts into each, by key: one file's, or every file's once imports are resolved. */
export interface MountGraph {
  object(key: string): Obj | undefined;
  into(key: string): ReadonlyArray<Pick<Mount, "parent" | "prefix" | "replaces">>;
}

/** Every full prefix `name` is served under, or none when any step is unknown. */
export function prefixesOf(g: MountGraph, name: string, depth = 0): Seg[][] {
  const o = g.object(name);
  if (!o || o.count !== 1 || o.mounted || depth > MAX_PREFIXES) return [];
  const into = g.into(name);
  if (!into.length) return o.app ? [o.own] : [];
  const out: Seg[][] = [];
  for (const m of into) {
    if (!m.prefix || m.parent === null) return [];
    for (const p of prefixesOf(g, m.parent, depth + 1)) out.push([...p, ...(m.replaces ? m.prefix : [...m.prefix, ...o.own])]);
  }
  return out.slice(0, MAX_PREFIXES);
}

/** A route's node under one prefix, or null when the prefix ends in the rest of the path. */
export function routeNode(rel: string, r: Pick<RouteFact, "framework" | "methods" | "path" | "from" | "to">, prefix: Seg[], mint: (base: string) => string): NodeV1 | null {
  if (prefix.length && "rest" in prefix[prefix.length - 1]) return null;
  const name = `${r.methods.length ? r.methods.join("|") : "ANY"} ${canonical([...prefix, ...r.path.segs], r.path.trailing)}`;
  const signature = `route ${r.framework} ${name}`;
  return {
    id: mint(`${rel}#route:${name}`), name, kind: "resource", path: rel, span: `L${r.from}-L${r.to}`,
    signature, exported: false, origin: "ast", body_hash: contentHash(signature), body_text: name,
    summary_state: "pending", summary: null, crux: null,
  };
}

/** The `contains` edge to a route and the `references` edge to its handler. */
export function routeEdges(rel: string, id: string, handler: RouteFact["handler"]): RawEdge[] {
  const edges: RawEdge[] = [{ source: rel, relation: "contains", file: rel, targetId: id }];
  if (handler && "targetId" in handler) edges.push({ source: id, relation: "references", file: rel, targetId: handler.targetId });
  else if (handler) edges.push({ source: id, relation: "references", file: rel, name: handler.name, specifier: handler.specifier });
  return edges;
}

export interface RouteContext {
  rel: string;
  lang: Language;
  /** The file's nodes so far, for a handler defined in it. */
  nodes: readonly NodeV1[];
  importedSymbols: ReadonlyMap<string, { name: string; specifier: string }>;
  goImports: ReadonlyMap<string, string>;
  mint: (base: string) => string;
}

/**
 * The file's routes as nodes, with `contains` and handler `references` edges, and the facts a mount in another file
 * needs ({@link RouteFacts}) when the file has a route it could not place or mounts an object it does not define.
 */
export function extractRoutes(root: SyntaxNode, ctx: RouteContext): { nodes: NodeV1[]; edges: RawEdge[]; facts?: RouteFacts } {
  // Each reader returns null, having read only its imports, for a file that imports no framework; a test serves nothing.
  const read = isTestPath(ctx.rel) ? null
    : ctx.lang === "python" ? readPython(root)
      : ctx.lang === "typescript" || ctx.lang === "tsx" ? readExpress(root, ctx.lang)
        : ctx.lang === "go" ? readGo(root, ctx.goImports)
          : null;
  const nodes: NodeV1[] = [];
  const edges: RawEdge[] = [];
  if (!read) return { nodes, edges };
  const startOf = (n: NodeV1) => Number(/^L(\d+)/.exec(n.span)?.[1]);
  const byName = new Map<string, NodeV1[]>();
  for (const n of ctx.nodes) {
    if (n.kind === "file") continue;
    const list = byName.get(n.name);
    if (list) list.push(n);
    else byName.set(n.name, [n]);
  }
  const local: MountGraph = { object: (key) => read.objects.get(key), into: (key) => read.mounts.filter((m) => m.child === key && !m.attr) };
  const prefixes = new Map<string, Seg[][]>();
  const waiting: RouteFact[] = [];
  for (const r of read.routes) {
    if (!prefixes.has(r.via)) prefixes.set(r.via, prefixesOf(local, r.via));
    const from = r.at.startPosition.row + 1;
    const to = r.at.endPosition.row + 1;
    // A decorated def is the registration itself; a named handler is the file's one top-level binding of the name: a definition or an import.
    const candidates = r.handler ? byName.get(r.handler) ?? [] : [];
    const key = r.handler && !r.decorated ? read.scopes.use(r.at, r.handler) : null;
    const top = r.handler !== null && key === Scopes.module(r.handler) && read.scopes.count(key) === 1;
    const own = !r.handler ? undefined
      : r.decorated ? candidates.find((n) => startOf(n) >= from && startOf(n) <= to)
        : top ? candidates.find((n) => n.id === `${ctx.rel}#${r.handler}`) : undefined;
    const imported = top && !own ? ctx.importedSymbols.get(r.handler!) : undefined;
    const handler = own ? { targetId: own.id } : imported ? { name: imported.name, specifier: imported.specifier } : undefined;
    const fact: RouteFact = { via: r.via, framework: r.framework, methods: r.methods, path: r.path, from, to, ...(handler ? { handler } : {}) };
    const under = prefixes.get(r.via)!;
    if (!under.length) waiting.push(fact);
    for (const prefix of under) {
      const node = routeNode(ctx.rel, fact, prefix, ctx.mint);
      if (!node) continue;
      nodes.push(node);
      edges.push(...routeEdges(ctx.rel, node.id, handler));
    }
  }
  // A mount of an object this file does not define may be one another file's facts resolve.
  const outward = read.mounts.some((m) => m.attr || !read.objects.has(m.child));
  if (!waiting.length && !outward) return { nodes, edges };
  const facts: RouteFacts = { objects: Object.fromEntries(read.objects), mounts: read.mounts, routes: waiting };
  if (read.requires && Object.keys(read.requires).length) facts.requires = read.requires;
  if (read.exports && Object.keys(read.exports).length) facts.exports = read.exports;
  return { nodes, edges, facts };
}
