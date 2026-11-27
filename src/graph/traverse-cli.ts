/**
 * CLI wiring for `graft callers` and its `--direction` / `--depth` flags.
 *
 * One command, one implementation: resolve a symbol via `resolveSymbol`, walk
 * edges via `edgeWalk` (incoming or outgoing, depth 1 or a BFS), and share the
 * same resolve-or-die flow, human formatter, and --json shape. Kept out of
 * cli.ts so that file stays thin (argument wiring only) and this logic stays
 * unit-testable without shelling out to the CLI on every case.
 *
 * `--direction out` subsumes the old `graft callees`; `--depth N` subsumes the
 * old `graft impact`. Exported formatters are reused by the MCP `graft_trace_calls`
 * tool (`src/mcp/tools.ts`), so both surfaces render identical reports.
 */
import { resolve } from "node:path";
import { fileReader, referenceLine, wordRe } from "../blast/evidence.js";
import { contextDirFor } from "../context/node-file.js";
import { withSavings, savingsFor, type Savings } from "../context/savings.js";
import { loadGraphCached } from "./load.js";
import { resolveSymbol, edgeWalk, type Direction, type EdgeHit } from "./traverse.js";
import { confidenceMark, type Confidence, type GraphV1, type NodeV1 } from "./types.js";
import { cmd } from "../brand.js";
import { isTestPath } from "../util/paths.js";
import { queryJson } from "./query-json.js";
import { formatProvenanceText, provenanceMatchJson } from "./provenance.js";

export interface CallersCliOptions {
  in?: string;
  json?: boolean;
  /** walk direction; defaults to "in" (callers). "out" gives callees. */
  direction?: string;
  /** max BFS depth, as the raw --depth string (validated here); defaults to 1. */
  depth?: string;
  /** the top-level `--dir` override, so this command respects it like every other. */
  globalDir?: string;
  /** include explicit EXTRACTED/INFERRED provenance and weakest-hop confidence ratings. */
  provenance?: boolean;
}

const ARROW: Record<Direction, "←" | "→"> = { in: "←", out: "→" };
const DEFAULT_DEPTH = 1;

/** Exported so the MCP `graft_trace_calls` tool (`src/mcp/tools.ts`) can render the
 * same human report format as the CLI, rather than re-implementing it — both
 * surfaces walk the same edges via the same `resolveSymbol` / `edgeWalk` core. */
export function headerOf(n: NodeV1): string {
  return `${n.name} · ${n.kind} · ${n.path}:${n.span}`;
}

/** One hit on its own line, with its relation. `showDepth` is set for multi-hop walks
 * (depth > 1), matching the old `graft impact` output which tagged every hit with its
 * BFS depth. The report prints a hit this way only when it has no node to group by
 * file ({@link hitLines}).
 */
export function hitLine(direction: Direction, hit: EdgeHit, showDepth: boolean): string {
  const arrow = ARROW[direction];
  const depthTag = showDepth ? ` [depth ${hit.depth}]` : "";
  const label = hit.node ? `${hit.node.name} (${hit.node.path}:${hit.node.span})` : `${hit.id} (unresolved import)`;
  return `  ${hit.relation} ${arrow} ${label}${depthTag}${confidenceMark(hit.confidence, hit.inferred)}`;
}

/** A quoted source line: where the edge actually happens. */
interface Quote {
  n: number;
  text: string;
}

/** The relation and arrow every hit shares, printed once after the header, or null when they differ. */
function sharedRelation(direction: Direction, hits: EdgeHit[]): string | null {
  const first = hits[0].relation;
  return hits.every((h) => h.relation === first) ? `${first} ${ARROW[direction]}` : null;
}

/** A path or name as printed in a group: JSON-quoted when it holds one of the layout's own
 * separators (`: `, `, `, ` [`), starts with `[` or `"`, or ends with a space, so a reader can
 * tell where it ends and a mark begins. */
function groupLabel(text: string): string {
  return /: |, | \[|^[["]| $/.test(text) ? JSON.stringify(text) : text;
}

/** One hit inside its file's group: the name, then the hit's first line, or, when the call site
 * is quoted, that line and its text. An edge that says "total calls add" is a claim; the quoted
 * line is the evidence, and it saves opening the file to check. */
function groupedHit(hit: NodeHit, showDepth: boolean, quote: Quote | undefined): string {
  const depthTag = showDepth ? ` [depth ${hit.depth}]` : "";
  const name = groupLabel(hit.node.name);
  if (quote) return `${name} L${quote.n}${depthTag}: ${quote.text.trim()}`;
  return `${name} ${hit.node.span.split("-")[0]}${depthTag}`;
}

/**
 * The hit lines of one definition, each path printed once a group. Hits group by relation, file and
 * inferred mark, in the order the walk found them; the mark follows the path. A group with no
 * quoted call site prints on one line (`path: name L8, name L20`); a group with quotes gives each
 * hit its own line under the path.
 * The relation is left out when `shared` (the header carries it). A hit with no node (an
 * unresolved import) keeps its own line. Paths and span ends were most of the answer's tokens on
 * the caller benchmark when each hit printed its own.
 */
function hitLines(
  direction: Direction,
  hits: EdgeHit[],
  showDepth: boolean,
  shared: string | null,
  quote?: (hit: EdgeHit) => Quote | undefined,
): string[] {
  const groups = new Map<string, HitGroup>();
  const out: (string | HitGroup)[] = [];
  for (const h of hits) {
    if (!h.node) {
      out.push(hitLine(direction, h, showDepth));
      continue;
    }
    const mark = confidenceMark(h.confidence, h.inferred);
    const key = `${h.relation}\0${h.node.path}\0${mark}`;
    let group = groups.get(key);
    if (!group) {
      group = { lead: `  ${shared ? "" : `${h.relation} ${ARROW[direction]} `}${groupLabel(h.node.path)}`, mark, items: [] };
      groups.set(key, group);
      out.push(group);
    }
    group.items.push({ hit: h as NodeHit, quote: quote?.(h) });
  }
  return out.map((g) => {
    if (typeof g === "string") return g;
    if (g.items.every((i) => !i.quote)) {
      return `${g.lead}${g.mark}: ${g.items.map((i) => groupedHit(i.hit, showDepth, undefined)).join(", ")}`;
    }
    return [`${g.lead}${g.mark}`, ...g.items.map((i) => `    ${groupedHit(i.hit, showDepth, i.quote)}`)].join("\n");
  });
}

type NodeHit = EdgeHit & { node: NodeV1 };

/** One file's hits for one relation and inferred mark. */
interface HitGroup {
  lead: string;
  mark: string;
  items: { hit: NodeHit; quote?: Quote }[];
}

/**
 * The call site for one hit, or nothing.
 *
 * Only for a resolved hit whose span we can read: an unresolved import has no
 * file, and a hit at depth 2+ references something in between rather than the
 * symbol asked about, so quoting it would point at the wrong line. Not for a
 * caller in a test either: its line already names the test and its span, and
 * those quotes were 8% of answer tokens in a 30-symbol benchmark sample.
 */
function quoteFor(
  hit: EdgeHit,
  name: string,
  read: (path: string) => string[] | null,
): Quote | undefined {
  if (!hit.node || hit.depth > 1 || isTestPath(hit.node.path)) return undefined;
  const { path, span } = hit.node;
  // A file that imports the name, or imports it as another name, calls it on a later line: quote that line.
  // Import statements are blanked first, so none is quoted as the call.
  const lines = read(path);
  if (!lines) return undefined;
  const imports = importLines(lines);
  const calls = lines.map((l, i) => (imports[i] ? "" : l));
  const importText = lines.filter((_, i) => imports[i]).map(importCode);
  const names = [name, ...aliasesOf(importText, name)].map(wordRe);
  const call = referenceLine(path, span, names, () => calls, true);
  if (call) return { n: call.n, text: lines[call.n - 1] };
  return referenceLine(path, span, [wordRe(name)], read, true) ?? undefined;
}

/** A line that starts an import, in Python (`import x`, `from x import y`) or JavaScript (`import { y } from`),
 * not `import.meta` or a dynamic `import(...)`. */
const IMPORT_LINE = /^\s*(?:from\s+\S+\s+import\b|import\b(?!\s*[.(]))/;

/** An import line's code: quoted text (a module path) and a `/* ... *\/` comment emptied, and a `#`, `//` or
 * unclosed `/*` comment outside quotes dropped. */
function importCode(line: string): string {
  let out = "";
  let quote = "";
  let escaped = false;
  let skipTo = 0;
  for (const [i, c] of line.split("").entries()) {
    if (i < skipTo) continue;
    if (escaped) escaped = false;
    else if (quote) {
      if (c === "\\") escaped = true;
      else if (c === quote) {
        quote = "";
        out += c;
      }
    } else if (c === "/" && line[i + 1] === "*") {
      const close = line.indexOf("*/", i + 2);
      if (close < 0) return out;
      skipTo = close + 2;
      out += " ";
    } else if (c === "#" || (c === "/" && line[i + 1] === "/")) {
      return out;
    } else {
      if (c === '"' || c === "'" || c === "`") quote = c;
      out += c;
    }
  }
  return out;
}

/** Which lines belong to an import statement: its first line and, when it opens `{` or `(`, the lines up to the close. */
function importLines(lines: string[]): boolean[] {
  let open = false;
  return lines.map((l) => {
    if (!open && !IMPORT_LINE.test(l)) return false;
    const code = importCode(l);
    const opened = Math.max(code.lastIndexOf("("), code.lastIndexOf("{"));
    open = open ? !/[)}]/.test(code) : opened >= 0 && !/[)}]/.test(code.slice(opened));
    return true;
  });
}

/** The names import lines bind `name` to (`name as alias`). */
function aliasesOf(lines: string[], name: string): string[] {
  const aliases = lines.flatMap((l) => {
    // Identifiers in order, with the text between each and the next: `name`, blank, `as`, blank, alias.
    const ids = [...l.matchAll(/[A-Za-z_$][\w$]*/g)];
    const gap = (k: number) => l.slice(ids[k].index + ids[k][0].length, ids[k + 1].index);
    return ids.flatMap((m, k) =>
      m[0] === name && ids[k + 2] && ids[k + 1][0] === "as" && /^\s+$/.test(gap(k)) && /^\s+$/.test(gap(k + 1))
        ? [ids[k + 2][0]]
        : [],
    );
  });
  // An alias holding `$` is skipped: `wordRe`'s `\b` cannot bound it, and gg-query skips it too.
  return [...new Set(aliases.filter((a) => a !== name && !a.includes("$")))];
}

/** Tokens-saved baseline for a callers/callees walk: the files of the matched
 * symbols plus every resolved edge endpoint, read whole — the files you'd open
 * to trace these edges by hand. Shared by the CLI and the MCP tool so both
 * surfaces report the same number. */
export function callersSavings(
  graph: GraphV1,
  results: { symbol: NodeV1; hits: EdgeHit[] }[],
): Savings | undefined {
  const paths: string[] = [];
  for (const { symbol, hits } of results) {
    paths.push(symbol.path);
    for (const h of hits) if (h.node) paths.push(h.node.path);
  }
  return savingsFor(graph, paths);
}

/** Loud, actionable empty-result note — never a bare empty list. `candidateCount`
 * is how many nodes {@link resolveSymbol} matched for this query (both call
 * sites already hold it as `matches.length`) — when it's >1, the query name is
 * itself ambiguous (several definitions share it), which is exactly the case
 * `resolve.ts` drops a cross-file call/reference for rather than guessing which
 * one it means. Without saying so, a zero-hit result here reads as "nothing
 * calls this" when it may really be "something does, but the edge was dropped". */
export function looseNoteFor(direction: Direction, name: string, candidateCount: number): string {
  const label = direction === "out" ? "callees" : "callers";
  const dir = direction === "out" ? "outgoing" : "incoming";
  const ambiguity =
    candidateCount > 1
      ? ` ${candidateCount} definitions share the name "${name}"; a cross-file caller of an ambiguous name is dropped rather than guessed, so this may undercount.`
      : "";
  return `  no indexed ${label} — the graph has no ${dir} call/reference edges for this symbol as written.${ambiguity} Check the name (try the bare symbol, or "Type.method"), or find its uses with ${cmd("graft grep")} "${name}". Fall back to raw grep -rn only for unindexed files`;
}

/** Says which calls to `name` no edge carries, naming them, so a short caller list is
 * not read as a whole one. Null when there are none, or for callees. */
export function unresolvedNoteFor(graph: GraphV1, direction: Direction, name: string): string | null {
  if (direction !== "in") return null;
  const calls = (graph.unresolvedCalls ?? []).filter((c) => c.name === name);
  if (calls.length === 0) return null;
  const named = calls.slice(0, 5).map((c) => (c.through ? `${c.source} (through ${c.file ? `${c.through}, in ${c.file}, which is not indexed` : c.through})` : `${c.source} (an assignment or a second import gives it more than one target)`));
  const more = calls.length > 5 ? ` and ${calls.length - 5} more` : "";
  return `  ⚠ may be incomplete: ${calls.length} call(s) to "${name}" did not resolve to one definition and are not listed: ${named.join(", ")}${more}`;
}

/** Callerless definitions listed by header before the rest are only counted.
 * Everyone's connected, says Lain; most homonyms are not. */
const QUIET_SHOWN = 3;

/**
 * The report for a walk: one block per definition, in the order given. When several
 * definitions share the name, those with no edges come last in one block (up to
 * {@link QUIET_SHOWN} headers, a count of the rest and one undercount note) instead
 * of the same note under each: hono's `verify` has 111 definitions, and the repeated
 * note was 40% of the answer tokens in a 30-symbol benchmark sample. The
 * unresolved-calls note is about the name, so it is printed once per name. Shared by
 * the CLI, the MCP `graft_trace_calls` tool and the workspace report.
 */
export function callerBlocks(
  graph: GraphV1,
  direction: Direction,
  showDepth: boolean,
  results: { symbol: NodeV1; hits: EdgeHit[] }[],
  quote?: (hit: EdgeHit, name: string) => Quote | undefined,
): string[] {
  const noted = new Set<string>();
  const unresolved = (name: string): string[] => {
    if (noted.has(name)) return [];
    noted.add(name);
    const note = unresolvedNoteFor(graph, direction, name);
    return note ? [note] : [];
  };
  const quiet = results.length > 1 ? results.filter((r) => r.hits.length === 0).map((r) => r.symbol) : [];
  const blocks = results
    .filter((r) => r.hits.length > 0 || results.length === 1)
    .map(({ symbol, hits }) => {
      if (hits.length === 0) return [headerOf(symbol), looseNoteFor(direction, symbol.name, 1), ...unresolved(symbol.name)].join("\n");
      const shared = sharedRelation(direction, hits);
      const header = shared ? `${headerOf(symbol)} · ${shared}` : headerOf(symbol);
      const lines = hitLines(direction, hits, showDepth, shared, quote && ((h) => quote(h, symbol.name)));
      return [header, ...lines, ...unresolved(symbol.name)].join("\n");
    });
  // Matching ignores case, so the quiet definitions can carry more than one name.
  if (quiet.length > 0) blocks.push([...quietLines(direction, quiet, results.length), ...quiet.flatMap((q) => unresolved(q.name))].join("\n"));
  return blocks;
}

/** The one block for the edgeless definitions of a shared name. Matching ignores
 * case, so the names can differ; each is named, and grep is offered for one name only. */
function quietLines(direction: Direction, quiet: NodeV1[], total: number): string[] {
  const label = direction === "out" ? "callees" : "callers";
  const names = [...new Set(quiet.map((n) => n.name))];
  const named = names.map((n) => `"${n}"`).join(" or ");
  const lines = quiet.slice(0, QUIET_SHOWN).map(headerOf);
  const rest = quiet.slice(QUIET_SHOWN);
  if (rest.length > 0) lines.push(`… and ${rest.length} more in ${new Set(rest.map((n) => n.path)).size} file(s)`);
  const which = quiet.length === total ? `any of the ${total}` : `${quiet.length} of the ${total}`;
  const grep = names.length === 1 ? `, or find its uses with ${cmd("graft grep")} ${named}` : "";
  lines.push(
    `  no indexed ${label} for ${which} definitions named ${named}; a cross-file caller of a shared name is dropped rather than guessed, so this may undercount. Pick one with --in <path prefix>${grep}`,
  );
  return lines;
}

/** Why a name has no symbol, when calls to it were seen: it is not a misspelling, they did not resolve. */
export function noSymbolText(graph: GraphV1, name: string): string | null {
  const calls = (graph.unresolvedCalls ?? []).filter((c) => c.name === name);
  if (calls.length === 0) return null;
  const file = calls.find((c) => c.file)?.file;
  return `"${name}" did not resolve to a symbol in the graph${file ? `: its calls go through ${file}, which is not indexed` : ": the calls above name it"}. Find its uses with ${cmd("graft grep")} "${name}"`;
}

interface SymbolJson {
  id: string;
  name: string;
  kind: string;
  path: string;
  span: string;
}

export interface MatchJson {
  symbol: SymbolJson;
  hits: HitJson[];
  note?: string;
  unresolved?: string;
}

interface HitJson {
  id: string;
  name?: string;
  kind?: string;
  path?: string;
  span?: string;
  relation: string;
  depth: number;
  /** Set on every edge that is not proven (`likely` and `inferred`): check it before relying on it. */
  inferred?: true;
  confidence: Confidence;
}

function symbolJson(n: NodeV1): SymbolJson {
  return { id: n.id, name: n.name, kind: n.kind, path: n.path, span: n.span };
}

function hitJson(hit: EdgeHit): HitJson {
  const out: HitJson = { id: hit.id, relation: hit.relation, depth: hit.depth, ...(hit.inferred ? { inferred: true as const } : {}),
    confidence: hit.confidence ?? (hit.inferred ? "inferred" : "extracted") };
  if (hit.node) {
    out.name = hit.node.name;
    out.kind = hit.node.kind;
    out.path = hit.node.path;
    out.span = hit.node.span;
  }
  return out;
}

/** One `--json` match: the symbol, its hits, and the notes the text report prints beside them. */
export function matchJson(
  graph: GraphV1,
  direction: Direction,
  r: { symbol: NodeV1; hits: EdgeHit[] },
  candidateCount: number,
): MatchJson {
  const m: MatchJson = { symbol: symbolJson(r.symbol), hits: r.hits.map(hitJson) };
  if (r.hits.length === 0) m.note = looseNoteFor(direction, r.symbol.name, candidateCount);
  const unresolved = unresolvedNoteFor(graph, direction, r.symbol.name);
  if (unresolved) m.unresolved = unresolved.trim();
  return m;
}

/** Parse and validate the raw `--direction` string; exits (code 1) on garbage. */
export function resolveDirection(raw: string | undefined): Direction {
  if (raw === undefined) return "in";
  if (raw === "in" || raw === "out") return raw;
  console.error(`✗ --direction must be "in" or "out", got "${raw}"`);
  process.exit(1);
}

/** Parse and validate the raw `--depth` string; exits (code 1) on garbage. */
export function resolveDepth(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_DEPTH;
  // `all` (aka full/max) = the whole transitive closure: walk until no new
  // node is reached. The BFS's visited-set makes this cycle-safe, and it
  // terminates when the frontier empties. This is the "show me every
  // connected source" mode — the right first move before a multi-file
  // refactor, where stopping at direct edges misses sibling/downstream files.
  if (/^(all|full|max)$/i.test(raw)) return Number.POSITIVE_INFINITY;
  const d = Number(raw);
  if (!Number.isFinite(d) || d < 1) {
    console.error(`✗ --depth must be a positive number or "all", got "${raw}"`);
    process.exit(1);
  }
  return Math.floor(d);
}

/**
 * Resolve `query` in the graph at `dir` (respecting `--dir`/`--in`), walk edges
 * per `--direction`/`--depth`, and print either the human report or `--json`.
 * Exits the process (code 1) when there's no graph at all or the symbol is
 * unknown — both are caller-facing mistakes, not recoverable states.
 */
export function runCallersCommand(query: string, dir: string, opts: CallersCliOptions): void {
  const root = resolve(dir);
  const contextDir = contextDirFor(root, opts.globalDir);
  const graph = loadGraphCached(contextDir);
  if (!graph) {
    console.error(`✗ no graph found at ${contextDir} — run \`${cmd("graft build")}\` first`);
    process.exit(1);
  }

  // `resolveSymbol` throws on an `--in` prefix that matches nothing indexed —
  // a caller mistake, reported in the same shape as the ones around it rather
  // than as a bare stack-trace message from the top-level handler.
  let matches: NodeV1[];
  try {
    matches = resolveSymbol(graph, query, opts.in ? { in: opts.in } : {});
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }
  if (matches.length === 0) {
    const unresolved = unresolvedNoteFor(graph, "in", query);
    if (unresolved) console.error(unresolved.trim());
    console.error(`✗ ${noSymbolText(graph, query) ?? `no symbol "${query}" in the graph — check spelling or run ${cmd("graft build")}`}`);
    process.exit(1);
  }

  const direction = resolveDirection(opts.direction);
  const depth = resolveDepth(opts.depth);
  const showDepth = depth > 1;

  const results = matches.map((symbol) => ({ symbol, hits: edgeWalk(graph, symbol, direction, depth, { provenance: opts.provenance }) }));
  const saved = callersSavings(graph, results);

  if (opts.provenance) {
    if (opts.json) {
      const payload = {
        query,
        matches: results.map((r) => provenanceMatchJson(r, direction === "in" ? (graph.unresolvedCalls ?? []).filter((c) => c.name === r.symbol.name) : undefined)),
        saved,
      };
      console.log(queryJson(payload));
      return;
    }
    const read = fileReader(root);
    process.stdout.write(
      formatProvenanceText({
        direction,
        showDepth,
        results,
        quote: (h, name) => quoteFor(h as EdgeHit, name, read),
        unresolvedNote: (name) => unresolvedNoteFor(graph, direction, name),
        saved,
      }),
    );
    return;
  }

  if (opts.json) {
    const payload = { query, matches: results.map((r) => matchJson(graph, direction, r, matches.length)), saved };
    console.log(queryJson(payload));
    return;
  }

  // One reader for the whole walk: several hits usually live in the same file.
  const read = fileReader(root);
  const blocks = callerBlocks(graph, direction, showDepth, results, (h, name) => quoteFor(h, name, read));
  process.stdout.write(withSavings(`${blocks.join("\n\n")}\n`, saved));
}
