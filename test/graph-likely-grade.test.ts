/**
 * The `likely` edge grade: a cross-file edge that a stated type, path, crate or base class
 * picked, graded between `extracted` and the bare-name `inferred`. Measured on 26 Nov 2026:
 * 108 of 111 such edges right against 13 of 48 for a bare name (README, 'How precise').
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEdges } from "../src/graph/resolve.js";
import type { PythonExports, RawEdge, TsModule } from "../src/graph/extract.js";
import type { NodeV1 } from "../src/graph/types.js";
import { confidenceRank, parseConfidence, provenanceOf, weakestConfidence } from "../src/graph/provenance.js";
import { hitLine, matchJson } from "../src/graph/traverse-cli.js";
import { impactOfMany, type EdgeHit } from "../src/graph/traverse.js";
import type { GraphV1 } from "../src/graph/types.js";

function n(id: string, kind: NodeV1["kind"]): NodeV1 {
  const post = id.includes("#") ? id.split("#")[1] : id;
  const segs = post.split(".");
  const owner = kind === "method" && segs.length >= 2 ? segs[segs.length - 2] : undefined;
  return { id, name: segs[segs.length - 1], kind, owner, path: id.split("#")[0], span: "L1-L1", signature: null,
    exported: true, origin: "ast", body_hash: "h", summary_state: "pending", summary: null, crux: null } as NodeV1;
}

const tsModule = (imports: string[]): TsModule => ({
  imports: imports.map((local) => ({ local, name: local, specifier: `./${local.toLowerCase()}` })),
  reexports: [], stars: [], exports: [],
});

const tsFrom = (file: string, imports: [string, string][]): RawEdge => ({
  source: file, relation: "contains", file,
  tsModule: { imports: imports.map(([local, specifier]) => ({ local, name: local, specifier })), reexports: [], stars: [], exports: [] },
}) as RawEdge;

const pyFrom = (file: string, imports: [string, string][]): RawEdge => ({
  source: file, relation: "contains", file,
  pythonExports: {
    imports: imports.map(([local, specifier], i) => ({ local, name: local, specifier, line: i + 1, conditional: false })),
    stars: [], all: null, conditionalDefs: [],
  } satisfies PythonExports,
}) as RawEdge;

const calls = (edges: ReturnType<typeof resolveEdges>) => edges.filter((e) => e.relation === "calls");

test("a typed member call into another file is likely in Python", () => {
  const edges = resolveEdges([n("store.py", "file"), n("store.py#Store", "class"), n("store.py#Store.save", "method"), n("app.py#run", "function")], [
    pyFrom("app.py", [["Store", "store"]]),
    { source: "app.py#run", relation: "calls", name: "save", viaMember: true, recvType: "Store", file: "app.py" },
  ]);
  assert.deepEqual(calls(edges).map((e) => [e.target, e.confidence]), [["store.py#Store.save", "likely"]]);
});

test("a TypeScript typed member call is likely when the file imports the receiver's type", () => {
  const edges = resolveEdges([n("src/cache.ts", "file"), n("src/cache.ts#Cache", "class"), n("src/cache.ts#Cache.get", "method"), n("src/app.ts#run", "function")], [
    { source: "src/app.ts", relation: "contains", file: "src/app.ts", tsModule: tsModule(["Cache"]) } as RawEdge,
    { source: "src/app.ts#run", relation: "calls", name: "get", viaMember: true, recvType: "Cache", file: "src/app.ts" },
  ]);
  assert.deepEqual(calls(edges).map((e) => [e.target, e.confidence]), [["src/cache.ts#Cache.get", "likely"]]);
});

test("a TypeScript receiver typed by a global the repository reuses stays inferred", () => {
  // hono declares `interface Response extends ClientResponse`; a handler's `res: Response` is the
  // platform's Response, which the handler never imports. 3 of 3 such edges were wrong.
  const nodes = [
    n("src/client/types.ts#Response", "interface"), n("src/client/types.ts#ClientResponse", "interface"),
    n("src/client/types.ts#ClientResponse.text", "method"), n("src/adapter/handler.ts#createResult", "function"),
  ];
  const edges = resolveEdges(nodes, [
    { source: "src/client/types.ts#Response", relation: "extends", name: "ClientResponse", file: "src/client/types.ts" },
    { source: "src/adapter/handler.ts", relation: "contains", file: "src/adapter/handler.ts", tsModule: tsModule([]) } as RawEdge,
    { source: "src/adapter/handler.ts#createResult", relation: "calls", name: "text", viaMember: true, recvType: "Response", file: "src/adapter/handler.ts" },
  ]);
  assert.deepEqual(calls(edges).map((e) => [e.target, e.confidence]), [["src/client/types.ts#ClientResponse.text", "inferred"]]);
});

test("a typed member call in a language the sample did not measure stays inferred", () => {
  const edges = resolveEdges([n("Store.java#Store", "class"), n("Store.java#Store.save", "method"), n("App.java#run", "method")], [
    { source: "App.java#run", relation: "calls", name: "save", viaMember: true, recvType: "Store", file: "App.java" },
  ]);
  assert.deepEqual(calls(edges).map((e) => e.confidence), ["inferred"]);
});

test("a bare-name call to another file's function stays inferred", () => {
  const edges = resolveEdges([n("util.py#helper", "function"), n("app.py#run", "function")], [
    { source: "app.py#run", relation: "calls", name: "helper", file: "app.py" },
  ]);
  assert.deepEqual(calls(edges).map((e) => e.confidence), ["inferred"]);
});

test("a base class found by its unique name in another file is likely; an unknown base keeps its name", () => {
  const edges = resolveEdges([n("base.py", "file"), n("base.py#Base", "class"), n("app.py#Child", "class"), n("app.py#Other", "class")], [
    pyFrom("app.py", [["Base", "base"]]),
    { source: "app.py#Child", relation: "extends", name: "Base", file: "app.py" },
    { source: "app.py#Other", relation: "extends", name: "Missing", file: "app.py" },
  ]);
  const ext = edges.filter((e) => e.relation === "extends").map((e) => [e.source, e.target, e.confidence]);
  assert.deepEqual(ext, [["app.py#Child", "base.py#Base", "likely"], ["app.py#Other", "Missing", "inferred"]]);
});

test("likely parses, ranks between extracted and inferred, and counts as INFERRED provenance", () => {
  assert.equal(parseConfidence("likely"), "likely");
  assert.equal(parseConfidence("probable"), "inferred");
  assert.ok(confidenceRank("extracted") > confidenceRank("likely"));
  assert.ok(confidenceRank("likely") > confidenceRank("inferred"));
  assert.equal(weakestConfidence("extracted", "likely"), "likely");
  assert.equal(weakestConfidence("likely", "inferred"), "inferred");
  assert.equal(provenanceOf("likely"), "INFERRED");
});

test("callers marks a likely hit [likely], keeps inferred: true in --json and adds confidence to every hit", () => {
  const node = (name: string) => ({ id: `src/a.ts#${name}`, name, kind: "function", path: "src/a.ts", span: "L1-L3" }) as unknown as NodeV1;
  const hit = (name: string, confidence: EdgeHit["confidence"]): EdgeHit => ({
    node: node(name), id: `src/a.ts#${name}`, relation: "calls", depth: 1, confidence,
    ...(confidence === "extracted" ? {} : { inferred: true as const }),
  });
  assert.equal(hitLine("in", hit("a", "likely"), false), "  calls ← a (src/a.ts:L1-L3) [likely]");
  assert.equal(hitLine("in", hit("b", "inferred"), false), "  calls ← b (src/a.ts:L1-L3) [inferred]");
  assert.equal(hitLine("in", hit("c", "extracted"), false), "  calls ← c (src/a.ts:L1-L3)");
  const json = matchJson({ nodes: [], edges: [] } as unknown as GraphV1, "in",
    { symbol: node("t"), hits: [hit("a", "likely"), hit("b", "inferred"), hit("c", "extracted")] }, 1);
  assert.deepEqual(json.hits.map((h) => [h.inferred ?? false, h.confidence]), [[true, "likely"], [true, "inferred"], [false, "extracted"]]);
});

// The grade needs the type or base to be the file's own or imported from the target's file:
// a namesake imported from a package, or a global, is not the repository's type.
test("a TypeScript receiver whose type is imported from a package stays inferred", () => {
  const edges = resolveEdges([n("src/client/types.ts#Response", "interface"), n("src/client/types.ts#Response.json", "method"), n("src/h.ts#handle", "function")], [
    tsFrom("src/h.ts", [["Response", "undici"]]),
    { source: "src/h.ts#handle", relation: "calls", name: "json", viaMember: true, recvType: "Response", file: "src/h.ts" },
  ]);
  assert.deepEqual(calls(edges).map((e) => [e.target, e.confidence]), [["src/client/types.ts#Response.json", "inferred"]]);
});

test("a TypeScript class extending a global the repository reuses stays inferred", () => {
  const edges = resolveEdges([n("src/errors/custom.ts#Error", "class"), n("src/app.ts#AppError", "class")], [
    tsFrom("src/app.ts", []),
    { source: "src/app.ts#AppError", relation: "extends", name: "Error", file: "src/app.ts" },
  ]);
  assert.deepEqual(edges.filter((e) => e.relation === "extends").map((e) => e.confidence), ["inferred"]);
});

test("a TypeScript base imported from a package stays inferred; one imported from the target's file is likely", () => {
  const nodes = [n("src/util/EventEmitter.ts", "file"), n("src/util/EventEmitter.ts#EventEmitter", "class"), n("src/bus.ts#Bus", "class"), n("src/own.ts#Own", "class")];
  const edges = resolveEdges(nodes, [
    tsFrom("src/bus.ts", [["EventEmitter", "events"]]),
    { source: "src/bus.ts#Bus", relation: "extends", name: "EventEmitter", file: "src/bus.ts" },
    tsFrom("src/own.ts", [["EventEmitter", "./util/EventEmitter"]]),
    { source: "src/own.ts#Own", relation: "extends", name: "EventEmitter", file: "src/own.ts" },
  ]);
  assert.deepEqual(edges.filter((e) => e.relation === "extends").map((e) => [e.source, e.confidence]),
    [["src/bus.ts#Bus", "inferred"], ["src/own.ts#Own", "likely"]]);
});

test("a Python base or receiver type the file does not import stays inferred", () => {
  const edges = resolveEdges([n("base.py", "file"), n("base.py#Base", "class"), n("base.py#Base.save", "method"), n("app.py#Child", "class"), n("app.py#run", "function")], [
    pyFrom("app.py", []),
    { source: "app.py#Child", relation: "extends", name: "Base", file: "app.py" },
    { source: "app.py#run", relation: "calls", name: "save", viaMember: true, recvType: "Base", file: "app.py" },
  ]);
  assert.deepEqual(edges.filter((e) => e.relation !== "contains").map((e) => [e.relation, e.confidence]), [["extends", "inferred"], ["calls", "inferred"]]);
});

test("a deployment resource reached through a likely and an extracted caller in one file stays definite", () => {
  // X's likely path reaches src/x.ts first; Y's extracted path at the same depth must still win.
  const g = {
    version: 1,
    nodes: [n("src/a.ts", "file"), n("src/a.ts#S", "function"), n("src/x.ts", "file"), n("src/x.ts#X", "function"), n("src/x.ts#Y", "function"),
      { ...n("deploy/Dockerfile#stage", "resource"), path: "deploy/Dockerfile" }],
    edges: [
      { source: "src/x.ts#X", target: "src/a.ts#S", relation: "calls", confidence: "likely" },
      { source: "src/x.ts#Y", target: "src/a.ts#S", relation: "calls", confidence: "extracted" },
      { source: "deploy/Dockerfile#stage", target: "src/x.ts", relation: "references", confidence: "extracted" },
    ],
  } as unknown as GraphV1;
  const seed = g.nodes.find((x) => x.id === "src/a.ts#S")!;
  for (const provenance of [false, true]) {
    const hits = impactOfMany(g, [seed], 2, "in", { provenance }).filter((h) => h.id.startsWith("deploy/"));
    assert.deepEqual(hits.map((h) => [h.id, h.depth, h.confidence, h.inferred ?? false]), [["deploy/Dockerfile#stage", 2, "extracted", false]], `provenance ${provenance}`);
  }
});

test("a TypeScript receiver type imported through a barrel is likely", () => {
  const nodes = [n("src/lib/index.ts", "file"), n("src/lib/cache.ts", "file"), n("src/lib/cache.ts#Cache", "class"),
    n("src/lib/cache.ts#Cache.get", "method"), n("src/app.ts#run", "function")];
  const edges = resolveEdges(nodes, [
    { source: "src/lib/index.ts", relation: "contains", file: "src/lib/index.ts",
      tsModule: { imports: [], reexports: [{ exported: "Cache", name: "Cache", specifier: "./cache" }], stars: [], exports: [] } } as RawEdge,
    tsFrom("src/app.ts", [["Cache", "./lib/index"]]),
    { source: "src/app.ts#run", relation: "calls", name: "get", viaMember: true, recvType: "Cache", file: "src/app.ts" },
  ]);
  assert.deepEqual(calls(edges).map((e) => [e.target, e.confidence]), [["src/lib/cache.ts#Cache.get", "likely"]]);
});
