/**
 * Child processes, for every module: import spawn, spawnSync, execFileSync and fork from here,
 * never from node:child_process (test/program.test.ts holds the source to that).
 *
 * Trail runs inside checkouts other people wrote. Given a bare name such as `git`, Node on
 * Windows looks in the working folder before PATH (libuv's search_path tries `git.com` and
 * `git.exe` there first), and a relative PATH entry such as `.` does the same on any system, so
 * the checkout's own git.exe would run in place of the person's git. Here a bare name is looked
 * up in PATH's absolute folders only and the program is started by its absolute path.
 */
import * as cp from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export { fork } from "node:child_process";

export interface FindOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Also a `.cmd` on Windows, for a caller that runs it through cmd.exe or unwraps npm's shim. */
  cmd?: boolean;
  isFile?: (path: string) => boolean;
}

/** A variable from `env`. On Windows a copied environment keeps the system's spelling (`Path`),
 * and of 2 spellings Node gives the child the first in sort order (`PATH` before `Path`). */
function envValue(env: NodeJS.ProcessEnv, name: string, win: boolean): string | undefined {
  if (!win) return env[name];
  const key = Object.keys(env).filter((k) => k.toUpperCase() === name).sort()[0];
  return key === undefined ? undefined : env[key];
}

function runnable(path: string, win: boolean): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (!win) accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The absolute path of program `name`: the first match in PATH's folders, or null. Empty and
 * relative entries (`.`, `bin`, `C:tools`) are skipped, so the working folder is never searched.
 * On Windows each folder is tried with PATHEXT's endings in its order (`.COM;.EXE;.BAT;.CMD` when
 * unset), keeping those Node can start without a shell: `.com` and `.exe`, and `.cmd` when `cmd`
 * is set. A `git.cmd` is passed over, as Node itself passes it over, so a `git.exe` later on PATH
 * is still found. With no PATH at all, POSIX looks in /usr/bin and /bin, as libuv does.
 */
export function findProgram(name: string, opts: FindOptions = {}): string | null {
  const win = (opts.platform ?? process.platform) === "win32";
  const env = opts.env ?? process.env;
  const isFile = opts.isFile ?? ((p: string) => runnable(p, win));
  const keep = [".com", ".exe", ...(opts.cmd ? [".cmd"] : [])];
  const endings = win
    ? (envValue(env, "PATHEXT", true) || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim().toLowerCase()).filter((e) => keep.includes(e))
    : [""];
  const path = envValue(env, "PATH", win) ?? (win ? "" : "/usr/bin:/bin");
  for (const entry of path.split(win ? ";" : ":")) {
    const dir = win ? entry.trim().replace(/^"(.*)"$/, "$1") : entry;
    if (win ? !/^([a-zA-Z]:[\\/]|\\\\)/.test(dir) : !dir.startsWith("/")) continue;
    for (const ending of endings) {
      const file = (win ? win32 : posix).join(dir, name + ending);
      if (isFile(file)) return file;
    }
  }
  return null;
}

/** What to start: a bare name's absolute path, or an Error when PATH has none. A path, or a
 * command line for a shell, is the caller's own choice and passes through. */
function program(file: string, rest: unknown[]): string | Error {
  const options = (Array.isArray(rest[0]) ? rest[1] : rest[0]) as cp.SpawnOptions | undefined;
  if (options?.shell || file.includes("/") || (process.platform === "win32" && file.includes("\\"))) return file;
  return findProgram(file, { env: options?.env }) ?? Object.assign(new Error(`${file} was not found on PATH`), { code: "ENOENT", path: file });
}

/** child_process.spawnSync. A program not on PATH gives `error` (code ENOENT) and a null status, as Node does. */
export const spawnSync = ((file: string, ...rest: unknown[]) => {
  const found = program(file, rest);
  if (found instanceof Error) return { pid: 0, output: null, status: null, signal: null, error: found };
  return (cp.spawnSync as (...args: unknown[]) => unknown)(found, ...rest);
}) as typeof cp.spawnSync;

/** child_process.execFileSync. A program not on PATH throws (code ENOENT), as Node does. */
export const execFileSync = ((file: string, ...rest: unknown[]) => {
  const found = program(file, rest);
  if (found instanceof Error) throw found;
  return (cp.execFileSync as (...args: unknown[]) => unknown)(found, ...rest);
}) as typeof cp.execFileSync;

/** child_process.spawn. A program not on PATH throws at once (code ENOENT), where Node would emit 'error' later. */
export const spawn = ((file: string, ...rest: unknown[]) => {
  const found = program(file, rest);
  if (found instanceof Error) throw found;
  return (cp.spawn as (...args: unknown[]) => unknown)(found, ...rest);
}) as typeof cp.spawn;
