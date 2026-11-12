/**
 * A Rust file's calls look up the `use` declarations in scope. Every function body
 * is a block, so a lookup that walked every block made a file of n functions cost
 * n squared: tokio and tracing hold files of thousands of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractGeneric, warmGenericGrammars } from "../src/graph/generic.js";

/** n functions, each with a block body that makes a bare call, a path call and a method call. */
function rustFile(n: number): string {
  const fns = Array.from({ length: n }, (_, i) => `fn f${i}(x: &Store) -> u32 {\n    let y = helper(${i});\n    io::flush();\n    x.get(y)\n}\n`);
  return `use std::io;\nmod inner {\n    use super::*;\n    pub fn g() { helper(1); }\n}\n${fns.join("")}`;
}

/** Best of 3 runs, in ms. */
function extractMs(src: string): number {
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    extractGeneric("lib.rs", src, "rust");
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

test("Rust: extraction time grows with the file, not with its functions times its calls", async () => {
  await warmGenericGrammars(["rust"]);
  const small = rustFile(1500);
  const large = rustFile(6000);
  extractGeneric("lib.rs", small, "rust"); // warm-up
  const ratio = extractMs(large) / extractMs(small);
  // 4 times the functions: about 4 times the time when linear, about 16 when quadratic.
  assert.ok(ratio < 9, `4x the functions took ${ratio.toFixed(1)}x the time`);
});

test("Rust: dropping empty block scopes keeps what the `use`s in blocks and `mod`s mean", async () => {
  await warmGenericGrammars(["rust"]);
  const src = `use crate::store::Store;
mod shut {
    pub fn inside() { Store::open(); }
}
fn outer() {
    { use other::Store; Store::open(); }
    Store::open();
}
`;
  const { rawEdges } = extractGeneric("lib.rs", src, "rust");
  const calls = rawEdges
    .filter((e) => e.relation === "calls" && e.name === "open")
    .map((e) => `${e.source} ${e.rustPath ?? ""}`);
  assert.deepEqual(calls.sort(), ["lib.rs#inside Store::open", "lib.rs#outer crate::store::Store::open", "lib.rs#outer other::Store::open"].sort());
});
