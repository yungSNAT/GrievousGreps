import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpRepo } from "./helpers.js";
import { startMcpServer } from "../src/mcp/server.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SERVER_URL = new URL("../src/mcp/server.ts", import.meta.url).href;

// Runs the real server in a child: it owns stdin/stdout and calls process.exit on stdin end.
const DRIVER = [
  "const { startMcpServer } = await import(process.env.MCP_SERVER_URL);",
  "const o = JSON.parse(process.env.MCP_OPTS);",
  "startMcpServer(o.root, o.dir ?? undefined, o.version ?? undefined, o.brainsOnly ? { brainsOnly: true } : undefined);",
].join("\n");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Msg = { jsonrpc?: string; id?: unknown; method?: string; result?: any; error?: { code: number; message: string } };

class Session {
  child: ChildProcess;
  messages: Msg[] = [];
  private buf = "";
  exited: Promise<number | null>;

  constructor(opts: { root: string; dir?: string; version?: string; brainsOnly?: boolean }) {
    this.child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", DRIVER], {
      cwd: REPO,
      env: { ...process.env, MCP_SERVER_URL: SERVER_URL, MCP_OPTS: JSON.stringify(opts), DO_NOT_TRACK: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (line.trim()) this.messages.push(JSON.parse(line));
      }
    });
    this.child.stderr!.resume();
    this.exited = new Promise((res) => this.child.on("exit", (code) => res(code)));
  }

  send(x: unknown): void {
    this.child.stdin!.write((typeof x === "string" ? x : JSON.stringify(x)) + "\n");
  }

  async waitFor(id: unknown, ms = 90_000): Promise<Msg> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const m = this.messages.find((x) => x.id === id && ("result" in x || "error" in x));
      if (m) return m;
      if (this.child.exitCode !== null) break;
      await sleep(25);
    }
    throw new Error(`no reply for id ${String(id)}; got ${JSON.stringify(this.messages)}`);
  }

  async close(): Promise<number | null> {
    this.child.stdin!.end();
    return this.exited;
  }

  kill(): void {
    if (this.child.exitCode === null) this.child.kill();
  }
}

describe("startMcpServer over stdio", () => {
  const dirs: string[] = [];
  const sessions: Session[] = [];
  const open = (o: ConstructorParameters<typeof Session>[0]) => {
    const s = new Session(o);
    sessions.push(s);
    return s;
  };

  before(() => {
    assert.equal(typeof startMcpServer, "function");
  });

  after(() => {
    for (const s of sessions) s.kill();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("dir override: handshake, ping, lists, errors and notifications", { timeout: 180_000 }, async () => {
    const root = tmpRepo("mcp-gap-dir");
    dirs.push(root);
    const s = open({ root, dir: root, version: "1.2.3" });

    s.send(""); // blank line ignored
    s.send("{oops"); // parse error
    s.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    s.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    s.send({ jsonrpc: "2.0", method: "ping" });
    s.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    s.send({ jsonrpc: "2.0", method: "tools/list" });
    s.send({ jsonrpc: "2.0", id: 4, method: "prompts/list" });
    s.send({ jsonrpc: "2.0", method: "prompts/list" });
    s.send({ jsonrpc: "2.0", method: "prompts/get", params: { name: "x" } });
    s.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "graft_repo_map" } });
    s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } });
    s.send({ jsonrpc: "2.0", id: 5, method: "no/such/method" });
    s.send({ jsonrpc: "2.0", method: "no/such/notification" });
    s.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "not_a_real_tool", arguments: {} } });
    s.send({ jsonrpc: "2.0", id: 8, method: "prompts/get", params: { name: "missing-prompt" } });
    s.send({ jsonrpc: "2.0", id: 7, method: "ping" });

    const init = await s.waitFor(1);
    assert.equal(init.result.protocolVersion, "2025-03-26");
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(init.result.serverInfo.version, "1.2.3");
    assert.equal(typeof init.result.serverInfo.name, "string");
    assert.equal(typeof init.result.instructions, "string");
    assert.ok(init.result.instructions.length > 0);

    assert.deepEqual((await s.waitFor(2)).result, {});

    const list = await s.waitFor(3);
    assert.ok(Array.isArray(list.result.tools));
    assert.ok(list.result.tools.length > 0, "a --dir override always advertises the repo tools");
    for (const t of list.result.tools) {
      assert.equal(typeof t.name, "string");
      assert.equal(typeof t.description, "string");
      assert.ok(t.inputSchema && typeof t.inputSchema === "object");
    }

    assert.deepEqual((await s.waitFor(4)).result, { prompts: [] });

    const unknown = await s.waitFor(5);
    assert.equal(unknown.error!.code, -32601);
    assert.equal(unknown.error!.message, "method not found: no/such/method");

    const call = await s.waitFor(6);
    assert.equal(call.result.content[0].type, "text");
    assert.equal(typeof call.result.content[0].text, "string");
    assert.ok(call.result.content[0].text.length > 0);
    assert.equal(call.result.isError, true);

    const prompt = await s.waitFor(8);
    if (prompt.error) assert.equal(typeof prompt.error.code, "number");
    else assert.equal(typeof prompt.result, "object");

    assert.deepEqual((await s.waitFor(7)).result, {});

    const parse = s.messages.find((m) => m.error?.code === -32700);
    assert.ok(parse, "parse error reply");
    assert.equal(parse!.id, null);
    assert.equal(parse!.error!.message, "parse error");

    // Notifications never get answers: only the 8 replies above (parse error + ids 1..8).
    assert.equal(s.messages.length, 9);
    for (const m of s.messages) assert.equal(m.jsonrpc, "2.0");

    assert.equal(await s.close(), 0);
  });

  test("no override in an unindexed folder: no tools, default version and protocol", { timeout: 180_000 }, async () => {
    const root = tmpRepo("mcp-gap-bare");
    dirs.push(root);
    const s = open({ root });

    s.send({ jsonrpc: "2.0", id: "a", method: "initialize" });
    s.send({ jsonrpc: "2.0", id: "b", method: "tools/list" });
    s.send({ jsonrpc: "2.0", id: "c", method: "tools/call", params: { name: "graft_check_freshness", arguments: {} } });

    const init = await s.waitFor("a");
    assert.equal(init.result.protocolVersion, "2024-11-05");
    assert.equal(init.result.serverInfo.version, "0");
    assert.deepEqual(init.result.capabilities, { tools: {} });

    const list = await s.waitFor("b");
    assert.deepEqual(list.result.tools, [], "a repo with no graph advertises nothing");

    const call = await s.waitFor("c");
    assert.equal(call.result.content[0].type, "text");
    assert.equal(typeof call.result.content[0].text, "string");

    assert.equal(await s.close(), 0);
  });

  test("brains-only server: not-connected instructions, repo tools refused", { timeout: 180_000 }, async () => {
    const root = tmpRepo("mcp-gap-brains");
    dirs.push(root);
    const s = open({ root, version: "9.9.9", brainsOnly: true });

    s.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    s.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    s.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "graft_find_code", arguments: { query: "x" } } });
    s.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "workspace_only_tool" } });
    s.send({ jsonrpc: "2.0", id: 5, method: "prompts/list" });

    const init = await s.waitFor(1);
    assert.equal(init.result.serverInfo.version, "9.9.9");
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.match(init.result.instructions, /isn't signed in to Trail/);
    assert.match(init.result.instructions, /trail login/);

    assert.deepEqual((await s.waitFor(2)).result, { tools: [] });

    const refused = await s.waitFor(3);
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /workspace's tools only; graft_find_code isn't one/);

    const remote = await s.waitFor(4);
    assert.ok(remote.result && typeof remote.result === "object", "workspace call answered with a result");

    assert.deepEqual((await s.waitFor(5)).result, { prompts: [] });

    assert.equal(await s.close(), 0);
  });
});
