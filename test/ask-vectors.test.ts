/**
 * `ask`'s semantic layer: chunking, the vectors sidecar a build writes and reuses,
 * reciprocal rank fusion with the lexical file order, and `TRAIL_SEMANTIC=0`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { ask } from "../src/ask/ask.js";
import { contextDirFor } from "../src/context/node-file.js";
import { chunkLines, fuseByFile, readVectors, vectorsPath, writeVectors, type DenseFile } from "../src/ask/vectors.js";

function withEnv<T>(value: string | undefined, run: () => T): T {
  const was = process.env.TRAIL_SEMANTIC;
  if (value === undefined) delete process.env.TRAIL_SEMANTIC;
  else process.env.TRAIL_SEMANTIC = value;
  try {
    return run();
  } finally {
    if (was === undefined) delete process.env.TRAIL_SEMANTIC;
    else process.env.TRAIL_SEMANTIC = was;
  }
}

async function withEnvAsync<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const was = process.env.TRAIL_SEMANTIC;
  if (value === undefined) delete process.env.TRAIL_SEMANTIC;
  else process.env.TRAIL_SEMANTIC = value;
  try {
    return await run();
  } finally {
    if (was === undefined) delete process.env.TRAIL_SEMANTIC;
    else process.env.TRAIL_SEMANTIC = was;
  }
}

test("chunks are runs of whole lines up to 750 characters, with their line numbers", () => {
  const line = "x".repeat(299);
  const source = [line, line, line, "", "y".repeat(900), "z"].join("\n");
  assert.deepEqual(
    chunkLines(source).map(([text, start, end]) => [text.length, start, end]),
    [
      [599, 1, 2],
      [300, 3, 4],
      [900, 5, 5],
      [1, 6, 6],
    ],
  );
  assert.deepEqual(chunkLines("\n  \n\t\n"), [], "blank text makes no chunk");
});

test("fusion ranks files by reciprocal rank, leading with one hit per file", () => {
  const hit = (pointer: string) => ({ pointer, from: "lexical" });
  const lexical = [hit("a.ts:L1-L2"), hit("b.ts:L3-L4"), hit("a.ts:L9-L9"), hit("c.ts")];
  const dense: DenseFile[] = [
    { path: "d.ts", score: 0.9, start: 5, end: 8 },
    { path: "b.ts", score: 0.8, start: 1, end: 2 },
  ];
  const out = fuseByFile(lexical, dense, 10, (d) => ({ pointer: `${d.path}:L${d.start}-L${d.end}`, from: "dense" }));
  // b: 1/62 + 1/62; a: 1/61; d: 1/61; c: 1/63. Ties sort by path.
  assert.deepEqual(
    out.map((h) => `${h.pointer} ${h.from}`),
    ["b.ts:L3-L4 lexical", "a.ts:L1-L2 lexical", "d.ts:L5-L8 dense", "c.ts lexical", "a.ts:L9-L9 lexical"],
  );
  assert.equal(fuseByFile(lexical, dense, 2, () => hit("never")).length, 2);
  assert.deepEqual(fuseByFile(lexical, [], 10, () => hit("never")).map((h) => h.pointer), ["a.ts:L1-L2", "b.ts:L3-L4", "c.ts", "a.ts:L9-L9"]);
});

test("a build reuses the vectors of unchanged files and embeds only changed ones", () => {
  const out = mkdtempSync(join(tmpdir(), "gg-vectors-"));
  const outDir = join(out, "graft");
  mkdirSync(outDir);
  try {
    withEnv(undefined, () => {
      const files = [
        { path: "a.ts", hash: "1", source: "export function alpha() {}\n" },
        { path: "b.ts", hash: "2", source: "export function beta() {}\n" },
      ];
      assert.equal(writeVectors(outDir, files), 2);
      assert.equal(writeVectors(outDir, files), 0, "nothing changed, nothing embedded");
      assert.equal(writeVectors(outDir, [files[0], { ...files[1], hash: "3", source: "export function gamma() {}\n" }]), 1);
      const index = readVectors(outDir)!;
      assert.deepEqual(index.files.map((f) => [f.path, f.hash, f.lines]), [["a.ts", "1", [1, 2]], ["b.ts", "3", [1, 2]]]);
      assert.equal(index.data.length, 2 * index.dim);
    });
    withEnv("0", () => writeVectors(outDir, []));
    assert.equal(existsSync(vectorsPath(outDir)), false, "TRAIL_SEMANTIC=0 removes the sidecar");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

/** Code whose words share nothing with the query below, beside 2 unrelated files. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "gg-semantic-"));
  writeFileSync(join(root, "auth.ts"), "export function verifyPassword(account: Account, secret: string): boolean {\n  return digest(secret) === account.digest;\n}\n");
  writeFileSync(join(root, "chart.ts"), "export function drawBars(values: number[]): void {\n  values.forEach((v) => canvas.rect(v));\n}\n");
  writeFileSync(join(root, "units.ts"), "export function celsiusToKelvin(c: number): number {\n  return c + 273.15;\n}\n");
  return root;
}

const QUERY = "login credentials";

test("a query with no word in the code still finds the file it means", async () => {
  const root = fixture();
  try {
    await withEnvAsync(undefined, () => buildGraph(root));
    const r = withEnv(undefined, () => ask(root, QUERY));
    assert.equal(r.mode, "lexical");
    assert.equal(r.hits[0]?.pointer, "auth.ts:L1-L3");
    assert.equal(r.hits[0]?.title, "verifyPassword · function");
    const off = withEnv("0", () => ask(root, QUERY));
    assert.equal(off.mode, "empty", "TRAIL_SEMANTIC=0 answers lexically, as before");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a graph built without vectors answers lexically and says so", async () => {
  const root = fixture();
  try {
    await withEnvAsync(undefined, () => buildGraph(root));
    unlinkSync(vectorsPath(contextDirFor(root)));
    const r = withEnv(undefined, () => ask(root, QUERY));
    assert.equal(r.mode, "empty");
    assert.match(r.note ?? "", /semantic ranking skipped: no vectors yet/);
    const off = withEnv("0", () => ask(root, QUERY));
    assert.doesNotMatch(off.note ?? "", /semantic/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
