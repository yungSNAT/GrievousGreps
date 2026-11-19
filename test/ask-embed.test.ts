/**
 * The shipped model's embeddings match model2vec's own.
 *
 * `fixtures/ask-embed/model2vec.json` holds, for fixed strings (code, prose, accents,
 * CJK, control characters, an over-long word, a text past 512 tokens), the token ids
 * model2vec 0.10.0's `tokenize` gave and the vectors its `encode` gave, for the model
 * committed in `models/potion-code-16M-v2`. model2vec averages in float16, so vectors
 * agree to float16 precision, not exactly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_DIR, f16ToF32, f32ToF16, loadTokenizer, openEmbedder, tokenIds } from "../src/ask/embed.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "ask-embed", "model2vec.json"), "utf8")) as {
  cases: { text: string; ids: number[]; vector: number[] }[];
};

test("the committed model is the one the fixtures came from", () => {
  const hash = createHash("sha256").update(readFileSync(join(MODEL_DIR, "model.safetensors"))).digest("hex");
  assert.equal(hash, "75cf7a6c2171b230ad19b1e7d8e0b1aee86da5a02af8e7cacedd9921d227623c");
});

test("token ids match model2vec's for every fixture string", () => {
  const tok = loadTokenizer();
  for (const c of fixture.cases) assert.deepEqual(tokenIds(tok, c.text), c.ids, JSON.stringify(c.text.slice(0, 60)));
});

for (const whole of [true, false]) {
  test(`vectors match model2vec's to float16 precision (${whole ? "whole table" : "rows on demand"})`, () => {
    const e = openEmbedder({ whole });
    try {
      for (const c of fixture.cases) {
        const v = e.embed(c.text);
        assert.equal(v.length, c.vector.length);
        const worst = Math.max(...c.vector.map((x, i) => Math.abs(x - v[i])));
        assert.ok(worst < 2e-3, `${JSON.stringify(c.text.slice(0, 40))}: off by ${worst}`);
      }
    } finally {
      e.close();
    }
  });
}

test("float16 conversion round-trips every finite float16 value", () => {
  const all = new Uint16Array(65536).map((_, i) => i);
  const finite = all.filter((h) => ((h >> 10) & 0x1f) !== 31);
  assert.deepEqual(f32ToF16(f16ToF32(finite)), finite);
  // Ties go to even, and values past float16's range saturate.
  assert.deepEqual([...f32ToF16(new Float32Array([1 + 2 ** -11, 1 + 3 * 2 ** -11, 70000, -70000]))], [0x3c00, 0x3c02, 0x7c00, 0xfc00]);
});

/** A model folder holding the real tokenizer and `model` as its safetensors file. */
function modelDir(model: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "gg-model-"));
  copyFileSync(join(MODEL_DIR, "tokenizer.json"), join(dir, "tokenizer.json"));
  writeFileSync(join(dir, "model.safetensors"), model);
  return dir;
}

/** A safetensors file with one F16 'embeddings' table of `rows` x `dim`, holding `dataBytes` bytes. */
function safetensors(rows: number, dim: number, dataBytes: number): Buffer {
  const header = Buffer.from(JSON.stringify({ embeddings: { dtype: "F16", shape: [rows, dim], data_offsets: [0, rows * dim * 2] } }));
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([len, header, Buffer.alloc(dataBytes, 0x3c)]);
}

test("a truncated, short or unreadable model is refused, never read as zeros", () => {
  const cases: Array<[string, Buffer]> = [
    ["truncated after its header", safetensors(63457, 256, 1000)],
    ["fewer rows than the vocabulary", safetensors(100, 256, 100 * 256 * 2)],
    ["text, not safetensors", Buffer.from("this is not a model file at all, just text\n".repeat(4))],
  ];
  for (const [what, bytes] of cases) {
    const dir = modelDir(bytes);
    try {
      for (const whole of [true, false]) {
        assert.throws(() => openEmbedder({ whole, dir }).embed("parse the config file"), /model\.safetensors/, `${what}, whole ${whole}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("the text is cut by code points, as model2vec cuts a Python string", () => {
  const tok = loadTokenizer();
  // maxChars UTF-16 units, but half as many code points: the word after them is inside the cut.
  const text = `${"😀".repeat(tok.maxChars / 2)} file`;
  assert.deepEqual(tokenIds(tok, text), [tok.vocab.get("file")!]);
});
