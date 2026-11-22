import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { collectSetup, setupCounts } from "../src/cloud/share-setup.js";
import { tmpRepo } from "./helpers.js";

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function putJson(path: string, value: unknown): void {
  put(path, JSON.stringify(value));
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function withEnv<T>(patch: Record<string, string | undefined>, run: () => T): T {
  const saved = Object.keys(patch).map((key) => [key, process.env[key]] as const);
  try {
    for (const [key, value] of Object.entries(patch)) setEnv(key, value);
    return run();
  } finally {
    for (const [key, value] of saved) setEnv(key, value);
  }
}

describe("collectSetup configuration and discovery gaps", () => {
  let root: string;
  let savedAppData: string | undefined;

  before(() => {
    savedAppData = process.env.APPDATA;
    root = tmpRepo("share-setup-gaps");
    process.env.APPDATA = join(root, "empty-app-data");
    mock.method(globalThis, "fetch", async () => {
      throw new Error("Setup collection must not make HTTP requests");
    });
  });

  after(() => {
    setEnv("APPDATA", savedAppData);
    mock.restoreAll();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("uses the default home without treating that same directory as a project", () => {
    const home = join(root, "default-home");
    putJson(join(home, ".claude.json"), {
      mcpServers: { personal: { command: "node", args: ["personal.mjs"] } },
    });
    putJson(join(home, ".mcp.json"), {
      mcpServers: { notAProject: { command: "node" } },
    });

    const { setup } = withEnv({ HOME: home, USERPROFILE: home }, () =>
      collectSetup({ dirs: [home], who: [] }),
    );

    assert.deepEqual(
      setup.mcp.map(({ scope, name, command, args }) => ({ scope, name, command, args })),
      [{ scope: "user", name: "personal", command: "node", args: ["personal.mjs"] }],
    );
  });

  test("ignores invalid user JSON without losing valid project servers", () => {
    const home = join(root, "broken-config-home");
    const repo = join(root, "valid-project");
    putJson(join(repo, ".mcp.json"), {
      mcpServers: { reader: { command: "node", args: ["reader.mjs", 42, null, "--quiet"] } },
    });

    for (const text of ["null", "false", "42", '"wrong shape"', '[{"command":"node"}]', '{"mcpServers":']) {
      put(join(home, ".claude.json"), text);
      const { setup } = collectSetup({ home, dirs: [repo], who: [] });

      assert.equal(setup.mcp.length, 1, `user config: ${text}`);
      const [server] = setup.mcp;
      assert.match(server!.scope, /^project /);
      assert.equal(server!.name, "reader");
      assert.equal(server!.type, "stdio");
      assert.equal(server!.command, "node");
      assert.deepEqual(server!.args, ["reader.mjs", "--quiet"]);
    }
  });

  test("keeps only an absolute MCP URL's origin and scrubs a relative endpoint", () => {
    const home = join(root, "endpoint-home");
    putJson(join(home, ".claude.json"), {
      mcpServers: {
        remote: {
          url: "https://reader:placeholder@mcp.example.test:8443/stream?ticket=fixture#details",
          headers: { Authorization: "fixture header" },
        },
        relay: { type: "sse", url: "maya-relay?ticket=fixture#details" },
        local: { command: "node", url: "" },
      },
    });

    const { setup, hidden } = collectSetup({ home, who: ["maya"] });
    assert.equal(setup.mcp.length, 3);
    const remote = setup.mcp.find(({ name }) => name === "remote")!;
    assert.equal(remote.type, "http");
    assert.equal(remote.url, "https://mcp.example.test:8443");
    assert.deepEqual(remote.headers, ["Authorization"]);

    const relay = setup.mcp.find(({ name }) => name === "relay")!;
    assert.equal(relay.type, "sse");
    assert.equal(relay.url, "[you]-relay");
    assert.ok(hidden > 0);

    const local = setup.mcp.find(({ name }) => name === "local")!;
    assert.equal(local.type, "stdio");
    assert.equal(Object.hasOwn(local, "url"), false);
  });

  test("discovers Desktop servers in the platform's configured location", () => {
    const home = join(root, "desktop-home");
    const appData = join(root, "desktop-app-data");
    const configRoot =
      process.platform === "win32" ? appData
        : process.platform === "darwin" ? join(home, "Library", "Application Support")
        : join(home, ".config");

    putJson(join(configRoot, "Claude", "claude_desktop_config.json"), {
      mcpServers: { notebook: { command: "node", args: ["notebook.mjs"] } },
    });

    const { setup } = withEnv({ APPDATA: appData }, () => collectSetup({ home, who: [] }));
    assert.deepEqual(
      setup.mcp.map(({ scope, name, args }) => ({ scope, name, args })),
      [{ scope: "desktop", name: "notebook", args: ["notebook.mjs"] }],
    );
  });

  test("falls back to the home Roaming folder when APPDATA is unset", {
    skip: process.platform !== "win32",
  }, () => {
    const home = join(root, "roaming-home");
    putJson(join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"), {
      mcpServers: { notes: { command: "node", args: ["notes.mjs"] } },
    });

    const { setup } = withEnv({ APPDATA: undefined }, () => collectSetup({ home, who: [] }));
    assert.deepEqual(
      setup.mcp.map(({ scope, name, command }) => ({ scope, name, command })),
      [{ scope: "desktop", name: "notes", command: "node" }],
    );
  });

  test("collects useful settings while omitting the share hook and plumbing-only files", () => {
    const home = join(root, "settings-home");
    const repo = join(root, "settings-project");
    const sync = { type: "command", command: 'node "trail-hooks.cjs" share-sync' };
    putJson(join(home, ".claude", "settings.json"), {
      outputStyle: "Notes for maya",
      statusLine: { type: "command", command: "show-status maya" },
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ command: "check maya" }, sync, { command: 7 }] },
          { matcher: false, hooks: [{ command: "record use" }] },
          { matcher: "Edit", hooks: {} },
        ],
        PostToolUse: {},
        Stop: [{ hooks: [sync] }],
      },
      permissions: { ask: ["Bash(run-check)", false] },
      enabledPlugins: { "notes@local": true, "search@local": false, "other@local": 1 },
      env: { EXAMPLE_FLAG: "fixture value" },
    });
    putJson(join(repo, ".claude", "settings.json"), {
      hooks: { Stop: [{ hooks: [sync] }] },
    });
    putJson(join(repo, ".claude", "settings.local.json"), { model: "sonnet" });
    putJson(join(home, ".claude", "plugins", "installed_plugins.json"), {
      "search@local": [],
      "notes@local": [],
    });

    const { setup } = collectSetup({ home, dirs: [repo], who: ["maya"] });
    assert.equal(setup.settings.length, 2);
    const [user, local] = setup.settings;
    assert.equal(user!.outputStyle, "Notes for [you]");
    assert.equal(user!.statusLine, "show-status [you]");
    assert.deepEqual(user!.hooks, { PreToolUse: ["Bash → check [you]", "record use"] });
    assert.deepEqual(user!.permissions, { allow: [], ask: ["Bash(run-check)"], deny: [] });
    assert.deepEqual(user!.plugins, ["notes@local"]);
    assert.deepEqual(user!.env, ["EXAMPLE_FLAG"]);
    assert.ok(local!.path.endsWith(join(".claude", "settings.local.json")));
    assert.equal(local!.model, "sonnet");
    assert.deepEqual(setup.plugins, ["notes@local", "search@local"]);
    const counts = setupCounts(setup);
    assert.equal(counts.hooks, 2);
    assert.equal(counts.plugins, 2, "a plugin installed and enabled is counted once");
  });

  test("gathers sorted Markdown files one level deep and counts oversized files once", () => {
    const home = join(root, "files-home");
    const repo = join(root, "files-project");
    const claude = join(home, ".claude");
    put(join(claude, "agents", "zebra.md"), "Review the final diff.");
    put(join(claude, "agents", "alpha.md"), "Ask maya to review.");
    put(join(claude, "agents", "ignore.txt"), "Not an agent.");
    put(join(claude, "agents", "folder.md", "nested.md"), "Not a top-level agent.");
    put(join(claude, "commands", "check.md"), "Run the checks.");
    put(join(claude, "skills", "triage", "SKILL.md"), "Triage the issue.");
    put(join(claude, "skills", "README.md"), "Not a skill directory.");
    put(join(claude, "projects", "work", "memory", "build.md"), "Use the local build.");
    put(join(claude, "projects", "work", "memory", "build.txt"), "Not a memory note.");
    put(join(repo, "AGENTS.md"), "Follow the project guide.");
    put(join(repo, "CLAUDE.local.md"), "x".repeat(512 * 1024 + 1));

    // Both spellings resolve to the same file paths after join().
    const { setup, leftOut } = collectSetup({ home, dirs: [repo, repo + sep], who: ["maya"] });
    assert.deepEqual(
      setup.files.filter(({ kind }) => kind === "agent").map(({ content }) => content),
      ["Ask [you] to review.", "Review the final diff."],
    );
    for (const [kind, content] of [
      ["command", "Run the checks."],
      ["skill", "Triage the issue."],
      ["memory", "Use the local build."],
      ["claude-md", "Follow the project guide."],
    ] as const) {
      assert.deepEqual(setup.files.filter((file) => file.kind === kind).map((file) => file.content), [content]);
    }
    assert.equal(leftOut, 1);
  });
});
