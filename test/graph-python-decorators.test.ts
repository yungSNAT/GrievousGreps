/**
 * A Python decorator written without arguments (`@stream_with_context`,
 * `@flask.stream_with_context`) calls the decorator with the function it decorates,
 * from the scope the definition sits in. Only `@route("/")`-style decorators, which are
 * call nodes, were read as calls, so the bare ones gave their function no caller.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

const HELPERS = `def stream_with_context(f):
    return f


def route(path):
    def deco(f):
        return f
    return deco
`;

const USER = `import pkg
from pkg.helpers import stream_with_context, route


@stream_with_context
def top():
    pass


def nested():
    @pkg.stream_with_context
    def gen():
        yield 1
    return gen


@route("/")
def view():
    pass


class Thing:
    @property
    def name(self):
        return "x"
`;

async function build(): Promise<GraphV1> {
  const dir = mkdtempSync(join(tmpdir(), "graft-py-decorators-"));
  mkdirSync(join(dir, "pkg"), { recursive: true });
  writeFileSync(join(dir, "pkg", "__init__.py"), "from .helpers import stream_with_context\n");
  writeFileSync(join(dir, "pkg", "helpers.py"), HELPERS);
  writeFileSync(join(dir, "pkg", "user.py"), USER);
  await buildGraph(dir);
  const graph = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "wiring graph should be written");
  return graph!;
}

const callsOf = (graph: GraphV1, source: string): string[] =>
  graph.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target).sort();

test("Python: a decorator without arguments is a call from the scope its definition sits in", async () => {
  const graph = await build();
  assert.deepEqual(callsOf(graph, "pkg/user.py"), ["pkg/helpers.py#route", "pkg/helpers.py#stream_with_context"], "at module level, and @route(\"/\") once");
  assert.deepEqual(callsOf(graph, "pkg/user.py#nested"), ["pkg/helpers.py#stream_with_context"], "through a module, inside a function");
  assert.deepEqual(callsOf(graph, "pkg/user.py#Thing"), [], "a builtin decorator reaches nothing");
});
