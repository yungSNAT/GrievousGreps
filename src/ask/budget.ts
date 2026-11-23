/**
 * `ask --max-tokens` / graft_find_code `max_tokens`: fit the answer to a token
 * budget. Ranking is untouched. In rank order, the top hit keeps its whole
 * definition when that fits; later hits are folded (signature and call lines kept,
 * the rest elided); a hit that no longer fits folded is listed by title and
 * pointer; the rest are left out and counted. Tokens are estimated at 4 ASCII
 * characters a token plus 1 for each other character, with a margin for the estimate.
 */
import { formatAskWithSaved, savedForHits, type AskHit, type AskResult } from "./ask.js";

export interface AskBudget {
  max_tokens: number;
  /** Estimated tokens of the rendered text answer, footer included (a `--json` answer is larger). */
  used_tokens: number;
  folded: number;
  pointer_only: number;
  omitted: number;
}

/** Share of the budget the estimate may fill: ASCII chars/4 runs under a real tokenizer on code. */
const MARGIN = 0.85;
/** Room kept for the footer, which is written once the hits are chosen. */
const FOOTER_TOKENS = 32;

/** A call: a name followed by `(`, allowing a macro's `!` and explicit generics
 * (`name<T>(`, `name::<T>(`). A line whose only such names are keywords is not one. */
const CALL = /([A-Za-z_$][\w$]*)!?(?:(?:::)?<(?:[^<>()]|<[^<>()]*>)*>)?\s*\(/g;
const NOT_CALLS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "elif", "with", "match", "sizeof",
  "typeof", "await", "yield", "new", "fn", "def", "func", "foreach", "until", "unless", "when", "and", "or", "not",
]);

function hasCall(line: string): boolean {
  for (const m of line.matchAll(CALL)) if (!NOT_CALLS.has(m[1])) return true;
  return false;
}

/** Lines of the signature: up to the first line that opens the body (`{`, `:`, `=>`,
 * `do` or `=` at its end) outside every bracket, so destructured and inline-typed
 * parameters and object return types stay; at most 12, else the first 6. A final
 * `{` after `:`, `<`, `(`, `,`, `|` or `&` opens a type or a parameter, not the body. */
function signatureLength(lines: string[]): number {
  let depth = 0;
  for (const [i, line] of lines.slice(0, 12).entries()) {
    const text = codeOf(line).trimEnd();
    const body = text.endsWith("{") && !/[:<(,|&]\s*\{$/.test(text);
    for (const ch of body ? text.slice(0, -1) : text) {
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
    }
    if (depth <= 0 && (body || /(:|=>|\bdo|=)$/.test(text))) return i + 1;
  }
  return Math.min(lines.length, 6);
}

/** A line with its double-quoted and template strings and character literals emptied
 * and any `//` comment dropped, so a bracket inside one is not counted. Each line is
 * read on its own. */
function codeOf(line: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) {
        quote = "";
        out += ch;
      }
    } else if (ch === "/" && line[i + 1] === "/") break;
    else if (ch === "'") {
      // Only a character literal: a lone quote is a Rust lifetime or an apostrophe.
      const lit = /^'(?:\\.|[^\\'])'/.exec(line.slice(i));
      out += lit ? "''" : ch;
      if (lit) i += lit[0].length - 1;
    } else {
      if (ch === '"' || ch === "`") quote = ch;
      out += ch;
    }
  }
  return out;
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

/** 4 ASCII characters a token, and a token for each other character: CJK text and
 * emoji run at 1 or more tokens a character, so this errs high rather than low. */
function tokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

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
  const how = b.folded || b.pointer_only || b.omitted ? "; for whole bodies, rerun with a larger max_tokens or without it, or read a pointer" : "";
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
  // The nudge for a thin answer reads what the search found, not what fits.
  const render = (hits: AskHit[], saved = r.saved) => formatAskWithSaved({ ...r, hits, saved }, undefined, r);
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
  // The savings line compares the pack with the files it replaces: those of the hits
  // that still show their code. A pointer or a left-out hit replaces none.
  const priced = savedForHits(r, chosen.filter((_, i) => levels[i] !== "pointer"));
  const saved = priced !== null ? priced : omitted || levels.includes("pointer") ? undefined : r.saved;
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
