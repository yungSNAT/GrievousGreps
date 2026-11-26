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
  "pkg/util.py": "def helper(x):\n    return x + 1\n\n\nclass HelperError(Exception):\n    pass\n",
  "py_except.py": "from pkg.util import HelperError\n\n\ndef guard(xs):\n    for e in xs:\n        check(e)\n    raise HelperError(\"empty\")\n\n\ndef retry():\n    try:\n        guard([])\n    except HelperError as e:\n        log(e)\n",
  "py_alias.py": "from pkg.util import helper as h\n\nh(3)\n",
  "py_plain.py": "from pkg.util import helper\n\nVALUES = [helper(i) for i in range(2)]\n",
  "pkg/py_relative.py": "from .util import helper as rel\n\n\ndef run():\n    return rel(6)\n",
  "py_module_init.py": "from pkg.util import helper as h2\n\nDEFAULT = {\"k\": h2(12)}\n",
  "py_comment.py": "from pkg.util import (  # )\n    helper as hc,\n)\n\nhc(5)\n",
  "py_comment_tight.py": "from pkg.util import (# )\n    helper as hd,\n)\n\nhd(7)\n",
  "py_comment_alias.py": "from pkg.util import helper  # helper as e\n\n\ndef scan(xs):\n    for e in xs:\n        check(e)\n    return helper(1)\n",
  "py_unused.py": "from pkg.util import helper as unused\n",
  "lib.ts": "export function helperTs(x: number): number {\n  return x + 1;\n}\n",
  "use.ts": "import { helperTs as ht } from \"./lib\";\n\nexport const y = ht(1);\n",
  "use_paren.ts": "import { helperTs } from \"./lib\"; import \"./side(\";\n\nexport const w = helperTs(3);\n",
  "use_str.ts": "import \"./helperTs as e\";\nimport { helperTs } from \"./lib\";\n\nexport function f(xs: number[]): number {\n  for (const e of xs) void e;\n  return helperTs(2);\n}\n",
  "use_multi.ts": "import {\n  helperTs as ht2,\n} from \"./lib\";\n\nexport const z = ht2(2);\n",
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
    assert.match(py.stdout, /py_comment\.py L5: hc\(5\)/, "a bracket in a comment does not close the import");
    assert.match(py.stdout, /py_comment_tight\.py L5: hd\(7\)/, "a comment straight after the bracket");
    assert.match(py.stdout, /scan L7: return helper\(1\)/, "an `as` in a comment binds no alias");
    assert.doesNotMatch(py.stdout, /L1: from /, "an import line is not quoted where the file calls the name");
    const ts = runCli(["callers", "helperTs", dir, "--no-refresh"]);
    assert.equal(ts.status, 0, ts.describe());
    assert.match(ts.stdout, /L3: export const y = ht\(1\);/);
    assert.match(ts.stdout, /L5: export const z = ht2\(2\);/, "an alias bound inside a multi-line import");
    assert.match(ts.stdout, /use_paren\.ts L3: export const w = helperTs\(3\);/, "a bracket in a module path does not open the import");
    assert.match(ts.stdout, /f L6: return helperTs\(2\);/, "an `as` in a module path binds no alias");
    const err = runCli(["callers", "HelperError", dir, "--no-refresh"]);
    assert.equal(err.status, 0, err.describe());
    assert.match(err.stdout, /guard L7: raise HelperError\("empty"\)/, "an except binding is no import alias");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
