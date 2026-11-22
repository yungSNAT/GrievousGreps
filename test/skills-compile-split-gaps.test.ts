import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pollLoop, splitSheet, statementsOf } from "../src/skills/compile-split.js";
import { tmpRepo } from "./helpers.js";

type Context = Parameters<typeof statementsOf>[2];
type Sheet = Parameters<typeof splitSheet>[0];
type Call = Sheet["calls"][number];

let ctx: Context;

before(() => {
  const home = tmpRepo("compile-split-gaps");
  ctx = { home, repoRoot: join(home, "repo"), job: null };
  mkdirSync(join(ctx.repoRoot, "packages", "cli"), { recursive: true });
});

after(() => {
  if (ctx) rmSync(ctx.home, { recursive: true, force: true });
});

// These fixtures supply the trace fields that splitSheet reads.
function stepCall(cmd: string, overrides: Partial<Call> = {}): Call {
  return {
    cmd,
    cwd: "",
    kind: "step",
    failed: false,
    bg: false,
    truncated: false,
    multiLine: cmd.includes("\n"),
    ...overrides,
  } as Call;
}

function runSheet(...calls: Call[]): Sheet {
  return { calls, job: null, checkIndex: -1 } as Sheet;
}

describe("statementsOf", () => {
  test("tracks redirected cd, the directory stack, and re-entry from an unknown cwd", () => {
    // The first command keeps the cds below from being treated as fold-applied leading cds.
    const script = [
      "git tag at-root",
      "AREA=packages",
      'cd "$AREA" 2>/dev/null || exit 1',
      "git tag in-packages",
      "pushd cli",
      "git tag in-cli",
      "popd",
      "git tag back-in-packages",
      "cd",
      "git tag at-home",
      "cd repo",
      "git tag after-unknown-relative-cd",
      'cd "$HOME/repo"',
      "git tag back-at-root",
      'cd "$OTHER_CHECKOUT"',
      "git tag at-unknown-checkout",
    ].join("\n");

    assert.deepEqual(
      statementsOf(script, "", ctx)
        .filter(({ kind }) => kind === "step")
        .map(({ text, cwd }) => [text, cwd]),
      [
        ["git tag at-root", ""],
        ["git tag in-packages", "packages"],
        ["git tag in-cli", "packages/cli"],
        ["git tag back-in-packages", "packages"],
        ["git tag at-home", null],
        ["git tag after-unknown-relative-cd", null],
        ["git tag back-at-root", ""],
        ["git tag at-unknown-checkout", null],
      ],
    );
  });

  test("keeps a guarded step intact and separates a status look and an echo header", () => {
    const guarded = "git diff --quiet && git tag v1.2.3";
    const verify = "git rev-parse --verify HEAD";
    const look = "git status --short";
    const push = "git push origin main";
    const statements = statementsOf(
      `${guarded}\n${verify}\n${look}\necho publishing && ${push}`,
      "",
      ctx,
    );

    assert.deepEqual(
      statements.filter(({ kind }) => kind === "step").map(({ text, blocked }) => [text, blocked]),
      [[guarded, null], [verify, null], [push, null]],
    );
    assert.equal(statements.find(({ text }) => text === look)?.kind, "look");
  });

  test("inlines plain values but blocks a step that reads an earlier dynamic assignment", () => {
    const script = [
      "CHANNEL=stable",
      'STAMP="$(git rev-parse --short HEAD)"',
      'git tag -m "$HOME:$STAMP" release-$CHANNEL',
      "git tag -m '$STAMP' release-${CHANNEL}-literal",
    ].join("\n");

    assert.deepEqual(
      statementsOf(script, "", ctx)
        .filter(({ kind }) => kind === "step")
        .map(({ text, blocked }) => [text, blocked]),
      [
        ['git tag -m "$HOME:$STAMP" release-stable', "uses $STAMP, set on an earlier line"],
        ["git tag -m '$STAMP' release-stable-literal", null],
      ],
    );
  });

  test("carries a plain export but records setup that a later command cannot run without", () => {
    const script = [
      "export GIT_EDITOR=true",
      "git tag -a v1.2.3",
      "source ./release-env.sh",
      "git push origin main",
    ].join("\n");

    assert.deepEqual(
      statementsOf(script, "", ctx)
        .filter(({ kind }) => kind === "step")
        .map(({ text, blocked }) => [text, blocked]),
      [
        ["GIT_EDITOR=true git tag -a v1.2.3", null],
        ["GIT_EDITOR=true git push origin main", "needs its shell set up first (`source ./release-env.sh`)"],
      ],
    );
  });

  test("an empty or setup-free no-op call contributes no statements", () => {
    assert.deepEqual(statementsOf("", "", ctx), []);
    assert.deepEqual(statementsOf("# nothing to publish\nset -e\ntrue\n:", "", ctx), []);
  });

  const scriptBlock = "runs a script written inline (a heredoc)";
  const heredocs = [
    {
      name: "a Python heredoc that only prints is a look",
      head: "python3 - <<'PY'",
      body: 'print("ready")',
      end: "PY",
      kind: "look",
      blocked: null,
    },
    {
      name: "a Python heredoc that writes a file is work, not a step",
      head: "python3 - <<'PY'",
      body: 'with open("release.txt", "w") as output:\n    output.write("ready")',
      end: "PY",
      kind: "work",
      blocked: null,
    },
    {
      name: "a shell heredoc retains its body and blocks the step",
      head: "bash <<'SH'",
      body: "git tag v1.2.3",
      end: "SH",
      kind: "step",
      blocked: scriptBlock,
    },
    {
      name: "a heredoc on an ordinary step also retains its body and blocks the step",
      head: "git tag -a v1.2.3 -F - <<'MSG'",
      body: "Release notes for 1.2.3",
      end: "MSG",
      kind: "step",
      blocked: scriptBlock,
    },
  ] as const;

  for (const { name, head, body, end, kind, blocked } of heredocs) {
    test(name, () => {
      const next = "git push origin main";
      const statements = statementsOf([head, body, end, next].join("\n"), "", ctx);

      assert.equal(statements.length, 2);
      const [script, following] = statements;
      assert.ok(script);
      assert.ok(following);
      assert.equal(script.kind, kind);
      assert.equal(script.heredoc, true);
      // The scanner's body span includes the closing delimiter line.
      assert.equal(script.body.trim(), `${body}\n${end}`);
      assert.equal(script.blocked, blocked);
      assert.equal(following.text, next);
      assert.equal(following.kind, "step");
      assert.equal(following.heredoc, false);
      assert.equal(following.body, "");
      assert.equal(following.blocked, null);
    });
  }
});

describe("pollLoop", () => {
  const ref = "git rev-parse --verify refs/heads/release";
  const quiet = "git diff --quiet";

  for (const { header, cmd, wait } of [
    { header: `until ${ref} >/dev/null 2>&1`, cmd: ref, wait: { token: null } },
    { header: `while ! ${ref}`, cmd: ref, wait: { token: null } },
    { header: `while ${quiet}`, cmd: quiet, wait: { token: null, whileOk: true } },
    { header: `until ! ${quiet}`, cmd: quiet, wait: { token: null, whileOk: true } },
  ]) {
    test(`reads the exit-status wait from ${header}`, () => {
      assert.deepEqual(pollLoop(`${header}; do sleep 0.5; done`), { cmd, wait });
    });
  }

  test("does not collapse a loop that runs a second command on each retry", () => {
    assert.equal(
      pollLoop(`until ${ref}; do git fetch origin; sleep 1; done`),
      null,
    );
  });

  test("does not extract a command that depends on the loop's own variable", () => {
    assert.equal(
      pollLoop('for ref in main release; do git rev-parse --verify "$ref" && break; sleep 1; done'),
      null,
    );
  });
});

describe("splitSheet", () => {
  test("attaches the polling condition to the extracted step, not to its neighbors", () => {
    const probe = "git rev-parse --abbrev-ref HEAD";
    const push = "git push origin release";
    const call = stepCall([
      `until [ "$(${probe})" = release ]; do sleep 1; done`,
      push,
    ].join("\n"));

    const result = splitSheet(runSheet(call), ctx);
    assert.deepEqual(result.sheet.calls.map(({ cmd, kind }) => [cmd, kind]), [
      [probe, "step"],
      [push, "step"],
    ]);
    const [waitStep, pushStep] = result.sheet.calls;
    assert.ok(waitStep);
    assert.ok(pushStep);
    assert.deepEqual(result.waits.get(waitStep), { token: "release" });
    assert.equal(result.waits.has(pushStep), false);
    assert.equal(result.blocked.size, 0);
    assert.deepEqual(result.parts.get(call), [waitStep, pushStep]);
  });

  test("keeps truncated steps and heredocs whole but splits a truncated call containing only looks", () => {
    const step = stepCall("git status --short\ngit tag v1.2.3", { truncated: true });
    const heredoc = stepCall(
      "python3 - <<'PY'\nprint(\"ready\")\nPY\ngit status --short",
      { truncated: true },
    );
    const looks = stepCall("git status --short\ngit diff --stat", { truncated: true });

    const { sheet, parts } = splitSheet(runSheet(step, heredoc, looks), ctx);

    assert.equal(sheet.calls[0], step);
    assert.equal(sheet.calls[1], heredoc);
    assert.deepEqual(parts.get(step), [step]);
    assert.deepEqual(parts.get(heredoc), [heredoc]);
    assert.deepEqual(
      sheet.calls.slice(2).map(({ cmd, kind, truncated }) => [cmd, kind, truncated]),
      [
        ["git status --short", "look", false],
        ["git diff --stat", "look", false],
      ],
    );
    assert.deepEqual(parts.get(looks), sheet.calls.slice(2));
  });
});
