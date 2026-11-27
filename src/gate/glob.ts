/**
 * Dependency-free, linear/polynomial-safe POSIX path glob compiler and matcher.
 *
 * Supports `*`, `**`, `?`, `[a-z]` / `[!a-z]` / `[^a-z]` character classes, and
 * `{a,b}` brace alternation on Node >=22.3.0 without regex backtracking.
 */

type SegmentToken = "*" | ((c: string) => boolean);
type CompiledSegment = "globstar" | SegmentToken[];

export interface CompiledGlob {
  alternatives: CompiledSegment[][];
}

const MAX_BRACE_EXPANSIONS = 64;

/** Verify a glob is a clean repo-relative path without leading/trailing `/` or `.`/`..` segments. */
export function assertRepoRelativeGlob(pattern: string, original = pattern): void {
  if (!pattern) {
    throw new Error(`glob "${original}" expands to an empty pattern`);
  }
  if (pattern.startsWith("/")) {
    throw new Error(`glob "${original}" must be repo-relative (remove leading "/")`);
  }
  if (pattern.endsWith("/")) {
    throw new Error(
      `glob "${original}" must not end with "/" (use "${pattern}**" to match files inside the directory)`,
    );
  }
  const parts = pattern.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new Error(
      `glob "${original}" must be a clean repo-relative path without empty, ".", or ".." segments`,
    );
  }
}

function findBracePair(pattern: string): { open: number; close: number; parts: string[] } | null {
  let depth = 0;
  let inClass = false;
  let open = -1;
  const parts: string[] = [];
  let partStart = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
    } else if (ch === "{") {
      if (depth === 0) {
        open = i;
        partStart = i + 1;
      }
      depth++;
    } else if (ch === "}") {
      if (depth === 0) throw new Error(`unmatched "}" in glob "${pattern}"`);
      depth--;
      if (depth === 0) {
        parts.push(pattern.slice(partStart, i));
        return { open, close: i, parts };
      }
    } else if (ch === "," && depth === 1) {
      parts.push(pattern.slice(partStart, i));
      partStart = i + 1;
    }
  }
  if (depth !== 0) throw new Error(`unclosed "{" in glob "${pattern}"`);
  return null;
}

function expandBraces(pattern: string): string[] {
  const queue = [pattern];
  const out: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const pair = findBracePair(cur);
    if (!pair) {
      out.push(cur);
      if (out.length > MAX_BRACE_EXPANSIONS) {
        throw new Error(`glob expands to more than ${MAX_BRACE_EXPANSIONS} alternatives: "${pattern}"`);
      }
      continue;
    }
    if (pair.parts.every((p) => p === "")) {
      throw new Error(`invalid empty brace group "{}" in glob "${pattern}"`);
    }
    const prefix = cur.slice(0, pair.open);
    const suffix = cur.slice(pair.close + 1);
    for (const part of pair.parts) {
      queue.push(`${prefix}${part}${suffix}`);
      if (queue.length + out.length > MAX_BRACE_EXPANSIONS) {
        throw new Error(`glob expands to more than ${MAX_BRACE_EXPANSIONS} alternatives: "${pattern}"`);
      }
    }
  }
  return out;
}

function compileSegment(part: string, fullPattern: string): CompiledSegment {
  if (part === "**") return "globstar";
  const tokens: SegmentToken[] = [];
  let i = 0;
  while (i < part.length) {
    const c = part[i]!;
    if (c === "*") {
      if (tokens.at(-1) !== "*") tokens.push("*");
      i++;
    } else if (c === "?") {
      tokens.push(() => true);
      i++;
    } else if (c === "[") {
      const close = part.indexOf("]", i + 1);
      if (close < 0) throw new Error(`unclosed "[" in glob "${fullPattern}"`);
      let body = part.slice(i + 1, close);
      const negate = body.startsWith("^") || body.startsWith("!");
      if (negate) body = body.slice(1);
      if (!body) throw new Error(`invalid empty character class in glob "${fullPattern}"`);
      const ranges: Array<[string, string]> = [];
      for (let j = 0; j < body.length; j++) {
        if (body[j + 1] === "-" && j + 2 < body.length) {
          ranges.push([body[j]!, body[j + 2]!]);
          j += 2;
        } else {
          ranges.push([body[j]!, body[j]!]);
        }
      }
      tokens.push((x) => ranges.some(([lo, hi]) => lo <= x && x <= hi) !== negate);
      i = close + 1;
    } else {
      tokens.push((x) => x === c);
      i++;
    }
  }
  return tokens;
}

function compileAlternative(alt: string, original: string): CompiledSegment[] {
  assertRepoRelativeGlob(alt, original);
  const out: CompiledSegment[] = [];
  for (const part of alt.split("/")) {
    const seg = compileSegment(part, original);
    if (seg === "globstar" && out.at(-1) === "globstar") continue;
    out.push(seg);
  }
  return out;
}

/** Validate and compile a normalized repo-relative POSIX glob pattern. */
export function compilePosixGlob(pattern: string): CompiledGlob {
  assertRepoRelativeGlob(pattern, pattern);
  const expanded = expandBraces(pattern);
  return {
    alternatives: expanded.map((alt) => compileAlternative(alt, pattern)),
  };
}

function matchSegmentTokens(tokens: SegmentToken[], name: string): boolean {
  let t = 0;
  let i = 0;
  let star = -1;
  let mark = 0;
  while (i < name.length) {
    const tok = tokens[t];
    if (tok !== undefined && tok !== "*" && tok(name[i]!)) {
      t++;
      i++;
    } else if (tok === "*") {
      star = t++;
      mark = i;
    } else if (star >= 0) {
      t = star + 1;
      i = ++mark;
    } else {
      return false;
    }
  }
  while (tokens[t] === "*") t++;
  return t === tokens.length;
}

function matchSegments(segments: CompiledSegment[], pathParts: string[]): boolean {
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = 0;
  while (s < pathParts.length) {
    const seg = segments[p];
    if (seg === "globstar") {
      starP = p++;
      starS = s;
    } else if (seg !== undefined && matchSegmentTokens(seg, pathParts[s]!)) {
      p++;
      s++;
    } else if (starP >= 0) {
      p = starP + 1;
      s = ++starS;
    } else {
      return false;
    }
  }
  // A standalone "**" matches any path, whereas a trailing "/**" requires >=1 segment.
  if (segments.length === 1 && segments[0] === "globstar") return true;
  return p === segments.length;
}

/** Match a repo-relative POSIX path against a compiled glob. */
export function matchesCompiledGlob(glob: CompiledGlob, path: string): boolean {
  const parts = path.split("/");
  return glob.alternatives.some((alt) => matchSegments(alt, parts));
}
