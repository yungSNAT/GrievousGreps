import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createApp, type AppConfig } from "../src/app/server.js";
import { jobKey, type ReviewJob } from "../src/app/events.js";
import { tmpRepo } from "./helpers.js";

const secret = "test-webhook-secret";
const api = "https://github-api.example";
const publicUrl = "https://viewer.example/";
const installationToken = "offline-installation-token";
const job: ReviewJob = {
  installationId: 5,
  owner: "NanoNets",
  repo: "Graft",
  number: 7,
  baseRef: "main",
  headSha: "abc",
  fromFork: false,
};

type App = ReturnType<typeof createApp>;
type ResponseRecord = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

// Exercise the registered handler with a streaming body, without listening on
// a port or making an HTTP request.
function dispatch(
  app: App,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  chunks: Buffer[] = [],
): Promise<ResponseRecord> {
  const req = Object.assign(Readable.from(chunks), { method, url, headers });
  return new Promise((resolve) => {
    let status = 200;
    let responseHeaders: Record<string, string> = {};
    const res = {
      headersSent: false,
      writeHead(code: number, fields: Record<string, string>) {
        status = code;
        responseHeaders = fields;
        this.headersSent = true;
        return this;
      },
      end(body: string) {
        resolve({ status, headers: responseHeaders, body });
        return this;
      },
    };
    assert.equal(app.server.emit("request", req, res), true);
  });
}

function delivery(number = job.number): Buffer {
  const fullName = `${job.owner}/${job.repo}`;
  return Buffer.from(JSON.stringify({
    action: "opened",
    installation: { id: job.installationId },
    repository: { name: job.repo, owner: { login: job.owner } },
    pull_request: {
      number,
      draft: false,
      state: "open",
      base: { ref: job.baseRef, repo: { full_name: fullName } },
      head: { sha: job.headSha, repo: { full_name: fullName } },
    },
  }));
}

function signature(body: Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function webhook(app: App, body: Buffer): Promise<ResponseRecord> {
  return dispatch(app, "POST", "/webhook", {
    "x-github-event": "pull_request",
    "x-hub-signature-256": signature(body),
  }, [body]);
}

describe("app server gaps", () => {
  let scratch: string | undefined;
  let config: AppConfig;
  const tokenUrl = `${api}/app/installations/${job.installationId}/access_tokens`;
  const fetchCalls: Array<{ url: string; method: string }> = [];

  before(() => {
    scratch = tmpRepo("app-server-gaps");
    const pageDir = join(scratch, "pages");
    mkdirSync(pageDir);
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    config = {
      appId: "1",
      privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      webhookSecret: secret,
      publicUrl,
      api,
      pageDir,
    };

    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      fetchCalls.push({ url, method });
      if (url !== tokenUrl || method !== "POST") {
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }
      return Response.json({
        token: installationToken, // nosemgrep -- a fake token from the offline GitHub stand-in
        expires_at: "2099-01-01T00:00:00Z",
      }, { status: 201 });
    });
  });

  after(() => {
    mock.restoreAll();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  test("a queued review gets an installation token and publishes a page that survives restart", async (t) => {
    const logs: string[] = [];
    t.mock.method(console, "log", (message: string) => { logs.push(message); });
    const firstFetch = fetchCalls.length;
    const reviewed: ReviewJob[] = [];
    const html = "<h1>Impact preview</h1>";
    let token: string | undefined;
    let published: string | undefined;

    // Omit the fetch and log seams so the app uses the mocked globals.
    const app = createApp(config, {
      review: async (received, deps) => {
        reviewed.push(received);
        token = await deps.token(received.installationId);
        published = await deps.publish?.(received, html);
        return { commentUrl: null, areas: 2, affected: 3, viewerUrl: published ?? null };
      },
    });

    const accepted = await webhook(app, delivery());
    await app.queue.drain();
    assert.equal(accepted.status, 202);
    assert.deepEqual(JSON.parse(accepted.body), { queued: true });
    assert.deepEqual(reviewed, [job]);
    assert.deepEqual(fetchCalls.slice(firstFetch), [{ url: tokenUrl, method: "POST" }]);
    assert.equal(token, installationToken);
    assert.ok(logs.includes(`${jobKey(job)}: queued`));
    const completion = `${jobKey(job)}: 2 changed → 3 affected in `;
    const completed = logs.find((line) => line.startsWith(completion));
    assert.ok(completed, "the default logger reports the completed review");
    assert.match(completed.slice(completion.length), /^\d+ms$/);

    assert.equal(app.pages.size, 1);
    assert.ok(published, "the reviewer received a page link");
    const link = new URL(published);
    assert.equal(link.origin, new URL(publicUrl).origin);
    assert.match(link.pathname, /^\/p\/[^/]+$/);
    assert.match(link.searchParams.get("t") ?? "", /^[a-f0-9]{32}$/);

    const restarted = createApp(config);
    const page = await dispatch(restarted, "GET", link.pathname + link.search);
    assert.equal(page.status, 200);
    assert.equal(page.body, html);
    assert.match(page.headers["cache-control"] ?? "", /\bprivate\b/);
    assert.equal((await dispatch(restarted, "GET", link.pathname)).status, 404);
  });

  test("review failures are logged for both Error and string rejections, and later work completes", async () => {
    const logs: string[] = [];
    const completed: number[] = [];
    const app = createApp({ ...config, log: (line) => logs.push(line) }, {
      fetch: async () => { throw new Error("this reviewer does not need GitHub"); },
      review: async (received) => {
        if (received.number === 7) throw new Error("review failed");
        if (received.number === 8) throw "review cancelled";
        completed.push(received.number);
        return { commentUrl: null, areas: 0, affected: 0, viewerUrl: null };
      },
    });

    for (const number of [7, 8, 9]) {
      const response = await webhook(app, delivery(number));
      await app.queue.drain();
      assert.equal(response.status, 202, `delivery for PR ${number} was accepted`);
    }

    assert.deepEqual(logs.filter((line) => line.includes(": FAILED ")), [
      `${jobKey({ ...job, number: 7 })}: FAILED review failed`,
      `${jobKey({ ...job, number: 8 })}: FAILED review cancelled`,
    ]);
    assert.deepEqual(completed, [9]);
    assert.equal(app.queue.size, 0);
  });

  test("the webhook accepts exactly 2 MiB but rejects one byte over the limit", async () => {
    const reviewed: ReviewJob[] = [];
    const app = createApp({ ...config, log: () => {} }, {
      review: async (received) => {
        reviewed.push(received);
        return { commentUrl: null, areas: 0, affected: 0, viewerUrl: null };
      },
    });
    const payload = delivery();
    const padding = Buffer.alloc(2 * 1024 * 1024 - payload.length, 0x20);
    const boundary = Buffer.concat([payload, padding]);
    const extra = Buffer.from(" ");
    const oversized = await dispatch(app, "POST", "/webhook", {
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature(Buffer.concat([boundary, extra])),
    }, [payload, padding, extra]);

    await app.queue.drain();
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body, "payload too large");
    assert.deepEqual(reviewed, [], "even a correctly signed oversized body is not queued");

    const accepted = await dispatch(app, "POST", "/webhook", {
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature(boundary),
    }, [payload, padding]);
    await app.queue.drain();
    assert.equal(accepted.status, 202);
    assert.deepEqual(reviewed, [job]);
  });

  test("a valid signature does not make malformed JSON or a missing event reviewable", async () => {
    const reviewed: ReviewJob[] = [];
    const app = createApp({ ...config, log: () => {} }, {
      review: async (received) => {
        reviewed.push(received);
        return { commentUrl: null, areas: 0, affected: 0, viewerUrl: null };
      },
    });

    const malformed = await webhook(app, Buffer.from('{"action":'));
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body, "bad json");

    const body = delivery();
    const noEvent = await dispatch(app, "POST", "/webhook", {
      "x-hub-signature-256": signature(body),
    }, [body]);
    assert.equal(noEvent.status, 204);
    assert.equal(noEvent.body, "");
    await app.queue.drain();
    assert.deepEqual(reviewed, []);
  });

  test("a malformed request target produces a generic error and logs the failure", async () => {
    const logs: string[] = [];
    const app = createApp({ ...config, log: (line) => logs.push(line) });

    const response = await dispatch(app, "GET", "http://[");
    assert.equal(response.status, 500);
    assert.equal(response.body, "internal error");
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^request failed: .+/);
  });
});
