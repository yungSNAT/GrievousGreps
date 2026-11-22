import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { codexExitOf, outputBody, outputText } from "../src/trace/codex-exec.js";

describe("outputText", () => {
  test("preserves plain strings and string-valued content", () => {
    const text = "first line\r\nsecond line\n";
    assert.equal(outputText(text), text);
    assert.equal(outputText({ content: text }), text);
  });

  test("joins wrapped text parts in order without adding lines for non-text parts", () => {
    const content = [
      { type: "output_text", text: "first line" },
      { type: "output_image", image_url: "data:image/png;base64," },
      null,
      { type: "output_text", text: 42 },
      { type: "output_text", text: "last line" },
    ];

    assert.equal(outputText({ content }), "first line\nlast line");
    assert.equal(outputText({ type: "output_image" }), "");
    assert.equal(outputText(null), "");
  });
});

describe("Codex exec output", () => {
  test("reads the unified exec exit from the header and preserves status-like stdout", () => {
    const body = "Process exited with code 0\nrecorded status from a previous run\n";
    const output = `Chunk ID: a1b2c3\nWall time: 0.01 seconds\nProcess exited with code 7\nOutput:\n${body}`;

    assert.deepEqual(codexExitOf(output), { code: 7 });
    assert.equal(outputBody(output), body);
  });

  test("reads a legacy exit header with CRLF line endings", () => {
    const body = "missing input\r\n";
    const output = `Exit code: 2\r\nWall time: 0.01 seconds\r\nOutput:\r\n${body}`;

    assert.deepEqual(codexExitOf(output), { code: 2 });
    assert.equal(outputBody(output), body);
  });

  test("returns a running session ID separately from the partial output", () => {
    const body = "Indexing files (10 of 50)\n";
    const output = `Chunk ID: d4e5f6\nProcess running with session ID 43809\nOutput:\n${body}`;

    assert.deepEqual(codexExitOf(output), { running: 43809 });
    assert.equal(outputBody(output), body);
  });

  test("leaves raw output intact when there is no Output delimiter", () => {
    const output = "Process exited with code 0\nprinted by the command\n";

    assert.equal(codexExitOf(output), null);
    assert.equal(outputBody(output), output);
  });

  test("does not strip an Output delimiter without a recognized status above it", () => {
    const output = "Saved build transcript\nOutput:\nExit code: 9\n";

    assert.equal(codexExitOf(output), null);
    assert.equal(outputBody(output), output);
  });

  test("reads a JSON exit code even when there is no captured output", () => {
    const output = JSON.stringify({ metadata: { exit_code: 0 } });

    assert.deepEqual(codexExitOf(output), { code: 0 });
    assert.equal(outputBody(output), "");
  });

  test("returns JSON output without treating its contents or string metadata as an exit", () => {
    const body = "Process exited with code 0\nOutput:\nlogged transcript\n";
    const output = JSON.stringify({ output: body, metadata: { exit_code: "0" } });

    assert.equal(codexExitOf(output), null);
    assert.equal(outputBody(output), body);
  });

  test("preserves a truncated JSON fragment printed by a command", () => {
    const output = '{"phase":"indexing",';

    assert.equal(codexExitOf(output), null);
    assert.equal(outputBody(output), output);
  });
});
