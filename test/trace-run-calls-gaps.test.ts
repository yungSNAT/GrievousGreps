import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix, sep } from "node:path";
import {
  cleanTail,
  effectiveFolder,
  foldKind,
  hostRefused,
  interpreterKind,
  makeCall,
  runHelpers,
  wentToBackground,
} from "../src/trace/run-calls.js";

describe("folding Bash calls and their results", () => {
  let scratch: string | undefined;
  let checkout: string;
  let home: string;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "trace-run-calls-gaps-"));
    checkout = join(scratch, "checkout");
    home = join(scratch, "home");
    mkdirSync(join(checkout, "packages"), { recursive: true });
    mkdirSync(join(home, "workspace"), { recursive: true });
  });

  after(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  test("leading cd commands resolve relative paths, home, and the previous folder", () => {
    assert.equal(effectiveFolder(checkout, "cd packages && npm test"), join(checkout, "packages"));
    assert.equal(effectiveFolder(checkout, "cd ~ && npm test"), homedir());
    assert.equal(effectiveFolder(checkout, "cd ~/workspace && npm test", home), join(home, "workspace"));
    assert.equal(effectiveFolder(checkout, "cd packages && cd - && npm test"), checkout);
    assert.equal(effectiveFolder(checkout, "cd - && npm test"), null);
  });

  test("HOME is expanded, but a misconfigured HOME of '-' does not resolve to a folder", () => {
    const raw = 'cd packages && cd "$HOME" && npm test';
    assert.equal(effectiveFolder(checkout, raw, home), home);
    // An argument that becomes "-" after expansion reaches cdTarget's guard;
    // a literal "cd -" is handled separately using the previous folder.
    assert.equal(effectiveFolder(checkout, raw, "-"), null);
  });

  test("a shell-dependent cd leaves the call unplaced rather than using the fallback checkout", () => {
    const raw = 'cd "$BUILD_DIR" && npm test';
    const placeOf = mock.fn((_folder: string) => ({ key: "project", root: checkout }));
    const call = makeCall(
      { id: "toolu_test", at: "2025-03-01T12:00:00Z", input: { command: raw } },
      raw,
      null,
      placeOf,
      checkout,
      home,
    );

    assert.equal(call.key, null);
    assert.equal(call.cwd, null);
    assert.equal(placeOf.mock.callCount(), 0);
  });

  test("an interpreter heredoc is classified by what its program does", () => {
    const print = 'print("ready")';
    const write = [
      'with open("report.txt", "w") as report:',
      '    report.write("ready")',
    ].join("\n");
    const heredoc = (body: string) => ["python3 - <<'PY'", body, "PY"].join("\n");

    assert.equal(interpreterKind(print), "look");
    assert.equal(interpreterKind(write), "work");
    assert.equal(foldKind(heredoc(print), null), "look");
    assert.equal(foldKind(heredoc(write), null), "work");
  });

  test("a workspace policy block is a host refusal, but output quoting it is not", () => {
    const refusal = "Bash in 'release worktree' was blocked by a workspace policy.";
    assert.equal(hostRefused(`  ${refusal}`), true);
    assert.equal(hostRefused(`Test fixture printed: ${refusal}`), false);
    assert.equal(hostRefused("Bash in 'release worktree' was allowed."), false);
  });

  test("a background notification survives a mark's tail, but not when quoted in a log", () => {
    // This is a path in a recorded Claude Code result, not a local filesystem path.
    const outputPath = posix.join(
      posix.sep,
      "tmp",
      ...Array.from({ length: 12 }, (_, i) => `workspace-${i}-with-a-long-cache-directory`),
      "tasks",
      "check-42.output",
    );
    const notice = `Output is being written to: ${outputPath}. You will be notified when it completes.`;
    const markTail = notice.slice(-200);

    assert.equal(wentToBackground(markTail), true);
    assert.equal(wentToBackground(`${markTail} To check interim output, use Read on that file path.`), true);
    assert.equal(wentToBackground(`Test runner diagnostic:\n${markTail}`), false);
    assert.equal(wentToBackground(markTail.replace("check-42.output", "check-42.log")), false);
    assert.equal(wentToBackground(`  ${notice.slice(-400)}\r\n`), true, "the length limit applies after trimming");
    assert.equal(wentToBackground(notice.slice(-401)), false, "the suffix alone is not enough past the limit");
    assert.equal(wentToBackground(notice), false, "a long line cannot be a mark tail");
    assert.equal(
      wentToBackground(
        `Command did not complete within its 500ms timeout and was moved to the background (ID: check-42). ${notice}`,
      ),
      true,
      "the full host result is recognized by its opening text",
    );
  });

  test("result tails discard older output and retain separate publish and push lines", () => {
    const publish = "+ example-package@1.2.3";
    const push = "abc1234..def5678 main -> beta";
    const recent = `\r\n  ${publish}  \r\n\r\n  ${push}  \r\n`;
    const result = `older build output\r\n${" ".repeat(200 - recent.length)}${recent}`;

    assert.equal(cleanTail(result), `${publish}\n${push}`);
    assert.equal(cleanTail("  \r\n\t"), undefined);
  });

  test("a result tail is withheld if it retains a credential, not if the credential aged out", () => {
    const fakeToken = "ghp_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const credentialLine = `Unexpected credential in command output: ${fakeToken}`;
    assert.equal(cleanTail(credentialLine), undefined);

    const summary = "Tests: 1 passed";
    assert.equal(cleanTail(`${credentialLine}\r\n${" ".repeat(200)}\r\n${summary}`), summary);
  });

  test("a missing tool result has no status notification or tail", () => {
    // A JavaScript caller can pass an absent transcript field despite the TS signature.
    const missing = undefined as unknown as string;
    assert.equal(hostRefused(missing), false);
    assert.equal(wentToBackground(missing), false);
    assert.equal(cleanTail(missing), undefined);
  });

  test("helper discovery keeps each successful scratch script once and skips failed calls", () => {
    // Use forward slashes for the Bash spelling, including on Windows.
    const script = join(checkout, "check artifact.mjs").split(sep).join(posix.sep);
    const failedScript = join(checkout, "retry artifact.mjs").split(sep).join(posix.sep);
    const call = {
      id: "toolu_helper",
      at: "2025-03-01T12:00:00Z",
      cmd: `node --no-warnings "${script}"`,
      key: null,
      cwd: null,
      bg: false,
      failed: false,
      isError: false,
      kind: "step" as const,
      src: { use: 0, result: 1 },
    };

    assert.deepEqual(runHelpers({
      calls: [
        call,
        { ...call, id: "toolu_retry", cmd: `node "${failedScript}"`, failed: true },
        { ...call, id: "toolu_recheck" },
      ],
    }), [script]);
  });
});
