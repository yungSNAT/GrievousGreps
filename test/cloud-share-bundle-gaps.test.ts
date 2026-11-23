import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  deleteCode,
  newSentState,
  parseDeleteCode,
  prepareBundle,
  readManifest,
  readSent,
  slug,
  unfinishedCopy,
  writeSent,
  type Manifest,
} from "../src/cloud/share-bundle.js";

void mock;

let scratch: string;
let savedConfigDir: string | undefined;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "share-bundle-gaps-"));
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
});

after(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  rmSync(scratch, { recursive: true, force: true });
});

/** A fresh empty home whose Claude config folder is its own `.claude`. */
function freshHome(tag: string): string {
  const home = join(scratch, `home-${tag}`);
  mkdirSync(join(home, ".claude"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  return home;
}

function copyOf(home: string, out: string): Manifest {
  return prepareBundle({ days: 7, home, who: [], out });
}

describe("prepareBundle", () => {
  test("with no sessions, the copy holds only the setup item and its files", () => {
    const home = freshHome("empty");
    const out = join(scratch, "out-empty");
    const progress: Array<[number, number]> = [];
    const now = Date.now();
    const m = prepareBundle({ days: 3, home, who: [], out, now, onProgress: (d, t) => progress.push([d, t]) });

    assert.equal(m.version, 1);
    assert.equal(m.days, 3);
    assert.equal(m.createdAt, now);
    assert.equal(m.items.length, 1);
    const setup = m.items[0]!;
    assert.equal(setup.kind, "setup");
    assert.equal(setup.id, "setup");
    assert.equal(setup.file, "setup.json");
    assert.equal(setup.folder, "");
    assert.equal(setup.repo, "");
    assert.equal(setup.title, "Claude setup");
    assert.equal(setup.messages, 0);
    assert.equal(setup.subagents, 0);
    assert.equal(setup.mtime, now);
    assert.ok(setup.gzBytes > 0);

    const json = readFileSync(join(out, "setup.json"), "utf8");
    assert.equal(setup.bytes, Buffer.byteLength(json));
    assert.ok(json.endsWith("\n"));
    assert.doesNotThrow(() => JSON.parse(json));

    assert.deepEqual(m.folders, []);
    assert.deepEqual(m.dropped, []);
    assert.deepEqual(m.tooBig, []);
    assert.deepEqual(m.dirs, []);
    assert.equal(typeof m.setup.memory, "number");
    assert.deepEqual(progress, []);

    assert.deepEqual(readManifest(out), JSON.parse(JSON.stringify(m)));
    const summary = readFileSync(join(out, "SUMMARY.md"), "utf8");
    assert.match(summary, /^# What share-session will send/);
    assert.match(summary, /## Folders/);
  });

  test("a recent session is zipped into sessions/<folder>/<id>.jsonl.gz and counted", () => {
    const home = freshHome("one");
    const cwd = join(scratch, "proj-web");
    mkdirSync(cwd, { recursive: true });
    const id = randomUUID();
    const projDir = join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(projDir, { recursive: true });
    const ts = new Date().toISOString();
    const lines = [
      { type: "user", sessionId: id, cwd, timestamp: ts, uuid: randomUUID(), message: { role: "user", content: "Please fix the login bug in the web app" } },
      { type: "assistant", sessionId: id, cwd, timestamp: ts, uuid: randomUUID(), message: { role: "assistant", content: [{ type: "text", text: "Fixed the login bug." }] } },
    ];
    writeFileSync(join(projDir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const out = join(scratch, "out-one");
    const progress: Array<[number, number]> = [];
    const m = prepareBundle({ days: 7, home, who: [], out, onProgress: (d, t) => progress.push([d, t]) });

    const sessions = m.items.filter((it) => it.kind === "session");
    assert.equal(sessions.length, 1);
    const s = sessions[0]!;
    assert.equal(s.id, id);
    assert.ok(s.file.startsWith("sessions/"));
    assert.ok(s.file.endsWith(`/${id}.jsonl.gz`));
    assert.ok(existsSync(join(out, ...s.file.split("/"))));
    assert.ok(s.gzBytes > 0);
    assert.equal(m.items[0]!.kind, "setup");
    assert.deepEqual(progress, [[1, 1]]);
    assert.equal(m.folders.length, 1);
    assert.equal(m.folders[0]!.n, 1);
    assert.equal(m.folders[0]!.sessions, 1);
    assert.equal(m.folders[0]!.label, s.folder);
    assert.equal(slug(s.folder), s.file.split("/")[1]);
  });
});

describe("unfinishedCopy", () => {
  test("a root that doesn't exist gives null", () => {
    assert.equal(unfinishedCopy(join(scratch, "no-such-root")), null);
  });

  test("the newest folder with a manifest is picked, skipping ones without", () => {
    const home = freshHome("uc");
    const root = join(scratch, "share-root");
    const older = join(root, "2026-01-01-1000");
    copyOf(home, older);
    mkdirSync(join(root, "2026-01-02-1000"), { recursive: true });
    writeFileSync(join(root, "2026-01-02-1000", "note.txt"), "not a copy");

    const got = unfinishedCopy(root);
    assert.ok(got);
    assert.equal(got.dir, older);
    assert.equal(got.sent, null);
    assert.equal(got.manifest.version, 1);
    assert.equal(got.manifest.items[0]!.id, "setup");

    const state = { ...newSentState(), sent: ["setup"] };
    writeSent(older, state);
    const partial = unfinishedCopy(root);
    assert.ok(partial);
    assert.deepEqual(partial.sent, state);

    writeSent(older, { ...state, finishedAt: Date.now() });
    assert.equal(unfinishedCopy(root), null);

    writeSent(older, { ...state, deletedAt: Date.now() });
    assert.equal(unfinishedCopy(root), null);
  });

  test("a root with only folders that aren't copies gives null", () => {
    const root = join(scratch, "share-root-junk");
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });
    assert.equal(unfinishedCopy(root), null);
  });
});

describe("readManifest and readSent", () => {
  test("readManifest refuses another version, a missing items list, and broken JSON", () => {
    const dir = join(scratch, "manifests");
    mkdirSync(dir, { recursive: true });
    assert.equal(readManifest(dir), null);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: 2, items: [] }));
    assert.equal(readManifest(dir), null);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: 1, items: "x" }));
    assert.equal(readManifest(dir), null);
    writeFileSync(join(dir, "manifest.json"), "{not json");
    assert.equal(readManifest(dir), null);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: 1, items: [] }));
    assert.deepEqual(readManifest(dir), { version: 1, items: [] });
  });

  test("readSent takes a well-formed state and refuses the rest", () => {
    const dir = join(scratch, "sents");
    mkdirSync(dir, { recursive: true });
    assert.equal(readSent(dir), null);
    writeFileSync(join(dir, "sent.json"), JSON.stringify({ bundleId: 5, sent: [] }));
    assert.equal(readSent(dir), null);
    writeFileSync(join(dir, "sent.json"), JSON.stringify({ bundleId: "x", sent: "nope" }));
    assert.equal(readSent(dir), null);
    writeFileSync(join(dir, "sent.json"), "garbage");
    assert.equal(readSent(dir), null);
    const s = newSentState();
    writeSent(dir, s);
    assert.deepEqual(readSent(dir), s);
    assert.ok(readFileSync(join(dir, "sent.json"), "utf8").endsWith("\n"));
  });
});

test("newSentState: a fresh uuid and secret whose delete code parses back", () => {
  const a = newSentState();
  const b = newSentState();
  assert.match(a.bundleId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.match(a.secret, /^[A-Za-z0-9_-]{24}$/);
  assert.deepEqual(a.sent, []);
  assert.notEqual(a.bundleId, b.bundleId);
  assert.notEqual(a.secret, b.secret);
  assert.deepEqual(parseDeleteCode(`  ${deleteCode(a)}  `), { bundleId: a.bundleId, secret: a.secret });
});

test("slug: a leading ~ with or without a separator goes", () => {
  assert.equal(slug("~/a"), "a");
  assert.equal(slug("~\\a"), "a");
  assert.equal(slug("~a"), "a");
  assert.equal(slug("src/web app"), "src-web-app");
});
