/**
 * Routers mounted from another file (`src/graph/route-mounts.ts`), the cases a wrong step would
 * misplace: a router mounted in its own file and from another, a Python package's own binding
 * against its submodule, CommonJS `module.exports` replacement and `require` of the whole value,
 * shadowed loaders and rebound imports, and a warm build that changes only a mount's prefix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";
import { checkGraphInvariants } from "../src/graph/invariants.js";
import { built, k8s, path, routeEdges, routeIds, withGraph } from "./deploy-routes-fixtures.js";

test("a router mounted in its own file and from another has a route under each prefix, each once", async () => {
  await withGraph({
    "both/api.py": `from fastapi import FastAPI, APIRouter

r = APIRouter()

@r.get("/x")
def x():
    return 1

app = FastAPI()
app.include_router(r, prefix="/local")
`,
    "both/other.py": `from fastapi import FastAPI
from both.api import r

other = FastAPI()
other.include_router(r, prefix="/remote")
other.include_router(r, prefix="/local")
`,
    "both/third.py": `from fastapi import FastAPI
from both.api import r

third = FastAPI()
third.include_router(r, prefix="/remote")
`,
  }, (graph) => {
    assert.deepEqual(routeIds(graph), ["both/api.py#route:GET /local/x", "both/api.py#route:GET /remote/x"]);
  });
});

test("Python: a package's own binding of a name wins over its submodule; a namespace package's submodule is found", async () => {
  await withGraph({
    "s1/__init__.py": "",
    "s1/main.py": `from fastapi import FastAPI
from s1.pkg import users

app = FastAPI()
app.include_router(users.router, prefix="/api")
`,
    // The package binds users from a dependency: s1/pkg/users.py is not what main.py mounts.
    "s1/pkg/__init__.py": "from somelib import users\n",
    "s1/pkg/users.py": "from fastapi import APIRouter\n\nrouter = APIRouter()\n\n@router.get(\"/u\")\ndef u():\n    return 1\n",
    // A package that assigns the name itself.
    "s1/made/__init__.py": "users = make_users()\n",
    "s1/made/users.py": "from fastapi import APIRouter\n\nrouter = APIRouter()\n\n@router.get(\"/m\")\ndef m():\n    return 1\n",
    "s1/app2.py": `from fastapi import FastAPI
from s1.made import users

app = FastAPI()
app.include_router(users.router, prefix="/made")
`,
    // A package whose __init__ imports its own submodule: that submodule is the name.
    "s1/own/__init__.py": "from . import users\n",
    "s1/own/users.py": "from fastapi import APIRouter\n\nrouter = APIRouter()\n\n@router.get(\"/o\")\ndef o():\n    return 1\n",
    "s1/app3.py": `from fastapi import FastAPI
from s1.own import users

app = FastAPI()
app.include_router(users.router, prefix="/own")
`,
    "nsapp/main.py": `from fastapi import FastAPI
from nsapp.routes import users

app = FastAPI()
app.include_router(users.router, prefix="/n")
`,
    "nsapp/routes/users.py": "from fastapi import APIRouter\n\nrouter = APIRouter()\n\n@router.get(\"/u\")\ndef u():\n    return 1\n",
  }, (graph) => {
    assert.deepEqual(routeIds(graph), ["nsapp/routes/users.py#route:GET /n/u", "s1/own/users.py#route:GET /own/o"]);
  });
});

test("CommonJS: the last module.exports wins, a write that may not run hides the module, and require gives the whole value", async () => {
  await withGraph({
    "cjs/server.js": `const express = require("express");
const a = require("./a");
const b = require("./b");
const c = require("./c");
const { r: d } = require("./d");
const m = require("./m");
const e = require("./e");
const app = express();
app.use("/a", a);
app.use("/b", b);
app.use("/c", c);
app.use("/d", d);
app.use("/m", m);
app.use("/e", e);
`,
    "cjs/esm.mjs": `import express from "express";
import m from "./m.js";
const app = express();
app.use("/esm", m);
`,
    // Replaced by a value not known here.
    "cjs/a.js": `const express = require("express");
const r = express.Router();
r.get("/x", (req, res) => res.end());
module.exports = r;
module.exports = choose();
`,
    // Exported only when a condition holds.
    "cjs/b.js": `const express = require("express");
const r = express.Router();
r.get("/x", (req, res) => res.end());
if (process.env.B) {
  module.exports = r;
}
`,
    // The later assignment wins.
    "cjs/c.js": `const { Router } = require("express");
const old = Router();
old.get("/old", (req, res) => res.end());
const r = Router();
r.get("/new", (req, res) => res.end());
module.exports = old;
module.exports = r;
`,
    // exports.r writes to the object module.exports no longer holds.
    "cjs/d.js": `const { Router } = require("express");
const r = Router();
r.get("/y", (req, res) => res.end());
module.exports = {};
exports.r = r;
`,
    // require and a default import give module.exports itself, not its default property.
    "cjs/m.js": `const { Router } = require("express");
const a = Router();
a.get("/whole", (req, res) => res.end());
const b = Router();
b.get("/prop", (req, res) => res.end());
module.exports = a;
module.exports.default = b;
`,
    // require of an ES module gives its namespace, not its default export.
    "cjs/e.mjs": `import { Router } from "express";
const r = Router();
r.get("/z", (req, res) => res.end());
export default r;
`,
    "cjs/e.js": `module.exports = require("./e.mjs");\n`,
  }, (graph) => {
    assert.deepEqual(routeIds(graph), ["cjs/c.js#route:GET /c/new", "cjs/m.js#route:GET /esm/whole", "cjs/m.js#route:GET /m/whole"]);
  });
});

test("nothing is guessed: a shadowed require, a rebound import, a CommonJS forward or require of an ES module gives no route", async () => {
  await withGraph({
    "sh/server.js": `const express = require("express");
const app = express();
function mount(require) {
  app.use("/p", require("./r"));
}
{
  const require = lookup;
  app.use("/q", require("./r"));
}
let w = require("./r");
w = wrap(w);
app.use("/w", w);
const f = require("./fwd");
app.use("/f", f);
const s = require("./s.mjs");
app.use("/s", s);
`,
    "sh/r.js": `const express = require("express");
const r = express.Router();
r.get("/z", (req, res) => res.end());
module.exports = r;
`,
    "sh/fwd.js": `module.exports = require("./r2");\n`,
    "sh/r2.js": `const express = require("express");
const r = express.Router();
r.get("/two", (req, res) => res.end());
module.exports = r;
`,
    "sh/s.mjs": `import { Router } from "express";
const r = Router();
r.get("/esm", (req, res) => res.end());
export default r;
`,
    "py/main.py": `from fastapi import FastAPI
from py.c import c

c = wrap(c)
app = FastAPI()
app.include_router(c, prefix="/c")
`,
    "py/c.py": "from fastapi import APIRouter\n\nc = APIRouter()\n\n@c.get(\"/z\")\ndef z():\n    return 1\n",
  }, (graph) => {
    assert.deepEqual(routeIds(graph), []);
  });
});

test("a warm build that changes only a mount's prefix moves the mounted routes and reuses the router's parse", async () => {
  const files = {
    "warm/main.py": "from fastapi import FastAPI\nfrom warm.users import router\n\napp = FastAPI()\napp.include_router(router, prefix=\"/one\")\n",
    "warm/users.py": "from fastapi import APIRouter\n\nrouter = APIRouter()\n\n@router.get(\"/u\")\ndef u():\n    return 1\n",
    "k8s/app.yaml": k8s([path("/two/u", "Exact", "api")]),
    "warm/Dockerfile": "FROM python:3.12\nCOPY . /app\n",
    "compose.yaml": "services:\n  api: { build: warm, image: acme/api }\n",
  };
  const { root, graph } = await built(files);
  try {
    assert.deepEqual(routeIds(graph), ["warm/users.py#route:GET /one/u"]);
    writeFileSync(join(root, "warm/main.py"), files["warm/main.py"].replace("/one", "/two"));
    const again = await buildGraph(root);
    assert.equal(again.reused, again.files - 1);
    const warm = readGraph(wiringPath(contextDirFor(root)))!;
    assert.deepEqual(routeIds(warm), ["warm/users.py#route:GET /two/u"]);
    assert.deepEqual(routeEdges(warm).filter((e) => e.startsWith("k8s/")), ["k8s/app.yaml#Ingress/default/main -> warm/users.py#route:GET /two/u (inferred)"]);
    assert.deepEqual(checkGraphInvariants(warm).problems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
