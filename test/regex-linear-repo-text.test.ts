/**
 * Patterns that read a repository's files, session text or a command's output run in linear time at the
 * sizes they are given: a Rust file, a git config, a Makefile, a CI or compose file, a session's text or the
 * output a check reads (its first 1,500 and last 2,500 characters), built to make them backtrack, costs
 * milliseconds. Before the rewrite each took seconds to minutes; the limit leaves room for a slow runner.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { cloneShape } from "./anchors-clone-fixture.js";
import { extractGeneric, warmGenericGrammars } from "../src/graph/generic.js";
import { buildGraph } from "../src/graph/build.js";
import { classifyCheck, type RunFacts } from "../src/trace/checks.js";
import { noEmails, scrub } from "../src/init/look-back.js";
import { branchGone, gitOf } from "../src/skills/anchors-git.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { composeServices, wideGone } from "../src/skills/anchors-wide.js";
import { goneAnchors } from "../src/skills/anchors.js";
import { diffAuthors } from "../src/blast/owners.js";
import type { ParsedSkill } from "../src/skills/types.js";

const LIMIT_MS = 3000;
const N = 100_000;

function quick<T>(what: string, run: () => T): T {
  const start = performance.now();
  const out = run();
  const ms = performance.now() - start;
  assert.ok(ms < LIMIT_MS, `${what} took ${ms.toFixed(0)} ms`);
  return out;
}

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
function dir(tag: string, files: Record<string, string>): string {
  const d = tmpRepo(`linear-${tag}`);
  made.push(d);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(d, path, ".."), { recursive: true });
    writeFileSync(join(d, path), text);
  }
  return d;
}

function skill(cmds: string[]): ParsedSkill {
  return {
    name: "x", description: "", meta: { trail: "s-000001", scope: "personal", asks: "", version: "1" },
    steps: cmds.map((cmd, i) => ({ n: i + 1, cmd, gated: null, bg: false, wait: false })),
    check: null, checkShows: null, ifFails: [], dontUse: "", params: [], hash: "sha256:x",
  };
}

const OK = { failed: false, isError: false };
const NONE: RunFacts = { versions: [], shas: [], pushedBranches: [] };

test("a deploy check's output full of spaces after a state word is read in linear time", () => {
  const cmd = "gh api repos/acme/webshop/commits/$(git rev-parse HEAD)/statuses --jq '.[0].state'";
  const text = `status${" ".repeat(3000)}!\nsuccess\n`;
  assert.equal(quick("deploy state", () => classifyCheck(cmd, text, OK, NONE, "ship"))?.passed, true);
  assert.equal(classifyCheck(cmd, "  state: ● failure\n", OK, NONE, "ship")?.passed, false, "an indented state line is still read");
});

test("git push output full of blank lines is read in linear time", () => {
  const text = `To github.com:acme/shop.git\n${"\n".repeat(2400)}x\n   1f2e3d4..9c8b7a6  beta -> beta\n`;
  const hit = quick("push", () => classifyCheck("git push origin beta", text, OK, NONE, "ship"));
  assert.deepEqual(hit?.facts, { sha: "9c8b7a6", branch: "beta", remote: "origin" }, "the line after the blank ones is still read");
});

test("session text with a long run of address characters and no @ is scrubbed in linear time", () => {
  const run = "a.".repeat(N);
  quick("noEmails", () => noEmails(run));
  quick("scrub", () => scrub(run));
  assert.equal(noEmails("mail jo.smith+x@example.com now"), "mail [email] now");
  assert.equal(scrub("from jo@example.co.uk"), "from [email]");
});

test("Rust use declarations with a long name or a long run of spaces are read in linear time", async () => {
  await warmGenericGrammars(["rust"]);
  quick("long name", () => extractGeneric("lib.rs", `pub use ${"a".repeat(N)};\nuse b::c as d;\n`, "rust"));
  quick("long gap", () => extractGeneric("lib.rs", `pub use a${" ".repeat(N)}::b;\n`, "rust"));
});

test("a Rust call through many generic arguments, and a receiver of many dots, are read in linear time", async () => {
  await warmGenericGrammars(["rust"]);
  quick("generic path", () => extractGeneric("lib.rs", `fn t() { let x = Foo::<${"A<B>, ".repeat(N / 6)}>::Bar::new(); x.go(); }\n`, "rust"));
  quick("dotted receiver", () => extractGeneric("lib.rs", `fn t() { ("${".".repeat(N)}").0.len(); }\n`, "rust"));
});

test("a Rust item whose first line holds a long gap is read in linear time", async () => {
  await warmGenericGrammars(["rust"]);
  const { nodes } = quick("signature", () => extractGeneric("lib.rs", `fn s() /*${" ".repeat(3000)}*/ {}\nfn t() {}\n`, "rust"));
  assert.ok(nodes.some((n) => n.label === "t" || n.id.endsWith("#t")), "the next item is still read");
});

const CARGO = '[package]\nname = "m"\nversion = "0.1.0"\nedition = "2021"\n';

test("a Rust return type that wraps a long gap is resolved in linear time", async () => {
  const build = (gap: string, list: string) => buildGraph(dir("box", {
    "Cargo.toml": CARGO,
    "src/lib.rs": `pub struct T;\nimpl T { pub fn m(&self) {} }\npub fn f() -> Box<${gap}T>::Out { todo!() }\npub fn o() -> Option<${gap}T>::Out { todo!() }\npub fn h() -> Box<A<${list}>> { todo!() }\npub fn g() { f().m(); o().unwrap().m(); h().m(); }\n`,
  }));
  const start = performance.now();
  const built = await build(" ".repeat(N), "B, ".repeat(N / 3));
  const ms = performance.now() - start;
  assert.ok(ms < LIMIT_MS * 3, `buildGraph took ${ms.toFixed(0)} ms`);
  assert.deepEqual(calls(built.contextDir, "g"), calls((await build(" ", "B, ")).contextDir, "g"), "the calls the same file without the padding has");
});

/** Each call edge from `fn` to a method, as `Type.method`. */
function calls(contextDir: string, fn: string): string[] {
  const graph = readGraph(wiringPath(contextDir))!;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return graph.edges
    .filter((e) => e.relation === "calls" && e.source.endsWith(`#${fn}`))
    .map((e) => byId.get(e.target))
    .map((n) => (n?.owner ? `${n.owner}.${n.name}` : (n?.name ?? "?")))
    .sort();
}

test("a git config whose remote URL holds a long gap is read in linear time", () => {
  const d = dir("gitcfg", { ".git/config": `[remote "origin"]\n\turl = a${" ".repeat(N)}b \n`, ".git/HEAD": "ref: refs/heads/main\n" });
  const git = quick("gitOf", () => gitOf(d));
  assert.equal(git?.remotes.get("origin"), `a${" ".repeat(N)}b`);
});

/** A checkout with a git shape, `make` on its PATH and its own Trail home. */
function checkout(tag: string, files: Record<string, string>): { d: string; env: NodeJS.ProcessEnv } {
  const d = dir(tag, { ...files, "bin/make": "#!/bin/sh\n" });
  chmodSync(join(d, "bin", "make"), 0o755);
  cloneShape(d);
  return { d, env: { HOME: join(d, "home"), PATH: join(d, "bin"), TRAIL_HOME: join(d, "trail") } };
}
const wide = (c: { d: string; env: NodeJS.ProcessEnv }, cmds: string[]) =>
  wideGone(skill(cmds), c.d, c.env, { scan: true, deadline: Date.now() + 10_000 }).map((a) => `${a.kind}:${a.name}`);

test("a remote URL holding a long run of slashes is matched to a step's URL in linear time", () => {
  const anchor = { kind: "branch" as const, name: "main", step: 1, remote: "https://github.com/acme/shop.git" };
  const judge = (url: string) => {
    const d = dir("urlkey", { ".git/config": `[remote "origin"]\n\turl = ${url}\n`, ".git/HEAD": "ref: refs/heads/main\n", ".git/refs/remotes/origin/main": `${"4e1c9a2f".padEnd(40, "0")}\n` });
    return branchGone(gitOf(d)!, anchor);
  };
  assert.equal(quick("urlKey", () => judge(`https://github.com/acme/shop${"/".repeat(N)}x`)), null, "another repo's URL names no remote");
  assert.deepEqual(judge("https://github.com/acme/shop.git///"), { gone: false, remote: "origin" }, "trailing slashes still go");
});

test("a Rust trait bound holding a long run of '<' before a line break is read in linear time", async () => {
  await warmGenericGrammars(["rust"]);
  const bounds = (header: string) =>
    extractGeneric("lib.rs", `pub trait Go { fn go(&self); }\nfn f<${header}>(t: T) { T::go(&t); }\n`, "rust").rawEdges.find((e) => e.name === "go")?.rustBounds;
  quick("bound", () => bounds(`T: Go /*${"<".repeat(N)}\n*/`));
  assert.deepEqual(bounds("T: a::Go<u8>"), ["Go"], "a bound's path and arguments go");
});

test("a Makefile line holding a long gap before no colon is read in linear time", () => {
  const c = checkout("make", { "Makefile": `a${" ".repeat(N)}=\ntest:\n\tgo test ./...\n` });
  const gone = quick("make", () => goneAnchors(skill(["make release"]), c.d, c.env));
  assert.deepEqual(gone.map((a) => `${a.kind}:${a.name}`), ["make:release"], "the targets after it are still read");
});

test("a co-author trailer of many '<' is read in linear time", () => {
  const d = dir("owners", { "a.txt": "a\n" });
  const git = (...args: string[]) => execFileSync("git", ["-C", d, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  writeFileSync(join(d, "a.txt"), "b\n");
  const trailer = `a${"<".repeat(N)}>x>`;
  // A name holding a CR, U+2028 or U+2029 was never read as `Name <email>`, and is kept whole too.
  const broken = [0x0d, 0x2028, 0x2029].map((c) => `Name${String.fromCharCode(c)}x <mail${c}@example.com>`);
  git("commit", "-q", "-am", `change\n\nCo-authored-by: ${trailer}\n${broken.map((b) => `Co-authored-by: ${b}\n`).join("")}Co-authored-by: Jo Bloggs <jo@example.com>`);
  const names = quick("diffAuthors", () => diffAuthors(d, "HEAD~1"));
  assert.deepEqual(names, ["T", "t@example.com", trailer, ...broken, "Jo Bloggs", "jo@example.com"]);
});

// CI files and a compose project's .env are read up to 64 KiB, so their padding stays under that. Each judgement is
// the one the same files without the padding get.
const CI_N = 60_000;

test("a compose file full of blank lines is read in linear time", () => {
  assert.deepEqual(quick("compose keys", () => composeServices(`services:\n${"\n".repeat(N)}  web:\n    image: x\n`)), composeServices("services:\n  web:\n    image: x\n"));
});

test("a CI file whose name line holds a long gap is read in linear time", () => {
  const ci = (gap: string) => wide(checkout("ci", { ".github/workflows/ci.yml": `name: CI${gap}x # note\non: push\n` }), ["gh workflow run Deploy"]);
  assert.deepEqual(quick("ci name", () => ci(" ".repeat(CI_N))), ci(" "));
});

test("a compose project's .env full of blank lines is read in linear time", () => {
  const svc = (gap: string) =>
    wide(checkout("svc", { "compose.yaml": "services:\n  web:\n    image: x\n", ".env": `${gap}x\n` }), ["docker compose up worker"]);
  assert.deepEqual(quick("compose env", () => svc("\n".repeat(CI_N))), svc("\n"));
});
