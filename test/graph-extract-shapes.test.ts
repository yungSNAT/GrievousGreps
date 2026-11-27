/**
 * Depth-tier definition and reference shapes that no other suite reaches:
 * Kotlin's object, annotation, secondary-constructor and typealias declarations,
 * R's S3 and S4 registration idioms and roxygen boundaries, Java's scoped
 * annotations and PHP 8 attributes.
 */
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { extractFile, type ExtractResult } from "../src/graph/extract.js";
import { warmDepthGrammars } from "../src/graph/depth-parser.js";

let restoreFetch: (() => void) | undefined;

before(async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    assert.fail("Graph extraction must work offline");
  });
  restoreFetch = () => fetchMock.mock.restore();
  await warmDepthGrammars(["kotlin", "r", "java", "php", "go", "typescript"]);
});

after(() => restoreFetch?.());

function symbol(result: ExtractResult, id: string) {
  const node = result.nodes.find((n) => n.id === id);
  assert.ok(node, `Missing node ${id}; have ${result.nodes.map((n) => n.id).join(", ")}`);
  return node;
}

function ids(result: ExtractResult): string[] {
  return result.nodes.map((n) => n.id).sort();
}

function references(result: ExtractResult, source: string) {
  return result.rawEdges
    .filter((e) => e.relation === "references" && e.source === source)
    .map((e) => ({ name: e.name, specifier: e.specifier }));
}

describe("Kotlin declaration shapes", () => {
  const file = "Model.kt";
  const source = [
    "annotation class Marker",
    "object Registry {",
    "  fun lookup(key: String): Int = 1",
    "}",
    "class Account(val id: Int) {",
    "  val cache = 1",
    "  constructor(name: String) : this(0) {",
    "    println(name)",
    "  }",
    "}",
    "typealias Handler = (Int) -> Unit",
    "enum class Colour { RED, GREEN }",
    "interface Shape { fun area(): Double }",
    "val limit = 10",
  ].join("\n");

  test("maps each declaration to its graph kind", () => {
    const result = extractFile(file, source, "kotlin");
    const kinds = Object.fromEntries(result.nodes.map((n) => [n.id, n.kind]));
    assert.deepEqual(kinds, {
      [file]: "file",
      [`${file}#Marker`]: "interface",
      [`${file}#Registry`]: "class",
      [`${file}#Registry.lookup`]: "method",
      [`${file}#Account`]: "class",
      [`${file}#Account.Account`]: "method",
      [`${file}#Handler`]: "type",
      [`${file}#Colour`]: "enum",
      [`${file}#Shape`]: "interface",
      [`${file}#Shape.area`]: "method",
      [`${file}#limit`]: "variable",
    });
  });

  test("an object's function and a secondary constructor belong to their type", () => {
    const result = extractFile(file, source, "kotlin");
    assert.equal(symbol(result, `${file}#Registry.lookup`).owner, "Registry");
    assert.equal(symbol(result, `${file}#Registry`).signature, "object Registry");
    const ctor = symbol(result, `${file}#Account.Account`);
    assert.equal(ctor.owner, "Account");
    assert.equal(ctor.span, "L7-L9");
    assert.equal(ctor.signature, "constructor(name: String) : this(0)");
    const call = result.rawEdges.find((e) => e.relation === "calls" && e.name === "println");
    assert.equal(call?.source, `${file}#Account.Account`, "the constructor body's call is attributed to the constructor");
  });

  test("annotation classes and typealiases keep their whole header as the signature", () => {
    const result = extractFile(file, source, "kotlin");
    assert.equal(symbol(result, `${file}#Marker`).signature, "annotation class Marker");
    assert.equal(symbol(result, `${file}#Handler`).signature, "typealias Handler = (Int) -> Unit");
    assert.equal(symbol(result, `${file}#Handler`).span, "L11-L11");
  });

  test("a class property is not a definition, but a top-level val is", () => {
    const result = extractFile(file, source, "kotlin");
    assert.ok(!ids(result).some((id) => id.endsWith("cache")), "a class property must not become a node");
    assert.equal(symbol(result, `${file}#limit`).signature, "val limit = 10");
  });
});

describe("R S3 and S4 registration", () => {
  test("UseMethod() with no argument makes the enclosing function a generic", () => {
    const file = "s3.R";
    const result = extractFile(file, [
      "area <- function(s) UseMethod()",
      "area.circle <- function(s) 3",
      "tally.circle <- function(s) 1",
    ].join("\n"), "r");
    const method = symbol(result, `${file}#circle.area`);
    assert.equal(method.kind, "method");
    assert.equal(method.owner, "circle");
    // No `tally` generic exists, so the dotted name stays an ordinary function.
    assert.equal(symbol(result, `${file}#tally.circle`).kind, "function");
    assert.equal(symbol(result, `${file}#area`).kind, "function");
  });

  test("a UseMethod call nested inside the body still registers the generic", () => {
    const file = "nested.R";
    const result = extractFile(file, [
      "size <- function(s) { if (TRUE) { UseMethod(\"size\") } }",
      "size.box <- function(s) 1",
    ].join("\n"), "r");
    const method = symbol(result, `${file}#box.size`);
    assert.equal(method.kind, "method");
    assert.equal(method.owner, "box");
  });

  test("setClass needs a non-empty string name and accepts a namespace-qualified call", () => {
    const file = "s4.R";
    const result = extractFile(file, [
      "setClass(Foo)",
      "setClass(\"\")",
      "methods::setClass(\"Shape\")",
    ].join("\n"), "r");
    assert.deepEqual(ids(result), [file, `${file}#Shape`]);
    assert.equal(symbol(result, `${file}#Shape`).kind, "class");
  });

  test("setMethod takes a named definition and ignores a definition that is not a function", () => {
    const file = "methods.R";
    const result = extractFile(file, [
      // `definition` is found by name, not as the third argument.
      "setMethod(\"show\", \"Shape\", where = globalenv(), definition = function(object) cat(\"shape\"))",
      "setMethod(\"draw\", \"Shape\", drawImpl)",
      "setMethod(\"fill\", function(object) 1)",
    ].join("\n"), "r");
    assert.deepEqual(ids(result), [file, `${file}#Shape.show`]);
    const show = symbol(result, `${file}#Shape.show`);
    assert.equal(show.kind, "method");
    assert.equal(show.owner, "Shape");
    const call = result.rawEdges.find((e) => e.relation === "calls" && e.name === "cat");
    assert.equal(call?.source, `${file}#Shape.show`);
  });

  test("an ordinary comment ends a roxygen block", () => {
    const file = "doc.R";
    const result = extractFile(file, [
      "#' @export",
      "# plain note",
      ".hidden <- function() 1",
      "#' Documented only",
      "# plain note",
      "shown <- function() 2",
      "#' Documented only",
      "internal <- function() 3",
      "#' @export",
      ".exported <- function() 4",
    ].join("\n"), "r");
    // Cut off from its `@export`, the dotted name falls back to the naming convention.
    assert.equal(symbol(result, `${file}#.hidden`).exported, false);
    // Cut off from its untagged block, the plain name is public by convention.
    assert.equal(symbol(result, `${file}#shown`).exported, true);
    // A block that touches its definition decides on its own.
    assert.equal(symbol(result, `${file}#internal`).exported, false);
    assert.equal(symbol(result, `${file}#.exported`).exported, true);
  });
});

describe("headers without a body", () => {
  test("a bodyless Go function declaration keeps its whole declaration as the signature", () => {
    const file = "svc/clock.go";
    const result = extractFile(file, [
      "package svc",
      "func now() int64",
      "func run() int64 { return now() }",
    ].join("\n"), "go");
    const now = symbol(result, `${file}#now`);
    assert.equal(now.kind, "function");
    assert.equal(now.signature, "func now() int64");
    assert.equal(now.span, "L2-L2");
    assert.equal(now.exported, false);
    assert.equal(symbol(result, `${file}#run`).signature, "func run() int64");
  });

  test("a module-level TypeScript wrapper call around a function defines that function", () => {
    const file = "wrap.ts";
    const result = extractFile(file, [
      "export const handler = Sentry.wrap(() => 1);",
      "const doubled = items.map((x) => x * 2);",
      "const memo = once(function inner() { return 2; });",
    ].join("\n"), "typescript");
    // An uppercase namespace's method and a bare call wrap a function; a value's method makes data.
    assert.deepEqual(ids(result), [file, `${file}#handler`, `${file}#memo`]);
    assert.equal(symbol(result, `${file}#handler`).kind, "function");
    assert.equal(symbol(result, `${file}#handler`).exported, true);
    assert.equal(symbol(result, `${file}#memo`).exported, false);
    const map = result.rawEdges.find((e) => e.relation === "calls" && e.name === "map");
    assert.equal(map?.source, file, "the data-making call stays on the module");
  });
});

describe("annotation and attribute references", () => {
  test("Java keeps a scoped annotation's whole name and reads method annotations", () => {
    const file = "Audit.java";
    const result = extractFile(file, [
      "import com.acme.Tracked;",
      "@com.acme.Audit",
      "@Tracked(level = 2)",
      "public class Audit {",
      "  @Override public String toString() { return \"\"; }",
      "}",
    ].join("\n"), "java");
    assert.deepEqual(references(result, `${file}#Audit`), [
      { name: "com.acme.Audit", specifier: undefined },
      { name: "Tracked", specifier: undefined },
    ]);
    assert.deepEqual(references(result, `${file}#Audit.toString`), [{ name: "Override", specifier: undefined }]);
  });

  test("PHP attributes reference their class through the file's use clauses or their own qualified name", () => {
    const file = "app/Controller.php";
    const result = extractFile(file, [
      "<?php",
      "namespace App\\Http;",
      "use App\\Attr\\Route;",
      "#[Route(\"/users\"), \\App\\Attr\\Cached]",
      "class Controller {",
      "  #[Route(\"/show\")]",
      "  public function show() { return 1; }",
      "}",
    ].join("\n"), "php");
    assert.deepEqual(references(result, `${file}#Controller`), [
      { name: "Route", specifier: "App\\Attr\\Route" },
      { name: "Cached", specifier: "App\\Attr\\Cached" },
    ]);
    assert.deepEqual(references(result, `${file}#Controller.show`), [{ name: "Route", specifier: "App\\Attr\\Route" }]);
  });

  test("PHP group use clauses qualify a reference with the group prefix and follow aliases", () => {
    const file = "app/make.php";
    const result = extractFile(file, [
      "<?php",
      "use App\\Models\\{User, Post as Article};",
      "function make() { new Article(); return new User(); }",
    ].join("\n"), "php");
    assert.deepEqual(references(result, `${file}#make`), [
      { name: "Post", specifier: "App\\Models\\Post" },
      { name: "User", specifier: "App\\Models\\User" },
    ]);
  });
});
