import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http, { type RequestListener } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { startVizServer, type VizServerOptions } from "../src/viz/serve.js";
import { tmpRepo } from "./helpers.js";

class MemoryResponse {
  status = 0;
  headers: Record<string, string> = {};
  body = "";
  ended = false;

  writeHead(status: number, headers: Record<string, string>) {
    this.status = status;
    this.headers = headers;
    return this;
  }

  write(chunk: string | Buffer) {
    this.body += chunk.toString();
    return true;
  }

  end(chunk?: string | Buffer) {
    if (chunk !== undefined) this.write(chunk);
    this.ended = true;
    return this;
  }
}

// Exercise the registered request handler without binding a socket or making
// an HTTP request. File reads and graph assembly still use real fixtures.
class MemoryServer extends EventEmitter {
  readonly attempts: { port: number; host: string }[] = [];
  closed = false;

  constructor(listener: RequestListener, private readonly listenErrors: readonly string[]) {
    super();
    this.on("request", listener);
  }

  listen(port: number, host: string, ready: () => void) {
    const code = this.listenErrors[this.attempts.length];
    this.attempts.push({ port, host });
    queueMicrotask(() => {
      if (code === undefined) ready();
      else this.emit("error", Object.assign(new Error(`listen ${code}`), { code }));
    });
    return this;
  }

  close(done: () => void) {
    this.closed = true;
    queueMicrotask(done);
    return this;
  }

  request(url?: string): MemoryResponse {
    const req = Object.assign(new EventEmitter(), { url });
    const res = new MemoryResponse();
    this.emit("request", req, res);
    return res;
  }
}

function assertJsonError(res: MemoryResponse, message: RegExp) {
  assert.equal(res.status, 404);
  assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(res.ended, true);
  assert.match(JSON.parse(res.body).error, message);
}

describe("viz server request and startup gaps", { concurrency: false }, () => {
  const roots: string[] = [];
  let transport: MemoryServer;
  let listenErrors: readonly string[] = [];

  before(() => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("Unexpected fetch in an in-memory viz server test");
    });
    mock.method(http, "createServer", (listener: RequestListener) => {
      transport = new MemoryServer(listener, listenErrors);
      return transport;
    });
    // serve.ts uses the named ESM export, not the default http object.
    syncBuiltinESMExports();
  });

  after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function fixture(): VizServerOptions {
    const root = tmpRepo("viz-serve-gaps");
    roots.push(root);
    const viewerDir = join(root, "viewer");
    mkdirSync(viewerDir);
    return {
      viewerDir,
      contextDir: join(root, ".context"),
      port: 4831,
      repoName: "gaps-fixture",
    };
  }

  function start(opts: VizServerOptions, errors: readonly string[] = []) {
    listenErrors = errors;
    return startVizServer(opts);
  }

  test("serves viewer assets with their MIME types and ignores query strings", async (t) => {
    const opts = fixture();
    const assets = [
      { file: "index.html", body: "<title>Gap fixture</title>\n", type: "text/html; charset=utf-8" },
      { file: "app.js", body: "export const ready = true;\n", type: "text/javascript; charset=utf-8" },
      { file: "style.css", body: "body { margin: 0; }\n", type: "text/css; charset=utf-8" },
    ];
    for (const { file, body } of assets) writeFileSync(join(opts.viewerDir, file), body);

    const viz = await start(opts);
    t.after(() => viz.close());

    for (const { file, body, type } of assets) {
      const path = `/${file}?v=fixture`;
      const res = transport.request(path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers["content-type"], type, path);
      assert.equal(res.body, body, path);
      assert.equal(res.ended, true, path);
    }

    // A request event with no URL uses the same entry point as GET /.
    const fallback = transport.request();
    assert.equal(fallback.status, 200);
    assert.equal(fallback.headers["content-type"], assets[0].type);
    assert.equal(fallback.body, assets[0].body);
  });

  test("distinguishes a missing bundle asset from an unknown route", async (t) => {
    const viz = await start(fixture());
    t.after(() => viz.close());

    const missingAsset = transport.request("/style.css");
    assert.equal(missingAsset.status, 404);
    assert.equal(missingAsset.headers["content-type"], "text/plain");
    assert.match(missingAsset.body, /viewer bundle missing.*package build/);

    const unknown = transport.request("/favicon.ico");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.headers["content-type"], "text/plain");
    assert.equal(unknown.body, "not found");
  });

  test("assembles a context graph with the configured repo name", async (t) => {
    const opts = fixture();
    mkdirSync(opts.contextDir);
    writeFileSync(
      join(opts.contextDir, "alpha.md"),
      "---\nname: Alpha\nslug: alpha\ntype: system\nsources: []\nlinks: []\n---\nbody\n",
    );

    const viz = await start(opts);
    t.after(() => viz.close());

    const res = transport.request("/api/context-graph?fresh=1");
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(res.ended, true);
    const graph = JSON.parse(res.body);
    assert.equal(graph.meta.repoName, opts.repoName);
    assert.equal(graph.meta.nodeCount, 1);
    assert.deepEqual(graph.nodes.map((node: { id: string }) => node.id), ["alpha"]);
  });

  test("serves a supported wiring graph and reports why other reads fail", async (t) => {
    const opts = fixture();
    const graphDir = join(opts.contextDir, ".graph");
    mkdirSync(graphDir, { recursive: true });
    const file = join(graphDir, "wiring.json");

    const viz = await start(opts);
    t.after(() => viz.close());
    const requestGraph = () => transport.request("/api/code-graph");

    assertJsonError(requestGraph(), /no wiring graph/);

    writeFileSync(file, '{"meta":');
    assertJsonError(requestGraph(), /wiring\.json is unreadable/);

    const graph = {
      meta: { version: 1, nodeCount: 0, edgeCount: 0, languages: [] },
      nodes: [],
      edges: [],
    };
    writeFileSync(file, JSON.stringify({ ...graph, meta: { ...graph.meta, version: 2 } }));
    assertJsonError(requestGraph(), /unsupported version/);

    writeFileSync(file, JSON.stringify(graph));
    const supported = requestGraph();
    assert.equal(supported.status, 200);
    assert.equal(supported.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(supported.ended, true);
    const parsed = JSON.parse(supported.body);
    assert.equal(parsed.meta.version, 1);
    assert.deepEqual(parsed.nodes, []);
    assert.deepEqual(parsed.edges, []);
  });

  test("retries a busy loopback port and ends an open event stream on close", async () => {
    const opts = fixture();
    const viz = await start(opts, ["EADDRINUSE"]);
    let stream: MemoryResponse;
    try {
      assert.deepEqual(transport.attempts, [
        { port: opts.port, host: "127.0.0.1" },
        { port: opts.port + 1, host: "127.0.0.1" },
      ]);
      assert.equal(viz.url, `http://127.0.0.1:${opts.port + 1}`);

      stream = transport.request("/events");
      assert.equal(stream.status, 200);
      assert.equal(stream.headers["content-type"], "text/event-stream");
      assert.equal(stream.body, ": connected\n\n");
      assert.equal(stream.ended, false);
    } finally {
      await viz.close();
    }
    assert.equal(stream.ended, true);
    assert.equal(transport.closed, true);
  });

  test("reports the attempted range when all ten ports are busy", async () => {
    const opts = fixture();
    await assert.rejects(start(opts, Array<string>(10).fill("EADDRINUSE")), {
      message: `no free port in ${opts.port}–${opts.port + 9}`,
    });
    assert.deepEqual(
      transport.attempts.map(({ port }) => port),
      Array.from({ length: 10 }, (_, i) => opts.port + i),
    );
  });

  test("propagates a non-address-in-use listen error without retrying", async () => {
    const opts = fixture();
    await assert.rejects(start(opts, ["EACCES"]), { code: "EACCES" });
    assert.deepEqual(transport.attempts, [{ port: opts.port, host: "127.0.0.1" }]);
  });
});
