/**
 * Python `@overload` stubs are type-checker declarations, not definitions: at run time the
 * name is bound to the def that follows them. Indexed as definitions, they made every call
 * to an overloaded function ambiguous (3 definitions of one name), so the call was dropped
 * and the function showed no callers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

const HELPERS = `import typing as t
from typing import overload


@t.overload
def stream(gen: int) -> int: ...


@t.overload
def stream(gen: str) -> str: ...


def stream(gen):
    return gen


class Box:
    @overload
    def get(self, key: int) -> int: ...

    @overload
    def get(self, key: str) -> str: ...

    def get(self, key):
        return key

    def first(self):
        return self.get(0)


def local_use():
    return stream(1)
`;

/** Overloads with no implementation after them (a stub file or a Protocol) are all
 * the definitions there are, so they stay. */
const PROTOCOL = `from typing import Protocol, overload


class Reader(Protocol):
    @overload
    def read(self, n: int) -> bytes: ...

    @overload
    def read(self, n: None) -> str: ...
`;

const USER = `from .helpers import stream


def use():
    return stream("a")
`;

async function build(): Promise<GraphV1> {
  const dir = mkdtempSync(join(tmpdir(), "graft-py-overloads-"));
  mkdirSync(join(dir, "pkg"), { recursive: true });
  writeFileSync(join(dir, "pkg", "__init__.py"), "");
  writeFileSync(join(dir, "pkg", "helpers.py"), HELPERS);
  writeFileSync(join(dir, "pkg", "protocol.py"), PROTOCOL);
  writeFileSync(join(dir, "pkg", "user.py"), USER);
  await buildGraph(dir);
  const graph = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "wiring graph should be written");
  return graph!;
}

const callsOf = (graph: GraphV1, source: string): string[] =>
  graph.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target);

const idsNamed = (graph: GraphV1, path: string, name: string): string[] =>
  graph.nodes.filter((n) => n.path === path && n.name === name).map((n) => n.id);

test("Python: @overload stubs before an implementation are not definitions", async () => {
  const graph = await build();
  assert.deepEqual(idsNamed(graph, "pkg/helpers.py", "stream"), ["pkg/helpers.py#stream"]);
  assert.deepEqual(idsNamed(graph, "pkg/helpers.py", "get"), ["pkg/helpers.py#Box.get"]);
  const impl = graph.nodes.find((n) => n.id === "pkg/helpers.py#stream");
  assert.match(impl?.span ?? "", /^L13-/, "the implementation, not a stub, keeps the name");
});

test("Python: a call to an overloaded function reaches its implementation", async () => {
  const graph = await build();
  assert.deepEqual(callsOf(graph, "pkg/user.py#use"), ["pkg/helpers.py#stream"], "through an import");
  assert.deepEqual(callsOf(graph, "pkg/helpers.py#local_use"), ["pkg/helpers.py#stream"], "in the same file");
  assert.deepEqual(callsOf(graph, "pkg/helpers.py#Box.first"), ["pkg/helpers.py#Box.get"], "an overloaded method");
});

test("Python: overloads with no implementation after them stay", async () => {
  const graph = await build();
  assert.deepEqual(idsNamed(graph, "pkg/protocol.py", "read"), [
    "pkg/protocol.py#Reader.read",
    "pkg/protocol.py#Reader.read~2",
  ]);
});
