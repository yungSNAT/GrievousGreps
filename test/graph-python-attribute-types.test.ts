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

async function build(): Promise<GraphV1> {
  const dir = mkdtempSync(join(tmpdir(), "graft-py-attrs-"));
  mkdirSync(join(dir, "pkg"), { recursive: true });
  writeFileSync(join(dir, "pkg", "__init__.py"), "");
  writeFileSync(join(dir, "pkg", "config.py"), CONFIG);
  writeFileSync(join(dir, "pkg", "base.py"), BASE);
  writeFileSync(join(dir, "pkg", "app.py"), APP);
  writeFileSync(join(dir, "user.py"), USER);
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
});

test("Python: an attribute with no stated type resolves to nothing", async () => {
  const graph = await build();
  assert.deepEqual(callsOf(graph, "user.py#unknown"), ["pkg/app.py#Flask"]);
});
