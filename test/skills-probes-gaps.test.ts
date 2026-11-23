import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { probePassWords, readyProbes, runProbes, PROBE_BUDGET_MS, type ProbeGit } from "../src/skills/probes.js";

const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function scratch(tag: string) {
  const home = tmpRepo(`probes-gaps-${tag}`);
  made.push(home);
  const checkout = join(home, "repo");
  mkdirSync(checkout, { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TRAIL_HOME: join(home, "trail-home") };
  if (process.env.PATHEXT) env.PATHEXT = process.env.PATHEXT;
  return { home, checkout, env };
}

const skill = (ready: string) => ({ meta: { ready } }) as any;
const NOW = new Date("2026-10-20T10:00:00.000Z");

/** A stub git recording its calls, answering with a fixed result. */
function stubGit(answer: { code: number | null; out: string; timedOut: boolean }) {
  const calls: string[][] = [];
  const fn: ProbeGit = (args, _cwd, ms) => {
    calls.push(args);
    assert.ok(ms > 0 && ms <= 150, "each git call gets at most 150 ms");
    return answer;
  };
  return { fn, calls };
}

describe("probePassWords and readyProbes", () => {
  test("each allowlisted form reads in words; anything else is null", () => {
    assert.equal(PROBE_BUDGET_MS, 300);
    assert.equal(probePassWords("command -v docker"), "docker installed");
    assert.equal(probePassWords("test -f package.json"), "package.json there");
    assert.equal(probePassWords("[ -S /var/run/docker.sock ]"), "/var/run/docker.sock there");
    assert.equal(probePassWords("  git   status  --porcelain "), "no uncommitted changes");
    assert.equal(probePassWords("git rev-parse --verify origin/beta"), "origin/beta exists");
    assert.equal(probePassWords("git rev-parse --abbrev-ref HEAD = beta"), "on beta");
    assert.equal(probePassWords("command -v a;rm"), null);
    assert.equal(probePassWords("test -f ../secret"), null);
    assert.equal(probePassWords("git rev-parse --verify -bad"), null);
    assert.equal(probePassWords("git rev-parse --abbrev-ref HEAD = a^b"), null);
    assert.equal(probePassWords("curl https://example.com"), null);
  });

  test("readyProbes splits on ' ; ', trims, drops empties and keeps at most six", () => {
    assert.deepEqual(readyProbes({ meta: {} } as any), []);
    assert.deepEqual(readyProbes(skill(" command -v git ;  ; test -d src ")), ["command -v git", "test -d src"]);
    const many = Array.from({ length: 9 }, (_, i) => `command -v p${i}`).join(" ; ");
    assert.equal(readyProbes(skill(many)).length, 6);
  });
});

describe("runProbes with a stubbed git", () => {
  test("a skill with no allowlisted probe runs nothing", () => {
    const b = scratch("none");
    const g = stubGit({ code: 0, out: "", timedOut: false });
    assert.deepEqual(runProbes(skill("rm -rf / ; curl x"), b.checkout, NOW, b.env, { git: g.fn }), []);
    assert.equal(g.calls.length, 0);
  });

  test("verify: exit 0 passes, exit 1 says the ref isn't here, any other exit is left out", () => {
    const b = scratch("verify");
    const ok = stubGit({ code: 0, out: "abc\n", timedOut: false });
    assert.deepEqual(runProbes(skill("git rev-parse --verify origin/beta"), b.checkout, NOW, b.env, { git: ok.fn }),
      [{ probe: "git rev-parse --verify origin/beta", ok: true }]);
    assert.deepEqual(ok.calls[0], ["rev-parse", "--verify", "--quiet", "origin/beta"]);

    const c = scratch("verify-missing");
    const missing = stubGit({ code: 1, out: "", timedOut: false });
    assert.deepEqual(runProbes(skill("git rev-parse --verify v9.9"), c.checkout, NOW, c.env, { git: missing.fn }),
      [{ probe: "git rev-parse --verify v9.9", ok: false, why: "v9.9 isn't here", fix: "Fetch it first, or ask the person." }]);

    const d = scratch("verify-broken");
    const broken = stubGit({ code: 128, out: "", timedOut: false });
    assert.deepEqual(runProbes(skill("git rev-parse --verify v9.9"), d.checkout, NOW, d.env, { git: broken.fn }), []);
    assert.equal(broken.calls.length, 1);
  });

  test("branch: the right branch passes, another or a detached HEAD fails, a git error is left out", () => {
    const probe = "git rev-parse --abbrev-ref HEAD = beta";
    const a = scratch("branch-ok");
    const on = stubGit({ code: 0, out: "beta\n", timedOut: false });
    assert.deepEqual(runProbes(skill(probe), a.checkout, NOW, a.env, { git: on.fn }), [{ probe, ok: true }]);
    assert.deepEqual(on.calls[0], ["rev-parse", "--abbrev-ref", "HEAD"]);

    const b = scratch("branch-other");
    const other = stubGit({ code: 0, out: "fix/x\n", timedOut: false });
    assert.deepEqual(runProbes(skill(probe), b.checkout, NOW, b.env, { git: other.fn }),
      [{ probe, ok: false, why: "This checkout is on fix/x, not beta", fix: "Ask the person before switching." }]);

    const c = scratch("branch-detached");
    const detached = stubGit({ code: 0, out: "HEAD\n", timedOut: false });
    assert.equal(runProbes(skill(probe), c.checkout, NOW, c.env, { git: detached.fn })[0]?.why,
      "This checkout is on a detached commit, not beta");

    const d = scratch("branch-err");
    const err = stubGit({ code: 128, out: "", timedOut: false });
    assert.deepEqual(runProbes(skill(probe), d.checkout, NOW, d.env, { git: err.fn }), []);
  });

  test("clean: empty output passes, a failing git or a timeout is left out", () => {
    const probe = "git status --porcelain";
    const a = scratch("clean-ok");
    const empty = stubGit({ code: 0, out: "", timedOut: false });
    assert.deepEqual(runProbes(skill(probe), a.checkout, NOW, a.env, { git: empty.fn }), [{ probe, ok: true }]);
    assert.deepEqual(empty.calls[0], ["status", "--porcelain"]);

    const b = scratch("clean-fail");
    const fail = stubGit({ code: 128, out: "", timedOut: false });
    assert.deepEqual(runProbes(skill(probe), b.checkout, NOW, b.env, { git: fail.fn }), []);

    const c = scratch("clean-slow");
    const slow = stubGit({ code: null, out: "", timedOut: true });
    assert.deepEqual(runProbes(skill(probe), c.checkout, NOW, c.env, { git: slow.fn }), []);
    assert.equal(slow.calls.length, 1);
  });

  test("git probes without a checkout, or with no budget, are left out and git never runs", () => {
    const b = scratch("nocheckout");
    const g = stubGit({ code: 0, out: "", timedOut: false });
    assert.deepEqual(runProbes(skill("git status --porcelain ; test -f relative.txt"), "", NOW, b.env, { git: g.fn }), []);
    assert.equal(g.calls.length, 0);

    const c = scratch("nobudget");
    writeFileSync(join(c.checkout, "here.txt"), "x");
    assert.deepEqual(runProbes(skill("git status --porcelain ; test -f here.txt"), c.checkout, NOW, c.env, { git: g.fn, budgetMs: 0 }), []);
    assert.equal(g.calls.length, 0);
  });

  test("results are cached 10 minutes per checkout and probe", () => {
    const b = scratch("cache");
    const probe = "git rev-parse --verify v1";
    const missing = stubGit({ code: 1, out: "", timedOut: false });
    const first = runProbes(skill(probe), b.checkout, NOW, b.env, { git: missing.fn });
    assert.equal(first[0]?.ok, false);

    const ok = stubGit({ code: 0, out: "", timedOut: false });
    const again = runProbes(skill(probe), b.checkout, new Date(NOW.getTime() + 5 * 60_000), b.env, { git: ok.fn });
    assert.deepEqual(again, first, "within 10 minutes the cached answer comes back, why and fix included");
    assert.equal(ok.calls.length, 0);

    const later = runProbes(skill(probe), b.checkout, new Date(NOW.getTime() + 11 * 60_000), b.env, { git: ok.fn });
    assert.deepEqual(later, [{ probe, ok: true }]);
    assert.equal(ok.calls.length, 1);

    const other = scratch("cache-other");
    const third = stubGit({ code: 1, out: "", timedOut: false });
    runProbes(skill(probe), other.checkout, new Date(NOW.getTime() + 11 * 60_000), b.env, { git: third.fn });
    assert.equal(third.calls.length, 1, "another checkout is keyed apart");
  });
});

describe("runProbes stat and PATH probes", () => {
  test("test -f / -d / -e check the kind of thing relative to the checkout", () => {
    const b = scratch("stat");
    writeFileSync(join(b.checkout, "package.json"), "{}");
    mkdirSync(join(b.checkout, "src"));
    const r = runProbes(skill("test -f package.json ; test -d src ; test -f src ; test -e nope.txt"), b.checkout, NOW, b.env);
    assert.deepEqual(r, [
      { probe: "test -f package.json", ok: true },
      { probe: "test -d src", ok: true },
      { probe: "test -f src", ok: false, why: "src isn't there", fix: "Tell the person before going on." },
      { probe: "test -e nope.txt", ok: false, why: "nope.txt isn't there", fix: "Tell the person before going on." },
    ]);
  });

  test("$HOME and ~ expand from env.HOME", () => {
    const b = scratch("home");
    mkdirSync(join(b.home, ".config"), { recursive: true });
    writeFileSync(join(b.home, ".config", "tool.json"), "{}");
    const r = runProbes(skill("test -f $HOME/.config/tool.json ; test -d ~/.config ; test -f ${HOME}/missing"), b.checkout, NOW, b.env);
    assert.deepEqual(r.map((x) => x.ok), [true, true, false]);
  });

  test("a missing socket names what to start", () => {
    const b = scratch("sock");
    const r = runProbes(skill("[ -S ~/.colima/default/docker.sock ] ; test -S $HOME/docker/run.sock ; test -S ~/app.sock ; test -S ~"), b.checkout, NOW, b.env);
    assert.deepEqual(r[0], { probe: "[ -S ~/.colima/default/docker.sock ]", ok: false, why: "Colima's socket isn't there", fix: "Start it first: colima start" });
    assert.deepEqual(r[1], { probe: "test -S $HOME/docker/run.sock", ok: false, why: "Docker's socket isn't there", fix: "Start Docker first, or ask the person." });
    assert.deepEqual(r[2], { probe: "test -S ~/app.sock", ok: false, why: "~/app.sock isn't there", fix: "Start what it belongs to first, or ask the person." });
    assert.equal(r.length, 3, "`test -S ~` has no slash after ~, so it's not an allowlisted path... or it is and fails");
  });

  test("command -v finds a program on PATH and reports one that isn't", () => {
    const b = scratch("which");
    const empty = join(b.home, "emptybin");
    mkdirSync(empty);
    const env = { ...b.env, PATH: [dirname(process.execPath), empty].join(process.platform === "win32" ? ";" : ":") };
    const r = runProbes(skill("command -v node ; command -v no-such-tool-xyz"), b.checkout, NOW, env);
    assert.deepEqual(r, [
      { probe: "command -v node", ok: true },
      { probe: "command -v no-such-tool-xyz", ok: false, why: "no-such-tool-xyz isn't installed here", fix: "Tell the person; don't install it for them." },
    ]);
  });
});
