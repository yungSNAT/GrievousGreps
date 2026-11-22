/** Class-file imports stay distinct from PHP function and constant imports. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractGeneric, isWarm, loadWasmLanguage, parseWasm, warmGenericGrammars } from "../src/graph/generic.js";

await warmGenericGrammars(["php"]);
const grammar = await loadWasmLanguage("php");

test("the shipped breadth PHP grammar loads", () => {
  assert.ok(grammar, "the shipped breadth PHP grammar must load");
  assert.ok(isWarm("php"), "the shipped breadth PHP grammar must be available");
});

function imports(source: string): string[] {
  const root = parseWasm(grammar, source);
  assert.ok(root && "hasError" in root, "the breadth grammar must parse the fixture");
  assert.equal(root.hasError, false, "fixture must parse without breadth grammar errors");
  return extractGeneric("PUBLIC.php", source, "php").rawEdges
    .filter((edge) => edge.relation === "imports")
    .map((edge) => edge.specifier!)
    .sort();
}

test("PHP breadth imports expand plain, comma and grouped class names without their aliases", () => {
  const source = String.raw`<?php
use App\Plain;
use App\One as First, App\Two;
use App\Attrs\{Route as Endpoint, Audit};
use \App\Root;
use \App\Base\{One};
use function App\helper;
use const App\READY;
#[Endpoint]
class Widget {}
`;
  assert.deepEqual(imports(source), ["App\\Attrs\\Audit", "App\\Attrs\\Route", "App\\One", "App\\Plain", "App\\Two", "\\App\\Base\\One", "\\App\\Root"]);
});

test("PHP mixed groups do not invent class-file imports for functions or constants", () => {
  // Mixed groups have been supported since PHP 7: https://wiki.php.net/rfc/group_use_declarations
  const source = String.raw`<?php
use App\{Widget, function helper, const READY};
`;
  assert.deepEqual(imports(source), ["App\\Widget"]);
});

test("PHP import keywords after comments and multi-byte characters still import only classes", () => {
  // Tree-sitter's offsets here match the source's UTF-16 indices, so a 2-byte or 4-byte character
  // before the keyword moves neither the keyword nor the namespace separator after it.
  const source = String.raw`<?php
use /* é */ function \App\{helper};
use /* 🦀 */ const \App\READY, \App\OTHER;
use App\{/* é */ function \helper, Widget};
`;
  assert.deepEqual(imports(source), ["App\\Widget"]);
});

test("PHP mixed groups keep class aliases and keyword-prefixed class names", () => {
  const source = String.raw`<?php
use App\{Widget as Alias, function helper as help, const READY as Ready, FunctionThing, ConstantThing};
`;
  assert.deepEqual(imports(source), ["App\\ConstantThing", "App\\FunctionThing", "App\\Widget"]);
});

test("PHP groups containing only imported symbols produce no class-file import edges", () => {
  const source = String.raw`<?php
use function App\{helper, other};
use const App\{READY, OTHER};
`;
  assert.deepEqual(imports(source), []);
});

test("PHP import keywords are case insensitive without changing class-name spelling", () => {
  const source = String.raw`<?php
USE App\Plain AS PlainAlias;
UsE App\{Widget AS GroupedAlias, FuNcTiOn helper AS Help, CoNsT READY AS Ready};
USE FUNCTION App\{helper, other};
USE CONST App\{READY, OTHER};
`;
  assert.deepEqual(imports(source), ["App\\Plain", "App\\Widget"]);
});

test("PHP class imports may use keyword namespace segments and Unicode name suffixes", () => {
  const source = String.raw`<?php
use App\{function\Widget, const\Thing, FunctionÉclair, ConstÉclair};
use function\App\{Other};
use function\App\One, const\App\Two;
`;
  assert.deepEqual(imports(source), ["App\\ConstÉclair", "App\\FunctionÉclair", "App\\const\\Thing", "App\\function\\Widget", "const\\App\\Two", "function\\App\\One", "function\\App\\Other"]);
});

test("PHP import comments separate symbols and preserve qualified names from PHP 7 source", () => {
  // PHP 7 permitted comments between namespace separators. The shipped grammar
  // recognises this legacy syntax as well as PHP 8's keyword namespace segments.
  const source = String.raw`<?php
use App\{Widget, function /* PUBLIC */ helper, const /* PUBLIC */ READY};
use App\/* PUBLIC */Models\User as /* PUBLIC */ Alias;
use App\/* PUBLIC */Models\{Car};
use /* PUBLIC */ function App\other;
use function /* PUBLIC */ \App\rooted;
use const \App\ROOTED;
`;
  assert.deepEqual(imports(source), ["App\\Models\\Car", "App\\Models\\User", "App\\Widget"]);
});

test("PHP function and constant import kinds apply to the entire comma list", () => {
  const source = String.raw`<?php
use function App\helper as Help, App\other;
use const App\READY as Ready, App\OTHER;
`;
  assert.deepEqual(imports(source), []);
});
