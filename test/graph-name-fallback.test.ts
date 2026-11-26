/**
 * A bare call name that matches one definition somewhere else in the repository is not
 * evidence that the call reaches it. Measured on rich and ripgrep (26 November 2026), the
 * Python bare-name fallback was right 0 of 12 (builtin `open()`, local aliases) and the Rust
 * method-form fallback 1 of 10 (`.clone()`, `.as_ref()`, `.and_then()` on untyped receivers).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFile } from "../src/graph/extract.js";
import { extractGeneric, warmGenericGrammars } from "../src/graph/generic.js";
import { resolveEdges } from "../src/graph/resolve.js";
import { warmDepthGrammars } from "../src/graph/depth-parser.js";

await warmDepthGrammars(["python"]);
await warmGenericGrammars(["rust"]);

function pythonCalls(files: Record<string, string>, source: string): string[] {
  const extracted = Object.entries(files).map(([path, text]) => extractFile(path, text, "python"));
  return resolveEdges(extracted.flatMap((x) => x.nodes), extracted.flatMap((x) => x.rawEdges))
    .filter((e) => e.source === source && e.relation === "calls")
    .map((e) => e.target)
    .sort();
}

function rustCalls(files: Record<string, string>, source: string): string[] {
  const extracted = Object.entries(files).map(([path, text]) => extractGeneric(path, text, "rust"));
  return resolveEdges(extracted.flatMap((x) => x.nodes), extracted.flatMap((x) => x.rawEdges))
    .filter((e) => e.source === source && e.relation === "calls")
    .map((e) => e.target)
    .sort();
}

const PYTHON = {
  "pkg/progress.py": "def open(file, mode='r'):\n    return file\n",
  "pkg/cells.py": "def _cell_len(text):\n    return len(text)\n\ndef cell_len(text):\n    return _cell_len(text)\n",
  "pkg/stars.py": "def starred():\n    return 1\n\nclass Starred:\n    pass\n",
  "pkg/widgets.py": "class Widget:\n    pass\n",
  "app/use.py": `from pkg.cells import cell_len
from pkg.stars import *

def save(path):
    with open(path) as handle:
        return handle

def length(text):
    _cell_len = cell_len
    return _cell_len(text)

def build():
    return Widget()

def via_star():
    Starred()
    return starred()

def local():
    return helper()

def helper():
    return 1
`,
};

test("a Python builtin call does not link to a repository function of the same name", () => {
  assert.deepEqual(pythonCalls(PYTHON, "app/use.py#save"), []);
});

test("a Python call through a local alias does not link to another file's function of that name", () => {
  assert.deepEqual(pythonCalls(PYTHON, "app/use.py#length"), []);
});

test("a Python class the file neither defines nor imports is not a constructor target", () => {
  assert.deepEqual(pythonCalls(PYTHON, "app/use.py#build"), []);
});

test("a Python star import and a same-file definition still resolve", () => {
  assert.deepEqual(pythonCalls(PYTHON, "app/use.py#via_star"), ["pkg/stars.py#Starred", "pkg/stars.py#starred"]);
  assert.deepEqual(pythonCalls(PYTHON, "app/use.py#local"), ["app/use.py#helper"]);
});

const RUST = {
  "src/error.rs": "pub struct Error;\n\nimpl Error {\n    pub fn duplicate(&self) -> Error {\n        Error\n    }\n}\n",
  "src/parse.rs": "pub fn parse_low_raw() -> u8 {\n    1\n}\n",
  "src/run.rs": `pub fn run() -> u8 {
    let value = make();
    value.duplicate();
    parse_low_raw()
}
`,
};

test("a Rust method call on an untyped receiver does not link to the one repository method of that name", () => {
  assert.deepEqual(rustCalls(RUST, "src/run.rs#run"), ["src/parse.rs#parse_low_raw"]);
});

test("a Rust method call on a field of no known type does not link by name either", () => {
  const files = { ...RUST, "src/run.rs": "pub struct Run { inner: Thing }\n\nimpl Run {\n    pub fn go(&self) {\n        self.inner.config.duplicate();\n    }\n}\n" };
  assert.deepEqual(rustCalls(files, "src/run.rs#go"), []);
});
