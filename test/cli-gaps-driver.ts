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
 *   started; `GG_DETACHED_THROWS` makes starting one fail instead, and `GG_SPAWN_LOG` names a
 *   file that gets each one's program and arguments (one JSON line each).
 * - `GG_UNREF_SERVERS`: a server the command starts doesn't hold the process open.
 * - `answers`: what a person types at each prompt, in order.
 * - `GG_PLATFORM`: the `process.platform` the code sees.
 * - `GG_CLOCK_STEP_MS`: every `Date.now()` is that much later than the one before, so a
 *   wait with a deadline ends at its first check.
 */
import { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpRepo } from "./helpers.js";

const entry = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
// By URL, so a command run from a folder outside the package still loads it.
const tsx = import.meta.resolve("tsx");

export interface Route {
  /** `METHOD /path/prefix` */
  on: string;
  /** Only for requests to this host (`trail.test`); any host when left out. */
  host?: string;
  status: number;
  /** No answer: the request times out. */
  timeout?: boolean;
  body?: unknown;
}

const driver = `
  import { appendFileSync } from "node:fs";
  import { mock } from "node:test";
  import childProcess from "node:child_process";
  import { syncBuiltinESMExports } from "node:module";

  const argv = process.argv;
  process.argv = [process.execPath, ${JSON.stringify(entry)}, ...argv.slice(2)];

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
      appendFileSync(process.env.GG_FETCH_LOG, JSON.stringify({ method, host: u.host, path: u.pathname + u.search, body: init.body ? JSON.parse(init.body) : null }) + "\\n");
    }
    const hit = routes.find((r) => (!r.host || r.host === u.host) && (method + " " + u.pathname + u.search).startsWith(r.on));
    if (!hit) throw new Error("offline in cli-gaps");
    if (hit.timeout) throw new DOMException("no answer in cli-gaps", "TimeoutError");
    return new Response(hit.body === undefined ? "" : JSON.stringify(hit.body), { status: hit.status });
  });

  // A person at the terminal answering each question in turn. Piped input can't do it: the
  // first prompt's reader takes every line, so the next prompt finds the input closed.
  if (process.env.GG_ANSWERS) {
    const answers = JSON.parse(process.env.GG_ANSWERS);
    const { EventEmitter } = await import("node:events");
    const readline = (await import("node:readline")).default;
    mock.method(readline, "createInterface", () => {
      const rl = new EventEmitter();
      rl.close = () => rl.emit("close");
      rl.question = (q, cb) => {
        process.stderr.write(q);
        setImmediate(() => (answers.length ? cb(answers.shift()) : rl.close()));
      };
      return rl;
    });
  }

  const spawn = childProcess.spawn;
  mock.method(childProcess, "spawn", (file, args, options) => {
    if ((Array.isArray(args) ? options : args)?.detached) {
      if (process.env.GG_SPAWN_LOG) appendFileSync(process.env.GG_SPAWN_LOG, JSON.stringify({ file, args: Array.isArray(args) ? args : [] }) + "\\n");
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
  /** Where the command runs; `home` when left out, never this checkout. */
  cwd?: string;
  input?: string;
  tty?: Array<"stdin" | "stdout" | "stderr">;
  routes?: Route[];
  fetchLog?: string;
  /** What a person types at each prompt, in order; after the last, the input closes. */
  answers?: string[];
  trail?: boolean;
  env?: Record<string, string | undefined>;
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  detail: string;
}

/**
 * The caller's environment without the switches this code reads (an agent session's or a
 * developer's own) and without the git variables that name a repository, which a git hook
 * running the suite sets and which would point every fixture's git at that checkout.
 */
function baseEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(CLAUDE|CODEX_|AI_AGENT$|GRAFT_|TRAIL_|GG_|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|NAMESPACE|PREFIX)$)/i.test(k),
    ),
  );
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

let scratch: string | undefined;
/**
 * This file's own folder, made once: the driver as a file (a worker or a child the
 * command starts inherits node's own flags, and `--eval` with `--input-type` would
 * break it) and an empty home for the tests' own git commands.
 */
function scratchDir(): string {
  if (scratch) return scratch;
  const dir = mkdtempSync(join(tmpdir(), "graft-cli-gaps-driver-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "driver.mjs"), driver);
  mkdirSync(join(dir, "home"));
  return (scratch = dir);
}

/** For a test's own git commands: the environment the CLI's git sees, so the developer's git config never applies. */
export function gitEnv(): NodeJS.ProcessEnv {
  return isolatedEnv(join(scratchDir(), "home"));
}

export function runCli(args: string[], o: CliOptions): CliResult {
  const env: NodeJS.ProcessEnv = { ...isolatedEnv(o.home), ...o.env };
  if (o.trail) env.TRAIL_INVOKED_AS = "trail";
  if (o.tty?.length) env.GG_TTY = o.tty.join(",");
  if (o.routes) env.GG_ROUTES = JSON.stringify(o.routes);
  if (o.fetchLog) env.GG_FETCH_LOG = o.fetchLog;
  if (o.answers) env.GG_ANSWERS = JSON.stringify(o.answers);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync(process.execPath, ["--import", tsx, join(scratchDir(), "driver.mjs"), ...args], {
    cwd: o.cwd ?? o.home,
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

/* The cli-gaps files' shared fixtures. */

/** Scratch folders for one test file, named after `prefix` and removed once its tests are done. */
export function scratchFolders(prefix: string): (tag: string) => string {
  const made: string[] = [];
  after(() => {
    for (const dir of made.reverse()) rmSync(dir, { recursive: true, force: true });
  });
  return (tag) => {
    const dir = tmpRepo(`${prefix}-${tag}`);
    made.push(dir);
    return dir;
  };
}

/** git in `cwd`, as the CLI's git sees it: its output, or a failed assertion naming the command. */
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, env: gitEnv() }); // NOSONAR: test fixture; runs the git on PATH on purpose
  assert.equal(r.status, 0, `git ${args.join(" ")}\n${r.stderr}`);
  return r.stdout;
}

/** A git repo in `dir` with one commit, of `src/<file>`, by `author`, with `origin` at `remote` when given. */
export function fixtureRepo(dir: string, o: { author: [name: string, email: string]; file: string; code: string; message: string; remote?: string }): string {
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", o.author[0]);
  git(dir, "config", "user.email", o.author[1]);
  if (o.remote) git(dir, "remote", "add", "origin", o.remote);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", o.file), o.code);
  git(dir, "add", "-A");
  git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", o.message);
  return dir;
}

/** Two independent repos, alpha and beta, in `root`: a workspace parent. */
export function workspaceRoot(root: string): string {
  for (const name of ["alpha", "beta"]) {
    mkdirSync(join(root, name, ".git"), { recursive: true });
    writeFileSync(join(root, name, "main.ts"), `export function ${name}(): number {\n  return 1;\n}\n`);
  }
  return root;
}

/** The stand-in Trail the routes answer for. */
export const SERVER = "http://trail.test";

/** Not real credentials, made at run time: any non-empty string is one to the CLI. */
export const fixtureToken = (slug: string): string => ["fixture", slug, process.pid].join("-");
export const fixtureSecret = ["fixture", "secret", "part", "one"].join("");

export function workspace(slug: string, name: string, url = SERVER) {
  return { id: `ws-${slug}`, name, slug, url: `${url}/w/${slug}`, invite_url: `${url}/join/${slug}` };
}

/** A saved connection to workspace `slug`, at SERVER unless `extra.url` says otherwise. */
export function cloud(slug: string, name: string, repos: string[], extra: { url?: string; via?: string } = {}) {
  const url = extra.url ?? SERVER;
  return { url, token: fixtureToken(slug), user: { name: "Ada", email: "ada@example.invalid" }, workspace: workspace(slug, name, url), repos, linkedAt: 1_700_000_000_000, ...extra };
}

/** `home`, connected to these workspaces, newest first. */
export function connectHome(home: string, clouds: Array<ReturnType<typeof cloud>>): string {
  if (clouds.length) {
    mkdirSync(join(home, ".trail"), { recursive: true });
    const [first, ...others] = clouds.map((c, i) => ({ ...c, linkedAt: c.linkedAt - i }));
    writeFileSync(join(home, ".trail", "cloud.json"), JSON.stringify(others.length ? { ...first, others } : first));
  }
  return home;
}
