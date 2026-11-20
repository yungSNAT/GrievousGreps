/** One segment of a Docker glob: `**`, or a test per character with `*` for any run of them. */
export type GlobSegment = "**" | Array<"*" | ((c: string) => boolean)>;

/**
 * A COPY or ADD source as Docker reads it (Go's `filepath.Match`, plus `**`): `*` and `?`
 * within one path segment, `[a-z]` and `[^a-z]` classes; null for a malformed class.
 * shortcut: a backslash is a literal character here, not an escape; a source escaping a
 * wildcard therefore matches as a wildcard. Upgrade path: read `\` as Go does.
 */
export function compileGlob(glob: string): GlobSegment[] | null {
  const out: GlobSegment[] = [];
  for (const part of glob.split("/")) {
    if (part === "**") {
      out.push("**");
      continue;
    }
    const tokens: Array<"*" | ((c: string) => boolean)> = [];
    let i = 0;
    while (i < part.length) {
      const c = part[i];
      if (c === "*") {
        if (tokens.at(-1) !== "*") tokens.push("*");
      } else if (c === "?") tokens.push(() => true);
      else if (c === "[") {
        const close = part.indexOf("]", i + 1);
        if (close < 0) return null;
        let body = part.slice(i + 1, close);
        const negate = body.startsWith("^");
        if (negate) body = body.slice(1);
        if (!body) return null;
        const ranges: Array<[string, string]> = [];
        for (let j = 0; j < body.length; j++) {
          if (body[j + 1] === "-" && j + 2 < body.length) {
            ranges.push([body[j], body[j + 2]]);
            j += 2;
          } else ranges.push([body[j], body[j]]);
        }
        tokens.push((x) => ranges.some(([lo, hi]) => lo <= x && x <= hi) !== negate);
        i = close + 1;
        continue;
      } else tokens.push((x) => x === c);
      i++;
    }
    out.push(tokens);
  }
  return out;
}

/** One segment against one name, in O(pattern × name): the last `*` takes one more character on a mismatch. */
function segmentMatches(tokens: Array<"*" | ((c: string) => boolean)>, name: string): boolean {
  let t = 0;
  let i = 0;
  let star = -1;
  let mark = 0;
  while (i < name.length) {
    const tok = tokens[t];
    if (tok !== undefined && tok !== "*" && tok(name[i])) {
      t++;
      i++;
    } else if (tok === "*") {
      star = t++;
      mark = i;
    } else if (star >= 0) {
      t = star + 1;
      i = ++mark;
    } else return false;
  }
  while (tokens[t] === "*") t++;
  return t === tokens.length;
}

/** Whether a glob names a path, or a folder holding it (COPY copies a folder's contents). */
export function globMatches(glob: GlobSegment[], path: string): boolean {
  const parts = path.split("/");
  // at[j]: the glob's segments so far match the path's first j parts.
  let at = new Array<boolean>(parts.length + 1).fill(false);
  at[0] = true;
  for (const seg of glob) {
    const next = new Array<boolean>(parts.length + 1).fill(false);
    for (let j = 0; j <= parts.length; j++) {
      if (!at[j]) continue;
      if (seg === "**") next.fill(true, j);
      else if (j < parts.length && segmentMatches(seg, parts[j])) next[j + 1] = true;
    }
    at = next;
  }
  return at.some(Boolean);
}

/** The first index in the sorted file paths at or after the given path. */
function lower(files: string[], path: string): number {
  let lo = 0;
  let hi = files.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (files[mid] < path) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Yield the file itself and indexed descendants in binary path order. */
export function* filesUnder(files: string[], fileSet: Set<string>, path: string): Iterable<string> {
  if (path === ".") {
    yield* files;
    return;
  }
  if (fileSet.has(path)) yield path;
  // '0' is the next character after '/', so the range contains all descendants.
  const end = lower(files, path + "0");
  for (let i = lower(files, path + "/"); i < end; i++) yield files[i];
}
