/**
 * HTTP routes in the graph (`src/graph/routes.ts`) and the Ingress paths that reach them
 * (`resolveDeploy`): a route is a node only when its full path is known in its file, it links
 * to its handler, and an Ingress path links only to routes its own Service's image ships.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";
import { calleesOf, impactOfMany } from "../src/graph/traverse.js";
import { checkGraphInvariants } from "../src/graph/invariants.js";
import { routeServes } from "../src/graph/routes.js";
import { runCallersCommand } from "../src/graph/traverse-cli.js";
import type { GraphV1 } from "../src/graph/types.js";

async function built(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "gg-routes-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const result = await buildGraph(root);
  return { root, result, graph: readGraph(wiringPath(contextDirFor(root)))! };
}

const routeIds = (graph: GraphV1) => graph.nodes.filter((n) => n.id.includes("#route:")).map((n) => n.id).sort();

/** Edges into or out of a route node, as `source -> target`, inferred ones marked. */
function routeEdges(graph: GraphV1): string[] {
  return graph.edges
    .filter((e) => e.relation === "references" && (e.source.includes("#route:") || e.target.includes("#route:")))
    .map((e) => `${e.source} -> ${e.target}${e.confidence === "inferred" ? " (inferred)" : ""}`)
    .sort();
}

// Fixtures are template literals: one token each, so the duplication check reads code only.
const k8s = (paths: string[], extra = "") => `apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  template:
    metadata: { labels: { app: api } }
    spec: { containers: [ { name: api, image: acme/api:1 } ] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  template:
    metadata: { labels: { app: web } }
    spec: { containers: [ { name: web, image: acme/web:1 } ] }
---
apiVersion: v1
kind: Service
metadata: { name: api }
spec: { selector: { app: api } }
---
apiVersion: v1
kind: Service
metadata: { name: web }
spec: { selector: { app: web } }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: main }
spec:
  rules:
    - http:
        paths:
${paths.join("\n")}
${extra}`;

const path = (p: string, type: string, svc: string) => `          - { path: ${p}, pathType: ${type}, backend: { service: { name: ${svc}, port: { number: 80 } } } }`;

const TWO_SERVICES: Record<string, string> = {
  "services/api/main.py": `from fastapi import FastAPI, APIRouter

app = FastAPI()
users = APIRouter(prefix="/users")

@users.get("/{user_id}")
def get_user(user_id: int):
    return user_id

@users.post("")
def create_user():
    return 1

@app.get("/health")
def health():
    return "ok"

orphan = APIRouter()

@orphan.get("/never")
def never():
    return 0

app.include_router(users, prefix="/api")
`,
  "services/api/Dockerfile": "FROM python:3.12\nCOPY . /app\n",
  "services/web/server.js": `import express, { Router } from "express";
import { listOrders } from "./orders.js";

const app = express();
const api = Router();
api.get("/orders", listOrders);
api.get("/orders/:id", (req, res) => res.end());
app.use("/api", api);
app.get("/health", health);
app.get("view engine");

function health(req, res) {
  res.end("ok");
}

app.listen(3000);
`,
  "services/web/orders.js": "export function listOrders(req, res) {\n  res.json([]);\n}\n",
  "services/web/Dockerfile": "FROM node:24\nCOPY . /srv\n",
  "compose.yaml": "services:\n  api: { build: services/api, image: acme/api }\n  web: { build: services/web, image: acme/web }\n",
  "k8s/app.yaml": k8s([
    path("/api/users", "Prefix", "api"),
    path("/api/orders", "Prefix", "web"),
    path("/health", "Exact", "web"),
  ], `---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: rewritten
  annotations: { nginx.ingress.kubernetes.io/rewrite-target: / }
spec:
  rules:
    - http:
        paths:
${path("/", "Prefix", "api")}`),
};

test("FastAPI and Express routes link to their handlers, and each Ingress path only to its own Service's routes", async () => {
  const { root, graph } = await built(TWO_SERVICES);
  try {
    assert.deepEqual(routeIds(graph), [
      "services/api/main.py#route:GET /api/users/{user_id}",
      "services/api/main.py#route:GET /health",
      "services/api/main.py#route:POST /api/users",
      "services/web/server.js#route:GET /api/orders",
      "services/web/server.js#route:GET /api/orders/{id}",
      "services/web/server.js#route:GET /health",
    ]);
    assert.deepEqual(routeEdges(graph), [
      "k8s/app.yaml#Ingress/default/main -> services/api/main.py#route:GET /api/users/{user_id} (inferred)",
      "k8s/app.yaml#Ingress/default/main -> services/api/main.py#route:POST /api/users (inferred)",
      "k8s/app.yaml#Ingress/default/main -> services/web/server.js#route:GET /api/orders (inferred)",
      "k8s/app.yaml#Ingress/default/main -> services/web/server.js#route:GET /api/orders/{id} (inferred)",
      "k8s/app.yaml#Ingress/default/main -> services/web/server.js#route:GET /health (inferred)",
      "services/api/main.py#route:GET /api/users/{user_id} -> services/api/main.py#get_user",
      "services/api/main.py#route:GET /health -> services/api/main.py#health",
      "services/api/main.py#route:POST /api/users -> services/api/main.py#create_user",
      "services/web/server.js#route:GET /api/orders -> services/web/orders.js#listOrders",
      "services/web/server.js#route:GET /health -> services/web/server.js#health",
    ]);
    assert.deepEqual(checkGraphInvariants(graph).problems, []);
    const route = graph.nodes.find((n) => n.id === "services/api/main.py#route:GET /api/users/{user_id}")!;
    assert.equal(route.kind, "resource");
    assert.equal(route.name, "GET /api/users/{user_id}");
    assert.equal(route.signature, "route GET /api/users/{user_id}");
    assert.equal(route.span, "L6-L8");
    const getUser = graph.nodes.find((n) => n.id === "services/api/main.py#get_user")!;
    const reached = impactOfMany(graph, [getUser], 2, "in");
    assert.equal(reached.find((h) => h.id === route.id)?.depth, 1);
    assert.equal(reached.find((h) => h.id === "k8s/app.yaml#Ingress/default/main")?.depth, 2);
    const ingress = graph.nodes.find((n) => n.id === "k8s/app.yaml#Ingress/default/main")!;
    assert.ok(calleesOf(graph, ingress).some((h) => h.id === route.id));
    // The README's commands.
    const [log, write] = [console.log, process.stdout.write];
    let text = "";
    console.log = (x: string) => { text += `${x}\n`; };
    process.stdout.write = ((x: string) => { text += x; return true; }) as typeof process.stdout.write;
    try {
      runCallersCommand("get_user", root, { depth: "2", json: true });
      const deep = (JSON.parse(text) as { matches: Array<{ hits: Array<{ id: string; depth: number }> }> }).matches.flatMap((m) => m.hits);
      text = "";
      runCallersCommand("main", root, { direction: "out", json: true });
      const out = (JSON.parse(text) as { matches: Array<{ hits: Array<{ id: string }> }> }).matches.flatMap((m) => m.hits);
      const at = (id: string) => deep.find((h) => h.id === id)?.depth;
      assert.equal(at("services/api/main.py#route:GET /api/users/{user_id}"), 1, text);
      assert.equal(at("k8s/app.yaml#Ingress/default/main"), 2, text);
      assert.ok(out.some((h) => h.id === "services/web/server.js#route:GET /health"), text);
    } finally {
      console.log = log;
      process.stdout.write = write;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Flask blueprints and Go ServeMux patterns: prefixes, methods, wildcards and mounted muxes", async () => {
  const { root, graph } = await built({
    "shop/app.py": `from flask import Flask, Blueprint

app = Flask(__name__)
bp = Blueprint("shop", __name__, url_prefix="/shop")

@bp.route("/cart/<int:cart_id>", methods=["GET", "DELETE"])
def cart(cart_id):
    return cart_id

@app.route("/files/<path:name>")
def files(name):
    return name

@app.get("/a-<id>")
def partial(id):
    return id

app.register_blueprint(bp, url_prefix="/store")
`,
    "shop/Dockerfile": "FROM python:3.12\nCOPY app.py /app/\n",
    "items/main.go": `package main

import "net/http"

func listItems(w http.ResponseWriter, r *http.Request) {}
func getItem(w http.ResponseWriter, r *http.Request)   {}
func admin(w http.ResponseWriter, r *http.Request)     {}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /items", listItems)
	mux.HandleFunc("GET /items/{id}", getItem)
	sub := http.NewServeMux()
	sub.HandleFunc("/panel", admin)
	mux.Handle("/admin/", http.StripPrefix("/admin", sub))
	http.Handle("/static/", http.HandlerFunc(listItems))
	http.ListenAndServe(":8080", mux)
}
`,
    "items/Dockerfile": "FROM golang:1.25\nCOPY . /src\n",
    "compose.yaml": "services:\n  api: { build: shop, image: acme/api }\n  web: { build: items, image: acme/web }\n",
    "k8s/app.yaml": k8s([
      path("/store", "Prefix", "api"),
      path("/files/a/b", "Exact", "api"),
      path("/items", "Prefix", "web"),
      path("/items/42", "Exact", "web"),
      path("/static/css", "Prefix", "web"),
    ]),
  });
  try {
    assert.deepEqual(routeIds(graph), [
      "items/main.go#route:ANY /admin/{...}",
      "items/main.go#route:ANY /static/{...}",
      "items/main.go#route:GET /items",
      "items/main.go#route:GET /items/{id}",
      "shop/app.py#route:GET /files/{name...}",
      "shop/app.py#route:GET|DELETE /store/cart/{cart_id:int}",
    ]);
    assert.deepEqual(routeEdges(graph), [
      "items/main.go#route:ANY /static/{...} -> items/main.go#listItems",
      "items/main.go#route:GET /items -> items/main.go#listItems",
      "items/main.go#route:GET /items/{id} -> items/main.go#getItem",
      "k8s/app.yaml#Ingress/default/main -> items/main.go#route:ANY /static/{...} (inferred)",
      "k8s/app.yaml#Ingress/default/main -> items/main.go#route:GET /items (inferred)",
      "k8s/app.yaml#Ingress/default/main -> items/main.go#route:GET /items/{id} (inferred)",
      "k8s/app.yaml#Ingress/default/main -> shop/app.py#route:GET /files/{name...} (inferred)",
      "k8s/app.yaml#Ingress/default/main -> shop/app.py#route:GET|DELETE /store/cart/{cart_id:int} (inferred)",
      "shop/app.py#route:GET /files/{name...} -> shop/app.py#files",
      "shop/app.py#route:GET|DELETE /store/cart/{cart_id:int} -> shop/app.py#cart",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an Ingress path serves a route by whole segments: Prefix, Exact, parameters and the rest of a path", () => {
  const cases: Array<[string, "Prefix" | "Exact", string, boolean]> = [
    ["/", "Prefix", "GET /anything/{x}", true],
    ["/api", "Prefix", "GET /api", true],
    ["/api/", "Prefix", "GET /api/users", true],
    ["/api", "Prefix", "GET /apiv2", false],
    ["/api/users", "Prefix", "GET /api", false],
    ["/api/7", "Prefix", "GET /api/{id}/items", true],
    ["/api/7/items", "Exact", "GET /api/{id}/items", true],
    ["/api/7", "Exact", "GET /api/{id}/items", false],
    ["/api/7/items/9", "Exact", "GET /api/{id}/items", false],
    ["/files/a/b/c", "Exact", "GET /files/{p...}", true],
    ["/files", "Prefix", "ANY /files/{...}", true],
    ["/other", "Prefix", "ANY /{...}", true],
    ["/x", "Prefix", "GET /", false],
    ["/", "Exact", "GET /", true],
    ["/files", "Exact", "ANY /files/{...}", false],
    ["/files/", "Exact", "ANY /files/{...}", true],
    ["/files/", "Exact", "GET /files/{p...}", false],
    ["/foo", "Exact", "GET /foo/", false],
    ["/foo/", "Exact", "GET /foo/", true],
    ["/foo/", "Exact", "GET /foo", false],
    ["/foo", "Prefix", "GET /foo/", true],
    ["/users/abc", "Exact", "GET /users/{id:int}", false],
    ["/users/42", "Exact", "GET /users/{id:int}", true],
    ["/users/abc", "Prefix", "GET /users/{id:int}/x", false],
    ["/v/1.5", "Exact", "GET /v/{n:float}", true],
    ["/k/not-a-uuid", "Exact", "GET /k/{k:uuid}", false],
  ];
  for (const [p, type, route, want] of cases) assert.equal(routeServes(p, type, route), want, `${type} ${p} vs ${route}`);
  assert.equal(routeServes("/", "ImplementationSpecific", "GET /x"), false, "a controller's own rules are not assumed");
});

test("a route in a file the Service's image does not ship, or behind a Service with no image chain, gets no Ingress link", async () => {
  const { root, graph } = await built({
    "app/main.py": 'from fastapi import FastAPI\napp = FastAPI()\n\n@app.get("/users")\ndef users():\n    return []\n',
    "app/Dockerfile": "FROM python:3.12\nCOPY other.py /app/\n",
    "app/other.py": "x = 1\n",
    "compose.yaml": "services:\n  api: { build: app, image: acme/api }\n",
    "k8s/app.yaml": k8s([path("/users", "Prefix", "api"), path("/users", "Prefix", "web")]),
  });
  try {
    assert.deepEqual(routeEdges(graph), ["app/main.py#route:GET /users -> app/main.py#users"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a compose dependency's image is not the Service's: its routes get no link", async () => {
  const fastapi = (route: string, fn: string) => `from fastapi import FastAPI\napp = FastAPI()\n\n@app.get("${route}")\ndef ${fn}():\n    return 1\n`;
  const { root, graph, result } = await built({
    "api/main.py": fastapi("/orders", "orders"),
    "api/Dockerfile": "FROM python:3.12\nCOPY . /app\n",
    "worker/main.py": fastapi("/jobs", "jobs"),
    "worker/Dockerfile": "FROM python:3.12\nCOPY . /app\n",
    "compose.yaml": "services:\n  api: { build: api, image: acme/api, depends_on: [worker] }\n  worker: { build: worker, image: acme/worker }\n",
    "k8s/app.yaml": k8s([path("/", "Prefix", "api")], `---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: odd, annotations: not-a-mapping }
spec: { rules: [ { http: { paths: [ { path: /, pathType: Prefix, backend: { service: { name: api } } } ] } } ] }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: typed }
spec: { rules: [ { http: { paths: [ { path: 7, pathType: Prefix, backend: { service: { name: api } } } ] } } ] }`),
  });
  try {
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(routeEdges(graph).filter((e) => e.startsWith("k8s/")), [
      "k8s/app.yaml#Ingress/default/main -> api/main.py#route:GET /orders (inferred)",
    ]);
    assert.ok(graph.nodes.some((n) => n.id === "worker/main.py#route:GET /jobs"));
    assert.ok(graph.edges.some((e) => e.source === "k8s/app.yaml#Ingress/default/typed" && e.target === "k8s/app.yaml#Service/default/api"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("names that only look like a framework, and apps in tests, give no routes", async () => {
  const { root, graph } = await built({
    "a.py": 'class FastAPI:\n    def get(self, p):\n        return lambda f: f\n\napp = FastAPI()\n\n@app.get("/x")\ndef x():\n    pass\n',
    "b.js": 'function express() { return { get() {} }; }\nconst app = express();\napp.get("/y", () => 1);\n',
    "c.go": 'package c\n\ntype m struct{}\n\nfunc (m) HandleFunc(p string, f func()) {}\n\nfunc f() {\n\thttp := m{}\n\thttp.HandleFunc("/z", f)\n}\n',
    "tests/test_api.py": 'from fastapi import FastAPI\napp = FastAPI()\n\n@app.get("/fixture")\ndef fixture():\n    pass\n',
    "d.py": 'from fastapi import FastAPI\napp = FastAPI()\napp = make()\n\n@app.get("/twice")\ndef twice():\n    pass\n',
  });
  try {
    assert.deepEqual(routeIds(graph), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A Deployment and Service per name, each running `acme/<name>`, and one Ingress with `paths`. */
const apps = (names: string[], paths: string[]) => `${names.map((n) => `apiVersion: apps/v1
kind: Deployment
metadata: { name: ${n} }
spec:
  template:
    metadata: { labels: { app: ${n} } }
    spec: { containers: [ { name: ${n}, image: acme/${n}:1 } ] }
---
apiVersion: v1
kind: Service
metadata: { name: ${n} }
spec: { selector: { app: ${n} } }
---
`).join("")}apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: main }
spec:
  rules:
    - http:
        paths:
${paths.join("\n")}
`;

test("review cases: slashes, typed parameters, hosts, unknown prefixes, shadowed names, shared images and bind mounts", async () => {
  const { root, graph } = await built({
    "svc/app.py": `from fastapi import FastAPI, APIRouter

app = FastAPI()
items = APIRouter(prefix="/items")
hidden = APIRouter()

@items.get("/")
def list_items():
    return []

@app.api_route("/never", methods=[])
def never():
    return 0

@app.get("/typed/{n:int}")
def typed(n):
    return n

@hidden.get("/hidden")
def hidden_route():
    return 1

app.include_router(items)

def make(FastAPI):
    other = FastAPI()

    @other.get("/fake")
    def fake():
        return 1

def register(app):
    app.include_router(hidden)
`,
    "svc/Dockerfile": "FROM python:3.12\nCOPY app.py /app/\n",
    "web/server.js": `import express from "express";
import { show } from "./show.js";

const app = express();
const a = express.Router();
const b = express.Router();
const c = express.Router();
const prefix = "/v1";
a.get("/a", show);
b.get("/b", show);
c.get("/c", show);
app.use(prefix, a);
app.use(\`/tpl\`, b);
app.use("/ok", c);

function wire(show) {
  c.get("/shadowed", show);
}
`,
    "web/show.js": "export function show(req, res) {\n  res.end();\n}\n",
    "web/Dockerfile": "FROM node:24\nCOPY . /srv\n",
    "gosvc/main.go": `package main

import "net/http"

func h(w http.ResponseWriter, r *http.Request) {}

func main() {
	http.HandleFunc("api.example.com/host", h)
	http.HandleFunc("/exact/{$}", h)
}
`,
    "gosvc/Dockerfile": "FROM golang:1.25\nCOPY . /src\n",
    "dup1/main.py": 'from fastapi import FastAPI\napp = FastAPI()\n\n@app.get("/d1")\ndef d1():\n    return 1\n',
    "dup1/Dockerfile": "FROM python:3.12\nCOPY . /app\n",
    "dup2/Dockerfile": "FROM python:3.12\nCOPY . /app\n",
    "mnt/main.py": 'from fastapi import FastAPI\napp = FastAPI()\n\n@app.get("/m")\ndef m():\n    return 1\n',
    "mntbuild/Dockerfile": "FROM python:3.12\nCOPY Dockerfile /app/\n",
    "compose.yaml": `services:
  svc: { build: svc, image: acme/svc }
  web: { build: web, image: acme/web }
  gosvc: { build: gosvc, image: acme/gosvc }
  dup1: { build: dup1, image: acme/dup }
  dup2: { build: dup2, image: acme/dup }
  mnt: { build: mntbuild, image: acme/mnt, volumes: [ "./mnt:/app" ] }
`,
    "k8s/app.yaml": apps(["svc", "web", "gosvc", "dup", "mnt"], [
      path("/items", "Prefix", "svc"),
      path("/typed/abc", "Exact", "svc"),
      path("/typed/7", "ImplementationSpecific", "svc"),
      path("/", "Prefix", "web"),
      path("/exact/", "Exact", "gosvc"),
      path("/host", "Prefix", "gosvc"),
      path("/", "Prefix", "dup"),
      path("/", "Prefix", "mnt"),
    ]),
  });
  try {
    assert.deepEqual(routeIds(graph), [
      "dup1/main.py#route:GET /d1",
      "gosvc/main.go#route:ANY /exact/",
      "mnt/main.py#route:GET /m",
      "svc/app.py#route:GET /items/",
      "svc/app.py#route:GET /typed/{n:int}",
      "web/server.js#route:GET /ok/c",
      "web/server.js#route:GET /ok/shadowed",
    ]);
    const edges = routeEdges(graph);
    assert.deepEqual(edges.filter((e) => e.startsWith("k8s/")), [
      "k8s/app.yaml#Ingress/default/main -> gosvc/main.go#route:ANY /exact/ (inferred)",
      "k8s/app.yaml#Ingress/default/main -> svc/app.py#route:GET /items/ (inferred)",
      "k8s/app.yaml#Ingress/default/main -> web/server.js#route:GET /ok/c (inferred)",
      "k8s/app.yaml#Ingress/default/main -> web/server.js#route:GET /ok/shadowed (inferred)",
    ]);
    assert.ok(edges.includes("web/server.js#route:GET /ok/c -> web/show.js#show"), edges.join("\n"));
    assert.ok(!edges.some((e) => e.startsWith("web/server.js#route:GET /ok/shadowed ->")), "a parameter shadows the imported handler");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
