import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { posix } from "node:path";
import { resolveEdges } from "../src/graph/resolve.js";
import type { RawEdge } from "../src/graph/extract.js";
import type { EdgeV1, NodeV1, UnresolvedCallV1 } from "../src/graph/types.js";

// Graph paths and IDs use POSIX separators on every platform.
function n(path: string, kind: NodeV1["kind"] = "file", symbol?: string, props: Partial<NodeV1> = {}): NodeV1 {
  return {
    id: symbol ? `${path}#${symbol}` : path,
    name: symbol?.split(".").at(-1)?.replace(/~\d+$/, "") ?? posix.basename(path),
    path, kind, span: "L1-L1", signature: null, exported: true, origin: "ast",
    body_hash: "h", summary_state: "pending", summary: null, crux: null, ...props,
  } as NodeV1;
}

function raw(source: NodeV1, relation: RawEdge["relation"], fields: Partial<RawEdge>): RawEdge {
  return { source: source.id, file: source.path, relation, ...fields };
}

function call(source: NodeV1, name: string, fields: Partial<RawEdge> = {}): RawEdge {
  return raw(source, "calls", { name, ...fields });
}

// Metadata-only records have no containment target of their own.
function meta(source: NodeV1, fields: Partial<RawEdge>): RawEdge {
  return raw(source, "contains", fields);
}

function edge(
  source: NodeV1, target: NodeV1 | string,
  confidence: EdgeV1["confidence"] = "inferred", relation: EdgeV1["relation"] = "calls",
): EdgeV1 {
  return { source: source.id, target: typeof target === "string" ? target : target.id, relation, confidence };
}

describe("language and structural resolution", () => {
  test("container scripts and generic JVM files use their language families", () => {
    const view = n("View.vue", "function", "mount");
    const button = n("Button.tsx", "function", "renderButton");
    const pyButton = n("buttons.py", "function", "renderButton");
    const build = n("build.gradle", "function", "configure", { origin: "generic" });
    const register = n("Tasks.kt", "method", "Tasks.register");
    const pyRegister = n("tasks.py", "method", "Tasks.register");

    assert.deepEqual(resolveEdges([view, button, pyButton, build, register, pyRegister], [
      call(view, "renderButton"), call(build, "register"),
    ]), [edge(view, button), edge(build, register)]);
  });

  test("a missing language does not filter either end of a cross-file call", () => {
    const script = n("entry.zzz", "function", "start");
    const helper = n("helpers.ts", "function", "load");
    const hook = n("hooks.zzz", "function", "onLoad");
    assert.deepEqual(resolveEdges([script, helper, hook], [
      call(script, "load"), call(helper, "onLoad"),
    ]), [edge(script, helper), edge(helper, hook)]);
  });

  test("C includes prefer a relative header, then a unique suffix, and preserve ambiguous names", () => {
    const main = n(posix.join("app", "main.cpp"));
    const local = n(posix.join("app", "config.h"));
    const other = n(posix.join("vendor", "config.h"));
    const wire = n(posix.join("include", "net", "wire.hpp"));
    const debugA = n(posix.join("vendor", "a", "debug.h"));
    const debugB = n(posix.join("vendor", "b", "debug.h"));
    assert.deepEqual(resolveEdges([main, local, other, wire, debugA, debugB], [
      raw(main, "imports", { specifier: "config.h" }),
      raw(main, "imports", { specifier: posix.join("net", "wire.hpp") }),
      raw(main, "imports", { specifier: "debug.h" }),
    ]), [
      edge(main, local, "extracted", "imports"),
      edge(main, wire, "extracted", "imports"),
      edge(main, "debug.h", "extracted", "imports"),
    ]);
  });

  test("Java resolves static imports, constructors, and only genuine annotation declarations", () => {
    const main = n("Main.java");
    const run = n(main.path, "method", "Main.run");
    const mainClass = n(main.path, "class", "Main");
    const report = n(main.path, "class", "Report");
    const audit = n(main.path, "interface", "Audit", { signature: "@Documented @interface Audit" });
    const service = n(main.path, "interface", "Service", { signature: "interface Service" });
    const numbers = n(posix.join("src", "main", "java", "demo", "tools", "Numbers.java"));

    assert.deepEqual(resolveEdges([main, run, mainClass, report, audit, service, numbers], [
      raw(main, "imports", { specifier: "demo.tools.Numbers.sum" }),
      raw(main, "imports", { specifier: "java.util.*" }),
      raw(mainClass, "extends", { name: "ExternalRunner" }),
      call(run, "Report"),
      raw(report, "references", { name: "Audit" }),
      raw(report, "references", { name: "Service" }),
      raw(report, "references", { name: "Entity" }),
    ]), [
      edge(main, numbers, "extracted", "imports"),
      edge(main, "java.util.*", "extracted", "imports"),
      edge(mainClass, "ExternalRunner", "inferred", "extends"),
      edge(run, report, "extracted"),
      edge(report, audit, "extracted", "references"),
      edge(report, "Service", "inferred", "references"),
      edge(report, "Entity", "inferred", "references"),
    ]);
  });

  test("named TS references stay inside the imported file, including when that file is missing", () => {
    const source = n("client.ts", "function", "connect");
    const modelFile = n("model.ts");
    const config = n(modelFile.path, "interface", "Config");
    const wrongConfig = n("defaults.ts", "interface", "Config");
    const wrongOptions = n("defaults.ts", "interface", "Options");

    assert.deepEqual(resolveEdges([source, modelFile, config, wrongConfig, wrongOptions], [
      raw(source, "references", { name: "Config", specifier: "./model.js" }),
      raw(source, "references", { name: "Options", specifier: "./model.js" }),
      raw(source, "references", { name: "Options", specifier: "./missing.js" }),
    ]), [edge(source, config, "extracted", "references")]);
  });

  test("PHP resolves a namespaced type reference and finds methods on a composed trait", () => {
    const api = n("Api.php", "class", "Api");
    const run = n(api.path, "method", "Api.run");
    const trait = n(api.path, "trait", "LogsRequests");
    const log = n(api.path, "method", "LogsRequests.log");
    const model = n(posix.join("lib", "Models", "User.php"));
    const user = n(model.path, "class", "User");

    assert.deepEqual(resolveEdges([api, run, trait, log, model, user], [
      raw(run, "references", { name: "User", specifier: "App\\Models\\User" }),
      raw(api, "implements", { name: "LogsRequests" }),
      call(run, "log", { viaMember: true, recvType: "Api" }),
    ]), [
      edge(run, user, "extracted", "references"),
      edge(api, trait, "extracted", "implements"),
      edge(run, log, "extracted"),
    ]);
  });

  test("generic bare references resolve types, not functions or self-loops", () => {
    const tree = n("Tree.scala", "class", "Tree", { origin: "generic" });
    const leaf = n("Leaf.scala", "class", "Leaf", { origin: "generic" });
    const helper = n(tree.path, "function", "makeLeaf", { origin: "generic" });
    assert.deepEqual(resolveEdges([tree, leaf, helper], [
      raw(tree, "references", { name: "Leaf" }),
      raw(tree, "references", { name: "Tree" }),
      raw(tree, "references", { name: "makeLeaf" }),
    ]), [edge(tree, leaf, "inferred", "references")]);
  });

  test("Gleam picks the constructor for a call and the type for an annotation", () => {
    const source = n(posix.join("src", "main.gleam"), "function", "run", { origin: "generic" });
    const specifier = posix.join("app", "config");
    const configFile = n(posix.join("src", `${specifier}.gleam`));
    const config = n(configFile.path, "type", "Config");
    const ctor = n(configFile.path, "function", "Config~2");
    const localMap = n(source.path, "function", "map");
    assert.deepEqual(resolveEdges([source, configFile, config, ctor, localMap], [
      raw(source, "references", { name: "Config", specifier }),
      call(source, "Config", { specifier }),
      call(source, "map", { specifier: posix.join("gleam", "list") }),
      call(source, "map", { specifier }),
    ]), [edge(source, config, "extracted", "references"), edge(source, ctor, "extracted")]);
  });

  test("Python follows a relative import to a class member and reports an unknown in-repo member", () => {
    const pkg = n(posix.join("app", "__init__.py"));
    const view = n(posix.join("app", "view.py"));
    const run = n(view.path, "function", "run");
    const schema = n(posix.join("app", "schema.py"));
    const builder = n(schema.path, "class", "Builder");
    const start = n(schema.path, "method", "Builder.start");
    const unresolvedCalls: UnresolvedCallV1[] = [];
    assert.deepEqual(resolveEdges([pkg, view, run, schema, builder, start], [
      raw(view, "imports", { specifier: ".schema" }),
      call(run, "start", { specifier: ".schema", pythonChain: ["Builder", "start"] }),
      call(run, "finish", { specifier: ".schema", pythonChain: ["Builder", "finish"] }),
    ], { unresolvedCalls }), [edge(view, schema, "extracted", "imports"), edge(run, start, "extracted")]);
    assert.deepEqual(unresolvedCalls, [{ source: run.id, name: "finish", through: ".schema" }]);
  });
});

describe("Go package resolution", () => {
  test("imports and qualified calls use the most specific module and ignore test-only functions", () => {
    const app = n(posix.join("app", "main.go"));
    const run = n(app.path, "function", "run");
    const a = n(posix.join("storage", "a.go"));
    const z = n(posix.join("storage", "z.go"));
    const tests = n(posix.join("storage", "z_test.go"));
    const shadow = n(posix.join("app", "store", "store.go"));
    const model = n(posix.join("storage", "model", "client.go"));
    const storeSpec = posix.join("example.test", "kit", "store");
    const modelSpec = posix.join(storeSpec, "model");
    const open = n(z.path, "function", "Open", { returns: `${modelSpec}.Client` });
    const testOpen = n(tests.path, "function", "Open");
    const testOnly = n(tests.path, "function", "Fixture");
    const shadowOpen = n(shadow.path, "function", "Open");
    const flush = n(model.path, "method", "Client.Flush");
    const opts = {
      goModules: [
        { module: posix.join("example.test", "kit"), dir: "app" },
        { module: storeSpec, dir: "storage" },
      ],
    };

    assert.deepEqual(resolveEdges([app, run, z, a, tests, shadow, model, open, testOpen, testOnly, shadowOpen, flush], [
      raw(app, "imports", { specifier: storeSpec }),
      raw(app, "imports", { specifier: "fmt" }),
      call(run, "Open", { specifier: storeSpec }),
      call(run, "Fixture", { specifier: storeSpec }),
      call(run, "Flush", { viaMember: true, goResult: { fn: "Open", specifier: storeSpec } }),
    ], opts), [
      edge(app, a, "extracted", "imports"),
      edge(app, "fmt", "extracted", "imports"),
      edge(run, open, "extracted"),
      edge(run, flush),
    ]);
  });

  test("a bare Go import cannot use the path basename as a mismatched package name", () => {
    const app = n("main.go");
    const lib = n(posix.join("store", "repo.go"));
    const explicit = n(app.path, "function", "explicit");
    const guessed = n("other.go", "function", "guessed");
    const save = n(lib.path, "method", "Client.Save");
    const module = posix.join("example.test", "app");
    const specifier = posix.join(module, "store");
    const nodes = [app, lib, explicit, guessed, save];
    const intents = [
      meta(lib, { goFile: { package: "repository", bare: [], ignored: false } }),
      meta(guessed, { goFile: { package: "main", bare: [specifier], ignored: false } }),
      raw(app, "imports", { specifier }),
      call(guessed, "Save", { viaMember: true, goType: { name: "Client", specifier } }),
      call(explicit, "Save", { viaMember: true, goType: { name: "Client", specifier } }),
    ];
    assert.deepEqual(resolveEdges(nodes, intents, { goModules: [{ module, dir: "." }] }), [
      edge(app, lib, "extracted", "imports"), edge(explicit, save),
    ]);
    assert.deepEqual(resolveEdges(nodes, intents, { goModules: [] }), [
      edge(app, specifier, "extracted", "imports"),
    ]);
  });

  test("a local factory result resolves without a module, but an unindexed result is not guessed", () => {
    const run = n("main.go", "function", "run");
    const runAdapter = n(run.path, "function", "runAdapter");
    const open = n("client.go", "function", "open", { returns: "Client" });
    const adapter = n("client.go", "function", "adapter");
    const close = n("client.go", "method", "Client.Close");
    const other = n(posix.join("other", "client.go"), "function", "open", { returns: "OtherClient" });
    assert.deepEqual(resolveEdges([run, runAdapter, open, adapter, close, other], [
      call(run, "Close", { viaMember: true, goResult: { fn: "open" } }),
      call(runAdapter, "Close", { viaMember: true, goResult: { fn: "adapter" } }),
    ]), [edge(run, close)]);
  });
});

describe("Rust macro, receiver and path resolution", () => {
  test("opaque item macros hide both targets and callers, unlike forwarding macros", () => {
    const file = n("lib.rs");
    const run = n(file.path, "function", "run");
    const hidden = n(file.path, "function", "discarded");
    const visible = n(file.path, "function", "retained");
    const record = n(file.path, "function", "record");
    const keep = n(file.path, "function", "keep", { signature: "macro_rules! keep" });
    assert.deepEqual(resolveEdges([file, run, hidden, visible, record, keep], [
      meta(file, { rustMacroDef: { name: "discard", emits: false } }),
      meta(file, { rustMacroDef: { name: "keep", emits: true } }),
      meta(file, { rustMacroItems: { macro: "discard", ids: [hidden.id] } }),
      meta(file, { rustMacroItems: { macro: "keep", ids: [visible.id] } }),
      call(run, "discarded", { rustForm: "free" }),
      call(run, "retained", { rustForm: "free" }),
      call(hidden, "record", { rustForm: "free" }),
      call(visible, "record", { rustForm: "free" }),
      call(run, "keep", { rustForm: "macro" }),
    ]), [edge(run, visible, "extracted"), edge(visible, record, "extracted"), edge(run, keep, "extracted")]);
  });

  test("a chain follows a builder alias and the successful result of a method", () => {
    const file = n("build.rs");
    const local = n(file.path, "function", "buildLocal");
    const imported = n(file.path, "function", "buildImported");
    const finish = n("builder.rs", "function", "Builder.finish", {
      owner: "Builder", returns: "Result<Cache, BuildError>",
    });
    const read = n("cache.rs", "function", "Cache.read", { owner: "Cache" });
    assert.deepEqual(resolveEdges([file, local, imported, finish, read], [
      meta(n("builder.rs"), { rustAlias: { alias: "BuilderAlias", target: "Builder", start: 0, end: 100 } }),
      call(local, "read", {
        viaMember: true, rustForm: "method", rustChain: { type: "Builder", methods: ["finish", "?"] },
      }),
      call(imported, "read", {
        viaMember: true, rustForm: "method", rustAt: 40, rustOwnerBrought: true,
        rustChain: { type: "BuilderAlias", methods: ["finish", "?"] },
      }),
    ]), [edge(local, read, "likely"), edge(imported, read, "likely")]);
  });

  test("an external Rust receiver binds an in-scope extension trait only when the impl fits", () => {
    const file = n("main.rs");
    const known = n(file.path, "function", "known");
    const unknown = n(file.path, "function", "unknown");
    const trait = n("normalize.rs", "interface", "Normalize");
    const clean = n(trait.path, "function", "Normalize.clean", { owner: "Normalize" });
    const unresolvedCalls: UnresolvedCallV1[] = [];

    assert.deepEqual(resolveEdges([file, known, unknown, trait, clean], [
      meta(file, { rustUseNames: { names: ["Normalize"], glob: false } }),
      meta(trait, { rustImpl: { trait: "Normalize", type: "Path" } }),
      call(known, "clean", {
        viaMember: true, rustForm: "method", rustChain: { root: "std", type: "PathBuf", methods: ["new"] },
      }),
      call(unknown, "clean", {
        viaMember: true, rustForm: "method", rustChain: { root: "fixture", fn: "fixture::load", methods: [] },
      }),
    ], { unresolvedCalls, rustExternalCrates: new Set(["fixture"]) }), [edge(known, clean)]);
    assert.deepEqual(unresolvedCalls, [{ source: unknown.id, name: "clean", through: null }]);
  });

  test("a Rust crate and a crate-qualified alias disambiguate same-named receiver types", () => {
    const file = n(posix.join("engine", "src", "main.rs"));
    const local = n(file.path, "function", "local");
    const remote = n(file.path, "function", "remote");
    const consumer = n(posix.join("consumer", "src", "main.rs"), "function", "run");
    const own = n(posix.join("engine", "src", "cache.rs"), "function", "Cache.read", { owner: "Cache" });
    const other = n(posix.join("storage", "src", "cache.rs"), "function", "Cache.read", { owner: "Cache" });
    const cache = n(own.path, "struct", "Cache");
    const otherCache = n(other.path, "struct", "Cache");
    const refresh = n(own.path, "function", "ScratchCache.refresh", { owner: "ScratchCache" });
    const rustCrateDirs = new Map([["engine", "engine"], ["storage", "storage"], ["consumer", "consumer"]]);
    const unresolvedCalls: UnresolvedCallV1[] = [];
    const member = { viaMember: true, rustForm: "method", recvType: "Cache" } as const;

    assert.deepEqual(resolveEdges([file, local, remote, consumer, own, other, cache, otherCache, refresh], [
      meta(file, { rustAlias: { alias: "RemoteCache", target: "Cache", root: "storage", start: 0, end: 100 } }),
      call(local, "read", member),
      call(remote, "read", { ...member, recvType: "RemoteCache", rustAt: 25 }),
      call(consumer, "read", member),
      call(consumer, "refresh", member),
    ], { rustCrateDirs, unresolvedCalls }), [edge(local, own, "likely"), edge(remote, other, "likely")]);
    // The ambiguous read is reported before it is dropped; refresh is reported
    // after the trait lookup fails to find a method for Cache.
    assert.deepEqual(unresolvedCalls, [
      { source: consumer.id, name: "read", through: "Cache" },
      { source: consumer.id, name: "refresh", through: "Cache" },
    ]);
  });

  test("qualified Rust calls reach cfg arms without making a self-edge; bare calls respect module scope", () => {
    const root = n(posix.join("src", "lib.rs"));
    const platform = n(posix.join("src", "platform.rs"));
    const run = n(root.path, "function", "run");
    const scoped = n(root.path, "function", "scoped");
    const ambiguous = n(root.path, "function", "ambiguous");
    const first = n(platform.path, "function", "open");
    const second = n(platform.path, "function", "open~2");
    const legacy = n(posix.join("src", "legacy.rs"), "function", "open");
    const rustCrateDirs = new Map([["app", "."]]);
    const unresolvedCalls: UnresolvedCallV1[] = [];
    const qualified = { rustForm: "free", rustPath: "crate::platform::open" } as const;

    assert.deepEqual(resolveEdges([root, platform, run, scoped, ambiguous, first, second, legacy], [
      meta(platform, { rustCfgItems: [[first.id, ""], [second.id, ""]] }),
      raw(root, "imports", { specifier: posix.join("crate", "platform", "open") }),
      call(run, "open", qualified),
      call(first, "open", { ...qualified, rustTemplate: true }),
      call(scoped, "open", { rustForm: "free", onlyModules: ["platform"] }),
      call(ambiguous, "open", { rustForm: "free" }),
    ], { rustCrateDirs, unresolvedCalls }), [
      edge(root, platform, "extracted", "imports"),
      edge(run, first, "extracted"), edge(run, second, "extracted"),
      edge(first, second, "likely"),
      edge(scoped, first), edge(scoped, second),
    ]);
    assert.deepEqual(unresolvedCalls, [{ source: ambiguous.id, name: "open", through: "3 definitions of that name" }]);
  });

  test("a call in a macro body is at best likely: definite and likely arrive as likely, inferred stays inferred", () => {
    const lib = n(posix.join("src", "lib.rs"));
    const helper = n(lib.path, "function", "helper");
    const viaType = n(lib.path, "function", "via_type");
    const viaName = n(lib.path, "function", "via_name");
    const own = n(lib.path, "function", "own");
    const store = n(posix.join("src", "store.rs"), "struct", "Store");
    const save = n(store.path, "function", "Store.save", { owner: "Store" });
    const far = n(posix.join("src", "far.rs"), "function", "far");
    const template = { rustTemplate: true } as const;
    assert.deepEqual(resolveEdges([lib, helper, viaType, viaName, own, store, save, far], [
      call(own, "helper", { rustForm: "free", ...template }),
      call(viaType, "save", { viaMember: true, rustForm: "method", recvType: "Store", ...template }),
      call(viaName, "far", { rustForm: "free", ...template }),
    ]), [edge(own, helper, "likely"), edge(viaType, save, "likely"), edge(viaName, far, "inferred")]);
  });
});
