import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { changed, planRetract, runRetract, type Retraction } from "../src/hosts/retract.js";
import { claudeGlobalTargets } from "../src/hosts/claude-global.js";

let root: string;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hosts-retract-gaps-")));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixture(tag: string) {
  const repo = join(root, tag, "repo");
  const home = join(root, tag, "home");
  mkdirSync(home, { recursive: true });
  put(join(repo, "README.md"), "Project files live here.\n");
  return { repo, home, local: { home, global: false } };
}

function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

const read = (path: string) => readFileSync(path, "utf8");

function action(report: Retraction[], path: string): Retraction["action"] {
  const matches = report.filter((entry) => entry.path === path);
  assert.equal(matches.length, 1, `expected one retraction for ${path}`);
  return matches[0]!.action;
}

function setEnv(values: Record<string, string>): () => void {
  const prior = Object.keys(values).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, values);
  return () => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const graftBlock = "<!-- graft:start -->\nGenerated instructions.\n<!-- graft:end -->\n";
const trailBlock = "<!-- trail:start -->\nOther generated instructions.\n<!-- trail:end -->\n";

describe("instruction retraction", () => {
  test("strips both brands' fences, collapsing the gap without changing CRLF", () => {
    const { repo, local } = fixture("crlf");
    const original = (
      `# Team notes\n\n${graftBlock}\n${trailBlock}\nRun the local tests first.\n`
    ).replace(/\n/g, "\r\n");
    const agents = put(join(repo, "AGENTS.md"), original);

    const preview = planRetract(repo, { ...local, apply: true });
    assert.equal(action(preview, agents), "removed");
    assert.deepEqual(changed(preview).map((entry) => entry.path), [agents]);
    assert.equal(read(agents), original);

    assert.equal(action(runRetract(repo, { ...local, apply: true }), agents), "removed");
    assert.equal(read(agents), "# Team notes\r\n\r\nRun the local tests first.\r\n");
    assert.equal(action(runRetract(repo, { ...local, apply: true }), agents), "absent");
  });

  test("a default plan predicts deletion of a fence-only file without deleting it", (t) => {
    const { repo, home, local } = fixture("fence-only");
    t.after(setEnv({ HOME: home, USERPROFILE: home }));
    const agents = put(join(repo, "AGENTS.md"), `\n${graftBlock}\n`);

    assert.equal(action(planRetract(repo), agents), "deleted");
    assert.equal(action(runRetract(repo, { ...local, apply: false }), agents), "deleted");
    assert.equal(read(agents), `\n${graftBlock}\n`);

    assert.equal(action(runRetract(repo, local), agents), "deleted");
    assert.equal(existsSync(agents), false);
    assert.equal(read(join(repo, "README.md")), "Project files live here.\n");
  });

  test("marker examples in prose are not treated as standalone fences", () => {
    const { repo, local } = fixture("inline-marker");
    const original = "The opening marker is `<!-- graft:start -->`.\nKeep this paragraph.\n";
    const agents = put(join(repo, "AGENTS.md"), original);

    assert.equal(action(runRetract(repo, { ...local, apply: true }), agents), "absent");
    assert.equal(read(agents), original);
  });

  test("excluding Antigravity protects shared AGENTS.md without skipping Claude's settings", () => {
    const { repo, local } = fixture("shared-exclusion");
    const agents = put(join(repo, "AGENTS.md"), graftBlock);
    const claude = put(join(repo, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "node trail-hooks.cjs" }] }],
      },
    }));
    assert.equal(action(planRetract(repo, local), agents), "deleted");

    const report = runRetract(repo, { ...local, apply: true, exclude: ["antigravity"] });
    assert.equal(report.some((entry) => entry.path === agents), false);
    assert.equal(read(agents), graftBlock);
    assert.equal(action(report, claude), "deleted");
    assert.equal(existsSync(claude), false);
  });
});

describe("JSON configuration retraction", () => {
  const graft = { command: "graft", args: ["serve"] };
  const trail = { command: "trail", args: ["serve"] };
  const custom = { command: "my-local-server" };

  const mcpCases = [
    {
      tag: "owned",
      input: { mcpServers: { graft, trail } },
      expected: undefined,
    },
    {
      tag: "foreign-server",
      input: { mcpServers: { graft, trail, custom } },
      expected: { mcpServers: { custom } },
    },
    {
      tag: "foreign-setting",
      input: { mcpServers: { trail }, description: "My local config" },
      expected: { description: "My local config" },
    },
  ];

  for (const { tag, input, expected } of mcpCases) {
    test(`plans and applies ${tag} MCP cleanup`, () => {
      const { repo, local } = fixture(`mcp-${tag}`);
      const original = JSON.stringify(input);
      const config = put(join(repo, ".mcp.json"), original);
      const want = expected === undefined ? "deleted" : "removed";

      assert.equal(action(planRetract(repo, local), config), want);
      assert.equal(read(config), original);
      assert.equal(action(runRetract(repo, { ...local, apply: true }), config), want);
      if (expected === undefined) {
        assert.equal(existsSync(config), false);
      } else {
        assert.deepEqual(JSON.parse(read(config)), expected);
        assert.equal(action(planRetract(repo, local), config), "absent");
      }
    });
  }

  for (const [tag, original, want] of [
    ["invalid", '{"mcpServers":', "skipped-unparseable"],
    ["null-root", "null", "skipped-unparseable"],
    ["array-root", "[]", "skipped-unparseable"],
    ["array-bucket", '{"mcpServers":[]}', "absent"],
    ["null-bucket", '{"mcpServers":null}', "absent"],
    ["foreign-only", JSON.stringify({ mcpServers: { custom } }), "absent"],
  ] as const) {
    test(`leaves ${tag} MCP content byte for byte`, () => {
      const { repo, local } = fixture(`mcp-${tag}`);
      const config = put(join(repo, ".mcp.json"), original);

      assert.equal(action(runRetract(repo, { ...local, apply: true }), config), want);
      assert.equal(read(config), original);
    });
  }

  test("keeps Claude user hooks and settings while deleting an owned-only local settings file", () => {
    const { repo, local } = fixture("claude-settings");
    const userHook = { hooks: [{ type: "command", command: "node my-check.cjs" }] };
    const graftHook = { hooks: [{ type: "command", command: "node graft-hooks.cjs" }] };
    const trailHook = { hooks: [{ type: "command", command: "node trail-hooks.cjs" }] };
    const statusLine = { type: "command", command: "node my-statusline.cjs" };
    const config = put(join(repo, ".claude", "settings.json"), JSON.stringify({
      statusLine,
      hooks: { PostToolUse: [graftHook, userHook], SessionStart: [trailHook] },
    }));
    const localConfig = put(join(repo, ".claude", "settings.local.json"), JSON.stringify({
      hooks: { SessionStart: [trailHook] },
    }));

    const preview = planRetract(repo, local);
    assert.equal(action(preview, config), "removed");
    assert.equal(action(preview, localConfig), "deleted");
    assert.equal(existsSync(localConfig), true);

    const report = runRetract(repo, { ...local, apply: true });
    assert.equal(action(report, config), "removed");
    assert.equal(action(report, localConfig), "deleted");
    assert.equal(existsSync(localConfig), false);
    assert.deepEqual(JSON.parse(read(config)), { statusLine, hooks: { PostToolUse: [userHook] } });
  });

  test("Cursor keeps user hooks and the schema version until only graft's hooks remain", () => {
    const { repo, local } = fixture("cursor-hooks");
    const userHook = { command: "node my-cursor-hook.cjs" };
    const graftHook = { command: "node graft-hooks.cjs" };
    const trailHook = { command: "node trail-hooks.cjs" };
    const original = JSON.stringify({
      version: 1,
      hooks: { afterFileEdit: [graftHook, userHook], sessionStart: [trailHook] },
    });
    const config = put(join(repo, ".cursor", "hooks.json"), original);

    assert.equal(action(planRetract(repo, local), config), "removed");
    assert.equal(read(config), original);
    assert.equal(action(runRetract(repo, { ...local, apply: true }), config), "removed");
    assert.deepEqual(JSON.parse(read(config)), {
      version: 1,
      hooks: { afterFileEdit: [userHook] },
    });

    const ownedOnly = JSON.stringify({ version: 1, hooks: { sessionStart: [trailHook] } });
    put(config, ownedOnly);
    assert.equal(action(planRetract(repo, local), config), "deleted");
    assert.equal(read(config), ownedOnly);
    assert.equal(action(runRetract(repo, { ...local, apply: true }), config), "deleted");
    assert.equal(existsSync(config), false);
    assert.equal(existsSync(dirname(config)), false, "the empty .cursor directory is pruned");
  });

  test("Cursor distinguishes malformed hooks JSON from a config with no hook map", () => {
    const { repo, local } = fixture("cursor-invalid");
    const config = join(repo, ".cursor", "hooks.json");
    for (const [original, want] of [
      ['{"hooks":', "skipped-unparseable"],
      ["null", "skipped-unparseable"],
      ['{"version":1,"hooks":[]}', "absent"],
    ] as const) {
      put(config, original);
      assert.equal(action(runRetract(repo, { ...local, apply: true }), config), want);
      assert.equal(read(config), original);
    }
  });
});

test("Claude's user-level shim and settings are cleaned only when global targets are enabled", (t) => {
  const { repo, home, local } = fixture("claude-global");
  t.after(setEnv({
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
  }));

  const [shimTarget, settingsTarget] = claudeGlobalTargets(home);
  const shimText = "// Generated shim.\n";
  const userHook = { hooks: [{ type: "command", command: "node my-check.cjs" }] };
  const graftHook = { hooks: [{ type: "command", command: "node graft-hooks.cjs" }] };
  const env = { MY_TEAM_SETTING: "enabled" };
  const settingsText = JSON.stringify({ env, hooks: { PostToolUse: [graftHook, userHook] } });
  const shim = put(shimTarget.path, shimText);
  const settings = put(settingsTarget.path, settingsText);

  const localReport = runRetract(repo, { ...local, apply: true });
  assert.equal(localReport.some((entry) => entry.path === shim || entry.path === settings), false);
  assert.equal(read(shim), shimText);
  assert.equal(read(settings), settingsText);

  const preview = planRetract(repo, { home });
  assert.equal(action(preview, shim), "deleted");
  assert.equal(action(preview, settings), "removed");
  assert.equal(read(shim), shimText);
  assert.equal(read(settings), settingsText);

  const report = runRetract(repo, { home, apply: true });
  assert.equal(action(report, shim), "deleted");
  assert.equal(action(report, settings), "removed");
  assert.equal(existsSync(shim), false);
  assert.deepEqual(JSON.parse(read(settings)), { env, hooks: { PostToolUse: [userHook] } });
});

describe("cache and ignore retraction", () => {
  test("cache:false keeps cache and ignore files; a full sweep preserves user content", () => {
    const { repo, local } = fixture("cache");
    const cache = join(repo, ".trail", "cache");
    const index = put(join(cache, "index.json"), "{}\n");
    const graft = put(join(repo, "graft"), "A user file, not a cache directory.\n");
    const gitignoreText = "# graft cache\n/graft/\n\nnode_modules";
    const ignoreText = "# graft search\n!graft/\ngraft/.cache/\ngraft/.graph/\n";
    const gitignore = put(join(repo, ".gitignore"), gitignoreText);
    const ignore = put(join(repo, ".ignore"), ignoreText);
    const agents = put(join(repo, "AGENTS.md"), graftBlock);

    const keep = runRetract(repo, { ...local, apply: true, cache: false });
    assert.equal(keep.some((entry) => entry.hostId === "graph"), false);
    assert.equal(action(keep, agents), "deleted");
    assert.equal(existsSync(agents), false);
    assert.equal(read(index), "{}\n");
    assert.equal(read(gitignore), gitignoreText);
    assert.equal(read(ignore), ignoreText);

    const preview = planRetract(repo, local);
    assert.equal(action(preview, cache), "deleted");
    assert.equal(action(preview, gitignore), "removed");
    assert.equal(action(preview, ignore), "deleted");
    assert.equal(read(index), "{}\n");
    assert.equal(read(gitignore), gitignoreText);
    assert.equal(read(ignore), ignoreText);

    const report = runRetract(repo, { ...local, apply: true });
    assert.equal(action(report, cache), "deleted");
    assert.equal(action(report, graft), "absent");
    assert.equal(action(report, gitignore), "removed");
    assert.equal(action(report, ignore), "deleted");
    assert.equal(existsSync(dirname(cache)), false);
    assert.equal(read(graft), "A user file, not a cache directory.\n");
    assert.equal(read(gitignore), "node_modules\n");
    assert.equal(existsSync(ignore), false);
  });

  test("a directory that becomes non-empty during pruning is left intact", () => {
    const { repo, local } = fixture("prune-race");
    const parent = join(repo, ".trail");
    const cache = join(parent, "cache");
    put(join(cache, "index.json"), "{}\n");
    const newNote = join(parent, "new-note.md");
    const gitignore = put(join(repo, ".gitignore"), "graft/\n");

    const rmdirSync = fs.rmdirSync;
    const stub = mock.method(fs, "rmdirSync", (...args: Parameters<typeof rmdirSync>) => {
      if (args[0] === parent) writeFileSync(newNote, "A note saved during cleanup.\n");
      return rmdirSync(...args);
    });

    let report: Retraction[];
    try {
      syncBuiltinESMExports();
      report = runRetract(repo, { ...local, apply: true });
    } finally {
      stub.mock.restore();
      syncBuiltinESMExports();
    }

    assert.equal(action(report, cache), "deleted");
    assert.equal(existsSync(cache), false);
    assert.equal(read(newNote), "A note saved during cleanup.\n");
    assert.equal(action(report, gitignore), "deleted", "cleanup continues after pruning stops");
    assert.equal(existsSync(gitignore), false);
  });
});
