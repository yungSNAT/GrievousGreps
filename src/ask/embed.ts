/**
 * Static embeddings for `ask`: the model2vec model `potion-code-16M-v2` that ships in
 * `models/`, read without a dependency or a network call.
 *
 * A model2vec model is a token embedding table: a text's vector is the mean of its
 * tokens' rows, L2-normalised. This module reproduces model2vec 0.10.0's `encode` for
 * this model: BERT normalisation and pre-tokenisation, WordPiece, the unknown token
 * dropped, 512 tokens at most (after cutting the text to 512 times the vocabulary's
 * median token length). `test/ask-embed.test.ts` holds model2vec's own token ids and
 * vectors for fixed strings.
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The model's folder: `models/` beside `src/` and `dist/` in a checkout or an install. */
export const MODEL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "models", "potion-code-16M-v2");
/** Names the model in the vectors sidecar, so vectors from another model are never mixed in. */
export const MODEL_ID = "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b";
const MAX_TOKENS = 512;

export interface Tokenizer {
  vocab: Map<string, number>;
  unk: number;
  maxWordChars: number;
  /** Characters kept before tokenising: model2vec's `max_length * median_token_length`. */
  maxChars: number;
}

export interface Embedder {
  dim: number;
  /** The unit vector of a text, or all zeros when no token of it is in the vocabulary. */
  embed(text: string): Float32Array;
  close(): void;
}

/** Whether the model files are present (a source checkout or install that kept `models/`). */
export function modelAvailable(dir = MODEL_DIR): boolean {
  return ["model.safetensors", "tokenizer.json"].every((f) => existsSync(join(dir, f)));
}

export function loadTokenizer(dir = MODEL_DIR): Tokenizer {
  const raw = JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8"));
  const model = raw.model;
  if (model?.type !== "WordPiece" || model.continuing_subword_prefix !== "##") {
    throw new Error(`unsupported tokenizer in ${dir}: ${model?.type}`);
  }
  const vocab = new Map<string, number>(Object.entries(model.vocab as Record<string, number>));
  const lengths = [...vocab.keys()].map((t) => t.length).sort((a, b) => a - b);
  const mid = lengths.length >> 1;
  const median = lengths.length % 2 ? lengths[mid] : (lengths[mid - 1] + lengths[mid]) / 2;
  return {
    vocab,
    unk: vocab.get(model.unk_token) ?? -1,
    maxWordChars: model.max_input_chars_per_word,
    maxChars: MAX_TOKENS * Math.trunc(median),
  };
}

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) || (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b920 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

const WHITESPACE = /\p{White_Space}/u;
const CONTROL = /\p{C}/u;
const MARK = /\p{Mn}/u;
const PUNCT = /[\p{P}\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/u;

/** BertNormalizer (clean text, CJK spacing, accents stripped, lower case), then
 * BertPreTokenizer (split on whitespace, each punctuation character on its own). */
export function preTokenize(text: string): string[] {
  let clean = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // Tab, newline and return are control characters that count as whitespace; any other
    // control character is dropped, even one Unicode also calls whitespace.
    if (cp === 0 || cp === 0xfffd || (CONTROL.test(ch) && ch !== "\t" && ch !== "\n" && ch !== "\r")) continue;
    clean += WHITESPACE.test(ch) ? " " : isCjk(cp) ? ` ${ch} ` : ch;
  }
  let stripped = "";
  for (const ch of clean.normalize("NFD")) if (!MARK.test(ch)) stripped += ch;
  const words: string[] = [];
  let word = "";
  for (const ch of stripped.toLowerCase()) {
    if (WHITESPACE.test(ch)) {
      if (word) words.push(word);
      word = "";
    } else if (PUNCT.test(ch)) {
      if (word) words.push(word);
      words.push(ch);
      word = "";
    } else word += ch;
  }
  if (word) words.push(word);
  return words;
}

/** One word's WordPiece ids, longest match first; a word with no full split is one unknown token. */
function wordPieces(tok: Tokenizer, word: string): number[] {
  const chars = Array.from(word);
  if (chars.length > tok.maxWordChars) return [tok.unk];
  const pieces: number[] = [];
  for (let start = 0; start < chars.length; ) {
    let end = chars.length;
    let id: number | undefined;
    for (; end > start && id === undefined; end--) id = tok.vocab.get((start > 0 ? "##" : "") + chars.slice(start, end).join(""));
    if (id === undefined) return [tok.unk];
    pieces.push(id);
    start = end + 1;
  }
  return pieces;
}

/** Token ids as model2vec's `tokenize` returns them: at most 512 tokens, then unknown tokens dropped. */
export function tokenIds(tok: Tokenizer, text: string): number[] {
  // model2vec cuts a Python string, so by code points; fewer UTF-16 units than that need no cut.
  const cut = text.length > tok.maxChars ? Array.from(text).slice(0, tok.maxChars).join("") : text;
  const ids = preTokenize(cut).flatMap((word) => wordPieces(tok, word));
  return ids.slice(0, MAX_TOKENS).filter((id) => id !== tok.unk);
}

/** float16 bits to float32, indexed by every bit pattern. */
export const F16 = (() => {
  const table = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const frac = h & 0x3ff;
    table[h] =
      exp === 0 ? sign * 2 ** -14 * (frac / 1024) : exp === 31 ? (frac ? NaN : sign * Infinity) : sign * 2 ** (exp - 15) * (1 + frac / 1024);
  }
  return table;
})();

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/** `v >>> s`, rounded to nearest, ties to even. */
function roundShift(v: number, s: number): number {
  const q = v >>> s;
  const rest = v & ((1 << s) - 1);
  const half = 1 << (s - 1);
  return q + (rest > half || (rest === half && q & 1) ? 1 : 0);
}

/** One float32 as the nearest float16's bits; out of range saturates to infinity. */
function toHalf(x: number): number {
  F32[0] = x;
  const bits = U32[0];
  const sign = (bits >>> 16) & 0x8000;
  const exp = ((bits >>> 23) & 0xff) - 112; // float32's bias 127 to float16's 15
  const mant = bits & 0x7fffff;
  if (exp >= 31) return sign | 0x7c00 | (exp === 143 && mant ? 0x200 : 0);
  if (exp <= 0) return exp < -10 ? sign : sign | roundShift(mant | 0x800000, 14 - exp);
  // A carry out of the mantissa raises the exponent, and past the top gives infinity, as it should.
  return sign | roundShift((exp << 23) | mant, 13);
}

export function f32ToF16(values: Float32Array): Uint16Array {
  return Uint16Array.from(values, toHalf);
}

interface Table {
  rows: number;
  dim: number;
  /** Byte offset of the first row in the file. */
  offset: number;
}

/** Fill `buf` from `pos`, or throw: a short read means the model file is cut. */
function readExact(fd: number, buf: Buffer, pos: number): void {
  if (readSync(fd, buf, 0, buf.length, pos) !== buf.length) throw new Error("model.safetensors: the file ends early");
}

/** The 'embeddings' table, checked to lie wholly inside the file and to cover the vocabulary. */
function readTable(fd: number, vocabRows: number): Table {
  const size = fstatSync(fd).size;
  const len = Buffer.alloc(8);
  readExact(fd, len, 0);
  const headerLen = Number(len.readBigUInt64LE(0));
  if (headerLen > size - 8) throw new Error("model.safetensors: not a safetensors file");
  const header = Buffer.alloc(headerLen);
  readExact(fd, header, 8);
  let t;
  try {
    t = JSON.parse(header.toString("utf8")).embeddings;
  } catch {
    throw new Error("model.safetensors: not a safetensors file");
  }
  if (t?.dtype !== "F16" || t.shape?.length !== 2) throw new Error("model.safetensors: expected an F16 'embeddings' table");
  const [rows, dim] = t.shape as [number, number];
  const [start, end] = (t.data_offsets ?? []) as [number, number];
  const counts = (...xs: unknown[]) => xs.every((x) => Number.isSafeInteger(x) && (x as number) >= 0);
  if (!counts(rows, dim, start, end) || dim === 0 || end < start) throw new Error("model.safetensors: a bad table shape or offsets");
  const offset = 8 + headerLen + start;
  if (end - start !== rows * dim * 2 || offset + rows * dim * 2 > size) throw new Error("model.safetensors: the table runs past the file");
  if (rows < vocabRows) throw new Error(`model.safetensors: ${rows} rows for a vocabulary of ${vocabRows}`);
  return { rows, dim, offset };
}

/**
 * An embedder over the shipped model. `whole` reads the 32 MB table once, for a build
 * that embeds many chunks; otherwise each text reads only its tokens' rows, which is
 * all a query needs.
 */
export function openEmbedder(opts: { whole?: boolean; dir?: string } = {}): Embedder {
  const dir = opts.dir ?? MODEL_DIR;
  const tok = loadTokenizer(dir);
  const fd = openSync(join(dir, "model.safetensors"), "r");
  let table: Table;
  let row: Buffer;
  let all: Uint16Array | null = null;
  try {
    table = readTable(fd, [...tok.vocab.values()].reduce((m, id) => Math.max(m, id + 1), 0));
    if (opts.whole) {
      const bytes = Buffer.alloc(table.rows * table.dim * 2);
      readExact(fd, bytes, table.offset);
      all = new Uint16Array(bytes.buffer, bytes.byteOffset, table.rows * table.dim);
    }
    row = Buffer.alloc(table.dim * 2);
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  const { dim } = table;
  const rowBits = new Uint16Array(row.buffer, row.byteOffset, dim);
  return {
    dim,
    embed(text: string): Float32Array {
      const out = new Float32Array(dim);
      const ids = tokenIds(tok, text);
      for (const id of ids) {
        let bits: Uint16Array;
        if (all) bits = all.subarray(id * dim, id * dim + dim);
        else {
          readExact(fd, row, table.offset + id * dim * 2);
          bits = rowBits;
        }
        for (let i = 0; i < dim; i++) out[i] += F16[bits[i]];
      }
      let norm = 0;
      for (let i = 0; i < dim; i++) norm += out[i] * out[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < dim; i++) out[i] /= norm;
      return out;
    },
    close: () => closeSync(fd),
  };
}
