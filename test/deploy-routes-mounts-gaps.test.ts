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
import { prefixesOf, type MountGraph } from "../src/graph/routes.js";
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

test("two registrations of one path keep their own routes and handlers when mounted from 2 files", async () => {
  await withGraph({
    "twice/api.py": `from fastapi import FastAPI, APIRouter

r = APIRouter()

@r.get("/x")
def first():
    return 1

@r.get("/x")
def second():
    return 2

app = FastAPI()
app.include_router(r, prefix="/local")
`,
    "twice/other.py": `from fastapi import FastAPI
from twice.api import r

other = FastAPI()
other.include_router(r, prefix="/remote")
`,
  }, (graph) => {
    const handlers = routeEdges(graph).map((e) => e.replace(/#route:GET (\/\w+)\/x(~\d+)? -> twice\/api\.py#/, " $1 "));
    assert.deepEqual(handlers, ["twice/api.py /local first", "twice/api.py /local second", "twice/api.py /remote first", "twice/api.py /remote second"]);
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
const { default: dp } = require("./m");
const app = express();
app.use("/a", a);
app.use("/b", b);
app.use("/c", c);
app.use("/d", d);
app.use("/m", m);
app.use("/dp", dp);
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
    // require and a default import give module.exports itself; destructuring default gives the property.
    "cjs/m.js": `const { Router } = require("express");
const a = Router();
a.get("/whole", (req, res) => res.end());
const b = Router();
b.get("/prop", (req, res) => res.end());
module.exports = a;
module.exports.default = b;
`,
  }, (graph) => {
    assert.deepEqual(routeIds(graph), ["cjs/c.js#route:GET /c/new", "cjs/m.js#route:GET /dp/prop", "cjs/m.js#route:GET /esm/whole", "cjs/m.js#route:GET /m/whole"]);
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

// Each form binds `users` in a package's __init__.py, or rebinds an imported `bp` in the module a mount imports it
// from, in a way route-mounts.ts does not model: the name is then opaque, so neither the submodule nor the first
// import is followed. `ok` is the control that does give a route.
const PACKAGE_FORMS: Record<string, string> = {
  ok: "",
  imported: "from somelib import users\n",
  rebound: "from . import users\nusers = make(users)\n",
  assigned: "users = make()\n",
  tuple: "users, other = make()\n",
  loop: "for users in make():\n    pass\n",
  with: "with make() as users:\n    pass\n",
  walrus: "(users := make())\n",
  splat: "match make():\n    case [*users]:\n        pass\n",
  matchas: "match make():\n    case {} as users:\n        pass\n",
  global: "def setup():\n    global users\n    users = make()\n",
  star: "from .extra import *\n",
  def: "def users():\n    return 1\n",
  class: "class users:\n    pass\n",
  getattr: "def __getattr__(name):\n    return make(name)\n",
  globals: "globals()[\"users\"] = make()\n",
  // Not listed by any review: the rule, not a list, denies them.
  locals: "locals()[\"users\"] = make()\n",
  finally: "try:\n    pass\nfinally:\n    users = None\n",
  sysmodules: "import sys\nsys.modules[__name__].users = make()\n",
};
const MODULE_FORMS: Record<string, string> = {
  ok: "from .impl import bp\n",
  rebound: "from .impl import bp\nbp = wrap(bp)\n",
  loop: "from .impl import bp\nfor bp in [bp]:\n    pass\n",
  def: "from .impl import bp\ndef bp():\n    return 1\n",
  del: "from .impl import bp\ndel bp\n",
  exceptas: "from .impl import bp\ntry:\n    setup()\nexcept Exception as bp:\n    pass\n",
  except: "from .impl import bp\ntry:\n    setup()\nexcept Exception:\n    bp = None\n",
  globals: "from .impl import bp\nglobals()[\"bp\"] = make()\n",
  // Not listed by any review.
  setattr: "import sys\nfrom .impl import bp\nsetattr(sys.modules[__name__], \"bp\", make())\n",
  exceptgroup: "from .impl import bp\ntry:\n    setup()\nexcept* Exception as bp:\n    pass\n",
  importas: "from .impl import bp\nimport os.path as bp\n",
  starafter: "from .impl import bp\nfrom .extra import *\n",
  sysmodules: "import sys\nfrom .impl import bp\nsys.modules[__name__].bp = make()\n",
  // A def, class or lambda header runs at module level.
  defdefault: "from .impl import bp\ndef f(x=(bp := make())):\n    return x\n",
  classbase: "from .impl import bp\nclass A((bp := object)):\n    pass\n",
  lambdadefault: "from .impl import bp\nf = lambda x=(bp := make()): x\n",
  decorator: "from .impl import bp\n@(bp := deco)\ndef f():\n    pass\n",
  annotation: "from .impl import bp\ndef f(x: (bp := int)):\n    pass\n",
  // Still routes: a star import before the name, setattr and vars inside a function, an annotation without a value.
  okstar: "from .extra import *\nfrom .impl import bp\n",
  okset: "from .impl import bp\ndef update(o, d):\n    for k, v in d.items():\n        setattr(o, k, v)\n    return vars(o)\n",
  okannot: "from .impl import bp\nbp: object\n",
  typealias: "from .impl import bp\ntype bp = int\n",
  sysalias: "import sys as s\nfrom .impl import bp\ns.modules[__name__].bp = make()\n",
  fromsys: "from sys import modules as m\nfrom .impl import bp\nm[__name__].bp = make()\n",
  // Still routes: a method or attribute that shares a builtin's name is not the builtin.
  okmethods: "from .impl import bp\nrows = session.exec(query)\nmodel.eval()\nobj.globals()\nlimit = cfg.vars\nflag = re.compile(p).eval\ny = obj.locals\nsetup(vars=1)\n",
  okfromsys: "from sys import argv\nfrom .impl import bp\n",
  okparam: "from .impl import bp\ndef helper(vars):\n    return vars\n",
  parenexec: "from .impl import bp\n(exec)(\"bp = make()\")\n",
};
// The mounting file's own imports, `{p}` its package.
const MAIN_FORMS: Record<string, string> = {
  star: "from {p}.impl import bp\nfrom {p}.extra import *\n",
  okstar: "from {p}.extra import *\nfrom {p}.impl import bp\n",
};
// Each form writes CommonJS exports in a way readCommonExports does not model: the module's exports are opaque.
const COMMONJS_FORMS: Record<string, string> = {
  ok: "module.exports = { r };",
  spread: "module.exports = { r, ...other };",
  computed: "module.exports = { r, [k]: x };",
  quoted: "module.exports = { r, \"r\": x };",
  getter: "module.exports = { r, get x() { return 1; } };",
  method: "module.exports = { r, x() {} };",
  assign: "module.exports = { r };\nObject.assign(module.exports, other);",
  define: "exports.r = r;\nObject.defineProperty(exports, \"r\", { get: () => x });",
  subscript: "module.exports = { r };\nmodule.exports[k] = x;",
  quotedname: "exports.r = r;\nexports[\"r\"] = x;",
  chained: "module.exports = exports = { r };",
  read: "exports.r = r;\nlog(module.exports);",
  bracket: "module.exports = { r };\nmodule[\"exports\"] = { r: x };",
  alias: "module.exports = { r };\nconst m = module;\nm.exports = { r: x };",
  this: "exports.r = r;\nthis.r = x;",
  argument: "module.exports = { r };\nsetup(module);",
  shorthand: "exports.r = r;\nsetup({ exports });",
  // Not listed by any review.
  optional: "module.exports = { r };\nmodule?.exports.r;",
  destructure: "exports.r = r;\n({ exports } = other);",
  arrowthis: "exports.r = r;\nconst set = () => { this.r = x; };",
  evalwrite: "exports.r = r;\neval(\"module.exports = { r: x }\");",
  construct: "exports.r = r;\nFunction(\"return this\")().r = x;",
  cache: "exports.r = r;\nrequire.cache[__filename].exports = { r: x };",
  arguments: "exports.r = r;\narguments[0].r = x;",
  // Still routes: a read that changes nothing, and a function's own arguments.
  okmain: "module.exports = { r };\nif (require.main === module) start();",
  okargs: "module.exports = { r };\nfunction first() { return arguments[0]; }",
  // An indirect eval and a Function body run in global scope, where the module's exports are out of reach.
  pareneval: "exports.r = r;\n(eval)(\"exports.r = x\");",
  okindirect: "module.exports = { r };\n(0, eval)(\"exports.r = x\");\nconst isFn = (f) => f instanceof Function;",
};

test("an unmodelled binding form gives no route: a package's name, a rebound import, CommonJS exports", async () => {
  const files: Record<string, string> = {};
  for (const [form, init] of Object.entries(PACKAGE_FORMS)) {
    files[`pk_${form}/__init__.py`] = init;
    files[`pk_${form}/extra.py`] = "users = 1\n";
    files[`pk_${form}/users.py`] = "from fastapi import APIRouter\n\nrouter = APIRouter()\n\n@router.get(\"/u\")\ndef u():\n    return 1\n";
    files[`pk_${form}/main.py`] = `from fastapi import FastAPI\nfrom pk_${form} import users\n\napp = FastAPI()\napp.include_router(users.router, prefix="/${form}")\n`;
  }
  for (const [form, views] of Object.entries(MODULE_FORMS)) {
    files[`md_${form}/__init__.py`] = "";
    files[`md_${form}/impl.py`] = "from flask import Blueprint\n\nbp = Blueprint(\"bp\", __name__)\n\n@bp.route(\"/z\")\ndef z():\n    return 1\n";
    files[`md_${form}/views.py`] = views;
    files[`md_${form}/extra.py`] = "bp = 1\n";
    files[`md_${form}/main.py`] = `from flask import Flask\nfrom md_${form}.views import bp\n\napp = Flask(__name__)\napp.register_blueprint(bp, url_prefix="/${form}")\n`;
  }
  for (const [form, imports] of Object.entries(MAIN_FORMS)) {
    files[`ms_${form}/__init__.py`] = "";
    files[`ms_${form}/impl.py`] = files["md_ok/impl.py"];
    files[`ms_${form}/extra.py`] = "bp = 1\n";
    files[`ms_${form}/main.py`] = `from flask import Flask\n${imports.replaceAll("{p}", `ms_${form}`)}\napp = Flask(__name__)\napp.register_blueprint(bp, url_prefix="/${form}")\n`;
  }
  for (const [form, write] of Object.entries(COMMONJS_FORMS)) {
    files[`cj_${form}/m.js`] = `const { Router } = require("express");\nconst r = Router();\nr.get("/w", (req, res) => res.end());\n${write}\n`;
    files[`cj_${form}/server.js`] = `const express = require("express");\nconst { r } = require("./m");\nconst app = express();\napp.use("/${form}", r);\n`;
  }
  await withGraph(files, (graph) => {
    assert.deepEqual(routeIds(graph), [
      "cj_ok/m.js#route:GET /ok/w", "cj_okargs/m.js#route:GET /okargs/w", "cj_okindirect/m.js#route:GET /okindirect/w",
      "cj_okmain/m.js#route:GET /okmain/w",
      "md_ok/impl.py#route:GET /ok/z", "md_okannot/impl.py#route:GET /okannot/z", "md_okfromsys/impl.py#route:GET /okfromsys/z",
      "md_okmethods/impl.py#route:GET /okmethods/z", "md_okparam/impl.py#route:GET /okparam/z", "md_okset/impl.py#route:GET /okset/z",
      "md_okstar/impl.py#route:GET /okstar/z", "ms_okstar/impl.py#route:GET /okstar/z", "pk_ok/users.py#route:GET /ok/u",
    ]);
  });
});

test("prefixesOf gives no prefix, after a bounded walk, when mounts fan in at every level", () => {
  // 8 levels of routers, each mounted 4 times into the next: 4^8 paths to the app.
  let visits = 0;
  const graph: MountGraph = {
    object: (key) => ({ app: key === "r8", own: [], count: 1 }),
    into: (key) => {
      visits++;
      const level = Number(key.slice(1));
      return level >= 8 ? [] : Array.from({ length: 4 }, () => ({ parent: `r${level + 1}`, prefix: [{ lit: "p" }] }));
    },
  };
  assert.deepEqual(prefixesOf(graph, "r0"), []);
  assert.ok(visits <= 1000, `${visits} objects walked`);
});
