/**
 * Gap tests for src/trace/walls.ts: each wall's fix text (Colima or not, SSH
 * remote forms, gh), the SSH remote check, the 4 KB windows and colour codes,
 * planted text shown by printers, and the "what fixed this before" line.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { matchWall, wallFixText, sshRemoteFor, lastTimeText, WALL_COPY, WALLS } from "../src/trace/walls.js";
import type { WallClass } from "../src/trace/types.js";

const none = { hasProgram: () => false, remoteSsh: null };

describe("wallFixText", () => {
  test("docker-rootless with colima on PATH gives the Colima fix and the env line", () => {
    const txt = wallFixText("docker-rootless", { hasProgram: (p) => p === "colima", remoteSsh: null });
    assert.ok(txt.startsWith(WALL_COPY.lead!), txt);
    assert.match(txt, /runs in Colima/);
    assert.match(txt, /colima start/);
    assert.match(txt, /DOCKER_HOST=unix:\/\/\$HOME\/\.colima\/default\/docker\.sock/);
    assert.match(txt, /TESTCONTAINERS_RYUK_DISABLED=true/);
  });

  test("docker-rootless without colima says no daemon is running", () => {
    const txt = wallFixText("docker-rootless", none);
    assert.match(txt, /No Docker daemon is running here/);
    assert.doesNotMatch(txt, /DOCKER_HOST/);
  });

  test("npm-e401-eotp fix names npm login", () => {
    const txt = wallFixText("npm-e401-eotp", none);
    assert.ok(txt.startsWith(WALL_COPY.lead!));
    assert.match(txt, /from npm: npm asking for a login or one-time password\./);
    assert.match(txt, /npm login/);
  });

  test("claude-not-logged-in fix and words", () => {
    const entry = WALLS.find((w) => w.cls === "claude-not-logged-in")!;
    assert.equal(entry.words, "claude not signed in");
    const txt = wallFixText("claude-not-logged-in", none);
    assert.match(txt, /from the claude CLI: claude not signed in\./);
    assert.match(txt, /signing in there/);
  });

  test("enospc and zsh-no-match and timeout-missing fixes", () => {
    assert.match(wallFixText("enospc", none), /df -h \./);
    assert.match(wallFixText("zsh-no-match", none), /noglob/);
    assert.match(wallFixText("timeout-missing", none), /no timeout program/);
  });

  test("git-https-auth with a good SSH remote names it in the push", () => {
    const txt = wallFixText("git-https-auth", { hasProgram: () => false, remoteSsh: "git@github.com:acme/shop.git" });
    assert.match(txt, /The usual fix is git push git@github\.com:acme\/shop\.git HEAD,/);
    assert.doesNotMatch(txt, /gh auth setup-git/);
  });

  test("git-https-auth with gh on PATH adds gh auth setup-git", () => {
    const txt = wallFixText("git-https-auth", { hasProgram: (p) => p === "gh", remoteSsh: null });
    assert.match(txt, /gh auth setup-git/);
    assert.match(txt, /git@host:owner\/repo\.git/);
  });

  test("git-https-auth rejects unsafe or malformed SSH remotes", () => {
    const generic = wallFixText("git-https-auth", none);
    assert.match(generic, /push to the remote's SSH address \(git@host:owner\/repo\.git\)/);
    for (const bad of [
      "git@-oProxyCommand:x/y.git",
      "git@github.com:acme/../x.git",
      "git@github.com:-upload-pack/x.git",
      "https://github.com/acme/shop.git",
      "git@github.com:acme/shop",
    ]) {
      const txt = wallFixText("git-https-auth", { hasProgram: () => false, remoteSsh: bad });
      assert.equal(txt, generic, bad);
      assert.ok(!txt.includes(bad), bad);
    }
    const nonString = wallFixText("git-https-auth", { hasProgram: () => false, remoteSsh: 42 as unknown as string });
    assert.equal(nonString, generic);
  });

  test("a throwing ctx falls back to the plain form; an unknown class is empty", () => {
    const txt = wallFixText("git-https-auth", {
      hasProgram: () => { throw new Error("boom"); },
      remoteSsh: "git@github.com:acme/shop.git",
    });
    assert.equal(txt, wallFixText("git-https-auth", none));
    assert.equal(wallFixText("no-such-wall" as WallClass, none), "");
  });
});

describe("sshRemoteFor", () => {
  test("rebuilds the SSH address from an https URL, dropping user and token", () => {
    assert.equal(sshRemoteFor("https://github.com/acme/shop.git"), "git@github.com:acme/shop.git");
    assert.equal(sshRemoteFor("https://github.com/acme/shop/"), "git@github.com:acme/shop.git");
    assert.equal(sshRemoteFor("  https://user:tok123@gitlab.example.com/grp/sub/proj  "), "git@gitlab.example.com:grp/sub/proj.git");
  });

  test("null for other schemes, option-like parts and dot-dot paths", () => {
    assert.equal(sshRemoteFor("http://github.com/acme/shop.git"), null);
    assert.equal(sshRemoteFor("git@github.com:acme/shop.git"), null);
    assert.equal(sshRemoteFor("https://github.com/-acme/shop"), null);
    assert.equal(sshRemoteFor("https://github.com/acme/.."), null);
    assert.equal(sshRemoteFor("https://github.com/acme"), null);
    assert.equal(sshRemoteFor(undefined as unknown as string), null);
  });
});

describe("matchWall windows and guards", () => {
  test("colour codes are removed before matching", () => {
    const out = "\x1b[31mnpm error code E401\x1b[0m\n\x1b[31mnpm error 401 Unauthorized\x1b[0m";
    assert.equal(matchWall(out, "npm publish", true), "npm-e401-eotp");
  });

  test("a long result matches on its head window", () => {
    const out = "npm error code EOTP\n" + "x".repeat(20000);
    assert.equal(matchWall(out, "npm publish", true), "npm-e401-eotp");
  });

  test("a long result matches on a whole line in its tail window", () => {
    const out = "x".repeat(10000) + "\nENOSPC: no space left on device, write";
    assert.equal(matchWall(out, "npm ci", true), "enospc");
  });

  test("an error only in the middle of a long result is not seen", () => {
    const out = "a".repeat(6000) + "\nENOSPC: no space left on device\n" + "b".repeat(6000);
    assert.equal(matchWall(out, "npm ci", true), null);
  });

  test("a tail window cut mid-line with no newline is dropped", () => {
    const tail = "ENOSPC: " + "z".repeat(4096 - 8);
    assert.equal(tail.length, 4096);
    assert.equal(matchWall("x".repeat(6000) + tail, "npm ci", true), null);
    // The same text starting a real line is kept.
    assert.equal(matchWall("x".repeat(5999) + "\n" + tail, "npm ci", true), "enospc");
  });

  test("bad inputs are no hit", () => {
    assert.equal(matchWall("", "npm ci", true), null);
    assert.equal(matchWall(42 as unknown as string, "npm ci", true), null);
    assert.equal(matchWall("npm error code E401", null as unknown as string, true), null);
    assert.equal(matchWall("npm error code E401", "npm publish " + "a".repeat(70 * 1024), true), null);
  });

  test("printers alone show planted text; a real program still fires", () => {
    const out = "ENOSPC: no space left on device, write";
    assert.equal(matchWall(out, "cat build.log", true), null);
    assert.equal(matchWall(out, "cp big.tar /tmp/full/", true), "enospc");
    const docker = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
    assert.equal(matchWall(docker, "grep docker notes.txt", true), null);
    assert.equal(matchWall(docker, "docker compose up -d db", true), "docker-rootless");
  });

  test("the npm wall needs an npm-family program in the command", () => {
    assert.equal(matchWall("npm error code E401", "make publish", true), null);
    assert.equal(matchWall("npm error code E401", "sudo -u ci pnpm publish", true), "npm-e401-eotp");
  });
});

describe("lastTimeText", () => {
  test("two days give the newest two dates and the lesson", () => {
    const txt = lastTimeText("Push with git push origin over SSH", ["2024-03-01", "2024-10-05", "2024-10-02"]);
    assert.match(txt, /worked on Oct 2 and Oct 5\): Push with git push origin over SSH$/);
    assert.ok(txt.startsWith("[trail] What fixed this here before"));
  });

  test("two epochs on one day say twice", () => {
    const txt = lastTimeText("Run colima start first", ["2024-10-02", "2024-10-02"]);
    assert.match(txt, /worked twice on Oct 2\): Run colima start first$/);
  });

  test("replacement patterns in the lesson are plain text", () => {
    const txt = lastTimeText("cost $& and $' here", ["2024-01-01", "2024-02-09"]);
    assert.ok(txt.endsWith("cost $& and $' here"), txt);
    assert.match(txt, /Jan 1 and Feb 9/);
  });

  test("fewer than two real days, junk, or no lesson give ''", () => {
    assert.equal(lastTimeText("lesson", ["2024-10-02"]), "");
    assert.equal(lastTimeText("lesson", ["2024-10-02", "yesterday", 5 as unknown as string]), "");
    assert.equal(lastTimeText("lesson", null as unknown as string[]), "");
    assert.equal(lastTimeText("", ["2024-10-02", "2024-10-03"]), "");
  });
});
