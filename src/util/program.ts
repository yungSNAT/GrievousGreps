/**
 * Child processes, for every module: import spawn, spawnSync, execFileSync and fork from here,
 * never from node:child_process (test/program.test.ts holds the source to that).
 *
 * Trail runs inside checkouts other people wrote. Given a bare name such as `git`, Node on
 * Windows looks in the working folder before PATH (libuv's search_path tries `git.com` and
 * `git.exe` there first), and a relative PATH entry such as `.` does the same on any system, so
 * the checkout's own git.exe would run in place of the person's git. A package runner (npx, a
 * package script, Yarn) also puts folders first on PATH that the tree it runs in fills: the
 * node_modules/.bin of the working folder and of each folder above it, and Yarn's own bin folder.
 * Here a bare name is looked up only in PATH's absolute folders that are none of these, and the
 * program is started by its absolute path.
 */
import * as cp from "node:child_process";
import { accessSync, constants, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export { fork } from "node:child_process";

export interface FindOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Also a `.cmd` on Windows, for a caller that runs it through cmd.exe or unwraps npm's shim. */
  cmd?: boolean;
  /** The child's working folder, when not this process's; this process's always counts too. */
  cwd?: string;
  isFile?: (path: string) => boolean;
  /** A path's real path, or null when it does not exist. */
  realpath?: (path: string) => string | null;
  /** The folders the system passes through to reach a file (see linkFolders), or null. */
  folders?: (file: string) => string[] | null;
  /** A folder's identity, its volume and file number as `dev:ino`, or null when it has none to read. */
  identity?: (path: string) => string | null;
}

export interface Located {
  /** The program to start, or null. */
  path: string | null;
  /** The first match found in a folder passed over (see locateProgram), for a caller to name. */
  skipped: string | null;
}

/** The message for a program PATH has nowhere trail starts programs from. */
export const notFound = (name: string) => `${name} was not found on PATH outside the working folder and its subfolders`;

/** The message for a program named by a path that is relative or in a folder locateProgram passes over. */
export const refused = (path: string) => `${path} was not started: trail starts programs only by an absolute path outside the working folder and its subfolders`;

/** A variable from `env`. On Windows a copied environment keeps the system's spelling (`Path`),
 * and of 2 spellings Node gives the child the first in sort order (`PATH` before `Path`). */
function envValue(env: NodeJS.ProcessEnv, name: string, win: boolean): string | undefined {
  if (!win) return env[name];
  const key = Object.keys(env).filter((k) => k.toUpperCase() === name).sort((a, b) => Number(a > b) - Number(a < b))[0];
  return key === undefined ? undefined : env[key];
}

/** An absolute path, with its drive or share on Windows (the child would take `\x` on its own folder's drive). */
const absolute = (path: string, win: boolean) => (win ? /^([a-zA-Z]:[\\/]|\\\\)/.test(path) : path.startsWith("/"));

function realPath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function identity(path: string): string | null {
  try {
    const s = statSync(path, { bigint: true });
    return s.ino === 0n ? null : `${s.dev}:${s.ino}`;
  } catch {
    return null;
  }
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
 * The folders the system passes through to reach `file`: where each link on the way stands (the
 * link itself when it stands for a folder, the folder holding it when it stands for the file) and
 * the real folder at the end; null when the path does not resolve. A `..` steps back from the
 * folder reached so far, as POSIX takes it; Windows removes `..` from the path as written, and from
 * a link's target put in its place, before it follows any link.
 */
function linkFolders(p: typeof posix, file: string): string[] | null {
  const win = p === win32;
  const split = (path: string) => path.split(win ? /[\\/]+/ : /\/+/).filter((part) => part !== "" && part !== ".");
  // Windows keeps `..` in a `\\?\` path, which resolve() removes. Node's fs calls (the lstat below,
  // realpath in allows) remove it in the same way first, so the trace and the real path agree; that
  // the system then opens such a path as resolved or not at all, NTFS having no `..` entry, is untested.
  if (win) file = p.resolve(file);
  let at = p.parse(file).root;
  let todo = split(file.slice(at.length));
  const found: string[] = [];
  for (let links = 0; todo.length > 0; ) {
    const part = todo.shift()!;
    if (part === "..") {
      at = p.dirname(at);
      continue;
    }
    const next = p.join(at, part);
    let target: string;
    try {
      if (!lstatSync(next).isSymbolicLink()) {
        at = next;
        continue;
      }
      target = readlinkSync(next);
    } catch {
      return null;
    }
    if (++links > 40) return null;
    found.push(todo.length > 0 ? next : at);
    if (win) {
      const rest = p.resolve(at, target, ...todo);
      at = p.parse(rest).root;
      todo = split(rest.slice(at.length));
      continue;
    }
    const root = p.parse(target).root;
    if (root) at = root;
    todo = [...split(target.slice(root.length)), ...todo];
  }
  return [...found, p.dirname(at)];
}

/** The rules locateProgram applies: which folders trail starts no program from. */
function rules(opts: FindOptions) {
  const win = (opts.platform ?? process.platform) === "win32";
  const p = win ? win32 : posix;
  const env = opts.env ?? process.env;
  const real = opts.realpath ?? realPath;
  const fold = (path: string) => (win ? path.toLowerCase() : path);
  // Each folder both as given and as its real path.
  const bothWays = (dir: string) => [p.resolve(dir), real(dir)].filter((d): d is string => d !== null).map(fold);
  const home = new Set(bothWays(homedir()));
  const work = [process.cwd(), opts.cwd].filter((d): d is string => d !== undefined);
  const trees = work.flatMap(bothWays);
  // A filesystem root or the home folder holds every folder the person installs to: only the folder itself is passed over.
  const holdsAll = (tree: string) => p.dirname(tree) === tree || home.has(tree);
  // The working folders also by identity: a share (\\localhost\C$\...) or a bind mount names a
  // folder its path does not show, and its real path keeps that spelling. Each identity maps to
  // whether it holds all; also kept are the volumes they are on and the roots they stand on.
  const known = new Map<string, string | null>();
  const id = (path: string) => {
    if (!known.has(path)) known.set(path, (opts.identity ?? identity)(path));
    return known.get(path)!;
  };
  const volume = (key: string) => key.slice(0, key.indexOf(":"));
  const homeId = id(homedir());
  const treeIds = new Map<string, boolean>();
  const volumes = new Set<string>();
  const roots = new Set<string>();
  // A working folder of no identity (stat failed, or no file number) could be any share: then no share is used.
  let unknown = false;
  for (const dir of work) {
    const key = id(p.resolve(dir));
    if (key === null) {
      unknown = true;
      continue;
    }
    const root = id(p.parse(real(dir) ?? p.resolve(dir)).root);
    treeIds.set(key, key === homeId || key === root);
    volumes.add(volume(key));
    if (root !== null) roots.add(root);
  }
  /** Whether folder `dir`, however spelled, is a working folder or under one by identity. A share's
   * path stops at the share, which can stand inside a working folder, so a share on a working
   * folder's volume that is not the root one stands on is passed over too. */
  const underById = (dir: string) => {
    if (volumes.size === 0 && !unknown) return false;
    for (let at = p.resolve(dir), self = true; ; self = false) {
      const key = id(at);
      if (key !== null && treeIds.has(key) && (self || !treeIds.get(key))) return true;
      const up = p.dirname(at);
      if (up === at) return win && at.startsWith(p.sep + p.sep) && (unknown || key === null || (volumes.has(volume(key)) && !roots.has(key)));
      at = up;
    }
  };
  const berry = envValue(env, "BERRY_BIN_FOLDER", win);
  const yarnBin = berry && p.isAbsolute(berry) ? bothWays(berry) : [];
  const inTree = (dir: string) => trees.some((tree) => {
    const rel = p.relative(tree, dir);
    return rel === "" || (!holdsAll(tree) && !(rel === ".." || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel)));
  });
  const packageBin = (dir: string) => p.basename(dir) === ".bin" && p.basename(p.dirname(dir)) === "node_modules";
  const passedOver = (dir: string) => {
    const d = fold(dir);
    return packageBin(d) || yarnBin.includes(d) || inTree(d) || underById(dir);
  };
  /** Whether the file at absolute path `file`, reached as written, may start: none of the folders
   * it is named from (`entry`) is passed over, and no folder on the way to it is a working folder's.
   * The node_modules/.bin and Yarn tests stay on the folders named, as a package runner names them
   * (Yarn classic's global bin links through a node_modules/.bin of its own). */
  const allows = (file: string, entry: string[]) => {
    const traced = (opts.folders ?? ((f: string) => linkFolders(p, f)))(file);
    const realFile = real(file);
    if (traced === null || realFile === null || entry.some(passedOver)) return false;
    // Each link also where it really stands (its folder's real path), so `\\?\` and 8.3 spellings match the working folder.
    const stands = traced.map((d) => {
      const parent = real(p.dirname(d));
      return parent === null ? d : p.join(parent, p.basename(d));
    });
    return ![p.dirname(realFile), ...traced, ...stands].some((d) => inTree(fold(d)) || underById(d));
  };
  return { win, p, env, real, allows };
}

/**
 * Program `name`: the first match in PATH's folders that trail starts programs from, and the
 * first match it passed over. Empty and relative entries (`.`, `bin`, `C:tools`) are never looked
 * in, so the working folder is never searched. An entry is passed over when it is a working folder
 * (this process's or `cwd`) or is under one, is a node_modules/.bin folder, or is the folder Yarn
 * names in BERRY_BIN_FOLDER. A filesystem root or the home folder as the working folder passes
 * over only itself, as every folder the person installs to is under one of them. Each test is
 * made on the entry as listed (made absolute) and on its real path; the working-folder test is
 * also made on where each link on the way to the program stands (a link to the program file
 * included), as traced and in its folder's real path, and on the program's real folder, with each working folder taken both ways too, so a
 * link in either direction does not bring a tree's folder back; letter case is ignored on Windows.
 * Each of those folders is also tested by identity (volume and file number): one that is a working
 * folder, or has one above it, is passed over however its path spells it, as a share
 * (`\\localhost\C$\...`) or a bind mount does; a share whose root is on a working folder's volume,
 * and is not the root a working folder stands on, is passed over too, as its path cannot show where
 * it stands, and so is every share when a working folder has no identity to read. A drive letter mapped to a share or made with subst is judged by its real path, which
 * is the share's or the folder's. A bind mount of a folder inside a working folder is not seen: only
 * the mount table shows where it stands. On Windows each folder is tried with PATHEXT's endings in its order (`.COM;.EXE;.BAT;.CMD` when
 * unset), keeping those Node can start without a shell: `.com` and `.exe`, and `.cmd` when `cmd`
 * is set; a name already ending in one of those (`cmd.exe`) is tried as it is. A `git.cmd` is
 * passed over, as Node itself passes it over, so a `git.exe` later on PATH is still found. With no
 * PATH at all, POSIX looks in /usr/bin and /bin, as libuv does.
 */
export function locateProgram(name: string, opts: FindOptions = {}): Located {
  const { win, p, env, real, allows } = rules(opts);
  const isFile = opts.isFile ?? ((file: string) => runnable(file, win));
  const keep = [".com", ".exe", ...(opts.cmd ? [".cmd"] : [])];
  const endings = !win || keep.some((e) => name.toLowerCase().endsWith(e))
    ? [""]
    : (envValue(env, "PATHEXT", true) || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim().toLowerCase()).filter((e) => keep.includes(e));

  const path = envValue(env, "PATH", win) ?? (win ? "" : "/usr/bin:/bin");
  let skipped: string | null = null;
  for (const entry of path.split(win ? ";" : ":")) {
    const listed = win ? entry.trim().replace(/^"(.*)"$/, "$1") : entry;
    if (!absolute(listed, win)) continue;
    // The real folder first: on POSIX `link/..` is the link target's parent, not the folder written before it.
    const dir = real(listed);
    if (dir === null) continue;
    for (const ending of endings) {
      const file = p.join(dir, name + ending);
      if (!isFile(file)) continue;
      // As written, so the links on the way are seen (Windows drops `..` first; POSIX takes it as it comes).
      const written = win ? p.join(listed, name + ending) : `${listed}/${name}${ending}`;
      if (allows(written, [p.resolve(listed), dir, p.dirname(p.resolve(written))])) return { path: file, skipped };
      skipped ??= file;
    }
  }
  return { path: null, skipped };
}

/** The absolute path of program `name` (see locateProgram), or null. */
export const findProgram = (name: string, opts: FindOptions = {}): string | null => locateProgram(name, opts).path;

/** Whether `file` is an absolute path that keeps to locateProgram's rules, links followed. */
export function admitted(file: string, opts: FindOptions = {}): boolean {
  const { win, p, real, allows } = rules(opts);
  const dir = p.dirname(p.resolve(file));
  return absolute(file, win) && allows(file, [dir, real(dir) ?? dir]);
}

const isBare = (name: string) => !name.includes("/") && !(process.platform === "win32" && name.includes("\\"));

const missing = (message: string, path: string) => Object.assign(new Error(message), { code: "ENOENT", path });

/** The arguments for child_process, with a bare program name replaced by its absolute path, or an
 * Error when PATH has none. An absolute path is the caller's own choice and passes through; a
 * relative one, which the system takes from the working folder, is refused. With a shell, the
 * command line is the caller's and the shell is what gets looked up, as Node would start it
 * (ComSpec, else a bare `cmd.exe`, on Windows): by name from PATH, or by an absolute path that
 * keeps to the same rules. */
function program(file: string, rest: unknown[]): unknown[] | Error {
  const at = Array.isArray(rest[0]) || rest[0] == null ? 1 : 0; // spawn(file, args?, options?), as Node reads it
  const options = rest[at] as cp.SpawnOptions | undefined;
  const cwd = options?.cwd instanceof URL ? fileURLToPath(options.cwd) : options?.cwd;
  const find = { env: options?.env, cwd };
  if (!options?.shell) {
    if (!isBare(file)) return absolute(file, process.platform === "win32") ? [file, ...rest] : missing(refused(file), file);
    const found = findProgram(file, find);
    return found === null ? missing(notFound(file), file) : [found, ...rest];
  }
  const named = typeof options.shell === "string" ? options.shell : process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const shell = isBare(named) ? findProgram(named, find) : admitted(named, find) ? named : null;
  if (shell === null) return missing(isBare(named) ? notFound(named) : refused(named), named);
  const args = [...rest];
  args[at] = { ...options, shell };
  return [file, ...args];
}

/** child_process.spawnSync. A program not on PATH gives `error` (code ENOENT) and a null status, as Node does. */
export const spawnSync = ((file: string, ...rest: unknown[]) => {
  const call = program(file, rest);
  if (call instanceof Error) return { pid: 0, output: null, status: null, signal: null, error: call };
  return (cp.spawnSync as (...args: unknown[]) => unknown)(...call);
}) as typeof cp.spawnSync;

/** child_process.execFileSync. A program not on PATH throws (code ENOENT), as Node does. */
export const execFileSync = ((file: string, ...rest: unknown[]) => {
  const call = program(file, rest);
  if (call instanceof Error) throw call;
  return (cp.execFileSync as (...args: unknown[]) => unknown)(...call);
}) as typeof cp.execFileSync;

/** child_process.spawn. A program not on PATH throws at once (code ENOENT), where Node would emit 'error' later. */
export const spawn = ((file: string, ...rest: unknown[]) => {
  const call = program(file, rest);
  if (call instanceof Error) throw call;
  return (cp.spawn as (...args: unknown[]) => unknown)(...call);
}) as typeof cp.spawn;
