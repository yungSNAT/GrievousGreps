import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { extractFile } from "../src/graph/extract.js";
import { warmDepthGrammars } from "../src/graph/depth-parser.js";

let restoreFetch: (() => void) | undefined;

before(async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    assert.fail("Graph extraction must work offline");
  });
  restoreFetch = () => fetchMock.mock.restore();
  await warmDepthGrammars(["php", "r"]);
});

after(() => restoreFetch?.());

describe("PHP group use imports", () => {
  test("preserves group namespace prefix on imports edges", () => {
    const file = "Service.php";
    const result = extractFile(
      file,
      String.raw`<?php
namespace App\Services;
use App\Models\{User, Post};
use App\Contracts\Cacheable;
use \App\Support\Str;

function load(User $u, Post $p): void {}
`,
      "php",
    );

    const imports = result.rawEdges
      .filter((e) => e.relation === "imports")
      .map((e) => e.specifier)
      .sort();
    assert.deepEqual(imports, [
      "App\\Contracts\\Cacheable",
      "App\\Models\\Post",
      "App\\Models\\User",
      "App\\Support\\Str",
    ]);

    const refs = result.rawEdges
      .filter((e) => e.relation === "references")
      .map((e) => ({ name: e.name, specifier: e.specifier }))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    assert.deepEqual(refs, [
      { name: "Post", specifier: "App\\Models\\Post" },
      { name: "User", specifier: "App\\Models\\User" },
    ]);
  });

  test("preserves group namespace prefix for nested qualified clauses and aliases", () => {
    const file = "Controller.php";
    const result = extractFile(
      file,
      String.raw`<?php
namespace App\Http;
use App\{Models\User as Account, Services\Auth};

function handle(Account $u, Auth $a): void {}
`,
      "php",
    );

    const imports = result.rawEdges
      .filter((e) => e.relation === "imports")
      .map((e) => e.specifier)
      .sort();
    assert.deepEqual(imports, ["App\\Models\\User", "App\\Services\\Auth"]);

    const refs = result.rawEdges
      .filter((e) => e.relation === "references")
      .map((e) => ({ name: e.name, specifier: e.specifier }))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    assert.deepEqual(refs, [
      { name: "Auth", specifier: "App\\Services\\Auth" },
      { name: "User", specifier: "App\\Models\\User" },
    ]);
  });
});

describe("R S3 UseMethod() generic detection", () => {
  test("does not register an S3 generic for no-arg, dynamic, or empty UseMethod()", () => {
    const file = "s3_invalid.R";
    const result = extractFile(
      file,
      `
f <- function(x) UseMethod()
f.cls <- function(x) 1

g <- function(x) UseMethod(x)
g.cls <- function(x) 2

h <- function(x) UseMethod("")
h.cls <- function(x) 3
`,
      "r",
    );

    for (const id of [`${file}#f`, `${file}#f.cls`, `${file}#g`, `${file}#g.cls`, `${file}#h`, `${file}#h.cls`]) {
      const node = result.nodes.find((n) => n.id === id);
      assert.ok(node, `Expected node ${id}`);
      assert.equal(node.kind, "function", `${id} must stay a plain function`);
      assert.equal(node.owner, undefined, `${id} must have no S3 class owner`);
    }
    assert.equal(
      result.nodes.some((n) => n.owner === "cls"),
      false,
      "must not invent S3 methods for cls",
    );
  });

  test("registers S3 generics for string-literal positional, named, and right-assigned UseMethod()", () => {
    const file = "s3_valid.R";
    const result = extractFile(
      file,
      `
summarize <- function(x) UseMethod("summarize")
summarize.cls <- function(x) 1

format_it <- function(x) UseMethod(generic = "format_it")
format_it.cls <- function(x) 2

opt_gen <- function(x) UseMethod(object = x, generic = "opt_gen")
opt_gen.cls <- function(x) 3

function(x) UseMethod("r_gen") -> r_gen
r_gen.cls <- function(x) 4
`,
      "r",
    );

    for (const [id, name] of [
      [`${file}#cls.summarize`, "summarize"],
      [`${file}#cls.format_it`, "format_it"],
      [`${file}#cls.opt_gen`, "opt_gen"],
      [`${file}#cls.r_gen`, "r_gen"],
    ] as const) {
      const node = result.nodes.find((n) => n.id === id);
      assert.ok(node, `Expected S3 method node ${id}`);
      assert.equal(node.kind, "method");
      assert.equal(node.owner, "cls");
      assert.equal(node.name, name);
    }
  });
});

describe("R roxygen scanning across plain # comments", () => {
  test("skips plain # comments without ending the preceding roxygen block", () => {
    const file = "roxygen_comments.R";
    const result = extractFile(
      file,
      `
#' @export
# plain note before function
.exported_dot <- function() 1

#' Internal helper docs
# plain note between doc and function
plain_internal <- function() 2

#' @title Multi-part doc
# middle plain comment
#' @export
#' @param x a value
.split_exported <- function(x) x

# standalone plain comment after a definition
plain_fallback <- function() 3

# another standalone plain comment
.dot_fallback <- function() 4
`,
      "r",
    );

    const exportedOf = (name: string) => result.nodes.find((n) => n.id === `${file}#${name}`)?.exported;
    assert.equal(exportedOf(".exported_dot"), true, "@export across plain # marks leading-dot fn exported");
    assert.equal(exportedOf("plain_internal"), false, "untagged roxygen across plain # marks plain fn unexported");
    assert.equal(exportedOf(".split_exported"), true, "@export separated by plain # inside block still exports");
    assert.equal(exportedOf("plain_fallback"), true, "plain # alone falls back to exported");
    assert.equal(exportedOf(".dot_fallback"), false, "plain # alone falls back to unexported for leading-dot");
  });
});
