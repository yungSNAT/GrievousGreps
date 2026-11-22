import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLS, callTool, canonicalToolName } from "../src/mcp/tools.js";
import { readWorkspace } from "../src/graph/workspace.js";
import { runCli, tmpRepo } from "./helpers.js";

type ObjectSchema = {
  type: string;
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
};

test("MCP advertises the regex search and repo map options", () => {
  const grep = TOOLS.find(({ name }) => name === "graft_find_all");
  assert.ok(grep);
  assert.match(grep.description, /regex search/i);
  const grepSchema = grep.inputSchema as ObjectSchema;
  assert.equal(grepSchema.type, "object");
  assert.deepEqual(grepSchema.required, ["pattern"]);
  assert.equal(grepSchema.properties.pattern.type, "string");
  assert.equal(grepSchema.properties.in.type, "string");
  assert.equal(grepSchema.properties.ignore_case.type, "boolean");
  assert.equal(grepSchema.properties.fixed.type, "boolean");

  const map = TOOLS.find(({ name }) => name === "graft_repo_map");
  assert.ok(map);
  assert.match(map.description, /hotspots/i);
  const mapSchema = map.inputSchema as ObjectSchema;
  assert.equal(mapSchema.type, "object");
  assert.equal(mapSchema.properties.max_dirs.type, "number");
  assert.match(mapSchema.properties.max_dirs.description ?? "", /default 16/);
});

function writeChild(root: string, name: string, fee: number): void {
  const dir = join(root, name);
  const src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, `${name}-fee.ts`),
    `export function calculateServiceFee(subtotal: number): number {
  // Fee[v1] is the flat rate.
  return subtotal + ${fee};
}
`,
  );
  writeFileSync(
    join(src, `${name}-checkout.ts`),
    `import { calculateServiceFee as fee } from './${name}-fee';

export function ${name}Total(subtotal: number): number {
  return fee(subtotal);
}
`,
  );

  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("add", "--all");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Add fee and checkout code");
}

describe("MCP tools rooted at a built workspace", () => {
  let root: string;
  let fetchCalls = 0;

  before(() => {
    mock.method(globalThis, "fetch", async () => {
      fetchCalls++;
      throw new Error("MCP workspace tests must not make HTTP requests");
    });

    root = tmpRepo("mcp-tools-gaps");
    writeChild(root, "billing", 19);
    writeChild(root, "shipping", 47);

    const build = runCli(["build", root], { timeoutMs: 60_000 });
    assert.equal(build.status, 0, build.describe());
    const workspace = readWorkspace(root);
    assert.ok(workspace, build.describe());
    assert.deepEqual([...workspace.children].sort(), ["billing", "shipping"]);
  });

  after(() => {
    mock.restoreAll();
    if (root) rmSync(root, { recursive: true, force: true });
    assert.equal(fetchCalls, 0);
  });

  test("find code includes results from both child graphs", async () => {
    const result = await callTool(root, "graft_find_code", { query: "calculateServiceFee" });

    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /billing-fee\.ts/);
    assert.match(result.text, /shipping-fee\.ts/);
  });

  test("the legacy ask name still accepts workspace scope and inlines source", async () => {
    assert.equal(canonicalToolName("graft_ask"), "graft_find_code");
    assert.equal(canonicalToolName("graft_find_code"), "graft_find_code");
    assert.equal(TOOLS.some(({ name }) => name === "graft_ask"), false);

    const result = await callTool(root, "graft_ask", {
      query: "calculateServiceFee",
      in: "shipping",
      limit: 1,
      full: true,
    });

    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /shipping-fee\.ts/);
    assert.match(result.text, /return subtotal \+ 47;/);
    assert.doesNotMatch(result.text, /billing-fee\.ts/);
  });

  test("federated grep honors literal, case-insensitive matching and child scope", async () => {
    // Neither a case-sensitive literal nor the regex fee[v1] matches Fee[v1].
    const options = { pattern: "fee[v1]", fixed: true, ignore_case: true };
    const all = await callTool(root, "graft_find_all", options);
    assert.equal(all.isError, false, all.text);
    assert.match(all.text, /billing-fee\.ts/);
    assert.match(all.text, /shipping-fee\.ts/);

    const scoped = await callTool(root, "graft_find_all", { ...options, in: "billing" });
    assert.equal(scoped.isError, false, scoped.text);
    assert.match(scoped.text, /billing-fee\.ts/);
    assert.doesNotMatch(scoped.text, /shipping-fee\.ts/);
  });

  test("federated tracing resolves callers in the selected child's graph", async () => {
    const result = await callTool(root, "graft_trace_calls", {
      symbol: "calculateServiceFee",
      in: "billing",
      direction: null,
      depth: "full",
    });

    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /\bbillingTotal\b/);
    assert.doesNotMatch(result.text, /\bshippingTotal\b/);
  });

  test("the workspace map covers both children", async () => {
    const result = await callTool(root, "graft_repo_map", { max_dirs: 8 });

    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /\bbilling\b/);
    assert.match(result.text, /\bshipping\b/);
  });

  test("workspace freshness reports on both children", async () => {
    const result = await callTool(root, "graft_check_freshness", {});

    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /\bbilling\b/);
    assert.match(result.text, /\bshipping\b/);
  });

  test("workspace tools give specific errors for missing and invalid arguments", async () => {
    const cases = [
      ["graft_find_code", {}, "graft_find_code requires a query"],
      ["graft_find_all", {}, "graft_find_all requires a pattern"],
      ["graft_trace_calls", {}, "graft_trace_calls requires a symbol"],
      [
        "graft_trace_calls",
        { symbol: "calculateServiceFee", direction: "sideways" },
        'graft_trace_calls: direction must be "in" or "out", got "sideways"',
      ],
    ] as const;

    for (const [name, args, text] of cases) {
      assert.deepEqual(await callTool(root, name, args), { text, isError: true });
    }
  });

  test("tools that do not federate fall through to the single-graph dispatcher", async () => {
    assert.deepEqual(await callTool(root, "graft_file_api", {}), {
      text: "graft_file_api requires a file",
      isError: true,
    });
    assert.deepEqual(await callTool(root, "graft_not_a_tool", {}), {
      text: "unknown tool: graft_not_a_tool",
      isError: true,
    });
  });
});
