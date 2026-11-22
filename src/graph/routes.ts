/**
 * HTTP routes as graph nodes, so an Ingress path can reach the handler that serves it.
 *
 * A route is read only when its full path is known in its own file: registered on an
 * application object (FastAPI, Flask, Express, a Go `net/http` mux), or on a router that
 * file mounts (`include_router`, `register_blueprint`, `use`). A router mounted only from
 * another file or under a prefix that is not a plain string, a path that is not a plain
 * string literal, a segment that is partly a parameter or uses an unknown converter, a Go
 * pattern with a host, or a name a function parameter shadows gives no route: nothing is
 * guessed. Each route is a `resource` node named `<METHODS> <path>`, with `{name}` for a
 * one-segment parameter (`{name:int}` when a converter restricts it), `{name...}` for the
 * rest of the path and a trailing `/` kept where the framework treats it as part of the
 * path; `deploy.ts` links an Ingress path to the routes it can serve.
 */
import { contentHash } from "../util/id.js";
import { isTestPath } from "../util/paths.js";
import type { SyntaxNode } from "./depth-parser.js";
import type { Language, RawEdge } from "./extract.js";
import type { NodeV1 } from "./types.js";
import { canonical, expressSeg, fastapiSeg, flaskSeg, goPattern, segments, type RoutePath, type Seg } from "./route-paths.js";

interface Obj {
  app: boolean;
  own: Seg[];
  /** Assignments to the name in the file; a route on a name assigned twice is not read. */
  count: number;
  /** A Go mux handed to another handler: served under a prefix this file does not show. */
  mounted?: true;
}

interface Mount {
  parent: string;
  child: string;
  /** Null when the prefix is not known: the child then gives no routes at all. */
  prefix: Seg[] | null;
  /** Flask: a `url_prefix` given at registration replaces the blueprint's own. */
  replaces?: true;
}

interface Found {
  at: SyntaxNode;
  via: string;
  methods: string[];
  path: RoutePath;
  /** A handler name to resolve, unless a parameter or local around the registration shadows it. */
  handler: string | null;
  /** The handler is the decorated definition itself. */
  decorated?: true;
}

interface Read {
  objects: Map<string, Obj>;
  mounts: Mount[];
  routes: Found[];
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

function* descendants(node: SyntaxNode): Iterable<SyntaxNode> {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop()!;
    yield n;
    for (let i = n.namedChildren.length - 1; i >= 0; i--) stack.push(n.namedChildren[i]);
  }
}

const FUNCTIONS = new Set([
  "function_definition", "lambda", // Python
  "function_declaration", "function_expression", "function", "arrow_function", "method_definition",
  "generator_function_declaration", "generator_function", // JavaScript and TypeScript
  "method_declaration", "func_literal", // Go (function_declaration is shared)
]);

const isName = (n: SyntaxNode | null | undefined, name: string) => n?.type === "identifier" && n.text === name;

/** Whether `n` binds `name` in its own scope: an assignment, declaration, loop target or definition. */
function declares(n: SyntaxNode, name: string): boolean {
  switch (n.type) {
    case "assignment": case "for_statement": case "for_in_statement": return isName(n.childForFieldName("left"), name);
    case "variable_declarator": case "function_declaration": case "function_definition": return isName(n.childForFieldName("name"), name);
    case "short_var_declaration": return (n.childForFieldName("left")?.namedChildren ?? []).some((c) => isName(c, name));
    case "var_spec": return n.namedChildren.some((c) => isName(c, name));
    default: return false;
  }
}

/**
 * Whether a function around `node` takes `name` as a parameter, or with `locals` binds it in
 * its body, so the name at `node` is not the file's. Errs towards shadowed, which drops a route
 * or handler edge rather than guessing one.
 */
function shadowed(node: SyntaxNode, name: string, locals: boolean): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (!FUNCTIONS.has(p.type)) continue;
    const params = p.childForFieldName("parameters") ?? p.childForFieldName("parameter");
    if (params && [...descendants(params)].some((n) => isName(n, name))) return true;
    const body = p.childForFieldName("body");
    if (locals && body && [...descendants(body)].some((n) => declares(n, name))) return true;
  }
  return false;
}

function objectFor(objects: Map<string, Obj>, name: string): Obj {
  let o = objects.get(name);
  if (!o) objects.set(name, (o = { app: false, own: [], count: 0 }));
  return o;
}

/** Records one assignment to `name`; `made` when it constructs an application or router. */
function assign(objects: Map<string, Obj>, name: string, made: Omit<Obj, "count"> | null, known: Set<string>): void {
  const o = objectFor(objects, name);
  o.count++;
  if (made) {
    o.app = made.app;
    o.own = made.own;
    known.add(name);
  }
}

/** The objects a framework constructor made; other names are kept only to count assignments. */
function onlyKnown(objects: Map<string, Obj>, known: Set<string>): Map<string, Obj> {
  return new Map([...objects].filter(([name]) => known.has(name)));
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

function readPython(root: SyntaxNode): Read | null {
  // Local names bound to the frameworks' classes, and to the modules themselves.
  const classes = new Map<string, string>();
  const modules = new Set<string>();
  for (const st of root.namedChildren) {
    const from = st.type === "import_from_statement" ? st.childForFieldName("module_name")?.text ?? "" : null;
    if (from !== null && !/^(fastapi|flask)(\.|$)/.test(from)) continue;
    if (from === null && st.type !== "import_statement") continue;
    for (const n of from === null ? st.namedChildren : st.namedChildren.slice(1)) {
      const name = n.type === "aliased_import" ? n.childForFieldName("name")?.text : n.text;
      const local = n.type === "aliased_import" ? n.childForFieldName("alias")?.text : n.text;
      if (!name || !local) continue;
      if (from !== null && Object.hasOwn(PY_CTORS, name)) classes.set(local, name);
      if (from === null && (name === "fastapi" || name === "flask")) modules.add(local);
    }
  }
  if (!classes.size && !modules.size) return null;
  const ctorOf = (call: SyntaxNode): string | null => {
    const f = call.childForFieldName("function");
    if (f?.type === "identifier") return classes.has(f.text) && !shadowed(call, f.text, true) ? classes.get(f.text)! : null;
    const mod = f?.type === "attribute" ? f.childForFieldName("object") : null;
    if (mod?.type === "identifier" && modules.has(mod.text) && !shadowed(call, mod.text, true)) {
      const attr = f!.childForFieldName("attribute")?.text ?? "";
      return Object.hasOwn(PY_CTORS, attr) ? attr : null;
    }
    return null;
  };
  const prefix = (node: SyntaxNode | undefined, flask: boolean): Seg[] | null => {
    if (!node) return [];
    const s = literal(node);
    return s === null ? null : segments(s, flask ? flaskSeg : fastapiSeg)?.segs ?? null;
  };

  const objects = new Map<string, Obj>();
  const known = new Set<string>();
  const flaskNames = new Set<string>();
  const mounts: Mount[] = [];
  const routes: Found[] = [];
  for (const n of descendants(root)) {
    if (n.type === "assignment" || n.type === "for_statement") {
      const left = n.childForFieldName("left");
      if (left?.type !== "identifier") continue;
      const right = n.type === "assignment" ? n.childForFieldName("right") : null;
      const ctor = right?.type === "call" ? ctorOf(right) : null;
      let made: Omit<Obj, "count"> | null = null;
      if (ctor && right) {
        const spec = PY_CTORS[ctor];
        const own = spec.prefix ? prefix(pyArgs(right).keyword.get(spec.prefix), spec.flask) : [];
        if (own) made = { app: spec.app, own };
        if (spec.flask) flaskNames.add(left.text);
      }
      assign(objects, left.text, made, known);
    } else if (n.type === "call") {
      const f = n.childForFieldName("function");
      if (f?.type !== "attribute") continue;
      const parent = f.childForFieldName("object");
      const method = f.childForFieldName("attribute")?.text;
      if (parent?.type !== "identifier") continue;
      const { positional, keyword } = pyArgs(n);
      const child = method === "mount" ? positional[1] : positional[0];
      if (child?.type !== "identifier") continue;
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
      if (shadowed(n, parent.text, false) || shadowed(n, child.text, false)) p = null;
      mounts.push({ parent: parent.text, child: child.text, prefix: p, ...(replaces ? { replaces: true as const } : {}) });
    } else if (n.type === "decorated_definition") {
      const def = n.childForFieldName("definition");
      const handler = def?.type === "function_definition" ? def.childForFieldName("name")?.text ?? null : null;
      if (!handler) continue;
      for (const d of n.namedChildren) {
        const call = d.type === "decorator" ? d.namedChildren[0] : null;
        const f = call?.type === "call" ? call.childForFieldName("function") : null;
        const via = f?.type === "attribute" ? f.childForFieldName("object") : null;
        const method = f?.childForFieldName("attribute")?.text ?? "";
        if (!call || via?.type !== "identifier" || shadowed(n, via.text, false)) continue;
        const flask = flaskNames.has(via.text);
        const { positional, keyword } = pyArgs(call);
        let methods: string[];
        if (PY_METHODS.has(method)) methods = [method.toUpperCase()];
        else if ((flask && method === "route") || (!flask && method === "api_route")) {
          const listed = keyword.get("methods");
          const names = listed ? (listed.type === "list" || listed.type === "tuple" ? listed.namedChildren.map(literal) : [null]) : ["GET"];
          // An empty list is not 'any method': it is read as no route.
          if (!names.length || names.some((m) => m === null || !/^[A-Za-z]+$/.test(m))) continue;
          methods = (names as string[]).map((m) => m.toUpperCase());
        } else continue;
        const raw = literal(positional[0] ?? keyword.get(flask ? "rule" : "path"));
        const path = raw === null ? null : segments(raw, flask ? flaskSeg : fastapiSeg);
        if (path) routes.push({ at: n, via: via.text, methods, path, handler, decorated: true });
      }
    }
  }
  return { objects: onlyKnown(objects, known), mounts, routes };
}

// ── JavaScript and TypeScript: Express ──────────────────────────────────────

const JS_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);

/** `use`'s first argument as a path: a plain string, a known object (no path), a function (no path), or unknown. */
function usePath(arg: SyntaxNode | undefined, objects: Map<string, Obj>): Seg[] | null | "objects" {
  if (!arg) return null;
  if (arg.type === "string") {
    const s = literal(arg);
    return s === null ? null : segments(s, expressSeg)?.segs ?? null;
  }
  if (arg.type === "identifier") return objects.has(arg.text) ? "objects" : null;
  return arg.type === "call_expression" || arg.type === "arrow_function" || arg.type === "function_expression" || arg.type === "function" ? "objects" : null;
}

function readExpress(root: SyntaxNode): Read | null {
  const express = new Set<string>();
  const routers = new Set<string>();
  const fromExpress = (n: SyntaxNode | null | undefined) => literal(n) === "express";
  // Imports and `require` calls at the top level only.
  for (const st of root.namedChildren) {
    if (st.type === "import_statement" && fromExpress(st.childForFieldName("source"))) {
      const clause = st.namedChildren.find((c) => c.type === "import_clause");
      for (const c of clause?.namedChildren ?? []) {
        if (c.type === "identifier") express.add(c.text);
        for (const s of c.type === "named_imports" ? c.namedChildren : []) {
          if (s.childForFieldName("name")?.text === "Router") routers.add((s.childForFieldName("alias") ?? s.childForFieldName("name"))!.text);
        }
      }
    }
    if (st.type !== "lexical_declaration" && st.type !== "variable_declaration") continue;
    for (const d of st.namedChildren.filter((c) => c.type === "variable_declarator")) {
      const value = d.childForFieldName("value");
      const required = value?.type === "call_expression" && value.childForFieldName("function")?.text === "require"
        && fromExpress(value.childForFieldName("arguments")?.namedChildren[0]);
      if (!required) continue;
      const name = d.childForFieldName("name");
      if (name?.type === "identifier") express.add(name.text);
      for (const p of name?.type === "object_pattern" ? name.namedChildren : []) {
        if (p.type === "shorthand_property_identifier_pattern" && p.text === "Router") routers.add("Router");
        const v = p.type === "pair_pattern" && p.childForFieldName("key")?.text === "Router" ? p.childForFieldName("value") : null;
        if (v?.type === "identifier") routers.add(v.text);
      }
    }
  }
  if (!express.size && !routers.size) return null;
  const made = (value: SyntaxNode | null): Omit<Obj, "count"> | null => {
    if (value?.type !== "call_expression") return null;
    const call = value;
    const f = call.childForFieldName("function");
    const own = (name: string, app: boolean) => (shadowed(call, name, true) ? null : { app, own: [] });
    if (f?.type === "identifier" && express.has(f.text)) return own(f.text, true);
    if (f?.type === "identifier" && routers.has(f.text)) return own(f.text, false);
    const obj = f?.type === "member_expression" ? f.childForFieldName("object")?.text ?? "" : "";
    if (express.has(obj) && f!.childForFieldName("property")?.text === "Router") return own(obj, false);
    return null;
  };

  const objects = new Map<string, Obj>();
  const known = new Set<string>();
  const uses: Array<{ at: SyntaxNode; parent: string; args: SyntaxNode[] }> = [];
  const routes: Found[] = [];
  for (const n of descendants(root)) {
    if (n.type === "variable_declarator" || n.type === "assignment_expression" || n.type === "for_in_statement") {
      const name = n.childForFieldName(n.type === "variable_declarator" ? "name" : "left");
      const value = n.type === "for_in_statement" ? null : n.childForFieldName(n.type === "variable_declarator" ? "value" : "right");
      if (name?.type === "identifier") assign(objects, name.text, made(value), known);
    } else if (n.type === "call_expression") {
      const f = n.childForFieldName("function");
      const parent = f?.type === "member_expression" ? f.childForFieldName("object") : null;
      const method = f?.childForFieldName("property")?.text ?? "";
      if (parent?.type !== "identifier") continue;
      const args = (n.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "comment");
      if (method === "use") uses.push({ at: n, parent: parent.text, args });
      else if (JS_METHODS.has(method) && args.length >= 2 && !shadowed(n, parent.text, false)) {
        const raw = literal(args[0]);
        // Express matches with or without a trailing slash by default.
        const path = raw === null ? null : segments(raw, expressSeg);
        const last = args[args.length - 1];
        if (path) {
          routes.push({ at: n, via: parent.text, methods: method === "all" ? [] : [method.toUpperCase()], path: { segs: path.segs, trailing: false }, handler: last.type === "identifier" ? last.text : null });
        }
      }
    }
  }
  const objectsMade = onlyKnown(objects, known);
  const mounts: Mount[] = [];
  for (const u of uses) {
    const first = usePath(u.args[0], objectsMade);
    const path = first === "objects" ? [] : first;
    const shadow = shadowed(u.at, u.parent, false);
    for (const a of u.args.slice(first === "objects" ? 0 : 1)) {
      if (a.type === "identifier") mounts.push({ parent: u.parent, child: a.text, prefix: shadow || shadowed(u.at, a.text, false) ? null : path });
    }
  }
  return { objects: objectsMade, mounts, routes };
}

// ── Go: net/http ────────────────────────────────────────────────────────────

/** The default mux's key: no Go identifier holds a space. */
const DEFAULT_MUX = "http DefaultServeMux";

function readGo(root: SyntaxNode, goImports: ReadonlyMap<string, string>): Read | null {
  const http = [...goImports].find(([, path]) => path === "net/http")?.[0];
  if (!http || http === "_" || http === ".") return null;
  const objects = new Map<string, Obj>([[DEFAULT_MUX, { app: true, own: [], count: 1 }]]);
  const known = new Set<string>([DEFAULT_MUX]);
  const routes: Found[] = [];
  const isNewMux = (v: SyntaxNode | undefined) => {
    const f = v?.type === "call_expression" ? v.childForFieldName("function") : null;
    return f?.type === "selector_expression" && f.childForFieldName("operand")?.text === http && f.childForFieldName("field")?.text === "NewServeMux";
  };
  const handles: SyntaxNode[] = [];
  for (const n of descendants(root)) {
    if (n.type === "short_var_declaration" || n.type === "assignment_statement" || n.type === "var_spec") {
      const names = n.type === "var_spec"
        ? n.namedChildren.filter((c) => c.type === "identifier")
        : n.childForFieldName("left")?.namedChildren ?? [];
      const values = (n.type === "var_spec" ? n.childForFieldName("value") : n.childForFieldName("right"))?.namedChildren ?? [];
      names.forEach((name, i) => {
        if (name.type === "identifier" && name.text !== "_") assign(objects, name.text, isNewMux(values[i]) && !shadowed(n, http, false) ? { app: true, own: [] } : null, known);
      });
    } else if (n.type === "call_expression") {
      const f = n.childForFieldName("function");
      const method = f?.type === "selector_expression" ? f.childForFieldName("field")?.text : undefined;
      if (method === "Handle" || method === "HandleFunc") handles.push(n);
    }
  }
  // `http` assigned in the file is not the package.
  if (objects.get(http)?.count) return null;
  for (const n of handles) {
    const f = n.childForFieldName("function")!;
    const operand = f.childForFieldName("operand")!;
    const pkg = operand.text === http && !shadowed(n, http, false);
    const via = pkg ? DEFAULT_MUX : operand.type === "identifier" && !shadowed(n, operand.text, false) ? operand.text : null;
    const args = (n.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "comment");
    for (const id of args[1] ? descendants(args[1]) : []) {
      const mux = id.type === "identifier" && known.has(id.text) ? objects.get(id.text) : undefined;
      if (mux) mux.mounted = true;
    }
    const raw = literal(args[0]);
    const pattern = raw === null ? null : goPattern(raw);
    if (!via || !pattern || args.length !== 2) continue;
    let h: SyntaxNode | null | undefined = args[1];
    if (f.childForFieldName("field")!.text === "Handle") {
      const conv = h.type === "call_expression" ? h.childForFieldName("function") : null;
      const wrapped = conv?.type === "selector_expression" && conv.childForFieldName("operand")?.text === http && conv.childForFieldName("field")?.text === "HandlerFunc";
      h = wrapped ? h.childForFieldName("arguments")?.namedChildren[0] : null;
    }
    routes.push({ at: n, via, ...pattern, handler: h?.type === "identifier" ? h.text : null });
  }
  return { objects: onlyKnown(objects, known), mounts: [], routes };
}

// ── Nodes ───────────────────────────────────────────────────────────────────

/** Every full prefix `name` is served under, or none when any step is unknown. */
function prefixesOf(read: Read, name: string, depth = 0): Seg[][] {
  const o = read.objects.get(name);
  if (!o || o.count !== 1 || o.mounted || depth > MAX_PREFIXES) return [];
  const into = read.mounts.filter((m) => m.child === name);
  if (!into.length) return o.app ? [o.own] : [];
  const out: Seg[][] = [];
  for (const m of into) {
    if (!m.prefix) return [];
    for (const p of prefixesOf(read, m.parent, depth + 1)) out.push([...p, ...(m.replaces ? m.prefix : [...m.prefix, ...o.own])]);
  }
  return out.slice(0, MAX_PREFIXES);
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

/** The file's routes as nodes, with `contains` and handler `references` edges. */
export function extractRoutes(root: SyntaxNode, ctx: RouteContext): { nodes: NodeV1[]; edges: RawEdge[] } {
  // Each reader returns null, after its imports alone, for a file that names no framework; a test serves nothing.
  const read = isTestPath(ctx.rel) ? null
    : ctx.lang === "python" ? readPython(root)
      : ctx.lang === "typescript" || ctx.lang === "tsx" ? readExpress(root)
        : ctx.lang === "go" ? readGo(root, ctx.goImports)
          : null;
  const nodes: NodeV1[] = [];
  const edges: RawEdge[] = [];
  if (!read?.routes.length) return { nodes, edges };
  const startOf = (n: NodeV1) => Number(/^L(\d+)/.exec(n.span)?.[1]);
  const byName = new Map<string, NodeV1[]>();
  for (const n of ctx.nodes) {
    if (n.kind === "file") continue;
    const list = byName.get(n.name);
    if (list) list.push(n);
    else byName.set(n.name, [n]);
  }
  const prefixes = new Map<string, Seg[][]>();
  for (const r of read.routes) {
    if (!prefixes.has(r.via)) prefixes.set(r.via, prefixesOf(read, r.via));
    const from = r.at.startPosition.row + 1;
    const to = r.at.endPosition.row + 1;
    // A decorated def is the registration itself; a named handler is a top-level definition or an import.
    const candidates = r.handler ? byName.get(r.handler) ?? [] : [];
    const local = !r.handler ? undefined
      : r.decorated ? candidates.find((n) => startOf(n) >= from && startOf(n) <= to)
        : shadowed(r.at, r.handler, true) ? undefined : candidates.find((n) => n.id === `${ctx.rel}#${r.handler}`);
    const imported = r.handler && !r.decorated && !local && !shadowed(r.at, r.handler, true) ? ctx.importedSymbols.get(r.handler) : undefined;
    for (const prefix of prefixes.get(r.via)!) {
      if (prefix.length && "rest" in prefix[prefix.length - 1]) continue;
      const name = `${r.methods.length ? r.methods.join("|") : "ANY"} ${canonical([...prefix, ...r.path.segs], r.path.trailing)}`;
      const id = ctx.mint(`${ctx.rel}#route:${name}`);
      const signature = `route ${name}`;
      nodes.push({
        id, name, kind: "resource", path: ctx.rel, span: `L${from}-L${to}`,
        signature, exported: false, origin: "ast", body_hash: contentHash(signature), body_text: name,
        summary_state: "pending", summary: null, crux: null,
      });
      edges.push({ source: ctx.rel, relation: "contains", file: ctx.rel, targetId: id });
      if (local) edges.push({ source: id, relation: "references", file: ctx.rel, targetId: local.id });
      else if (imported) edges.push({ source: id, relation: "references", file: ctx.rel, name: imported.name, specifier: imported.specifier });
    }
  }
  return { nodes, edges };
}
