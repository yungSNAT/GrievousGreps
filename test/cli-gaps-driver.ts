/**
 * The real CLI in a fresh process, for the cli-gaps tests. Commander parses on
 * import, so each call gets its own process; what a test can't arrange from
 * outside is set up in the process before `src/cli.ts` loads:
 *
 * - `tty`: which of stdin, stdout and stderr say they are a terminal. Only the
 *   flag: what is read still comes from `input`.
 * - `routes`: Trail's answers, by method and path prefix. Every other request
 *   fails as if offline; nothing reaches the network. Each request is logged to
 *   `fetchLog` (one JSON line each) when it is given.
 * - detached children (upkeep, telemetry flush, background waits, the browser) are never
 *   started; `GG_DETACHED_THROWS` makes starting one fail instead.
 * - `GG_UNREF_SERVERS`: a server the command starts doesn't hold the process open.
 * - `GG_PLATFORM`: the `process.platform` the code sees.
 * - `GG_CLOCK_STEP_MS`: every `Date.now()` is that much later than the one before, so a
 *   wait with a deadline ends at its first check.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const entry = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const testDir = fileURLToPath(new URL(".", import.meta.url));
// By URL, so a command run from a folder outside the package still loads it.
const tsx = import.meta.resolve("tsx");

export interface Route {
  /** `METHOD /path/prefix` */
  on: string;
  status: number;
  body?: unknown;
}

const driver = `
  import { appendFileSync } from "node:fs";
  import { mock } from "node:test";
  import childProcess from "node:child_process";
  import { syncBuiltinESMExports } from "node:module";

  const argv = process.argv;
  process.argv = [process.execPath, ${JSON.stringify(entry)}, ...argv.slice(1)];

  // The platform the code sees, for the branches that pick a command by it. Nothing is run for real.
  if (process.env.GG_PLATFORM) Object.defineProperty(process, "platform", { value: process.env.GG_PLATFORM, configurable: true });

  for (const s of (process.env.GG_TTY ?? "").split(",").filter(Boolean)) {
    Object.defineProperty(process[s], "isTTY", { value: true, configurable: true });
  }

  // Each read of the clock moves it on by this much: a wait with a deadline ends on its first check.
  if (process.env.GG_CLOCK_STEP_MS) {
    let t = Date.now();
    const step = Number(process.env.GG_CLOCK_STEP_MS);
    Date.now = () => (t += step);
  }

  const routes = JSON.parse(process.env.GG_ROUTES ?? "[]");
  mock.method(globalThis, "fetch", async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    if (process.env.GG_FETCH_LOG) {
      appendFileSync(process.env.GG_FETCH_LOG, JSON.stringify({ method, path: u.pathname + u.search, body: init.body ? JSON.parse(init.body) : null }) + "\\n");
    }
    const hit = routes.find((r) => (method + " " + u.pathname + u.search).startsWith(r.on));
    if (!hit) throw new Error("offline in cli-gaps");
    return new Response(hit.body === undefined ? "" : JSON.stringify(hit.body), { status: hit.status });
  });

  const spawn = childProcess.spawn;
  mock.method(childProcess, "spawn", (file, args, options) => {
    if ((Array.isArray(args) ? options : args)?.detached) {
      if (process.env.GG_DETACHED_THROWS) throw new Error("no opener in cli-gaps");
      return new childProcess.ChildProcess();
    }
    return spawn(file, args, options);
  });
  syncBuiltinESMExports();

  // A server the command starts doesn't keep the process alive: it exits once the command is done.
  if (process.env.GG_UNREF_SERVERS) {
    const net = await import("node:net");
    const listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (...a) {
      const r = listen.apply(this, a);
      this.unref();
      return r;
    };
    const fs = (await import("node:fs")).default;
    const watch = fs.watch;
    mock.method(fs, "watch", (...a) => watch(...a).unref());
    syncBuiltinESMExports();
  }

  // Commander assumes exit never returns.
  const exit = process.exit.bind(process);
  mock.method(process, "exit", (code) => exit(code));
  process.once("exit", () => {
    process.argv = argv;
    mock.restoreAll();
    syncBuiltinESMExports();
  });

  await import(${JSON.stringify(pathToFileURL(entry).href)});
`;

export interface CliOptions {
  home: string;
  cwd?: string;
  input?: string;
  tty?: Array<"stdin" | "stdout" | "stderr">;
  routes?: Route[];
  fetchLog?: string;
  trail?: boolean;
  env?: Record<string, string | undefined>;
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  detail: string;
}

/** The caller's environment without the switches this code reads: an agent session's or a developer's own. */
function baseEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX_|AI_AGENT$|GRAFT_|TRAIL_|GG_)/.test(k)));
}

/** Offline, isolated environment: every home the code looks in points at `home`. */
export function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv(),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    TRAIL_HOME: join(home, ".trail"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    CI: "1",
    DO_NOT_TRACK: "1",
    NO_COLOR: "1",
    GRAFT_NO_BROWSER: "1",
    GRAFT_NO_TRAIL_SWITCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    TRAIL_NO_FETCH: "1",
    npm_config_offline: "true",
    npm_config_cache: join(home, "npm-cache"),
    CLAUDECODE: undefined,
    TRAIL_INVOKED_AS: undefined,
    TRAIL_CLOUD: undefined,
    TRAIL_TEST_SERVER: undefined,
    GRAFT_API_KEY: undefined,
    GRAFT_NO_GITIGNORE: undefined,
    GRAFT_NO_IGNORE: undefined,
    OPENROUTER_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
  };
}

export function runCli(args: string[], o: CliOptions): CliResult {
  const env: NodeJS.ProcessEnv = { ...isolatedEnv(o.home), ...o.env };
  if (o.trail) env.TRAIL_INVOKED_AS = "trail";
  if (o.tty?.length) env.GG_TTY = o.tty.join(",");
  if (o.routes) env.GG_ROUTES = JSON.stringify(o.routes);
  if (o.fetchLog) env.GG_FETCH_LOG = o.fetchLog;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync(process.execPath, ["--import", tsx, "--input-type=module", "--eval", driver, "--", ...args], {
    cwd: o.cwd ?? testDir,
    encoding: "utf8",
    input: o.input ?? "",
    timeout: 90_000,
    windowsHide: true,
    env,
  });
  assert.ifError(r.error);
  assert.equal(r.signal, null);
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    detail: `${JSON.stringify(args)}\nstatus: ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
  };
}
