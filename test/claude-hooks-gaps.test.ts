/**
 * Gaps in src/claude/hooks.ts: edit-path parsing across host shapes, the map
 * check for relative and Windows paths, the touch-learnings plumbing outside
 * trail, and the once-a-day repo bookkeeping (repo_seen, learnings committed,
 * the uncommitted-learnings line and the shared-setup check).
 */
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpRepo } from "./helpers.js";
import {
  underGraft,
  editedFilePath,
  withTouchLearnings,
  learningsOnTouch,
  handlePreEdit,
  trackRepoSeen,
  trackLearningsCommitted,
  uncommittedDirective,
  setupUncommitted,
} from "../src/claude/hooks.js";
import { cacheDir, readJson } from "../src/util/state.js";
import { repoPlace } from "../src/notes/home.js";

const DAY = 24 * 60 * 60 * 1000;
const made: string[] = [];

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=T", "-c", "user.email=t@t.test", ...args], { cwd, encoding: "utf8" });

function scratch(tag: string): string {
  const d = tmpRepo(tag);
  made.push(d);
  return d;
}

/** A git repo with one commit, so HEAD exists. */
function repo(tag: string): string {
  const d = scratch(tag);
  git(d, "init", "-q");
  writeFileSync(join(d, "README.md"), "# r\n");
  git(d, "add", "README.md");
  git(d, "commit", "-qm", "init");
  return d;
}

function learning(d: string, name: string): void {
  mkdirSync(join(d, ".trail", "learnings"), { recursive: true });
  writeFileSync(join(d, ".trail", "learnings", name), `---\nid: ${name}\n---\nA learning.\n`);
}

function markFile(d: string, name: string): string {
  return join(cacheDir(repoPlace(d).checkout), name);
}

after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("underGraft", () => {
  test("a path relative to the repo is checked as it stands", () => {
    assert.equal(underGraft("/r", "graft/node.md"), true);
    assert.equal(underGraft("/r", ".trail/cache/x.md"), true);
    assert.equal(underGraft("/r", "src/a.ts"), false);
  });

  test("Windows separators are read as the same folders", () => {
    assert.equal(underGraft("C:\\r", "C:\\r\\.trail\\cache\\n.md"), true);
    assert.equal(underGraft("C:\\r", "C:\\r\\graft\\INDEX.md"), true);
    assert.equal(underGraft("C:\\r", "C:\\r\\src\\a.ts"), false);
  });
});

describe("editedFilePath", () => {
  const dir = resolve("repo-root");

  test("Claude's file_path wins as given", () => {
    const p = join(dir, "src", "a.ts");
    assert.equal(editedFilePath({ tool_input: { file_path: p, command: "*** Add File: other.ts" } }, dir), p);
  });

  test("a Codex patch names a repo-relative file, resolved against the project", () => {
    const cmd = "*** Begin Patch\n*** Update File: src/b.ts\n@@\n-old\n+new\n*** End Patch";
    assert.equal(editedFilePath({ tool_input: { command: cmd } }, dir), join(dir, "src/b.ts"));
    const add = "*** Begin Patch\n*** Add File: new.ts  \n+x\n*** Add File: second.ts\n*** End Patch";
    assert.equal(editedFilePath({ tool_input: { command: add } }, dir), join(dir, "new.ts"), "the first target, trimmed");
  });

  test("an absolute path in the patch header is kept", () => {
    const abs = resolve(dir, "elsewhere", "c.ts");
    assert.equal(editedFilePath({ tool_input: { command: `*** Update File: ${abs}` } }, dir), abs);
  });

  test("a blank file_path falls through to the command; nothing usable is null", () => {
    assert.equal(editedFilePath({ tool_input: { file_path: "   ", command: "*** Add File: d.ts" } }, dir), join(dir, "d.ts"));
    assert.equal(editedFilePath({ tool_input: { file_path: "  " } }, dir), null);
    assert.equal(editedFilePath({ tool_input: { command: "*** Delete File: gone.ts" } }, dir), null);
    assert.equal(editedFilePath({ tool_input: { command: "" } }, dir), null);
    assert.equal(editedFilePath(undefined, dir), null);
    assert.equal(editedFilePath({ tool_input: { command: 42 } }, dir), null);
  });
});

describe("touch learnings outside a repo that keeps them", () => {
  let plain: string;
  before(() => { plain = scratch("hooks-touch-plain"); });

  test("learningsOnTouch has nothing to say", () => {
    assert.equal(learningsOnTouch({ tool_name: "Read", tool_input: { file_path: join(plain, "a.ts") } }, plain), null);
    assert.equal(learningsOnTouch({ tool_name: "Bash", tool_input: { command: "cat a.ts" } }, plain, true), null);
  });

  test("withTouchLearnings passes a block, and an answer with nothing to add, through untouched", () => {
    const blocked = { block: "no", context: "ctx" } as any;
    assert.equal(withTouchLearnings(blocked, { tool_input: { file_path: join(plain, "a.ts") } }, plain), blocked);
    const out = { context: "skills mark" } as any;
    const got = withTouchLearnings(out, { tool_name: "Edit", tool_input: { file_path: join(plain, "a.ts") } }, plain);
    assert.equal(got, out);
    assert.equal(got.context, "skills mark");
  });

  test("handlePreEdit writes no hook answer when there are no learnings", () => {
    const write = mock.method(process.stdout, "write", () => true);
    try {
      handlePreEdit({ tool_name: "Edit", tool_input: { file_path: join(plain, "a.ts") } }, plain);
      assert.equal(write.mock.callCount(), 0);
    } finally {
      write.mock.restore();
    }
  });
});

describe("trackRepoSeen", () => {
  test("outside git nothing is marked", () => {
    const d = scratch("hooks-seen-nogit");
    trackRepoSeen(d, 1_000_000);
    assert.equal(existsSync(join(d, ".git")), false);
  });

  test("a repo is seen once a day", () => {
    const d = repo("hooks-seen");
    const now = 10 * DAY;
    trackRepoSeen(d, now);
    const mark = markFile(d, "trail-repo-seen.json");
    assert.equal(readJson<{ at: number }>(mark)?.at, now);
    trackRepoSeen(d, now + 1000);
    assert.equal(readJson<{ at: number }>(mark)?.at, now, "within the day: not again");
    trackRepoSeen(d, now + DAY);
    assert.equal(readJson<{ at: number }>(mark)?.at, now + DAY);
  });
});

describe("trackLearningsCommitted", () => {
  test("a repo without a HEAD is counted next time", () => {
    const d = scratch("hooks-committed-nohead");
    git(d, "init", "-q");
    trackLearningsCommitted(d);
    assert.equal(existsSync(markFile(d, "trail-learnings-committed.json")), false);
  });

  test("the committed learnings on HEAD are counted, and the count follows new commits", () => {
    const d = repo("hooks-committed");
    learning(d, "a.md");
    learning(d, "b.md");
    writeFileSync(join(d, ".trail", "learnings", "notes.txt"), "not a learning\n");
    git(d, "add", ".trail");
    git(d, "commit", "-qm", "learnings");
    trackLearningsCommitted(d);
    const mark = markFile(d, "trail-learnings-committed.json");
    assert.equal(readJson<{ count: number }>(mark)?.count, 2);

    learning(d, "c.md");
    git(d, "add", ".trail");
    git(d, "commit", "-qm", "one more");
    trackLearningsCommitted(d);
    assert.equal(readJson<{ count: number }>(mark)?.count, 3);

    git(d, "rm", "-q", ".trail/learnings/a.md", ".trail/learnings/b.md");
    git(d, "commit", "-qm", "fewer");
    trackLearningsCommitted(d);
    assert.equal(readJson<{ count: number }>(mark)?.count, 1, "a drop is recorded too");
  });
});

describe("uncommittedDirective", () => {
  test("outside git, and with everything committed, there is nothing to say", () => {
    assert.equal(uncommittedDirective(scratch("hooks-unc-nogit")), "");
    const d = repo("hooks-unc-clean");
    learning(d, "a.md");
    git(d, "add", ".trail");
    git(d, "commit", "-qm", "learnings");
    assert.equal(uncommittedDirective(d, 5 * DAY), "");
  });

  test("one uncommitted learning is named once a day", () => {
    const d = repo("hooks-unc-one");
    learning(d, "a.md");
    const now = 20 * DAY;
    const text = uncommittedDirective(d, now);
    assert.match(text, /1 learning added to this repo \(in \.trail\/learnings\/\) isn't committed yet/);
    assert.match(text, /word for word: /);
    assert.ok(text.endsWith("\n"));
    assert.equal(uncommittedDirective(d, now + 1000), "", "said already today");
    assert.match(uncommittedDirective(d, now + DAY), /1 learning added/);
  });

  test("several uncommitted learnings are counted", () => {
    const d = repo("hooks-unc-two");
    learning(d, "a.md");
    learning(d, "b.md");
    assert.match(uncommittedDirective(d, 30 * DAY), /2 learnings added to this repo .* aren't committed yet/);
  });

  test("an uncommitted shared setup is said instead", () => {
    const d = repo("hooks-unc-setup");
    mkdirSync(join(d, ".trail"), { recursive: true });
    writeFileSync(join(d, ".trail", "hook.cjs"), "// hook\n");
    const text = uncommittedDirective(d, 40 * DAY);
    assert.match(text, /trail's shared setup here \(\.trail\/ and \.claude\/settings\.json\) isn't committed yet/);
  });
});

describe("setupUncommitted", () => {
  test("no hook on disk: the old setup says nothing", () => {
    assert.equal(setupUncommitted(repo("hooks-setup-none")), false);
  });

  test("an untracked hook, or HEAD's settings not running it, is uncommitted; committed both is not", () => {
    const d = repo("hooks-setup");
    mkdirSync(join(d, ".trail"), { recursive: true });
    writeFileSync(join(d, ".trail", "hook.cjs"), "// hook\n");
    assert.equal(setupUncommitted(d), true, "hook not tracked");

    git(d, "add", ".trail/hook.cjs");
    git(d, "commit", "-qm", "hook");
    assert.equal(setupUncommitted(d), true, "no settings in HEAD");

    mkdirSync(join(d, ".claude"), { recursive: true });
    writeFileSync(join(d, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
    git(d, "add", ".claude/settings.json");
    git(d, "commit", "-qm", "settings without the hook");
    assert.equal(setupUncommitted(d), true, "settings don't run the hook");

    writeFileSync(join(d, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ command: 'node "$CLAUDE_PROJECT_DIR"/.trail/hook.cjs session-start' }] } }));
    git(d, "add", ".claude/settings.json");
    git(d, "commit", "-qm", "settings run the hook");
    assert.equal(setupUncommitted(d), false);
  });
});
