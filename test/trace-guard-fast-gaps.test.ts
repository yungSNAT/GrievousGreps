import { test, describe, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter, basename } from "node:path";
import { createHash } from "node:crypto";
import type * as Fs from "node:fs";
import {
  SURE_FAIL_REASON,
  FIXED_DIRS,
  pathDirs,
  programFiles,
  timeoutOnPath,
  sureFail,
  markDenied,
} from "../src/trace/guard-fast.js";
import { sessionPath } from "../src/trace/gate-file.js";
import { normalizeCommand, stripTimeout } from "../src/trace/shell.js";

const roots: string[] = [];
function scratch(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `gf-gaps-${tag}-`));
  roots.push(d);
  return d;
}

// The module reads fs through process.getBuiltinModule, i.e. the mutable CJS exports object.
// Hide any real `timeout` program of this machine (e.g. in /usr/local/bin or a nix profile) so the
// deny path is reachable everywhere; timeout files placed in our scratch folders stay visible.
const fsMod = process.getBuiltinModule("node:fs") as typeof Fs;
const realStat = fsMod.statSync.bind(fsMod) as (...a: unknown[]) => unknown;
mock.method(fsMod, "statSync", (...args: unknown[]) => {
  const p = String(args[0]);
  if (basename(p).toLowerCase().startsWith("timeout") && !roots.some((r) => p.startsWith(r))) {
    const err = new Error(`ENOENT: no such file or directory, stat '${p}'`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }
  return realStat(...args);
});

after(() => {
  mock.restoreAll();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const KEPT = "---\nstatus: active\ncheck: no-timeout\nenforce: sure-fail\n---\n# No timeout\nThis Mac has none.\n";

function makeEnv(): { env: NodeJS.ProcessEnv; trail: string; home: string; pathDir: string } {
  const home = scratch("home");
  const trail = scratch("trail");
  const pathDir = scratch("path");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    TRAIL_HOME: trail,
    PATH: pathDir,
    USER: "gf-nobody-test",
    LOGNAME: "gf-nobody-test",
  };
  return { env, trail, home, pathDir };
}

function writeGuardrail(trail: string, text: string): void {
  mkdirSync(join(trail, "learnings"), { recursive: true });
  writeFileSync(join(trail, "learnings", "no-timeout.md"), text);
}

function placeTimeout(dir: string, executable = true): void {
  mkdirSync(dir, { recursive: true });
  const name = process.platform === "win32" ? "timeout.exe" : "timeout";
  writeFileSync(join(dir, name), "#!/bin/sh\nexit 0\n", { mode: executable ? 0o755 : 0o644 });
}

function keptEnv(): NodeJS.ProcessEnv {
  const e = makeEnv();
  writeGuardrail(e.trail, KEPT);
  return e.env;
}

describe("sureFail deny path", () => {
  test("denies a plain timeout run when the guardrail is kept and no timeout exists", () => {
    const env = keptEnv();
    assert.equal(timeoutOnPath(env), false);
    const r = sureFail("timeout 5 npm test", env);
    assert.deepEqual(r, { deny: SURE_FAIL_REASON, check: "no-timeout" });
    assert.match(r!.deny, /trail forget no-timeout/);
    assert.match(r!.deny, /timeout: command not found/);
  });

  test("denies after env prefixes and in chained commands", () => {
    const env = keptEnv();
    assert.equal(sureFail("FOO=1 env -u BAR X=2 timeout 10 make build", env)?.check, "no-timeout");
    assert.equal(sureFail("env -i timeout 10 make", env)?.check, "no-timeout");
    assert.equal(sureFail("cd app && timeout 30 npm test", env)?.check, "no-timeout");
  });

  test("allows when the command changes PATH or loads shell setup", () => {
    const env = keptEnv();
    assert.ok(sureFail("timeout 5 npm test", env), "baseline denies");
    for (const cmd of [
      "export PATH=/opt/x/bin:$PATH; timeout 5 npm test",
      "PATH+=/opt/x; timeout 5 npm test",
      "declare -x PATH=/opt/x; timeout 5 npm test",
      "source ~/.zshrc && timeout 5 npm test",
      ". ./env.sh && timeout 5 npm test",
      "eval \"$(brew shellenv)\" && timeout 5 npm test",
      "hash -r; timeout 5 npm test",
    ]) {
      assert.equal(sureFail(cmd, env), null, cmd);
    }
  });

  test("allows when the command defines or probes its own timeout", () => {
    const env = keptEnv();
    for (const cmd of [
      "timeout() { \"$@\"; }; timeout 5 npm test",
      "function timeout { \"$@\"; }; timeout 5 npm test",
      "alias timeout='gtimeout'; timeout 5 npm test",
      "command -v timeout && timeout 5 npm test",
      "which timeout",
    ]) {
      assert.equal(sureFail(cmd, env), null, cmd);
    }
  });

  test("allows gtimeout, non-durations, non-strings, commands without timeout and very long commands", () => {
    const env = keptEnv();
    assert.equal(sureFail("gtimeout 5 npm test", env), null);
    assert.equal(sureFail("timeout --help", env), null);
    assert.equal(sureFail("npm test", env), null);
    assert.equal(sureFail(42 as unknown as string, env), null);
    assert.equal(sureFail("timeout 5 echo " + "a".repeat(70 * 1024), env), null);
  });

  test("allows when a timeout program is on PATH", () => {
    const e = makeEnv();
    writeGuardrail(e.trail, KEPT);
    placeTimeout(e.pathDir);
    assert.equal(timeoutOnPath(e.env), true);
    assert.equal(sureFail("timeout 5 npm test", e.env), null);
  });
});

describe("guardrail file variants", () => {
  function verdict(text: string | null, makeDir = false): ReturnType<typeof sureFail> {
    const e = makeEnv();
    if (makeDir) mkdirSync(join(e.trail, "learnings", "no-timeout.md"), { recursive: true });
    else if (text !== null) writeGuardrail(e.trail, text);
    return sureFail("timeout 5 npm test", e.env);
  }

  test("a missing status counts as active", () => {
    assert.equal(verdict("---\ncheck: no-timeout\nenforce: sure-fail\n---\n")?.check, "no-timeout");
  });

  test("quoted, padded, upper-case values and CRLF endings still count", () => {
    assert.equal(verdict("---\r\nstatus: 'Active'\r\ncheck:  \"No-Timeout\" \r\nenforce: Sure-Fail\r\n---")?.check, "no-timeout");
  });

  test("retired, edited, missing, unframed, oversized or folder guardrails allow", () => {
    assert.equal(verdict("---\nstatus: retired\ncheck: no-timeout\nenforce: sure-fail\n---\n"), null);
    assert.equal(verdict("---\nstatus: active\ncheck: no-timeout\nenforce: warn\n---\n"), null);
    assert.equal(verdict("---\nstatus: active\ncheck: other\nenforce: sure-fail\n---\n"), null);
    assert.equal(verdict("status: active\ncheck: no-timeout\nenforce: sure-fail\n"), null);
    assert.equal(verdict(null), null);
    assert.equal(verdict(KEPT + "x".repeat(5000)), null);
    assert.equal(verdict(null, true), null);
  });

  test("a guardrail that is a symlink is not followed", { skip: process.platform === "win32" }, () => {
    const e = makeEnv();
    const real = join(scratch("real"), "kept.md");
    writeFileSync(real, KEPT);
    mkdirSync(join(e.trail, "learnings"), { recursive: true });
    symlinkSync(real, join(e.trail, "learnings", "no-timeout.md"));
    assert.equal(sureFail("timeout 5 npm test", e.env), null);
    const direct = keptEnv();
    assert.equal(sureFail("timeout 5 npm test", direct)?.check, "no-timeout");
  });
});

describe("timeout lookup helpers", () => {
  test("pathDirs keeps only absolute, non-empty entries", () => {
    const a = scratch("pd-a");
    const b = scratch("pd-b");
    const env = { PATH: [a, "", "relative" + "dir", b].join(delimiter) };
    assert.deepEqual(pathDirs(env), [a, b]);
    assert.deepEqual(pathDirs({}), []);
  });

  test("programFiles gives the bare name off Windows and PATHEXT endings on Windows", () => {
    if (process.platform === "win32") {
      assert.deepEqual(programFiles("timeout", { PATHEXT: ".EXE; .Cmd;bad;.toolongextension" }), ["timeout", "timeout.exe", "timeout.cmd"]);
      assert.deepEqual(programFiles("timeout", {}), ["timeout", "timeout.com", "timeout.exe", "timeout.bat", "timeout.cmd"]);
    } else {
      assert.deepEqual(programFiles("timeout", { PATHEXT: ".EXE" }), ["timeout"]);
    }
  });

  test("timeoutOnPath finds timeout in $HOME/.local/bin", () => {
    assert.ok(FIXED_DIRS.includes("$HOME/.local/bin"));
    const e = makeEnv();
    assert.equal(timeoutOnPath(e.env), false);
    placeTimeout(join(e.home, ".local", "bin"));
    assert.equal(timeoutOnPath(e.env), true);
  });

  test("a non-executable timeout file or a folder named timeout does not count", { skip: process.platform === "win32" }, () => {
    const e = makeEnv();
    placeTimeout(e.pathDir, false);
    assert.equal(timeoutOnPath(e.env), false);
    const sub = join(e.pathDir, "nested");
    mkdirSync(join(sub, "timeout"), { recursive: true });
    assert.equal(timeoutOnPath({ ...e.env, PATH: sub }), false);
  });

  test("timeoutOnPath works without USER or LOGNAME, and with an odd user name", () => {
    const e = makeEnv();
    const env = { ...e.env };
    delete env.USER;
    delete env.LOGNAME;
    assert.equal(timeoutOnPath(env), false);
    assert.equal(timeoutOnPath({ ...e.env, USER: "bad user/../x" }), false);
    placeTimeout(join(e.home, "bin"));
    assert.equal(timeoutOnPath(env), true);
  });

  test("timeoutOnPath without HOME falls back to the os home folder", () => {
    const e = makeEnv();
    const env = { ...e.env };
    delete env.HOME;
    assert.equal(timeoutOnPath(env), false);
    placeTimeout(e.pathDir);
    assert.equal(timeoutOnPath(env), true);
  });
});

describe("markDenied", () => {
  const id = "0b9f3c1e-1234-4abc-9def-0123456789ab";

  test("appends one line with the time and the sha of the command without timeout", () => {
    const e = makeEnv();
    const cmd = "timeout 30 npm test";
    const at = new Date("2024-05-06T07:08:09.000Z");
    markDenied(id, cmd, e.env, at);
    const path = sessionPath(id, ".denied.jsonl", e.env);
    assert.ok(existsSync(path), path);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]!);
    const rest = normalizeCommand(stripTimeout(cmd));
    assert.equal(rec.at, "2024-05-06T07:08:09.000Z");
    assert.equal(rec.restSha, `sha256:${createHash("sha256").update(rest).digest("hex")}`);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  test("a missing command hashes the empty rest and the default time is now", () => {
    const e = makeEnv();
    const before = Date.now();
    markDenied(id, undefined as unknown as string, e.env);
    const path = sessionPath(id, ".denied.jsonl", e.env);
    const rec = JSON.parse(readFileSync(path, "utf8").trim());
    const rest = normalizeCommand(stripTimeout(""));
    assert.equal(rec.restSha, `sha256:${createHash("sha256").update(rest).digest("hex")}`);
    const t = Date.parse(rec.at);
    assert.ok(t >= before - 1000 && t <= Date.now() + 1000, rec.at);
  });

  test("stops appending at the 4 KB cap", () => {
    const e = makeEnv();
    for (let i = 0; i < 80; i++) markDenied(id, `timeout ${i} make`, e.env);
    const path = sessionPath(id, ".denied.jsonl", e.env);
    const text = readFileSync(path, "utf8");
    const lines = text.trim().split("\n");
    assert.ok(Buffer.byteLength(text) <= 4096, String(Buffer.byteLength(text)));
    assert.ok(lines.length > 10 && lines.length < 80, String(lines.length));
    for (const l of lines) assert.match(JSON.parse(l).restSha, /^sha256:[0-9a-f]{64}$/);
  });

  test("leaves a folder planted at the file path alone", () => {
    const e = makeEnv();
    const path = sessionPath(id, ".denied.jsonl", e.env);
    mkdirSync(path, { recursive: true });
    markDenied(id, "timeout 5 make", e.env);
    assert.ok(statSync(path).isDirectory());
  });
});
