/**
 * Blast radius of a diff: what else in the repo depends on the lines this change
 * touched.
 *
 * The whole command is a join between two things graft already has — git's changed
 * line ranges (`diff.ts`) and the wiring graph's incoming edges (`traverse.ts`) —
 * so there is no new graph logic here, only the seeding rule:
 *
 *   changed line → the innermost symbol whose span contains it → seed
 *
 * Seeding by SYMBOL rather than by file is what makes the answer worth reading: a
 * 400-line file with a one-line edit reports the dependents of that one function,
 * not of everything the file happens to define. The file node is seeded too, so
 * importers (whose edge targets the file, not the symbol) are still found.
 */
import { impactOfMany, type EdgeHit } from "../graph/traverse.js";
import type { GraphV1, NodeV1 } from "../graph/types.js";
import { dirLabel, moduleIndex, parentDir, shortLabel, type ModuleIndex } from "./modules.js";
import type { ChangedFile, Hunk, LineRange } from "./diff.js";
import { wordRe } from "./evidence.js";
import type { Owner, Reviewer } from "./owners.js";

const SPAN_RE = /^L(\d+)-L(\d+)$/;

/** A file's lines from the checkout, or null when it cannot be read. */
export type LineReader = (path: string) => string[] | null;

export interface BlastOptions {
  /** BFS depth over incoming edges; `Infinity` for the full closure. */
  depth: number;
  /** Concept/directory labels. Built from the context dir when omitted. */
  modules?: ModuleIndex;
  /** Reads the checkout, to find where a declaration ends and which of a caller's
   * lines name the changed symbol. Without it a declaration is its first line, and a
   * caller counts as edited when any line of its span changed. */
  read?: LineReader;
  /** Also list the test files the change reaches ({@link BlastReport.tests}). */
  tests?: boolean;
}

/** A changed symbol the walk started from. */
export interface Seed {
  id: string;
  name: string;
  kind: string;
  path: string;
  span: string;
  /** True for a whole-file seed (an added file, or a change outside any symbol). */
  wholeFile: boolean;
  /** The diff changed the declaration's text, from the span's first line to the end
   * of its signature, whitespace and a comma before a closing bracket aside. Its
   * callers can then need editing too ({@link LeftBehind}). */
  declarationChanged?: true;
}

/** A caller of a symbol whose declaration changed, where the diff did not edit the call. */
export interface LeftBehind {
  /** The changed symbol it calls. */
  seed: { id: string; name: string };
  id: string;
  name: string;
  kind: string;
  path: string;
  span: string;
  /** The caller's first line naming the changed symbol, when the file could be read. */
  line?: number;
  /** The call edge is inferred: a lead, not a fact. */
  inferred?: true;
}

/** A test file the change reaches over the full closure, whatever `--depth` says. */
export interface TestReach {
  path: string;
  /** Hops from the nearest changed symbol; 0 for a test file the diff edits. */
  depth: number;
  /** The diff edits this file. */
  changed?: true;
  /** Every reached symbol in it is inferred. */
  inferred?: true;
  /** Its reached symbols, nearest first. */
  symbols: string[];
}

/** One dependent symbol, and how the walk reached it. */
export interface Impacted {
  id: string;
  name: string;
  kind: string;
  path: string;
  span: string;
  relation: string;
  depth: number;
  /** Every shortest path to it crosses an inferred edge: a lead, not a fact ({@link EdgeHit}). */
  inferred?: true;
}

/**
 * Where a cluster's label came from — the rungs of the naming ladder.
 *
 * `concept` — a concept node from a `--deep` build claims every file in the cluster.
 * `named`   — `graft blast --name` asked a model to name this cluster (see name.ts).
 * `symbol`  — the deterministic backstop: the cluster's most significant symbol.
 *
 * A bare directory is never a label. The whole point of the picture is that a
 * reviewer reads what is affected, and `src/graph/` tells them nothing they could
 * not get from the diff — but it must never be replaced by a guess either, so the
 * backstop names a real symbol rather than inventing a feature name.
 */
export type LabelSource = "concept" | "named" | "symbol";

/** Dependents grouped for the diagram: the unit a reviewer actually thinks in. */
export interface ImpactedModule {
  label: string;
  labelSource: LabelSource;
  /** Stable identity for the cluster, independent of its label: the concept name
   * or the directory it was grouped by. Naming and its cache key hang off this. */
  key: string;
  files: string[];
  symbols: Impacted[];
  /** Changed files whose edges reached this module — the diagram's arrows. */
  from: string[];
  /** Who has worked on these files, best first. Filled in by `attachOwners`;
   * absent when the radius was taken outside a git repository. */
  owners?: Owner[];
}

/**
 * Whether the diff brought its tests along.
 *
 * `changed` — a test file that reaches this area was edited in this PR.
 * `stale`   — tests reach it and the diff left every one of them alone.
 * `none`    — nothing under `test/` reaches it at all.
 * `na`      — no function, method or class changed here, so there is nothing to
 *             ask the question of: a types-only file, or config and wiring.
 */
export type TestSignal = "changed" | "stale" | "none" | "na";

/** One area of the diff: the changed files a reviewer thinks of as one thing. */
export interface ChangedArea {
  label: string;
  labelSource: LabelSource;
  /** The directory the cluster was grouped by — see {@link ImpactedModule.key}. */
  key: string;
  /** Changed, indexed, non-test files grouped under this label. */
  files: string[];
  /** Changed symbols seeded from those files. */
  seeds: number;
  tests: TestSignal;
  /** Test files with an edge into this area, and those of them the diff changed. */
  testFiles: string[];
  changedTestFiles: string[];
  /** Test reach, over the area's exported functions/methods/classes only. */
  reached: number;
  behavioural: number;
  /** Names of the behavioural symbols no test reaches, for the collapsed detail. */
  unreached: string[];
  /** Changed symbol names, behaviour first — the backstop label and the naming
   * prompt both read from this. */
  seedNames: string[];
  /** Who has worked on these files, best first — see {@link ImpactedModule.owners}. */
  owners?: Owner[];
}

export interface BlastReport {
  basis: string;
  depth: number;
  changed: ChangedFile[];
  /** Changed paths the graph has no node for: unsupported language, or deleted. */
  unindexed: string[];
  /** Changed paths that were deleted, called out because their dependents are
   * unknowable from a graph built at the post-change commit. */
  deleted: string[];
  seeds: Seed[];
  impacted: Impacted[];
  modules: ImpactedModule[];
  /** The diff itself, grouped: the left-hand side of the diagram. */
  areas: ChangedArea[];
  /** Test-only dependents, kept out of `modules` so they cannot crowd it out. */
  testModules: ImpactedModule[];
  /** Who to tag, ranked across every area. Absent outside a git repository, and
   * empty when the author is the only person in the history. */
  reviewers?: Reviewer[];
  /** Calls naming a changed symbol that the build could not pin to one definition
   * (`graph.unresolvedCalls`). No edge carries them, so `impacted` may miss their
   * callers; the report says so, as `callers` does. The resolver (graph/resolve.ts)
   * records some of them: TypeScript and JavaScript calls through an import the
   * graph does not map; Python calls through a rebound name or a dotted module
   * path it cannot place; and Rust trait calls with several fitting impls, `self`
   * calls in an impl, lower-case member calls whose owner is ambiguous or unseen,
   * and free calls to a name defined more than once. Others are dropped
   * unrecorded, including ambiguous bare-name calls in every language and member
   * calls whose owner is ambiguous outside Rust. An empty list is therefore not
   * proof that every call resolved. */
  unresolved?: UnresolvedName[];
  /** Callers a declaration change left unedited. Only `calls` edges count, and a
   * caller still naming a symbol the diff removed or renamed is not found: the graph
   * is built after the change. */
  leftBehind?: LeftBehind[];
  /** Test files the change reaches. Present only when asked for (`--tests`). */
  tests?: TestReach[];
}

export interface UnresolvedName {
  name: string;
  calls: number;
}

/** Unresolved calls per changed symbol name, most first. */
function unresolvedForSeeds(graph: GraphV1, seeds: Seed[]): UnresolvedName[] {
  const names = new Set(seeds.filter((s) => !s.wholeFile).map((s) => s.name));
  const counts = new Map<string, number>();
  for (const c of graph.unresolvedCalls ?? []) {
    if (names.has(c.name)) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  }
  return [...counts].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

function spanBounds(span: string): { start: number; end: number } | null {
  const m = SPAN_RE.exec(span);
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
}

/**
 * The innermost symbols whose spans overlap any changed range in `path`.
 *
 * "Innermost" matters for a method: a changed line inside `Cache.get` overlaps both
 * the class span and the method span, and seeding the class would report everyone
 * who touches any part of `Cache`. Nesting is resolved by keeping, for each range,
 * only symbols that contain no other matched symbol.
 */
function seedsForFile(graph: GraphV1, path: string, ranges: { start: number; end: number }[]): NodeV1[] {
  const symbols: { node: NodeV1; start: number; end: number }[] = [];
  for (const n of graph.nodes) {
    if (n.kind === "file" || n.path !== path) continue;
    const b = spanBounds(n.span);
    if (b) symbols.push({ node: n, ...b });
  }
  if (symbols.length === 0) return [];

  const hit = new Map<string, NodeV1>();
  for (const r of ranges) {
    const overlapping = symbols.filter((s) => s.start <= r.end && s.end >= r.start);
    // Drop any symbol that strictly contains another overlapping one (the class
    // around a changed method), keeping the tightest description of the edit.
    for (const s of overlapping) {
      const containsAnother = overlapping.some(
        (o) => o !== s && o.start >= s.start && o.end <= s.end,
      );
      if (!containsAnother) hit.set(s.node.id, s.node);
    }
  }
  return [...hit.values()];
}

/** Compute the blast radius of `changed` against `graph`. */
export function blastRadius(
  graph: GraphV1,
  changed: ChangedFile[],
  basis: string,
  opts: BlastOptions,
): BlastReport {
  const fileNodes = new Map<string, NodeV1>();
  for (const n of graph.nodes) if (n.kind === "file") fileNodes.set(n.path, n);

  const seeds: Seed[] = [];
  const unindexed: string[] = [];
  const deleted: string[] = [];
  /** Seed nodes per changed file, kept for the area grouping and the test signal. */
  const seedNodes = new Map<string, NodeV1[]>();
  /** Merged dependents, keyed by node id, at the shallowest depth any file reached
   * them — plus which changed files did the reaching. */
  const merged = new Map<string, { hit: Impacted; from: Set<string> }>();
  /** Symbol seeds whose declaration the diff changed. */
  const declaredSeeds: NodeV1[] = [];
  /** Every hunk's removed lines: where a declaration moved as it stood is found. */
  const removed = changed.flatMap((f) => f.hunks.map((h) => squashLines(removedText(h))));

  for (const file of changed) {
    if (file.status === "deleted") {
      deleted.push(file.path);
      continue;
    }
    const fileNode = fileNodes.get(file.path);
    if (!fileNode) {
      unindexed.push(file.path);
      continue;
    }

    // No hunk ranges (a rename with no content change, a mode change) or an added
    // file: the unit of change is the file itself.
    const symbolSeeds = file.ranges.length > 0 ? seedsForFile(graph, file.path, file.ranges) : [];
    for (const node of symbolSeeds) {
      const declared = declarationChanged(node, file, removed, opts.read);
      if (declared) declaredSeeds.push(node);
      seeds.push({
        id: node.id, name: node.name, kind: node.kind, path: node.path, span: node.span, wholeFile: false,
        ...(declared ? { declarationChanged: true as const } : {}),
      });
    }
    if (symbolSeeds.length === 0) {
      seeds.push({
        id: fileNode.id, name: fileNode.name, kind: fileNode.kind,
        path: fileNode.path, span: fileNode.span, wholeFile: true,
      });
    }

    // One walk PER CHANGED FILE, not one walk over every seed at once. A combined
    // walk records the depth a node was first reached at but not by which seed, so
    // the diagram could only draw "every changed file reaches every module" — a
    // cross-product that tells a reviewer nothing. Walking per file costs one
    // adjacency build each (cheap: the graph is already in memory) and buys arrows
    // that are true.
    //
    // The FILE node is a seed only when no symbol matched. `imports` edges target
    // the file id, so seeding it alongside symbols would pull in every importer of
    // the file — a one-line edit to one function would report every module that
    // imports the module, which is the noise this command exists to avoid. With no
    // symbol seeds (a change to a top-level constant, a new import, a file with no
    // extracted symbols) the file IS the unit of change, and its importers are the
    // only dependents there are.
    const walkSeeds = symbolSeeds.length > 0 ? symbolSeeds : [fileNode];
    seedNodes.set(file.path, walkSeeds);
    const hits = impactOfMany(graph, walkSeeds, opts.depth, "in");
    for (const h of hits) {
      if (!hasNode(h)) continue;
      const hit = toImpacted(h);
      const prev = merged.get(hit.id);
      if (!prev) merged.set(hit.id, { hit, from: new Set([file.path]) });
      else {
        prev.from.add(file.path);
        // Keep the shallowest reach: a symbol two hops from one changed file and one
        // hop from another is one hop away from this PR. At the same depth a definite
        // path replaces an inferred one, as it does within one walk (`impactOfMany`).
        if (hit.depth < prev.hit.depth || (hit.depth === prev.hit.depth && prev.hit.inferred && !hit.inferred)) prev.hit = hit;
      }
    }
  }

  const impacted = [...merged.values()].map((m) => m.hit);
  const origins = new Map([...merged].map(([id, m]) => [id, m.from]));
  const index = opts.modules ?? emptyIndex();
  const grouped = groupByModule(impacted, changed, origins, index);

  return {
    basis,
    depth: opts.depth,
    changed,
    unindexed,
    deleted,
    seeds,
    impacted,
    modules: grouped.modules,
    testModules: grouped.testModules,
    areas: changedAreas(graph, changed, seedNodes, index, grouped.modules),
    unresolved: unresolvedForSeeds(graph, seeds),
    leftBehind: callersLeftBehind(graph, declaredSeeds, changed, opts.read),
    ...(opts.tests ? { tests: testsReached(graph, [...seedNodes.values()].flat(), changed) } : {}),
  };
}

/** Lines searched for the end of a wrapped signature or call. The searches read line
 * by line, and a longer signature or call is rare. */
const MAX_WRAPPED_LINES = 40;

/**
 * Declaration text as compared: whitespace dropped, and a comma before a closing
 * bracket, so wrapping or unwrapping a signature (a formatter's trailing comma
 * included) compares equal.
 */
const squash = (text: string): string => dropClosingCommas(text).replace(/\s+/g, "");

const dropClosingCommas = (text: string): string => text.replace(/,(?=\s*[)\]}>])/g, "");

const overlaps = (ranges: LineRange[], start: number, end: number): boolean =>
  ranges.some((r) => r.start <= end && r.end >= start);

/** A hunk that only deletes: git places it at the line before the gap. A hunk whose
 * lines fell past the text cap is never taken for one, so a long deletion reads as an edit. */
const pureDeletion = (h: Hunk): boolean => h.dropped === 0 && !h.lines.some((l) => l.sign === "+");

const removedText = (h: Hunk): string[] => h.lines.filter((l) => l.sign === "-").map((l) => l.text);

/**
 * Whether the file's diff touches lines `start` to `end` of the post-image. A pure
 * deletion counts only when its gap lies inside, before line `end`: deleting a
 * function's first statement, or the line after a call, leaves the gap after it.
 * With no hunk text, the ranges.
 */
function touches(file: ChangedFile | undefined, start: number, end: number): boolean {
  if (!file) return false;
  if (file.hunks.length === 0) return overlaps(file.ranges, start, end);
  return file.hunks.some((h) => (pureDeletion(h) ? h.start >= start && h.start < end : h.start <= end && h.end >= start));
}

/** Lines {@link squash}ed into one string, and the offset each line starts at. */
interface Squashed {
  text: string;
  starts: Set<number>;
}

function squashLines(lines: string[]): Squashed {
  let text = "";
  const starts = new Set<number>();
  // Commas go over the joined lines, so one ending a line before the next line's bracket goes too.
  for (const line of dropClosingCommas(lines.join("\n")).split("\n")) {
    starts.add(text.length);
    text += line.replace(/\s+/g, "");
  }
  return { text, starts };
}

/** Whether `needle` occurs in `hay` starting where one of its lines starts. */
function atLineStart(hay: Squashed, needle: string): boolean {
  for (let at = hay.text.indexOf(needle); at >= 0; at = hay.text.indexOf(needle, at + 1)) {
    if (hay.starts.has(at)) return true;
  }
  return false;
}

/**
 * The pre-image of post-image lines `start` to `end`, rebuilt from the hunks: each
 * hunk touching them gives its removed lines where it stands, every other line is
 * unchanged context. Widened to whole hunks, since a hunk's removed lines cannot be
 * split by line.
 */
function preImage(file: ChangedFile, lines: string[], start: number, end: number): Squashed {
  const near = file.hunks.filter((h) => h.start <= end && h.end >= start);
  const from = Math.min(start, ...near.filter((h) => !pureDeletion(h)).map((h) => h.start));
  const to = Math.max(end, ...near.map((h) => h.end));
  const old: string[] = [];
  let n = from;
  while (n <= to) {
    const rewritten = near.find((h) => !pureDeletion(h) && h.start === n);
    if (rewritten) {
      old.push(...removedText(rewritten));
      n = rewritten.end + 1;
      continue;
    }
    if (n <= lines.length) old.push(lines[n - 1]);
    for (const h of near) if (pureDeletion(h) && h.start === n) old.push(...removedText(h));
    n++;
  }
  return squashLines(old);
}

const count = (text: string, ch: string): number => text.split(ch).length - 1;

/**
 * A symbol's declaration: from the span's first line to where the signature the graph
 * recorded ends, and its text up to one character past the signature: enough to see a
 * return type removed, not so much that a body on the same line counts. Found by reading the
 * span until its squashed text contains the signature, which is how a parameter on
 * the third line of a wrapped signature counts. A signature left with a parenthesis
 * open (the generic tier stores only a signature's first line) runs on to where it
 * closes, and its text to the end of that line. Just the first line when the
 * signature is not found (the file moved on from the graph).
 */
function declaration(node: NodeV1, span: { start: number; end: number }, lines: string[]): { end: number; text: string } {
  const last = Math.min(span.end, span.start + MAX_WRAPPED_LINES - 1, lines.length);
  const signature = node.signature ? squash(node.signature) : "";
  for (let n = span.start; signature && n <= last; n++) {
    const text = squashLines(lines.slice(span.start - 1, n)).text;
    const at = text.indexOf(signature);
    if (at < 0) continue;
    if (count(signature, "(") <= count(signature, ")")) return { end: n, text: text.slice(0, at + signature.length + 1) };
    const end = Math.max(n, callEnd(lines, span.start, 0, last));
    return { end, text: squashLines(lines.slice(span.start - 1, end)).text };
  }
  return { end: span.start, text: squash(lines[span.start - 1] ?? "") };
}

/**
 * Whether the diff changed `node`'s declaration ({@link declaration}): the diff
 * touches its lines, and its text is not in their rebuilt pre-image, nor among any
 * hunk's removed lines (a declaration moved as it stood). Either is compared from the
 * start of a line, so a dropped `async` or `export` still counts. With no file to read,
 * any touch of the first line counts; with no hunk text, any touch of the declaration.
 */
function declarationChanged(node: NodeV1, file: ChangedFile, removed: Squashed[], read?: LineReader): boolean {
  const span = spanBounds(node.span);
  if (!span) return false;
  const lines = read?.(node.path);
  if (!lines || span.start > lines.length) return touches(file, span.start, span.start);
  const decl = declaration(node, span, lines);
  if (!touches(file, span.start, decl.end)) return false;
  if (file.hunks.length === 0) return true;
  return ![preImage(file, lines, span.start, decl.end), ...removed].some((old) => atLineStart(old, decl.text));
}

/**
 * The last line of a call whose name is on line `n` at column `at`: where the
 * parenthesis after the name closes, so a changed argument on a later line of a
 * wrapped call counts. Line `n` when no parenthesis follows the name on it. Strings
 * and comments are not parsed, though {@link callSite} passes lines with comments
 * blanked, and the scan stops after {@link MAX_WRAPPED_LINES}.
 */
function callEnd(lines: string[], n: number, at: number, last: number): number {
  let depth = 0;
  for (let i = n; i <= Math.min(last, n + MAX_WRAPPED_LINES - 1); i++) {
    for (const ch of i === n ? lines[i - 1].slice(at) : lines[i - 1]) {
      if (ch === "(") depth++;
      else if (ch === ")" && depth > 0 && --depth === 0) return i;
    }
    if (depth === 0) return n;
  }
  return n;
}

/** Extensions whose line comments start with `#`, and those whose start with `--`. */
const HASH_COMMENTS = new Set(["py", "pyi", "rb", "sh", "bash", "zsh", "pl", "pm", "r", "ex", "exs", "jl", "nim", "cr", "coffee", "tcl", "ps1", "php"]);
const DASH_COMMENTS = new Set(["lua", "sql", "hs", "elm", "ada", "adb", "ads"]);

/** Whether a quote opens at `text[i]`. A `'` between digits (`1'000`) does not, nor, in Rust, one that is no char literal (a lifetime). */
function opensQuote(text: string, i: number, rust: boolean): boolean {
  const ch = text[i];
  if (ch === '"' || ch === "`") return true;
  if (ch !== "'" || (/\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? ""))) return false;
  return !rust || /^'(?:[^'\\]|\\[^']{1,9})'/.test(text.slice(i));
}

/**
 * Lines `from` to `to` of `path` with comments blanked, indexed as `lines` is. `//`
 * and `/* *\/` comments (a block comment across lines too) except where `#` or `--`
 * starts a line comment instead ({@link HASH_COMMENTS}, {@link DASH_COMMENTS}; PHP
 * has both), and `#` only after whitespace there, so `$#` stays. Markers inside
 * quotes are text, so `"a // b"; f()` keeps `f()`; quotes pair within a line, with
 * backslash escapes. Blanked with spaces, so a column of the result is one of the line.
 */
function codeLines(lines: string[], from: number, to: number, path: string): string[] {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const hash = HASH_COMMENTS.has(ext);
  const dash = DASH_COMMENTS.has(ext);
  const slash = ext === "php" || (!hash && !dash);
  const code: string[] = [];
  let block = false;
  for (let n = from; n <= to; n++) {
    const text = lines[n - 1];
    let out = "";
    let quote = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (block) {
        if (text.startsWith("*/", i)) {
          block = false;
          out += " ";
          i++;
        }
        out += " ";
        continue;
      }
      if (quote) {
        if (ch === quote) quote = "";
        else if (ch === "\\") out += text[i++] ?? "";
        out += text[i] ?? "";
        continue;
      }
      if (slash && text.startsWith("/*", i)) {
        block = true;
        out += "  ";
        i++;
        continue;
      }
      const lineComment =
        (slash && text.startsWith("//", i)) || (dash && text.startsWith("--", i)) || (hash && ch === "#" && (i === 0 || /\s/.test(text[i - 1])));
      if (lineComment) {
        out += " ".repeat(text.length - i);
        break;
      }
      if (opensQuote(text, i, ext === "rs")) quote = ch;
      out += ch;
    }
    code[n - 1] = out;
  }
  return code;
}

/**
 * Where `caller` calls `name`: "edited" when the diff changed the call, else the line
 * to look at (null when none could be found).
 *
 * With the file readable, a call is the name followed by `(` (after `!`, `?.` or
 * type arguments), running to where that parenthesis closes ({@link callEnd}), so a
 * changed argument on a later line counts. Any call the diff left alone leaves the
 * caller behind, whatever happened to its other calls, several on one line included.
 * With no call of that shape (a JSX element, a decorator, `new Foo`), a changed line
 * naming it counts as the edit. Comments are skipped ({@link codeLines}); a call-shaped
 * name inside a string still counts. Calls match by name and edits by line, so a caller
 * left behind is a lead to check. Without the file, or with no line naming it (a call
 * through an alias), any changed line in the caller's span counts.
 */
function callSite(caller: NodeV1, name: string, file: ChangedFile | undefined, read?: LineReader): "edited" | number | null {
  const span = spanBounds(caller.span);
  if (!span) return null;
  const lines = read?.(caller.path);
  if (lines) {
    const named = wordRe(name);
    const called = new RegExp(`${named.source}\\s*(?:(?:!|\\?\\.)\\s*)?(?:<[^<>()]*>\\s*)?\\(`, "g");
    const last = Math.min(span.end, lines.length);
    const code = codeLines(lines, span.start, last, caller.path);
    let calls = 0;
    const mentions: number[] = [];
    for (let n = span.start; n <= last; n++) {
      const found = [...code[n - 1].matchAll(called)];
      for (const call of found) {
        calls++;
        if (!touches(file, n, callEnd(code, n, call.index, last))) return n;
      }
      if (found.length === 0 && named.test(code[n - 1])) mentions.push(n);
    }
    if (calls > 0) return "edited";
    if (mentions.length > 0) return mentions.some((n) => touches(file, n, n)) ? "edited" : mentions[0];
  }
  return touches(file, span.start, span.end) ? "edited" : null;
}

/** Methods a class's callers reach when they construct it: `Foo(...)`, `new Foo(...)`. */
const CONSTRUCTORS = new Set(["constructor", "__init__"]);

/**
 * The callers of each changed declaration whose call the diff did not edit: the
 * call sites a signature change can leave behind. Direct `calls` edges only, since a
 * declaration change breaks the call, not what calls the caller. A changed
 * `constructor` or `__init__` stands for its class, since a call constructing the
 * class targets the class.
 */
function callersLeftBehind(graph: GraphV1, declared: NodeV1[], changed: ChangedFile[], read?: LineReader): LeftBehind[] {
  if (declared.length === 0) return [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  /** Edge targets whose callers to check, and the changed symbol each stands for. */
  const watched = new Map(declared.map((n) => [n.id, n]));
  for (const seed of declared) {
    if (seed.kind !== "method" || !CONSTRUCTORS.has(seed.name) || !seed.owner) continue;
    const span = spanBounds(seed.span);
    const owner = graph.nodes.find((n) => {
      const b = n.kind === "class" && n.path === seed.path && n.name === seed.owner ? spanBounds(n.span) : null;
      return b !== null && span !== null && b.start <= span.start && b.end >= span.end;
    });
    if (owner && !watched.has(owner.id)) watched.set(owner.id, seed);
  }
  const fileOf = new Map(changed.map((f) => [f.path, f]));
  const found = new Map<string, LeftBehind>();
  for (const e of graph.edges) {
    if (e.relation !== "calls" || e.source === e.target) continue;
    const seed = watched.get(e.target);
    const target = seed ? byId.get(e.target) : undefined;
    const caller = target ? byId.get(e.source) : undefined;
    if (!seed || !target || !caller) continue;
    const key = `${seed.id}\0${caller.id}`;
    const prev = found.get(key);
    // A second edge between the same pair adds nothing but certainty.
    if (prev) {
      if (e.confidence !== "inferred") delete prev.inferred;
      continue;
    }
    const site = callSite(caller, target.name, fileOf.get(caller.path), read);
    if (site === "edited") continue;
    found.set(key, {
      seed: { id: seed.id, name: seed.name },
      id: caller.id, name: caller.name, kind: caller.kind, path: caller.path, span: caller.span,
      ...(site === null ? {} : { line: site }),
      ...(e.confidence === "inferred" ? { inferred: true as const } : {}),
    });
  }
  return [...found.values()].sort((a, b) =>
    a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0) || a.name.localeCompare(b.name) || a.seed.name.localeCompare(b.seed.name));
}

/**
 * The test files the change reaches, over the full closure from every seed.
 *
 * Not capped by `--depth`: the question is which tests to run, and a test two hops
 * further out still runs the changed code. A test file the diff edits is listed at
 * depth 0. As with the test signal, a test that drives the code through a CLI or a
 * spawned process has no edge, so it is not found.
 */
function testsReached(graph: GraphV1, seeds: NodeV1[], changed: ChangedFile[]): TestReach[] {
  const indexed = new Set(graph.nodes.filter((n) => n.kind === "file").map((n) => n.path));
  const byPath = new Map<string, { reach: TestReach; definite: boolean; hits: { name: string; depth: number }[] }>();
  for (const f of changed) {
    if (f.status === "deleted" || !indexed.has(f.path) || !TEST_PATH.test(f.path)) continue;
    byPath.set(f.path, { reach: { path: f.path, depth: 0, changed: true, symbols: [] }, definite: true, hits: [] });
  }
  for (const h of impactOfMany(graph, seeds, Number.POSITIVE_INFINITY, "in")) {
    if (!hasNode(h) || !TEST_PATH.test(h.node.path)) continue;
    let entry = byPath.get(h.node.path);
    if (!entry) {
      entry = { reach: { path: h.node.path, depth: h.depth, symbols: [] }, definite: false, hits: [] };
      byPath.set(h.node.path, entry);
    }
    entry.reach.depth = Math.min(entry.reach.depth, h.depth);
    if (!h.inferred) entry.definite = true;
    if (h.node.kind !== "file") entry.hits.push({ name: h.node.name, depth: h.depth });
  }
  return [...byPath.values()]
    .map(({ reach, definite, hits }) => ({
      ...reach,
      ...(definite ? {} : { inferred: true as const }),
      symbols: [...new Set(hits.sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name)).map((s) => s.name))],
    }))
    .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
}

/**
 * Group the changed files into areas, and work out whether each one's tests moved.
 *
 * The diff's own side of the diagram used to be one box per changed file, which can
 * never fit: a 24-file PR drew ten arbitrary paths. Grouped by the same concept
 * labels the dependents use, the same PR is three or four circles — and once the
 * files are grouped, "did a test that reaches this move too?" is one question per
 * circle instead of per file.
 */
function changedAreas(
  graph: GraphV1,
  changed: ChangedFile[],
  seedNodes: Map<string, NodeV1[]>,
  index: ModuleIndex,
  modules: ImpactedModule[],
): ChangedArea[] {
  const changedTests = new Set(changed.filter((c) => TEST_PATH.test(c.path)).map((c) => c.path));
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  /** How many edges point AT each node — how central it is in the graph. */
  const inDegree = new Map<string, number>();
  for (const e of graph.edges) inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  /** Incoming edge sources per node id, resolved to the source's file path. */
  const incoming = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    const path = nodeById.get(e.source)?.path;
    if (!path || !TEST_PATH.test(path)) continue;
    const at = incoming.get(e.target) ?? new Set<string>();
    at.add(path);
    incoming.set(e.target, at);
  }

  // Group by DIRECTORY, not by concept. Concepts in a well-summarised repo are
  // near-file-grained — graft's own PR produced nine of them, one file each — so
  // grouping the diff by concept groups nothing: the left side was nine circles
  // with near-identical truncated names. A directory is the coarser unit reviewers
  // already use, and a concept name is only worth borrowing when one concept
  // happens to claim the whole group.
  const groups = new Map<string, string[]>();
  for (const path of seedNodes.keys()) {
    // A changed test file is the signal, not the source of a blast radius. Drawing
    // it as an area would put "your tests changed" on both sides of the arrow.
    if (TEST_PATH.test(path)) continue;
    const dir = dirLabel(path);
    groups.set(dir, [...(groups.get(dir) ?? []), path]);
  }
  coarsen(groups, MAX_AREAS);

  const byKey = new Map<string, ChangedArea>();
  /** Hub candidates per area, ranked once every seed has been seen. */
  const candidates = new Map<ChangedArea, { name: string; behavioural: boolean; degree: number }[]>();
  for (const [dir, paths] of groups) {
    const area: ChangedArea = {
      label: dir, labelSource: "symbol", key: dir,
      files: [], seeds: 0, tests: "none", testFiles: [], changedTestFiles: [],
      reached: 0, behavioural: 0, unreached: [], seedNames: [],
    };
    byKey.set(dir, area);
    for (const path of paths) {
      const nodes = seedNodes.get(path) ?? [];
      area.files.push(path);
      area.seeds += nodes.length;

      for (const node of nodes) {
        // Reach is measured over behaviour only. Counting interfaces and type aliases
        // would sink every ratio: nothing "calls" a type, so a fully tested area of
        // typed code would report a third of its symbols as unreached.
        const behavioural = node.kind === "function" || node.kind === "method" || node.kind === "class";
        const from = incoming.get(node.id) ?? new Set<string>();
        for (const t of from) {
          if (!area.testFiles.includes(t)) area.testFiles.push(t);
          if (changedTests.has(t) && !area.changedTestFiles.includes(t)) area.changedTestFiles.push(t);
        }
        candidates.set(area, [
          ...(candidates.get(area) ?? []),
          { name: node.name, behavioural, degree: inDegree.get(node.id) ?? 0 },
        ]);
        if (!behavioural) continue;
        area.behavioural++;
        if (from.size > 0) area.reached++;
        else area.unreached.push(node.name);
      }
    }
  }

  for (const area of byKey.values()) {
    // The hub is the most-depended-on function in the area, not whichever symbol the
    // file walk happened to end on: `LlmFailureGate` rather than `transportRetries`.
    // Behaviour outranks types, since nothing calls an interface.
    area.seedNames = (candidates.get(area) ?? [])
      .sort((a, b) =>
        Number(b.behavioural) - Number(a.behavioural) || b.degree - a.degree || a.name.localeCompare(b.name))
      .map((c) => c.name);
    const concept = sharedConcept(area.files, index);
    area.label = concept ?? hubLabel(area.seedNames, area.key);
    area.labelSource = concept ? "concept" : "symbol";
    area.files.sort(); // NOSONAR: strings only, so the default code-unit order is deterministic
    area.testFiles.sort(); // NOSONAR: strings only, so the default code-unit order is deterministic
    area.changedTestFiles.sort(); // NOSONAR: strings only, so the default code-unit order is deterministic
    area.tests =
      area.behavioural === 0 ? "na"
      : area.changedTestFiles.length > 0 ? "changed"
      : area.testFiles.length > 0 ? "stale"
      : "none";
  }

  // Ordered by how much each area actually reaches, because the diagram caps this
  // list and folds the rest into one circle. Ordered by size instead, the fold ends
  // up holding the best-connected areas and the tail circle collects every arrow —
  // the same mistake, one level up, as capping changed FILES in diff order.
  const reach = (a: ChangedArea) =>
    modules.filter((m) => m.from.some((f) => a.files.includes(f))).length;
  return [...byKey.values()].sort(
    (a, b) => reach(b) - reach(a) || b.files.length - a.files.length || a.label.localeCompare(b.label),
  );
}

/** Convenience wrapper: build the module index from a context dir. */
export function blastRadiusIn(
  graph: GraphV1,
  contextDir: string,
  changed: ChangedFile[],
  basis: string,
  depth: number,
  extra: Pick<BlastOptions, "read" | "tests"> = {},
): BlastReport {
  return blastRadius(graph, changed, basis, { depth, modules: moduleIndex(contextDir), ...extra });
}

function hasNode(h: EdgeHit): h is EdgeHit & { node: NodeV1 } {
  // Unresolved endpoints (an import module string no node exists for) carry no
  // location, so they can neither be grouped nor opened — dropped rather than
  // rendered as a box with no file behind it.
  return h.node !== null;
}

function toImpacted(h: EdgeHit & { node: NodeV1 }): Impacted {
  return {
    id: h.node.id, name: h.node.name, kind: h.node.kind,
    path: h.node.path, span: h.node.span, relation: h.relation, depth: h.depth,
    ...(h.inferred ? { inferred: true as const } : {}),
  };
}

function emptyIndex(): ModuleIndex {
  return { hasConcepts: false, labelOf: (p) => p, conceptOf: () => null };
}

/**
 * The concept claiming EVERY file in a cluster, or null when they disagree.
 *
 * Unanimity is the point: a concept that covers three of five files describes
 * something narrower than the cluster, and stamping its name on the whole thing is
 * how a diagram starts lying about what it drew.
 */
function sharedConcept(paths: string[], index: ModuleIndex): string | null {
  const concepts = new Set(paths.map((p) => index.conceptOf(p)));
  const [only] = concepts;
  return concepts.size === 1 && only ? shortLabel(only) : null;
}

/**
 * The deterministic backstop label: the cluster's most significant symbol.
 *
 * Reached with no concept, no cache and no API key, so this is what guarantees a
 * circle never carries a bare directory. It is a fact rather than a guess — the
 * reviewer can grep the name — which is why it beats borrowing a neighbouring
 * concept: on graft's own graph that borrowing labelled the freshness gate
 * "Graph Extraction and Loading", which misleads worse than any path.
 */
export function hubLabel(names: string[], fallback: string): string {
  const [head] = names.filter(Boolean);
  // The hub alone, with no "+8" tail: how many symbols came with it is already the
  // circle's second line and the table's own column, and repeating it in the label
  // turned "writeGraph" into "writeGraph +8", which reads as a version number.
  return head ? shortLabel(head) : fallback;
}

/**
 * Group dependents into modules. `origins` carries, per dependent, the changed
 * files whose walk actually reached it — so a module's `from` is the real arrow
 * set, not every changed file in the PR.
 */
function groupByModule(
  impacted: Impacted[],
  changed: ChangedFile[],
  origins: Map<string, Set<string>>,
  modules: ModuleIndex,
): { modules: ImpactedModule[]; testModules: ImpactedModule[] } {
  const changedPaths = new Set(changed.map((c) => c.path));
  const byKey = new Map<string, ImpactedModule>();

  for (const hit of impacted) {
    // A dependent inside a file the PR already changes is not "reach" — it is the
    // diff. Reviewers see it in the diff itself; repeating it as blast radius is
    // what makes these comments feel like noise.
    if (changedPaths.has(hit.path)) continue;
    // Cluster by concept where one exists, else by directory. Clustering and
    // LABELLING are separate steps now: the key only has to be stable, while the
    // label goes through the ladder below and may end up naming a symbol.
    const key = modules.conceptOf(hit.path) ?? dirLabel(hit.path);
    let mod = byKey.get(key);
    if (!mod) {
      mod = { label: key, labelSource: "symbol", key, files: [], symbols: [], from: [] };
      byKey.set(key, mod);
    }
    mod.symbols.push(hit);
    if (!mod.files.includes(hit.path)) mod.files.push(hit.path);
  }

  for (const mod of byKey.values()) {
    const from = new Set<string>();
    for (const s of mod.symbols) for (const p of origins.get(s.id) ?? []) from.add(p);
    mod.from = [...from].sort(); // NOSONAR: strings only, so the default code-unit order is deterministic
    mod.files.sort(); // NOSONAR: strings only, so the default code-unit order is deterministic
    // Definite before inferred at each depth, so the lists' caps drop leads first.
    mod.symbols.sort((a, b) =>
      a.depth - b.depth || Number(a.inferred === true) - Number(b.inferred === true) || a.path.localeCompare(b.path));
    // Shallowest symbol first after that sort, so it is the cluster's hub: the
    // thing one hop from the diff rather than an arbitrary member.
    const concept = sharedConcept(mod.files, modules);
    mod.label = concept ?? hubLabel(mod.symbols.map((s) => s.name), mod.key);
    mod.labelSource = concept ? "concept" : "symbol";
  }

  // Test-only modules are separated, not just sorted last. On a repo with a test
  // per module they are the majority of the graph's dependents — graft's own 24-file
  // PR produced 31 modules, 24 of them a single test file — so leaving them in the
  // same list means they crowd out every module a reviewer needs whatever the caps
  // are. "Your tests reference the thing you changed" is one line, not 24 sections.
  const bySize = (a: ImpactedModule, b: ImpactedModule) =>
    b.symbols.length - a.symbols.length || a.label.localeCompare(b.label);
  const all = [...byKey.values()];
  return {
    modules: all.filter((m) => !isTestOnly(m)).sort(bySize),
    testModules: all.filter(isTestOnly).sort(bySize),
  };
}

/**
 * Directory groups the diff is folded down to before anything is drawn.
 *
 * Kept here rather than in the renderer because it is a statement about the diff,
 * not about the picture: five areas is roughly what a reviewer holds in their head,
 * and the renderer then draws all of them.
 */
const MAX_AREAS = 5;

/**
 * Fold directory groups into their parents until there are at most `max`.
 *
 * The deepest group goes first, and only into a parent that already exists, so
 * `src/ai/llm/` joins `src/ai/` rather than everything collapsing towards the repo
 * root. When no group has an existing parent, one is created — but never at the top
 * level, since a single `(root)` area is no grouping at all.
 */
function coarsen(groups: Map<string, string[]>, max: number): void {
  const depth = (dir: string) => dir.split("/").length;
  while (groups.size > max) {
    const keys = [...groups.keys()].sort((a, b) => depth(b) - depth(a) || (groups.get(a)!.length - groups.get(b)!.length));
    const pick =
      keys.find((k) => groups.has(parentDir(k)) && parentDir(k) !== "") ??
      keys.find((k) => parentDir(k) !== "");
    if (!pick) return;
    const parent = parentDir(pick);
    groups.set(parent, [...(groups.get(parent) ?? []), ...groups.get(pick)!]);
    groups.delete(pick);
  }
}

const TEST_PATH = /(^|\/)(tests?|specs?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$/i;

/** True when every file in the module is a test file. */
function isTestOnly(mod: ImpactedModule): boolean {
  return mod.files.length > 0 && mod.files.every((f) => TEST_PATH.test(f));
}
