import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { wordShape, globWallTied } from "../src/trace/walls-glob.js";

const err = (word: string) => `zsh:1: no matches found: ${word}`;

describe("wordShape", () => {
  test("returns null for a word longer than the readable limit", () => {
    assert.equal(wordShape("a".repeat(2049) + "*"), null);
    const ok = wordShape("a".repeat(2047) + "*");
    assert.ok(ok);
    assert.equal(ok!.glob, true);
  });

  test("plain glob word is literal and flagged as glob", () => {
    const s = wordShape("*.ts")!;
    assert.equal(s.glob, true);
    assert.ok(s.re.test("*.ts"));
    assert.ok(!s.re.test("a.ts"));
  });

  test("single-quoted glob characters are not a glob", () => {
    const s = wordShape("'*.ts'")!;
    assert.equal(s.glob, false);
    assert.ok(s.re.test("*.ts"));
    const open = wordShape("'abc")!;
    assert.ok(open.re.test("abc"));
  });

  test("double quotes: escapes, $var, ${...} and backticks", () => {
    const s = wordShape('"a\\"b"*')!;
    assert.equal(s.glob, true);
    assert.ok(s.re.test('a"b*'));
    const e = wordShape('"$x-${y}-`z`"')!;
    assert.equal(e.glob, false);
    assert.ok(e.re.test("one-two-three"));
    assert.ok(!e.re.test("one+two"));
    const open = wordShape('"abc')!;
    assert.ok(open.re.test("abc"));
    const tick = wordShape('"`unterminated')!;
    assert.ok(tick.re.test("anything at all"));
  });

  test("backslash escapes a glob character outside quotes", () => {
    const s = wordShape("a\\*b")!;
    assert.equal(s.glob, false);
    assert.ok(s.re.test("a*b"));
  });

  test("special parameters and named variables read as anything", () => {
    const s = wordShape("$#*")!;
    assert.equal(s.glob, true);
    assert.ok(s.re.test("3*"));
    const v = wordShape("$PAT-x*")!;
    assert.ok(v.re.test("foo-x*"));
    assert.ok(!v.re.test("foo-y*"));
  });

  test("adjacent expansions collapse into a single .*", () => {
    const s = wordShape("$a$b")!;
    assert.equal(s.re.source, "^.*$");
  });

  test("backtick substitutions, terminated or not", () => {
    const s = wordShape("`ls`*")!;
    assert.equal(s.glob, true);
    assert.ok(s.re.test("whatever*"));
    const open = wordShape("x`ls")!;
    assert.ok(open.re.test("xyz"));
    assert.equal(open.glob, false);
  });

  test("$(...) honours backslash-escaped closers and unterminated brackets", () => {
    const s = wordShape("$(echo \\))x*")!;
    assert.equal(s.glob, true);
    assert.ok(s.re.test("zzx*"));
    const open = wordShape("$(foo")!;
    assert.equal(open.glob, false);
    assert.ok(open.re.test("anything"));
    const brace = wordShape("${a")!;
    assert.ok(brace.re.test("q"));
  });

  test("tilde expands only at the start or after = or :", () => {
    const s = wordShape("~/x*")!;
    assert.ok(s.re.test("/home/u/x*"));
    const f = wordShape("--dir=~/x*")!;
    assert.ok(f.re.test("--dir=/h/x*"));
    const lit = wordShape("a~b")!;
    assert.ok(lit.re.test("a~b"));
    assert.ok(!lit.re.test("aZb"));
  });

  test("brace expansion reads as anything, a lone brace is literal", () => {
    const s = wordShape("{a,b}*")!;
    assert.ok(s.re.test("anything*"));
    const r = wordShape("{1..3}x")!;
    assert.ok(r.re.test("2x"));
    const lit = wordShape("{a}")!;
    assert.ok(lit.re.test("{a}"));
    assert.ok(!lit.re.test("a"));
  });

  test("too many expansions give null", () => {
    assert.equal(wordShape("$a-$b-$c-$d-$e-$f-$g*"), null);
    assert.ok(wordShape("$a-$b-$c-$d-$e-$f*"));
  });
});

describe("globWallTied", () => {
  test("false without a zsh no-matches line", () => {
    assert.equal(globWallTied("bash: nothing here", "grep foo* file"), false);
  });

  test("flag value with =", () => {
    assert.equal(globWallTied(err("--include=*.ts"), "grep -r foo --include=*.ts ."), true);
  });

  test("flag value as the next word and per-program pattern flags", () => {
    assert.equal(globWallTied(err("*.ts"), "rsync -a --exclude *.ts src dst"), true);
    assert.equal(globWallTied(err("*.ts"), "find . -name *.ts"), true);
    assert.equal(globWallTied(err("*.go"), "rg -g *.go foo"), true);
  });

  test("a file glob for a file command is not a wall", () => {
    assert.equal(globWallTied(err("*.txt"), "ls *.txt"), false);
    assert.equal(globWallTied(err("*.ts"), "git add *.ts"), false);
  });

  test("single-word commands give nothing", () => {
    assert.equal(globWallTied(err("x*"), "ls"), false);
  });

  test("URL and ?key= query arguments", () => {
    assert.equal(globWallTied(err("https://x.com/a?b=1"), "curl https://x.com/a?b=1"), true);
    assert.equal(globWallTied(err("repos/x?per_page=100"), "gh api repos/x?per_page=100"), true);
  });

  test("git grep/log/diff pathspec after global flags", () => {
    assert.equal(globWallTied(err("src/*.ts"), "git -C repo log -- src/*.ts"), true);
    assert.equal(globWallTied(err("HEAD:src/*.ts"), "git --no-pager diff HEAD:src/*.ts"), true);
  });

  test("grep pattern found after skipping value flags", () => {
    assert.equal(globWallTied(err("2026[34]"), "grep -A 3 2026[34] file"), true);
    assert.equal(globWallTied(err("x*"), "grep -m 1 x* y*"), true);
    assert.equal(globWallTied(err("y*"), "grep -m 1 x* y*"), false);
  });

  test("rg uses its own value flags", () => {
    assert.equal(globWallTied(err("x*"), "rg -t ts x* src"), true);
    // -t takes no value for grep, so 'ts' is the pattern there
    assert.equal(globWallTied(err("x*"), "grep -t ts x*"), false);
  });

  test("explicit -e, -e<pat>, --regexp= and -f patterns", () => {
    assert.equal(globWallTied(err("foo.*"), "grep -e foo.* bar"), true);
    assert.equal(globWallTied(err("-efoo.*"), "grep -efoo.* bar"), true);
    assert.equal(globWallTied(err("--regexp=a*"), "grep --regexp=a* bar"), true);
    assert.equal(globWallTied(err("x*"), "grep -f pats.txt x*"), false);
    assert.equal(globWallTied(err("x*"), "grep --file=pats.txt x*"), false);
  });

  test("-- ends flags so a dash word is the pattern", () => {
    assert.equal(globWallTied(err("-x*"), "grep -- -x* file"), true);
  });

  test("wrappers are stripped, including xargs flags", () => {
    assert.equal(globWallTied(err("foo*"), "noglob grep foo* file"), true);
    assert.equal(globWallTied(err("foo*"), "xargs -0 grep foo*"), true);
  });

  test("expansions in the command word match any text", () => {
    assert.equal(globWallTied(err("foo*"), "grep $PAT* file"), true);
  });

  test("other zsh error line prefixes", () => {
    assert.equal(globWallTied("/bin/zsh:2: no matches found: foo*", "grep foo* f"), true);
    assert.equal(globWallTied("(eval):1: no matches found: foo*", "grep foo* f"), true);
    assert.equal(globWallTied("zsh: no matches found: foo*", "grep foo* f"), true);
  });

  test("words too long to read are not candidates", () => {
    const long = "a".repeat(2100) + "*";
    assert.equal(globWallTied(err(long), `grep ${long} file`), false);
  });

  test("candidate collection stops at 32 words in one command", () => {
    const cmd = "grep " + Array.from({ length: 40 }, (_, i) => `-e p${i}*`).join(" ");
    assert.equal(globWallTied(err("p0*"), cmd), true);
    assert.equal(globWallTied(err("p39*"), cmd), false);
  });

  test("candidate collection stops at 32 words across commands", () => {
    const cmd = Array.from({ length: 40 }, (_, i) => `grep q${i}* f`).join("; ");
    assert.equal(globWallTied(err("q0*"), cmd), true);
    assert.equal(globWallTied(err("q38*"), cmd), false);
  });
});
