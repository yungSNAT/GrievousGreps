/** `callers` quotes the call, not the import, when a file imports the name under another one. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { runCli } from "./helpers.js";

const FILES: Record<string, string> = {
  "pkg/__init__.py": "",
  "pkg/util.py": "def helper(x):\n    return x + 1\n",
  "py_alias.py": "from pkg.util import helper as h\n\nh(3)\n",
  "py_plain.py": "from pkg.util import helper\n\nVALUES = [helper(i) for i in range(2)]\n",
  "pkg/py_relative.py": "from .util import helper as rel\n\n\ndef run():\n    return rel(6)\n",
  "py_module_init.py": "from pkg.util import helper as h2\n\nDEFAULT = {\"k\": h2(12)}\n",
  "py_unused.py": "from pkg.util import helper as unused\n",
  "lib.ts": "export function helperTs(x: number): number {\n  return x + 1;\n}\n",
  "use.ts": "import { helperTs as ht } from \"./lib\";\n\nexport const y = ht(1);\n",
};

test("callers quotes the line that calls a name imported under an alias, at module level and inside a function", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gg-alias-quote-"));
  try {
    for (const [path, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    await buildGraph(dir);
    const py = runCli(["callers", "helper", dir, "--no-refresh"]);
    assert.equal(py.status, 0, py.describe());
    assert.match(py.stdout, /py_alias\.py L3: h\(3\)/);
    assert.match(py.stdout, /py_plain\.py L3: VALUES = \[helper\(i\) for i in range\(2\)\]/);
    assert.match(py.stdout, /run L5: return rel\(6\)/);
    assert.match(py.stdout, /py_module_init\.py L3: DEFAULT = \{"k": h2\(12\)\}/);
    assert.doesNotMatch(py.stdout, /L1: from /, "an import line is not quoted where the file calls the name");
    const ts = runCli(["callers", "helperTs", dir, "--no-refresh"]);
    assert.equal(ts.status, 0, ts.describe());
    assert.match(ts.stdout, /L3: export const y = ht\(1\);/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
