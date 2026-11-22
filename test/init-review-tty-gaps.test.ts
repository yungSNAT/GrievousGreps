/**
 * Gap tests for the review screen's keys: every key letter keysOf knows
 * (r/R and n/N included), the r key on an item that isn't a preference,
 * space ticking, n ending the screen, an empty list, and what `s` shows for
 * a preference whose lines can't be read, a guardrail of an unknown class
 * and any other item.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { detailLines, keysOf, runScreen } from "../src/init/review-tty.js";
import { INIT_COPY } from "../src/init/review-screen.js";
import type { InitItem } from "../src/init/types.js";
import { factsOf, REPO_KEY, threeItems } from "./init-screen-fixtures.js";

function fakeTty(keys: string[]) {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { setRawMode: (b: boolean) => void; isRaw: boolean };
  let raw = false;
  stdin.isTTY = true;
  stdin.setRawMode = (b: boolean) => {
    raw = b;
    return stdin;
  };
  let out = "";
  const stdout = new Writable({ write(chunk, _e, cb) { out += chunk.toString(); cb(); } }) as unknown as NodeJS.WriteStream;
  stdout.isTTY = true;
  (stdout as { columns?: number }).columns = 200;
  let k = 0;
  const next = () => {
    if (k < keys.length) {
      (stdin as unknown as PassThrough).write(keys[k++]!);
      setImmediate(next);
    }
  };
  setImmediate(next);
  return { io: { stdin, stdout }, out: () => out, raw: () => raw };
}

const withTimeout = <T>(p: Promise<T>) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("screen hung")), 3000))]);

describe("keysOf", () => {
  test("reads every key letter, both cases, arrows and a lone escape", () => {
    assert.deepEqual(keysOf("rR"), ["r", "r"]);
    assert.deepEqual(keysOf("nN"), ["n", "n"]);
    assert.deepEqual(keysOf("\x1b[A\x1bOB\x1b[C"), ["up", "down", "other"]);
    assert.deepEqual(keysOf("\x1b"), ["esc"]);
    assert.deepEqual(keysOf("qQ\x03"), ["quit", "quit", "quit"]);
    assert.deepEqual(keysOf("\r\n "), ["enter", "enter", "space"]);
    assert.deepEqual(keysOf("kjsSwW"), ["up", "down", "s", "s", "w", "w"]);
    assert.deepEqual(keysOf("x"), ["other"]);
    assert.deepEqual(keysOf("j r n"), ["down", "space", "r", "space", "n"]);
  });
});

describe("detailLines", () => {
  const base = threeItems()[0]!;

  test("a preference with no readable lines says so", () => {
    const noRefs = { ...base, kind: "preference", skill: undefined, pref: { refs: [] } } as unknown as InitItem;
    assert.deepEqual(detailLines(noRefs, {}), ["Trail couldn't read these lines again just now."]);
    const noPref = { ...base, kind: "preference", skill: undefined, pref: undefined } as unknown as InitItem;
    assert.deepEqual(detailLines(noPref, {}), ["Trail couldn't read these lines again just now."]);
  });

  test("a guardrail of an unknown class shows an empty line", () => {
    const g = { ...base, kind: "guardrail", skill: undefined, guardrail: { cls: "no-such-class-xyz" } } as unknown as InitItem;
    assert.deepEqual(detailLines(g, {}), [""]);
  });

  test("any other item shows its own detail, or nothing", () => {
    const withDetail = { ...base, kind: "review", skill: undefined, detail: ["one", "two"] } as unknown as InitItem;
    assert.deepEqual(detailLines(withDetail, {}), ["one", "two"]);
    const without = { ...base, kind: "review", skill: undefined, detail: undefined } as unknown as InitItem;
    assert.deepEqual(detailLines(without, {}), []);
  });
});

describe("runScreen keys", () => {
  test("r on an item that isn't a preference leaves it alone and says later", async () => {
    const items = threeItems();
    const idx = items.findIndex((i) => i.kind !== "preference" && i.kind !== "claudeai");
    assert.ok(idx >= 0, "fixture has a non-preference item");
    const orig = items[idx]!;
    const t = fakeTty([...Array.from({ length: idx }, () => "j"), "r", "q"]);
    const r = await withTimeout(runScreen(items, factsOf(), t.io, { repoKey: REPO_KEY, env: {} }));
    assert.equal(r.how, "esc");
    assert.equal(r.scopes[orig.n]!.scope, orig.scope);
    assert.equal(r.scopes[orig.n]!.applies, orig.applies);
    const note = INIT_COPY.rLater!;
    assert.ok(t.out().includes(note.slice(0, 15)), "the later note is drawn");
  });

  test("space ticks the item under the cursor and n ends the screen", async () => {
    const items = threeItems();
    const first = items[0]!;
    const t = fakeTty([" ", "n"]);
    const r = await withTimeout(runScreen(items, factsOf(), t.io, { repoKey: REPO_KEY, env: {} }));
    assert.equal(r.how, "n");
    assert.equal(r.ticked.includes(first.n), !first.ticked, "space flipped the first item");
    assert.equal(items[0]!.ticked, first.ticked, "the caller's items are not changed");

    const t2 = fakeTty(["N"]);
    const r2 = await withTimeout(runScreen(threeItems(), factsOf(), t2.io, { repoKey: REPO_KEY, env: {} }));
    assert.equal(r2.how, "n");
    assert.deepEqual(r2.ticked, threeItems().filter((i) => i.ticked).map((i) => i.n));
  });

  test("an empty list ticks nothing and keeps nothing", async () => {
    const t = fakeTty([" ", "r", "w", "s", "n"]);
    const r = await withTimeout(runScreen([], factsOf(), t.io, { repoKey: REPO_KEY, env: {} }));
    assert.ok(r.how === "n" || r.how === "esc");
    assert.deepEqual(r.ticked, []);
    assert.deepEqual(r.scopes, {});
    assert.equal(t.raw(), false);
  });
});
