import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  codexFailed,
  codexPostBash,
  postBashRun,
  postBashSkills,
  resultText,
} from "../src/claude/post-bash.js";
import { wallContextText, wallOfResult } from "../src/claude/walls-hook.js";
import { hostFacts } from "../src/skills/host-facts.js";
import { gateFilePath, skillsOnFast } from "../src/trace/gate-file.js";
import { detectHost } from "../src/trace/host.js";
import { cleanTail } from "../src/trace/run-calls.js";
import { skillsGate } from "../src/trace/skill-session.js";

describe("post-Bash hook", () => {
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let restoreFetch: (() => void) | undefined;

  before(() => {
    const fetchStub = mock.method(globalThis, "fetch", async () => {
      throw new Error("Post-Bash tests must not make HTTP requests");
    });
    restoreFetch = () => fetchStub.mock.restore();

    root = realpathSync(mkdtempSync(join(tmpdir(), "post-bash-gaps-")));
    repo = join(root, "repo");
    mkdirSync(repo);
    env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      TMPDIR: root,
      TEMP: root,
      TMP: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
      TRAIL_HOME: join(root, "trail"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CODEX_HOME: join(root, "codex"),
    };

    if (!skillsOnFast(env)) {
      for (const value of ["1", "on", "true"]) {
        env.TRAIL_SKILLS = value;
        if (skillsOnFast(env)) break;
      }
    }
    assert.equal(skillsOnFast(env), true, "the fixture must enable skills");

    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
    git("init", "--initial-branch=main");
    git("-c", "user.name=Hook Test", "-c", "user.email=hook@example.invalid",
      "commit", "--allow-empty", "-m", "Initial commit");
    git("remote", "add", "origin", "https://example.invalid/example/fixture.git");
  });

  after(() => {
    try {
      restoreFetch?.();
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  function bash(command = "npm test", host: "claude" | "codex" = "claude") {
    const sid = randomUUID();
    const transcriptDir = host === "codex"
      ? join(env.CODEX_HOME!, "sessions", "2026", "01", "01")
      : join(env.CLAUDE_CONFIG_DIR!, "projects", "fixture");
    mkdirSync(transcriptDir, { recursive: true });
    const transcript = join(
      transcriptDir,
      host === "codex" ? `rollout-2026-01-01T00-00-00-${sid}.jsonl` : `${sid}.jsonl`,
    );
    writeFileSync(transcript, "");
    return {
      session_id: sid,
      transcript_path: transcript,
      cwd: repo,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: `toolu_${randomUUID()}`,
      tool_input: { command },
      ...(host === "codex" ? { turn_id: randomUUID(), model: "gpt-5.4" } : {}),
    };
  }

  interface Mark {
    id: string;
    at: string;
    failed: boolean;
    tail?: string;
  }

  function markFiles(): string[] {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".post.jsonl"))
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
  }

  function marksFor(id: string): Mark[] {
    return markFiles().flatMap((file) =>
      readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)
        .map((line) => JSON.parse(line) as Mark),
    ).filter((mark) => mark.id === id);
  }

  function assertMark(id: string, failed: boolean, tail?: string) {
    const marks = marksFor(id);
    assert.equal(marks.length, 1, "expected exactly one mark for this tool call");
    const mark = marks[0]!;
    assert.equal(mark.failed, failed);
    assert.equal(mark.at, new Date(mark.at).toISOString());
    if (tail === undefined) {
      assert.equal(Object.hasOwn(mark, "tail"), false);
    } else {
      assert.equal(mark.tail, tail);
    }
  }

  function codexOutput(code: number, body: string): string {
    return [
      "Chunk ID: a1b2c3",
      "Wall time: 0.012 seconds",
      `Process exited with code ${code}`,
      "Original token count: 6",
      "Output:",
      body,
    ].join("\n");
  }

  test("the HookOut wrapper ignores a non-Bash tool with its default arguments", () => {
    assert.deepEqual(postBashSkills({ tool_name: "Read" }, repo), {});
  });

  test("the HookOut wrapper still journals a successful check", () => {
    const { session_id, ...input } = bash();
    assert.deepEqual(postBashSkills({
      ...input,
      sessionId: session_id,
      tool_response: { stdout: "Tests started", stderr: "\n2 tests passed" },
    }, repo, env), {});
    assertMark(input.tool_use_id, false, "Tests started\n2 tests passed");
  });

  test("a payload without a command isn't a check and produces no wall context", () => {
    const input = {
      ...bash(),
      tool_input: { description: "Run tests" },
      tool_response: "Tests passed",
    };
    const beforeFiles = markFiles();
    assert.deepEqual(postBashRun(input, repo, env), { out: {}, marked: false, sent: [] });
    assert.deepEqual(markFiles(), beforeFiles);
  });

  test("a failed non-check in a gated session is journaled without changing the gate", () => {
    const input = {
      ...bash("git status"),
      hook_event_name: "PostToolUseFailure",
      error: "The request to run this command was declined.",
    };
    const gate = gateFilePath(input.session_id, env);
    mkdirSync(dirname(gate), { recursive: true });
    const priorGate = "{}\n";
    writeFileSync(gate, priorGate);

    assert.deepEqual(postBashRun(input, repo, env, true), {
      out: {}, marked: true, sent: [],
    });
    assertMark(input.tool_use_id, true);
    assert.equal(readFileSync(gate, "utf8"), priorGate);
  });

  test("a failed check without string error text gets a mark but no tail", () => {
    const input = {
      ...bash(),
      hook_event_name: "PostToolUseFailure",
      error: { message: "Not transcript text" },
      tool_response: "Do not use this as the error",
    };
    assert.deepEqual(postBashRun(input, repo, env, true), {
      out: {}, marked: true, sent: [],
    });
    assertMark(input.tool_use_id, true);
  });

  test("result text uses only the transcript's string fields", () => {
    assert.equal(resultText({ tool_response: "plain output" }, false), "plain output");
    assert.equal(resultText({ tool_response: { stdout: 0, stderr: "warning" } }, false), "warning");
    assert.equal(resultText({ tool_response: { stdout: "done", stderr: null } }, false), "done");
    assert.equal(resultText({ tool_response: 42 }, false), "");
    assert.equal(resultText({ tool_response: null }, false), "");
    assert.equal(resultText(undefined, false), "");
    assert.equal(resultText(undefined, true), "");
    assert.equal(resultText({ error: "User declined", tool_response: "ignored" }, true), "User declined");
  });

  test("Codex output without an exit header leaves no result mark", () => {
    const input = { ...bash("npm test", "codex"), tool_response: "Build output was truncated." };
    const beforeFiles = markFiles();
    assert.equal(codexFailed(input.tool_response), null);
    assert.equal(codexFailed(undefined), null);
    assert.equal(codexPostBash(input, repo, env), null);
    assert.deepEqual(markFiles(), beforeFiles);
  });

  test("Codex success records only the output body", () => {
    const input = {
      ...bash("npm test", "codex"),
      tool_response: codexOutput(0, "2 tests passed"),
    };
    assert.equal(codexFailed(input.tool_response), false);
    assert.deepEqual(codexPostBash(input, repo, env), { out: {}, marked: true, sent: [] });
    assertMark(input.tool_use_id, false, "2 tests passed");
  });

  test("Codex failure records the nonzero exit and output body", () => {
    const input = {
      ...bash("npm test", "codex"),
      tool_response: codexOutput(7, "Expected 2 items but got 1"),
    };
    assert.equal(codexFailed(input.tool_response), true);
    assert.deepEqual(codexPostBash(input, repo, env), { out: {}, marked: true, sent: [] });
    assertMark(input.tool_use_id, true, "Exit code 7\nExpected 2 items but got 1");
  });

  // Use representative failure text without running the commands.
  const failures = [
    ["git push", "! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs"],
    ["git push", "fatal: Authentication failed for 'https://example.invalid/example/fixture.git'"],
    ["git push", "fatal: could not read Username for 'https://example.invalid': terminal prompts disabled"],
    ["git fetch", "ssh: Could not resolve hostname example.invalid: Name or service not known\nfatal: Could not read from remote repository."],
    ["git status", "fatal: detected dubious ownership in repository"],
    ["git status", "fatal: not a git repository (or any of the parent directories): .git"],
    ["npm install", "npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree"],
    ["npm install", "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied, mkdir"],
    ["npm install", "npm ERR! code ENOSPC\nnpm ERR! no space left on device"],
    ["npm install", "npm ERR! code EAI_AGAIN\nnpm ERR! getaddrinfo EAI_AGAIN registry.npmjs.org"],
    ["npm run dev", "Error: listen EADDRINUSE: address already in use :::3000"],
    ["gh pr view", "To get started with GitHub CLI, please run: gh auth login"],
    ["docker ps", "Cannot connect to the Docker daemon. Is the docker daemon running?"],
  ] as const;

  for (const host of ["claude", "codex"] as const) {
    test(`${host}: catalogued failure telemetry is independent of model context`, () => {
      const shown = (body: string) => host === "codex" ? `Exit code 1\n${body}` : body;
      const [command, body] = failures.find(([cmd, text]) =>
        wallOfResult(shown(text), cmd, true)
      ) ?? failures[0];
      const input = {
        ...bash(command, host),
        hook_event_name: host === "codex" ? "PostToolUse" : "PostToolUseFailure",
        ...(host === "codex" ? { tool_response: codexOutput(1, body) } : { error: body }),
      };

      const cls = wallOfResult(shown(body), command, true);
      const gate = skillsGate(input, repo, env);
      const result = host === "codex"
        ? codexPostBash(input, repo, env)
        : postBashRun(input, repo, env, true);

      assert.ok(result);
      // A recognized check gets a mark even with no pre-existing gate file.
      assert.equal(result.marked, true, `expected a failed check mark for ${command}`);
      assertMark(input.tool_use_id, true, cleanTail(shown(body)) || undefined);

      if (!cls || !gate.ok) {
        assert.deepEqual(result.sent, []);
        assert.deepEqual(result.out, {});
        return;
      }

      assert.deepEqual(result.sent, [["wall_hit", { class: cls, had_lesson: "false" }]]);
      const detected = detectHost(input).host;
      const facts = hostFacts(env, detected);
      const visible = detected === "codex" ? facts.postToolContext : facts.failureContext;
      if (visible) {
        const { text } = wallContextText(cls, {
          checkout: gate.ctx.checkout,
          repoKey: gate.ctx.repoKey,
          env,
          now: gate.ctx.now,
        });
        assert.ok(text.trim(), "the catalog must supply a fix");
        assert.equal(result.out.context, text);
      } else {
        assert.equal(result.out.context, undefined);
      }
    });
  }
});
