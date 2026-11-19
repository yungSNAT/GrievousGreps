/**
 * Tests for Go extraction in the Tier-1 code graph. Builds a small Go module in a
 * temp dir and asserts the emitted nodes (funcs, methods, structs, interfaces, type
 * aliases) and edges (calls, intra-module imports) match the AST walk in extract.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { writeBuildConfig } from "../src/util/state.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const MAIN_GO = `package main

import (
\t"fmt"
\t"mymod/pkg/util"
)

type ID int

type User struct {
\tName string
}

type Reader interface {
\tRead() error
}

func Foo() {
\tfmt.Println("hi")
\tutil.Helper()
}

func bar() {}

func (u *User) Save() error {
\tFoo()
\tu.name()
\treturn nil
}

func (u User) name() string { return u.Name }
`;

const UTIL_GO = `package util

func Helper() {}
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-go-"));
  writeFileSync(join(dir, "go.mod"), "module mymod\n\ngo 1.21\n");
  writeFileSync(join(dir, "main.go"), MAIN_GO);
  mkdirSync(join(dir, "pkg", "util"), { recursive: true });
  writeFileSync(join(dir, "pkg", "util", "util.go"), UTIL_GO);
  return dir;
}

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

test("Go extraction: funcs, methods, structs, interfaces, type aliases", async () => {
  const dir = makeFixture();
  try {
    const result = await buildGraph(dir); // $0, Tier-1 only
    assert.ok(result.languages.includes("go"), "languages should include go");

    const graph = readGraph(wiringPath(join(dir, "graft")));
    assert.ok(graph, "wiring graph should be written");

    // functions — exported by leading-uppercase
    const foo = nodeById(graph!, "main.go#Foo");
    assert.equal(foo?.kind, "function");
    assert.equal(foo?.exported, true);
    assert.equal(nodeById(graph!, "main.go#bar")?.exported, false);

    // methods — receiver-qualified name, file-scope, exported by method name
    const save = nodeById(graph!, "main.go#User.Save");
    assert.equal(save?.kind, "method");
    assert.equal(save?.exported, true);
    const name = nodeById(graph!, "main.go#User.name");
    assert.equal(name?.kind, "method");
    assert.equal(name?.exported, false);

    // named types
    assert.equal(nodeById(graph!, "main.go#User")?.kind, "struct");
    assert.equal(nodeById(graph!, "main.go#Reader")?.kind, "interface");
    assert.equal(nodeById(graph!, "main.go#ID")?.kind, "type");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Go extraction: call and import edges", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // same-file plain call resolves: Save() → Foo()
    const call = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "main.go#User.Save" && e.target === "main.go#Foo",
    );
    assert.ok(call, "Save should have a resolved calls edge to Foo");

    // member call `u.name()` resolves to the receiver method by its bare name
    const memberCall = graph.edges.find(
      (e) =>
        e.relation === "calls" && e.source === "main.go#User.Save" && e.target === "main.go#User.name",
    );
    assert.ok(memberCall, "Save should have a resolved calls edge to User.name");

    // intra-module import resolves to the target package's file node
    const internal = graph.edges.find(
      (e) => e.relation === "imports" && e.source === "main.go" && e.target === "pkg/util/util.go",
    );
    assert.ok(internal, "mymod/pkg/util should resolve to pkg/util/util.go");

    // stdlib import stays an unresolved package string
    const external = graph.edges.find(
      (e) => e.relation === "imports" && e.source === "main.go" && e.target === "fmt",
    );
    assert.ok(external, "fmt should remain an external package string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Go extraction: go.mod in a subdirectory resolves intra-module imports", async () => {
  // Monorepo shape: the module lives under backend/, not the repo root.
  const dir = mkdtempSync(join(tmpdir(), "graft-go-sub-"));
  try {
    mkdirSync(join(dir, "backend", "store"), { recursive: true });
    writeFileSync(join(dir, "backend", "go.mod"), "module example.com/app\n\ngo 1.21\n");
    writeFileSync(
      join(dir, "backend", "main.go"),
      `package main\n\nimport (\n\t"fmt"\n\t"example.com/app/store"\n)\n\nfunc main() {\n\tfmt.Println(store.New())\n}\n`,
    );
    writeFileSync(join(dir, "backend", "store", "store.go"), "package store\n\nfunc New() int { return 0 }\n");

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // `example.com/app/store` → backend/store (module dir `backend` + subpath `store`)
    const internal = graph.edges.find(
      (e) =>
        e.relation === "imports" &&
        e.source === "backend/main.go" &&
        e.target === "backend/store/store.go",
    );
    assert.ok(internal, "subdir-module import should resolve to backend/store/store.go");

    // stdlib still stays external
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "imports" && e.source === "backend/main.go" && e.target === "fmt",
      ),
      "fmt should remain an external package string",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A5: a go.mod under a persisted --include-dir override is found, so imports inside it resolve internally", async () => {
  // build/ is in SKIP_DIRS by default — readGoModules must honor the same
  // persisted include-dir override source-files.ts already reads, or a
  // go.mod living under an included dir is missed while its .go files (which
  // DO go through source-files.ts) are indexed just fine.
  const dir = mkdtempSync(join(tmpdir(), "graft-go-include-dir-"));
  try {
    mkdirSync(join(dir, "build", "store"), { recursive: true });
    writeFileSync(join(dir, "build", "go.mod"), "module example.com/app\n\ngo 1.21\n");
    writeFileSync(
      join(dir, "build", "main.go"),
      `package main\n\nimport (\n\t"fmt"\n\t"example.com/app/store"\n)\n\nfunc main() {\n\tfmt.Println(store.New())\n}\n`,
    );
    writeFileSync(join(dir, "build", "store", "store.go"), "package store\n\nfunc New() int { return 0 }\n");
    writeBuildConfig(dir, { includeDirs: ["build"] });

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // Sanity: the .go files under build/ are indexed at all (source-files.ts
    // already reads the persisted include list correctly).
    assert.ok(graph.nodes.some((n) => n.id === "build/main.go#main"), "build/main.go should be indexed");

    const internal = graph.edges.find(
      (e) => e.relation === "imports" && e.source === "build/main.go" && e.target === "build/store/store.go",
    );
    assert.ok(internal, "example.com/app/store should resolve internally once build/go.mod is found");

    const external = graph.edges.find(
      (e) => e.relation === "imports" && e.source === "build/main.go" && e.target === "example.com/app/store",
    );
    assert.ok(!external, "must not be left as an unresolved external package string once the module is found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Go extraction: a call through an interface-typed struct field resolves to the interface method (#618)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-go-iface-"));
  try {
    writeFileSync(join(dir, "go.mod"), "module example.test/interface-repro\n\ngo 1.23\n");
    writeFileSync(
      join(dir, "client.go"),
      "package example\n\ntype Client struct{}\nfunc (*Client) Containers() []int { return nil }\nfunc (*Client) ImageContainers(string) []int { return nil }\n",
    );
    writeFileSync(
      join(dir, "worker.go"),
      "package example\n\ntype API interface {\n\tContainers() []int\n\tImageContainers(string) []int\n}\ntype Worker struct { api API }\nfunc (w Worker) Inventory() []int { return w.api.Containers() }\nfunc (w Worker) Recheck(name string) []int { return w.api.ImageContainers(name) }\n",
    );
    writeFileSync(
      join(dir, "fake_test.go"),
      "package example\n\ntype Fake struct{}\nfunc (*Fake) Containers() []int { return nil }\nfunc (*Fake) ImageContainers(string) []int { return nil }\n",
    );

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    const spec = nodeById(graph, "worker.go#API.Containers");
    assert.equal(spec?.kind, "method");
    assert.equal(spec?.owner, "API");
    assert.equal(spec?.exported, true);

    const calls = (source: string) =>
      graph.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target);
    assert.deepEqual(calls("worker.go#Worker.Inventory"), ["worker.go#API.Containers"]);
    assert.deepEqual(calls("worker.go#Worker.Recheck"), ["worker.go#API.ImageContainers"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Go extraction: an inline interface type mints no method nodes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-go-inline-iface-"));
  try {
    writeFileSync(join(dir, "go.mod"), "module mymod\n\ngo 1.21\n");
    writeFileSync(
      join(dir, "main.go"),
      "package main\n\ntype Holder struct { r interface{ Read() error } }\n\nfunc Use(r interface{ Close() error }) {}\n",
    );

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.deepEqual(
      graph.nodes.filter((n) => n.kind === "method").map((n) => n.id),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Go extraction: a bare call resolves inside its own package only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-go-bare-"));
  try {
    writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.22\n");
    for (const sub of ["server", "worker", "mathx"]) mkdirSync(join(dir, sub));
    writeFileSync(join(dir, "server", "server.go"), "package server\n\nfunc Start() {\n\tc := newClient()\n\t_ = c\n}\n");
    writeFileSync(
      join(dir, "server", "client.go"),
      "package server\n\ntype client struct{}\n\nfunc newClient() *client { return &client{} }\n",
    );
    writeFileSync(
      join(dir, "worker", "worker.go"),
      "package worker\n\ntype client struct{}\n\nfunc newClient() *client { return &client{} }\n\nfunc Run(items []int) int {\n\tm := 0\n\tfor _, it := range items {\n\t\tm = max(m, it)\n\t}\n\t_ = newClient()\n\treturn m\n}\n",
    );
    writeFileSync(
      join(dir, "mathx", "mathx.go"),
      "package mathx\n\nfunc max(a, b int) int {\n\tif a > b {\n\t\treturn a\n\t}\n\treturn b\n}\n\nfunc Clamp(v int) int { return max(v, 0) }\n",
    );

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    const calls = (source: string) =>
      graph.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target);
    assert.deepEqual(calls("server/server.go#Start"), ["server/client.go#newClient"]);
    assert.deepEqual(calls("worker/worker.go#Run"), ["worker/worker.go#newClient"]);
    assert.deepEqual(calls("mathx/mathx.go#Clamp"), ["mathx/mathx.go#max"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Go extraction: a package-qualified call resolves into the imported package's directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-go-pkg-call-"));
  try {
    mkdirSync(join(dir, "pkg", "util"), { recursive: true });
    mkdirSync(join(dir, "pkg", "other"), { recursive: true });
    writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.22\n");
    writeFileSync(
      join(dir, "main.go"),
      'package main\n\nimport (\n\t"fmt"\n\t"example.com/app/pkg/util"\n)\n\nfunc run() {\n\tfmt.Println(util.Helper())\n}\n',
    );
    writeFileSync(
      join(dir, "alt.go"),
      'package main\n\nimport ut "example.com/app/pkg/util"\n\nfunc alt() string { return ut.Format() }\n',
    );
    writeFileSync(join(dir, "pkg", "util", "helper.go"), 'package util\n\nfunc Helper() string { return "hi" }\n');
    writeFileSync(join(dir, "pkg", "util", "format.go"), 'package util\n\nfunc Format() string { return "" }\n');
    writeFileSync(join(dir, "pkg", "other", "other.go"), "package other\n\nfunc Helper() {}\nfunc Format() {}\n");

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    const calls = (source: string) =>
      graph.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target);
    assert.deepEqual(calls("main.go#run"), ["pkg/util/helper.go#Helper"]);
    assert.deepEqual(calls("alt.go#alt"), ["pkg/util/format.go#Format"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Go extraction: a local that shadows an import name is not the package", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-go-pkg-shadow-"));
  try {
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.22\n");
    writeFileSync(
      join(dir, "config", "config.go"),
      'package config\n\nfunc Get(k string) string { return k }\nfunc Load() (string, error) { return "", nil }\n',
    );
    writeFileSync(
      join(dir, "main.go"),
      'package main\n\nimport "example.com/app/config"\n\n' +
        'func short() { config := load(); config.Get("x") }\n' +
        'func param(config cfg) { config.Get("x") }\n' +
        'func variable() { var config = load(); config.Get("x") }\n' +
        'func ranged(cs []cfg) { for _, config := range cs { config.Get("x") } }\n' +
        'func rebound() { config, _ := config.Load(); config.Get("x") }\n' +
        'func direct() { config.Get("x") }\n',
    );

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    const calls = (source: string) =>
      graph.edges
        .filter((e) => e.relation === "calls" && e.source === source && e.target.startsWith("config/"))
        .map((e) => e.target);
    for (const fn of ["short", "param", "variable", "ranged"]) assert.deepEqual(calls(`main.go#${fn}`), [], fn);
    assert.deepEqual(calls("main.go#rebound"), ["config/config.go#Load"]);
    assert.deepEqual(calls("main.go#direct"), ["config/config.go#Get"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Builds the graph of a temporary Go module `example.com/app` from its files, keyed by path, and deletes the module.
async function goModuleGraph(files: Record<string, string>): Promise<GraphV1> {
  const dir = mkdtempSync(join(tmpdir(), "graft-go-module-"));
  try {
    writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.22\n");
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    await buildGraph(dir);
    return readGraph(wiringPath(join(dir, "graft")))!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Go extraction: a receiver typed by a parameter or a function's result resolves its method", async () => {
  const graph = await goModuleGraph({
    "log/logger.go":
      "package log\n\n" +
        "type Logger struct{ level int }\n" +
        "type Entry struct{ logger *Logger }\n\n" +
        "var std = New()\n\n" +
        "func New() *Logger { return &Logger{} }\n" +
        "func NewEntry(l *Logger) *Entry { return &Entry{logger: l} }\n" +
        "func Load() (*Logger, error) { return New(), nil }\n" +
        "func Pair() (*Entry, *Logger) { return nil, nil }\n" +
        "func (l *Logger) SetLevel(v int) { l.level = v }\n" +
        "func (e *Entry) SetLevel(v int) {}\n" +
        "func SetLevel(v int) { std.SetLevel(v) }\n",
    "main.go":
      'package main\n\nimport "example.com/app/log"\n\n' +
        "func run(f func(*log.Logger)) {}\n" +
        "func fromCtor() { l := log.New(); l.SetLevel(1) }\n" +
        "func fromParam(l *log.Logger) { l.SetLevel(1) }\n" +
        "func fromLiteral() { run(func(l *log.Logger) { l.SetLevel(1) }) }\n" +
        "func fromEntry() { e := log.NewEntry(nil); e.SetLevel(1) }\n" +
        "func fromPair() { l, _ := log.Load(); l.SetLevel(1) }\n" +
        "func fromSecond() { _, l := log.Pair(); l.SetLevel(1) }\n",
  });

  const setLevel = (source: string) =>
    graph.edges
      .filter((e) => e.relation === "calls" && e.source === source && e.target.endsWith("SetLevel"))
      .map((e) => e.target);
  assert.deepEqual(setLevel("log/logger.go#SetLevel"), ["log/logger.go#Logger.SetLevel"]);
  for (const fn of ["fromCtor", "fromParam", "fromLiteral", "fromPair"]) {
    assert.deepEqual(setLevel(`main.go#${fn}`), ["log/logger.go#Logger.SetLevel"], fn);
  }
  assert.deepEqual(setLevel("main.go#fromEntry"), ["log/logger.go#Entry.SetLevel"]);
  // Only a function's first result is read, so the second value stays untyped rather than guessed.
  assert.deepEqual(setLevel("main.go#fromSecond"), []);
});

test("Go extraction: a receiver's type names its package, and a guess is dropped rather than taken", async () => {
  const graph = await goModuleGraph({
    "log/logger.go":
      "package log\n\n" +
        "type Logger struct{}\n" +
        "type Entry struct{}\n\n" +
        "func New() *Logger { return &Logger{} }\n" +
        "func NewEntry() *Logger { return New() }\n" +
        "func (l *Logger) SetLevel(v int) {}\n" +
        "func (e *Entry) SetLevel(v int) {}\n",
    "config/config.go":
      "package config\n\ntype Config struct{}\n\nfunc Load() (*Config, error) { return nil, nil }\nfunc (c *Config) Get(k string) string { return k }\n",
    "helpers.ts": "export function New() {}\n",
    "main.go":
      'package main\n\nimport (\n\t"example.com/app/config"\n\t"example.com/app/log"\n)\n\n' +
        "type Logger struct{}\n\n" +
        "func (l *Logger) SetLevel(v int) {}\n" +
        "func New() *Logger { return &Logger{} }\n" +
        "func run(f func(*log.Logger)) {}\n" +
        "func runEntry(f func(*log.Entry)) {}\n" +
        "func importedType(l *log.Logger) { l.SetLevel(1) }\n" +
        "func shadowedNew() { New := func() *log.Entry { return nil }; x := New(); x.SetLevel(1) }\n" +
        "func funcTypeParam(l *Logger) { var cb func(l *log.Entry); _ = cb; l.SetLevel(1) }\n" +
        "func declaredResult() { x := log.NewEntry(); x.SetLevel(1) }\n" +
        'func rebound() { config, _ := config.Load(); config.Get("x") }\n' +
        "func twoLiterals() { run(func(l *log.Logger) { l.SetLevel(1) }); runEntry(func(l *log.Entry) { l.SetLevel(1) }) }\n" +
        "func twoBlocks(ok bool) { if ok { l := &log.Logger{}; l.SetLevel(1) } else { l := &log.Entry{}; l.SetLevel(1) } }\n" +
        "func literalOnly(l *Logger) { run(func(l *log.Logger) {}); l.SetLevel(1) }\n" +
        'func shadowAfter() { x, _ := config.Load(); config := 1; _ = config; x.Get("k") }\n' +
        "func viaVar() { var x = log.New(); x.SetLevel(1) }\n" +
        "func pair() { a, b := log.New(), New(); a.SetLevel(1); b.SetLevel(2) }\n" +
        "func sameFolderNew() { x := New(); x.SetLevel(1) }\n",
  });

  const calls = (fn: string, suffix: string) =>
    graph.edges
      .filter((e) => e.relation === "calls" && e.source === `main.go#${fn}` && e.target.endsWith(suffix))
      .map((e) => e.target)
      .sort();
  const imported = "log/logger.go#Logger.SetLevel";
  const local = "main.go#Logger.SetLevel";
  // S1: another package's type is looked for in that package, never in the caller's same-named type.
  assert.deepEqual(calls("importedType", "SetLevel"), [imported]);
  // S2: a local function value hides the package's New, so x's type is unknown.
  assert.deepEqual(calls("shadowedNew", "SetLevel"), []);
  // S3: a function type's parameter is no variable, so l keeps its own type.
  assert.deepEqual(calls("funcTypeParam", "SetLevel"), [local]);
  // S4: the declared result decides, not the NewX name.
  assert.deepEqual(calls("declaredResult", "SetLevel"), [imported]);
  // S5: config is the package where Load is called, and holds Load's result afterwards.
  assert.deepEqual(calls("rebound", ""), ["config/config.go#Config.Get", "config/config.go#Load"]);
  // H1: one name, 2 types in one scope (blocks share their function's): neither is guessed.
  assert.deepEqual(calls("twoBlocks", "SetLevel"), []);
  // Each func literal is a scope of its own: its parameters type only its own body.
  assert.deepEqual(calls("twoLiterals", "SetLevel"), ["log/logger.go#Entry.SetLevel", imported]);
  assert.deepEqual(calls("literalOnly", "SetLevel"), [local]);
  // A local declared after the call does not hide the package the call names.
  assert.deepEqual(calls("shadowAfter", "Get"), ["config/config.go#Config.Get"]);
  assert.deepEqual(calls("viaVar", "SetLevel"), [imported]);
  assert.deepEqual(calls("pair", "SetLevel"), [imported, local]);
  // S6: a TypeScript New in the same folder does not make Go's ambiguous.
  assert.deepEqual(calls("sameFolderNew", "SetLevel"), [local]);
});

test("Go extraction: a function's result of another package's type, and test files, reach the right method", async () => {
  const graph = await goModuleGraph({
    "log/logger.go": "package log\n\ntype Logger struct{}\n\nfunc New() *Logger { return &Logger{} }\nfunc (l *Logger) SetLevel(v int) {}\n",
    "log/logger_test.go": "package log\n\nfunc (l *Logger) Check() {}\nfunc TestOwn() { l := New(); l.SetLevel(1); l.Check() }\n",
    "logtest/null.go":
      'package logtest\n\nimport (\n\t"bytes"\n\tlg "example.com/app/log"\n)\n\n' +
        "func NewNullLogger() (*lg.Logger, int) { return nil, 0 }\n" +
        "func NewBuffer() *bytes.Buffer { return nil }\n",
    "main.go":
      'package main\n\nimport "example.com/app/logtest"\n\n' +
        "func qualified() { l, _ := logtest.NewNullLogger(); l.SetLevel(1) }\n" +
        "func outside() { b := logtest.NewBuffer(); b.SetLevel(1) }\n",
    "main_test.go":
      'package main\n\nimport (\n\t"example.com/app/log"\n\t"example.com/app/logtest"\n)\n\n' +
        "func TestLevel() { l, _ := logtest.NewNullLogger(); l.SetLevel(1); l.Check() }\n" +
        "func TestParam(l *log.Logger) { l.Check() }\n",
  });

  const calls = (source: string) =>
    graph.edges.filter((e) => e.relation === "calls" && e.source === source && e.target.includes("Logger.")).map((e) => e.target).sort();
  // The result's type is read through the returning file's imports, alias included.
  assert.deepEqual(calls("main.go#qualified"), ["log/logger.go#Logger.SetLevel"]);
  // A type from outside the module names no method here.
  assert.deepEqual(calls("main.go#outside"), []);
  // A test file reaches a method in another package's ordinary files, never in its test files.
  assert.deepEqual(calls("main_test.go#TestLevel"), ["log/logger.go#Logger.SetLevel"]);
  assert.deepEqual(calls("main_test.go#TestParam"), []);
  // A test file in the method's own folder reaches both its ordinary files and its test files.
  assert.deepEqual(calls("log/logger_test.go#TestOwn"), ["log/logger.go#Logger.SetLevel", "log/logger_test.go#Logger.Check"]);
});

test("Go extraction: a func literal's local does not type a captured variable it does not yet shadow", async () => {
  const graph = await goModuleGraph({
    "main.go":
      "package main\n\n" +
        "type A struct{}\ntype B struct{}\n\n" +
        "func (a *A) M() {}\nfunc (b *B) M() {}\nfunc (b *B) N() {}\n" +
        "func NewB() *B { return &B{} }\n" +
        "func run(cb func()) {}\n" +
        "func before(l *A) { run(func() { l.M(); l := &B{}; l.N() }) }\n" +
        "func outside(l *A, debug bool) { run(func() { if debug { l := NewB(); l.N() }; l.M() }) }\n",
  });

  const calls = (fn: string) =>
    graph.edges.filter((e) => e.relation === "calls" && e.source === `main.go#${fn}` && e.target === "main.go#B.M");
  // The call before the declaration, or outside its block, is the captured *A's: never B.M.
  assert.deepEqual(calls("before"), []);
  assert.deepEqual(calls("outside"), []);
});

test("Go extraction: a func literal's parameter or local named like the method's receiver hides the receiver", async () => {
  const graph = await goModuleGraph({
    "main.go":
      "package main\n\n" +
        "type Logger struct{}\ntype Entry struct{}\n\n" +
        "func (l *Logger) SetLevel(v int) {}\nfunc (e *Entry) SetLevel(v int) {}\n" +
        "func run(f func(*Entry)) {}\n" +
        "func (l *Logger) Param() { run(func(l *Entry) { l.SetLevel(1) }) }\n" +
        "func (l *Logger) Local() { run(func(*Entry) { l := &Entry{}; l.SetLevel(1) }) }\n" +
        "func (l *Logger) Captured() { run(func(*Entry) { l.SetLevel(1) }) }\n",
  });

  const calls = (fn: string) =>
    graph.edges.filter((e) => e.relation === "calls" && e.source === `main.go#Logger.${fn}` && e.target.endsWith("SetLevel")).map((e) => e.target);
  assert.deepEqual(calls("Param"), ["main.go#Entry.SetLevel"]);
  // The local follows a captured receiver of another type, so the name gets no type rather than the receiver's.
  assert.deepEqual(calls("Local"), []);
  assert.deepEqual(calls("Captured"), ["main.go#Logger.SetLevel"]);
});

test("Go extraction: a type parameter names no type, though the package declares one of that name", async () => {
  const graph = await goModuleGraph({
    "main.go":
      "package main\n\n" +
        "type Mer interface{ M() }\n" +
        "type T struct{}\ntype B struct{}\n" +
        "type Box[T Mer] struct{ v T }\n\n" +
        "func (t *T) M() {}\nfunc (b *B) M() {}\n" +
        "func Wrap[T any](v T) T { return v }\n" +
        "func result(b *B) { x := Wrap(b); x.M() }\n" +
        "func Each[T Mer](v T) { v.M() }\n" +
        "func (b *Box[T]) Call(v T) { v.M() }\n" +
        "func plain(t *T) { t.M() }\n",
  });

  const reachesT = (source: string) =>
    graph.edges.filter((e) => e.relation === "calls" && e.source === `main.go#${source}` && e.target === "main.go#T.M");
  for (const source of ["result", "Each", "Call"]) assert.deepEqual(reachesT(source), [], source);
  assert.equal(reachesT("plain").length, 1);
});

test("Go extraction: an import without an alias is named by its package clause, not its path", async () => {
  const graph = await goModuleGraph({
    "util/log/log.go":
      "package logger\n\ntype Logger struct{}\n\nfunc New() *Logger { return &Logger{} }\nfunc (l *Logger) Info() {}\n",
    "wrap/wrap.go":
      'package wrap\n\nimport (\n\t"example.com/app/util/log"\n\t"github.com/x/golog"\n)\n\n' +
        "var _ = logger.New\n\nfunc Make() *log.Logger { return nil }\n",
    "main.go":
      'package main\n\nimport (\n\t"example.com/app/util/log"\n\t"example.com/app/wrap"\n\t"github.com/x/golog"\n)\n\n' +
        "var _ = logger.New\n\n" +
        "func viaType(l *log.Logger) { l.Info() }\n" +
        "func viaCall() { log.New() }\n" +
        "func viaResult() { l := log.New(); l.Info() }\n" +
        "func viaOtherFile() { w := wrap.Make(); w.Info() }\n",
    "alias.go": 'package main\n\nimport lg "example.com/app/util/log"\n\nfunc viaAlias() { l := lg.New(); l.Info() }\n',
  });

  const calls = (fn: string) =>
    graph.edges
      .filter((e) => e.relation === "calls" && e.source.endsWith(`.go#${fn}`) && e.target.startsWith("util/"))
      .map((e) => e.target)
      .sort();
  // `log` names github.com/x/golog's package here, as util/log's package is logger.
  for (const fn of ["viaType", "viaCall", "viaResult", "viaOtherFile"]) assert.deepEqual(calls(fn), [], fn);
  assert.deepEqual(calls("viaAlias"), ["util/log/log.go#Logger.Info", "util/log/log.go#New"]);
});
