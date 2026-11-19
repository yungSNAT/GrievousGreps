/**
 * `ask`'s semantic layer: chunking, the vectors sidecar a build writes and reuses,
 * reciprocal rank fusion with the lexical file order, and `TRAIL_SEMANTIC=0`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { ask } from "../src/ask/ask.js";
import { contextDirFor } from "../src/context/node-file.js";
import { chunkLines, denseFiles, fuseByFile, readVectors, vectorsPath, writeVectors, type DenseFile } from "../src/ask/vectors.js";
import { relevantRetrieval } from "../src/claude/format.js";

async function withEnv<T>(value: string | undefined, run: () => T | Promise<T>): Promise<T> {
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

test("a build reuses the vectors of unchanged files and embeds only changed ones", async () => {
  const out = mkdtempSync(join(tmpdir(), "gg-vectors-"));
  const outDir = join(out, "graft");
  mkdirSync(outDir);
  try {
    await withEnv(undefined, () => {
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
    await withEnv("0", () => writeVectors(outDir, []));
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
    await withEnv(undefined, () => buildGraph(root));
    const r = await withEnv(undefined, () => ask(root, QUERY));
    assert.equal(r.mode, "lexical");
    assert.equal(r.hits[0]?.pointer, "auth.ts:L1-L3");
    assert.equal(r.hits[0]?.title, "verifyPassword · function");
    const off = await withEnv("0", () => ask(root, QUERY));
    assert.equal(off.mode, "empty", "TRAIL_SEMANTIC=0 answers lexically, as before");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a graph built without vectors answers lexically and says so", async () => {
  const root = fixture();
  try {
    await withEnv(undefined, () => buildGraph(root));
    unlinkSync(vectorsPath(contextDirFor(root)));
    const r = await withEnv(undefined, () => ask(root, QUERY));
    assert.equal(r.mode, "empty");
    assert.match(r.note ?? "", /semantic ranking skipped: no vectors yet/);
    const off = await withEnv("0", () => ask(root, QUERY));
    assert.doesNotMatch(off.note ?? "", /semantic/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("files found only by meaning carry no word coverage, so the prompt hook does not inject them", async () => {
  const root = fixture();
  try {
    await withEnv(undefined, () => buildGraph(root));
    const r = await withEnv(undefined, () => ask(root, QUERY));
    assert.equal(r.hits[0]?.pointer, "auth.ts:L1-L3");
    assert.deepEqual([r.coverage, r.coverageStrong], [0, 0]);
    const session = { graftReads: 0, sourceReads: 0, savedTokens: 0, injectedPointers: [] as string[] };
    relevantRetrieval(r as unknown as Parameters<typeof relevantRetrieval>[0], session as unknown as Parameters<typeof relevantRetrieval>[1]);
    assert.deepEqual(session.injectedPointers, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable model leaves ask lexical, with a note, instead of failing", async () => {
  const root = fixture();
  const bad = mkdtempSync(join(tmpdir(), "gg-badmodel-"));
  writeFileSync(join(bad, "tokenizer.json"), "{ not json");
  writeFileSync(join(bad, "model.safetensors"), "text");
  try {
    await withEnv(undefined, () => buildGraph(root));
    const r = await withEnv(undefined, () => ask(root, QUERY, { modelDir: bad }));
    assert.equal(r.mode, "empty");
    assert.match(r.note ?? "", /semantic ranking skipped: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});

test("a query with no known token, or of another width, ranks no file by meaning", () => {
  const index = { model: "m", dim: 2, files: [{ path: "a.ts", hash: "1", lines: [1, 1] }, { path: "b.ts", hash: "2", lines: [1, 1] }], data: Uint16Array.from([0x3c00, 0, 0, 0x3c00]) };
  assert.equal(denseFiles(index, Float32Array.from([1, 0]))[0]?.path, "a.ts");
  assert.deepEqual(denseFiles(index, new Float32Array(2)), [], "a zero vector");
  assert.deepEqual(denseFiles(index, Float32Array.from([1, 0, 0])), [], "another width");
  assert.deepEqual(denseFiles(index, Float32Array.from([NaN, 0])), [], "not finite");
});

test("a tie in the fusion goes to the lexical file, not to the earlier path", () => {
  const hit = (pointer: string) => ({ pointer });
  const out = fuseByFile([hit("z.ts:L1-L2")], [{ path: "a.ts", score: 0.5, start: 1, end: 1 }], 10, (d) => hit(`${d.path}:L1-L1`));
  assert.deepEqual(out.map((h) => h.pointer), ["z.ts:L1-L2", "a.ts:L1-L1"]);
});

test("a failed vectors write removes the old vectors, and other versions or chunk sizes are not read", async () => {
  const out = mkdtempSync(join(tmpdir(), "gg-vectors-"));
  const outDir = join(out, "graft");
  mkdirSync(outDir);
  try {
    await withEnv(undefined, () => writeVectors(outDir, [{ path: "a.ts", hash: "1", source: "export function alpha() {}\n" }]));
    const good = readFileSync(vectorsPath(outDir));
    for (const [from, to] of [['"version":1', '"version":2'], ['"chunk":750', '"chunk":751']]) {
      writeFileSync(vectorsPath(outDir), Buffer.from(good.toString("latin1").replace(from, to), "latin1"));
      assert.equal(readVectors(outDir), null, to);
    }
    writeFileSync(vectorsPath(outDir), good);
    await assert.rejects(() => withEnv(undefined, () => writeVectors(outDir, [{ path: "b.ts", hash: "2", source: undefined as unknown as string }])));
    assert.equal(existsSync(vectorsPath(outDir)), false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a build with TRAIL_SEMANTIC=0 writes no vectors", async () => {
  const root = fixture();
  try {
    await withEnv("0", () => buildGraph(root));
    assert.equal(existsSync(vectorsPath(contextDirFor(root))), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a damaged or empty chunk vector never ranks its file", () => {
  const NAN16 = 0x7e00;
  const index = {
    model: "m", dim: 2,
    files: [{ path: "a.ts", hash: "1", lines: [1, 1] }, { path: "m.ts", hash: "2", lines: [1, 1] }, { path: "e.ts", hash: "3", lines: [1, 1] }, { path: "z.ts", hash: "4", lines: [1, 1] }],
    data: Uint16Array.from([NAN16, 0, 0x3c00, 0, 0, 0, 0x2e66, 0]),
  };
  assert.deepEqual(denseFiles(index, Float32Array.from([1, 0])).map((d) => d.path), ["m.ts", "z.ts"]);
});

test("a short answer is the start of a longer one", async () => {
  const root = fixture();
  // Words of the query in every file, so the word ranking runs deeper than a short limit.
  writeFileSync(join(root, "login.ts"), "// login credentials form: account, secret, values, number, canvas\nexport const loginFormLabels = ['account', 'secret'];\n");
  try {
    await withEnv(undefined, () => buildGraph(root));
    for (const q of ["login credentials", "account secret values number", "canvas number account"]) {
      const long = await withEnv(undefined, () => ask(root, q, { limit: 10 }));
      for (const limit of [1, 2]) {
        const short = await withEnv(undefined, () => ask(root, q, { limit }));
        assert.deepEqual(short.hits.map((h) => h.pointer), long.hits.slice(0, limit).map((h) => h.pointer), `${q} at ${limit}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
