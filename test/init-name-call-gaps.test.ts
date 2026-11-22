import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InitCandidate } from "../src/init/types.js";

type Naming = typeof import("../src/init/name-call.js");
type Request = {
  bin: string;
  prompt: string;
  model: string;
  timeoutMs: number;
  options: {
    system: string;
    schema: { properties: { findings: { items: { required: string[] } } } };
  };
};
type ClaudeDouble = {
  bin: string | undefined;
  homes: (string | undefined)[];
  requests: Request[];
  reply: unknown;
};

// Replace only the Claude Code boundary. This exercises the real prompt and
// response handling without installing a CLI shim or changing PATH.
const doubleUrl = `data:text/javascript,${encodeURIComponent(`
  export const state = { bin: undefined, homes: [], requests: [], reply: undefined };
  export function claudeBin(home) {
    state.homes.push(home);
    return state.bin;
  }
  export async function callClaude(bin, prompt, model, timeoutMs, options) {
    state.requests.push({ bin, prompt, model, timeoutMs, options });
    if (state.reply === undefined) throw new Error("Unexpected Claude Code call");
    return state.reply;
  }
`)}`;

function skill(
  id: string,
  plainName: string,
  job: string,
  steps: string[],
  check: string,
  options: { omitCompiledJob?: boolean; costly?: number } = {},
): InitCandidate {
  // Only the candidate and compiled-skill fields read by the naming module.
  return {
    id,
    kind: "skill",
    key: `github.com/acme/toolkit|job:${job}`,
    plainName,
    nameWords: [plainName],
    count: {
      days: 3,
      ...(options.costly === undefined ? {} : { costly: options.costly }),
    },
    skill: {
      compiled: {
        name: plainName,
        description: "Original compiled description.",
        meta: options.omitCompiledJob ? {} : { job },
        steps: steps.map((cmd) => ({ cmd })),
        check,
      },
    },
  } as unknown as InitCandidate;
}

const release = skill(
  "i-1f0e2a9c41", "release-npm", "publish",
  ["npm version patch", "npm publish"], "npm view acme-toolkit version",
);
const preferenceText = "Always explain the change with one small example.";
const preference = {
  id: "i-2a2a2a2a2a",
  kind: "preference",
  plainName: preferenceText,
  count: { days: 2 },
} as unknown as InitCandidate;

describe("init skill naming", () => {
  let naming: Naming;
  let claude: ClaudeDouble;
  let home: string | undefined;

  before(async () => {
    home = mkdtempSync(join(tmpdir(), "greps-name-call-"));
    mock.method(globalThis, "fetch", () => {
      throw new Error("Naming tests must not use HTTP");
    });

    const subjectUrl = new URL("../src/init/name-call.ts", import.meta.url).href;
    let intercepted = false;
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (
          specifier === "./claude-call.js" &&
          context.parentURL?.split(/[?#]/, 1)[0] === subjectUrl
        ) {
          intercepted = true;
          return { url: doubleUrl, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
    try {
      naming = await import("../src/init/name-call.js");
      assert.ok(intercepted, "Claude Code must be replaced before testing nameItems");
      claude = (await import(doubleUrl)).state as ClaudeDouble;
    } finally {
      hooks.deregister();
    }
  });

  after(() => {
    mock.restoreAll();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  });

  function arrange(bin?: string, reply?: unknown): void {
    claude.bin = bin;
    claude.reply = reply;
    claude.homes.length = 0;
    claude.requests.length = 0;
  }

  test("valid names can use the default availability check, but not banned words", () => {
    const { validName } = naming;
    assert.equal(validName("publish-package"), true);
    assert.equal(validName("build-notebook"), true, "a substring is not a banned word");
    assert.equal(validName(`publish-${"x".repeat(32)}`), true);
    assert.equal(validName(`publish-${"x".repeat(33)}`), false);

    for (const name of ["release-notes", "project-memory", "test-workflow", "release-rules"]) {
      assert.equal(validName(name), false, name);
    }
    for (const name of ["Publish-Package", "publish--package", "publish-"]) {
      assert.equal(validName(name), false, name);
    }
    assert.equal(validName(42 as unknown as string), false);

    const taken = mock.fn((name: string) => name === "publish-package");
    assert.equal(validName("publish-package", taken), false);
    assert.equal(validName("publish-library", taken), true);
    assert.deepEqual(taken.mock.calls.map(({ arguments: args }) => args), [
      ["publish-package"],
      ["publish-library"],
    ]);
  });

  test("preferences and skill candidates without compiled steps do not trigger discovery or a call", async () => {
    arrange();
    const uncompiled = { ...release, skill: undefined } as InitCandidate;
    const result = await naming.nameItems([preference, uncompiled], { HOME: home });

    assert.deepEqual(result, { names: {}, model: "none", why: null, sentItems: 0, tokens: 0 });
    assert.deepEqual(claude.homes, []);
    assert.equal(claude.requests.length, 0);
    assert.equal(naming.nameLine(result, [], 0), null);
  });

  test("an empty HOME uses default discovery and missing Claude Code keeps the plain names", async () => {
    arrange();
    const result = await naming.nameItems([release], { HOME: "" });

    assert.deepEqual(claude.homes, [undefined]);
    assert.equal(claude.requests.length, 0);
    assert.deepEqual(result, {
      names: {}, model: "none", why: "not_installed", sentItems: 0, tokens: 0,
    });
    const line = naming.nameLine(result, [release.plainName], 0);
    assert.match(line ?? "", /Claude Code isn't installed/);
    assert.match(line ?? "", /plain names/);
    assert.match(line ?? "", /copies the steps without Claude/);
  });

  test("asks once with only compiled skill data and applies only usable names and descriptions", async () => {
    const checks = skill("i-3b3b3b3b3b", "test-cli", "test", ["npm test"], "", {
      omitCompiledJob: true,
      costly: 0,
    });
    const bin = join(home!, "bin", "claude");
    arrange(bin, {
      ok: true,
      findings: [
        { id: preference.id, name: "explain-simply", description: "Gives an example." },
        { id: release.id, name: 42, description: "Publishes the package." },
        { id: release.id, name: "release-notes", description: "Publishes the package." },
        { id: release.id, name: "ship-toolkit", description: "Follows the release workflow." },
        {
          id: release.id,
          name: "  publish-toolkit  ",
          description: " Publishes the package —\n then checks the registry. ",
        },
        { id: release.id, name: "ship-package", description: "Ships the package." },
        { id: checks.id, name: "publish-toolkit", description: "Runs the test suite." },
        { id: checks.id, name: "run-checks", description: "Runs the test suite." },
      ],
    });

    const result = await naming.nameItems([release, preference, checks], { HOME: home });

    assert.deepEqual(claude.homes, [home]);
    assert.equal(claude.requests.length, 1);
    const [{ bin: sentBin, prompt, model, timeoutMs, options }] = claude.requests;
    assert.equal(sentBin, bin);
    assert.equal(model, naming.NAME_MODEL);
    assert.equal(timeoutMs, 60_000);
    assert.match(options.system, /description: one plain sentence of at most 120 characters/);
    assert.match(options.system, /Never change, add, remove or reorder the steps/);
    assert.deepEqual(options.schema.properties.findings.items.required, ["id", "name", "description"]);
    const payloadStart = prompt.indexOf("\n\n");
    assert.ok(payloadStart > 0, "the request separates its instructions from the JSON payload");
    assert.ok(!prompt.includes(preferenceText));
    assert.deepEqual(JSON.parse(prompt.slice(payloadStart + 2)), {
      skills: [
        {
          id: release.id,
          job: "publish",
          steps: ["npm version patch", "npm publish"],
          check: "npm view acme-toolkit version",
          days: 3,
        },
        { id: checks.id, job: "test", steps: ["npm test"], check: null, days: 3, costly: 0 },
      ],
    });

    assert.equal(result.why, null);
    assert.equal(result.model, model);
    assert.equal(result.sentItems, 2);
    assert.equal(result.tokens, Math.ceil((prompt.length + options.system.length) / 4));
    assert.deepEqual(result.names, {
      [release.id]: {
        title: "publish-toolkit",
        description: "Publishes the package, then checks the registry.",
      },
      [checks.id]: { title: "run-checks", description: "Runs the test suite." },
    });
    const line = naming.nameLine(result, [release.plainName, checks.plainName], 1);
    assert.match(line ?? "", /asked twice: to read 1 PR review and to name 2 skills/);

    const compiled = release.skill!.compiled!;
    const renamed = naming.applyName(compiled, result.names[release.id]);
    assert.equal(renamed.name, "publish-toolkit");
    assert.equal(renamed.description, "Publishes the package, then checks the registry.");
    assert.strictEqual(renamed.steps, compiled.steps);
    assert.equal(renamed.check, compiled.check);
    assert.strictEqual(renamed.meta, compiled.meta);
    assert.equal(compiled.name, "release-npm");
    assert.equal(compiled.description, "Original compiled description.");
    assert.strictEqual(naming.applyName(compiled, result.names[preference.id]), compiled);
  });

  test("a refusal preserves the plain names and tells the user how to retry", async () => {
    const said = 'Could not name "release-npm".';
    arrange(join(home!, "bin", "claude"), { ok: false, why: "refused", said });

    const result = await naming.nameItems([release], { HOME: home }, { timeoutMs: 2500 });

    assert.equal(claude.requests.length, 1);
    assert.equal(claude.requests[0].timeoutMs, 2500);
    assert.equal(result.why, "refused");
    assert.equal(result.said, said);
    assert.equal(result.sentItems, 1);
    assert.deepEqual(result.names, {});
    const line = naming.nameLine(result, [release.plainName], 0);
    assert.match(line ?? "", /Claude Code said no \("Could not name 'release-npm'\."\)/);
    assert.match(line ?? "", /plain names/);
    assert.match(line ?? "", /trail init --look-back/);
  });
});
