import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  missingNativePackages,
  nativeFallbackNotice,
  nativeParser,
  nativeReady,
  realNativeRequire,
  setNativeRequireForTest,
} from "../src/graph/native.js";

/** A stand-in for node tree-sitter's Parser: it accepts any grammar object unless
 * the grammar is marked `bad`, which mimics an addon built for another ABI. */
class FakeParser {
  static instances: FakeParser[] = [];
  lang: unknown = undefined;
  setCalls: unknown[] = [];
  constructor() {
    FakeParser.instances.push(this);
  }
  setLanguage(g: unknown): void {
    this.setCalls.push(g);
    if (g && (g as { bad?: boolean }).bad) throw new Error("Incompatible language version 99");
    this.lang = g;
  }
  parse(input: (index: number) => string): { rootNode: unknown } {
    return { rootNode: { text: input(0), lang: this.lang } };
  }
}

const TS_GRAMMAR = { name: "typescript" };
const TSX_GRAMMAR = { name: "tsx" };
const PY_GRAMMAR = { name: "python" };
const JAVA_BAD = { name: "java", bad: true };

type Spec = Record<string, unknown | Error | string>;

/** A require that returns the faked module for each id, throws an Error value as
 * node-gyp-build would, and throws a bare string for `{ throwString }` entries. */
function fakeRequire(spec: Spec, calls: string[] = []): (id: string) => unknown {
  return (id) => {
    calls.push(id);
    if (!(id in spec)) throw new Error(`Cannot find module '${id}'`);
    const v = spec[id];
    if (v instanceof Error) throw v;
    if (v && typeof v === "object" && "throwString" in (v as object)) throw (v as { throwString: string }).throwString;
    return v;
  };
}

function baseSpec(): Spec {
  return {
    "tree-sitter": FakeParser,
    "tree-sitter-typescript": { typescript: TS_GRAMMAR, tsx: TSX_GRAMMAR },
    "tree-sitter-python": PY_GRAMMAR,
    "tree-sitter-java": JAVA_BAD,
  };
}

afterEach(() => {
  setNativeRequireForTest(null);
  FakeParser.instances = [];
});

describe("nativeReady and nativeParser with working modules", () => {
  test("a loaded grammar is ready, and the shared parser switches between grammars", () => {
    setNativeRequireForTest(fakeRequire(baseSpec()));
    assert.equal(nativeReady("tsx"), true);
    assert.equal(nativeReady("typescript"), true);
    assert.equal(nativeReady("python"), true);
    // One parser instance shared across languages: the core is constructed once.
    assert.equal(FakeParser.instances.length, 1);

    const p = nativeParser("tsx") as unknown as FakeParser;
    assert.equal(p.lang, TSX_GRAMMAR);
    const tree = p.parse((i) => (i === 0 ? "const x = 1;" : ""));
    assert.deepEqual(tree.rootNode, { text: "const x = 1;", lang: TSX_GRAMMAR });

    const p2 = nativeParser("typescript") as unknown as FakeParser;
    assert.equal(p2, p, "the same parser is reused");
    assert.equal(p2.lang, TS_GRAMMAR);

    const p3 = nativeParser("python") as unknown as FakeParser;
    assert.equal(p3.lang, PY_GRAMMAR);
    assert.deepEqual(missingNativePackages(["tsx", "typescript", "python"]), []);
  });

  test("the answer is cached: a second ask does not require again", () => {
    const calls: string[] = [];
    setNativeRequireForTest(fakeRequire(baseSpec(), calls));
    assert.equal(nativeReady("python"), true);
    const after1 = calls.length;
    assert.equal(nativeReady("python"), true);
    assert.equal(calls.length, after1);
    assert.deepEqual(calls.sort(), ["tree-sitter", "tree-sitter-python"]);
  });

  test("two grammars from one module are required once", () => {
    const calls: string[] = [];
    setNativeRequireForTest(fakeRequire(baseSpec(), calls));
    nativeReady("typescript");
    nativeReady("tsx");
    assert.equal(calls.filter((c) => c === "tree-sitter-typescript").length, 1);
    assert.equal(calls.filter((c) => c === "tree-sitter").length, 1);
  });
});

describe("failures are remembered and explained", () => {
  test("a missing grammar addon: not ready, nativeParser throws with the load error", () => {
    const spec = baseSpec();
    spec["tree-sitter-kotlin"] = new Error("No native build was found for tree-sitter-kotlin");
    setNativeRequireForTest(fakeRequire(spec));
    assert.equal(nativeReady("kotlin"), false);
    assert.throws(
      () => nativeParser("kotlin"),
      { message: "the native kotlin parser is not available: No native build was found for tree-sitter-kotlin" },
    );
    assert.deepEqual(missingNativePackages(["kotlin", "python"]), ["tree-sitter-kotlin"]);
  });

  test("a core binding that won't load: every language falls back and the core is named first", () => {
    const spec = baseSpec();
    spec["tree-sitter"] = new Error("No native build was found for tree-sitter");
    spec["tree-sitter-go"] = new Error("No native build was found for tree-sitter-go");
    setNativeRequireForTest(fakeRequire(spec));
    assert.equal(nativeReady("python"), false);
    assert.equal(nativeReady("go"), false);
    assert.throws(() => nativeParser("python"), {
      message: "the native python parser is not available: No native build was found for tree-sitter",
    });
    // The grammar is still loaded, so every missing package is named.
    assert.deepEqual(missingNativePackages(["go", "python"]), ["tree-sitter", "tree-sitter-go"]);
  });

  test("a core constructor that throws is recorded as the core's failure", () => {
    const spec = baseSpec();
    spec["tree-sitter"] = class {
      constructor() {
        throw new Error("binding ABI mismatch in Parser()");
      }
    };
    setNativeRequireForTest(fakeRequire(spec));
    assert.equal(nativeReady("python"), false);
    assert.throws(() => nativeParser("python"), {
      message: "the native python parser is not available: binding ABI mismatch in Parser()",
    });
    assert.deepEqual(missingNativePackages(["python"]), ["tree-sitter"]);
  });

  test("a thrown non-Error value becomes its string form", () => {
    const spec = baseSpec();
    spec["tree-sitter-swift"] = { throwString: "swift addon missing" };
    setNativeRequireForTest(fakeRequire(spec));
    assert.equal(nativeReady("swift"), false);
    assert.throws(() => nativeParser("swift"), {
      message: "the native swift parser is not available: swift addon missing",
    });
  });

  test("a grammar the parser rejects: not ready, no package to allow, no reason appended", () => {
    setNativeRequireForTest(fakeRequire(baseSpec()));
    assert.equal(nativeReady("java"), false);
    assert.deepEqual(missingNativePackages(["java"]), []);
    assert.throws(() => nativeParser("java"), { message: "the native java parser is not available" });
  });

  test("a module without the picked export: not ready, nothing to install", () => {
    const spec = baseSpec();
    spec["tree-sitter-php"] = { php_only: { name: "php_only" } };
    setNativeRequireForTest(fakeRequire(spec));
    assert.equal(nativeReady("php"), false);
    assert.deepEqual(missingNativePackages(["php"]), []);
    assert.throws(() => nativeParser("php"), { message: "the native php parser is not available" });
  });

  test("the r alias is reported under its real npm name, alongside others, sorted", () => {
    const spec = baseSpec();
    spec["tree-sitter-r"] = new Error("no build for r");
    spec["tree-sitter-kotlin"] = new Error("no build for kotlin");
    setNativeRequireForTest(fakeRequire(spec));
    assert.deepEqual(missingNativePackages(["r", "kotlin", "r"]), ["@davisvaughan/tree-sitter-r", "tree-sitter-kotlin"]);
  });

  test("resetting the seam forgets cached failures", () => {
    const spec = baseSpec();
    spec["tree-sitter-python"] = new Error("missing");
    setNativeRequireForTest(fakeRequire(spec));
    assert.equal(nativeReady("python"), false);
    setNativeRequireForTest(fakeRequire(baseSpec()));
    assert.equal(nativeReady("python"), true);
  });
});

describe("nativeFallbackNotice and realNativeRequire", () => {
  test("no fallback or an empty one prints nothing", () => {
    assert.equal(nativeFallbackNotice(undefined), null);
    assert.equal(nativeFallbackNotice({ languages: [], packages: ["tree-sitter"] }), null);
  });

  test("several packages are joined with commas in one allow-scripts flag", () => {
    assert.equal(
      nativeFallbackNotice({ languages: ["go", "python"], packages: ["tree-sitter", "tree-sitter-go"] }),
      "⚠ go, python: basic parsing only, their parsers didn't load. To fix: run npm ci --allow-scripts=tree-sitter,tree-sitter-go in your GrievousGreps folder",
    );
  });

  test("realNativeRequire is a plain require", () => {
    const path = realNativeRequire("node:path") as { join: (...p: string[]) => string };
    assert.equal(typeof path.join, "function");
    assert.throws(() => realNativeRequire("definitely-not-a-module-xyz"), /Cannot find module/);
  });
});
