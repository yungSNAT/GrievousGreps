import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { claudeGlobalTargets, installClaudeGlobal } from "../src/hosts/claude-global.js";
import { serverEntry } from "../src/hosts/mcp-config.js";
import { tmpRepo } from "./helpers.js";

const homes: string[] = [];

function scratchHome(tag: string): string {
  const home = tmpRepo(`claude-global-${tag}`);
  homes.push(home);
  return home;
}

function paths(home: string) {
  return {
    shim: join(home, ".claude", "helpers", "graft-hooks.cjs"),
    settings: join(home, ".claude", "settings.json"),
    mcp: join(home, ".claude.json"),
  };
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sessionStartCommands(path: string): string[] {
  const groups: Array<{ hooks: Array<{ command: string }> }> = readJson(path).hooks.SessionStart;
  return groups.flatMap(({ hooks }) => hooks.map(({ command }) => command));
}

function sessionStartInvocation(shim: string): string {
  // Claude's hook command uses forward slashes even on Windows.
  return `"${shim.split(sep).join("/")}" session-start`;
}

before(() => {
  mock.method(globalThis, "fetch", () => {
    throw new Error("Claude global configuration tests must not use the network");
  });
});

after(() => {
  mock.restoreAll();
  for (const home of homes) rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

describe("Claude global install planning", () => {
  test("default graft plan includes a user MCP file; trail plans only the shim and hooks", () => {
    const home = scratchHome("plan");
    const { shim, settings, mcp } = paths(home);
    const plan = claudeGlobalTargets(home);

    assert.deepEqual(
      plan.map(({ id, path, hostId, scope, kind }) => ({ id, path, hostId, scope, kind })),
      [
        { id: "claude-global-shim", path: shim, hostId: "claude", scope: "global", kind: "hook" },
        { id: "claude-global-hooks", path: settings, hostId: "claude", scope: "global", kind: "hook" },
        { id: "claude-global-mcp", path: mcp, hostId: "claude", scope: "global", kind: "mcp" },
      ],
    );
    assert.equal(plan.find(({ kind }) => kind === "mcp")?.what, "mcpServers.graft");
    assert.deepEqual(claudeGlobalTargets(home, "trail"), plan.slice(0, 2));
    assert.equal(existsSync(join(home, ".claude")), false);
    assert.equal(existsSync(mcp), false);
  });
});

describe("Claude global shim and hook installation", () => {
  test("a fresh graft install writes a shim, an absolute SessionStart hook, and a user MCP entry", () => {
    const home = scratchHome("fresh");
    const { shim, settings, mcp } = paths(home);
    const writes = installClaudeGlobal(home);

    assert.deepEqual(writes.slice(0, 2), [
      { id: "claude-global-shim", path: shim, action: "created" },
      { id: "claude-global-hooks", path: settings, action: "created" },
    ]);
    const shimStat = statSync(shim);
    assert.ok(shimStat.isFile() && shimStat.size > 0);
    assert.equal(
      sessionStartCommands(settings).filter((command) => command.includes(sessionStartInvocation(shim))).length,
      1,
    );
    assert.deepEqual(readJson(mcp).mcpServers.graft, serverEntry({ brand: "graft" }));
  });

  test("merges into existing settings and leaves the file byte-for-byte alone on reinstall", () => {
    const home = scratchHome("settings");
    const { shim, settings, mcp } = paths(home);
    const customStart = { hooks: [{ type: "command", command: "custom-session-start" }] };
    const permissions = { allow: ["Bash(npm test)"] };
    mkdirSync(join(home, ".claude"));
    writeFileSync(settings, JSON.stringify({ permissions, hooks: { SessionStart: [customStart] } }));

    const hooksId = "claude-global-hooks";
    assert.deepEqual(installClaudeGlobal(home, "trail").find(({ id }) => id === hooksId), {
      id: hooksId, path: settings, action: "updated",
    });
    const merged = readJson(settings);
    assert.deepEqual(merged.permissions, permissions);
    assert.ok(sessionStartCommands(settings).includes("custom-session-start"));
    assert.equal(
      sessionStartCommands(settings).filter((command) => command.includes(sessionStartInvocation(shim))).length,
      1,
    );
    assert.equal(existsSync(mcp), false, "trail does not create a user MCP file");

    const compact = JSON.stringify(merged);
    writeFileSync(settings, compact);
    assert.deepEqual(installClaudeGlobal(home, "trail").find(({ id }) => id === hooksId), {
      id: hooksId, path: settings, action: "unchanged",
    });
    assert.equal(readFileSync(settings, "utf8"), compact);
  });

  test("malformed settings are not overwritten, but the shim and graft registration still land", () => {
    const home = scratchHome("bad-settings");
    const { shim, settings, mcp } = paths(home);
    const original = "{ not valid JSON\n";
    mkdirSync(join(home, ".claude"));
    writeFileSync(settings, original);

    const hooksId = "claude-global-hooks";
    assert.deepEqual(installClaudeGlobal(home).find(({ id }) => id === hooksId), {
      id: hooksId, path: settings, action: "skipped-unparseable",
    });
    assert.equal(readFileSync(settings, "utf8"), original);
    assert.ok(statSync(shim).isFile());
    assert.deepEqual(readJson(mcp).mcpServers.graft, serverEntry({ brand: "graft" }));
  });

  test("a file blocking the helpers directory prevents hook wiring but not MCP registration", () => {
    const home = scratchHome("blocked-shim");
    const { shim, settings, mcp } = paths(home);
    const blocker = join(home, ".claude", "helpers");
    const original = '{"model":"opus"}\n';
    mkdirSync(join(home, ".claude"));
    writeFileSync(blocker, "not a directory");
    writeFileSync(settings, original);

    const writes = installClaudeGlobal(home);
    assert.deepEqual(writes.map(({ id }) => id), ["claude-global-shim", "claude-global-mcp"]);
    assert.deepEqual(writes[0], { id: "claude-global-shim", path: shim, action: "skipped-unparseable" });
    assert.equal(readFileSync(blocker, "utf8"), "not a directory");
    assert.equal(readFileSync(settings, "utf8"), original);
    assert.deepEqual(readJson(mcp).mcpServers.graft, serverEntry({ brand: "graft" }));
  });
});

describe("Claude user-scope MCP configuration during install", () => {
  test("trail removes the old user-scope trail server without changing graft or project servers", () => {
    const home = scratchHome("legacy-mcp");
    const { mcp } = paths(home);
    const graft = { command: "graft", args: ["mcp"] };
    const trail = { command: "trail", args: ["mcp"] };
    const projects = { [join(home, "project")]: { mcpServers: { trail } } };
    writeFileSync(mcp, JSON.stringify({ mcpServers: { graft, trail }, projects }));

    const mcpId = "claude-global-mcp";
    assert.deepEqual(installClaudeGlobal(home, "trail").find(({ id }) => id === mcpId), {
      id: mcpId, path: mcp, action: "updated",
    });
    const config = readJson(mcp);
    assert.deepEqual(config.mcpServers, { graft });
    assert.deepEqual(config.projects, projects);
  });

  test("trail preserves an existing workspace-only server without rewriting its configuration", () => {
    const home = scratchHome("workspace-mcp");
    const { mcp } = paths(home);
    const original = JSON.stringify({ mcpServers: { trail: { command: "trail", args: ["mcp", "--brains"] } } });
    writeFileSync(mcp, original);

    const mcpId = "claude-global-mcp";
    assert.deepEqual(installClaudeGlobal(home, "trail").find(({ id }) => id === mcpId), {
      id: mcpId, path: mcp, action: "unchanged",
    });
    assert.equal(readFileSync(mcp, "utf8"), original);
  });

  for (const brand of ["graft", "trail"] as const) {
    test(`${brand} leaves malformed MCP configuration intact and still wires SessionStart`, () => {
      const home = scratchHome(`bad-mcp-${brand}`);
      const { mcp, settings, shim } = paths(home);
      const original = "{ unfinished";
      writeFileSync(mcp, original);

      const mcpId = "claude-global-mcp";
      assert.deepEqual(installClaudeGlobal(home, brand).find(({ id }) => id === mcpId), {
        id: mcpId, path: mcp, action: "skipped-unparseable",
      });
      assert.equal(readFileSync(mcp, "utf8"), original);
      assert.ok(sessionStartCommands(settings).some((command) => command.includes(sessionStartInvocation(shim))));
    });
  }
});
