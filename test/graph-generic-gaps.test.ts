/**
 * Gap coverage for src/graph/generic.ts: registry lookups, grammar warming and loading,
 * parse failures, the walker fallback and the per-language passes (C, PHP, Rust, Elixir, Gleam).
 */
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import {
  GENERIC_LANGS,
  extractGeneric,
  fallbackLangOf,
  genericExtensions,
  genericLangOf,
  hideGenericGrammarsForTest,
  isWarm,
  loadWasmLanguage,
  parseWasm,
  swapGrammarForTest,
  warmGenericGrammars,
  withoutGenerics,
} from "../src/graph/generic.js";

type Edge = Record<string, any>;
const edgesOf = (r: { rawEdges: unknown[] }): Edge[] => r.rawEdges as Edge[];

void mock;

describe("registry lookups", () => {
  test("fallbackLangOf gives java its own breadth row and stand-ins for the rest", () => {
    const java = fallbackLangOf("java");
    assert.equal(java.name, "java");
    assert.ok(java.exts.includes(".java"));
    assert.equal(java, GENERIC_LANGS.find((l) => l.name === "java"));
    assert.equal(java, genericLangOf("src/Main.java"), "the .java breadth row is the native fallback");
    assert.equal(fallbackLangOf("typescript").wasm, "typescript");

    const go = fallbackLangOf("go" as never);
    assert.deepEqual(go, { name: "go", exts: [], wasm: "go", bundledTags: ["go"] });
    const r = fallbackLangOf("r" as never);
    assert.deepEqual(r.bundledTags, ["r"]);
    const php = fallbackLangOf("php" as never);
    assert.equal(php.wasm, "php");
    assert.equal(php.bundledTags, undefined);
    assert.equal(fallbackLangOf("typescript" as never).bundledTags?.join(","), "javascript,typescript");
  });

  test("genericLangOf matches extensions case-insensitively and rejects unknown ones", () => {
    assert.equal(genericLangOf("src/Lib.RS")?.name, "rust");
    assert.equal(genericLangOf("solver.f90")?.name, "fortran");
    assert.equal(genericLangOf("notes.txt"), null);
    const exts = genericExtensions();
    assert.ok(exts.includes(".f08"));
    assert.ok(exts.includes(".gleam"));
    assert.ok(!exts.includes(".f"));
  });
});

describe("withoutGenerics", () => {
  test("drops turbofish and type arguments", () => {
    assert.equal(withoutGenerics("a::Foo::<Vec<u8>>::new"), "a::Foo::new");
    assert.equal(withoutGenerics("Ref<'a, T>::get"), "Ref::get");
  });
  test("ignores angle brackets inside brackets, arrows and literals", () => {
    assert.equal(withoutGenerics("f::<{ 1 < 2 }>"), "f");
    assert.equal(withoutGenerics("Box<dyn Fn() -> u8>::call"), "Box::call");
    assert.equal(withoutGenerics("X<'}'>::y"), "X::y");
    assert.equal(withoutGenerics('m<r#"a>b"#>::z'), "m::z");
    assert.equal(withoutGenerics('S<"q>\\"">::w'), "S::w");
  });
});

describe("loading and parsing", () => {
  test("loadWasmLanguage returns null for a missing or hidden grammar", async () => {
    assert.equal(await loadWasmLanguage("definitely-not-a-grammar"), null);
    hideGenericGrammarsForTest(["lua"]);
    try {
      assert.equal(await loadWasmLanguage("lua"), null);
    } finally {
      hideGenericGrammarsForTest([]);
    }
  });

  test("parseWasm parses with a loaded grammar and returns null for a bogus one", async () => {
    const lua = await loadWasmLanguage("lua");
    assert.ok(lua, "lua grammar should load");
    const root = parseWasm(lua, "function g() end\n");
    assert.ok(root);
    assert.equal(root!.hasError, false);
    assert.match(root!.text, /function g\(\) end/);
    assert.equal(parseWasm({ not: "a language" }, "x"), null);
  });

  test("warmGenericGrammars warms stand-ins and skips unknown names", async () => {
    await warmGenericGrammars(["go", "php", "no-such-lang"]);
    assert.equal(isWarm("go"), true);
    assert.equal(isWarm("php"), true);
    assert.equal(isWarm("no-such-lang"), false);
    // A second call with everything already loaded returns early and changes nothing.
    await warmGenericGrammars(["go"]);
    assert.equal(isWarm("go"), true);
  });
});

describe("extractGeneric", () => {
  before(async () => {
    await warmGenericGrammars(["go", "php", "c", "rust", "ocaml", "elixir", "gleam"]);
  });

  test("an unwarmed language yields only the file node", () => {
    const r = extractGeneric("dir/b.unknown", "one\ntwo\nthree", "notalang");
    assert.equal(r.nodes.length, 1);
    const file = r.nodes[0]!;
    assert.equal(file.kind, "file");
    assert.equal(file.name, "b.unknown");
    assert.equal(file.span, "L1-L3");
    assert.equal(file.chars, Buffer.byteLength("one\ntwo\nthree"));
    assert.deepEqual(r.rawEdges, []);
  });

  test("a grammar that throws is reported, not swallowed", () => {
    const prev = swapGrammarForTest("fakelang", { language: { bogus: true }, query: null });
    try {
      assert.throws(() => extractGeneric("x.fake", "code", "fakelang"), /fakelang grammar threw: /);
    } finally {
      swapGrammarForTest("fakelang", prev);
    }
    assert.equal(isWarm("fakelang"), false);
  });

  test("go extracts through the bundled tags stand-in", () => {
    const src = "package main\n\nfunc helper() {}\n\nfunc main() {\n\thelper()\n}\n";
    const r = extractGeneric("main.go", src, "go");
    const names = r.nodes.map((n) => n.name);
    assert.ok(names.includes("helper"), names.join(","));
    assert.ok(names.includes("main"), names.join(","));
    const main = r.nodes.find((n) => n.name === "main")!;
    assert.equal(main.span, "L5-L7");
    assert.equal(main.signature, "func main()");
  });

  test("C local includes become imports; system includes do not", () => {
    const src = '#include "util.h"\n#include <stdio.h>\nint helper(void) { return 1; }\nint main(void) { return helper(); }\n';
    const r = extractGeneric("main.c", src, "c");
    const imports = edgesOf(r).filter((e) => e.relation === "imports");
    assert.deepEqual(imports.map((e) => e.specifier), ["util.h"]);
    assert.ok(r.nodes.some((n) => n.id === "main.c#main"));
    const call = edgesOf(r).find((e) => e.relation === "calls" && e.name === "helper");
    assert.equal(call?.source, "main.c#main");
  });

  test("PHP use declarations import classes and skip function imports", () => {
    const src = "<?php\nnamespace Shop;\nuse App\\Models\\User;\nuse function App\\helper;\nclass Cart {}\n";
    const r = extractGeneric("Cart.php", src, "php");
    const specs = edgesOf(r).filter((e) => e.relation === "imports").map((e) => e.specifier);
    assert.ok(specs.includes("App\\Models\\User"), specs.join(","));
    assert.ok(!specs.some((s) => String(s).includes("helper")), specs.join(","));
    assert.ok(r.nodes.some((n) => n.name === "Cart"));
  });

  test("a grammar with no tags query falls back to the node-kind walker", () => {
    const r = extractGeneric("math.ml", "let add x y = x + y\n", "ocaml");
    assert.ok(r.nodes.some((n) => n.name === "add" && n.kind === "variable"), JSON.stringify(r.nodes.map((n) => [n.name, n.kind])));
    assert.deepEqual(edgesOf(r).filter((e) => e.relation === "calls"), []);
  });

  describe("rust", () => {
    const src = [
      "use crate::engine::Engine;",
      "pub use crate::util::helper;",
      "mod option;",
      "pub mod config;",
      "type Alias = Engine;",
      "pub struct Holder { engine: Engine, count: u32 }",
      "pub trait Run { fn run(&self); }",
      "impl Run for Holder { fn run(&self) { helper(); self.engine.start(); } }",
      "impl Holder { pub fn new() -> Holder { Holder { engine: Engine::new(), count: 0 } } }",
      "#[cfg(test)]",
      "fn only_test() {}",
      "macro_rules! cfg_rt { ($($item:item)*) => { $($item)* } }",
      "cfg_rt! { pub fn spawn() {} }",
      "fn main() { assert!(compute(1)); }",
      "fn compute(x: u32) -> bool { x > 0 }",
      "",
    ].join("\n");
    let nodes: ReturnType<typeof extractGeneric>["nodes"];
    let edges: Edge[];
    before(() => {
      const r = extractGeneric("lib.rs", src, "rust");
      nodes = r.nodes;
      edges = edgesOf(r);
    });

    test("methods carry their impl owner and return type", () => {
      const ctor = nodes.find((n) => n.name === "new");
      assert.equal(ctor?.owner, "Holder");
      assert.equal(ctor?.returns, "Holder");
      assert.ok(nodes.some((n) => n.name === "run" && n.owner === "Holder"));
    });

    test("items inside an item macro are unwrapped and tied to the macro", () => {
      assert.ok(nodes.some((n) => n.id === "lib.rs#spawn"));
      const region = edges.find((e) => e.rustMacroItems);
      assert.equal(region?.rustMacroItems.macro, "cfg_rt");
      assert.ok(region?.rustMacroItems.ids.includes("lib.rs#spawn"));
      const cfg = edges.find((e) => e.rustCfgItems)?.rustCfgItems as [string, string][];
      const ids = cfg.map(([id]) => id);
      assert.ok(ids.includes("lib.rs#only_test"), ids.join(","));
      assert.ok(ids.includes("lib.rs#spawn"), ids.join(","));
      assert.ok(!ids.includes("lib.rs#main"));
    });

    test("module-level facts become raw edges", () => {
      const specs = edges.filter((e) => e.specifier).map((e) => e.specifier);
      assert.ok(specs.includes("crate/engine/Engine"), specs.join(","));
      const pub = edges.find((e) => e.rustPubUses)?.rustPubUses;
      assert.deepEqual(pub?.names, [["helper", "crate::util::helper"]]);
      const mods = edges.find((e) => e.rustModUses)?.rustModUses;
      assert.deepEqual(mods?.mods, ["option", "config"]);
      assert.deepEqual(mods?.open, ["config"]);
      const alias = edges.find((e) => e.rustAlias)?.rustAlias;
      assert.equal(alias?.alias, "Alias");
      assert.equal(alias?.target, "Engine");
      assert.deepEqual(edges.find((e) => e.rustFields)?.rustFields, { owner: "Holder", fields: [["engine", "Engine"]] });
      assert.deepEqual(edges.find((e) => e.rustImpl)?.rustImpl, { trait: "Run", type: "Holder" });
      assert.deepEqual(edges.find((e) => e.rustMacroDef)?.rustMacroDef, { name: "cfg_rt", emits: true });
      const used = edges.find((e) => e.rustUseNames)?.rustUseNames;
      assert.ok(used?.names.includes("Engine"));
      assert.equal(used?.glob, false);
    });

    test("calls inside macro arguments and through self fields are kept", () => {
      const viaMacro = edges.find((e) => e.relation === "calls" && e.name === "compute");
      assert.equal(viaMacro?.source, "lib.rs#main");
      assert.equal(viaMacro?.rustForm, "free");
      const start = edges.find((e) => e.relation === "calls" && e.name === "start");
      assert.deepEqual(start?.rustChain, { field: { owner: "Holder", field: "engine" }, methods: [] });
    });
  });

  test("elixir remote calls are typed through the module's aliases", () => {
    const src = "defmodule Shop.Checkout do\n  alias Shop.Cart\n  def total(x), do: Cart.sum(x)\nend\n";
    const r = extractGeneric("lib/checkout.ex", src, "elixir");
    const call = edgesOf(r).find((e) => e.relation === "calls" && e.name === "sum");
    assert.equal(call?.recvType, "Shop.Cart");
    assert.equal(call?.argCount, 1);
    assert.equal(call?.viaMember, true);
    const total = r.nodes.find((n) => n.name === "total");
    assert.equal(total?.owner, "Shop.Checkout");
    assert.equal(total?.arity, 1);
  });

  test("gleam imports and qualified calls are pinned to their module", () => {
    const src = "import app/thing\n\npub fn main() {\n  thing.helper(1)\n}\n";
    const r = extractGeneric("src/app/main.gleam", src, "gleam");
    const edges = edgesOf(r);
    assert.ok(edges.some((e) => e.relation === "imports" && e.specifier === "app/thing"));
    const call = edges.find((e) => e.relation === "calls" && e.name === "helper");
    assert.equal(call?.specifier, "app/thing");
    assert.equal(call?.source, "src/app/main.gleam#main");
  });
});

after(() => {
  hideGenericGrammarsForTest([]);
});
