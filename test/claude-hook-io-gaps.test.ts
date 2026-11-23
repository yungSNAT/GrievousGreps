import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHILD_TIMEOUT_MS,
  graftJson,
  graftJsonWithin,
  withContextDirArg,
} from "../src/claude/hook-io.js";
import { resolveContextDir } from "../src/claude/state.js";
import { tmpRepo } from "./helpers.js";

function withEnv<T>(changes: NodeJS.ProcessEnv, run: () => T): T {
  const previous = Object.keys(changes).map((key) => [key, process.env[key]] as const);
  try {
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("Claude hook child I/O", () => {
  let dir: string;
  let cliPath: string;
  let contextDir: string;

  before(() => {
    dir = tmpRepo("claude-hook-io-gaps");
    contextDir = join(dir, "shared context");
    mkdirSync(contextDir);
    cliPath = join(dir, "stub graft.cjs");
    writeFileSync(cliPath, String.raw`
const { readFileSync, realpathSync } = require("node:fs");
const [command, ...args] = process.argv.slice(2);
const reply = (value) => process.stdout.write(JSON.stringify(value));

switch (command) {
  case "argv":
    reply({ args, cwd: realpathSync(process.cwd()) });
    break;
  case "ask":
    reply({
      args,
      prompt: readFileSync(0, "utf8"),
      firstBuildWait: process.env.GRAFT_FIRST_BUILD_WAIT_MS,
    });
    break;
  case "check":
    reply({ stale: true, changedFiles: 2 });
    process.exitCode = 1;
    break;
  case "failed-check":
    process.stdout.write(args[0] === "blank" ? " \n\t" : "check failed\n");
    process.exitCode = 1;
    break;
  case "invalid-answer":
    process.stdout.write("not JSON\n");
    break;
  case "slow-answer":
    setTimeout(() => reply({ ready: true }), 1000);
    break;
  default:
    throw new Error("Unexpected stub invocation: " + command);
}
`);
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  function runStub(args: string[]): unknown {
    return withEnv({ GRAFT_TEST_CLI: cliPath }, () => graftJson(dir, args));
  }

  test("leaves argv unchanged when GRAFT_DIR is unset", () => {
    const args = ["ask", "--json"];
    withEnv({ GRAFT_DIR: undefined }, () => {
      assert.strictEqual(withContextDirArg(dir, args), args);
      assert.deepEqual(args, ["ask", "--json"]);
    });
  });

  test("appends the resolved context directory without mutating the caller's argv", () => {
    const args = ["ask", "--json"];
    withEnv({ GRAFT_DIR: contextDir }, () => {
      assert.deepEqual(withContextDirArg(dir, args), [
        "ask", "--json", "--dir", resolveContextDir(dir),
      ]);
      assert.deepEqual(args, ["ask", "--json"]);
    });
  });

  test("reads a JSON answer with the default budget and no supplied stdin", () => {
    assert.equal(CHILD_TIMEOUT_MS, 8_000);
    assert.deepEqual(runStub(["argv", "--dir", contextDir]), {
      args: ["--dir", contextDir],
      cwd: realpathSync(dir),
    });
  });

  test("passes the prompt on stdin and disables the first-build wait only in the child", () => {
    const prompt = 'Explain "shared context".\nInclude café paths.';
    withEnv({ GRAFT_TEST_CLI: cliPath, GRAFT_FIRST_BUILD_WAIT_MS: "1234" }, () => {
      assert.deepEqual(graftJson(dir, ["ask", "--json"], 10_000, prompt), {
        args: ["--json"],
        prompt,
        firstBuildWait: "0",
      });
      assert.equal(process.env.GRAFT_FIRST_BUILD_WAIT_MS, "1234");
    });
  });

  test("recovers the stale-check JSON despite the nonzero exit status", () => {
    assert.deepEqual(runStub(["check", "--json"]), { stale: true, changedFiles: 2 });
  });

  test("returns null for a failed child with malformed or blank stdout", () => {
    assert.equal(runStub(["failed-check", "malformed"]), null);
    assert.equal(runStub(["failed-check", "blank"]), null);
  });

  test("returns null when a successful child prints an invalid JSON answer", () => {
    assert.equal(runStub(["invalid-answer"]), null);
  });

  test("returns null when the default CLI cannot launch in a vanished working directory", () => {
    withEnv({ GRAFT_TEST_CLI: undefined }, () => {
      assert.equal(graftJson(join(dir, "vanished checkout"), ["check", "--json"]), null);
    });
  });

  test("the asynchronous budget resolves to null without waiting for a slow child to close", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const answer = withEnv({ GRAFT_TEST_CLI: cliPath }, () =>
        graftJsonWithin(dir, ["slow-answer"], 250),
      );
      let settled = false;
      void answer.then(() => { settled = true; });

      mock.timers.tick(250);
      await Promise.resolve();

      assert.equal(settled, true, "the deadline should settle the answer before the child closes");
      assert.equal(await answer, null);
    } finally {
      mock.timers.reset();
    }
  });
});
