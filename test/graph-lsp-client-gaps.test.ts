/**
 * LspClient against a small fake language server (a Node script speaking LSP framing over
 * stdio): initialize, the reverse requests every server makes at startup, didOpen,
 * call-hierarchy queries (answers, errors, a wedged server), readiness polling, dispose,
 * and servers that are missing or exit at once.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LspClient, type CallHierarchyItem } from "../src/graph/lsp/client.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SERVER = String.raw`
const fs = require("fs");
const logFile = process.argv[2];
const log = (m) => fs.appendFileSync(logFile, JSON.stringify(m) + "\n");
log({ pid: process.pid });
const send = (msg) => { const s = JSON.stringify(msg); process.stdout.write("Content-Length: " + Buffer.byteLength(s) + "\r\n\r\n" + s); };
const item = (uri, name) => ({ name, kind: 12, uri,
  range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
  selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 13 } } });
function handle(msg) {
  log(msg);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: "cfg", method: "workspace/configuration", params: { items: [{ section: "a" }, { section: "b" }] } });
    send({ jsonrpc: "2.0", id: "reg", method: "client/registerCapability", params: { registrations: [] } });
    send({ jsonrpc: "2.0", id: "prog", method: "window/workDoneProgress/create", params: { token: "t" } });
    send({ jsonrpc: "2.0", id: "edit", method: "workspace/applyEdit", params: { edit: {} } });
    send({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: "hi" } });
    process.stderr.write("chatty server\n");
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { callHierarchyProvider: true } } });
  } else if (msg.method === "textDocument/prepareCallHierarchy") {
    const line = msg.params.position.line;
    if (line === 99) return; // wedged: never answers
    if (line === 5) return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "boom" } });
    send({ jsonrpc: "2.0", id: msg.id, result: line === 0 ? [item(msg.params.textDocument.uri, "main")] : null });
  } else if (msg.method === "callHierarchy/outgoingCalls") {
    send({ jsonrpc: "2.0", id: msg.id, result: [{ to: item(msg.params.item.uri, "helper"), fromRanges: [] }, { fromRanges: [] }] });
  } else if (msg.method && msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  }
}
let buf = Buffer.alloc(0);
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const i = buf.indexOf("\r\n\r\n");
    if (i < 0) return;
    const m = /Content-Length: *(\d+)/i.exec(buf.subarray(0, i).toString());
    const len = Number(m[1]);
    if (buf.length < i + 4 + len) return;
    const msg = JSON.parse(buf.subarray(i + 4, i + 4 + len).toString());
    buf = buf.subarray(i + 4 + len);
    handle(msg);
  }
});
`;

let dir = "";
before(() => { dir = mkdtempSync(join(tmpdir(), "graft-lsp-gaps-")); });
after(async () => {
  for (let i = 0; ; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch (e) { if (i >= 40) throw e; await sleep(100); }
  }
});

type Msg = Record<string, any>;
function readLog(file: string): Msg[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
async function waitFor(file: string, pred: (msgs: Msg[]) => boolean, ms = 10000): Promise<Msg[]> {
  const end = Date.now() + ms;
  for (;;) {
    const msgs = readLog(file);
    if (pred(msgs) || Date.now() > end) return msgs;
    await sleep(25);
  }
}

describe("LspClient with a fake language server", () => {
  let client: LspClient;
  let logFile = "";
  let fileA = "";
  let fileB = "";
  let initResult = false;
  let earlyItems: CallHierarchyItem[] = [];

  before(async () => {
    const script = join(dir, "fake-server.cjs");
    writeFileSync(script, SERVER);
    logFile = join(dir, "server-log.jsonl");
    fileA = join(dir, "a.js");
    fileB = join(dir, "b.js");
    writeFileSync(fileA, "function main() {\n  helper();\n}\n");
    writeFileSync(fileB, "export const b = 1;\n");
    client = new LspClient(process.execPath, [script, logFile], dir, "javascript", 300);
    // Not initialized yet: queries and opens are no-ops.
    earlyItems = await client.prepareCallHierarchy(fileA, { line: 0, character: 9 });
    client.didOpen(fileB);
    initResult = await client.initialize();
  });

  after(async () => { await client.dispose(); });

  test("before initialize nothing is sent; initialize succeeds and sends initialized", async () => {
    assert.deepEqual(earlyItems, []);
    assert.equal(initResult, true);
    const msgs = await waitFor(logFile, (m) => m.some((x) => x.method === "initialized"));
    const init = msgs.find((x) => x.method === "initialize");
    assert.ok(init, "initialize was sent");
    assert.equal(init!.params.rootUri, pathToFileURL(dir).toString());
    assert.equal(init!.params.workspaceFolders[0].uri, pathToFileURL(dir).toString());
    assert.ok(msgs.some((x) => x.method === "initialized"));
    assert.ok(!msgs.some((x) => x.method === "textDocument/didOpen" && x.params.textDocument.uri === pathToFileURL(fileB).toString()),
      "the didOpen before initialize was dropped");
  });

  test("the server's startup reverse requests get default answers", async () => {
    const isReply = (id: string) => (x: Msg) => x.id === id && !x.method;
    const msgs = await waitFor(logFile, (m) => ["cfg", "reg", "prog", "edit"].every((id) => m.some(isReply(id))));
    assert.deepEqual(msgs.find(isReply("cfg"))!.result, [{}, {}], "one empty config per item");
    assert.equal(msgs.find(isReply("reg"))!.result, null);
    assert.equal(msgs.find(isReply("prog"))!.result, null);
    assert.deepEqual(msgs.find(isReply("edit"))!.result, { applied: false });
  });

  test("didOpen sends the document once, with its text and language; missing files are skipped", async () => {
    client.didOpen(fileA);
    client.didOpen(fileA);
    client.didOpen(join(dir, "missing.js"));
    // A round trip orders the log after the notifications.
    await client.prepareCallHierarchy(fileA, { line: 0, character: 9 });
    const opens = (await waitFor(logFile, (m) => m.some((x) => x.method === "textDocument/didOpen")))
      .filter((x) => x.method === "textDocument/didOpen");
    assert.equal(opens.length, 1);
    const doc = opens[0].params.textDocument;
    assert.equal(doc.uri, pathToFileURL(fileA).toString());
    assert.equal(doc.languageId, "javascript");
    assert.equal(doc.version, 1);
    assert.equal(doc.text, readFileSync(fileA, "utf8"));
  });

  test("prepareCallHierarchy: items, null → [], error → [], wedged server → [] after the timeout", async () => {
    const items = await client.prepareCallHierarchy(fileA, { line: 0, character: 9 });
    assert.equal(items.length, 1);
    assert.equal(items[0].name, "main");
    assert.equal(items[0].uri, pathToFileURL(fileA).toString());
    assert.deepEqual(await client.prepareCallHierarchy(fileA, { line: 3, character: 0 }), []);
    assert.deepEqual(await client.prepareCallHierarchy(fileA, { line: 5, character: 0 }), []);
    const t0 = Date.now();
    assert.deepEqual(await client.prepareCallHierarchy(fileA, { line: 99, character: 0 }), []);
    assert.ok(Date.now() - t0 >= 250, "waited for the per-call timeout");
  });

  test("outgoingCalls returns each call's target, dropping entries without one", async () => {
    const [item] = await client.prepareCallHierarchy(fileA, { line: 0, character: 9 });
    const callees = await client.outgoingCalls(item);
    assert.deepEqual(callees.map((c) => c.name), ["helper"]);
  });

  test("waitUntilReady: true once the probe answers, false when the budget is zero", async () => {
    assert.equal(await client.waitUntilReady(fileA, { line: 0, character: 9 }), true);
    assert.equal(await client.waitUntilReady(fileA, { line: 3, character: 0 }, 0), false);
  });

  test("dispose stops queries and kills the server", async () => {
    const pid = readLog(logFile).find((x) => typeof x.pid === "number")!.pid as number;
    const [item] = await client.prepareCallHierarchy(fileA, { line: 0, character: 9 });
    await client.dispose();
    assert.deepEqual(await client.prepareCallHierarchy(fileA, { line: 0, character: 9 }), []);
    assert.deepEqual(await client.outgoingCalls(item), []);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 100 && alive(); i++) await sleep(50);
    assert.equal(alive(), false, "the server process is gone");
  });
});

test("a server that doesn't exist: initialize returns false and queries return nothing", async () => {
  const client = new LspClient(join(dir, "no-such-language-server"), ["--stdio"], dir, "javascript", 300);
  try {
    assert.equal(await client.initialize(), false);
    assert.deepEqual(await client.prepareCallHierarchy(join(dir, "x.js"), { line: 0, character: 0 }), []);
    assert.equal(await client.waitUntilReady(join(dir, "x.js"), { line: 0, character: 0 }, 0), false);
  } finally {
    await client.dispose();
  }
});

test("a server that has already exited when initialize runs is reported as failed", async () => {
  const client = new LspClient(process.execPath, ["-e", "process.exit(3)"], dir, "javascript", 300);
  try {
    await sleep(1500); // let the exit event land first
    const t0 = Date.now();
    assert.equal(await client.initialize(), false);
    assert.ok(Date.now() - t0 < 10000, "bailed without waiting on an initialize response");
    const item: CallHierarchyItem = {
      name: "f", kind: 12, uri: pathToFileURL(join(dir, "x.js")).toString(),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    };
    assert.deepEqual(await client.outgoingCalls(item), []);
    assert.deepEqual(await client.prepareCallHierarchy(join(dir, "x.js"), { line: 0, character: 0 }), []);
  } finally {
    await client.dispose();
  }
});
