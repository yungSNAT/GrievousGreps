/**
 * HTTP routes as graph nodes, so an Ingress path can reach the handler that serves it.
 *
 * A route is read only when its full path is known in its own file: registered on an
 * application object (FastAPI, Flask, Express, a Go `net/http` mux), or on a router that
 * file mounts (`include_router`, `register_blueprint`, `use`). A router mounted only from
 * another file, a path that is not a plain string literal, or a segment that is partly a
 * parameter gives no route: nothing is guessed. Each route is a `resource` node named
 * `<METHODS> <path>`, with `{name}` for a one-segment parameter and `{name...}` for the
 * rest of the path; `deploy.ts` links an Ingress path to the routes it can serve.
 */
import { contentHash } from "../util/id.js";
import { isTestPath } from "../util/paths.js";
import type { SyntaxNode } from "./depth-parser.js";
import type { Language, RawEdge } from "./extract.js";
import type { NodeV1 } from "./types.js";

type Seg = { lit: string } | { param: string } | { rest: string };

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
  prefix: Seg[];
  /** Flask: a `url_prefix` given at registration replaces the blueprint's own. */
  replaces?: true;
}

interface Found {
  at: SyntaxNode;
  via: string;
  methods: string[];
  path: Seg[];
  handler: string | null;
}

interface Read {
  objects: Map<string, Obj>;
  mounts: Mount[];
  routes: Found[];
}

const MAX_PREFIXES = 8;

// ── Paths ───────────────────────────────────────────────────────────────────

const PLAIN = /^[^:*?()+[\]{}<>\\]+$/;

/** A path's segments; null when one is not plain, partly a parameter, or a rest that is not last. */
function segments(path: string, one: (seg: string) => Seg | null): Seg[] | null {
  if (path !== "" && !path.startsWith("/")) return null;
  const out: Seg[] = [];
  for (const s of path.split("/").filter(Boolean)) {
    if (out.length && "rest" in out[out.length - 1]) return null;
    const seg = PLAIN.test(s) ? { lit: s } : one(s);
    if (!seg) return null;
    out.push(seg);
  }
  return out;
}

const expressSeg = (s: string): Seg | null => {
  const m = /^(?::([A-Za-z_$][\w$]*)|\*([A-Za-z_$][\w$]*)?)$/.exec(s);
  return !m ? null : m[1] ? { param: m[1] } : { rest: m[2] ?? "" };
};

const fastapiSeg = (s: string): Seg | null => {
  const m = /^\{([A-Za-z_]\w*)(?::(\w+))?\}$/.exec(s);
  return !m ? null : m[2] === "path" ? { rest: m[1] } : { param: m[1] };
};

const flaskSeg = (s: string): Seg | null => {
  const m = /^<(?:(\w+)(?:\([^)]*\))?:)?([A-Za-z_]\w*)>$/.exec(s);
  return !m ? null : m[1] === "path" ? { rest: m[2] } : { param: m[2] };
};

const goSeg = (s: string): Seg | null => {
  const m = /^\{([A-Za-z_]\w*)(\.\.\.)?\}$/.exec(s);
  return !m ? null : m[2] ? { rest: m[1] } : { param: m[1] };
};

/** A Go 1.22 pattern: `[METHOD ][HOST]/path`, a trailing `/` matching the subtree below it. */
function goPattern(pattern: string): { methods: string[]; path: Seg[] } | null {
  const m = /^(?:([A-Z]+)\s+)?[^/\s]*(\/.*)$/.exec(pattern);
  if (!m) return null;
  let path = m[2];
  let subtree = false;
  if (path.endsWith("/{$}")) path = path.slice(0, -3);
  else if (path.endsWith("/")) subtree = true;
  const segs = segments(path, goSeg);
  if (!segs) return null;
  if (subtree && !(segs.length && "rest" in segs[segs.length - 1])) segs.push({ rest: "" });
  return { methods: m[1] ? [m[1]] : [], path: segs };
}

function canonical(path: Seg[]): string {
  return `/${path.map((s) => ("lit" in s ? s.lit : "param" in s ? `{${s.param}}` : `{${s.rest}...}`)).join("/")}`;
}

function parseCanonical(path: string): Seg[] {
  return path.split("/").filter(Boolean).map((s) => {
    const m = /^\{(.*?)(\.\.\.)?\}$/.exec(s);
    return !m ? { lit: s } : m[2] ? { rest: m[1] } : { param: m[1] };
  });
}

/**
 * Whether an Ingress path of `type` can send a request to `route` (a route node's name), by
 * whole segments: `Exact` needs the whole route, any other type a route at or below the path.
 * A parameter matches any one segment; a rest parameter, everything after it.
 */
export function routeServes(ingressPath: string, type: string, route: string): boolean {
  const segs = parseCanonical(route.slice(route.indexOf(" ") + 1));
  const want = ingressPath.split("/").filter(Boolean);
  for (let i = 0; i < want.length; i++) {
    const s = segs[i];
    if (!s) return false;
    if ("rest" in s) return true;
    if ("lit" in s && s.lit !== want[i]) return false;
  }
  if (type !== "Exact") return true;
  return segs.length === want.length || (segs.length === want.length + 1 && "rest" in segs[want.length]);
}

// ── Literals ────────────────────────────────────────────────────────────────

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

function readPython(root: SyntaxNode): Read {
  // Local names bound to the frameworks' classes, and to the modules themselves.
  const classes = new Map<string, string>();
  const modules = new Set<string>();
  for (const st of root.namedChildren) {
    if (st.type === "import_from_statement") {
      const mod = st.childForFieldName("module_name")?.text ?? "";
      if (!/^(fastapi|flask)(\.|$)/.test(mod)) continue;
      for (const n of st.namedChildren.slice(1)) {
        const name = n.type === "aliased_import" ? n.childForFieldName("name")?.text : n.text;
        const local = n.type === "aliased_import" ? n.childForFieldName("alias")?.text : n.text;
        if (name && local && Object.hasOwn(PY_CTORS, name)) classes.set(local, name);
      }
    } else if (st.type === "import_statement") {
      for (const n of st.namedChildren) {
        const name = n.type === "aliased_import" ? n.childForFieldName("name")?.text : n.text;
        const local = n.type === "aliased_import" ? n.childForFieldName("alias")?.text : n.text;
        if ((name === "fastapi" || name === "flask") && local) modules.add(local);
      }
    }
  }
  const ctorOf = (call: SyntaxNode): string | null => {
    const f = call.childForFieldName("function");
    if (f?.type === "identifier") return classes.get(f.text) ?? null;
    if (f?.type === "attribute" && modules.has(f.childForFieldName("object")?.text ?? "")) {
      const attr = f.childForFieldName("attribute")?.text ?? "";
      return Object.hasOwn(PY_CTORS, attr) ? attr : null;
    }
    return null;
  };
  const prefix = (node: SyntaxNode | undefined, flask: boolean): Seg[] | null => {
    if (!node) return [];
    const s = literal(node);
    return s === null ? null : segments(s, flask ? flaskSeg : fastapiSeg);
  };

  const objects = new Map<string, Obj>();
  const known = new Set<string>();
  const flaskNames = new Set<string>();
  const mounts: Mount[] = [];
  const routes: Found[] = [];
  for (const n of descendants(root)) {
    if (n.type === "assignment") {
      const left = n.childForFieldName("left");
      if (left?.type !== "identifier") continue;
      const right = n.childForFieldName("right");
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
      if (method === "include_router" || method === "register_blueprint") {
        const child = positional[0];
        const flask = method === "register_blueprint";
        const p = prefix(keyword.get(flask ? "url_prefix" : "prefix"), flask);
        if (child?.type === "identifier" && p) {
          mounts.push({ parent: parent.text, child: child.text, prefix: p, ...(flask && keyword.has("url_prefix") ? { replaces: true as const } : {}) });
        }
      } else if (method === "mount") {
        const p = literal(positional[0]);
        const segs = p === null ? null : segments(p, fastapiSeg);
        if (positional[1]?.type === "identifier" && segs) mounts.push({ parent: parent.text, child: positional[1].text, prefix: segs });
      }
    } else if (n.type === "decorated_definition") {
      const def = n.childForFieldName("definition");
      const handler = def?.type === "function_definition" ? def.childForFieldName("name")?.text ?? null : null;
      if (!handler) continue;
      for (const d of n.namedChildren) {
        const call = d.type === "decorator" ? d.namedChildren[0] : null;
        const f = call?.type === "call" ? call.childForFieldName("function") : null;
        const via = f?.type === "attribute" ? f.childForFieldName("object") : null;
        const method = f?.childForFieldName("attribute")?.text ?? "";
        if (!call || via?.type !== "identifier") continue;
        const flask = flaskNames.has(via.text);
        const { positional, keyword } = pyArgs(call);
        let methods: string[];
        if (PY_METHODS.has(method)) methods = [method.toUpperCase()];
        else if ((flask && method === "route") || (!flask && method === "api_route")) {
          const listed = keyword.get("methods");
          const names = listed ? (listed.type === "list" || listed.type === "tuple" ? listed.namedChildren.map(literal) : [null]) : ["GET"];
          if (names.some((m) => m === null || !/^[A-Za-z]+$/.test(m))) continue;
          methods = (names as string[]).map((m) => m.toUpperCase());
        } else continue;
        const raw = literal(positional[0] ?? keyword.get(flask ? "rule" : "path"));
        const path = raw === null ? null : segments(raw, flask ? flaskSeg : fastapiSeg);
        if (path) routes.push({ at: n, via: via.text, methods, path, handler });
      }
    }
  }
  return { objects: onlyKnown(objects, known), mounts, routes };
}

/** The objects a framework constructor made; other names are kept only to count assignments. */
function onlyKnown(objects: Map<string, Obj>, known: Set<string>): Map<string, Obj> {
  return new Map([...objects].filter(([name]) => known.has(name)));
}

// ── JavaScript and TypeScript: Express ──────────────────────────────────────

const JS_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);

function readExpress(root: SyntaxNode): Read {
  const express = new Set<string>();
  const routers = new Set<string>();
  const fromExpress = (n: SyntaxNode | null | undefined) => literal(n) === "express";
  for (const n of descendants(root)) {
    if (n.type === "import_statement" && fromExpress(n.childForFieldName("source"))) {
      const clause = n.namedChildren.find((c) => c.type === "import_clause");
      for (const c of clause?.namedChildren ?? []) {
        if (c.type === "identifier") express.add(c.text);
        for (const s of c.type === "named_imports" ? c.namedChildren : []) {
          if (s.childForFieldName("name")?.text === "Router") routers.add((s.childForFieldName("alias") ?? s.childForFieldName("name"))!.text);
        }
      }
    } else if (n.type === "variable_declarator") {
      const value = n.childForFieldName("value");
      const required = value?.type === "call_expression" && value.childForFieldName("function")?.text === "require"
        && fromExpress(value.childForFieldName("arguments")?.namedChildren[0]);
      if (!required) continue;
      const name = n.childForFieldName("name");
      if (name?.type === "identifier") express.add(name.text);
      for (const p of name?.type === "object_pattern" ? name.namedChildren : []) {
        if (p.type === "shorthand_property_identifier_pattern" && p.text === "Router") routers.add("Router");
        if (p.type === "pair_pattern" && p.childForFieldName("key")?.text === "Router") {
          const v = p.childForFieldName("value");
          if (v?.type === "identifier") routers.add(v.text);
        }
      }
    }
  }
  const made = (value: SyntaxNode | null): Omit<Obj, "count"> | null => {
    if (value?.type !== "call_expression") return null;
    const f = value.childForFieldName("function");
    if (f?.type === "identifier" && express.has(f.text)) return { app: true, own: [] };
    if (f?.type === "identifier" && routers.has(f.text)) return { app: false, own: [] };
    if (f?.type === "member_expression" && express.has(f.childForFieldName("object")?.text ?? "") && f.childForFieldName("property")?.text === "Router") {
      return { app: false, own: [] };
    }
    return null;
  };

  const objects = new Map<string, Obj>();
  const known = new Set<string>();
  const mounts: Mount[] = [];
  const routes: Found[] = [];
  if (!express.size && !routers.size) return { objects, mounts, routes };
  for (const n of descendants(root)) {
    if (n.type === "variable_declarator" || n.type === "assignment_expression") {
      const name = n.childForFieldName(n.type === "variable_declarator" ? "name" : "left");
      if (name?.type === "identifier") assign(objects, name.text, made(n.childForFieldName(n.type === "variable_declarator" ? "value" : "right")), known);
    } else if (n.type === "call_expression") {
      const f = n.childForFieldName("function");
      const parent = f?.type === "member_expression" ? f.childForFieldName("object") : null;
      const method = f?.childForFieldName("property")?.text ?? "";
      if (parent?.type !== "identifier") continue;
      const args = (n.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "comment");
      if (method === "use") {
        const first = literal(args[0]);
        const prefix = first === null ? (args[0]?.type === "string" ? null : []) : segments(first, expressSeg);
        if (!prefix) continue;
        for (const a of args.slice(first === null ? 0 : 1)) {
          if (a.type === "identifier") mounts.push({ parent: parent.text, child: a.text, prefix });
        }
      } else if (JS_METHODS.has(method) && args.length >= 2) {
        const raw = literal(args[0]);
        const path = raw === null ? null : segments(raw, expressSeg);
        const last = args[args.length - 1];
        if (path) routes.push({ at: n, via: parent.text, methods: method === "all" ? [] : [method.toUpperCase()], path, handler: last.type === "identifier" ? last.text : null });
      }
    }
  }
  return { objects: onlyKnown(objects, known), mounts, routes };
}

// ── Go: net/http ────────────────────────────────────────────────────────────

/** The default mux's key: no Go identifier holds a space. */
const DEFAULT_MUX = "http DefaultServeMux";

function readGo(root: SyntaxNode, goImports: ReadonlyMap<string, string>): Read {
  const http = [...goImports].find(([, path]) => path === "net/http")?.[0];
  const objects = new Map<string, Obj>();
  const known = new Set<string>();
  const mounts: Mount[] = [];
  const routes: Found[] = [];
  if (!http || http === "_" || http === ".") return { objects, mounts, routes };
  objects.set(DEFAULT_MUX, { app: true, own: [], count: 1 });
  known.add(DEFAULT_MUX);
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
        if (name.type === "identifier" && name.text !== "_") assign(objects, name.text, isNewMux(values[i]) ? { app: true, own: [] } : null, known);
      });
    } else if (n.type === "call_expression") {
      const f = n.childForFieldName("function");
      const method = f?.type === "selector_expression" ? f.childForFieldName("field")?.text : undefined;
      if (method === "Handle" || method === "HandleFunc") handles.push(n);
    }
  }
  // `http` shadowed by a local of that name is not the package.
  if (objects.get(http)?.count) return { objects: new Map(), mounts, routes };
  for (const n of handles) {
    const f = n.childForFieldName("function")!;
    const operand = f.childForFieldName("operand")!;
    const via = operand.text === http ? DEFAULT_MUX : operand.type === "identifier" ? operand.text : null;
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
  return { objects: onlyKnown(objects, known), mounts, routes };
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
    for (const p of prefixesOf(read, m.parent, depth + 1)) out.push([...p, ...(m.replaces ? m.prefix : [...m.prefix, ...o.own])]);
  }
  return out.slice(0, MAX_PREFIXES);
}

export interface RouteContext {
  rel: string;
  source: string;
  lang: Language;
  /** The file's nodes so far, for a handler defined in it. */
  nodes: readonly NodeV1[];
  importedSymbols: ReadonlyMap<string, { name: string; specifier: string }>;
  goImports: ReadonlyMap<string, string>;
  mint: (base: string) => string;
}

/** The file's routes as nodes, with `contains` and handler `references` edges. */
export function extractRoutes(root: SyntaxNode, ctx: RouteContext): { nodes: NodeV1[]; edges: RawEdge[] } {
  // A file that never names a framework is not walked a second time; a test serves nothing.
  const read = isTestPath(ctx.rel) ? null : ctx.lang === "python" ? (/fastapi|flask/.test(ctx.source) ? readPython(root) : null)
    : ctx.lang === "typescript" || ctx.lang === "tsx" ? (ctx.source.includes("express") ? readExpress(root) : null)
      : ctx.lang === "go" ? readGo(root, ctx.goImports)
        : null;
  const nodes: NodeV1[] = [];
  const edges: RawEdge[] = [];
  if (!read?.routes.length) return { nodes, edges };
  const prefixes = new Map<string, Seg[][]>();
  for (const r of read.routes) {
    if (!prefixes.has(r.via)) prefixes.set(r.via, prefixesOf(read, r.via));
    for (const prefix of prefixes.get(r.via)!) {
      if (prefix.length && "rest" in prefix[prefix.length - 1]) continue;
      const name = `${r.methods.length ? r.methods.join("|") : "ANY"} ${canonical([...prefix, ...r.path])}`;
      const id = ctx.mint(`${ctx.rel}#route:${name}`);
      const signature = `route ${name}`;
      nodes.push({
        id, name, kind: "resource", path: ctx.rel, span: `L${r.at.startPosition.row + 1}-L${r.at.endPosition.row + 1}`,
        signature, exported: false, origin: "ast", body_hash: contentHash(signature), body_text: name,
        summary_state: "pending", summary: null, crux: null,
      });
      edges.push({ source: ctx.rel, relation: "contains", file: ctx.rel, targetId: id });
      if (!r.handler) continue;
      // A decorated def is the registration itself; a named handler is a top-level definition.
      const from = r.at.startPosition.row + 1;
      const to = r.at.endPosition.row + 1;
      const startOf = (n: NodeV1) => Number(/^L(\d+)/.exec(n.span)?.[1]);
      const local = ctx.nodes.find((n) => n.kind !== "file" && n.name === r.handler && startOf(n) >= from && startOf(n) <= to)
        ?? ctx.nodes.find((n) => n.id === `${ctx.rel}#${r.handler}` && n.kind !== "file");
      const imported = ctx.importedSymbols.get(r.handler);
      if (local) edges.push({ source: id, relation: "references", file: ctx.rel, targetId: local.id });
      else if (imported) edges.push({ source: id, relation: "references", file: ctx.rel, name: imported.name, specifier: imported.specifier });
    }
  }
  return { nodes, edges };
}
