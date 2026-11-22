import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DEPTH,
  heredocInterpreter,
  inlineScript,
  programOfText,
  quotedTextHit,
  shellScript,
  simpleCommands,
  writesFile,
} from "../src/trace/shell-words.js";

describe("shell and interpreter scripts", () => {
  test("extracts a shell command string from combined flags", () => {
    assert.equal(
      shellScript(["bash", "-lc", "'printf ready; git status'"]),
      "printf ready; git status",
    );
    assert.equal(shellScript(["sh", "-c", "''"]), "");
  });

  test("does not extract code without a shell, a command flag, and an operand", () => {
    assert.equal(shellScript([]), null);
    assert.equal(shellScript(["sh"]), null);
    assert.equal(shellScript(["sh", "-s", "build"]), null);
    assert.equal(shellScript(["sh", "-c"]), null);
    assert.equal(shellScript(["node", "-c", "build.js"]), null);
  });

  test("skips flag values before looking for inline code", () => {
    assert.equal(
      inlineScript(["node", "--require", "./register.cjs", "-e", "'console.log(42)'"]),
      "console.log(42)",
    );
    assert.equal(
      inlineScript(["python3", "-B", "-W", "ignore", "-c", "'print(42)'"]),
      "print(42)",
    );
  });

  test("does not mistake a script's arguments for interpreter flags", () => {
    assert.equal(
      inlineScript(["python3", "-W", "ignore", "report.py", "-c", "'summary'"]),
      null,
    );
    assert.equal(inlineScript(["node", "-r", "./register.cjs", "--eval"]), null);
  });

  test("recognizes stdin programs after options or an explicit dash", () => {
    assert.equal(heredocInterpreter(["node", "--no-warnings"]), "node");
    assert.equal(
      heredocInterpreter(["node", "--no-warnings", "<<'JS'", "2>errors.log"]),
      "node",
    );
    assert.equal(
      heredocInterpreter(["python3", "-u", "-", "weekly", "<<'PY'"]),
      "python3",
    );
  });

  test("does not treat heredoc data for a named script as interpreter code", () => {
    assert.equal(heredocInterpreter(["python3", "-u", "report.py", "<<'DATA'"]), null);
    assert.equal(heredocInterpreter(["cat", "<<'DATA'"]), null);
    assert.equal(heredocInterpreter([]), null);
  });
});

describe("program and command discovery", () => {
  test("finds the first non-plumbing program inside a shell command string", () => {
    assert.deepEqual(programOfText("sh -c 'printf ready; git status'"), {
      prog: "git status",
      plumbing: false,
    });
    assert.deepEqual(programOfText("sh -c ''"), { prog: null, plumbing: true });
  });

  test("looks inside a subshell before considering the next outer command", () => {
    assert.deepEqual(programOfText("(printf ready; npm run check); git status"), {
      prog: "npm run",
      plumbing: false,
    });
  });

  test("accepts a literal quoted executable but does not guess a variable's value", () => {
    assert.deepEqual(programOfText('"git" status'), {
      prog: "git status",
      plumbing: false,
    });
    assert.deepEqual(programOfText('printf ready; "$TOOL" status; git status'), {
      prog: null,
      plumbing: false,
    });
  });

  test("flattens nested subshells in command order", () => {
    assert.deepEqual(
      simpleCommands("(printf ready; (git status; npm run check)); echo done"),
      ["printf ready", "git status", "npm run check", "echo done"],
    );
  });

  test("keeps the loop body without treating its header as a command", () => {
    const commands = simpleCommands('for item in alpha beta; do printf "%s" "$item"; done');
    assert.ok(commands.includes('printf "%s" "$item"'));
    assert.ok(!commands.some((command) => /^(?:for|do)\b/.test(command)));
  });

  test("skips a plumbing condition to find the program in the then branch", () => {
    assert.deepEqual(programOfText("if true; then npm run check; fi"), {
      prog: "npm run",
      plumbing: false,
    });
  });

  test("keeps a subshell body intact when descending would exceed the depth limit", () => {
    const body = "printf ready; git status";
    const command = `(${body})`;
    assert.deepEqual(simpleCommands(command, MAX_DEPTH - 1), ["printf ready", "git status"]);
    assert.deepEqual(simpleCommands(command, MAX_DEPTH), [body]);
  });
});

describe("redirects and quoted text", () => {
  test("distinguishes file redirects from quoted text and discarded output", () => {
    assert.equal(writesFile("printf ready >> build.log"), true);
    assert.equal(writesFile("git status 2> diagnostics.log"), true);
    assert.equal(writesFile("printf '%s' 'example > build.log'"), false);
    assert.equal(writesFile("git status > /dev/null"), false);
    assert.equal(writesFile("git status 2>&1"), false);
  });

  test("only treats ordinary printf as a reader of its quoted arguments", () => {
    const hitOf = (text: string) => text.includes("release-note") ? "segment hit" : null;
    assert.equal(quotedTextHit("printf '%s' 'release-note'", hitOf, "whole hit"), null);
    assert.equal(
      quotedTextHit("printf -v note '%s' 'release-note'", hitOf, "whole hit"),
      "segment hit",
    );
  });
});
