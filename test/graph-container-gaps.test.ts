import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  CONTAINER_LANGS,
  containerExtensions,
  containerLangOf,
  extractContainer,
  isContainerWarm,
  warmContainerGrammars,
  type ContainerLang,
} from "../src/graph/container.js";
import { depthReady } from "../src/graph/depth-parser.js";
import { extractFile, type RawEdge } from "../src/graph/extract.js";
import { fallbackLangOf, warmGenericGrammars } from "../src/graph/generic.js";
import { contentHash } from "../src/util/id.js";

describe("container grammar selection and extraction", () => {
  const vue = CONTAINER_LANGS.find((lang) => lang.name === "vue")!;
  const svelte = CONTAINER_LANGS.find((lang) => lang.name === "svelte")!;
  const astro = CONTAINER_LANGS.find((lang) => lang.name === "astro")!;

  before(async () => {
    await warmContainerGrammars([vue.name, astro.name]);
  });

  after(() => mock.restoreAll());

  test("claims container extensions and skips unknown names when warming again", async () => {
    assert.deepEqual(new Set(containerExtensions()), new Set([".vue", ".svelte", ".astro"]));
    assert.equal(containerLangOf(join("components", "Card.VUE")), vue);
    assert.equal(containerLangOf(join("components", "Card.vue.bak")), null);

    const unknown = "not-a-container";
    await warmContainerGrammars([vue.name, unknown, vue.name, astro.name]);
    assert.equal(isContainerWarm(vue.name), true);
    assert.equal(isContainerWarm(astro.name), true);
    assert.equal(isContainerWarm(unknown), false);
  });

  test("an unwarmed Svelte component is file-only; warming exposes the script at its original lines", async () => {
    const rel = "Card.svelte";
    const source = [
      '<script lang="ts">',
      "",
      '  function label(): string { return "ready"; }',
      "</script>",
      "<p>{label()}</p>",
    ].join("\n");

    assert.equal(isContainerWarm(svelte.name), false);
    const cold = extractContainer(rel, source, svelte);
    assert.deepEqual(cold.nodes.map(({ id, kind }) => ({ id, kind })), [{ id: rel, kind: "file" }]);
    assert.deepEqual(cold.rawEdges, []);
    assert.equal(cold.blockError, undefined);
    assert.equal(cold.nodes[0]?.span, "L1-L5");
    assert.equal(cold.nodes[0]?.chars, source.length);
    assert.equal(cold.nodes[0]?.body_hash, contentHash(source));
    assert.equal(cold.nodes[0]?.body_text, "");

    await warmContainerGrammars([svelte.name]);
    assert.equal(isContainerWarm(svelte.name), true);
    const warm = extractContainer(rel, source, svelte);
    assert.equal(warm.blockError, undefined);
    assert.equal(warm.nodes[0]?.body_hash, cold.nodes[0]?.body_hash);
    assert.equal(warm.nodes.find((node) => node.id === `${rel}#label`)?.span, "L3-L3");
  });

  test("an empty Vue component script does not pull in scripts nested in markup", () => {
    const rel = "Empty.vue";
    const source = [
      "<template>",
      "  <div><script>function nested() { return 1; }</script></div>",
      "</template>",
      "<script></script>",
    ].join("\n");

    const result = extractContainer(rel, source, vue);
    assert.deepEqual(result.nodes.map(({ id, span }) => ({ id, span })), [{ id: rel, span: "L1-L4" }]);
    assert.equal(result.nodes[0]?.body_text, "");
    assert.deepEqual(result.rawEdges, []);
    assert.equal(result.blockError, undefined);
  });

  test("Astro indexes a nested script after frontmatter and remaps its colliding edge endpoints", () => {
    const rel = "Panel.astro";
    const script = [
      "function setup() { return 42; }",
      "function run() { return setup(); }",
      "console.log(run());",
    ].join("\n");
    const source = [
      "---",
      script,
      "---",
      "<Layout>",
      "  <script>",
      script,
      "  </script>",
      "</Layout>",
    ].join("\n");

    const result = extractContainer(rel, source, astro);
    assert.equal(result.blockError, undefined);
    assert.equal(result.nodes[0]?.id, rel);
    assert.equal(result.nodes[0]?.span, "L1-L12");
    const setupId = `${rel}#setup`;
    const runId = `${rel}#run`;
    assert.deepEqual(
      result.nodes.filter((node) => node.name === "setup").map(({ id, span }) => ({ id, span })),
      [
        { id: setupId, span: "L2-L2" },
        { id: `${setupId}~2`, span: "L8-L8" },
      ],
    );
    assert.equal(result.nodes.find((node) => node.id === `${runId}~2`)?.span, "L9-L9");

    const functionIds = [setupId, runId];
    const touchesFunctions = (edge: RawEdge, suffix: string): boolean =>
      functionIds.some((id) => edge.source === id + suffix || edge.targetId === id + suffix);
    const endpoints = ({ source, targetId }: RawEdge) => ({ source, targetId });
    const originalEdges = extractFile(rel, script, "typescript").rawEdges
      .filter((edge) => touchesFunctions(edge, ""))
      .map(endpoints);
    assert.ok(originalEdges.length > 0, "the standalone script should emit a function edge");

    const rename = (id: string) => functionIds.includes(id) ? `${id}~2` : id;
    assert.deepEqual(
      result.rawEdges.filter((edge) => touchesFunctions(edge, "")).map(endpoints),
      originalEdges,
    );
    assert.deepEqual(
      result.rawEdges.filter((edge) => touchesFunctions(edge, "~2")).map(endpoints),
      originalEdges.map(({ source, targetId }) => ({
        source: rename(source),
        targetId: targetId === undefined ? undefined : rename(targetId),
      })),
    );
  });

  test("a custom embedded language uses its warmed breadth grammar when depth is cold", async () => {
    const pythonVue: ContainerLang = { ...vue, inner: "python" };
    await warmGenericGrammars([fallbackLangOf(pythonVue.inner).name]);
    assert.equal(depthReady(pythonVue.inner), false);

    const rel = "Example.vue";
    const source = [
      "<template><p>Example</p></template>",
      '<script lang="python">',
      "def greet():",
      '    return "hello"',
      "</script>",
    ].join("\n");
    const result = extractContainer(rel, source, pythonVue);

    assert.equal(result.blockError, undefined);
    assert.equal(result.nodes[0]?.span, "L1-L5");
    const greet = result.nodes.find((node) => node.name === "greet");
    assert.ok(greet, "the breadth grammar should extract greet");
    assert.equal(greet.path, rel);
    assert.match(greet.span, /^L3-L\d+$/);
  });

  for (const failure of [
    { label: "an Error", value: new Error("embedded extractor unavailable"), message: "embedded extractor unavailable" },
    { label: "a thrown string", value: "embedded extractor rejected input", message: "embedded extractor rejected input" },
  ]) {
    test(`reports ${failure.label} from one block and still indexes the next`, () => {
      const configured: ContainerLang = {
        ...astro,
        get inner() {
          return astro.inner;
        },
      };
      // Fail the first dispatch without changing the parser or the container registry.
      mock.getter(configured, "inner", () => {
        throw failure.value;
      }, { times: 1 });

      const rel = "Recover.astro";
      const source = [
        "---",
        "function skipped() { return 0; }",
        "---",
        "<script>",
        "function kept() { return 1; }",
        "</script>",
      ].join("\n");
      const result = extractContainer(rel, source, configured);

      assert.equal(result.blockError, `astro block: ${failure.message}`);
      assert.deepEqual(result.nodes.map(({ id, span }) => ({ id, span })), [
        { id: rel, span: "L1-L6" },
        { id: `${rel}#kept`, span: "L5-L5" },
      ]);
    });
  }
});
