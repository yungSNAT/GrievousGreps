import { test, describe, before, after, mock } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceConnector, connectorUrl } from "../src/mcp/connector.js";
import * as workspace from "../src/cloud/workspace.js";

const BASE = "https://team.trailhq.com";
const TOKEN = "trl_connector_test";
const PROTOCOL = "2025-06-18";
const INITIALIZED = "notifications/initialized";

type Post = {
  url: string;
  init: RequestInit;
  headers: Headers;
  body: { id?: number; method: string; params?: Record<string, unknown> };
};

function mockWorkspace(t: TestContext, respond: (post: Post) => Response): Post[] {
  const posts: Post[] = [];
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.ok(typeof init?.body === "string", "expected a JSON request body");
      const post = {
        url: String(input),
        init,
        headers: new Headers(init.headers),
        body: JSON.parse(init.body),
      };
      posts.push(post);
      return respond(post);
    },
  );
  t.after(() => fetchMock.mock.restore());
  return posts;
}

function reply(post: Post, result: unknown, headers?: HeadersInit): Response {
  return Response.json({ jsonrpc: "2.0", id: post.body.id, result }, { headers });
}

function accepted(): Response {
  return new Response(null, { status: 202 });
}

function stateless(respond: (post: Post) => Response) {
  return (post: Post): Response => {
    if (post.body.method === "initialize") return reply(post, {});
    if (post.body.method === INITIALIZED) return accepted();
    return respond(post);
  };
}

function setEnv(t: TestContext, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    process.env[key] = value;
  }
}

describe("WorkspaceConnector offline gaps", { concurrency: false }, () => {
  let scratch: string;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "mcp-connector-gaps-"));
  });

  after(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  function machine() {
    const home = mkdtempSync(join(scratch, "home-"));
    const trailHome = join(home, ".trail");
    mkdirSync(trailHome);
    const env = { HOME: home, USERPROFILE: home, TRAIL_HOME: trailHome };

    return {
      home,
      env,
      pair(token = TOKEN) {
        const now = new Date().toISOString();
        const cloud = {
          url: BASE,
          token,
          tokenId: "tok_connector_test",
          workspace: { id: "ws_gaps", slug: "gaps", name: "Connector Tests" },
          email: "connector@example.test",
          user: { id: "user_gaps", email: "connector@example.test" },
          pairedAt: now,
          connectedAt: now,
          repos: [],
        };
        type Save = (value: typeof cloud, env: NodeJS.ProcessEnv) => void;
        const store = workspace as typeof workspace & {
          writeClouds?: (value: (typeof cloud)[], env: NodeJS.ProcessEnv) => void;
          writeCloud?: Save;
          saveCloud?: Save;
        };
        const matches = () => workspace.readClouds(env)[0]?.token === token;

        if (store.writeClouds) {
          store.writeClouds([cloud], env);
        } else {
          const save = store.writeCloud ?? store.saveCloud;
          if (save) {
            save(cloud, env);
          } else {
            // Check the fixture through the pairing reader before testing the
            // connector, so an unreadable fixture cannot pass as an RPC error.
            const layouts = [
              ["cloud.json", cloud],
              ["cloud.json", [cloud]],
              ["cloud.json", { version: 1, clouds: [cloud] }],
              ["cloud.json", { version: 1, connections: [cloud] }],
              ["clouds.json", [cloud]],
              ["clouds.json", { version: 1, clouds: [cloud] }],
            ] as const;
            for (const [file, data] of layouts) {
              const path = join(trailHome, file);
              writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
              if (matches()) break;
              rmSync(path);
            }
          }
        }
        assert.equal(matches(), true, "the scratch machine has the requested pairing");
      },
      unpair() {
        rmSync(home, { recursive: true, force: true });
      },
    };
  }

  function pairedConnector() {
    const m = machine();
    m.pair();
    return new WorkspaceConnector({ env: m.env, cwd: m.home });
  }

  test("the default URL resolver accepts a same-origin override and rejects a different origin", (t) => {
    const override = `${BASE}/connector/v2`;
    setEnv(t, { TRAIL_MCP_URL: override });
    assert.equal(connectorUrl({ url: BASE }), override);
    process.env.TRAIL_MCP_URL = "https://other.example/mcp";
    assert.equal(connectorUrl({ url: BASE }), `${BASE}/mcp`);
    assert.equal(connectorUrl({ url: "not an address" }), null);
  });

  test("the default connector observes sign-in, token replacement, and logout", async (t) => {
    const m = machine();
    const override = `${BASE}/connector/v2`;
    setEnv(t, { ...m.env, TRAIL_MCP_URL: override });
    const posts = mockWorkspace(t, (post) => {
      if (post.body.method === "initialize") {
        return reply(post, {
          instructions: post.headers.get("authorization") === `Bearer ${TOKEN}`
            ? "Original team guidance"
            : "Updated team guidance",
        });
      }
      assert.equal(post.body.method, INITIALIZED);
      return accepted();
    });

    const c = new WorkspaceConnector();
    c.warm();
    assert.equal(c.connected(), false);
    assert.equal(c.started(), false);
    assert.equal(await c.listTools(), null);
    const unpaired = await c.callTool("get_context", {});
    assert.equal(unpaired.isError, true);
    assert.match(unpaired.content[0]?.text ?? "", /run `trail login`/);
    assert.equal(posts.length, 0);

    m.pair();
    assert.equal(c.connected(), true);
    c.warm();
    assert.equal(await c.instructions(), "Original team guidance");
    assert.equal(c.started(), true);
    assert.deepEqual(posts.map((p) => p.body.method), ["initialize", INITIALIZED]);
    assert.equal(posts[0]?.url, override);
    assert.deepEqual(posts[0]?.body.params?.clientInfo, { name: "trail", version: "0" });

    const replacement = "trl_connector_replacement";
    m.pair(replacement);
    assert.equal(await c.instructions(), "Updated team guidance");
    assert.deepEqual(
      posts.filter((p) => p.body.method === "initialize").map((p) => p.headers.get("authorization")),
      [`Bearer ${TOKEN}`, `Bearer ${replacement}`],
    );

    const count = posts.length;
    m.unpair();
    assert.equal(c.connected(), false);
    assert.equal(await c.instructions(), "");
    assert.equal(await c.listPrompts(), null);
    const prompt = await c.getPrompt("team-style", {});
    assert.ok("error" in prompt);
    assert.equal(prompt.error.code, -32603);
    assert.match(prompt.error.message, /run `trail login`/);
    assert.equal(posts.length, count, "logout prevents reuse of the cached session");
  });

  test("an SSE handshake skips unrelated events and negotiates headers for paged prompts", async (t) => {
    const m = machine();
    m.pair();
    const protocol = "2024-11-05";
    const skill = { name: "team-style", description: "Team style guide", arguments: [{ name: "topic" }] };
    const posts = mockWorkspace(t, (post) => {
      switch (post.body.method) {
        case "initialize": {
          const result = JSON.stringify({ protocolVersion: protocol, instructions: "Read the team skills." });
          const text = [
            ": keep-alive",
            "data: {incomplete",
            'data: {"jsonrpc":"2.0","id":999,"result":{"instructions":"Wrong reply"}}',
            `event: message\r\ndata: {"jsonrpc":"2.0","id":${post.body.id},\r\ndata: "result":${result}}`,
          ].join("\r\n\r\n");
          return new Response(text, {
            headers: { "content-type": "text/event-stream", "mcp-session-id": "workspace-session" },
          });
        }
        case INITIALIZED:
          throw new TypeError("notification transport closed");
        case "prompts/list":
          if (post.body.params?.cursor === "page-two") {
            return reply(post, { prompts: { name: "not an array" }, nextCursor: "" });
          }
          return Response.json([
            null,
            { jsonrpc: "2.0", id: post.body.id },
            { jsonrpc: "2.0", method: "notifications/prompts/list_changed" },
            { jsonrpc: "2.0", id: post.body.id, result: {
              prompts: [null, { name: 123 }, skill], nextCursor: "page-two",
            } },
          ]);
        default:
          throw new Error(`Unexpected request: ${post.body.method}`);
      }
    });

    const c = new WorkspaceConnector({ env: m.env, cwd: m.home, version: "1.2.3" });
    assert.equal(await c.instructions(), "Read the team skills.");
    assert.deepEqual(await c.listPrompts(), [skill]);
    assert.deepEqual(posts.map((p) => p.body.method), [
      "initialize", INITIALIZED, "prompts/list", "prompts/list",
    ]);
    assert.deepEqual(posts[0]?.body.params, {
      protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "trail", version: "1.2.3" },
    });
    assert.equal(posts[0]?.headers.has("mcp-session-id"), false);
    assert.equal(posts[0]?.headers.has("mcp-protocol-version"), false);
    assert.equal(posts[1]?.body.id, undefined);
    for (const post of posts) {
      assert.equal(post.init.method, "POST");
      assert.equal(post.init.redirect, "error");
      assert.equal(post.headers.get("authorization"), `Bearer ${TOKEN}`);
    }
    for (const post of posts.slice(1)) {
      assert.equal(post.headers.get("mcp-session-id"), "workspace-session");
      assert.equal(post.headers.get("mcp-protocol-version"), protocol);
    }
    assert.deepEqual(posts.slice(2).map((p) => p.body.params), [{}, { cursor: "page-two" }]);
  });

  test("listing stops after twenty pages when the workspace never stops paging", async (t) => {
    const cursors: unknown[] = [];
    const posts = mockWorkspace(t, stateless((post) => {
      assert.equal(post.body.method, "tools/list");
      cursors.push(post.body.params?.cursor);
      const page = cursors.length;
      return reply(post, { tools: [{ name: `tool-${page}` }], nextCursor: `page-${page + 1}` });
    }));

    const tools = await pairedConnector().listTools();
    assert.deepEqual(tools?.map((tool) => tool.name), Array.from({ length: 20 }, (_, i) => `tool-${i + 1}`));
    assert.deepEqual(cursors, [undefined, ...Array.from({ length: 19 }, (_, i) => `page-${i + 2}`)]);
    assert.equal(posts.filter((p) => p.body.method === "initialize").length, 1);
    assert.equal(posts[2]?.headers.get("mcp-protocol-version"), PROTOCOL);
    assert.equal(posts[2]?.headers.has("mcp-session-id"), false);
  });

  for (const [status, recovers] of [[404, true], [400, false]] as const) {
    test(`HTTP ${status} in a session causes one restart and one replay`, async (t) => {
      let sessions = 0;
      const result = {
        content: [{ type: "text", text: "Team context" }],
        structuredContent: { source: "workspace" },
        isError: false,
      };
      const posts = mockWorkspace(t, (post) => {
        switch (post.body.method) {
          case "initialize":
            return reply(post, {}, { "mcp-session-id": `session-${++sessions}` });
          case INITIALIZED:
            return accepted();
          case "tools/call":
            return recovers && post.headers.get("mcp-session-id") === "session-2"
              ? reply(post, result)
              : new Response(null, { status });
          default:
            throw new Error(`Unexpected request: ${post.body.method}`);
        }
      });

      const args = { query: "release process" };
      const actual = await pairedConnector().callTool("get_context", args);
      if (recovers) {
        assert.deepEqual(actual, result);
      } else {
        assert.equal(actual.isError, true);
        assert.match(actual.content[0]?.text ?? "", /dropped the session.*repo tools still work/);
      }
      assert.deepEqual(posts.map((p) => p.body.method), [
        "initialize", INITIALIZED, "tools/call", "initialize", INITIALIZED, "tools/call",
      ]);
      const calls = posts.filter((p) => p.body.method === "tools/call");
      assert.deepEqual(calls.map((p) => p.headers.get("mcp-session-id")), ["session-1", "session-2"]);
      const params = { name: "get_context", arguments: args };
      assert.deepEqual(calls.map((p) => p.body.params), [params, params]);
      assert.notEqual(calls[0]?.body.id, calls[1]?.body.id);
    });
  }

  for (const [status, reason] of [[403, /refused this laptop's sign-in/], [404, /older version/]] as const) {
    test(`initialize HTTP ${status} reports refusal and allows a retry after back-off`, async (t) => {
      const c = pairedConnector();
      const start = Date.now();
      let now = start;
      const clock = mock.method(Date, "now", () => now);
      t.after(() => clock.mock.restore());

      const posts = mockWorkspace(t, (post) => {
        if (post.body.method === "initialize") {
          return now < start + 30_000
            ? new Response(null, { status })
            : reply(post, { instructions: "Workspace is ready." });
        }
        assert.equal(post.body.method, INITIALIZED);
        return accepted();
      });

      assert.equal(c.refusal(), null);
      assert.equal(await c.instructions(), "");
      assert.equal(c.started(), false);
      assert.match(c.refusal() ?? "", reason);

      now += 29_999;
      assert.equal(await c.listTools(), null);
      assert.deepEqual(posts.map((p) => p.body.method), ["initialize"]);

      now += 1;
      assert.equal(await c.instructions(), "Workspace is ready.");
      assert.equal(c.started(), true);
      assert.equal(c.refusal(), null);
      assert.deepEqual(posts.map((p) => p.body.method), ["initialize", "initialize", INITIALIZED]);
    });
  }

  test("RPC errors retain their meaning and unreadable responses become soft errors", async (t) => {
    const posts = mockWorkspace(t, stateless((post) => {
      const id = post.body.id;
      const rpcError = (error: object) => Response.json({ jsonrpc: "2.0", id, error });
      switch (post.body.params?.name) {
        case "unknown-tool":
          return rpcError({ code: -32601, message: "No such tool" });
        case "count":
          return reply(post, { count: 2 });
        case "empty":
          return reply(post, null);
        case "offline":
          throw new TypeError("fetch failed");
        case "bad-arguments":
          return rpcError({ code: -32602, message: "Topic is required" });
        case "incomplete-error":
          return rpcError({ code: "INVALID" });
        case "bad-json":
          return new Response("{invalid json", { headers: { "content-type": "application/json" } });
        case "unmatched-batch":
          return Response.json([{ jsonrpc: "2.0", id: -1, result: {} }]);
        case "unfinished-stream":
          return new Response(": keep-alive\n\n", { headers: { "content-type": "text/event-stream" } });
        case "bad-request":
          return new Response(null, { status: 400 });
        default:
          throw new Error(`Unexpected request: ${post.body.method}`);
      }
    }));

    const c = pairedConnector();
    assert.deepEqual(await c.callTool("unknown-tool", {}), {
      isError: true, content: [{ type: "text", text: "the Trail workspace said: No such tool" }],
    });
    assert.deepEqual(await c.callTool("count", {}), { content: [{ type: "text", text: '{"count":2}' }] });
    assert.deepEqual(await c.callTool("empty", {}), { content: [{ type: "text", text: "null" }] });
    const offline = await c.callTool("offline", {});
    assert.equal(offline.isError, true);
    assert.match(offline.content[0]?.text ?? "", /couldn't reach your Trail workspace.*repo tools still work/);
    assert.deepEqual(await c.getPrompt("bad-arguments", {}), {
      error: { code: -32602, message: "Topic is required" },
    });
    assert.deepEqual(await c.getPrompt("incomplete-error", {}), {
      error: { code: -32603, message: "the Trail workspace returned an error" },
    });
    for (const name of ["bad-json", "unmatched-batch", "unfinished-stream"]) {
      assert.deepEqual(await c.getPrompt(name, {}), {
        error: { code: -32603, message: "the Trail workspace sent an answer trail could not read" },
      });
    }
    assert.deepEqual(await c.getPrompt("bad-request", {}), {
      error: { code: -32603, message: "the Trail workspace answered 400" },
    });
    assert.equal(posts.filter((p) => p.body.method === "initialize").length, 1, "a stateless 400 does not restart");
  });
});
