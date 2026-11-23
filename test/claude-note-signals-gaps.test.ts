import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { fileWordRe, noteAsk, noteSignals } from "../src/claude/note-signals.js";
import { tmpRepo } from "./helpers.js";

type Block = Record<string, unknown>;
type Entry = Record<string, unknown>;

const billingFile = ["packages", "billing app", "web", "src", "totals.ts"] as const;
const taxFile = ["service", "src", "tax.ts"] as const;
const settingsFile = [".claude", "settings.json"] as const;
let repo: string;

before(() => {
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Transcript tests must not use the network");
  });
  repo = tmpRepo("note-signals-gaps");
  for (const parts of [billingFile, taxFile, settingsFile]) {
    const file = join(repo, ...parts);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, parts === settingsFile ? "{}\n" : "export const rate = 3;\n");
  }
});

after(() => {
  mock.restoreAll();
  if (repo) rmSync(repo, { recursive: true, force: true });
});

function assistant(uuid: string, content: Block[], cwd?: string): Entry {
  return { type: "assistant", uuid, cwd, message: { role: "assistant", content } };
}

function user(uuid: string, content: string | Block[]): Entry {
  return { type: "user", uuid, message: { role: "user", content } };
}

function tool(uuid: string, name: string, input: Block, cwd?: string): Entry {
  return assistant(uuid, [{ type: "tool_use", id: `tool-${uuid}`, name, input }], cwd);
}

// Commands are recorded tool inputs, never executed by the tests.
function bash(uuid: string, command: string, cwd?: string): Entry {
  return tool(uuid, "Bash", { command }, cwd);
}

function result(uuid: string, content: string | Block[] = "", isError = false): Entry {
  return user(`result-${uuid}`, [
    { type: "tool_result", tool_use_id: `tool-${uuid}`, is_error: isError, content },
  ]);
}

function signals(...entries: Entry[]) {
  return noteSignals(entries.map((entry) => JSON.stringify(entry)).join("\n"), repo);
}

describe("file names in recorded shell commands", () => {
  const words = (text: string, re: RegExp) => Array.from(text.matchAll(re), (m) => m[0]);

  test("keeps the Windows drive and directories in native and Git Bash paths", () => {
    const native = win32.join("C:", "work", "shop", "src", "totals.ts");
    const gitBash = native.split(win32.sep).join(posix.sep);
    const command = `sed -i 's/old/new/' "${native}" "${gitBash}" README.md`;
    assert.deepEqual(words(command, fileWordRe("win32")), [native, gitBash]);
  });

  test("matches a POSIX absolute path and supports the default platform", () => {
    const file = posix.join(posix.sep, "work", "shop", "src", "totals.ts");
    assert.deepEqual(words(`tee ${file} README.md`, fileWordRe("linux")), [file]);
    assert.deepEqual(words("tee totals.ts README.md", fileWordRe()), ["totals.ts"]);
  });
});

describe("checks that fail and then pass", () => {
  test("finds a shell edit under a quoted cd relative to transcript cwd and keys on the first pass", () => {
    const cwd = join(repo, "packages");
    const checkCwd = join(cwd, "billing app");
    const check = "npm --prefix=web test";
    const target = posix.join("web", "src", "totals.ts");

    assert.deepEqual(
      signals(
        bash("hidden-failure", `${check} | tail -n 10`, checkCwd),
        result("hidden-failure", [{ type: "text", text: "# fail 2" }]),
        bash("exit-failure", `${check} -- --runInBand`, checkCwd),
        result("exit-failure", "The runner exited before printing its summary.", true),
        bash("fix", `cd "billing app" && sed -i 's/float/integer/' ${target}`, cwd),
        result("fix"),
        bash("first-pass", `${check} | tail -n 10`, checkCwd),
        result("first-pass", "2 passed, 0 failed"),
        bash("rerun", `${check} -- --runInBand`, checkCwd),
        result("rerun", "All tests passed."),
      ),
      [{
        kind: "fixed",
        key: "fixed:first-pass",
        what: `${check} failed 2 times, then passed after your change to ${posix.join(...billingFile)}.`,
      }],
    );
  });

  test("does not credit a settings write or a failed source write for a passing check", () => {
    assert.deepEqual(
      signals(
        bash("failure", "npm run typecheck"),
        result("failure", "error TS2322: Type 'string' is not assignable to type 'number'."),
        bash("settings", `printf '{}' > ${posix.join(...settingsFile)}`),
        result("settings"),
        bash("failed-write", `sed -i 's/old/new/' ${posix.join(...taxFile)}`),
        result("failed-write", "Permission denied", true),
        bash("pass", "npm run typecheck"),
        result("pass", "Type check passed."),
      ),
      [],
    );
  });

  test("credits a shell write with a computed filename without guessing the path", () => {
    assert.deepEqual(
      signals(
        bash("failure", "npx tsc --noEmit"),
        result("failure", "error TS2307: Cannot find module './retry-config'."),
        bash(
          "generate",
          `node -e 'require("node:fs").writeFileSync(process.argv[1] + ".ts", "export const retries = 3;")' retry-config`,
        ),
        result("generate"),
        bash("pass", "npx tsc --noEmit"),
        result("pass"),
      ),
      [{
        kind: "fixed",
        key: "fixed:pass",
        what: "npx tsc failed once, then passed after your change.",
      }],
    );
  });
});

test("a block-form correction counts after repo work, not after setup alone", () => {
  const conversation = [
    user("request", "Can you fix the billing totals?"),
    assistant("proposal", [{ type: "text", text: "I'll round each amount before summing." }]),
    user("correction", [
      { type: "text" }, // A text block with no payload should not become the first line.
      { type: "text", text: '  No, keep the totals in "cents".' },
      { type: "text", text: "Round only the final display amount." },
    ]),
  ];

  assert.deepEqual(
    signals(...conversation, bash("setup", "npm install && trail init;"), result("setup")),
    [],
  );
  assert.deepEqual(
    signals(
      ...conversation,
      bash("inspect", "npm install && git diff --stat"),
      result("inspect", "1 file changed"),
    ),
    [{
      kind: "corrected",
      key: "corrected:correction",
      what: `The user corrected you ("No, keep the totals in 'cents'.").`,
    }],
  );
});

describe("shipping after a learning conflict", () => {
  test("an unrelated edit does not clear a failed trail check's conflict", () => {
    const conflict = [
      tool("original-edit", "Edit", { file_path: join(repo, ...taxFile) }),
      bash("check", "trail check"),
      result("check", `✗ ${posix.join(...taxFile)}:12: Keep rates in basis points.`, true),
    ];
    const shipment = [
      bash("pr", 'gh pr create --title "Update billing rates"'),
      result("pr", "Created pull request #42"),
    ];
    const shipped = {
      kind: "shipped",
      key: "shipped:pr",
      what: "You opened a PR for this work, and no learning went with it.",
    };
    const detected = signals(
      ...conflict,
      tool("unrelated-edit", "Edit", { file_path: join(repo, ...billingFile) }),
      ...shipment,
    );

    assert.deepEqual(detected, [
      {
        kind: "overrode",
        key: "overrode:pr",
        what: "trail check found this change goes against a learning, and it shipped anyway.",
      },
      shipped,
    ]);
    const ask = noteAsk(detected[0]!);
    assert.match(ask, /--replaces <the old learning's file>/);
    assert.match(ask, /if the learning still holds and this is an exception, say so and stop/i);

    assert.deepEqual(
      signals(
        ...conflict,
        tool("address-conflict", "Edit", { file_path: join(repo, ...taxFile) }),
        ...shipment,
      ),
      [shipped],
    );
  });

  test("a blocked commit is not shipping, and a shell edit to a named file clears the override", () => {
    const blocked = [
      tool("original-edit", "Edit", { file_path: join(repo, ...taxFile) }),
      bash("blocked", 'git commit -m "Update tax rates"'),
      result(
        "blocked",
        [
          "trail check found 2 conflicts",
          `- ${posix.join(...billingFile)}:4: Keep totals in cents.`,
          `- ${posix.join(...taxFile)}:12: Keep rates in basis points.`,
        ].join("\n"),
        true,
      ),
    ];
    const retry = [
      bash("retry", 'git commit -m "Update tax rates"'),
      result("retry", "1 file changed"),
    ];

    assert.deepEqual(signals(...blocked), []);
    assert.deepEqual(
      signals(...blocked, ...retry).map(({ kind, key }) => ({ kind, key })),
      [
        { kind: "overrode", key: "overrode:retry" },
        { kind: "shipped", key: "shipped:retry" },
      ],
    );
    assert.deepEqual(
      signals(
        ...blocked,
        bash("fix", `cd service; sed -i 's/percent/basisPoints/' ${posix.join("src", "tax.ts")}`),
        result("fix"),
        ...retry,
      ),
      [{
        kind: "shipped",
        key: "shipped:retry",
        what: "You committed this work, and no learning went with it.",
      }],
    );
  });
});
