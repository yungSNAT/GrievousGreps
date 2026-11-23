import { test, describe, before, after, mock } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { startSpinner } from "../src/util/spinner.js";

const CLEAR = "\r\x1b[2K";

function captureStream(isTTY: boolean, columns?: number) {
  const writes: string[] = [];
  const stream = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        writes.push(chunk.toString());
        done();
      },
    }),
    { isTTY, columns },
  ) as unknown as NodeJS.WriteStream;
  return { stream, writes };
}

// Drive ticks directly so frame assertions don't depend on wall-clock timing.
// The test context restores both timer functions after each test.
function controlInterval(t: TestContext, unref?: () => void) {
  const handle = (unref ? { unref } : {}) as unknown as NodeJS.Timeout;
  const schedule = t.mock.method(
    globalThis,
    "setInterval",
    (_callback: () => void, _delay?: number) => handle,
  );
  const cancel = t.mock.method(globalThis, "clearInterval", (_handle: unknown) => {});
  return { handle, schedule, cancel };
}

describe("startSpinner", () => {
  describe("with default options on a TTY", () => {
    const { stream, writes } = captureStream(true);
    let restoreStderr: (() => void) | undefined;

    before(() => {
      const stderr = mock.getter(process, "stderr", () => stream);
      restoreStderr = () => stderr.mock.restore();
    });

    after(() => restoreStderr?.());

    test("draws to stderr, advances frames, and clears once on stop", (t) => {
      const unref = t.mock.fn();
      const { handle, schedule, cancel } = controlInterval(t, unref);
      const spinner = startSpinner("x".repeat(110));

      try {
        // With no column count, the 100-column fallback leaves 99 usable.
        const visibleText = "x".repeat(97);
        assert.equal(spinner.active, true);
        assert.deepEqual(writes, [`${CLEAR}⠋ ${visibleText}`]);
        assert.equal(schedule.mock.callCount(), 1);
        const [callback, delay] = schedule.mock.calls[0]!.arguments;
        const tick = callback as () => void;
        assert.equal(delay, 80);
        assert.equal(unref.mock.callCount(), 1);

        tick();
        assert.equal(writes.at(-1), `${CLEAR}⠙ ${visibleText}`);

        spinner.update("checking files");
        assert.equal(writes.at(-1), `${CLEAR}⠹ checking files`);

        const beforePrint = writes.length;
        spinner.print("Checked one directory");
        assert.deepEqual(writes.slice(beforePrint), [
          CLEAR,
          "Checked one directory\n",
          `${CLEAR}⠸ checking files`,
        ]);
        assert.equal(spinner.active, true);

        const beforeStop = writes.length;
        spinner.stop();
        assert.equal(spinner.active, false);
        assert.deepEqual(writes.slice(beforeStop), [CLEAR]);
        assert.equal(cancel.mock.callCount(), 1);
        assert.equal(cancel.mock.calls[0]!.arguments[0], handle);

        spinner.stop();
        spinner.update("late progress");
        tick();
        assert.deepEqual(writes.slice(beforeStop), [CLEAR]);
        assert.equal(cancel.mock.callCount(), 1);
      } finally {
        spinner.stop();
      }
    });
  });

  test("explicitly enables a non-TTY stream and uses its current width", (t) => {
    const { schedule } = controlInterval(t); // This handle has no unref method.
    const { stream, writes } = captureStream(false, 8);
    const text = "y".repeat(35);
    const spinner = startSpinner(text, { stream, enabled: true, intervalMs: 25 });

    try {
      assert.equal(spinner.active, true);
      assert.deepEqual(writes, [`${CLEAR}⠋ ${"y".repeat(18)}`]);
      assert.equal(schedule.mock.callCount(), 1);
      assert.equal(schedule.mock.calls[0]!.arguments[1], 25);

      stream.columns = 26;
      spinner.update(text);
      assert.equal(writes.at(-1), `${CLEAR}⠙ ${"y".repeat(23)}`);
    } finally {
      spinner.stop();
    }
  });

  for (const [name, isTTY, enabled] of [
    ["a redirected stream", false, undefined],
    ["an explicitly disabled TTY", true, false],
  ] as const) {
    test(`${name} receives completed lines without animation`, (t) => {
      const { schedule } = controlInterval(t);
      const { stream, writes } = captureStream(isTTY);
      const spinner = startSpinner("scanning", { stream, enabled });

      try {
        assert.equal(spinner.active, false);
        assert.deepEqual(writes, []);
        spinner.update("still scanning");
        assert.deepEqual(writes, []);

        spinner.print("Scan complete");
        spinner.stop();
        spinner.stop();
        assert.deepEqual(writes, ["Scan complete\n"]);
        assert.equal(spinner.active, false);
        assert.equal(schedule.mock.callCount(), 0);
      } finally {
        spinner.stop();
      }
    });
  }
});
