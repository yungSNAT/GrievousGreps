/**
 * `Cargo.lock`-anchored resolved-dependency source lookup (`crate-source`).
 *
 * Mirrors `rust/gg-query/src/crate_source.rs`: read-only, fail-closed, bounded
 * resolution from a workspace's `Cargo.lock` to the exact local Cargo registry,
 * git checkout or path source directory.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";

const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
const MAX_LOCKFILES = 16;
const MAX_SCAN_DEPTH = 2;
const MAX_REGISTRY_DIRS = 64;
const MAX_GIT_CHECKOUTS = 128;
const MAX_RESULTS = 16;

const SKIP_DIRS = new Set([".git", "target", "node_modules", ".trail", "graft", "dist", "vendor"]);
const CRATE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const VERSION_RE = /^[A-Za-z0-9.+-]{1,128}$/;

export type CrateSourceKind = "registry" | "git" | "path";
export type ResolutionStatus = "found" | "not_cached";

export interface CrateSourceMatch {
  name: string;
  version: string;
  kind: CrateSourceKind;
  status: ResolutionStatus;
  lockfile: string;
  source?: string;
  path?: string;
  manifestPath?: string;
  srcDir?: string;
  hint?: string;
}

export interface CrateSourceReport {
  query: string;
  versionFilter?: string;
  cargoHome: string;
  matches: CrateSourceMatch[];
  truncated: number;
}

export interface CrateSourceOptions {
  crateName: string;
  repo: string;
  version?: string;
  cargoHome?: string;
  lockfile?: string;
}

interface LockPackage {
  name: string;
  version: string;
  source?: string;
}

function validateCrateName(name: string): void {
  if (!CRATE_NAME_RE.test(name)) {
    throw new Error(`invalid crate name "${name}": only ASCII letters, digits, '-' and '_' are allowed`);
  }
}

function validateVersion(version: string): void {
  if (!VERSION_RE.test(version) || version.includes("..")) {
    throw new Error(`invalid version filter "${version}"`);
  }
}

function canonicalCrateKey(name: string): string {
  return name.replaceAll("-", "_");
}

function resolveCargoHome(overrideDir?: string): string {
  if (overrideDir) return resolve(overrideDir);
  if (process.env.CARGO_HOME && process.env.CARGO_HOME.trim()) {
    return resolve(process.env.CARGO_HOME);
  }
  return join(homedir(), ".cargo");
}

function containedRealpath(candidate: string, boundary: string): string | null {
  try {
    const canonBound = realpathSync(boundary);
    const canonCand = realpathSync(candidate);
    if (canonCand === canonBound) return canonCand;
    const prefix = canonBound.endsWith(sep) ? canonBound : `${canonBound}${sep}`;
    return canonCand.startsWith(prefix) ? canonCand : null;
  } catch {
    return null;
  }
}

function discoverLockfiles(repoCanon: string, explicit?: string): string[] {
  if (explicit) {
    const joined = isAbsolute(explicit) ? explicit : join(repoCanon, explicit);
    const canon = containedRealpath(joined, repoCanon);
    if (!canon || !statSync(canon).isFile()) {
      throw new Error(`lockfile ${explicit} is missing or escapes repository root ${repoCanon}`);
    }
    return [canon];
  }
  const rootLock = join(repoCanon, "Cargo.lock");
  const rootCanon = containedRealpath(rootLock, repoCanon);
  if (rootCanon && statSync(rootCanon).isFile()) {
    return [rootCanon];
  }
  const found: string[] = [];
  scanLockfiles(repoCanon, repoCanon, 0, found);
  found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (found.length === 0) {
    throw new Error(`no Cargo.lock found under ${repoCanon}`);
  }
  return found;
}

function scanLockfiles(repoCanon: string, dir: string, depth: number, out: string[]): void {
  if (depth > MAX_SCAN_DEPTH || out.length >= MAX_LOCKFILES) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === "Cargo.lock") {
      const canon = containedRealpath(full, repoCanon);
      if (canon) {
        out.push(canon);
        if (out.length >= MAX_LOCKFILES) return;
      }
    } else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      subdirs.push(full);
    }
  }
  subdirs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const sub of subdirs) scanLockfiles(repoCanon, sub, depth + 1, out);
}

function parseCargoLock(lockPath: string): LockPackage[] {
  const st = statSync(lockPath);
  if (st.size > MAX_LOCKFILE_BYTES) {
    throw new Error(`Cargo.lock ${lockPath} exceeds ${MAX_LOCKFILE_BYTES} byte safety cap`);
  }
  const raw = readFileSync(lockPath, "utf8");
  const parsed = parseToml(raw) as { package?: unknown };
  if (!Array.isArray(parsed.package)) return [];
  const pkgs: LockPackage[] = [];
  for (const item of parsed.package) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== "string" || typeof rec.version !== "string") continue;
    pkgs.push({
      name: rec.name,
      version: rec.version,
      ...(typeof rec.source === "string" ? { source: rec.source } : {}),
    });
  }
  return pkgs;
}

function manifestPackageName(manifestPath: string): string | null {
  try {
    const parsed = parseToml(readFileSync(manifestPath, "utf8")) as { package?: { name?: unknown } };
    return typeof parsed.package?.name === "string" ? parsed.package.name : null;
  } catch {
    return null;
  }
}

function findCrateDirUnder(rootDir: string, boundary: string, crateName: string, maxDepth: number): string | null {
  const stack: { dir: string; depth: number }[] = [{ dir: rootDir, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < 256) {
    const cur = stack.pop()!;
    visited++;
    const manifest = join(cur.dir, "Cargo.toml");
    if (existsSync(manifest) && manifestPackageName(manifest) === crateName) {
      const canon = containedRealpath(cur.dir, boundary);
      if (canon) return canon;
    }
    if (cur.depth >= maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(cur.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const children = entries
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.has(e.name))
      .map((e) => join(cur.dir, e.name))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ dir: children[i], depth: cur.depth + 1 });
    }
  }
  return null;
}

function resolveRegistryDir(cargoHome: string, name: string, version: string): string | null {
  const regSrc = join(cargoHome, "registry", "src");
  let entries;
  try {
    entries = readdirSync(regSrc, { withFileTypes: true });
  } catch {
    return null;
  }
  const indexDirs = entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => join(regSrc, e.name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_REGISTRY_DIRS);
  const folderName = `${name}-${version}`;
  for (const idxDir of indexDirs) {
    const candidate = join(idxDir, folderName);
    if (existsSync(join(candidate, "Cargo.toml"))) {
      const canon = containedRealpath(candidate, regSrc);
      if (canon && statSync(canon).isDirectory()) return canon;
    }
  }
  return null;
}

function resolveGitDir(cargoHome: string, source: string, name: string): string | null {
  const hashIdx = source.lastIndexOf("#");
  if (hashIdx === -1) return null;
  const rev = source.slice(hashIdx + 1);
  if (rev.length < 7 || !/^[0-9a-fA-F]+$/.test(rev)) return null;
  const shortRev = rev.slice(0, 7);
  const gitRoot = join(cargoHome, "git", "checkouts");
  let entries;
  try {
    entries = readdirSync(gitRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const repoDirs = entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => join(gitRoot, e.name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_GIT_CHECKOUTS);
  for (const repoDir of repoDirs) {
    const revDir = join(repoDir, shortRev);
    try {
      if (!lstatSync(revDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const found = findCrateDirUnder(revDir, gitRoot, name, 2);
    if (found) return found;
  }
  return null;
}

function buildMatchEntry(
  pkg: LockPackage,
  lockfileRel: string,
  lockfileDir: string,
  repoCanon: string,
  cargoHome: string,
): CrateSourceMatch {
  let kind: CrateSourceKind = "path";
  let foundDir: string | null = null;
  if (pkg.source?.startsWith("registry+")) {
    kind = "registry";
    foundDir = resolveRegistryDir(cargoHome, pkg.name, pkg.version);
  } else if (pkg.source?.startsWith("git+")) {
    kind = "git";
    foundDir = resolveGitDir(cargoHome, pkg.source, pkg.name);
  } else {
    foundDir = findCrateDirUnder(lockfileDir, repoCanon, pkg.name, 3);
  }

  if (foundDir) {
    const manifestPath = join(foundDir, "Cargo.toml");
    const srcDir = join(foundDir, "src");
    return {
      name: pkg.name,
      version: pkg.version,
      kind,
      status: "found",
      lockfile: lockfileRel,
      ...(pkg.source ? { source: pkg.source } : {}),
      path: foundDir,
      ...(existsSync(manifestPath) ? { manifestPath } : {}),
      ...(existsSync(srcDir) && statSync(srcDir).isDirectory() ? { srcDir } : {}),
    };
  }
  return {
    name: pkg.name,
    version: pkg.version,
    kind,
    status: "not_cached",
    lockfile: lockfileRel,
    ...(pkg.source ? { source: pkg.source } : {}),
    hint:
      kind === "path"
        ? "workspace/path crate directory not found under repository root"
        : `locked version ${pkg.version} is not unpacked in ${cargoHome}; run \`cargo fetch\` to populate it`,
  };
}

export function resolveCrateSource(opts: CrateSourceOptions): CrateSourceReport {
  validateCrateName(opts.crateName);
  if (opts.version !== undefined) validateVersion(opts.version);
  const repoCanon = realpathSync(resolve(opts.repo));
  const cargoHome = resolveCargoHome(opts.cargoHome);
  const lockfiles = discoverLockfiles(repoCanon, opts.lockfile);

  const exactHits: { pkg: LockPackage; lf: string }[] = [];
  const canonHits: { pkg: LockPackage; lf: string }[] = [];
  const queryCanon = canonicalCrateKey(opts.crateName);

  for (const lf of lockfiles) {
    for (const pkg of parseCargoLock(lf)) {
      if (opts.version !== undefined && pkg.version !== opts.version) continue;
      if (pkg.name === opts.crateName) exactHits.push({ pkg, lf });
      else if (canonicalCrateKey(pkg.name) === queryCanon) canonHits.push({ pkg, lf });
    }
  }

  const chosen = exactHits.length > 0 ? exactHits : canonHits;
  if (chosen.length === 0) {
    const verNote = opts.version ? ` version ${opts.version}` : "";
    throw new Error(`crate "${opts.crateName}"${verNote} not found in ${lockfiles.length} Cargo.lock file(s)`);
  }

  const seen = new Set<string>();
  const matches: CrateSourceMatch[] = [];
  let truncated = 0;

  for (const { pkg, lf } of chosen) {
    const lfRel = relative(repoCanon, lf).split("\\").join("/");
    const key = `${pkg.name}\0${pkg.version}\0${pkg.source ?? ""}\0${lfRel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (matches.length >= MAX_RESULTS) {
      truncated++;
      continue;
    }
    matches.push(buildMatchEntry(pkg, lfRel, dirname(lf), repoCanon, cargoHome));
  }

  return {
    query: opts.crateName,
    ...(opts.version ? { versionFilter: opts.version } : {}),
    cargoHome,
    matches,
    truncated,
  };
}

export function formatCrateSourceText(report: CrateSourceReport): string {
  const lines: string[] = [];
  for (const m of report.matches) {
    if (m.status === "found" && m.path) {
      lines.push(`${m.name} ${m.version} (${m.kind}, ${m.lockfile}) → ${m.path}`);
    } else {
      lines.push(`⚠ ${m.name} ${m.version} (${m.kind}, ${m.lockfile}): ${m.hint ?? "not cached locally"}`);
    }
  }
  if (report.truncated > 0) {
    lines.push(`… and ${report.truncated} more match(es)`);
  }
  return `${lines.join("\n")}\n`;
}
