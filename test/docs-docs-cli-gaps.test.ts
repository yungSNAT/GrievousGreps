/**
 * Gap tests for src/docs/docs-cli.ts: runDocs end to end with a stand-in
 * gg-docs (count checks, a missing binary, a refused root, the checkout note,
 * a binary that cannot start, exit codes and the --json protocol check), plus
 * the default arguments of docsTarget, findDocsBinary and docsRoot.
 */
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DOCS_PROTOCOL, docsRoot, docsTarget, envelopeProblem, findDocsBinary, runDocs } from "../src/docs/docs-cli.js";

let dir: string;
let pkgRoot: string;
let fake: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "docs-gaps-"));
  pkgRoot = join(dir, "pkg");
  mkdirSync(pkgRoot, { recursive: true });
  fake = join(dir, "fake-gg-docs");
  writeFileSync(
    fake,
    [
      `#!${process.execPath}`,
      "const a = process.argv.slice(2);",
      "const mode = process.env.FAKE_DOCS_MODE;",
      "if (a.includes('--json')) process.stdout.write(mode === 'old' ? '{\"protocol\":0}' : JSON.stringify({ protocol: 1, args: a }));",
      "process.exit(mode === 'fail' ? 3 : 0);",
      "",
    ].join("\n"),
  );
  chmodSync(fake, 0o755);
});

after(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function withCwd<T>(cwd: string, fn: () => T): T {
  const old = process.cwd();
  process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(old);
  }
}

function capture<T>(fn: () => T): { value: T; errors: string[] } {
  const err = mock.method(console, "error", () => {});
  try {
    const value = fn();
    return { value, errors: err.mock.calls.map((c) => c.arguments.map(String).join(" ")) };
  } finally {
    err.mock.restore();
  }
}

function captureStdout<T>(fn: () => T): { value: T; out: string } {
  const chunks: string[] = [];
  const w = mock.method(process.stdout, "write", (chunk: unknown) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  });
  try {
    const value = fn();
    return { value, out: chunks.join("") };
  } finally {
    w.mock.restore();
  }
}

const unixOnly = {
  skip: process.platform === "win32" ? "a shebang script is not runnable on Windows" : /\s/.test(process.execPath) ? "node path has spaces" : false,
};

describe("default arguments", () => {
  test("docsTarget with no arguments describes this machine", () => {
    assert.equal(docsTarget(), docsTarget(process.platform, process.arch));
  });

  test("findDocsBinary reads TRAIL_DOCS_BIN from process.env by default", () => {
    withEnv({ TRAIL_DOCS_BIN: fake }, () => {
      assert.deepEqual(findDocsBinary(pkgRoot), { bin: resolve(fake) });
    });
    withEnv({ TRAIL_DOCS_BIN: join(dir, "absent-bin") }, () => {
      const r = findDocsBinary(pkgRoot);
      assert.ok("error" in r && r.error.includes("TRAIL_DOCS_BIN names no file"));
    });
  });

  test("findDocsBinary without a VERSION offers no prebuilt path", () => {
    const r = findDocsBinary(pkgRoot, {}, "linux", "x64");
    assert.ok("error" in r);
    assert.doesNotMatch(r.error, /Or put a gg-docs/);
    assert.match(r.error, /Or set TRAIL_DOCS_BIN to a gg-docs binary\./);
    assert.ok(r.error.includes(join(pkgRoot, "rust", "gg-docs", "target", "release", "gg-docs")));
  });

  test("docsRoot uses the process cwd by default", () => {
    const loose = join(dir, "loose-default");
    mkdirSync(loose, { recursive: true });
    const r = withCwd(loose, () => docsRoot(undefined));
    assert.ok("root" in r);
    assert.equal(r.root, process.cwd() === loose ? loose : r.root);
    const top = withCwd(resolve("/"), () => docsRoot(undefined));
    assert.ok("error" in top && top.error.includes("drive's root"));
  });

  test("envelopeProblem: null and a number carry no protocol", () => {
    assert.match(envelopeProblem("null") ?? "", /protocol \(none\)/);
    assert.match(envelopeProblem("7") ?? "", /protocol \(none\)/);
    assert.equal(envelopeProblem(JSON.stringify({ protocol: DOCS_PROTOCOL })), undefined);
  });
});

describe("runDocs", () => {
  test("a count that is not a positive whole number stops before any binary is looked for", () => {
    withEnv({ TRAIL_DOCS_BIN: join(dir, "never-looked-at") }, () => {
      const s = capture(() => runDocs({ sub: "search", query: ["x"], limit: "0" }, { pkgRoot, root: dir }));
      assert.equal(s.value, 1);
      assert.deepEqual(s.errors, ['✗ --limit must be a positive whole number, got "0"']);
      const g = capture(() => runDocs({ sub: "get", path: "a.md", from: "abc" }, { pkgRoot, root: dir }));
      assert.equal(g.value, 1);
      assert.deepEqual(g.errors, ['✗ --from must be a positive whole number, got "abc"']);
      const l = capture(() => runDocs({ sub: "get", path: "a.md", from: "2", lines: "1.5" }, { pkgRoot, root: dir }));
      assert.equal(l.value, 1);
      assert.deepEqual(l.errors, ['✗ --lines must be a positive whole number, got "1.5"']);
    });
  });

  test("no binary: the error says where to get one and the code is 1", () => {
    withEnv({ TRAIL_DOCS_BIN: undefined }, () => {
      const r = capture(() => runDocs({ sub: "status" }, { pkgRoot, root: dir }));
      assert.equal(r.value, 1);
      assert.equal(r.errors.length, 1);
      assert.match(r.errors[0], /docs needs the gg-docs binary/);
      assert.match(r.errors[0], /Or set TRAIL_DOCS_BIN/);
    });
  });

  test("a root that is a drive's root is refused before the binary runs", () => {
    withEnv({ TRAIL_DOCS_BIN: process.execPath }, () => {
      const r = withCwd(resolve("/"), () => capture(() => runDocs({ sub: "status" }, { pkgRoot })));
      assert.equal(r.value, 1);
      assert.equal(r.errors.length, 1);
      assert.match(r.errors[0], /home folder or a drive's root/);
      assert.match(r.errors[0], /name the folder with --root/);
    });
  });

  test("below a checkout the note is printed and the binary's exit code is returned", () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "notes"), { recursive: true });
    // node itself as the "binary": it rejects --protocol with exit code 9.
    withEnv({ TRAIL_DOCS_BIN: process.execPath }, () => {
      const r = withCwd(join(repo, "notes"), () => capture(() => runDocs({ sub: "update" }, { pkgRoot })));
      assert.equal(r.value, 9);
      assert.equal(r.errors.length, 1);
      assert.match(r.errors[0], /docs: searching the whole checkout at /);
    });
  });

  test("a binary that cannot be started is reported with code 1", () => {
    const notExe = join(dir, "a-folder-not-a-binary");
    mkdirSync(notExe, { recursive: true });
    withEnv({ TRAIL_DOCS_BIN: notExe }, () => {
      const r = capture(() => runDocs({ sub: "status" }, { pkgRoot, root: dir }));
      assert.equal(r.value, 1);
      assert.ok(r.errors.some((e) => e.startsWith(`✗ could not run ${resolve(notExe)}:`)), r.errors.join("\n"));
    });
  });

  test("text answers: exit 0 passes, a failing exit code is kept", unixOnly, () => {
    withEnv({ TRAIL_DOCS_BIN: fake, FAKE_DOCS_MODE: undefined }, () => {
      const ok = capture(() => runDocs({ sub: "get", path: "a.md", from: "1", lines: "2" }, { pkgRoot, root: dir }));
      assert.equal(ok.value, 0);
      assert.deepEqual(ok.errors, []);
    });
    withEnv({ TRAIL_DOCS_BIN: fake, FAKE_DOCS_MODE: "fail" }, () => {
      const bad = capture(() => runDocs({ sub: "status" }, { pkgRoot, root: dir }));
      assert.equal(bad.value, 3);
    });
  });

  test("--json: a matching protocol is written to stdout as is", unixOnly, () => {
    withEnv({ TRAIL_DOCS_BIN: fake, FAKE_DOCS_MODE: undefined }, () => {
      const r = capture(() => captureStdout(() => runDocs({ sub: "search", query: ["claims"], limit: "2", json: true }, { pkgRoot, root: dir })));
      assert.equal(r.value.value, 0);
      assert.deepEqual(r.errors, []);
      const body = JSON.parse(r.value.out);
      assert.equal(body.protocol, DOCS_PROTOCOL);
      assert.deepEqual(body.args, ["--protocol", "1", "--root", resolve(dir), "search", "-n", "2", "--json", "--", "claims"]);
    });
  });

  test("--json: another protocol is refused and nothing is written", unixOnly, () => {
    withEnv({ TRAIL_DOCS_BIN: fake, FAKE_DOCS_MODE: "old" }, () => {
      const r = capture(() => captureStdout(() => runDocs({ sub: "status", json: true }, { pkgRoot, root: dir })));
      assert.equal(r.value.value, 1);
      assert.equal(r.value.out, "");
      assert.equal(r.errors.length, 1);
      assert.match(r.errors[0], /answered in protocol 0, but .* reads protocol 1/);
    });
  });

  test("--json: a failing binary keeps its code and its stdout is not checked", unixOnly, () => {
    withEnv({ TRAIL_DOCS_BIN: fake, FAKE_DOCS_MODE: "fail" }, () => {
      const r = capture(() => captureStdout(() => runDocs({ sub: "update", json: true }, { pkgRoot, root: dir })));
      assert.equal(r.value.value, 3);
      assert.equal(r.value.out, "");
      assert.deepEqual(r.errors, []);
    });
  });
});
