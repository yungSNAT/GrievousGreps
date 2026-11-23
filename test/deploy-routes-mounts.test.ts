/**
 * Routers mounted from another file (`src/graph/route-mounts.ts`): a FastAPI `include_router`, a
 * Flask `register_blueprint` in an app factory and an Express `use` of a router another module
 * exports give the routes their full path, once imports are resolved. Each route stays in the
 * file that registers it and links to its handler; nothing is guessed when a step is unknown.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";
import { checkGraphInvariants } from "../src/graph/invariants.js";
import { built, k8s, path, routeEdges, routeIds } from "./deploy-routes-fixtures.js";

async function withGraph(files: Record<string, string>, check: (graph: Awaited<ReturnType<typeof built>>["graph"]) => void) {
  const { root, graph } = await built(files);
  try {
    check(graph);
    assert.deepEqual(checkGraphInvariants(graph).problems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("FastAPI: a router imported by name, through its module or through a package's re-export is served under the mount's prefix", async () => {
  await withGraph({
    "app/__init__.py": "",
    "app/main.py": `from fastapi import FastAPI
from app.routers import users
from app.routers.items import router as items_router
from .routers import orders_router

app = FastAPI()
app.include_router(users.router, prefix="/api")
app.include_router(items_router, prefix="/v1")
app.include_router(orders_router)
`,
    "app/routers/__init__.py": "from .orders import router as orders_router\n",
    "app/routers/users.py": `from fastapi import APIRouter

router = APIRouter(prefix="/users")

@router.get("/{user_id}")
def get_user(user_id: int):
    return user_id
`,
    "app/routers/items.py": `from fastapi import APIRouter

router = APIRouter()

@router.delete("/items/{item_id}")
def delete_item(item_id: int):
    return item_id
`,
    "app/routers/orders.py": `from fastapi import APIRouter

router = APIRouter(prefix="/orders")

@router.get("")
def list_orders():
    return []
`,
    "app/Dockerfile": "FROM python:3.12\nCOPY . /app\n",
    "compose.yaml": "services:\n  api: { build: app, image: acme/api }\n",
    "k8s/app.yaml": k8s([path("/api/users", "Prefix", "api"), path("/orders", "Exact", "api")]),
  }, (graph) => {
    assert.deepEqual(routeIds(graph), [
      "app/routers/items.py#route:DELETE /v1/items/{item_id}",
      "app/routers/orders.py#route:GET /orders",
      "app/routers/users.py#route:GET /api/users/{user_id}",
    ]);
    assert.deepEqual(routeEdges(graph), [
      "app/routers/items.py#route:DELETE /v1/items/{item_id} -> app/routers/items.py#delete_item",
      "app/routers/orders.py#route:GET /orders -> app/routers/orders.py#list_orders",
      "app/routers/users.py#route:GET /api/users/{user_id} -> app/routers/users.py#get_user",
      "k8s/app.yaml#Ingress/default/main -> app/routers/orders.py#route:GET /orders (inferred)",
      "k8s/app.yaml#Ingress/default/main -> app/routers/users.py#route:GET /api/users/{user_id} (inferred)",
    ]);
    const route = graph.nodes.find((n) => n.id === "app/routers/users.py#route:GET /api/users/{user_id}")!;
    assert.equal(route.kind, "resource");
    assert.equal(route.signature, "route fastapi GET /api/users/{user_id}");
    assert.equal(route.span, "L5-L7");
    assert.ok(graph.edges.some((e) => e.source === "app/routers/users.py" && e.relation === "contains" && e.target === route.id));
  });
});

test("Flask: a blueprint registered in an app factory takes the registration's url_prefix", async () => {
  await withGraph({
    "web/__init__.py": "",
    "web/app.py": `from flask import Flask
from .views import bp
from .api import api

def create_app():
    app = Flask(__name__)
    app.register_blueprint(bp, url_prefix="/admin")
    app.register_blueprint(api)
    return app
`,
    "web/views.py": `from flask import Blueprint

bp = Blueprint("admin", __name__, url_prefix="/ignored")

@bp.route("/dash")
def dash():
    return "ok"
`,
    "web/api.py": `from flask import Blueprint

api = Blueprint("api", __name__, url_prefix="/api")

@api.route("/ping", methods=["POST"])
def ping():
    return "pong"
`,
    // The application factory pattern: imports inside the factory.
    "web2/__init__.py": "",
    "web2/app.py": `from flask import Flask

def create_app():
    app = Flask(__name__)
    from .views import bp
    from . import api
    app.register_blueprint(bp, url_prefix="/admin")
    app.register_blueprint(api.api)
    return app
`,
    "web2/views.py": `from flask import Blueprint

bp = Blueprint("admin", __name__)

@bp.route("/dash")
def dash():
    return "ok"
`,
    "web2/api.py": `from flask import Blueprint

api = Blueprint("api", __name__, url_prefix="/api")

@api.route("/ping", methods=["POST"])
def ping():
    return "pong"
`,
  }, (graph) => {
    assert.deepEqual(routeIds(graph), [
      "web/api.py#route:POST /api/ping", "web/views.py#route:GET /admin/dash",
      "web2/api.py#route:POST /api/ping", "web2/views.py#route:GET /admin/dash",
    ]);
    assert.deepEqual(routeEdges(graph), [
      "web/api.py#route:POST /api/ping -> web/api.py#ping",
      "web/views.py#route:GET /admin/dash -> web/views.py#dash",
      "web2/api.py#route:POST /api/ping -> web2/api.py#ping",
      "web2/views.py#route:GET /admin/dash -> web2/views.py#dash",
    ]);
    assert.equal(graph.nodes.find((n) => n.id === "web/views.py#route:GET /admin/dash")?.signature, "route flask GET /admin/dash");
  });
});

test("Express: a router another module exports, by require or import, default or named, is served under use's path", async () => {
  await withGraph({
    "srv/server.js": `const express = require("express");
const users = require("./routes/users");
const { teams } = require("./routes/teams");
const misc = require("./routes/misc");
const { both } = require("./routes/both");
const app = express();
app.use("/users", users);
app.use("/teams", teams);
app.use("/ping", require("./routes/ping"));
app.use(misc);
app.use("/both", both);
`,
    "srv/routes/both.js": `const { Router } = require("express");
const both = Router();
both.put("/x", (req, res) => res.end());
module.exports = { both };
`,
    "srv/routes/ping.js": `const express = require("express");
const r = express.Router();
r.get("/", (req, res) => res.end());
module.exports = r;
`,
    "srv/routes/misc.js": `const { Router } = require("express");
const misc = Router();
misc.get("/misc", (req, res) => res.end());
module.exports = misc;
`,
    "srv/routes/users.js": `const express = require("express");
const router = express.Router();
router.get("/:id", show);
function show(req, res) {
  res.end();
}
module.exports = router;
`,
    "srv/routes/teams.js": `const { Router } = require("express");
const teams = Router();
teams.post("/", (req, res) => res.end());
exports.teams = teams;
`,
    "esm/api.ts": `import express from "express";
import orders from "./orders.js";
import { adminRouter as admin } from "./admin.js";
import { reports } from "./routes/index.js";
const app = express();
app.use("/api", orders);
app.use("/admin", admin);
app.use("/reports", reports);
`,
    "esm/routes/index.ts": `export { default as reports } from "./reports.js";\n`,
    "esm/routes/reports.ts": `import { Router } from "express";
const reports = Router();
reports.get("/daily", (req, res) => res.end());
export default reports;
`,
    "esm/orders.ts": `import { Router } from "express";
import { list } from "./list.js";
const r = Router();
r.get("/orders", list);
export default r;
`,
    "esm/list.ts": "export function list() {}\n",
    "esm/admin.ts": `import { Router } from "express";
export const adminRouter = Router();
adminRouter.delete("/cache", (req, res) => res.end());
`,
  }, (graph) => {
    assert.deepEqual(routeIds(graph), [
      "esm/admin.ts#route:DELETE /admin/cache",
      "esm/orders.ts#route:GET /api/orders",
      "esm/routes/reports.ts#route:GET /reports/daily",
      "srv/routes/both.js#route:PUT /both/x",
      "srv/routes/misc.js#route:GET /misc",
      "srv/routes/ping.js#route:GET /ping",
      "srv/routes/teams.js#route:POST /teams",
      "srv/routes/users.js#route:GET /users/{id}",
    ]);
    assert.deepEqual(routeEdges(graph), [
      "esm/orders.ts#route:GET /api/orders -> esm/list.ts#list",
      "srv/routes/users.js#route:GET /users/{id} -> srv/routes/users.js#show",
    ]);
    assert.equal(graph.nodes.find((n) => n.id === "srv/routes/users.js#route:GET /users/{id}")?.signature, "route express GET /users/{id}");
  });
});

test("a chain of mounts across 3 files adds each prefix; a router mounted from 2 files has a route under each", async () => {
  await withGraph({
    "chain/main.py": `from fastapi import FastAPI
from chain.api import api

app = FastAPI()
app.include_router(api, prefix="/api")
`,
    "chain/api.py": `from fastapi import APIRouter
from chain.v1 import v1

api = APIRouter()
api.include_router(v1, prefix="/v1")
`,
    "chain/v1.py": `from fastapi import APIRouter

v1 = APIRouter()

@v1.get("/status")
def status():
    return "ok"
`,
    "chain/admin.py": `from fastapi import FastAPI
from chain.v1 import v1

admin = FastAPI()
admin.include_router(v1, prefix="/internal")
`,
    "chain/dup.py": `from fastapi import FastAPI
from chain.v1 import v1

dup = FastAPI()
dup.include_router(v1, prefix="/api/v1")
`,
  }, (graph) => {
    // dup.py serves v1 at the path main.py's chain gives it: one route, not two.
    assert.deepEqual(routeIds(graph), ["chain/v1.py#route:GET /api/v1/status", "chain/v1.py#route:GET /internal/status"]);
  });
});

test("nothing is guessed: an unknown prefix (Python or Express), a router bound twice, an import cycle, a test file's mount or an unmounted router gives no route", async () => {
  await withGraph({
    "g/main.py": `from fastapi import FastAPI
from g.a import a
from g.b import b
from g.c import c
import os

app = FastAPI()
app.include_router(a, prefix=os.environ["P"])
app.include_router(b, prefix="/b")
`,
    "g/a.py": "from fastapi import APIRouter\n\na = APIRouter()\n\n@a.get(\"/x\")\ndef x():\n    return 1\n",
    "g/b.py": "from fastapi import APIRouter\n\nb = APIRouter()\nb = APIRouter()\n\n@b.get(\"/y\")\ndef y():\n    return 1\n",
    "g/c.py": "from fastapi import APIRouter\n\nc = APIRouter()\n\n@c.get(\"/z\")\ndef z():\n    return 1\n",
    "g/test_app.py": "from fastapi import FastAPI\nfrom g.c import c\n\napp = FastAPI()\napp.include_router(c)\n",
    "g/loop_a.py": "from g.loop_b import r\n",
    "g/loop_b.py": "from g.loop_a import r\n",
    "g/loop_main.py": "from fastapi import FastAPI\nfrom g.loop_a import r\n\napp = FastAPI()\napp.include_router(r)\n",
    "neg/server.js": `const express = require("express");
const { BASE } = require("./config");
const r = require("./r");
const app = express();
app.use(BASE, r);
`,
    "neg/config.js": `exports.BASE = "/x";\n`,
    "neg/r.js": `const express = require("express");
const r = express.Router();
r.get("/y", (req, res) => res.end());
module.exports = r;
`,
  }, (graph) => {
    assert.deepEqual(routeIds(graph), []);
  });
});

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
