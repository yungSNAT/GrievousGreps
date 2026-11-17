/**
 * `graft version` / `graft --version` support, and the refusal `graft upgrade` prints.
 *
 * Split out of cli.ts so the formatting helpers can be unit-tested with
 * injected results instead of hitting the network from tests.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { admitted, findProgram, notFound, refused, spawnSync } from "./util/program.js";
import type { SpawnSyncOptions } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brand, PACKAGE_FOR } from "./brand.js";

/** Locates package.json relative to a module URL (works for both `dist/cli.js`
 * running one level under the published package root, and `src/cli.ts` running
 * one level under the repo root via tsx). */
export function resolvePackageJsonPath(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const candidates = [resolve(moduleDir, "..", "package.json"), resolve(moduleDir, "package.json")];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

/**
 * The npm package this code was installed as. Update checks go to the package
 * actually installed, not to the name typed.
 */
export function readPackageName(moduleUrl: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolvePackageJsonPath(moduleUrl), "utf8")) as { name?: string };
    return pkg.name ?? PACKAGE_FOR.graft;
  } catch {
    return PACKAGE_FOR.graft;
  }
}

const PKG_NAME = readPackageName(import.meta.url);

/** Reads the version of the graft package this module was loaded from. */
export function readCurrentVersion(moduleUrl: string): string {
  const raw = readFileSync(resolvePackageJsonPath(moduleUrl), "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
}

/**
 * The version as `--version` prints it, with the commit the build came from as
 * SemVer build metadata (`0.28.0+gg.eaa839317b75`) when `npm run build` recorded
 * one (scripts/stamp-commit.mjs). The stamp counts only for the build that wrote
 * it: not when running from src, and not once a later `tsc` or `npm run dev` has
 * rewritten the running module after it.
 */
export function versionLine(moduleUrl: string): string {
  const version = readCurrentVersion(moduleUrl);
  try {
    const module = fileURLToPath(moduleUrl);
    const dist = resolve(dirname(resolvePackageJsonPath(moduleUrl)), "dist");
    if (!module.startsWith(dist + sep)) return version;
    const stamp = join(dist, "build-commit.txt");
    if (statSync(module).mtimeMs > statSync(stamp).mtimeMs) return version;
    const commit = readFileSync(stamp, "utf8").trim();
    if (!/^[0-9a-f]{7,40}(-dirty)?$/.test(commit)) return version;
    return `${version}${version.includes("+") ? "." : "+"}${commit}`;
  } catch {
    return version;
  }
}

/** Runs `npm <args>` by npm's absolute path from PATH (util/program.ts); throws when there is none.
 * On Windows `npm` is the `npm.cmd` shim, which Node can start only through cmd.exe, where `%NAME%`
 * in its path would expand and the shim's fallback to a bare `node` would be looked for in the
 * working folder first. So trail makes the shim's own choice without a shell, for the layout
 * Node's installer, nvm-windows and `npm i -g npm` make: Node is the node.exe beside the shim, else
 * `node` from PATH, and npm is node_modules/npm/bin/npm-cli.js under the global prefix the shim's
 * npm-prefix.js prints, when that file exists, else the one beside the shim. Each must keep to
 * util/program.ts's rules, or nothing runs. A `.cmd` with no npm-cli.js beside it, such as mise's
 * shims, which hand on to another program through cmd.exe, is not run. */
function npmSync(args: readonly string[], options: SpawnSyncOptions) {
  const npm = findProgram("npm", { cmd: true });
  if (!npm) throw new Error(notFound("npm"));
  if (!npm.toLowerCase().endsWith(".cmd")) return spawnSync(npm, args, { ...options, windowsHide: true });
  const bin = (prefix: string) => join(prefix, "node_modules", "npm", "bin");
  const beside = join(dirname(npm), "node.exe");
  const node = existsSync(beside) ? beside : findProgram("node");
  if (!node) throw new Error(notFound("node"));
  const run = (script: string, more: readonly string[], opts: SpawnSyncOptions) => {
    for (const file of [node, script]) if (!admitted(file)) throw new Error(refused(file));
    return spawnSync(node, [script, ...more], { ...opts, windowsHide: true });
  };
  let cli = join(bin(dirname(npm)), "npm-cli.js");
  const prefixScript = join(bin(dirname(npm)), "npm-prefix.js");
  if (existsSync(prefixScript)) {
    const prefix = run(prefixScript, [], { ...options, encoding: "utf8" }).stdout?.toString().trim().split(/\r?\n/).pop();
    if (prefix && existsSync(join(bin(prefix), "npm-cli.js"))) cli = join(bin(prefix), "npm-cli.js");
  }
  if (!existsSync(cli)) throw new Error(`npm's npm-cli.js is not beside ${npm}`);
  return run(cli, args, options);
}

export interface NpmViewResult {
  ok: boolean;
  version?: string;
}

/** `npm view <pkg> version`, offline-safe: any failure (no npm, no network,
 * timeout) resolves to `{ ok: false }` rather than throwing. */
export function getNpmViewVersion(pkgName: string = PKG_NAME, timeoutMs = 2000): NpmViewResult {
  try {
    const res = npmSync(["view", pkgName, "version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (res.error || res.signal || res.status !== 0) return { ok: false };
    const version = res.stdout?.toString().trim();
    if (!version) return { ok: false };
    return { ok: true, version };
  } catch {
    return { ok: false };
  }
}

/** Pure formatter for `graft version`. No package is published under this distribution, so nothing is compared. */
export function formatVersionReport(current: string): string {
  return `${brand()} ${current}\nnot compared with npm: this distribution has no published package`;
}

/** `upgrade` on this fork: no package is published under it, and npm's would replace it. */
export const UPGRADE_UNAVAILABLE =
  "✗ upgrade is not available for this distribution: the package on npm is upstream's, and installing it would replace this one. See the install instructions in this repository's README.";
