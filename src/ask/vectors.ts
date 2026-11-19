/**
 * Semantic ranking for `ask`: the build embeds each indexed source file in chunks
 * (`embed.ts`), and a query ranks files by their best chunk, fused with the lexical
 * ranking by reciprocal rank fusion.
 *
 * The vectors live in `<outDir>/.cache/ask-vectors.bin`: an 8-byte little-endian
 * header length, a JSON header naming the model and chunk size and, per file, its content
 * hash and chunk line ranges, then every chunk's vector as float16, in header order. A file
 * whose hash is unchanged keeps its vectors on the next build. `TRAIL_SEMANTIC=0`
 * turns the whole layer off, at build and at query.
 */
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { CACHE_DIR } from "../context/node-file.js";
import { removeFileInside, resolveInside, writeFileInside } from "../util/safe-fs.js";
import { F16, MODEL_ID, f32ToF16, modelAvailable, openEmbedder, type Embedder } from "./embed.js";

export const VECTORS_FILE = "ask-vectors.bin";
/** A chunk is consecutive whole lines, up to this many characters (a longer line is its own chunk). */
const CHUNK_CHARS = 750;
/** Files the dense list contributes to the fusion. */
const DENSE_FILES = 50;
/** Reciprocal rank fusion's constant: rank r scores 1 / (RRF_K + r). */
const RRF_K = 60;

export interface VectorFile {
  path: string;
  hash: string;
  /** Chunk line ranges, 1-based and inclusive, flattened: [start, end, start, end, …]. */
  lines: number[];
}

export interface VectorIndex {
  model: string;
  dim: number;
  files: VectorFile[];
  /** float16 bits, `dim` per chunk, in file then chunk order. */
  data: Uint16Array;
}

export interface DenseFile {
  path: string;
  score: number;
  start: number;
  end: number;
}

export function vectorsPath(outDir: string): string {
  return join(outDir, CACHE_DIR, VECTORS_FILE);
}

/** Semantic ranking is on unless `TRAIL_SEMANTIC=0`, and needs the model (the shipped one by default). */
export function semanticEnabled(dir?: string): boolean {
  return process.env.TRAIL_SEMANTIC !== "0" && modelAvailable(dir);
}

/** A file's chunks: [text, startLine, endLine] runs of whole lines up to {@link CHUNK_CHARS}. */
export function chunkLines(source: string): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  let cur: string[] = [];
  let size = 0;
  let start = 1;
  const flush = (end: number) => {
    const text = cur.join("\n");
    if (text.trim()) out.push([text, start, end]);
  };
  source.split(/\r\n|\r|\n/).forEach((line, i) => {
    if (cur.length && size + line.length > CHUNK_CHARS) {
      flush(i);
      cur = [];
      size = 0;
      start = i + 1;
    }
    cur.push(line);
    size += line.length + 1;
  });
  if (cur.length) flush(start + cur.length - 1);
  return out;
}

export function readVectors(outDir: string): VectorIndex | null {
  try {
    const file = resolveInside(dirname(outDir), vectorsPath(outDir));
    const buf = readFileSync(file);
    const headerLen = Number(buf.readBigUInt64LE(0));
    const head = JSON.parse(buf.subarray(8, 8 + headerLen).toString("utf8"));
    const chunks = (head.files as VectorFile[]).reduce((n, f) => n + f.lines.length / 2, 0);
    const bytes = buf.subarray(8 + headerLen);
    if (head.version !== 1 || head.model !== MODEL_ID || head.chunk !== CHUNK_CHARS || bytes.length !== chunks * head.dim * 2) return null;
    const data = new Uint16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    return { model: head.model, dim: head.dim, files: head.files, data };
  } catch {
    return null;
  }
}

/**
 * Write the vectors for `files` (repo-relative path, content hash, source), reusing the
 * prior sidecar's vectors for every file whose hash is unchanged. With semantic ranking
 * off, removes any sidecar instead, as a failed write does, so a later query never reads
 * vectors of old code.
 * Returns the number of chunks embedded this run.
 */
export function writeVectors(outDir: string, files: Array<{ path: string; hash: string; source: string }>): number {
  const base = dirname(outDir);
  if (!semanticEnabled()) {
    removeFileInside(base, vectorsPath(outDir));
    return 0;
  }
  try {
    return writeAll(outDir, files);
  } catch (err) {
    // Vectors of an older build must never rank a newer graph.
    removeFileInside(base, vectorsPath(outDir));
    throw err;
  }
}

function writeAll(outDir: string, files: Array<{ path: string; hash: string; source: string }>): number {
  const prior = readVectors(outDir);
  const priorAt = new Map<string, { file: VectorFile; offset: number }>();
  if (prior) {
    let offset = 0;
    for (const f of prior.files) {
      priorAt.set(f.path, { file: f, offset });
      offset += (f.lines.length / 2) * prior.dim;
    }
  }
  let embedder: Embedder | null = null;
  let embedded = 0;
  const out: VectorFile[] = [];
  const parts: Uint16Array[] = [];
  try {
    for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      const old = priorAt.get(f.path);
      if (prior && old && old.file.hash === f.hash) {
        out.push(old.file);
        parts.push(prior.data.subarray(old.offset, old.offset + (old.file.lines.length / 2) * prior.dim));
        continue;
      }
      const chunks = chunkLines(f.source);
      if (!chunks.length) continue;
      embedder ??= openEmbedder({ whole: true });
      const lines: number[] = [];
      for (const [text, start, end] of chunks) {
        parts.push(f32ToF16(embedder.embed(text)));
        lines.push(start, end);
      }
      embedded += chunks.length;
      out.push({ path: f.path, hash: f.hash, lines });
    }
  } finally {
    embedder?.close();
  }
  const dim = embedder?.dim ?? prior?.dim ?? 256;
  const header = Buffer.from(JSON.stringify({ version: 1, model: MODEL_ID, chunk: CHUNK_CHARS, dim, files: out }), "utf8");
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length));
  writeFileInside(dirname(outDir), vectorsPath(outDir), Buffer.concat([len, header, ...parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))]), { atomic: true });
  return embedded;
}

/**
 * Files ranked by their best chunk's cosine with `query`, best first, at most {@link DENSE_FILES}.
 * None for a query with no known token (a zero vector), of another width or not finite: those
 * would rank every file alike, so by path.
 */
export function denseFiles(index: VectorIndex, query: Float32Array, keep: (path: string) => boolean = () => true): DenseFile[] {
  const { dim, data } = index;
  if (query.length !== dim || !query.every(Number.isFinite) || !query.some((x) => x !== 0)) return [];
  const best: DenseFile[] = [];
  let at = 0;
  for (const f of index.files) {
    const n = f.lines.length / 2;
    if (!keep(f.path)) {
      at += n * dim;
      continue;
    }
    let top: DenseFile | null = null;
    for (let c = 0; c < n; c++, at += dim) {
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += query[i] * F16[data[at + i]];
      // A chunk with no known token (a zero vector) or a damaged one (not finite) says nothing.
      if (dot !== 0 && Number.isFinite(dot) && (!top || dot > top.score)) top = { path: f.path, score: dot, start: f.lines[2 * c], end: f.lines[2 * c + 1] };
    }
    if (top) best.push(top);
  }
  best.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return best.slice(0, DENSE_FILES);
}

/** The file a hit's pointer names: the pointer without its `:Lx-Ly` span. */
export function pointerFile(pointer: string): string {
  return pointer.replace(/:L\d+(-L\d+)?$/, "");
}

/**
 * Fuse a lexical hit list with the dense file list by reciprocal rank fusion over
 * files, then emit one leading hit per fused file (the lexical hit for it, else
 * `denseHit`'s), then the remaining lexical hits in their own order, up to `limit`.
 */
export function fuseByFile<H extends { pointer: string }>(hits: H[], dense: DenseFile[], limit: number, denseHit: (d: DenseFile) => H): H[] {
  const firstHit = new Map<string, H>();
  for (const h of hits) if (!firstHit.has(pointerFile(h.pointer))) firstHit.set(pointerFile(h.pointer), h);
  const lexFiles = [...firstHit.keys()];
  const lexRank = new Map(lexFiles.map((f, i) => [f, i]));
  const score = new Map<string, number>();
  const add = (files: string[]) => files.forEach((f, i) => score.set(f, (score.get(f) ?? 0) + 1 / (RRF_K + i + 1)));
  add(lexFiles);
  add(dense.map((d) => d.path));
  // A tie goes to the lexical order, then to the path.
  const lexAt = (f: string) => lexRank.get(f) ?? Infinity;
  const order = [...score]
    .sort((a, b) => b[1] - a[1] || lexAt(a[0]) - lexAt(b[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([f]) => f);
  const denseAt = new Map(dense.map((d) => [d.path, d]));
  const leaders: H[] = [];
  const used = new Set<H>();
  for (const f of order) {
    const lex = firstHit.get(f);
    if (lex) used.add(lex);
    leaders.push(lex ?? denseHit(denseAt.get(f)!));
  }
  return [...leaders, ...hits.filter((h) => !used.has(h))].slice(0, limit);
}

/** Embed a query with the shipped model, reading only its tokens' rows. */
export function embedQuery(query: string, dir?: string): Float32Array {
  const e = openEmbedder({ dir });
  try {
    return e.embed(query);
  } finally {
    e.close();
  }
}
