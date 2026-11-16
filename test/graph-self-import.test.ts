import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph } from "../src/graph/build.js";
import * as traverse from "../src/graph/traverse-cli.js";
import type { GraphV1 } from "../src/graph/types.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

interface Graph {
  edges: { relation: string; source: string; target: string; confidence: string }[];
  unresolvedCalls?: { source: string; name: string; through: string | null }[];
}

async function build(t: { after: (f: () => void) => void }, files: Record<string, string>): Promise<Graph> {
  const root = mkdtempSync(join(tmpdir(), "self-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  await buildGraph(root);
  return JSON.parse(readFileSync(join(root, "graft", ".graph", "wiring.json"), "utf8"));
}

const calls = (graph: Graph, source: string) =>
  graph.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target).sort();

const decoy = "export function setCookie() {}\nexport function stream() {}\nexport function make() {}\n";

test("a package's own name reaches its source through `exports`, at the root and in a workspace", async (t) => {
  const graph = await build(t, {
    "package.json": JSON.stringify({
      name: "hono",
      exports: {
        ".": { import: "./dist/index.js" },
        "./cookie": { types: "./dist/types/helper/cookie/index.d.ts", import: "./dist/helper/cookie/index.js", require: "./dist/cjs/helper/cookie/index.js" },
        "./streaming": "./dist/helper/streaming/index.js",
      },
    }),
    "src/index.ts": "export function make() {}\n",
    "src/helper/cookie/index.ts": "export function setCookie() {}\n",
    "src/helper/streaming/index.ts": "export function stream() {}\n",
    "src/decoy.ts": decoy,
    "adapters/lambda/a.ts": `import { make } from "hono";\nimport { setCookie } from "hono/cookie";\nimport { stream } from "hono/streaming";\nexport function run() { make(); setCookie(); stream(); }\n`,
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { "./deep": { default: "./lib/deep/entry.mjs" }, "./feat/*": "./dist/feat/*.js" } }),
    "packages/core/src/deep/entry.ts": "export function dig() {}\n",
    "packages/core/src/feat/one.ts": "export function one() {}\n",
    "packages/other/x.ts": "export function dig() {}\nexport function one() {}\n",
    "apps/b.ts": `import { dig } from "@acme/core/deep";\nimport { one } from "@acme/core/feat/one";\nexport function run() { dig(); one(); }\n`,
  });
  assert.deepEqual(calls(graph, "adapters/lambda/a.ts#run"), ["src/helper/cookie/index.ts#setCookie", "src/helper/streaming/index.ts#stream", "src/index.ts#make"]);
  assert.deepEqual(calls(graph, "apps/b.ts#run"), ["packages/core/src/deep/entry.ts#dig", "packages/core/src/feat/one.ts#one"]);
});

test("an `exports` pattern fills every `*` in its target, as Node does", async (t) => {
  const graph = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { "./feat/*": "./dist/impl/*/*.js" } }),
    "packages/core/src/impl/one/one.ts": "export function one() {}\n",
    "packages/core/src/decoy.ts": "export function one() {}\n",
    "apps/b.ts": `import { one } from "@acme/core/feat/one";\nexport function run() { one(); }\n`,
  });
  assert.deepEqual(edge(graph, "apps/b.ts#run"), [["packages/core/src/impl/one/one.ts#one", "extracted"]]);
});

const edge = (graph: Graph, source: string) =>
  graph.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => [e.target, e.confidence]);

test("a stub the manifest points at does not stop the search (vue)", async (t) => {
  const stub = `'use strict'\nmodule.exports = require('./dist/shared.cjs.js')\n`;
  const graph = await build(t, {
    "packages/shared/package.json": JSON.stringify({ name: "@vue/shared", main: "index.js", exports: { ".": { node: { default: "./index.js" }, import: "./dist/shared.esm.js", require: "./index.js" } } }),
    "packages/shared/index.js": stub,
    "packages/shared/src/index.ts": `export * from "./general";\n`,
    "packages/shared/src/general.ts": "export function isArray() {}\n",
    "packages/other/x.ts": "export function isArray() {}\n",
    "apps/a.ts": `import { isArray } from "@vue/shared";\nexport function run() { isArray(); }\n`,
  });
  assert.deepEqual(edge(graph, "apps/a.ts#run"), [["packages/shared/src/general.ts#isArray", "extracted"]]);
});

test("without `exports`, a workspace package's `main` reaches its source", async (t) => {
  const graph = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", main: "lib/entry.js" }),
    "packages/core/src/entry.ts": "export function make() {}\n",
    "packages/other/x.ts": "export function make() {}\n",
    "apps/a.ts": `import { make } from "@acme/core";\nexport function run() { make(); }\n`,
  });
  assert.deepEqual(edge(graph, "apps/a.ts#run"), [["packages/core/src/entry.ts#make", "extracted"]]);
});

test("a name no path reaches is found inside its package and marked inferred; a wildcard path reaches its own", async (t) => {
  const graph = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { "./features/*": "./dist/impl/*.js", "./gen": "./generated/gen.js" } }),
    "packages/core/src/impl/one.ts": "export function one() {}\n",
    "packages/core/src/gen-source.ts": "export function gen() {}\n",
    "packages/other/x.ts": "export function one() {}\nexport function gen() {}\n",
    "apps/a.ts": `import { one } from "@acme/core/features/one";\nimport { gen } from "@acme/core/gen";\nexport function run() { one(); gen(); }\n`,
  });
  assert.deepEqual(edge(graph, "apps/a.ts#run").sort(), [
    ["packages/core/src/gen-source.ts#gen", "inferred"],
    ["packages/core/src/impl/one.ts#one", "extracted"],
  ]);
});

test("the repo's own import that nothing in its package defines is reported, and an outside one stays silent", async (t) => {
  const graph = await build(t, {
    "package.json": JSON.stringify({ name: "hono", exports: { "./gen": "./generated/gen.js" } }),
    "packages/twice/package.json": JSON.stringify({ name: "twice" }),
    "packages/twice/a.ts": "export function both() {}\n",
    "packages/twice/b.ts": "export function both() {}\n",
    "src/decoy.ts": "export function ext() {}\n",
    "a.ts": `import { gen } from "hono/gen";\nimport { ext } from "other-pkg/sub";\nimport * as K from "hono/nope";\nimport { both } from "twice";\nexport function run() { gen(); ext(); K.ns(); both(); }\n`,
  });
  assert.deepEqual(calls(graph, "a.ts#run"), [], "no guess at the decoy");
  assert.deepEqual((graph.unresolvedCalls ?? []).filter((u) => u.source === "a.ts#run").map((u) => [u.name, u.through]).sort(), [
    ["both", "twice"],
    ["gen", "hono/gen"],
    ["ns", "hono/nope"],
  ]);
});

test("`baseUrl` without `paths` is in the repo when the first segment is under it, and outside when not", async (t) => {
  const graph = await build(t, {
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "./src" } }),
    "src/lib/util.ts": "export function f() {}\n",
    "z/other.ts": "export function f() {}\nexport function ext() {}\nexport function gone() {}\n",
    "a.ts": `import { f } from "lib/util";\nimport { ext } from "lodash";\nimport { gone } from "lib/gone";\nexport function run() { f(); ext(); gone(); }\n`,
  });
  assert.deepEqual(calls(graph, "a.ts#run"), ["src/lib/util.ts#f"]);
  assert.deepEqual((graph.unresolvedCalls ?? []).filter((u) => u.source === "a.ts#run").map((u) => u.name), ["gone"]);
});

test("Python: an absolute import of the repo's own package finds its module", async (t) => {
  const graph = await build(t, {
    "mypkg/__init__.py": "",
    "mypkg/b.py": "def f():\n    pass\n",
    "other/__init__.py": "",
    "other/c.py": "def f():\n    pass\n",
    "mypkg/a.py": "from mypkg.b import f\n\ndef run():\n    f()\n",
  });
  assert.deepEqual(calls(graph, "mypkg/a.py#run"), ["mypkg/b.py#f"]);
});

test("Rust: `crate::` and a workspace member's own name both reach it", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[workspace]\nmembers = ["crates/*"]\n`,
    "crates/grep-printer/Cargo.toml": `[package]\nname = "grep-printer"\n`,
    "crates/grep-printer/src/lib.rs": "pub mod util;\npub fn run() { crate::util::f(); }\n",
    "crates/grep-printer/src/util.rs": "pub fn f() {}\n",
    "crates/app/Cargo.toml": `[package]\nname = "app"\n[dependencies]\ngrep-printer = "1"\n`,
    "crates/app/src/main.rs": "use grep_printer::util::f;\nfn main() { f(); }\n",
  });
  assert.deepEqual(calls(graph, "crates/grep-printer/src/lib.rs#run"), ["crates/grep-printer/src/util.rs#f"]);
  assert.deepEqual(calls(graph, "crates/app/src/main.rs#main"), ["crates/grep-printer/src/util.rs#f"]);
});

const types = "pub struct One;\npub struct Two;\nimpl One { pub fn go() {} }\nimpl Two { pub fn run() {} }\n";

test("Rust: an alias reads in its inline module, so 2 modules may share its name", async (t) => {
  const graph = await build(t, {
    "src/t.rs": types,
    "src/a.rs": "mod a { type R = crate::t::One; pub fn x() { R::go(); } }\nmod b { type R = crate::t::Two; pub fn y() { R::run(); } }\n",
  });
  assert.equal(calls(graph, "src/a.rs#x").length, 1, "the first module's alias");
  assert.equal(calls(graph, "src/a.rs#y").length, 1, "the second module's alias");
});

test("Rust: an alias names its crate, which picks between the repo's types of that name (ripgrep's Range)", async (t) => {
  const graph = await build(t, {
    "crates/matcher/Cargo.toml": `[package]\nname = "grep-matcher"\n`,
    "crates/matcher/src/lib.rs": "pub struct Match;\nimpl Match { pub fn new() {} }\n",
    "crates/ignore/Cargo.toml": `[package]\nname = "ignore"\n`,
    "crates/ignore/src/lib.rs": "pub struct Match;\nimpl Match { pub fn new() {} }\n",
    "crates/searcher/Cargo.toml": `[package]\nname = "grep-searcher"\n[dependencies]\ngrep-matcher = { path = "../matcher" }\n`,
    "crates/searcher/src/lib.rs": "use grep_matcher::Match;\npub type Range = Match;\n",
    "crates/searcher/src/core.rs": "use crate::Range;\nfn f() { Range::new(); }\n",
  });
  assert.deepEqual(calls(graph, "crates/searcher/src/core.rs#f").map((x) => x.split("#")[0]), ["crates/matcher/src/lib.rs"]);
});

test("Rust: an alias of a dependency's type stops there, and a type only a macro makes is stated", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[package]\nname = "app"\n[dependencies]\nhttp = "1"\n`,
    "src/lib.rs": "pub struct Other;\nimpl Other { pub fn from_err() {} pub fn builder() {} }\ndefine!(MadeByMacro);\n",
    "src/a.rs": "type Req = http::Request;\npub fn up() { Req::builder(); }\npub fn made() { MadeByMacro::from_err(); }\n",
  });
  assert.deepEqual(calls(graph, "src/a.rs#up"), []);
  const stated = (graph.unresolvedCalls ?? []).filter((u) => u.source.startsWith("src/a.rs")).map((u) => [u.source, u.name, u.through]);
  assert.deepEqual(stated, [["src/a.rs#up", "builder", "Request"], ["src/a.rs#made", "from_err", "MadeByMacro"]]);
});

test("a relative import of a file the graph lacks, such as a build's, is reported with no guess", async (t) => {
  const graph = await build(t, {
    "src/effect.ts": "export function effect() {}\n",
    "bench/a.ts": `import { effect } from "../dist/reactivity";\nexport function run() { effect(); }\n`,
  });
  assert.deepEqual(calls(graph, "bench/a.ts#run"), []);
  assert.deepEqual((graph.unresolvedCalls ?? []).map((u) => [u.name, u.through]), [["effect", "../dist/reactivity"]]);
});

const stated = (graph: Graph, source: string) => (graph.unresolvedCalls ?? []).filter((u) => u.source === source).map((u) => [u.name, u.through]);

test("V3: an entry forwarding the name outside does not end the search past one defining it", async (t) => {
  const graph = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { ".": { require: "./cjs/entry.cjs", import: "./esm/entry.js" } } }),
    "packages/core/cjs/entry.cjs": `export { run } from "outside-pkg";\n`,
    "packages/core/esm/entry.js": "export function run() {}\n",
    "packages/other/x.ts": "export function run() {}\n",
    "apps/a.ts": `import { run } from "@acme/core";\nexport function go() { run(); }\n`,
  });
  assert.deepEqual(calls(graph, "apps/a.ts#go"), ["packages/core/esm/entry.js#run"]);
  const out = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { ".": "./cjs/entry.cjs" } }),
    "packages/core/cjs/entry.cjs": `export { run } from "outside-pkg";\n`,
    "packages/other/x.ts": "export function run() {}\n",
    "apps/a.ts": `import { run } from "@acme/core";\nexport function go() { run(); }\n`,
  });
  assert.deepEqual(calls(out, "apps/a.ts#go"), [], "only outside: T1 holds");
  assert.deepEqual(stated(out, "apps/a.ts#go"), []);
});

test("V2: a package name found outside its entries must be exported under that name", async (t) => {
  const renamed = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { ".": "./dist/unmapped/entry.js" } }),
    "packages/core/src/barrel.ts": `export { execute as run } from "./impl";\n`,
    "packages/core/src/impl.ts": "export function execute() {}\n",
    "packages/core/src/other.ts": "export function run() {}\n",
    "apps/a.ts": `import { run } from "@acme/core";\nexport function go() { run(); }\n`,
  });
  assert.deepEqual(calls(renamed, "apps/a.ts#go"), [], "2 things export that name: no guess");
  assert.deepEqual(stated(renamed, "apps/a.ts#go"), [["run", "@acme/core"]]);
  const hidden = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { ".": "./dist/unmapped/entry.js" } }),
    "packages/core/src/private.ts": "function run() {}\nrun();\n",
    "apps/a.ts": `import { run } from "@acme/core";\nexport function go() { run(); }\n`,
  });
  assert.deepEqual(calls(hidden, "apps/a.ts#go"), [], "a private function of that name proves nothing");
  assert.deepEqual(stated(hidden, "apps/a.ts#go"), [["run", "@acme/core"]]);
  const proven = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { ".": "./dist/unmapped/entry.js" } }),
    "packages/core/src/barrel.ts": `export { execute as run } from "./impl";\n`,
    "packages/core/src/impl.ts": "export function execute() {}\n",
    "apps/a.ts": `import { run } from "@acme/core";\nexport function go() { run(); }\n`,
  });
  assert.deepEqual(calls(proven, "apps/a.ts#go"), [], "a rename no entry reaches proves nothing about the package (W3)");
  assert.deepEqual(stated(proven, "apps/a.ts#go"), [["run", "@acme/core"]]);
});

test("V4: an `exports` wildcard substitutes by prefix and suffix", async (t) => {
  const graph = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { "./api/*": "./dist/impl/*.js", "./v/*.js": "./dist/vers/*.js" } }),
    "packages/core/src/impl/one.ts": "export function f() {}\n",
    "packages/core/src/impl/two.ts": "export function f() {}\n",
    "packages/core/src/vers/three.ts": "export function g() {}\n",
    "packages/core/src/vers/four.ts": "export function g() {}\n",
    "apps/a.ts": `import { f } from "@acme/core/api/two";\nimport { g } from "@acme/core/v/three.js";\nexport function go() { f(); g(); }\n`,
  });
  assert.deepEqual(edge(graph, "apps/a.ts#go").sort(), [["packages/core/src/impl/two.ts#f", "extracted"], ["packages/core/src/vers/three.ts#g", "extracted"]]);
});

test("V5: an alias reaches another Rust module only through a `use`", async (t) => {
  const graph = await build(t, {
    "src/t.rs": "pub struct Match;\nimpl Match { pub fn run() {} }\n",
    "src/a.rs": "use crate::t::Match;\npub type Range = Match;\n",
    "src/sibling.rs": "fn f() { Range::run(); }\n",
    "src/user.rs": "use crate::a::Range;\nfn g() { Range::run(); }\n",
    "src/globbed.rs": "use crate::a::*;\nfn h() { Range::run(); }\n",
  });
  assert.deepEqual(calls(graph, "src/sibling.rs#f"), [], "nothing brings it in");
  assert.equal(calls(graph, "src/user.rs#g").length, 1, "a `use` does");
  assert.equal(calls(graph, "src/globbed.rs#h").length, 1, "a glob may");
});

test("U4: a child's `baseUrl` outranks the one it inherits", async (t) => {
  const graph = await build(t, {
    "tsconfig.base.json": JSON.stringify({ compilerOptions: { baseUrl: "./wrong", paths: { "~/*": ["./*"] } } }),
    "tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions: { baseUrl: "./src" } }),
    "src/lib/util.ts": "export function f() {}\nexport function h() {}\n",
    "wrong/lib/util.ts": "export function f() {}\nexport function h() {}\n",
    "a.ts": `import { f } from "lib/util";\nimport { h } from "~/lib/util";\nexport function run() { f(); h(); }\n`,
  });
  assert.deepEqual(calls(graph, "a.ts#run"), ["src/lib/util.ts#f", "src/lib/util.ts#h"]);
});

test("V6: `Self::f` in a trait impl's own `f` is the type's inherent method, not a call to itself", async (t) => {
  const graph = await build(t, {
    "src/l.rs": "pub trait L { fn accept(&mut self); }\nimpl L for ext::U { fn accept(&mut self) { Self::accept(self); } }\npub struct A;\nimpl A { pub fn go(n: u8) { Self::go(n); } }\n",
  });
  assert.deepEqual(graph.edges.filter((e) => e.relation === "calls" && e.target === e.source && e.source.includes("accept")), []);
  assert.deepEqual(calls(graph, "src/l.rs#go"), ["src/l.rs#go"], "inherent recursion stays");
});

test("a call through a `.d.ts` did not resolve, and the message names the file", async (t) => {
  const graph = await build(t, {
    "dts/utils.d.ts": "export declare function expectType<T>(v: T): void;\n",
    "dts/a.ts": `import { expectType } from "./utils";\nexport function run() { expectType(1); }\n`,
    "src/other.ts": "export function other() {}\n",
  });
  assert.deepEqual(graph.unresolvedCalls, [{ source: "dts/a.ts#run", name: "expectType", through: "./utils", file: "dts/utils.d.ts" }]);
  const g = graph as unknown as GraphV1;
  assert.match(traverse.unresolvedNoteFor(g, "in", "expectType")!, /through \.\/utils, in dts\/utils\.d\.ts, which is not indexed/);
  assert.match(traverse.noSymbolText(g, "expectType")!, /did not resolve/);
  assert.match(traverse.noSymbolText(g, "expectType")!, /dts\/utils\.d\.ts/);
  assert.doesNotMatch(traverse.noSymbolText(g, "expectType")!, /no symbol|no definition|spelling/);
  assert.equal(traverse.noSymbolText(g, "nothingCallsThis"), null);
});

test("a `macro_rules` arm's calls count, under the rules for other macro bodies", async (t) => {
  const graph = await build(t, {
    "src/routing.rs": `pub fn on() {}
pub fn on_service() {}
macro_rules! top {
    ($name:ident) => {
        pub fn $name() { on(); $crate::routing::on_service(); helper_elsewhere(); x.not_this(); }
    };
}
`,
    "src/other.rs": "pub fn helper_elsewhere() {}\npub fn not_this() {}\n",
  });
  assert.deepEqual(calls(graph, "src/routing.rs#top"), ["src/routing.rs#on", "src/routing.rs#on_service"]);
});

const tracingLike = {
  "Cargo.toml": `[workspace]\nmembers = ["core", "main-crate", "sub"]\n`,
  "core/Cargo.toml": `[package]\nname = "tracing-core"\n`,
  "core/src/lib.rs": "pub mod dispatcher;\n",
  "core/src/dispatcher.rs": "pub fn with_default() {}\npub fn get_default() {}\n",
  "main-crate/Cargo.toml": `[package]\nname = "tracing"\n[dependencies]\ntracing-core = { path = "../core" }\n`,
  "main-crate/src/lib.rs": "pub mod subscriber;\npub mod dispatcher;\npub use tracing_core::dispatcher::get_default;\n",
  "main-crate/src/subscriber.rs": "pub fn with_default() {}\n",
  "main-crate/src/dispatcher.rs": "pub use tracing_core::dispatcher::*;\n",
  "sub/Cargo.toml": `[package]\nname = "sub"\n[dependencies]\ntracing = { path = "../main-crate" }\ntracing-core = { path = "../core" }\n`,
};

test("Rust: a path follows the workspace's crates, its module files and `pub use`, past a repeated name", async (t) => {
  const graph = await build(t, {
    ...tracingLike,
    "sub/src/a.rs": `use tracing::dispatcher;
use tracing::subscriber::with_default as wd;
use crate::b::local;
pub fn spelt() { tracing::subscriber::with_default(); }
pub fn other_crate() { tracing_core::dispatcher::with_default(); }
pub fn through_glob() { dispatcher::with_default(); }
pub fn renamed() { wd(); }
pub fn reexported() { tracing::get_default(); }
pub fn own() { local(); crate::b::local(); super::a::near(); }
pub fn near() {}
`,
    "sub/src/b.rs": "pub fn local() {}\npub fn near() {}\n",
    "sub/src/lib.rs": "pub mod a;\npub mod b;\n",
  });
  assert.deepEqual(calls(graph, "sub/src/a.rs#spelt"), ["main-crate/src/subscriber.rs#with_default"]);
  assert.deepEqual(calls(graph, "sub/src/a.rs#other_crate"), ["core/src/dispatcher.rs#with_default"]);
  assert.deepEqual(calls(graph, "sub/src/a.rs#through_glob"), ["core/src/dispatcher.rs#with_default"]);
  assert.deepEqual(calls(graph, "sub/src/a.rs#renamed"), ["main-crate/src/subscriber.rs#with_default"]);
  assert.deepEqual(calls(graph, "sub/src/a.rs#reexported"), ["core/src/dispatcher.rs#get_default"]);
  assert.deepEqual(calls(graph, "sub/src/a.rs#own"), ["sub/src/a.rs#near", "sub/src/b.rs#local"]);
});

test("Rust: a call reaches each `cfg` arm of a function, by path and by bare name", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[workspace]\nmembers = ["core", "app"]\n`,
    "core/Cargo.toml": `[package]\nname = "tracing-core"\n`,
    "core/src/lib.rs": "pub mod dispatcher;\npub mod other;\npub mod blocking;\npub mod user;\npub mod process;\npub mod both;\n",
    "core/src/dispatcher.rs": `#[cfg(feature = "std")]
pub fn get_default() {}
#[cfg(not(feature = "std"))]
pub fn get_default() {}
pub fn near() { get_default(); }
mod a { pub fn twin() {} }
mod b { pub fn twin() {} }
pub fn pair() { twin(); }
mod c {
    #[cfg(unix)]
    pub fn gated() {}
    pub fn inner() { gated(); }
}
mod d {
    #[cfg(windows)]
    pub fn gated() {}
}
mod e {
    #[cfg(unix)]
    pub fn os() {}
    #[cfg(windows)]
    pub fn os() {}
    pub fn here() { os(); }
}
cfg_std! { pub fn current() {} }
cfg_no_std! { cfg_alloc! { pub fn current() {} } }
pub fn now() { current(); }
`,
    "core/src/other.rs": "pub fn get_default() {}\n",
    // tokio's `blocking.rs`: one arm re-exports the function, the others define it.
    "core/src/blocking.rs": `cfg_rt! { pub(crate) use crate::other::get_default; }
cfg_not_rt! {
    #[cfg(unix)]
    pub(crate) fn get_default() {}
    #[cfg(not(unix))]
    pub(crate) fn get_default() {}
}
pub fn inside() { crate::blocking::get_default(); }
`,
    // A path the graph cannot follow (std) is no call to same-named arms in this file.
    "core/src/process.rs": "mod c {\n    #[cfg(unix)]\n    pub fn id() {}\n    #[cfg(windows)]\n    pub fn id() {}\n}\npub fn root() { std::process::id(); }\n",
    // A macro may share a function's name (another namespace); it is no arm.
    "core/src/both.rs": "#[cfg(unix)]\npub fn foo() {}\n#[cfg(windows)]\npub fn foo() {}\nmacro_rules! foo { () => {}; }\n",
    "core/src/user.rs": "use crate::blocking::get_default;\npub fn mixed() { get_default(); }\npub fn through() { crate::both::foo(); }\n",
    "app/Cargo.toml": `[package]\nname = "app"\n[dependencies]\ntracing-core = { path = "../core" }\n`,
    "app/src/lib.rs": "use tracing_core::dispatcher;\npub fn far() { dispatcher::get_default(); }\n",
  });
  assert.ok(!calls(graph, "core/src/user.rs#mixed").includes("core/src/blocking.rs#get_default"), "an arm that re-exports leaves the name uncertain");
  assert.ok(!calls(graph, "core/src/blocking.rs#inside").includes("core/src/blocking.rs#get_default"), "also through a path inside that file");
  assert.deepEqual(calls(graph, "core/src/process.rs#root"), [], "a path that leads outside reaches no arm");
  const stated = (graph.unresolvedCalls ?? []).filter((u) => ["core/src/blocking.rs#inside", "core/src/process.rs#root"].includes(u.source)).map((u) => [u.source, u.name, u.through]).sort();
  // A call into std reaches nothing the repository defines, so it states no undercount.
  assert.deepEqual(stated, [["core/src/blocking.rs#inside", "get_default", "crate::blocking::get_default"]], "the uncertain path call is reported unresolved, with its path");
  assert.deepEqual(calls(graph, "core/src/user.rs#through"), ["core/src/both.rs#foo", "core/src/both.rs#foo~2"], "a same-named macro does not hide an arm");
  const arms = ["core/src/dispatcher.rs#get_default", "core/src/dispatcher.rs#get_default~2"];
  assert.deepEqual(calls(graph, "app/src/lib.rs#far"), arms, "through a path");
  assert.deepEqual(calls(graph, "core/src/dispatcher.rs#near"), arms, "by bare name in the same file");
  assert.deepEqual(calls(graph, "core/src/dispatcher.rs#pair"), [], "2 functions of one name in different modules are not arms");
  assert.deepEqual(calls(graph, "core/src/dispatcher.rs#inner"), [], "nor are 2 gated ones in different inline modules");
  assert.deepEqual(calls(graph, "core/src/dispatcher.rs#here"), ["core/src/dispatcher.rs#os", "core/src/dispatcher.rs#os~2"], "2 gated ones in one inline module are");
  assert.deepEqual(calls(graph, "core/src/dispatcher.rs#now"), ["core/src/dispatcher.rs#current", "core/src/dispatcher.rs#current~2"], "as are 2 inside item macros");
});

// Each case: test name, workspace files, caller and the one callee its path reaches.
const externCrateCases: [string, Record<string, string>, string, string][] = [
  ["a path follows a crate that `pub extern crate … as` re-exports", {
    "Cargo.toml": `[workspace]\nmembers = ["cli", "grep", "core"]\n`,
    "cli/Cargo.toml": `[package]\nname = "grep-cli"\n`,
    "cli/src/lib.rs": "mod hostname;\npub use crate::hostname::hostname;\n",
    "cli/src/hostname.rs": "pub fn hostname() {}\n",
    "grep/Cargo.toml": `[package]\nname = "grep"\n[dependencies]\ngrep-cli = { path = "../cli" }\n`,
    "grep/src/lib.rs": "pub extern crate grep_cli as cli;\n",
    "core/Cargo.toml": `[package]\nname = "core-app"\n[dependencies]\ngrep = { path = "../grep" }\n`,
    "core/src/lib.rs": "fn hostname() { platform(); }\nfn platform() { grep::cli::hostname(); }\n",
  }, "core/src/lib.rs#platform", "cli/src/hostname.rs#hostname"],
  ["`pub extern crate self as …` in a module names the crate root, not that module", {
    "Cargo.toml": `[workspace]\nmembers = ["lib", "app"]\n`,
    "lib/Cargo.toml": `[package]\nname = "dep"\n`,
    "lib/src/lib.rs": "pub mod sub;\npub fn target() {}\n",
    "lib/src/sub.rs": "pub extern crate self as root;\npub fn target() {}\n",
    "app/Cargo.toml": `[package]\nname = "app"\n[dependencies]\ndep = { path = "../lib" }\n`,
    "app/src/lib.rs": "pub fn go() { dep::sub::root::target(); }\n",
  }, "app/src/lib.rs#go", "lib/src/lib.rs#target"],
];
for (const [name, files, caller, callee] of externCrateCases) {
  test(`Rust: ${name}`, async (t) => {
    assert.deepEqual(calls(await build(t, files), caller), [callee]);
  });
}

test("Rust: the items inside an item macro such as `cfg_rt!` are read as items", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[workspace]\nmembers = ["rt", "app"]\n`,
    "rt/Cargo.toml": `[package]\nname = "tokio"\n`,
    "rt/src/lib.rs": "pub mod task;\npub mod runtime;\ncfg_rt! {\n    pub use task::spawn;\n}\n",
    "rt/src/task/mod.rs": "mod spawn;\ncfg_rt! {\n    mod yield_now;\n    cfg_more! {\n        #![doc = \"inner\"]\n        pub use yield_now::yield_now;\n    }\n}\ncfg_rt! { pub use spawn::spawn; }\n",
    "rt/src/task/spawn.rs": "cfg_rt! {\n    pub fn spawn() { helper(); }\n}\nfn helper() {}\n",
    "rt/src/task/yield_now.rs": "cfg_a! {\n    cfg_b! {\n        pub fn yield_now() {}\n    }\n}\nlazy_static! {\n    static ref READY: bool = true;\n}\n",
    "rt/src/runtime.rs": "pub fn spawn() {}\npub fn yield_now() {}\npub struct Handle;\nimpl Handle {\n    cfg_rt! {\n        pub fn block_on(&self) { crate::task::spawn(); }\n    }\n}\n",
    "app/Cargo.toml": `[package]\nname = "app"\n[dependencies]\ntokio = { path = "../rt" }\n`,
    "app/src/lib.rs": "pub mod a;\n",
    "app/src/a.rs": "pub fn go() { tokio::spawn(); tokio::task::yield_now(); }\n",
  });
  assert.deepEqual(calls(graph, "app/src/a.rs#go"), ["rt/src/task/spawn.rs#spawn", "rt/src/task/yield_now.rs#yield_now"]);
  assert.deepEqual(calls(graph, "rt/src/task/spawn.rs#spawn"), ["rt/src/task/spawn.rs#helper"], "a call inside belongs to its function");
  assert.deepEqual(calls(graph, "rt/src/runtime.rs#block_on"), ["rt/src/task/spawn.rs#spawn"], "an impl's item macro too");
});

test("Rust: the items of a repo macro that drops its body are no targets", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[package]\nname = "app"\n`,
    "src/lib.rs": "pub mod b;\npub mod a;\npub mod real;\n#[macro_use]\nmod macros;\ndiscard! {\n    pub use b::run;\n}\npub use real::run;\n",
    "src/macros.rs": "macro_rules! discard {\n    ($($i:item)*) => {};\n}\nmacro_rules! keep {\n    ($($i:item)*) => { $( #[cfg(test)] $i )* };\n}\nmacro_rules! either {\n    (keep $($i:item)*) => { $($i)* };\n    ($($i:item)*) => {};\n}\nmacro_rules! named {\n    (pub fn $n:ident() {}) => {};\n}\nmacro_rules! first {\n    ($a:item $b:item) => { $a };\n}\nmod one {\n    macro_rules! wrap {\n        ($($i:item)*) => { $($i)* };\n    }\n}\nmod two {\n    macro_rules! wrap {\n        ($($i:item)*) => {};\n    }\n}\npub fn setup() {\n    #[macro_export]\n    macro_rules! gone {\n        ($($i:item)*) => {};\n    }\n}\nmacro_rules! label {\n    (pub fn $n:ident() {}) => { const _: &str = stringify!($n); };\n}\nmacro_rules! documented {\n    (#[doc = $d:expr] $i:item) => { $i };\n}\nmacro_rules! pair {\n    (pub fn $n:ident() {} $b:item) => { $b };\n}\n",
    "src/b.rs": "pub fn f() {}\npub fn g() {}\npub fn h() {}\npub fn k() {}\npub fn n1() {}\npub fn q() {}\npub fn w() {}\npub fn lb() {}\npub fn dd() {}\npub fn pp() {}\npub fn run() {}\n",
    "src/real.rs": "pub fn run() {}\n",
    "src/a.rs": "use crate::b::*;\ndiscard! {\n    pub fn f() { g(); }\n}\nkeep! {\n    pub fn g() {}\n}\neither! {\n    pub fn h() {}\n}\nnamed! {\n    pub fn n1() {}\n}\nfirst! {\n    pub fn k() {}\n    pub fn spare() {}\n}\nwrap! {\n    pub fn w() {}\n}\ngone! {\n    pub fn q() {}\n}\nlabel! {\n    pub fn lb() {}\n}\ndocumented! {\n    #[doc = \"kept\"]\n    pub fn dd() {}\n}\npair! {\n    pub fn pp() {}\n    pub fn kept() {}\n}\npub fn go() { f(); g(); h(); n1(); k(); w(); q(); lb(); dd(); pp(); crate::run(); }\n",
  });
  assert.deepEqual(calls(graph, "src/a.rs#go"), ["src/a.rs#dd", "src/a.rs#g", "src/b.rs#f", "src/b.rs#h", "src/b.rs#k", "src/b.rs#lb", "src/b.rs#n1", "src/b.rs#pp", "src/b.rs#q", "src/b.rs#w", "src/real.rs#run"], "an arm that matches item tokens outside an item capture, or drops a captured item, or a dropping definition of the name anywhere, even in a function, makes the macro opaque, and its `pub use` re-exports nothing; a dropped attribute does not");
  assert.deepEqual(calls(graph, "src/a.rs#f"), [], "a dropped item calls nothing");
});

test("Rust: a module path in an inline `mod` is not one of the file's child modules", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[workspace]\nmembers = ["mock", "app"]\n`,
    "mock/Cargo.toml": `[package]\nname = "tracing-mock"\n`,
    "mock/src/lib.rs": "pub mod subscriber;\n",
    "mock/src/subscriber.rs": "pub fn mock() {}\n",
    "app/Cargo.toml": `[package]\nname = "app"\n[dependencies]\ntracing-mock = { path = "../mock" }\n`,
    "app/src/lib.rs": "pub mod subscriber;\npub fn top() { subscriber::mock(); }\nmod inner {\n    use tracing_mock::*;\n    pub fn go() { subscriber::mock(); }\n}\nmod own {\n    mod subscriber {\n        pub fn mock() {}\n    }\n    use tracing_mock::*;\n    pub fn local() { subscriber::mock(); }\n}\n",
    "app/src/subscriber.rs": "pub fn mock() {}\n",
  });
  assert.deepEqual(calls(graph, "app/src/lib.rs#top"), ["app/src/subscriber.rs#mock"]);
  assert.deepEqual(calls(graph, "app/src/lib.rs#go"), ["mock/src/subscriber.rs#mock"]);
  assert.deepEqual(calls(graph, "app/src/lib.rs#local"), ["app/src/lib.rs#mock"], "a `mod` declared in scope shadows the glob");
});

test("Rust: a module path no `use` names reads through the crates a glob `use` brings in", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[workspace]\nmembers = ["mock", "two", "app"]\n`,
    "mock/Cargo.toml": `[package]\nname = "tracing-mock"\n`,
    "mock/src/lib.rs": "pub mod subscriber;\npub mod layer;\npub mod expect;\n",
    "mock/src/subscriber.rs": "pub fn mock() {}\n",
    "mock/src/layer.rs": "pub fn mock() {}\n",
    "mock/src/expect.rs": "pub fn span() {}\n",
    "two/Cargo.toml": `[package]\nname = "two"\n`,
    "two/src/lib.rs": "pub mod expect;\n",
    "two/src/expect.rs": "pub fn span() {}\n",
    "app/Cargo.toml": `[package]\nname = "app"\n[dev-dependencies]\ntracing-mock = { path = "../mock" }\ntwo = { path = "../two" }\n`,
    "app/src/lib.rs": "",
    "app/tests/t.rs": `use tracing_mock::*;
#[test]
fn globbed() { subscriber::mock(); layer::mock(); }
mod inner {
    use two::*;
    use tracing_mock::*;
    #[test]
    fn both() { expect::span(); }
}
mod named {
    use tracing_mock::*;
    use two::expect;
    #[test]
    fn by_use() { expect::span(); }
}
`,
  });
  assert.deepEqual(calls(graph, "app/tests/t.rs#globbed"), ["mock/src/layer.rs#mock", "mock/src/subscriber.rs#mock"]);
  assert.deepEqual(calls(graph, "app/tests/t.rs#both"), [], "2 globs reach a `span`, so neither is chosen");
  assert.deepEqual(calls(graph, "app/tests/t.rs#by_use"), ["two/src/expect.rs#span"], "a `use` naming the module beats a glob");
});

test("Rust: under `use super::*`, a module path reads through the `use` lines of the file that declares the module", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[workspace]\nmembers = ["mock", "two", "app"]\n`,
    "mock/Cargo.toml": `[package]\nname = "tracing-mock"\n`,
    "mock/src/lib.rs": "pub mod expect;\npub mod layer;\n",
    "mock/src/expect.rs": "pub fn event() {}\n",
    "mock/src/layer.rs": "pub fn mock() {}\n",
    "two/Cargo.toml": `[package]\nname = "two"\n`,
    "two/src/lib.rs": "pub mod expect;\npub mod layer;\n",
    "two/src/expect.rs": "pub fn event() {}\n",
    "two/src/layer.rs": "pub fn mock() {}\n",
    "app/Cargo.toml": `[package]\nname = "app"\n[dependencies]\ntracing-mock = { path = "../mock" }\ntwo = { path = "../two" }\n`,
    "app/src/lib.rs": "mod outer;\n",
    "app/src/outer.rs": "use tracing_mock::layer;\nmod inner;\n",
    "app/src/outer/inner.rs": "use super::*;\npub fn go() { layer::mock(); }\n",
    // tracing's tests/layer_filters: main.rs declares `mod option;` and imports `expect`.
    "app/tests/filters/main.rs": "mod option;\nmod own;\nuse tracing_mock::{expect, layer};\n",
    "app/tests/filters/option.rs": `use super::*;
#[test]
fn option_none() { expect::event(); layer::mock(); }
mod nested {
    use super::*;
    fn deeper() { expect::event(); }
}
`,
    "app/tests/filters/own.rs": "use super::*;\nuse two::expect;\nfn by_use() { expect::event(); }\n",
    // 2 test crates declare `mod common;` and import `expect` from different crates.
    "app/tests/a.rs": "mod common;\nuse tracing_mock::expect;\n",
    "app/tests/b.rs": "mod common;\nuse two::expect;\n",
    "app/tests/common.rs": "use super::*;\npub fn shared() { expect::event(); }\n",
  });
  assert.deepEqual(calls(graph, "app/tests/filters/option.rs#option_none"), ["mock/src/expect.rs#event", "mock/src/layer.rs#mock"]);
  assert.deepEqual(calls(graph, "app/tests/filters/option.rs#deeper"), ["mock/src/expect.rs#event"], "an inline module that globs `super` sees the file's glob");
  assert.deepEqual(calls(graph, "app/src/outer/inner.rs#go"), ["mock/src/layer.rs#mock"], "a module file below a non-mod.rs parent");
  assert.deepEqual(calls(graph, "app/tests/filters/own.rs#by_use"), ["two/src/expect.rs#event"], "the file's own `use` beats the parent's");
  assert.deepEqual(calls(graph, "app/tests/common.rs#shared"), [], "2 parents bind `expect` to 2 crates, so neither is chosen");
  assert.deepEqual(stated(graph, "app/tests/common.rs#shared"), [["event", "expect::event"]]);
});

test("Rust: under `use super::*`, only a file whose own modules sit beside it is a parent, and every binding must agree", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[workspace]\nmembers = ["mock", "two", "app"]\n`,
    "mock/Cargo.toml": `[package]\nname = "tracing-mock"\n`,
    "mock/src/lib.rs": "pub mod expect;\n",
    "mock/src/expect.rs": "pub fn event() {}\n",
    "two/Cargo.toml": `[package]\nname = "two"\n`,
    "two/src/lib.rs": "pub mod expect;\n",
    "two/src/expect.rs": "pub fn event() {}\n",
    "app/Cargo.toml": `[package]\nname = "app"\n[dependencies]\ntracing-mock = { path = "../mock" }\ntwo = { path = "../two" }\n`,
    "app/src/lib.rs": "",
    // inner.rs is main.rs's module, so its `mod option;` is tests/nest/inner/option.rs.
    "app/tests/nest/main.rs": "mod option;\nmod inner;\nuse tracing_mock::expect;\n",
    "app/tests/nest/inner.rs": "mod option;\nuse two::expect;\n",
    "app/tests/nest/option.rs": "use super::*;\nfn from_main() { expect::event(); }\n",
    // A root no rule names (a custom target): its module lib.rs is no parent of option.rs either.
    "app/src/fixtures/root.rs": "mod option;\nmod lib;\nuse tracing_mock::expect;\n",
    "app/src/fixtures/lib.rs": "mod option;\nuse two::expect;\n",
    "app/src/fixtures/option.rs": "use super::*;\nfn custom() { expect::event(); }\n",
    // `cfg` arms bind `expect` to 2 crates; the build picks one, the graph cannot.
    "app/tests/cfg/main.rs": `mod option;\n#[cfg(feature = "a")]\nuse tracing_mock::expect;\n#[cfg(not(feature = "a"))]\nuse two::expect;\n`,
    "app/tests/cfg/option.rs": "use super::*;\nfn either() { expect::event(); }\n",
    // The parent's own module file, outside `src`.
    "app/tests/own/main.rs": "mod option;\nmod helpers;\n",
    "app/tests/own/helpers.rs": "pub fn event() {}\n",
    "app/tests/own/option.rs": "use super::*;\nfn local() { helpers::event(); }\n",
  });
  assert.deepEqual(calls(graph, "app/tests/nest/option.rs#from_main"), ["mock/src/expect.rs#event"], "inner.rs is not a parent");
  assert.deepEqual(calls(graph, "app/src/fixtures/option.rs#custom"), [], "a module of an unnamed root is not a parent");
  assert.deepEqual(calls(graph, "app/tests/cfg/option.rs#either"), [], "2 bindings disagree");
  assert.deepEqual(calls(graph, "app/tests/own/option.rs#local"), ["app/tests/own/helpers.rs#event"], "the parent's own module");
});

test("Rust: under `use super::*`, a top-level test file stays a root, a parent's modules must be declared, and module files are followed down", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[workspace]\nmembers = ["mock", "two", "app"]\n`,
    "mock/Cargo.toml": `[package]\nname = "tracing-mock"\n`,
    "mock/src/lib.rs": "pub mod expect;\n",
    "mock/src/expect.rs": "pub fn event() {}\n",
    "two/Cargo.toml": `[package]\nname = "two"\n`,
    "two/src/lib.rs": "pub mod expect;\n",
    "two/src/expect.rs": "pub fn event() {}\n",
    "app/Cargo.toml": `[package]\nname = "app"\n[dependencies]\ntracing-mock = { path = "../mock" }\ntwo = { path = "../two" }\n`,
    // tests/foo.rs is a test crate whose `mod option;` is tests/option.rs, though bar.rs also
    // declares it as a module, whose `mod option;` is tests/foo/option.rs.
    "app/tests/foo.rs": "mod option;\nuse tracing_mock::expect;\n",
    "app/tests/bar.rs": "mod foo;\n",
    "app/tests/option.rs": "use super::*;\nfn top() { expect::event(); }\n",
    "app/tests/foo/option.rs": "use super::*;\nfn below() { expect::event(); }\n",
    // lib.rs never declares `mod orphan;`, so `orphan` is no module of it.
    "app/src/lib.rs": "mod child;\n",
    "app/src/child.rs": "use super::*;\nfn stray() { orphan::event(); }\n",
    "app/src/orphan.rs": "pub fn event() {}\n",
    // A module of the parent's own module file.
    "app/tests/deep/main.rs": "mod option;\nmod helpers;\n",
    "app/tests/deep/helpers.rs": "pub(crate) mod nested;\n",
    "app/tests/deep/helpers/nested.rs": "pub fn event() {}\n",
    "app/tests/deep/option.rs": "use super::*;\nfn deep() { helpers::nested::event(); }\n",
  });
  assert.deepEqual(calls(graph, "app/tests/option.rs#top"), ["mock/src/expect.rs#event"], "a top-level test file is a crate root");
  assert.deepEqual(calls(graph, "app/tests/foo/option.rs#below"), ["mock/src/expect.rs#event"]);
  assert.deepEqual(calls(graph, "app/src/child.rs#stray"), [], "an undeclared module file");
  assert.deepEqual(calls(graph, "app/tests/deep/option.rs#deep"), ["app/tests/deep/helpers/nested.rs#event"]);
});

test("Rust: under `use super::*`, a test file is a root only when Cargo builds it as a target", async (t) => {
  const files = (crate: string, manifest: string) => ({
    [`${crate}/Cargo.toml`]: `[package]\nname = "${crate}"\n${manifest}[dependencies]\ntracing-mock = { path = "../mock" }\n`,
    [`${crate}/tests/foo.rs`]: "mod option;\nuse tracing_mock::expect;\n",
    [`${crate}/tests/bar.rs`]: "mod foo;\n",
    [`${crate}/tests/option.rs`]: "use super::*;\nfn top() { expect::event(); }\n",
    [`${crate}/tests/foo/option.rs`]: "use super::*;\nfn below() { expect::event(); }\n",
  });
  const graph = await build(t, {
    "Cargo.toml": `[workspace]\nmembers = ["mock", "only_bar", "only_foo"]\n`,
    "mock/Cargo.toml": `[package]\nname = "tracing-mock"\n`,
    "mock/src/lib.rs": "pub mod expect;\n",
    "mock/src/expect.rs": "pub fn event() {}\n",
    // With `autotests = false` only the listed targets are crates: foo.rs is bar.rs's module.
    // A `path` outside a target table names no target.
    ...files("only_bar", `autotests = false\n\n[[test]]\nname = "bar"\n\n[package.metadata.x]\npath = "tests/foo.rs"\n`),
    // A target named by its path is a crate, whatever its file is called.
    ...files("only_foo", `autotests = false\n\n[[test]]\nname = "it"\npath = "tests/foo.rs"\n`),
  });
  assert.deepEqual(calls(graph, "only_bar/tests/option.rs#top"), [], "foo.rs is no target, so tests/option.rs is no module of it");
  assert.deepEqual(calls(graph, "only_bar/tests/foo/option.rs#below"), ["mock/src/expect.rs#event"]);
  assert.deepEqual(calls(graph, "only_foo/tests/option.rs#top"), ["mock/src/expect.rs#event"], "the listed path is a crate root");
});

test("Rust: under `use super::*`, a module file's function is reached only when the caller can see it", async (t) => {
  const tree = (dir: string, mod: string, fn: string) => ({
    [`app/tests/${dir}/main.rs`]: "mod option;\nmod helpers;\n",
    [`app/tests/${dir}/helpers.rs`]: `${mod} nested;\n${fn} own() {}\n`,
    [`app/tests/${dir}/helpers/nested.rs`]: `${fn} event() {}\n`,
    [`app/tests/${dir}/option.rs`]: "use super::*;\nfn deep() { helpers::nested::event(); }\nfn near() { helpers::own(); }\n",
  });
  const graph = await build(t, {
    "app/Cargo.toml": `[package]\nname = "app"\n`,
    ...tree("open", "pub(crate) mod", "pub fn"),
    ...tree("private_fn", "pub mod", "fn"),
    ...tree("private_mod", "mod", "pub fn"),
  });
  assert.deepEqual(calls(graph, "app/tests/open/option.rs#deep"), ["app/tests/open/helpers/nested.rs#event"]);
  assert.deepEqual(calls(graph, "app/tests/open/option.rs#near"), ["app/tests/open/helpers.rs#own"]);
  assert.deepEqual(calls(graph, "app/tests/private_fn/option.rs#deep"), [], "a private fn is not visible beside its module");
  assert.deepEqual(calls(graph, "app/tests/private_fn/option.rs#near"), [], "a private fn is not visible beside its module");
  assert.deepEqual(calls(graph, "app/tests/private_mod/option.rs#deep"), [], "a private module is not visible beside its parent");
});

test("Rust: a repeated name no path settles is stated, and a dependency's stays silent", async (t) => {
  const graph = await build(t, {
    ...tracingLike,
    "sub/Cargo.toml": `[package]\nname = "sub"\n[dependencies]\noutside = "1"\n`,
    "sub/src/a.rs": "pub fn bare() { with_default(); }\n",
    "sub/src/lib.rs": "pub mod a;\n",
    "sub/src/ext.rs": `use outside::with_default;\npub fn out() { with_default(); }\n`,
  });
  assert.deepEqual(calls(graph, "sub/src/a.rs#bare"), []);
  assert.deepEqual(stated(graph, "sub/src/a.rs#bare"), [["with_default", "2 definitions of that name"]]);
  assert.deepEqual(stated(graph, "sub/src/ext.rs#out"), []);
});

test("Rust: a method's receiver reads from `self`, a binding, a parameter or a field, past a repeated name", async (t) => {
  const graph = await build(t, {
    "src/types.rs": `pub struct One { pub two: Two, pub boxed: Box<Two>, pub list: Vec<u8> }
impl One { pub fn go(&self) {} pub fn new() -> Self { One { two: Two, boxed: Box::new(Two), list: vec![] } } pub fn own(&self) { self.go(); self.two.go(); self.boxed.go(); self.list.push(1); } }
pub struct Two;
impl Two { pub fn go(&self) {} pub fn push(&self, _: u8) {} }
`,
    "src/use_it.rs": `use crate::types::{One, Two};
pub fn annotated() { let x: Two = make(); x.go(); }
pub fn built() { let x = One::new(); x.go(); }
pub fn literal() { let x = Two {}; x.go(); }
pub fn param(x: &mut Two) { x.go(); }
pub fn chained() { One::new().go(); }
pub fn shadowed(x: One) { let x = make(); x.go(); }
pub fn std_value() { let v = Vec::new(); v.push(1); }
pub fn in_loop(x: One) { for x in items() { x.go(); } }
`,
  });
  const one = "src/types.rs#go";
  const two = "src/types.rs#go~2";
  assert.deepEqual(calls(graph, "src/types.rs#own"), [one, two].sort(), "self, and fields; a Vec's push is not Two's");
  assert.deepEqual(calls(graph, "src/use_it.rs#annotated"), [two]);
  assert.deepEqual(calls(graph, "src/use_it.rs#built"), [one, "src/types.rs#new"]);
  assert.deepEqual(calls(graph, "src/use_it.rs#literal"), [two]);
  assert.deepEqual(calls(graph, "src/use_it.rs#param"), [two]);
  assert.deepEqual(calls(graph, "src/use_it.rs#chained"), [one, "src/types.rs#new"]);
  assert.deepEqual(calls(graph, "src/use_it.rs#shadowed"), [], "a shadow with no type is not the parameter");
  assert.deepEqual(calls(graph, "src/use_it.rs#std_value"), [], "not the repo's push");
  assert.deepEqual(calls(graph, "src/use_it.rs#in_loop"), [], "a loop variable is not the parameter");
});

test("Rust: a receiver reads through the signatures of the calls that made it, and stops where they stop", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[package]\nname = "app"\n`,
    "src/lib.rs": "pub mod mock;\npub mod t;\n",
    "src/mock.rs": `pub struct Mock;
impl Mock { pub fn enter(self) -> Self { self } pub fn run(self) -> Handle { Handle } pub fn opaque(self) -> u8 { 0 } }
pub struct Handle;
impl Handle { pub fn run(&self) {} pub fn finish(&self) -> Result<Other, String> { Ok(Other) } }
pub struct Other;
impl Other { pub fn run(&self) {} }
pub trait Lone { fn only(&self); }
pub fn mock() -> Mock { Mock }
`,
    "src/t.rs": `use crate::mock::mock;
pub fn chain() { mock().enter().run().run(); }
pub fn bound() { let h = mock().enter().run(); h.run(); }
pub fn through_try() -> Result<(), String> { let o = mock().run().finish()?; o.run(); Ok(()) }
pub fn stops() { mock().opaque().run(); }
pub fn generic<C: crate::mock::Lone>(c: C) { c.only(); }
`,
  });
  const has = (source: string, needle: string) => calls(graph, source).filter((x) => x.includes(needle));
  assert.equal(has("src/t.rs#chain", "#run").length, 2, "Mock's run, then Handle's");
  assert.deepEqual(has("src/t.rs#bound", "#run").sort(), ["src/mock.rs#run", "src/mock.rs#run~2"]);
  assert.equal(has("src/t.rs#through_try", "#run").length, 2, "Mock's run, then Other's");
  assert.deepEqual(has("src/t.rs#stops", "#run"), [], "a u8 has no run of the repo's");
  assert.deepEqual(has("src/t.rs#generic", "#only"), ["src/mock.rs#only"], "a generic parameter falls back on the name");
});

test("Rust: only a binding pattern shadows a local, not a condition naming it", async (t) => {
  const graph = await build(t, {
    "src/lib.rs": `pub struct Foo;
impl Foo { pub fn go(&self) {} pub fn ready(&self) -> bool { true } }
pub struct Bar;
impl Bar { pub fn go(&self) {} }
pub fn cond(x: Foo) { if x.ready() { x.go(); } }
pub fn loops(x: Foo) { while x.ready() { x.go(); } }
pub fn matched(x: Foo, b: bool) { match b { true => x.go(), _ => {} } }
pub fn shadow(x: Foo, o: Option<Bar>) { if let Some(x) = o { x.go(); } }
pub fn chain(x: Foo, o: Option<Bar>) { while let Some(x) = o { x.go(); } }
`,
  });
  const go = "src/lib.rs#go";
  assert.ok(calls(graph, "src/lib.rs#cond").includes(go), "a condition binds nothing");
  assert.ok(calls(graph, "src/lib.rs#loops").includes(go), "nor a loop's");
  assert.deepEqual(calls(graph, "src/lib.rs#matched"), [go]);
  assert.deepEqual(calls(graph, "src/lib.rs#shadow"), [], "`if let` rebinds it");
  assert.deepEqual(calls(graph, "src/lib.rs#chain"), [], "`while let` rebinds it");
});

test("Rust: an Option or Result is its inner type only once it is unwrapped", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[package]\nname = "app"\n`,
    "src/lib.rs": `pub struct Foo;
impl Foo { pub fn f(&self) {} pub fn me() -> Result<Self, String> { Ok(Foo) } }
pub struct Bar;
impl Bar { pub fn f(&self) {} }
pub fn make() -> Option<Foo> { None }
pub fn wrapped() { let x = make(); x.f(); }
pub fn tried() -> Option<u8> { let x = make()?; x.f(); None }
pub fn unwrapped() { make().unwrap().f(); }
pub fn expected() { let x = Foo::me().expect("no"); x.f(); }
pub fn boxed(x: Box<Foo>) { x.f(); }
`,
  });
  const f = "src/lib.rs#f";
  assert.deepEqual(calls(graph, "src/lib.rs#wrapped"), ["src/lib.rs#make"], "an Option has no f of Foo's");
  assert.ok(calls(graph, "src/lib.rs#tried").includes(f));
  assert.ok(calls(graph, "src/lib.rs#unwrapped").includes(f));
  assert.ok(calls(graph, "src/lib.rs#expected").includes(f));
  assert.deepEqual(calls(graph, "src/lib.rs#boxed"), [f], "a Box derefs by itself");
});

test("Rust: a call in a `macro_rules` arm is a template's, so inferred and never definite", async (t) => {
  const graph = await build(t, {
    "src/lib.rs": `pub fn helper() {}
macro_rules! m { () => { helper() } }
pub fn real() { helper(); }
`,
  });
  const found = graph.edges.filter((e) => e.relation === "calls" && e.target === "src/lib.rs#helper");
  assert.deepEqual(found.map((e) => [e.source, e.confidence]).sort(), [["src/lib.rs#m", "inferred"], ["src/lib.rs#real", "extracted"]]);
});

test("Rust: `Self::f` in a trait impl's own `f` reaches the inherent method, or itself, or is said", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[package]\nname = "app"\n[dependencies]\ndep = "1"\n`,
    "src/lib.rs": `pub trait Tr { fn go(&self); fn run(&self, n: u8); }
pub struct Foo;
impl Foo { pub fn go(&self) {} }
impl Tr for Foo {
  fn go(&self) { Self::go(self) }
  fn run(&self, n: u8) { Self::run(self, n) }
}
pub trait Sel { fn accept(&self); }
impl Sel for dep::Thing { fn accept(&self) { Self::accept(self) } }
`,
  });
  const inherent = "src/lib.rs#go~2";
  const own = graph.nodes.filter((n) => n.name === "go" && n.owner === "Foo").map((n) => n.id).find((id) => id !== inherent)!;
  assert.deepEqual(calls(graph, own), [inherent], "the inherent method wins");
  const run = graph.nodes.filter((n) => n.name === "run" && n.owner === "Foo").map((n) => n.id)[0]!;
  assert.deepEqual(calls(graph, run), [run], "with no inherent method it is plain recursion");
  const accept = graph.nodes.filter((n) => n.name === "accept" && n.owner === "Thing").map((n) => n.id)[0]!;
  assert.deepEqual(calls(graph, accept), [], "a dependency's type may hold its own");
  assert.deepEqual(stated(graph, accept), [["accept", "Thing"]]);
});

test("Rust: an alias in one module does not redirect a sibling's type of that name", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[package]\nname = "app"\n`,
    "src/lib.rs": `pub mod a {
  pub struct Foo;
  impl Foo { pub fn f(&self) {} }
  pub type Alias = Foo;
  pub fn here(x: Alias) { x.f(); }
}
pub mod b {
  pub struct Alias;
  impl Alias { pub fn f(&self) {} }
  pub fn there(x: Alias) { x.f(); }
}
pub mod c {
  use crate::a::Alias;
  pub fn brought(x: Alias) { x.f(); }
}
`,
  });
  assert.deepEqual(calls(graph, "src/lib.rs#here"), ["src/lib.rs#f"]);
  assert.deepEqual(calls(graph, "src/lib.rs#there"), ["src/lib.rs#f~2"], "its own Alias, not a's");
});

test("Rust: a repo trait in scope provides a method on a std or dependency receiver, one trait only", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[package]\nname = "app"\n[dependencies]\ndep = "1"\n`,
    "src/lib.rs": `pub mod hidden;
pub trait Ext { fn ext_call(&self) -> usize; }
impl<T> Ext for [T] { fn ext_call(&self) -> usize { 0 } }
pub fn param(v: &Vec<i32>) -> usize { v.ext_call() }
pub fn local() -> usize { let v = Vec::<i32>::new(); v.ext_call() }
pub struct Holder { items: Vec<i32> }
impl Holder { pub fn field(&self) -> usize { self.items.ext_call() } }
pub fn outside(v: dep::Thing) -> usize { v.ext_call() }
pub fn not_in_scope(v: &Vec<i32>) { v.tucked(); }
pub fn plain(v: &mut Vec<i32>) { v.push(1); }
pub trait One { fn twice(&self); }
pub trait Two { fn twice(&self); }
pub fn both(v: &Vec<i32>) { v.twice(); }
pub fn push_owner() { Other.push(); }
pub struct Other;
impl Other { pub fn push(&self) {} }
`,
    "src/hidden.rs": "pub trait Tucked { fn tucked(&self); }\n",
  });
  for (const f of ["param", "local"]) assert.deepEqual(calls(graph, `src/lib.rs#${f}`), ["src/lib.rs#ext_call"], f);
  assert.deepEqual(calls(graph, "src/lib.rs#outside"), [], "no impl for that type");
  assert.deepEqual(stated(graph, "src/lib.rs#outside"), [["ext_call", "Thing"]]);
  assert.deepEqual(calls(graph, "src/lib.rs#field"), ["src/lib.rs#ext_call"]);
  assert.deepEqual(calls(graph, "src/lib.rs#not_in_scope"), [], "a trait no `use` brings in provides nothing");
  assert.deepEqual(calls(graph, "src/lib.rs#plain"), [], "no trait provides it: the std type's own");
  assert.deepEqual(calls(graph, "src/lib.rs#both"), []);
  assert.deepEqual(stated(graph, "src/lib.rs#both"), [["twice", "Vec"]]);
});

test("Rust: a receiver whose type is known never falls back on another type's method", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[package]\nname = "app"\n[dependencies]\ndep = "1"\n`,
    "src/lib.rs": `use dep::A;
pub struct B;
impl B { pub fn f(&self) {} }
pub struct Cart;
pub fn used(x: A) { x.f(); }
pub fn pathed(x: dep::A) { x.f(); }
pub fn own(x: Cart) { x.f(); }
pub fn built() { let x = dep::A::new(); x.f(); }
`,
  });
  for (const f of ["used", "pathed", "built"]) assert.deepEqual(calls(graph, `src/lib.rs#${f}`), [], f);
  assert.deepEqual(calls(graph, "src/lib.rs#own"), []);
  assert.deepEqual(stated(graph, "src/lib.rs#own"), [["f", "Cart"]], "the repo's own type lacks it: said, not bound");
});

test("W3: a package's name counts only through what its manifest reaches, and otherwise is said", async (t) => {
  const entry = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { ".": "./src/index.ts" } }),
    "packages/core/src/index.ts": "export function other() {}\n",
    "packages/core/src/inner.ts": "export function run() {}\n",
    "apps/a.ts": `import { run } from "@acme/core";\nexport function go() { run(); }\n`,
  });
  assert.deepEqual(calls(entry, "apps/a.ts#go"), [], "the entry does not export it; another file doing so proves nothing");
  assert.deepEqual(stated(entry, "apps/a.ts#go"), [["run", "@acme/core"]]);
  const reached = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { ".": "./src/index.ts" } }),
    "packages/core/src/index.ts": `export * from "./inner";\n`,
    "packages/core/src/inner.ts": "export function run() {}\n",
    "apps/a.ts": `import { run } from "@acme/core";\nexport function go() { run(); }\n`,
  });
  assert.deepEqual(calls(reached, "apps/a.ts#go"), ["packages/core/src/inner.ts#run"]);
});

test("Rust: a std type's own method beats a repo trait of that name, and `vec!` is a Vec", async (t) => {
  const graph = await build(t, {
    "src/lib.rs": `pub trait Stack { fn push(&mut self, n: u8); fn pile(&self); }
impl<T> Stack for [T] { fn push(&mut self, _: u8) {} fn pile(&self) {} }
pub fn own(v: &mut Vec<u8>) { v.push(1); }
pub fn through_macro() { let v = vec![1, 2]; v.pile(); }
`,
  });
  assert.deepEqual(calls(graph, "src/lib.rs#own"), [], "Vec's own push");
  assert.deepEqual(calls(graph, "src/lib.rs#through_macro"), ["src/lib.rs#pile"]);
});

test("Rust: a repo trait reaches a std or dependency receiver only through a blanket impl or one for that type", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[package]\nname = "app"\n[dependencies]\ndep = "1"\n`,
    "src/lib.rs": `pub mod far;
use dep::Thing;
pub struct Mine;
pub trait Blanket { fn wide(&self); }
impl<L> Blanket for L where L: Sized { fn wide(&self) {} }
pub trait ForMine { fn narrow(&self); }
impl ForMine for Mine { fn narrow(&self) {} }
pub trait ForThing { fn exact(&self); }
impl ForThing for dep::Thing { fn exact(&self) {} }
pub trait NoImpl { fn nothing(&self); }
pub fn std_blanket(v: &Vec<u8>) { v.wide(); }
pub fn dep_blanket(x: Thing) { x.wide(); }
pub fn std_other(v: &Vec<u8>) { v.narrow(); }
pub fn dep_other(x: Thing) { x.narrow(); }
pub fn no_impl(v: &Vec<u8>) { v.nothing(); }
pub fn std_far(v: &Vec<u8>) { v.reach(); }
`,
    "src/far.rs": "pub trait Far { fn reach(&self); }\nimpl<T> Far for T { fn reach(&self) {} }\n",
  });
  const wide = graph.nodes.find((n) => n.name === "wide" && n.owner === "Blanket")!.id;
  assert.deepEqual(calls(graph, "src/lib.rs#std_blanket"), [wide]);
  assert.deepEqual(calls(graph, "src/lib.rs#dep_blanket"), [wide]);
  for (const [f, name, through] of [["std_other", "narrow", "Vec"], ["dep_other", "narrow", "Thing"], ["no_impl", "nothing", "Vec"], ["std_far", "reach", "Vec"]] as const) {
    assert.deepEqual(calls(graph, `src/lib.rs#${f}`), [], f);
    assert.deepEqual(stated(graph, `src/lib.rs#${f}`), [[name, through]], f);
  }
});

test("`callers` marks an inferred edge, in plain and JSON output, and no other", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "self-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/lib.rs"), "pub fn helper() {}\nmacro_rules! m { () => { helper() } }\npub fn real() { helper(); }\n");
  await buildGraph(root);
  const capture = (json: boolean) => {
    const [log, write] = [console.log, process.stdout.write];
    let text = "";
    console.log = (x: string) => { text += x; };
    process.stdout.write = ((x: string) => { text += x; return true; }) as typeof process.stdout.write;
    try {
      traverse.runCallersCommand("helper", root, { json });
    } finally {
      console.log = log;
      process.stdout.write = write;
    }
    return text;
  };
  const lines = capture(false).split("\n");
  assert.match(lines.find((l) => l.includes("← m "))!, /\[inferred\]$/);
  assert.doesNotMatch(lines.find((l) => l.includes("← real "))!, /inferred/);
  const hits = JSON.parse(capture(true)).matches[0].hits as { name: string; inferred?: boolean }[];
  assert.equal(hits.find((h) => h.name === "m")!.inferred, true);
  assert.equal(hits.find((h) => h.name === "real")!.inferred, undefined);
  const deep = traverse.hitLine("in", { node: null, id: "x", relation: "calls", depth: 2, inferred: true }, true);
  assert.match(deep, /\[inferred\]/);
});

test("W3: a package with no entry to ask binds its one exporting definition as inferred; a folder with no manifest is said", async (t) => {
  const importer = `import { run } from "@acme/core";\nexport function go() { run(); }\n`;
  const root = { "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }), "apps/a.ts": importer };
  for (const manifest of [{ name: "@acme/core" }, { name: "@acme/core", main: "dist/index.js" }, { name: "@acme/core", exports: { "./x": "./dist/x.js" } }]) {
    const one = await build(t, { ...root, "packages/core/package.json": JSON.stringify(manifest), "packages/core/lib/inner.ts": "export function run() {}\n" });
    assert.deepEqual(edge(one, "apps/a.ts#go"), [["packages/core/lib/inner.ts#run", "inferred"]], JSON.stringify(manifest));
    assert.deepEqual(stated(one, "apps/a.ts#go"), []);
    const two = await build(t, { ...root, "packages/core/package.json": JSON.stringify(manifest), "packages/core/lib/inner.ts": "export function run() {}\n", "packages/core/lib/also.ts": "export function run() {}\n" });
    assert.deepEqual(calls(two, "apps/a.ts#go"), [], "2 definitions are no answer");
    assert.deepEqual(stated(two, "apps/a.ts#go"), [["run", "@acme/core"]]);
  }
  const bare = await build(t, { ...root, "packages/core/lib/inner.ts": "export function run() {}\n" });
  assert.deepEqual(calls(bare, "apps/a.ts#go"), []);
  assert.deepEqual(stated(bare, "apps/a.ts#go"), [["run", "@acme/core"]], "no package.json is said, not silent");
  const external = await build(t, { ...root, "packages/other/lib/inner.ts": "export function run() {}\n" });
  assert.deepEqual(stated(external, "apps/a.ts#go"), [], "a name no folder holds stays outside");
});

test("W3: an entry exporting a name it cannot be followed through still binds the package's one definition, as inferred", async (t) => {
  const graph = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { ".": { dev: "./src/index.ts" } } }),
    "packages/core/src/index.ts": `import * as D from "./d";\nexport const run = process.env.X ? () => null : D.run;\n`,
    "packages/core/src/d.ts": "export function run() {}\n",
    "apps/a.ts": `import { run } from "@acme/core";\nexport function go() { run(); }\n`,
  });
  assert.deepEqual(edge(graph, "apps/a.ts#go"), [["packages/core/src/d.ts#run", "inferred"]]);
});

test("Rust: an impl for a tuple, a function or any other unnamed type keeps its file", async (t) => {
  const graph = await build(t, {
    "src/lib.rs": `pub trait Tr { fn go(&self); }
impl<T> Tr for (Vec<T>, T) { fn go(&self) {} }
impl<R> Tr for fn(&mut u8) -> R { fn go(&self) {} }
impl<'a, const N: usize, T: Sized + 'a> Tr for [T; N] { fn go(&self) {} }
pub fn kept() {}
`,
  });
  assert.ok(graph.nodes.some((n) => n.id === "src/lib.rs#kept"), "the file's symbols survive");
});

test("a file whose extraction throws is reported with its reason and not counted as parsed, in every tier", async (t) => {
  const deep = 150_000;
  const files: Record<string, string> = {
    "ok.ts": "export function fine() {}\n",
    "deep.ts": `export const x = ${"[".repeat(deep)}${"]".repeat(deep)};\n`,
    "deep.py": `x = ${"[".repeat(deep)}${"]".repeat(deep)}\n`,
    "deep.rs": `pub fn x() { ${"(".repeat(deep)}1${")".repeat(deep)}; }\n`,
    "deep.go": `package a\nvar x = ${"(".repeat(deep)}1${")".repeat(deep)}\n`,
    "deep.vue": `<script>\nexport const x = ${"[".repeat(deep)}${"]".repeat(deep)};\n</script>\n`,
  };
  const root = mkdtempSync(join(tmpdir(), "self-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  const result = await buildGraph(root);
  const thrown = result.errors.filter((e) => e.includes("parse failed"));
  assert.ok(thrown.length >= 1, `something must throw for this to test anything: ${result.errors.join("; ")}`);
  for (const e of thrown) assert.match(e, /^deep\.\w+: parse failed — ./, "the file and the reason");
  assert.equal(result.failed, thrown.length);
  assert.equal(result.parsed + result.failed + result.reused, result.files);
});
