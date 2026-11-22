/**
 * Turning a report into code a reader can see.
 *
 * `blast` knows which lines changed (git's hunks) and which symbols reach them
 * (the walk), and both the hosted panel and the PR comment want to SHOW that
 * rather than cite a line number the reader has to go and look up. The shaping
 * lives here so the two surfaces quote the same lines: a comment that disagreed
 * with the page it links to would be worse than one that said less.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deployFormatOf } from "../graph/deploy.js";
import type { Evidence, EvidenceLine } from "../viz/assemble.js";
import type { Impacted, Seed } from "./blast.js";
import type { ChangedFile, DiffLine } from "./diff.js";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Symbols given their own snippet per node. Past this the panel is a file listing
 * rather than a summary — the rest are still counted in the headline. */
export const MAX_EVIDENCE = 4;
/** Lines shown per snippet before it folds. A handful is a hunk you can read at a
 * glance; a 30-line refactor is a diff view's job, not a panel's. */
const MAX_LINES = 6;

/** `L12-L34` → the numbers, so a label is something a reader can type. */
export function spanRange(span: string): { start: number; end: number } | null {
  const m = /^L(\d+)(?:-L(\d+))?$/.exec(span);
  if (!m) return null;
  const start = Number(m[1]);
  return { start, end: m[2] === undefined ? start : Number(m[2]) };
}

function labelFor(name: string, path: string, span: string): string {
  const r = spanRange(span);
  return r ? `${name} · ${path}:${r.start}-${r.end}` : `${name} · ${path}`;
}

/** Keep the first {@link MAX_LINES}, and say how many were left. */
function fold(lines: EvidenceLine[]): { lines: EvidenceLine[]; more?: number } {
  if (lines.length <= MAX_LINES) return { lines };
  return { lines: lines.slice(0, MAX_LINES), more: lines.length - MAX_LINES };
}

const asEvidenceLines = (lines: DiffLine[]): EvidenceLine[] =>
  lines.map((l) => ({ n: l.n, sign: l.sign, text: l.text }));

/**
 * The hunks of `file` that fall inside `span`.
 *
 * A file's diff is split by symbol rather than shown whole, because two unrelated
 * edits in one file are two answers — a panel that merges them makes the reader do
 * the separating.
 */
function hunksIn(
  file: ChangedFile,
  span: { start: number; end: number } | null,
): { lines: EvidenceLine[]; dropped: number } {
  const out: EvidenceLine[] = [];
  let dropped = 0;
  for (const h of file.hunks) {
    if (span && (h.end < span.start || h.start > span.end)) continue;
    out.push(...asEvidenceLines(h.lines));
    dropped += h.dropped;
  }
  return { lines: out, dropped };
}

/** Evidence for one changed symbol: what this PR did to it. */
export function seedEvidence(seed: Seed, file: ChangedFile | undefined): Evidence | null {
  if (!file || deployFormatOf(file.path) || (file.oldPath && deployFormatOf(file.oldPath))) return null;
  const span = seed.wholeFile ? null : spanRange(seed.span);
  const { lines, dropped } = hunksIn(file, span);
  if (lines.length === 0 && dropped === 0) return null;
  const folded = fold(lines);
  const more = (folded.more ?? 0) + dropped;
  return {
    label: seed.wholeFile ? seed.path : labelFor(seed.name, seed.path, seed.span),
    note: file.status === "added" ? "new file" : seed.wholeFile ? "outside any symbol" : undefined,
    lines: folded.lines,
    more: more > 0 ? more : undefined,
  };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The first line inside a span that mentions one of `needles`, with its number.
 *
 * This is the whole trick behind "why is this symbol here": the edge says A calls
 * B, and this finds the line where it does it. Shared so `blast`'s panel, its
 * comment and `graft callers` all quote the same line for the same edge. With
 * `inCode`, a mention in a string or a comment does not count ({@link codeOf}).
 */
export function referenceLine(
  path: string,
  span: string,
  needles: RegExp[],
  read: (path: string) => string[] | null,
  inCode = false,
): { n: number; text: string; needle: number } | null {
  const range = spanRange(span);
  const lines = read(path);
  if (!range || !lines) return null;
  const syntax = inCode ? syntaxOf(path) : null;
  let open: string | null = null;
  for (const [i, text] of lines.slice(range.start - 1, range.end).entries()) {
    let seen = text;
    // A name in a string or a comment is text about the symbol, not a use of it.
    if (syntax) ({ code: seen, open } = codeOf(text, syntax, open));
    const needle = needles.findIndex((re) => re.test(seen));
    if (needle >= 0) return { n: range.start + i, text, needle };
  }
  return null;
}

/** Extensions whose line comments start with `#`, and those whose start with `--`. */
const HASH_COMMENTS = new Set(["py", "pyi", "rb", "sh", "bash", "zsh", "pl", "pm", "r", "ex", "exs", "jl", "nim", "cr", "coffee", "tcl", "ps1", "php"]);
const DASH_COMMENTS = new Set(["lua", "sql", "hs", "elm", "ada", "adb", "ads"]);

/** Whether a quote opens at `text[i]`. A `'` between digits (`1'000`) does not, nor, in Rust, one that is no char literal (a lifetime). */
export function opensQuote(text: string, i: number, rust: boolean): boolean {
  const ch = text[i];
  if (ch === '"' || ch === "`") return true;
  if (ch !== "'" || (/\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? ""))) return false;
  return !rust || /^'(?:[^'\\]|\\[^']{1,9})'/.test(text.slice(i));
}

/** How a file writes comments, by its extension, as blast's `codeLines` reads them. */
interface Syntax { slash: boolean; dash: boolean; hash: boolean; rust: boolean; go: boolean; js: boolean }

const JS_EXTENSIONS = new Set(["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"]);

export function syntaxOf(path: string): Syntax {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const hash = HASH_COMMENTS.has(ext);
  const dash = DASH_COMMENTS.has(ext);
  return { hash, dash, slash: ext === "php" || (!hash && !dash), rust: ext === "rs", go: ext === "go", js: JS_EXTENSIONS.has(ext) };
}

/** Where the string or block comment `open` closes at or after `i` (past its last character), or -1 when it runs past
 * the line. `open` is its closing text; an `r` before it marks a raw string, where a backslash escapes nothing, as in
 * a block comment. Backslash escapes count in other strings. */
function closeOf(text: string, i: number, open: string): number {
  if (open === "*/" || open.startsWith("r")) {
    const close = open === "*/" ? open : open.slice(1);
    const end = text.indexOf(close, i);
    return end < 0 ? -1 : end + close.length;
  }
  let j = i;
  while (j < text.length) {
    if (text.startsWith(open, j)) return j + open.length;
    j += text[j] === "\\" ? 2 : 1;
  }
  return -1;
}

/** Words after which a `/` starts a regex literal, not a division. */
const BEFORE_REGEX = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"]);

/** Where a JavaScript regex literal starting at `text[i]` ends, past its flags, or -1 when the `/` divides the value
 * before it (a name, a number, a string or a closing bracket), closes a JSX tag (`</td>`, `/>`) or the line ends first. */
function regexEnd(text: string, i: number): number {
  if (text[i + 1] === ">") return -1;
  let k = i - 1;
  while (k >= 0 && (text[k] === " " || text[k] === "\t")) k--;
  if (text[k] === "<") return -1;
  if (k >= 0 && /[\w$)\]'"`]/.test(text[k])) {
    let s = k;
    while (s > 0 && /[\w$]/.test(text[s - 1])) s--;
    if (!BEFORE_REGEX.has(text.slice(s, k + 1))) return -1;
  }
  let inClass = false;
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") j++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      j++;
      while (j < text.length && /[a-z]/i.test(text[j])) j++;
      return j;
    }
    j++;
  }
  return -1;
}

/** A Rust raw string's opening (`r"`, `r#"`, `br##"`), matched at `lastIndex`. */
const RUST_RAW = /[bc]?r(#*)"/y;

/**
 * A line with each string, regex literal and comment blanked to one space, and the string or block comment still open
 * at its end: a block comment, a triple-quoted string, a backtick string and a Rust string run on to the next line;
 * other `"` and `'` strings close with their line. `open` is what the previous line left open, as {@link closeOf}
 * reads it. Comments are read as {@link syntaxOf} says.
 */
function codeOf(text: string, syntax: Syntax, open: string | null): { code: string; open: string | null } {
  let code = "";
  let i = 0;
  if (open) {
    const end = closeOf(text, 0, open);
    if (end < 0) return { code, open };
    code = " ";
    i = end;
    open = null;
  }
  while (i < text.length) {
    const ch = text[i];
    // Where the string or comment just opened starts its text.
    let from = i + 1;
    RUST_RAW.lastIndex = i;
    const raw = syntax.rust && /[bcr]/.test(ch) && !/\w/.test(text[i - 1] ?? "") ? RUST_RAW.exec(text) : null;
    const regex = syntax.js && ch === "/" ? regexEnd(text, i) : -1;
    // `\/*` is an escaped slash in a regex literal (`/\/*$/`), never a comment.
    if (syntax.slash && text.startsWith("/*", i) && text[i - 1] !== "\\") [open, from] = ["*/", i + 2];
    else if ((syntax.slash && text.startsWith("//", i)) || (syntax.dash && text.startsWith("--", i)) || (syntax.hash && ch === "#" && (i === 0 || /\s/.test(text[i - 1])))) break;
    else if (regex > 0) {
      code += " ";
      i = regex;
      continue;
    } else if (text.startsWith('"""', i) || text.startsWith("'''", i)) [open, from] = [text.slice(i, i + 3), i + 3];
    else if (raw) [open, from] = [`r"${raw[1]}`, i + raw[0].length];
    else if (syntax.go && ch === "`") open = "r`";
    else if (opensQuote(text, i, syntax.rust)) open = ch;
    else code += ch;
    if (open) {
      const end = closeOf(text, from, open);
      if (end < 0) return { code, open: open === "'" || (open === '"' && !syntax.rust) ? null : open };
      code += " ";
      i = end;
      open = null;
    } else i++;
  }
  return { code, open: null };
}

/** A symbol name, matched as a whole word — `export` must not hit `exportViz`. */
export const wordRe = (name: string): RegExp => new RegExp(`\\b${escapeRe(name)}\\b`);

/**
 * Evidence for one dependent symbol: the line that reaches the diff.
 *
 * Nothing changed here, so there is no hunk to show — the useful line is the one
 * naming a changed symbol or module, which answers "why am I in this blast radius
 * at all". Found by reading the symbol's span off disk.
 *
 * When no line names the diff, this returns nothing rather than quoting the span's
 * first line: for a file-level dependent that first line is `/**`, and a panel that
 * shows it has spent a code block to say nothing.
 */
export function impactedEvidence(
  sym: Impacted,
  reach: ReachTerms,
  read: (path: string) => string[] | null,
): Evidence | null {
  // A changed symbol's own name is the strongest signal; a file-level dependent
  // usually reaches the diff through its import line, which names a MODULE
  // instead, so both are tried in that order.
  const byName = referenceLine(sym.path, sym.span, reach.names.map(wordRe), read, true);
  if (byName) {
    return {
      label: labelFor(sym.name, sym.path, sym.span),
      note: `${sym.relation} ${reach.names[byName.needle]}`,
      lines: [{ n: byName.n, sign: " ", text: byName.text }],
    };
  }

  const byModule = referenceLine(sym.path, sym.span, reach.modules, read);
  if (byModule) {
    return {
      label: labelFor(sym.name, sym.path, sym.span),
      note: sym.relation,
      lines: [{ n: byModule.n, sign: " ", text: byModule.text }],
    };
  }

  // No line names the diff — an indirect reach (a dynamic import, a re-export),
  // or a symbol whose whole file is the span. Quoting its first line means
  // quoting `/**`, so the block is dropped instead: the path stays in `sources`
  // and the panel simply says less.
  return null;
}

/** What a line has to mention to be the line that reaches the diff. */
export interface ReachTerms {
  /** Changed symbol names, longest first. */
  names: string[];
  /** `from "./data.js"` for each changed file, matched on the module specifier so
   * a common stem like `data` cannot match a variable of the same name. */
  modules: RegExp[];
}

export function reachTerms(seeds: Seed[], changed: ChangedFile[]): ReachTerms {
  const names = [...new Set(seeds.filter((s) => !s.wholeFile).map((s) => s.name))].sort((a, b) => b.length - a.length);
  const stems = [...new Set(changed.map((f) => f.path.replace(/\.[^./]+$/, "").split("/").pop() ?? ""))].filter(Boolean);
  return {
    names,
    modules: stems.map((stem) => new RegExp(`["'\`][^"'\`]*\\b${escapeRe(stem)}(\\.[a-z]+)?["'\`]`)),
  };
}

/** Read each file once, and never fail: a snippet is a nicety, and a symbol whose
 * file moved under us must not take the whole page down. */
export function fileReader(root: string | undefined): (path: string) => string[] | null {
  const cache = new Map<string, string[] | null>();
  return (path: string) => {
    // A deployment file's lines can hold a Secret's or an environment's values: never quoted.
    if (root === undefined || deployFormatOf(path)) return null;
    const hit = cache.get(path);
    if (hit !== undefined) return hit;
    let lines: string[] | null = null;
    try {
      lines = readFileSync(join(root, path), "utf8").split("\n");
    } catch {
      // Deleted, renamed under us, or unreadable: no snippet, no failure.
      lines = null;
    }
    cache.set(path, lines);
    return lines;
  };
}
