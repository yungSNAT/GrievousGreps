import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "claude-call-gaps-"));
const standIn = join(root, "claude-stand-in.cjs");
const ask = { system: "Find practices in past sessions", schema: { type: "object" } };
let claude: typeof import("../src/init/claude-call.js");

const failures = [
  {
    name: "reports a usage limit from string errors when result is empty",
    prompt: "Read the morning session.",
    response: {
      is_error: true,
      result: "",
      errors: ["Usage limit reached|1760000000", { retryable: true }, "try again later"],
    },
    expected: { ok: false, why: "refused", said: "Usage limit reached; try again later" },
  },
  {
    name: "recognizes an expired login from HTTP status alone",
    prompt: "Read yesterday's session.",
    response: { is_error: true, api_error_status: 401 },
    expected: { ok: false, why: "not_signed_in" },
  },
  {
    name: "prefers the final result to earlier errors",
    prompt: "Read the last session.",
    response: {
      is_error: true,
      result: "The response was interrupted",
      errors: ["OAuth session expired"],
    },
    expected: { ok: false, why: "failed", said: "The response was interrupted" },
  },
];

before(async () => {
  const responses = Object.fromEntries(failures.map(({ prompt, response }) => [prompt, response]));
  writeFileSync(standIn, `
const responses = ${JSON.stringify(responses)};
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (!Object.hasOwn(responses, prompt)) {
    process.stderr.write("Unexpected prompt");
    process.exitCode = 2;
    return;
  }
  process.stdout.write(JSON.stringify(responses[prompt]) + "\\n");
  process.exitCode = 1;
});
`);

  // Insert a JS entry point before Claude's flags. This keeps the real child
  // process and its stdio, without needing a shebang or a Windows shell shim.
  const realSpawn = childProcess.spawn;
  mock.method(childProcess, "spawn", (command: string, args?: readonly string[], options?: SpawnOptions) => {
    if (command === process.execPath && args?.[0] === "-p") {
      return realSpawn(command, [standIn, ...args], options);
    }
    return realSpawn(command, args, options);
  });
  syncBuiltinESMExports();
  claude = await import("../src/init/claude-call.js");
});

after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  rmSync(root, { recursive: true, force: true });
});

test("claudeBin ignores unrelated and incomplete extensions and picks the newest installed copy", () => {
  const home = join(root, "extension-home");
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const platform = `${process.platform}-${process.arch}`;
  const notOnPath = () => null;

  function extension(editor: string, name: string, installed = true): string {
    const dir = join(home, editor, "extensions", `${name}-${platform}`, "resources", "native-binary");
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, exe);
    if (installed) writeFileSync(bin, "");
    return bin;
  }

  extension(".vscode", "other.claude-code-100.0.0");
  extension(".cursor", "anthropic.claude-code-99.0.0", false);
  assert.equal(claude.claudeBin(home, notOnPath), null);

  extension(".vscode", "anthropic.claude-code-1.99.99");
  extension(".cursor", "anthropic.claude-code-2.9.99");
  extension(".vscode-insiders", "anthropic.claude-code-2.10.9");
  const newest = extension(".windsurf", "anthropic.claude-code-2.10.12");
  assert.equal(claude.claudeBin(home, notOnPath), newest);
});

describe("completedFindings", () => {
  test("keeps complete objects before and after a malformed entry but omits the unfinished tail", () => {
    const first = {
      headline: 'Keep the literal "quote", backslash \\ and braces {[]}',
      evidence: [{ lines: [7, 8] }],
    };
    const second = { headline: "Sessions live in Postgres" };
    const partial = `\n{ "findings": [
      ${JSON.stringify(first)},
      {"headline": },
      ${JSON.stringify(second)},
      {"headline":"still being written`;

    assert.deepEqual(claude.completedFindings(partial), [first, second]);
  });

  test("stops at the end of the findings array, not the end of the response", () => {
    assert.deepEqual(
      claude.completedFindings('{"findings":[{"headline":"Keep cents"}],"metadata":{"count":1}}'),
      [{ headline: "Keep cents" }],
    );
  });
});

describe("callClaude failure results", () => {
  for (const { name, prompt, expected } of failures) {
    test(name, async () => {
      const result = await claude.callClaude(process.execPath, prompt, "sonnet", 10_000, ask);
      assert.deepEqual(result, expected);
    });
  }
});
