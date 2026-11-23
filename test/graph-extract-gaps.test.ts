import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { extractFile, type ExtractResult } from "../src/graph/extract.js";
import { parseDepth, warmDepthGrammars } from "../src/graph/depth-parser.js";
import { contentHash } from "../src/util/id.js";

let restoreFetch: (() => void) | undefined;

before(async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    assert.fail("Graph extraction must work offline");
  });
  restoreFetch = () => fetchMock.mock.restore();
  await warmDepthGrammars(["typescript", "python", "java", "php", "go", "kotlin"]);
});

after(() => restoreFetch?.());

function symbol(result: ExtractResult, id: string) {
  const node = result.nodes.find((n) => n.id === id);
  assert.ok(node, `Missing node ${id}`);
  return node;
}

function callsFrom(result: ExtractResult, source: string) {
  return result.rawEdges.filter((e) => e.relation === "calls" && e.source === source);
}

function pythonTable(result: ExtractResult) {
  const table = result.rawEdges.find((e) => e.pythonExports)?.pythonExports;
  assert.ok(table, "Missing Python export table");
  return table;
}

describe("TypeScript extraction", () => {
  test("recovers an interface with a line-leading generic overload", () => {
    const file = "dispatch.ts";
    const firstSignatures = ["(key: H): Handlers[H]", "current: Handler"];
    const source = firstSignatures.map((first) => [
      "export interface Dispatch<H extends keyof Handlers> {",
      `  ${first}`,
      "  <I>(key: I): I;",
      "  reset(): void;",
      "}",
      "export function tail() { return 42; }",
    ].join("\n")).find((candidate) =>
      parseDepth("typescript", candidate, (root) => root.hasError) &&
      parseDepth("typescript", candidate.replace("  <I>", " ;<I>"), (root) => !root.hasError),
    );
    assert.ok(source, "Expected a generic overload that needs a separator to parse cleanly");

    const result = extractFile(file, source, "typescript");
    const dispatch = symbol(result, `${file}#Dispatch`);
    assert.equal(dispatch.kind, "interface");
    assert.equal(dispatch.span, "L1-L5");
    assert.match(dispatch.body_text ?? "", / ;<I>\(key: I\): I;/);
    assert.equal(symbol(result, `${file}#Dispatch.reset`).owner, "Dispatch");
    assert.equal(symbol(result, `${file}#tail`).span, "L6-L6");
    assert.equal(symbol(result, file).body_hash, contentHash(source));
  });

  test("keeps the original parse when inserting a separator cannot fix the file", () => {
    const file = "draft.ts";
    const source = [
      "export interface Draft {",
      "  <T>(value: T): T;",
      "  reset(): void;",
      "}",
      "export function kept() { return 1; }",
      "const unfinished = ;",
    ].join("\n");
    const result = extractFile(file, source, "typescript");
    assert.match(symbol(result, `${file}#Draft`).body_text ?? "", /\{ <T>\(value: T\)/);
    assert.equal(symbol(result, `${file}#Draft.reset`).owner, "Draft");
    assert.equal(symbol(result, `${file}#kept`).exported, true);

    const withoutOverload = extractFile(file, "function kept() {}\nconst unfinished = ;", "typescript");
    assert.equal(symbol(withoutOverload, `${file}#kept`).signature, "function kept()");
  });

  test("records alias, namespace, star and default bindings independently", () => {
    const file = "index.ts";
    const result = extractFile(file, `
import "./setup.js";
import load, { parse as decode, format } from "./reader.js";
import * as tools from "./tools.js";
export { decode as parse, format };
export { build as compile } from "./build.js";
export * as plugins from "./plugins.js";
export * from "./defaults.js";
export const run = () => tools.text.format(decode(load()));
export var revision = 1;
export default run;
`, "typescript");
    const table = result.rawEdges.find((e) => e.tsModule)?.tsModule;
    assert.ok(table);
    assert.deepEqual(table.imports, [
      { local: "load", name: "default", specifier: "./reader.js" },
      { local: "decode", name: "parse", specifier: "./reader.js" },
      { local: "format", name: "format", specifier: "./reader.js" },
      { local: "tools", name: "*", specifier: "./tools.js" },
    ]);
    assert.deepEqual(table.reexports, [
      { exported: "compile", name: "build", specifier: "./build.js" },
      { exported: "plugins", name: "*", specifier: "./plugins.js" },
    ]);
    assert.deepEqual(table.stars, ["./defaults.js"]);
    assert.deepEqual(table.exports, [
      { exported: "parse", local: "decode" },
      { exported: "format", local: "format" },
      { exported: "run", local: "run" },
      { exported: "revision", local: "revision" },
      { exported: "default", local: "run" },
    ]);
    assert.ok(result.rawEdges.some((e) =>
      e.source === file && e.relation === "imports" && e.specifier === "./setup.js"));
    assert.deepEqual(callsFrom(result, `${file}#run`).map((e) => [e.name, e.tsPath]), [
      ["format", ["tools", "text"]],
      ["decode", []],
      ["load", []],
    ]);
  });

  test("a named default declaration binds a local name; an anonymous one does not", () => {
    const file = "entry.ts";
    const named = extractFile(file, "export default function start() {}", "typescript");
    assert.equal(symbol(named, `${file}#start`).exported, true);
    assert.deepEqual(named.rawEdges.find((e) => e.tsModule)?.tsModule?.exports, [
      { exported: "default", local: "start" },
    ]);

    const anonymous = extractFile(file, "export default function () { initialize(); }", "typescript");
    assert.ok(!anonymous.rawEdges.some((e) => e.tsModule));
    assert.deepEqual(callsFrom(anonymous, file).map((e) => e.name), ["initialize"]);
  });

  test("only binding positions in parameters, declarations and loops shadow an import", () => {
    const file = "scope.ts";
    const result = extractFile(file, `
import { run } from "./runtime.js";
function imported() { run(); }
function keyOnly({ run: task = run } = {}) { run(); }
function shorthand({ run }: { run: () => void }) { run(); }
function defaultBinding({ run = fallback } = {}) { run(); }
function optional(run?: () => void) { if (run) run(); }
function rest(...[run]: Array<() => void>) { run(); }
function localKeyOnly() { const { run: task } = config; run(); }
function localAlias() { const { task: run } = config; run(); }
function forOf(tasks: Array<() => void>) { for (const run of tasks) run(); }
function counted(initial: () => void) { for (let run = initial; ready(); advance()) run(); }
function nestedDeclaration() { function run() {} run(); }
`, "typescript");
    const expectations = {
      imported: [], keyOnly: [], localKeyOnly: [],
      shorthand: undefined, defaultBinding: undefined, optional: undefined,
      rest: undefined, localAlias: undefined, forOf: undefined,
      counted: undefined, nestedDeclaration: undefined,
    };
    for (const [fn, path] of Object.entries(expectations)) {
      const calls = callsFrom(result, `${file}#${fn}`).filter((e) => e.name === "run");
      assert.deepEqual(calls.map((e) => e.tsPath), [path], fn);
    }
  });
});

describe("Python extraction", () => {
  test("retains literal __all__, aliases, wildcard imports and conditional exports", () => {
    const file = "__init__.py";
    const result = extractFile(file, `import tools.formatting, tools.rendering as renderer
from .core import load, parse as parse_item
from .plugins import *
try:
    from .fast import run
except ImportError:
    from .slow import run
if ENABLE_EXTENSIONS:
    def optional():
        pass
    class Extra:
        pass
__all__ = [
    "load",
    # Preserve the compatibility alias.
    'parse_item',
]
def build():
    return tools.formatting.normalize(renderer.render(parse_item(load())))
def run_selected():
    return run()
`, "python");
    const table = pythonTable(result);
    assert.deepEqual(table.imports, [
      { local: "tools", name: "", specifier: "tools", line: 1, conditional: false },
      { local: "renderer", name: "", specifier: "tools.rendering", line: 1, conditional: false },
      { local: "load", name: "load", specifier: ".core", line: 2, conditional: false },
      { local: "parse_item", name: "parse", specifier: ".core", line: 2, conditional: false },
      { local: "run", name: "run", specifier: ".fast", line: 5, conditional: true },
      { local: "run", name: "run", specifier: ".slow", line: 7, conditional: true },
    ]);
    assert.deepEqual(table.stars, [".plugins"]);
    assert.deepEqual(table.conditionalDefs, ["optional", "Extra"]);
    assert.deepEqual(table.all, ["load", "parse_item"]);
    assert.deepEqual(callsFrom(result, `${file}#build`).map((e) => [e.specifier, e.pythonChain]), [
      ["tools", ["formatting", "normalize"]],
      ["tools.rendering", ["render"]],
      [".core", ["parse"]],
      [".core", ["load"]],
    ]);
    assert.deepEqual(
      callsFrom(result, `${file}#run_selected`).map((e) => [e.pythonRebound, e.specifier, e.pythonChain]),
      [["run", undefined, []]],
    );
  });

  for (const [label, declarations, expected] of [
    ["literal tuple", '__all__ = ("load", "save")', ["load", "save"]],
    ["nonliteral item", '__all__ = ["load", dynamic_name]', null],
    ["augmented assignment", '__all__ = ["load"]\n__all__ += ["save"]', null],
    ["method mutation", '__all__ = ["load"]\n__all__.append("save")', null],
    ["repeated assignment", '__all__ = ["load"]\n__all__ = ["save"]', null],
  ] as const) {
    test(`__all__: ${label}`, () => {
      const result = extractFile("__init__.py", `from .core import load\n${declarations}\n`, "python");
      assert.deepEqual(pythonTable(result).all, expected);
    });
  }

  test("defaults see enclosing imports, while the body and nested defs see local bindings", () => {
    const file = "config.py";
    const result = extractFile(file, `from .defaults import load

def configure(load=load()):
    from .implementation import create as make
    import helpers.text
    def nested():
        return make(helpers.text.clean("input"))
    return load(), nested()

def separate():
    return make()
`, "python");
    assert.deepEqual(pythonTable(result).imports.map((i) => i.local), ["load"]);
    assert.deepEqual(
      callsFrom(result, `${file}#configure`).map((e) => [e.name, e.specifier, e.pythonChain]),
      [["load", ".defaults", ["load"]], ["nested", undefined, undefined]],
    );
    assert.deepEqual(
      callsFrom(result, `${file}#configure.nested`).map((e) => [e.specifier, e.pythonChain]),
      [[".implementation", ["create"]], ["helpers", ["text", "clean"]]],
    );
    assert.deepEqual(
      callsFrom(result, `${file}#separate`).map((e) => [e.name, e.specifier]),
      [["make", undefined]],
    );
  });

  test("local fallback imports are marked rebound only when their targets differ", () => {
    const file = "fallback.py";
    const result = extractFile(file, `def read():
    try:
        from .fast import decode as parse
        from .common import normalize
    except ImportError:
        from .slow import decode as parse
        from .common import normalize
    return normalize(parse())
`, "python");
    const calls = callsFrom(result, `${file}#read`);
    assert.deepEqual(calls.map((e) => e.name), ["normalize", "parse"]);
    assert.equal(calls[0].specifier, ".common");
    assert.deepEqual(calls[0].pythonChain, ["normalize"]);
    assert.equal(calls[1].specifier, undefined);
    assert.equal(calls[1].pythonChain, undefined);
    assert.equal(calls[1].pythonRebound, "parse");
    assert.equal(calls[1].pythonReboundModule, ".slow");
    assert.equal(calls[1].pythonReboundName, "decode");
    assert.ok(!result.rawEdges.some((e) => e.pythonExports));
  });

  test("match captures and walruses in definition headers rebind module imports", () => {
    const file = "bindings.py";
    const result = extractFile(file, `from .tasks import first, rest, load, make_base, untouched
match records:
    case [first, *rest]:
        pass
    case _:
        pass

def setup(callback=(load := fallback)):
    pass

class Widget((make_base := Base)):
    pass

first()
rest()
load()
make_base()
untouched()
`, "python");
    assert.deepEqual(callsFrom(result, file).map((e) => [
      e.name, e.pythonRebound, e.specifier, e.pythonChain,
    ]), [
      ["first", "first", undefined, undefined],
      ["rest", "rest", undefined, undefined],
      ["load", "load", undefined, undefined],
      ["make_base", "make_base", undefined, undefined],
      ["untouched", undefined, ".tasks", ["untouched"]],
    ]);
  });

  test("lambda-local walruses and class-body bindings do not leak into nested lambdas", () => {
    const file = "scopes.py";
    const result = extractFile(file, `from .tools import build, transform

class Config:
    build = fallback
    immediate = build()
    deferred = lambda: build()

def local():
    return lambda: ((transform := fallback), transform())

def nested():
    return lambda: ((lambda: (transform := fallback)), transform())

def defaults():
    return lambda transform=transform(): transform()
`, "python");
    assert.deepEqual(callsFrom(result, `${file}#Config`).map((e) => e.pythonChain), [["build"]]);
    assert.deepEqual(callsFrom(result, `${file}#local`), []);
    for (const name of ["nested", "defaults"]) {
      assert.deepEqual(callsFrom(result, `${file}#${name}`).map((e) => [e.specifier, e.pythonChain]), [
        [".tools", ["transform"]],
      ]);
    }
  });

  test("overload signatures disappear only when a concrete implementation follows", () => {
    const implementation = extractFile("render.py", `from typing import overload
@overload
def render(value: int) -> str: ...
@overload
def render(value: bytes) -> str: ...
def render(value):
    return str(value)
`, "python");
    const defs = implementation.nodes.filter((n) => n.name === "render");
    assert.deepEqual(defs.map((n) => n.signature), ["def render(value)"]);

    const stub = extractFile("render.pyi", `from typing import Protocol, overload
class Renderer(Protocol):
    @overload
    def render(self, value: int) -> str: ...
    @overload
    def render(self, value: bytes) -> str: ...
`, "python");
    assert.deepEqual(stub.nodes.filter((n) => n.owner === "Renderer").map((n) => n.id), [
      "render.pyi#Renderer.render", "render.pyi#Renderer.render~2",
    ]);
  });
});

test("Java anonymous bodies own their methods without guessing qualified supertype names", () => {
  const file = "Demo.java";
  const result = extractFile(file, `public class Demo {
    public Object local() {
        return new Listener<String>() {
            public void accept(String value) {}
        };
    }
    private Object qualified() {
        return new external.Listener<String>() {
            public void accept(String value) {}
        };
    }
}
`, "java");
  const local = `${file}#Demo.local`;
  const qualified = `${file}#Demo.qualified`;
  assert.equal(symbol(result, local).exported, true);
  assert.equal(symbol(result, qualified).exported, false);
  for (const parent of [local, qualified]) {
    const anonymous = `${parent}.{anonymous}`;
    assert.equal(symbol(result, anonymous).exported, false);
    assert.equal(symbol(result, `${anonymous}.accept`).owner, "{anonymous}");
    assert.ok(result.rawEdges.some((e) =>
      e.relation === "contains" && e.source === parent && e.targetId === anonymous));
  }
  assert.equal(symbol(result, `${local}.{anonymous}`).signature, "new Listener<String>()");
  assert.deepEqual(callsFrom(result, local).map((e) => [e.name, e.argCount]), [["Listener", 0]]);
  assert.deepEqual(callsFrom(result, qualified), []);
  assert.deepEqual(result.rawEdges.filter((e) => e.relation === "implements").map((e) => [
    e.source, e.name,
  ]), [[`${local}.{anonymous}`, "Listener"]]);
});

test("PHP enum constants do not detach enum methods or absorb the next function", () => {
  const file = "Status.php";
  const result = extractFile(file, `<?php
enum Status: string {
    case Ready = 'ready';
    public const LABELS = ['ready' => 'Ready'];
    public function label(): string { return self::LABELS[$this->value]; }
}
function defaultStatus(): string { return 'ready'; }
`, "php");
  assert.equal(symbol(result, `${file}#Status`).kind, "enum");
  assert.equal(symbol(result, `${file}#Status.label`).kind, "method");
  assert.equal(symbol(result, `${file}#defaultStatus`).kind, "function");
  assert.ok(result.rawEdges.some((e) =>
    e.relation === "contains" && e.source === `${file}#Status` && e.targetId === `${file}#Status.label`));
});

test("PHP distinguishes free, member, nullsafe and scoped calls", () => {
  const file = "Renderer.php";
  const result = extractFile(file, String.raw`<?php
class Renderer {
    public function render(?Formatter $formatter, callable $callback): string {
        $formatter->prefix();
        $formatter?->suffix();
        self::trimOutput();
        $callback();
        return \App\text\escape("hello");
    }
}
`, "php");
  assert.deepEqual(callsFrom(result, `${file}#Renderer.render`).map((e) => [e.name, e.viaMember]), [
    ["prefix", true], ["suffix", true], ["trimOutput", true], ["escape", false],
  ]);
});

test("Go uses identifier casing and Kotlin uses declaration visibility", () => {
  const go = extractFile("worker.go", "package worker\nfunc Run() { prepare() }\nfunc prepare() {}\n", "go");
  assert.equal(symbol(go, "worker.go#Run").exported, true);
  assert.equal(symbol(go, "worker.go#prepare").exported, false);

  const kotlin = extractFile("Worker.kt", "fun run() {}\ninternal fun prepare() {}\npublic fun stop() {}\n", "kotlin");
  assert.equal(symbol(kotlin, "Worker.kt#run").exported, true);
  assert.equal(symbol(kotlin, "Worker.kt#prepare").exported, false);
  assert.equal(symbol(kotlin, "Worker.kt#stop").exported, true);
});
