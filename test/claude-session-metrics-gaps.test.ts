/**
 * Gap tests for src/claude/session-metrics.ts: tool classification across host
 * shapes, the session read-modify-write, picking the latest session, the input
 * rate, and the stats readout.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  addHookSavings,
  classifyToolUse,
  commandInvokesGraft,
  formatSessionStats,
  isGraftMcpTool,
  isMcpToolName,
  latestSession,
  parseSavings,
  recordToolUse,
  sessionInputRate,
} from "../src/claude/session-metrics.js";
import { readSession, writeSession, sessionDir, listSessionIds, type SessionState } from "../src/claude/state.js";
import { GRAFT_MCP_TOOL_NAMES } from "../src/mcp/tool-names.js";
import { groupDigits } from "../src/context/savings.js";
import { dollarsSaved, formatDollars } from "../src/context/price.js";
import { tmpRepo } from "./helpers.js";

const dirs: string[] = [];
function scratch(tag: string): string {
  const d = tmpRepo(tag);
  dirs.push(d);
  return d;
}

let savedInvokedAs: string | undefined;
let hadInvokedAs = false;

before(() => {
  hadInvokedAs = Object.prototype.hasOwnProperty.call(process.env, "TRAIL_INVOKED_AS");
  savedInvokedAs = process.env.TRAIL_INVOKED_AS;
  delete process.env.TRAIL_INVOKED_AS;
});

after(() => {
  if (hadInvokedAs) process.env.TRAIL_INVOKED_AS = savedInvokedAs;
  else delete process.env.TRAIL_INVOKED_AS;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const GRAFT_TOOL = [...GRAFT_MCP_TOOL_NAMES][0] as string;

describe("tool names", () => {
  test("MCP-style names are recognised by prefix, colon or double underscore", () => {
    assert.equal(isMcpToolName("mcp__graft__x"), true);
    assert.equal(isMcpToolName("MCP:graft_find_code"), true);
    assert.equal(isMcpToolName("server__tool"), true);
    assert.equal(isMcpToolName("Read"), false);
    assert.equal(isMcpToolName("Bash"), false);
  });

  test("graft MCP tools are found under every host prefix, look-alikes are not", () => {
    assert.equal(isGraftMcpTool(GRAFT_TOOL), true);
    assert.equal(isGraftMcpTool(`mcp__graft__${GRAFT_TOOL}`), true);
    assert.equal(isGraftMcpTool(`MCP:${GRAFT_TOOL.toUpperCase()}`), true);
    assert.equal(isGraftMcpTool(`server.${GRAFT_TOOL}`), true);
    assert.equal(isGraftMcpTool("mcp__other__my_graft_helper"), false);
    assert.equal(isGraftMcpTool(""), false);
  });

  test("a source-checkout dist path counts as running the CLI", () => {
    assert.equal(commandInvokesGraft("node dist/cli.js ask x"), true);
    assert.equal(commandInvokesGraft("node dist\\bin\\graft.js grep y"), true);
    assert.equal(commandInvokesGraft("  npx -y @nanonets/graft ask z"), true);
    assert.equal(commandInvokesGraft("ls -la"), false);
  });
});

describe("classifyToolUse", () => {
  test("no tool name means no signal", () => {
    assert.equal(classifyToolUse(), null);
    assert.equal(classifyToolUse(""), null);
  });

  test("graft MCP tools are graft, native read tools are source", () => {
    assert.equal(classifyToolUse(`mcp__graft__${GRAFT_TOOL}`), "graft");
    for (const t of ["Read", "Grep", "Glob", "Search"]) assert.equal(classifyToolUse(t), "source", t);
  });

  test("a Bash or Shell tool is graft only when its command runs the CLI", () => {
    assert.equal(classifyToolUse("Bash", 'graft ask "auth"'), "graft");
    assert.equal(classifyToolUse("Shell", "cd src && trail callers run"), "graft");
    assert.equal(classifyToolUse("Bash", "ls -la"), null);
    assert.equal(classifyToolUse("Bash"), null);
    assert.equal(classifyToolUse("Shell", ""), null);
  });

  test("edits and unrelated tools are neither", () => {
    assert.equal(classifyToolUse("Edit", "graft ask x"), null);
    assert.equal(classifyToolUse("Task"), null);
  });
});

describe("savings parsing", () => {
  test("parseSavings sums every footer in a blob", () => {
    assert.equal(parseSavings("out\n[graft] tokens saved ≈ 1,200 (80%)\nmore\n[trail] tokens saved ≈ 300 (50%)"), 1500);
    assert.equal(parseSavings("nothing here"), 0);
  });

  test("addHookSavings adds to the running total only when there is something to add", () => {
    const s: SessionState = {} as SessionState;
    addHookSavings(s, "no footer");
    assert.equal(s.savedTokens, undefined);
    addHookSavings(s, "[graft] tokens saved ≈ 400 (40%)");
    assert.equal(s.savedTokens, 400);
    addHookSavings(s, "[graft] tokens saved ≈ 100 (10%)");
    assert.equal(s.savedTokens, 500);
  });
});

describe("recordToolUse", () => {
  test("nothing to record writes nothing", () => {
    const d = scratch("sm-noop");
    recordToolUse(d, "s1", {});
    recordToolUse(d, "s1", { kind: null, savedTokens: 0 });
    assert.deepEqual(listSessionIds(d), []);
    assert.equal(latestSession(d), null);
  });

  test("graft and source uses bump their counters, savings accumulate, host is stamped once", () => {
    const d = scratch("sm-record");
    recordToolUse(d, "abc", { kind: "graft", savedTokens: 1000, host: "cursor" as any });
    recordToolUse(d, "abc", { kind: "graft", host: "claude-code" as any });
    recordToolUse(d, "abc", { kind: "source" });
    recordToolUse(d, "abc", { savedTokens: 250 });
    const s = readSession(d, "abc");
    assert.equal(s.graftReads, 2);
    assert.equal(s.sourceReads, 1);
    assert.equal(s.savedTokens, 1250);
    assert.equal(s.turnUsedGraft, true);
    assert.equal(s.host, "cursor");
  });

  test("a source read alone does not mark the turn as owing a tally", () => {
    const d = scratch("sm-source");
    recordToolUse(d, "src", { kind: "source" });
    const s = readSession(d, "src");
    assert.equal(s.sourceReads, 1);
    assert.ok(!s.turnUsedGraft);
    assert.ok(!s.graftReads);
  });

  test("an empty session id lands in the default session", () => {
    const d = scratch("sm-default");
    recordToolUse(d, "", { kind: "graft" });
    assert.deepEqual(listSessionIds(d), ["default"]);
    assert.equal(readSession(d, "default").graftReads, 1);
  });
});

describe("latestSession and sessionInputRate", () => {
  test("the most recently touched session wins", () => {
    const d = scratch("sm-latest");
    writeSession(d, "older", { ...readSession(d, "older"), graftReads: 1 });
    writeSession(d, "newer", { ...readSession(d, "newer"), graftReads: 7 });
    const sdir = sessionDir(d);
    assert.ok(existsSync(join(sdir, "older.json")));
    const t0 = new Date("2025-01-01T00:00:00Z");
    const t1 = new Date("2025-06-01T00:00:00Z");
    utimesSync(join(sdir, "older.json"), t1, t1);
    utimesSync(join(sdir, "newer.json"), t0, t0);
    const latest = latestSession(d);
    assert.equal(latest?.id, "older");
    assert.equal(latest?.graftReads, 1);
  });

  test("no billed turn means no rate; a billed one gives micros per token", () => {
    const d = scratch("sm-rate");
    assert.equal(sessionInputRate(d), null);
    writeSession(d, "s", { ...readSession(d, "s"), graftReads: 1 });
    assert.equal(sessionInputRate(d), null);
    writeSession(d, "s", { ...readSession(d, "s"), inputCostMicros: 3000, inputTokensBilled: 1000 });
    assert.equal(sessionInputRate(d), 3);
    writeSession(d, "s", { ...readSession(d, "s"), inputCostMicros: 3000, inputTokensBilled: 0 });
    assert.equal(sessionInputRate(d), null);
  });
});

describe("formatSessionStats", () => {
  test("no session says how to get one, under the running name", () => {
    const out = formatSessionStats(null);
    assert.match(out, /^graft stats: no session recorded yet\. Use graft in an agent session/);
    process.env.TRAIL_INVOKED_AS = "trail";
    try {
      assert.match(formatSessionStats(null), /^trail status: no session recorded yet\. Use trail /);
    } finally {
      delete process.env.TRAIL_INVOKED_AS;
    }
  });

  test("an empty session shows zeros and no retrieval yet, without value or prompt lines", () => {
    const out = formatSessionStats({ id: "e1" } as any);
    const lines = out.split("\n");
    assert.equal(lines[0], "graft stats: session e1");
    assert.ok(lines.includes("  graft reads:   0"));
    assert.ok(lines.includes("  source reads:  0   (Read / Grep / Glob)"));
    assert.ok(lines.includes("  mix:           no retrieval yet"));
    assert.ok(lines.includes(`  tokens saved:  ~${groupDigits(0)}`));
    assert.ok(!out.includes("value saved"));
    assert.ok(!out.includes("prompts asked"));
  });

  test("a busy session shows the mix, savings, value and prompt asks", () => {
    const s = {
      id: "busy",
      graftReads: 3,
      sourceReads: 1,
      savedTokens: 12345,
      inputCostMicros: 3_000_000,
      inputTokensBilled: 1_000_000,
      promptAsks: 4,
    } as any;
    const out = formatSessionStats(s);
    assert.match(out, /^  mix:           75% graft$/m);
    assert.ok(out.includes(`  tokens saved:  ~${groupDigits(12345)}`));
    const usd = dollarsSaved(12345, 3_000_000, 1_000_000);
    assert.notEqual(usd, null);
    assert.ok(out.includes(`  value saved:   ~${formatDollars(usd as number)}`));
    assert.match(out, /^  prompts asked: 4$/m);
  });
});
