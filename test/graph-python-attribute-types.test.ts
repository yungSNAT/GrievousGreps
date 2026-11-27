/**
 * A Python method call on an instance attribute, `app.config.from_mapping()`, where the
 * attribute's type is stated in another file: the class (or a base class) assigns
 * `self.config` a constructor call, an annotated value, or the result of one of its own
 * methods whose return annotation names the type. Flask's `app.config` is the last kind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

const CONFIG = `class Config(dict):
    def from_mapping(self, mapping):
        return True


class Settings:
    def load(self):
        return 1


class Other:
    def from_mapping(self, mapping):
        return False
`;

const BASE = `from .config import Config, Settings


class App:
    def __init__(self):
        self.config = self.make_config()
        self.settings = Settings()
        self.typed: Settings = make()
        self.loose = make()

    def make_config(self) -> Config:
        return Config()

    def own(self):
        return self.config.from_mapping({})


def make():
    return None
`;

const APP = `from .base import App


class Flask(App):
    pass
`;

const USER = `from pkg import app as appmod
from pkg.app import Flask


def create():
    app = Flask()
    app.config.from_mapping({})
    app.settings.load()
    app.typed.load()


def through_module():
    app = appmod.Flask()
    app.config.from_mapping({})


def unknown():
    app = Flask()
    app.loose.from_mapping({})
    app.missing.from_mapping({})
`;

// Cases where the attribute's type is not known for sure: 2 classes share a name and only
// one has the attribute, one class assigns it 2 types, and a capitalised function is called
// through a module where a class of that name also exists.
const UNSURE = {
  "pkg/config.py": CONFIG,
  "pkg/store.py": `class Store:
    def run(self):
        return 1
`,
  "pkg/factory.py": `def Store():
    return None
`,
  "pkg/a.py": `from .config import Config


class Server:
    def __init__(self):
        self.config = Config()
`,
  "pkg/b.py": `class Server:
    def __init__(self):
        self.name = "b"
`,
  "pkg/holder.py": `from .config import Config, Other
from . import factory


class Holder:
    def __init__(self, flag):
        if flag:
            self.config = Config()
        else:
            self.config = Other()
        self.store = factory.Store()
`,
  "user.py": `from pkg import factory, store
from pkg.b import Server
from pkg.holder import Holder


def same_name():
    s = Server()
    s.config.from_mapping({})


def two_types():
    h = Holder(True)
    h.config.from_mapping({})


def factory_call():
    h = Holder(False)
    h.store.run()


def module_and_untyped(x):
    factory.Store()
    x.config.from_mapping({})


def plain_factory():
    x = factory.Store()
    x.run()
`,
  "store_user.py": `from pkg.store import Store


def constructed():
    x = Store()
    x.run()


def annotated(get):
    x: Store = get()
    x.run()
`,
  "pkg/dual.py": `from .config import Config


class Worker:
    def __init__(self):
        self.name = "top"


def build():
    class Worker:
        def __init__(self):
            self.config = Config()
    return Worker()
`,
  "pkg/lazy.py": `from .config import Config


class Lazy:
    def __init__(self):
        self.config = Config()

    def reset(self):
        self.config = None
`,
  "more_user.py": `from pkg.dual import Worker
from pkg.lazy import Lazy


def use_top():
    w = Worker()
    w.config.from_mapping({})


def maybe_none():
    l = Lazy()
    l.config.from_mapping({})
`,
  "imports_a.py": `from pkg.a import Server


def same_name_imported():
    s = Server()
    s.config.from_mapping({})
`,
  "pkg/svc.py": `from .config import Config


class Service:
    def __init__(self):
        self.config = Config()
`,
  "svc_user.py": `from pkg import svc


def custom():
    class Service(svc.Service):
        pass
    return Service()


def via_module():
    s = svc.Service()
    s.config.from_mapping({})
`,
};

async function build(files: Record<string, string> = {
  "pkg/config.py": CONFIG,
  "pkg/base.py": BASE,
  "pkg/app.py": APP,
  "user.py": USER,
}): Promise<GraphV1> {
  const dir = mkdtempSync(join(tmpdir(), "graft-py-attrs-"));
  mkdirSync(join(dir, "pkg"), { recursive: true });
  writeFileSync(join(dir, "pkg", "__init__.py"), "");
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  await buildGraph(dir);
  const graph = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "wiring graph should be written");
  return graph!;
}

const callsOf = (graph: GraphV1, source: string): string[] =>
  graph.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target).sort();

test("Python: a method call on an attribute a base class types in another file resolves", async () => {
  const graph = await build();
  assert.deepEqual(callsOf(graph, "user.py#create"), [
    "pkg/app.py#Flask",
    "pkg/config.py#Config.from_mapping",
    "pkg/config.py#Settings.load",
  ], "a method's return annotation, a constructor call and an annotation each type the attribute");
  assert.ok(callsOf(graph, "user.py#through_module").includes("pkg/config.py#Config.from_mapping"), "an instance made through a module");
  assert.ok(callsOf(graph, "pkg/base.py#App.own").includes("pkg/config.py#Config.from_mapping"), "through self");
  const viaAttr = graph.edges.find((e) => e.relation === "calls" && e.source === "user.py#create" && e.target === "pkg/config.py#Config.from_mapping");
  assert.equal(viaAttr?.confidence, "likely", "an attribute's type read from another file is likely");
});

let unsure: Promise<GraphV1> | undefined;
const unsureCalls = async (source: string): Promise<string[]> => callsOf(await (unsure ??= build(UNSURE)), source);

test("Python: an attribute of a class name 2 classes share is read from the class the file imports", async () => {
  assert.deepEqual(await unsureCalls("user.py#same_name"), ["pkg/b.py#Server"], "the imported class has no such attribute");
  assert.deepEqual(await unsureCalls("imports_a.py#same_name_imported"), ["pkg/a.py#Server", "pkg/config.py#Config.from_mapping"], "the imported class has it");
  assert.ok((await unsureCalls("svc_user.py#via_module")).includes("pkg/config.py#Config.from_mapping"), "made through a module, beside a namesake nested in a function");
  assert.deepEqual(await unsureCalls("more_user.py#use_top"), ["pkg/dual.py#Worker"], "a namesake nested in the same file lends nothing");
});

test("Python: an attribute also assigned a value of unknown type resolves to nothing", async () => {
  assert.deepEqual(await unsureCalls("more_user.py#maybe_none"), ["pkg/lazy.py#Lazy"]);
});

test("Python: an attribute its class assigns 2 types resolves to nothing", async () => {
  assert.deepEqual(await unsureCalls("user.py#two_types"), ["pkg/holder.py#Holder"]);
});

test("Python: a capitalised function's result is not the class of that name", async () => {
  assert.deepEqual(await unsureCalls("user.py#factory_call"), ["pkg/holder.py#Holder"], "as an attribute");
  assert.deepEqual(await unsureCalls("user.py#plain_factory"), ["pkg/factory.py#Store"], "as a local");
});

test("Python: a class the file imports keeps its methods beside a function of that name elsewhere", async () => {
  assert.deepEqual(await unsureCalls("store_user.py#constructed"), ["pkg/store.py#Store", "pkg/store.py#Store.run"], "made here");
  assert.deepEqual(await unsureCalls("store_user.py#annotated"), ["pkg/store.py#Store.run"], "annotated");
});

test("Python: a module's function and an untyped receiver keep their resolution", async () => {
  assert.deepEqual(await unsureCalls("user.py#module_and_untyped"), ["pkg/factory.py#Store"]);
});

test("Python: an attribute with no stated type resolves to nothing", async () => {
  const graph = await build();
  assert.deepEqual(callsOf(graph, "user.py#unknown"), ["pkg/app.py#Flask"]);
});
