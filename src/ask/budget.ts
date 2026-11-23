/**
 * `ask --max-tokens` / graft_find_code `max_tokens`: fit the answer to a token
 * budget. Ranking is untouched. In rank order, the top hit keeps its whole
 * definition when that fits; later hits are folded (signature and call lines kept,
 * the rest elided); a hit that no longer fits folded is listed by title and
 * pointer; the rest are left out and counted. Tokens are estimated at 4
 * characters a token, as the savings line does, with a margin for the estimate.
 */
import { formatAskWithSaved, type AskHit, type AskResult } from "./ask.js";

export interface AskBudget {
  max_tokens: number;
  /** Estimated tokens of the rendered answer, footer included. */
  used_tokens: number;
  folded: number;
  pointer_only: number;
  omitted: number;
}

/** Share of the budget the estimate may fill: chars/4 runs under a real tokenizer on code. */
const MARGIN = 0.85;
/** Room kept for the footer, which is written once the hits are chosen. */
const FOOTER_TOKENS = 32;

/** A call: a name followed by `(`. A line whose only such names are keywords is not one. */
const CALL = /([A-Za-z_$][\w$]*)\s*\(/g;
const NOT_CALLS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "elif", "with", "match", "sizeof",
  "typeof", "await", "yield", "new", "fn", "def", "func", "foreach", "until", "unless", "when", "and", "or", "not",
]);

function hasCall(line: string): boolean {
  for (const m of line.matchAll(CALL)) if (!NOT_CALLS.has(m[1])) return true;
  return false;
}

/** Lines of the signature: up to the first line that opens the body (`{`, `:` or `=>`
 * at its end), at most 6. */
function signatureLength(lines: string[]): number {
  const end = lines.slice(0, 6).findIndex((l) => /(\{|:|=>|\bdo|=)\s*$/.test(l.trimEnd()));
  return end < 0 ? 1 : end + 1;
}

/**
 * Fold a definition: keep its signature, every body line holding a call and its
 * last line; each run of other lines becomes one `⋯ N lines` marker at that run's
 * indent. Code with nothing to elide comes back unchanged.
 */
export function foldCode(code: string): string {
  const lines = code.split("\n");
  const head = signatureLength(lines);
  const keep = lines.map((l, i) => i < head || i === lines.length - 1 || hasCall(l));
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (keep[i]) {
      out.push(lines[i++]);
      continue;
    }
    let j = i;
    while (j < lines.length && !keep[j]) j++;
    const n = j - i;
    // One plain line costs no more than its marker.
    if (n === 1) out.push(lines[i]);
    else out.push(`${/^\s*/.exec(lines[i])?.[0] ?? ""}⋯ ${n} lines`);
    i = j;
  }
  return out.join("\n");
}

const tokens = (text: string): number => Math.ceil(text.length / 4);

type Level = "whole" | "folded" | "pointer";

function atLevel(hit: AskHit, level: Level, folded: string | undefined): AskHit {
  if (level === "whole") return hit;
  if (level === "folded") return { ...hit, code: folded };
  const { code: _code, snippet: _snippet, related: _related, ...bare } = hit;
  return { ...bare, snippet: "" };
}

function footer(b: AskBudget): string {
  const parts = [
    b.folded && `${b.folded} folded`,
    b.pointer_only && `${b.pointer_only} as pointers only`,
    b.omitted && `${b.omitted} left out`,
  ].filter(Boolean);
  const how = b.folded || b.pointer_only ? "; rerun with full (or read the pointer) for a whole body" : "";
  return `budget: about ${b.used_tokens} of ${b.max_tokens} tokens${parts.length ? `, ${parts.join(", ")}` : ""}${how}`;
}

/**
 * The answer fitted to `maxTokens`, rendered, with its budget record. `r`'s hits
 * must carry their whole definitions (`ask` with `source` and `full`).
 */
export function budgetAsk(r: AskResult, maxTokens: number): { result: AskResult & { budget: AskBudget }; text: string; savedTokens: number } {
  const cap = Math.floor(maxTokens * MARGIN) - FOOTER_TOKENS;
  const chosen: AskHit[] = [];
  const levels: Level[] = [];
  let omitted = 0;
  const render = (hits: AskHit[], saved = r.saved) => formatAskWithSaved({ ...r, hits, saved });
  for (const [i, hit] of r.hits.entries()) {
    const folded = hit.code === undefined ? undefined : foldCode(hit.code);
    const tries: Level[] = hit.code === undefined ? ["whole"] : i === 0 ? ["whole", "folded", "pointer"] : folded === hit.code ? ["whole", "pointer"] : ["folded", "pointer"];
    const fit = tries.find((level) => tokens(render([...chosen, atLevel(hit, level, folded)]).text) <= cap);
    // The first hit always shows, at least as a pointer: an empty answer helps nobody.
    const level = fit ?? (i === 0 ? "pointer" : undefined);
    if (!level) {
      omitted = r.hits.length - i;
      break;
    }
    chosen.push(atLevel(hit, level, folded));
    levels.push(level);
  }
  // The savings line compares the pack with the files it covers; a left-out hit covers none.
  const saved = omitted ? undefined : r.saved;
  const out = render(chosen, saved);
  const budget: AskBudget = {
    max_tokens: maxTokens,
    used_tokens: 0,
    folded: levels.filter((l, i) => l === "folded" && chosen[i].code !== r.hits[i].code).length,
    pointer_only: levels.filter((l) => l === "pointer").length,
    omitted,
  };
  budget.used_tokens = tokens(out.text) + tokens(footer(budget)) + 1;
  const text = `${out.text}${footer(budget)}\n`;
  return { result: { ...r, hits: chosen, saved, budget }, text, savedTokens: out.savedTokens };
}

/** A `max_tokens` value: a whole number of at least 1, or why not. */
export function parseMaxTokens(value: unknown): number | string {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : `max_tokens must be a whole number of at least 1, got ${JSON.stringify(value)}`;
}
