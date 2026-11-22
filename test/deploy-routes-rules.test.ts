/**
 * Route reading cases from review: trailing slashes, converters and rests as each framework
 * defines them, hosts, unknown prefixes, names bound in other scopes, middleware, shared images
 * and bind mounts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { apps, built, path, routeEdges, routeIds } from "./deploy-routes-fixtures.js";


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
      "svc/app.py#route:ANY /never",
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

test("each framework's own rules: empty methods, converters and rests, scopes, middleware and a require in a function", async () => {
  const { root, graph } = await built({
    "py/flaskapp.py": `from flask import Flask

app = Flask(__name__)

@app.route("/opts", methods=[])
def opts():
    return ""

@app.route("/v/<float:n>")
def flt(n):
    return n

def unrelated(items):
    for app in items:
        print(app)
`,
    "py/fastapp.py": `from fastapi import FastAPI

api = FastAPI()

@api.api_route("/any", methods=[])
def any_method():
    return 1

@api.get("/files/{p:path}")
def files(p):
    return p

@api.get("/v/{n:float}")
def flt(n):
    return n
`,
    "py/Dockerfile": "FROM python:3.12\nCOPY . /app\n",
    "web/server.js": `import express from "express";
import { show } from "./show.js";

const app = express();
const r = express.Router();

function auth(req, res, next) {
  next();
}

function list(req, res) {
  res.end();
}

function wired(opts = show) {
  app.get("/wired", show);
}

function nested() {
  function inner() {
    const show = 1;
    return show;
  }
  app.get("/nested", show);
}

function setup() {
  list = function () {};
  app.get("/list", list);
}

r.get("/r", show);
app.use(auth, r);
`,
    "web/show.js": "export function show(req, res) {\n  res.end();\n}\n",
    "web/lazy.js": `function make() {
  const express = require("express");
  const lazy = express();
  lazy.get("/made", (req, res) => res.end());
}
`,
    "gosvc/main.go": `package main

import "net/http"

type fake struct{}

func (http fake) HandleFunc(p string, h any) {}

func (http fake) run() {
	http.HandleFunc("/recv", h)
}

func h(w http.ResponseWriter, r *http.Request) {}

func main() {
	http.HandleFunc("/real", h)
}
`,
    "compose.yaml": "services:\n  py: { build: py, image: acme/py }\n",
    "k8s/app.yaml": apps(["py"], [path("/files/", "Exact", "py"), path("/v/1", "Exact", "py")]),
  });
  try {
    assert.deepEqual(routeIds(graph), [
      "gosvc/main.go#route:ANY /real",
      "py/fastapp.py#route:ANY /any",
      "py/fastapp.py#route:GET /files/{p...}",
      "py/fastapp.py#route:GET /v/{n:float}",
      "py/flaskapp.py#route:GET /v/{n:float}",
      "py/flaskapp.py#route:OPTIONS /opts",
      "web/lazy.js#route:GET /made",
      "web/server.js#route:GET /list",
      "web/server.js#route:GET /nested",
      "web/server.js#route:GET /r",
      "web/server.js#route:GET /wired",
    ]);
    const signature = (id: string) => graph.nodes.find((n) => n.id === id)?.signature;
    assert.equal(signature("py/flaskapp.py#route:GET /v/{n:float}"), "route flask GET /v/{n:float}");
    assert.equal(signature("py/fastapp.py#route:GET /v/{n:float}"), "route fastapi GET /v/{n:float}");
    const edges = routeEdges(graph);
    // FastAPI's path converter and float take '/files/' and '1'; Flask's float needs a fraction.
    assert.deepEqual(edges.filter((e) => e.startsWith("k8s/")), [
      "k8s/app.yaml#Ingress/default/main -> py/fastapp.py#route:GET /files/{p...} (inferred)",
      "k8s/app.yaml#Ingress/default/main -> py/fastapp.py#route:GET /v/{n:float} (inferred)",
    ]);
    for (const route of ["/wired", "/nested", "/r"]) {
      assert.ok(edges.includes(`web/server.js#route:GET ${route} -> web/show.js#show`), `${route}: ${edges.join("\n")}`);
    }
    assert.ok(!edges.some((e) => e.startsWith("web/server.js#route:GET /list ->")), "list is reassigned in setup");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocks and class bodies are scopes: a name bound inside one does not stand for the outer binding", async () => {
  const { root, graph } = await built({
    "blk/server.js": `import express from "express";
import { show } from "./show.js";

const app = express();
const r = express.Router();
let auth = "/api";
r.get("/x", show);

if (process.env.DEBUG) {
  function auth(req, res, next) {
    next();
  }
}
app.use(auth, r);

function local() {
  class app {
    static get(path, handler) {}
  }
  app.get("/fake", show);
}

function blockLocal() {
  if (process.env.DEBUG) {
    const app = { get() {} };
    app.get("/inner", show);
  }
  app.get("/outer", show);
}
`,
    "blk/show.js": "export function show(req, res) {\n  res.end();\n}\n",
    "gosvc/main.go": `package main

import "net/http"

type fake struct{}

func (f fake) HandleFunc(p string, h any) {}

func h(w http.ResponseWriter, r *http.Request) {}

func main() {
	mux := http.NewServeMux()
	if true {
		mux := 1
		_ = mux
		http := fake{}
		http.HandleFunc("/shadow", h)
	}
	mux.HandleFunc("/go", h)
	http.ListenAndServe(":8080", mux)
	switch http := any(mux).(type) {
	default:
		http.HandleFunc("/switch", h)
	}
}

func param(mux *http.ServeMux) {
	mux.HandleFunc("/param", h)
	mux, err := http.NewServeMux(), error(nil)
	_ = err
}
`,
    "py/app.py": `from flask import Flask

app = Flask(__name__)

class Views:
    app = None

    def setup(self):
        @app.route("/method")
        def method():
            return ""

@app.route("/py")
def py():
    return ""

def factory():
    app = Flask("f")

    class Holder:
        app = None

        def rebind(self):
            nonlocal app
            app = Flask("g")

    @app.route("/nonlocal")
    def nl():
        return ""
`,
    "blk/types.ts": `import express from "express";
import { show } from "./show.js";

const app = express();

function caught() {
  try {
    show();
  } catch (app) {
    app.get("/caught", show);
  }
  for (const app of [show]) {
    app.get("/looped", show);
  }
  if (show) {
    var app = { get() {} };
  }
  app.get("/var", show);
}

function enums() {
  enum app { A }
  app.get("/enum", show);
}

function abstracts() {
  abstract class app {
    static get(path: string, handler: unknown) {}
  }
  app.get("/abstract", show);
}

app.get("/ts", show);
`,
  });
  try {
    // An unknown prefix gives no route: '/x' would be the block function read as middleware.
    assert.deepEqual(routeIds(graph), [
      "blk/server.js#route:GET /outer",
      "blk/types.ts#route:GET /ts",
      "gosvc/main.go#route:ANY /go",
      "py/app.py#route:GET /method",
      "py/app.py#route:GET /py",
    ]);
    assert.ok(routeEdges(graph).includes("blk/server.js#route:GET /outer -> blk/show.js#show"), routeEdges(graph).join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
