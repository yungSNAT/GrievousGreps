/**
 * Routers mounted from another file (`src/graph/route-mounts.ts`): a FastAPI `include_router`, a
 * Flask `register_blueprint` in an app factory and an Express `use` of a router another module
 * exports give the routes their full path, once imports are resolved. Each route stays in the
 * file that registers it and links to its handler; nothing is guessed when a step is unknown.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
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
  }, (graph) => {
    assert.deepEqual(routeIds(graph), ["web/api.py#route:POST /api/ping", "web/views.py#route:GET /admin/dash"]);
    assert.deepEqual(routeEdges(graph), [
      "web/api.py#route:POST /api/ping -> web/api.py#ping",
      "web/views.py#route:GET /admin/dash -> web/views.py#dash",
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
  }, (graph) => {
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
