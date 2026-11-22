/**
 * Route paths: each framework's path syntax read into segments, the one form route nodes are
 * named in, and whether an Ingress path can reach a route (`routes.ts` reads the routes,
 * `deploy.ts` links them).
 */
export type Seg = { lit: string } | { param: string; type?: string } | { rest: string };

/** Whose path rules a route follows: its converters and whether its rest of the path may be empty. */
export type Framework = "fastapi" | "flask" | "express" | "go";

/** A path's segments, and whether it ends in a `/` that the framework matches literally. */
export interface RoutePath {
  segs: Seg[];
  trailing: boolean;
}


const PLAIN = /^[^:*?()+[\]{}<>\\]+$/;
/** What each converter accepts in one segment, as Werkzeug (Flask) and Starlette (FastAPI) define it. */
const TYPES: Partial<Record<Framework, Record<string, RegExp>>> = {
  flask: {
    int: /^\d+$/,
    float: /^\d+\.\d+$/,
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  },
  fastapi: {
    int: /^\d+$/,
    float: /^\d+(?:\.\d+)?$/,
    uuid: /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i,
  },
};

/** Whether a rest parameter also takes nothing: Starlette's `path` and Go's `...` do, Werkzeug's `path` and Express 5's `*name` do not. */
const emptyRest = (framework: string, name: string) => framework === "fastapi" || framework === "go" || name === "";

/** A path's segments; null when one is not plain, partly a parameter, or a rest that is not last. */
export function segments(path: string, one: (seg: string) => Seg | null): RoutePath | null {
  if (path !== "" && !path.startsWith("/")) return null;
  const segs: Seg[] = [];
  for (const s of path.split("/").filter(Boolean)) {
    if (segs.length && "rest" in segs[segs.length - 1]) return null;
    const seg = PLAIN.test(s) ? { lit: s } : one(s);
    if (!seg) return null;
    segs.push(seg);
  }
  return { segs, trailing: path.endsWith("/") };
}

/** A converter name as a segment: a type the matcher can check, the rest of the path, or null. */
function converted(name: string, conv: string | undefined, framework: "fastapi" | "flask"): Seg | null {
  if (conv === undefined || conv === (framework === "flask" ? "string" : "str")) return { param: name };
  if (conv === "path") return { rest: name };
  return Object.hasOwn(TYPES[framework]!, conv) ? { param: name, type: conv } : null;
}

export const expressSeg = (s: string): Seg | null => {
  const m = /^(?::([A-Za-z_$][\w$]*)|\*([A-Za-z_$][\w$]*)?)$/.exec(s);
  return !m ? null : m[1] ? { param: m[1] } : { rest: m[2] ?? "" };
};

export const fastapiSeg = (s: string): Seg | null => {
  const m = /^\{([A-Za-z_]\w*)(?::(\w+))?\}$/.exec(s);
  return m ? converted(m[1], m[2], "fastapi") : null;
};

export const flaskSeg = (s: string): Seg | null => {
  const m = /^<(?:(\w+):)?([A-Za-z_]\w*)>$/.exec(s);
  return m ? converted(m[2], m[1], "flask") : null;
};

const goSeg = (s: string): Seg | null => {
  const m = /^\{([A-Za-z_]\w*)(\.\.\.)?\}$/.exec(s);
  return !m ? null : m[2] ? { rest: m[1] } : { param: m[1] };
};

/** A Go 1.22 pattern `[METHOD ]/path`: a trailing `/` matches the subtree below it, `/{$}` only itself. A host gives null. */
export function goPattern(pattern: string): { methods: string[]; path: RoutePath } | null {
  const m = /^(?:([A-Z]+)\s+)?(\/.*)$/.exec(pattern);
  if (!m) return null;
  const exact = m[2].endsWith("/{$}");
  const path = segments(exact ? m[2].slice(0, -3) : m[2], goSeg);
  if (!path) return null;
  if (!exact && path.trailing) {
    path.segs.push({ rest: "" });
    path.trailing = false;
  }
  return { methods: m[1] ? [m[1]] : [], path };
}

export function canonical(segs: Seg[], trailing: boolean): string {
  const body = segs.map((s) => ("lit" in s ? s.lit : "param" in s ? `{${s.param}${s.type ? `:${s.type}` : ""}}` : `{${s.rest}...}`)).join("/");
  return `/${body}${trailing && segs.length ? "/" : ""}`;
}

function parseCanonical(path: string): RoutePath {
  const segs = path.split("/").filter(Boolean).map((s): Seg => {
    const m = /^\{([^:}.]*)(?::(\w+))?(\.\.\.)?\}$/.exec(s);
    return !m ? { lit: s } : m[3] ? { rest: m[1] } : m[2] ? { param: m[1], type: m[2] } : { param: m[1] };
  });
  return { segs, trailing: path.length > 1 && path.endsWith("/") };
}

/**
 * Whether an Ingress path of `type` can send a request to `route` (a route node's name), by
 * whole segments, by `framework`'s rules. `Exact` needs the whole route, trailing `/`
 * included; `Prefix` a route at or below the path. A parameter matches one segment its
 * converter accepts; a rest parameter one or more segments, and also the bare trailing `/`
 * where the framework lets it be empty. `ImplementationSpecific` depends on the controller,
 * so it matches nothing.
 */
export function routeServes(ingressPath: string, type: string, route: string, framework: string): boolean {
  if (type !== "Exact" && type !== "Prefix") return false;
  const { segs, trailing } = parseCanonical(route.slice(route.indexOf(" ") + 1));
  const want = ingressPath.split("/").filter(Boolean);
  const types = TYPES[framework as Framework] ?? {};
  for (let i = 0; i < want.length; i++) {
    const s = segs[i];
    if (!s) return false;
    if ("rest" in s) return true;
    if ("lit" in s ? s.lit !== want[i] : s.type !== undefined && !types[s.type]?.test(want[i])) return false;
  }
  if (type === "Prefix") return true;
  const wantTrailing = ingressPath.endsWith("/");
  if (segs.length === want.length) return want.length === 0 || trailing === wantTrailing;
  const next = segs[want.length];
  return segs.length === want.length + 1 && next !== undefined && "rest" in next && emptyRest(framework, next.rest) && wantTrailing;
}
