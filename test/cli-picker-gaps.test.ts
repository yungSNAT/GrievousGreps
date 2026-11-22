import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { HostPlan } from "../src/hosts/plan.js";
import {
  tilde,
  compactWrites,
  describeWrites,
  initialPickerState,
  keyOf,
  keysOf,
  reducePicker,
  renderPicker,
  pickedIds,
  pickedHostIds,
  pickedTelemetry,
  drivePicker,
  visibleRows,
  TELEMETRY_ROW_ID,
  KEY_UP,
  KEY_DOWN,
  KEY_ESC,
  KEY_CTRL_C,
  type PickerIO,
} from "../src/cli-picker.js";

const root = mkdtempSync(join(tmpdir(), "cli-picker-gaps-"));
const repo = join(root, "repo");
const home = join(root, "home");

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function w(path: string, scope: "repo" | "global", kind = "file", what = "config") {
  return { path, scope, kind, what };
}

function makePlan(opts: { codexDetected?: boolean } = {}): HostPlan[] {
  return [
    {
      id: "claude",
      detected: true,
      writes: [
        w(join(repo, ".claude", "settings.json"), "repo", "hook", "hooks"),
        w(join(repo, ".mcp.json"), "repo", "mcp", "mcp server"),
      ],
    },
    {
      id: "codex",
      detected: opts.codexDetected ?? false,
      writes: [
        w(join(repo, "AGENTS.md"), "repo", "file", "instructions"),
        w(join(home, ".codex", "config.toml"), "global", "mcp", "mcp server"),
      ],
    },
  ] as unknown as HostPlan[];
}

describe("tilde", () => {
  test("shortens the home dir and paths under it, leaves everything else", () => {
    assert.equal(tilde(home, home), "~");
    assert.equal(tilde(join(home, ".codex", "x"), home), `~${sep}.codex${sep}x`);
    // A sibling that merely shares the prefix is not under home.
    assert.equal(tilde(home + "other", home), home + "other");
    assert.equal(tilde(join(root, "elsewhere"), home), join(root, "elsewhere"));
  });
});

describe("compactWrites and describeWrites", () => {
  test("folds a folder written twice and honours an explicit maxShown", () => {
    const writes = [
      w(join(repo, ".claude", "a.json"), "repo"),
      w(join(repo, ".claude", "b.json"), "repo"),
      w(join(repo, ".mcp.json"), "repo"),
      w(join(home, ".codex", "config.toml"), "global"),
      w(join(home, ".codex", "AGENTS.md"), "global"),
    ] as never;
    assert.equal(
      compactWrites(writes, repo, home, 1),
      `.claude${sep} +1 more · + 2 in ~${sep}.codex${sep}`,
    );
    assert.equal(compactWrites(writes, repo, home), `.claude${sep}, .mcp.json · + 2 in ~${sep}.codex${sep}`);
  });

  test("a single top folder lists its paths and truncates past the default", () => {
    const writes = [
      w(join(repo, "a.md"), "repo"),
      w(join(repo, "b.md"), "repo"),
      w(join(repo, "c.md"), "repo"),
    ] as never;
    // Three different tops → three entries, default maxShown 2.
    assert.equal(compactWrites(writes, repo, home), "a.md, b.md +1 more");
    const one = [w(join(repo, ".claude", "x.json"), "repo"), w(join(repo, ".claude", "y.json"), "repo")] as never;
    assert.equal(compactWrites(one, repo, home), `${join(".claude", "x.json")}, ${join(".claude", "y.json")}`);
  });

  test("describeWrites names globals and notes missing MCP", () => {
    const writes = [
      w(join(repo, "a"), "repo"),
      w(join(repo, "b"), "repo"),
      w(join(home, ".codex", "c"), "global"),
    ] as never;
    assert.equal(describeWrites(writes, repo, home, 1), `a +1 more · + 1 in ~${sep}.codex${sep} (machine-wide) · no MCP`);
    const withMcp = [w(join(repo, ".mcp.json"), "repo", "mcp")] as never;
    assert.equal(describeWrites(withMcp, repo, home), ".mcp.json");
  });
});

describe("keys", () => {
  test("keyOf maps every bound key", () => {
    assert.equal(keyOf(KEY_UP), "up");
    assert.equal(keyOf("k"), "up");
    assert.equal(keyOf(KEY_DOWN), "down");
    assert.equal(keyOf("j"), "down");
    assert.equal(keyOf(" "), "space");
    assert.equal(keyOf("a"), "all");
    assert.equal(keyOf("m"), "more");
    assert.equal(keyOf("\r"), "enter");
    assert.equal(keyOf("\n"), "enter");
    assert.equal(keyOf(KEY_ESC), "abort");
    assert.equal(keyOf(KEY_CTRL_C), "abort");
    assert.equal(keyOf("q"), "abort");
    assert.equal(keyOf("z"), null);
  });

  test("keysOf splits batched input, consumes CSI sequences whole", () => {
    assert.deepEqual(keysOf(" am\r\n"), ["space", "all", "more", "enter", "enter"]);
    assert.deepEqual(keysOf(`${KEY_UP}${KEY_DOWN}j`), ["up", "down", "down"]);
    // A bare ESC not followed by '[' is an abort; the next byte is its own key.
    assert.deepEqual(keysOf("\x1bx"), ["abort"]);
    assert.deepEqual(keysOf("\x1bk"), ["abort", "up"]);
    // An unknown CSI sequence (ctrl+right) is ignored, never read as abort.
    assert.deepEqual(keysOf("\x1b[1;5Cj"), ["down"]);
    // A truncated CSI at the end of a chunk is ignored.
    assert.deepEqual(keysOf("j\x1b["), ["down"]);
  });
});

describe("initialPickerState and reducePicker", () => {
  test("telemetry row is offered, checked only when already on", () => {
    const off = initialPickerState(makePlan(), repo, home, { offerTelemetry: true });
    assert.equal(off.rows.at(-1)!.id, TELEMETRY_ROW_ID);
    assert.equal(off.rows.at(-1)!.kind, "setting");
    assert.equal(pickedTelemetry(off), false);
    const on = initialPickerState(makePlan(), repo, home, { offerTelemetry: true, telemetryChecked: true });
    assert.equal(pickedTelemetry(on), true);
    const none = initialPickerState(makePlan(), repo, home);
    assert.equal(pickedTelemetry(none), undefined);
    assert.deepEqual(pickedIds(none), ["claude"]);
    assert.equal(none.rows[1]!.hasGlobal, true);
  });

  test("space toggles the row under the cursor, abort marks the state aborted", () => {
    let s = initialPickerState(makePlan({ codexDetected: true }), repo, home, { offerTelemetry: true });
    s = reducePicker(s, "space");
    assert.deepEqual(pickedIds(s), []);
    s = reducePicker(s, "space");
    assert.deepEqual(pickedIds(s), ["claude"]);
    s = reducePicker(s, "down");
    s = reducePicker(s, "space");
    assert.deepEqual(pickedHostIds(s), ["claude", "codex"]);
    s = reducePicker(s, "down");
    s = reducePicker(s, "space");
    assert.deepEqual(pickedIds(s), ["claude", "codex", TELEMETRY_ROW_ID]);
    assert.deepEqual(pickedHostIds(s), ["claude", "codex"]);
    // 'all' with every host on clears the hosts but leaves the consent row.
    s = reducePicker(s, "all");
    assert.deepEqual(pickedIds(s), [TELEMETRY_ROW_ID]);
    s = reducePicker(s, "up");
    assert.equal(s.cursor, 1);
    const aborted = reducePicker(s, "abort");
    assert.equal(aborted.aborted, true);
    assert.equal(aborted.done, false);
    assert.equal(reducePicker(s, "enter").done, true);
  });

  test("more unfolds undetected agents and folding unchecks them", () => {
    let s = initialPickerState(makePlan(), repo, home);
    assert.deepEqual(visibleRows(s).map((r) => r.id), ["claude"]);
    s = reducePicker(s, "more");
    assert.deepEqual(visibleRows(s).map((r) => r.id), ["claude", "codex"]);
    s = reducePicker(reducePicker(s, "down"), "space");
    assert.deepEqual(pickedIds(s), ["claude", "codex"]);
    s = reducePicker(s, "more");
    assert.equal(s.cursor, 0);
    assert.deepEqual(pickedIds(s), ["claude"]);
    // With nothing hidden, 'more' is a no-op.
    const all = initialPickerState(makePlan({ codexDetected: true }), repo, home);
    assert.equal(reducePicker(all, "more"), all);
  });
});

describe("renderPicker", () => {
  test("no fold line when every agent is detected; a rule before the consent row", () => {
    const s = initialPickerState(makePlan({ codexDetected: true }), repo, home, { offerTelemetry: true });
    const out = renderPicker(s, false, { title: null });
    const lines = out.split("\n");
    assert.match(lines[0]!, /^› \[✓\] claude/);
    assert.doesNotMatch(out, /not detected/);
    assert.ok(lines.some((l) => l.includes("─".repeat(40))));
    assert.ok(lines.some((l) => l.includes("[ ] anonymous usage stats")));
    assert.equal(lines.at(-1), "↑↓ move · space toggle · a all · enter confirm · esc cancel");
  });

  test("fold line sits above the rule when agents are hidden", () => {
    const s = initialPickerState(makePlan(), repo, home, { offerTelemetry: true });
    const lines = renderPicker(s, false, { title: "pick:" }).split("\n");
    assert.equal(lines[0], "pick:");
    const fold = lines.findIndex((l) => l.includes("+ 1 not detected (codex) · m to show"));
    const rule = lines.findIndex((l) => l.includes("─".repeat(40)));
    assert.ok(fold > 0 && rule === fold + 1);
    assert.match(lines.at(-1)!, /m more/);
    const shown = renderPicker(reducePicker(s, "more"), false, { title: null });
    assert.match(shown, /codex \(not detected\)/);
    assert.match(shown, /m to fold the 1 not detected/);
  });
});

function fakeIO(columns = 200) {
  const writes: string[] = [];
  const raw: boolean[] = [];
  let paused = 0;
  const stdin = Object.assign(new EventEmitter(), {
    isRaw: false,
    setRawMode(v: boolean) { raw.push(v); },
    resume() {},
    pause() { paused++; },
  });
  const io: PickerIO = { out: { write: (s: string) => writes.push(s), columns }, stdin };
  return { io, stdin, writes, raw, paused: () => paused };
}

describe("drivePicker", () => {
  test("keys toggle and confirm; the picker is erased and raw mode restored", async () => {
    const f = fakeIO();
    const p = drivePicker(initialPickerState(makePlan({ codexDetected: true }), repo, home), "pick:", f.io);
    assert.match(f.writes[0]!, /^pick:\n/);
    f.stdin.emit("data", Buffer.from("x"));
    assert.equal(f.writes.length, 1, "an ignored key does not redraw");
    f.stdin.emit("data", Buffer.from("j"));
    assert.equal(f.writes.length, 3, "erase then redraw");
    assert.match(f.writes[1]!, /^\x1b\[\d+A\x1b\[0J$/);
    f.stdin.emit("data", Buffer.from(" \r"));
    const state = await p;
    assert.ok(state);
    assert.deepEqual(pickedHostIds(state), ["claude", "codex"]);
    assert.match(f.writes.at(-1)!, /^\x1b\[\d+A\x1b\[0J$/);
    assert.deepEqual(f.raw, [true, false]);
    assert.equal(f.paused(), 1);
    assert.equal(f.stdin.listenerCount("data"), 0);
    assert.equal(f.stdin.listenerCount("end"), 0);
  });

  test("escape cancels with null", async () => {
    const f = fakeIO();
    const p = drivePicker(initialPickerState(makePlan(), repo, home), null, f.io);
    f.stdin.emit("data", Buffer.from(" q"));
    assert.equal(await p, null);
  });

  test("a closed stdin cancels instead of hanging", async () => {
    const f = fakeIO();
    const p = drivePicker(initialPickerState(makePlan(), repo, home), "pick:", f.io);
    f.stdin.emit("end");
    assert.equal(await p, null);
    assert.equal(f.stdin.listenerCount("data"), 0);
  });
});
