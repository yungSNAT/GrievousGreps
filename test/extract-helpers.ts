/** Shared setup for depth-tier extraction suites: offline grammars and node lookup. */
import { before, after, mock } from "node:test";
import assert from "node:assert/strict";
import type { ExtractResult, Language } from "../src/graph/extract.js";
import { warmDepthGrammars } from "../src/graph/depth-parser.js";

/** Warms `languages` before the suite and fails any network fetch whilst it runs. */
export function offlineDepthGrammars(languages: Language[]): void {
  let restoreFetch: (() => void) | undefined;
  before(async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      assert.fail("Graph extraction must work offline");
    });
    restoreFetch = () => fetchMock.mock.restore();
    await warmDepthGrammars(languages);
  });
  after(() => restoreFetch?.());
}

export function symbol(result: ExtractResult, id: string) {
  const node = result.nodes.find((n) => n.id === id);
  assert.ok(node, `Missing node ${id}`);
  return node;
}
