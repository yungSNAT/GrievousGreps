/**
 * `Cargo.lock`-anchored resolved-dependency source lookup (`crate-source`).
 *
 * Mirrors `rust/gg-query/src/crate_source/mod.rs`: read-only, fail-closed,
 * bounded resolution from a workspace's `Cargo.lock` to the exact local Cargo
 * registry, git checkout or path source directory.
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  containedRealpath,
  MAX_LOCKFILE_BYTES,
  MAX_SCAN_ENTRIES,
  readBoundedRegularFile,
  readDirIncremental,
  resolveGit,
  resolvePathCrate,
  resolveRegistry,
  SKIP_DIRS,
  type ResolveOutcome,
} from "./crate-source-verify.js";

const MAX_LOCKFILES = 16;
const MAX_SCAN_DEPTH = 2;
const MAX_RESULTS = 16;

const CRATE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const VERSION_RE = /^[A-Za-z0-9.+-]{1,128}$/;

export type CrateSourceKind = "registry" | "git" | "path";
export type ResolutionStatus = "found" | "not_cached" | "ambiguous" | "unresolved" | "budget_exhausted";

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
  const state = { visited: 0, exhausted: false };
  scanLockfiles(repoCanon, repoCanon, 0, found, state);
  if (state.exhausted) {
    throw new Error(`lockfile scan budget exceeded under ${repoCanon}`);
  }
  found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (found.length === 0) {
    throw new Error(`no Cargo.lock found under ${repoCanon}`);
  }
  return found;
}

function scanLockfiles(
  repoCanon: string,
  dir: string,
  depth: number,
  out: string[],
  state: { visited: number; exhausted: boolean },
): void {
  if (depth > MAX_SCAN_DEPTH || state.exhausted) return;
  const scanned = readDirIncremental(dir, MAX_SCAN_ENTRIES - state.visited);
  if (!scanned) return;
  state.visited += scanned.entries.length;
  if (scanned.exhausted) {
    state.exhausted = true;
    return;
  }
  const subdirs: string[] = [];
  for (const entry of scanned.entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === "Cargo.lock") {
      const canon = containedRealpath(full, repoCanon);
      if (canon) {
        if (out.length >= MAX_LOCKFILES) {
          state.exhausted = true;
          return;
        }
        out.push(canon);
      }
    } else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      subdirs.push(full);
    }
  }
  subdirs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const sub of subdirs) {
    scanLockfiles(repoCanon, sub, depth + 1, out, state);
    if (state.exhausted) return;
  }
}

function parseCargoLock(lockPath: string): LockPackage[] {
  const raw = readBoundedRegularFile(lockPath, MAX_LOCKFILE_BYTES);
  const parsed = parseToml(raw) as { package?: unknown };
  if (!Array.isArray(parsed.package)) return [];
  const pkgs: LockPackage[] = [];
  for (const item of parsed.package) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== "string" || typeof rec.version !== "string") continue;
    if (rec.source !== undefined && typeof rec.source !== "string") {
      throw new Error(`invalid non-string source field for crate "${rec.name}" in ${lockPath}`);
    }
    pkgs.push({
      name: rec.name,
      version: rec.version,
      ...(typeof rec.source === "string" ? { source: rec.source } : {}),
    });
  }
  return pkgs;
}

function buildMatchEntry(
  pkg: LockPackage,
  lockfileRel: string,
  lockfileDir: string,
  repoCanon: string,
  cargoHome: string,
): CrateSourceMatch {
  validateCrateName(pkg.name);
  validateVersion(pkg.version);
  let kind: CrateSourceKind;
  let outcome: ResolveOutcome;

  if (pkg.source === undefined) {
    kind = "path";
    outcome = resolvePathCrate(lockfileDir, repoCanon, pkg.name, pkg.version);
  } else if (pkg.source.startsWith("registry+")) {
    kind = "registry";
    outcome = resolveRegistry(cargoHome, pkg.source, pkg.name, pkg.version);
  } else if (pkg.source.startsWith("git+")) {
    kind = "git";
    outcome = resolveGit(cargoHome, pkg.source, pkg.name, pkg.version);
  } else {
    throw new Error(`unsupported source scheme "${pkg.source}" for crate "${pkg.name}" in Cargo.lock`);
  }

  const base = {
    name: pkg.name,
    version: pkg.version,
    kind,
    lockfile: lockfileRel,
    ...(pkg.source ? { source: pkg.source } : {}),
  };

  if (outcome.status === "found") {
    return {
      ...base,
      status: "found",
      path: outcome.verified.dir,
      manifestPath: outcome.verified.manifestPath,
      ...(outcome.verified.srcDir ? { srcDir: outcome.verified.srcDir } : {}),
    };
  }
  if (outcome.status === "not_cached") {
    return {
      ...base,
      status: "not_cached",
      hint:
        kind === "path"
          ? `workspace/path crate ${pkg.name} ${pkg.version} not found under repository root`
          : `locked version ${pkg.version} is not unpacked in ${cargoHome}; run \`cargo fetch\` to populate it`,
    };
  }
  return { ...base, status: outcome.status, hint: outcome.hint };
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
