/**
 * The patterns that backtracked for a long time on long input (Sonar S8786)
 * are scans now. Each case here is what the old pattern gave, recorded before
 * the change, so nothing redacted or hidden before goes through now; the long
 * inputs took seconds before and must take milliseconds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText } from "../src/trace/redact.js";
import { anonymize, redactEnvValues } from "../src/cloud/share-session.js";
import { slug } from "../src/cloud/share-bundle.js";
import { exportCandidates, exportFacts } from "../src/notes/claude-export.js";

// Built in pieces so no scanner reads a real-looking key in this file.
const GH = "ghp_" + "Zx81Qw72Er63Ty54Ui45Op36As27Df18";
const PASS = "S3cr3t" + "Passw0rdXyZ";
const SK = "sk-" + "live-" + "1234567890abcdefghijklmnop";
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/" + "bPxRfiCYEXAMPLEKEY==";
const JWT = "eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NSJ9" + ".abcdefghijklmnop";
const R = "[redacted]";

/** Under this many milliseconds: the old patterns took 0.5 to 5 seconds on these inputs on a Linux test box. */
const QUICK = 1000;
function quick(what: string, run: () => unknown): void {
  const start = performance.now();
  run();
  const took = performance.now() - start;
  assert.ok(took < QUICK, `${what} took ${Math.round(took)} ms`);
}

test("redactText: a link's password and a name's value go as before", () => {
  const cases: Array<[string, string]> = [
    [`DATABASE_URL=postgres://admin:${PASS}@db.example.com:5432/app`, `DATABASE_URL=postgres://admin:${R}@db.example.com:5432/app`],
    [`see https://bob:${PASS}hunter2@git.example.com/repo.git now`, `see https://bob:${R}@git.example.com/repo.git now`],
    [`clone 1+git+ssh://u:${PASS}-123@host/x`, `clone 1+git+ssh://u:${R}@host/x`],
    [`x://y/https://alice:${PASS}@h.example/p`, `x://y/https://alice:${R}@h.example/p`],
    ["postgres://admin:@db.example.com and s3://bucket/key", "postgres://admin:@db.example.com and s3://bucket/key"],
    [`API_KEY=${SK}`, `API_KEY=${R}`],
    [`token: ${GH}`, `token: ${R}`],
    [`AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`, `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`],
    ["secret====", "secret===="],
    [`PASSWORD=:${PASS}:`, `PASSWORD=:${R}`],
    ["key=", "key="],
    [`=${SK}`, R],
    [`a:b:c:${GH}`, `a:${R}`],
    [`url?token=${SK}&x=1`, `url?token=${R}&x=1`],
    [`Authorization: Bearer ${JWT}`, `Authorization: Bearer ${R}`],
  ];
  for (const [text, want] of cases) assert.equal(redactText(text).text, want, text);
});

test("anonymize: emails are hidden where the email pattern found them", () => {
  const cases: Array<[string, string]> = [
    ["mail maya@acme.test or Maya.Raman+x@sub.acme.co.uk today", "mail [email] or [email] today"],
    ["x.y@a.b.cc.d", "[email].d"],
    ["a@b@c.de", "a@[email]"],
    ["a@b.cc@d.ee", "[email]@d.ee"],
    ["a@b.ccx+y@d.ee", "[email][email]"],
    ["a@.b.cc", "[email]"],
    ["a@b.cc9", "[email]9"],
    ["a@-b.c.dd", "[email]"],
    ["weird a@b..cc end", "weird [email] end"],
    ["no at sign here", "no at sign here"],
    ["@acme.test", "@acme.test"],
    ["u@host", "u@host"],
    ["u@host.c", "u@host.c"],
    ["u@host.co", "[email]"],
    ["1@2.34", "1@2.34"],
    ["u@h.ab.c", "[email].c"],
    ["u@h.abc.d1", "[email].d1"],
  ];
  for (const [text, want] of cases) assert.equal(anonymize(text, []).text, want, text);
  assert.equal(anonymize("a@b.cc and c@d.ee", []).n, 2);
});

test("redactEnvValues: each value goes, wherever the line's lead or `=` puts it", () => {
  const cases: Array<[string, string, string[]]> = [
    ["FOO=bar", `FOO=${R}`, ["FOO=bar"]],
    ["export FOO=bar", `export FOO=${R}`, ["FOO=bar"]],
    ["  12→ export API_KEY = sk-123", `  12→ export API_KEY = ${R}`, ["API_KEY=sk-123"]],
    ["3\tTOKEN=abc", `3\tTOKEN=${R}`, ["TOKEN=abc"]],
    ["\n\n  FOO=bar\nBAR=baz", `\n\n  FOO=${R}\nBAR=${R}`, ["FOO=bar", "BAR=baz"]],
    ["FOO=\nbar", `FOO=\n${R}`, ["FOO=bar"]],
    ["export\nFOO=bar", `export\nFOO=${R}`, ["FOO=bar"]],
    [`FOO=${R} x`, `FOO=${R} x`, []],
    ["x FOO=bar", "x FOO=bar", []],
    ["FOO = bar # comment", `FOO = ${R}`, ["FOO=bar # comment"]],
    ["\u00a0FOO=bar", `\u00a0FOO=${R}`, ["FOO=bar"]],
    ["A=1\r\nB=2\r\n", `A=${R}\r\nB=${R}\r\n`, ["A=1", "B=2"]],
  ];
  for (const [text, want, wantTaken] of cases) {
    const taken: string[] = [];
    assert.equal(redactEnvValues(text, (what) => taken.push(what)), want, JSON.stringify(text));
    assert.deepEqual(taken, wantTaken, JSON.stringify(text));
  }
});

test("slug: dashes at either end go, and an empty name is home", () => {
  const cases: Array<[string, string]> = [
    ["~/Documents/assign", "Documents-assign"],
    ["~\\work\\a b", "work-a-b"],
    ["~", "home"],
    ["---x---", "x"],
    ["~/--a--b--", "a--b"],
    ["", "home"],
    ["a/b/c", "a-b-c"],
    ["~/ü-ñ/z", "z"],
    ["!!!", "home"],
    ["~/-", "home"],
  ];
  for (const [label, want] of cases) assert.equal(slug(label), want, label);
});

test("exportFacts: each heading form names its section; exportCandidates: a long fact's title ends at a whole word", () => {
  const heads = ["# Work", "Top of mind:", "**Work context**", "**Projects:**", "*Recent months*", "_Personal_", "##   Spaced heading  ", "**Odd:**:", "Q&A, notes/ideas - list:"];
  const text = heads.map((h, i) => `${h}\n- Item ${i} about the codebase.`).join("\n") + "\n•   An item with spaces before it.\n12) A numbered one.";
  assert.deepEqual(
    exportFacts(text).map((f) => [f.section, f.text]),
    [
      ["Work", "Item 0 about the codebase."],
      ["Top of mind", "Item 1 about the codebase."],
      ["Work context", "Item 2 about the codebase."],
      ["Projects", "Item 3 about the codebase."],
      ["Recent months", "Item 4 about the codebase."],
      ["Personal", "Item 5 about the codebase."],
      ["Spaced heading", "Item 6 about the codebase."],
      ["Odd", "Item 7 about the codebase."],
      ["Q&A, notes/ideas - list", "Item 8 about the codebase."],
      ["Q&A, notes/ideas - list", "An item with spaces before it."],
      ["Q&A, notes/ideas - list", "A numbered one."],
    ],
  );
  const titles = (fact: string) => exportCandidates("/r", `- ${fact}`).candidates.map((c) => c.title);
  assert.deepEqual(titles("Works on the TypeScript codebase every day and reviews pull requests in the morning before standup meetings begin."), [
    "Works on the TypeScript codebase every day and reviews pull requests in the morning…",
  ]);
  assert.deepEqual(titles("Deploys the backend with Docker and Kubernetes to EKS, and debugs CI failures in GitHub Actions with   many   spaces here."), [
    "Deploys the backend with Docker and Kubernetes to EKS, and debugs CI failures in GitHub…",
  ]);
});

const long: Array<[string, () => unknown]> = [
  ["a long word after a key, with no link in it", () => redactText(`${GH}${"a".repeat(50_000)}`)],
  ["a long word with no `@`", () => anonymize("a".repeat(50_000), [])],
  ["an email host of many dots", () => anonymize(`a@${"b.".repeat(25_000)}`, [])],
  ["a run of blank lines in a .env read", () => redactEnvValues(`${"\n".repeat(5_000)}x`, () => {})],
  ["a run of spaces in a .env read", () => redactEnvValues(`${" ".repeat(50_000)}x`, () => {})],
];
for (const [what, run] of long) test(`long input stays quick: ${what}`, () => quick(what, run));
