import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CODEX_COPY,
  codexTrust,
  codexTrustLine,
  trailHookKeys,
  withCodexSandbox,
} from "../src/hosts/codex-trust.js";
import { tmpRepo } from "./helpers.js";

let scratch: string | undefined;

before(() => {
  scratch = tmpRepo("codex-trust-gaps");
});

after(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

function fixture(prefix = "codex-") {
  assert.ok(scratch);
  const home = mkdtempSync(join(scratch, prefix));
  return {
    env: { CODEX_HOME: home },
    hooksPath: join(home, "hooks.json"),
    configPath: join(home, "config.toml"),
  };
}

const graft = { type: "command", command: "node graft-hooks.cjs" };
const singleHook = {
  hooks: { PreToolUse: [{ matcher: ".*", hooks: [graft] }] },
};

function installHook(f: ReturnType<typeof fixture>): string {
  writeFileSync(f.hooksPath, JSON.stringify(singleHook));
  return `${f.hooksPath}:pre_tool_use:0:0`;
}

describe("Codex sandbox notice", () => {
  test("appends the notice to both writing fields without changing the input or repeating the notice", () => {
    const context = "Run `trail skills add example.md`.";
    const block = "First run `trail skills lesson`.";
    const out = { context, block };

    const warned = withCodexSandbox(out, "codex");

    assert.equal(warned.context, `${context} ${CODEX_COPY.sandbox}`);
    assert.equal(warned.block, `${block} ${CODEX_COPY.sandbox}`);
    assert.deepEqual(out, { context, block });
    assert.deepEqual(withCodexSandbox(warned, "codex"), warned);
    assert.equal(withCodexSandbox(out, "claude"), out);
  });

  test("handles a writing block without context and leaves empty or read-only text alone", () => {
    const block = "Run `trail skills update example`.";
    assert.deepEqual(withCodexSandbox({ block }, "codex"), {
      block: `${block} ${CODEX_COPY.sandbox}`,
    });

    const readOnly = { context: "Run `trail skills list`." };
    assert.deepEqual(withCodexSandbox(readOnly, "codex"), readOnly);
    assert.deepEqual(withCodexSandbox({ block: "" }, "codex"), { block: "" });
    assert.deepEqual(withCodexSandbox({}, "codex"), {});
  });
});

describe("Codex hook discovery", () => {
  test("uses Codex's event labels and preserves group and handler positions", () => {
    const f = fixture();
    const legacy = { type: "command", command: "node trail-hooks.cjs" };
    const other = { type: "command", command: "node local-check.cjs" };
    const events = [
      ["PermissionRequest", "permission_request"],
      ["PostToolUse", "post_tool_use"],
      ["PreCompact", "pre_compact"],
      ["PostCompact", "post_compact"],
      ["SessionStart", "session_start"],
      ["SessionEnd", "session_end"],
      ["UserPromptSubmit", "user_prompt_submit"],
      ["SubagentStart", "subagent_start"],
      ["SubagentStop", "subagent_stop"],
      ["Stop", "stop"],
      ["Interrupt", "interrupt"],
    ] as const;
    writeFileSync(f.hooksPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Read", hooks: [other] },
          { matcher: "Bash", hooks: [other, graft, legacy] },
        ],
        FutureEvent: [{ hooks: [graft] }],
        ...Object.fromEntries(events.map(([event]) => [event, [{ hooks: [graft] }]])),
      },
    }));

    assert.deepEqual(trailHookKeys(f.env), [
      `${f.hooksPath}:pre_tool_use:1:1`,
      `${f.hooksPath}:pre_tool_use:1:2`,
      ...events.map(([, label]) => `${f.hooksPath}:${label}:0:0`),
    ]);
  });

  test("cannot discover hooks when hooks.json is missing or is a directory", () => {
    const f = fixture();
    assert.deepEqual(trailHookKeys(f.env), []);
    assert.deepEqual(codexTrust(f.env), { state: "unknown", untrusted: [] });

    mkdirSync(f.hooksPath);
    assert.deepEqual(trailHookKeys(f.env), []);
    assert.equal(codexTrustLine(f.env), null);
  });

  test("does not use an oversized hooks.json even if its JSON is valid", () => {
    const f = fixture();
    const json = JSON.stringify(singleHook);
    writeFileSync(f.hooksPath, json.padEnd(1024 * 1024 + 1, " "));

    assert.deepEqual(trailHookKeys(f.env), []);
    assert.deepEqual(codexTrust(f.env), { state: "unknown", untrusted: [] });
  });
});

describe("Codex TOML trust records", () => {
  test("matches a basic-string key with path and Unicode escapes and accepts a literal hash", () => {
    // A quote exercises basic-string escaping on POSIX; Windows paths have
    // backslashes to escape instead.
    const f = fixture(process.platform === "win32" ? "codex-" : 'codex-"quoted"-');
    const key = installHook(f);
    const quotedKey = JSON.stringify(key).replace(
      /:pre_tool_use:0:0"$/,
      () => String.raw`:\u0070re_tool_us\U00000065:0:0"`,
    );
    const config = `[hooks.state.${quotedKey}]\ntrusted_hash = 'sha256:ab12'\n`;
    writeFileSync(f.configPath, config);

    assert.deepEqual(codexTrust(f.env), { state: "trusted", untrusted: [] });
    assert.equal(codexTrustLine(f.env), null);
    assert.equal(readFileSync(f.configPath, "utf8"), config);
  });

  test("reports a missing or disabled record as untrusted, even if the disabled record has a hash", () => {
    const f = fixture();
    const key = installHook(f);
    const untrusted = { state: "untrusted", untrusted: [key] };
    assert.deepEqual(codexTrust(f.env), untrusted);

    const record = (enabled: boolean) =>
      `[hooks.state]\r\n${JSON.stringify(key)} = { trusted_hash = "sha256:ab12", enabled = ${enabled} }\r\n`;
    writeFileSync(f.configPath, record(false));
    assert.deepEqual(codexTrust(f.env), untrusted);
    assert.equal(codexTrustLine(f.env), CODEX_COPY.trust);

    writeFileSync(f.configPath, record(true));
    assert.deepEqual(codexTrust(f.env), { state: "trusted", untrusted: [] });
    assert.equal(codexTrustLine(f.env), null);
  });

  for (const [problem, hash] of [
    ["an unquoted hash", "sha256:ab12"],
    ["an unterminated literal string", "'sha256:ab12"],
    ["an unterminated basic string", '"sha256:ab12'],
    ["an unsupported escape", String.raw`"sha256:ab\q12"`],
    ["a dangling backslash", '"sha256:ab12' + "\\"],
    ["invalid Unicode digits", String.raw`"\u12X4"`],
    ["a truncated Unicode escape", String.raw`"\u12`],
    ["an out-of-range Unicode code point", String.raw`"\U00110000"`],
  ] as const) {
    test(`reports unknown for ${problem}`, () => {
      const f = fixture();
      const key = installHook(f);
      writeFileSync(f.configPath, `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${hash}\n`);

      assert.deepEqual(codexTrust(f.env), { state: "unknown", untrusted: [] });
      assert.equal(codexTrustLine(f.env), CODEX_COPY.trust);
    });
  }
});
