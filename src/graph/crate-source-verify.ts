/**
 * Bounded regular-file reading and identity/containment verification for `crate-source`.
 *
 * Mirrors `rust/gg-query/src/crate_source/verify.rs`: assumes a stable
 * repository/cache tree during a single invocation, opens regular-file handles
 * directly for bounded reads, and verifies `[package].name` + `[package].version`
 * (including `version.workspace = true`), registry index identity and full git SHA.
 */
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { parse as parseToml } from "smol-toml";

export const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_SCAN_ENTRIES = 512;
const MAX_REGISTRY_DIRS = 64;
const MAX_GIT_CHECKOUTS = 128;

export const SKIP_DIRS = new Set([".git", "target", "node_modules", ".trail", "graft", "dist", "vendor"]);

export interface VerifiedDir {
  dir: string;
  manifestPath: string;
  srcDir?: string;
}

export type ResolveOutcome =
  | { status: "found"; verified: VerifiedDir }
  | { status: "not_cached" }
  | { status: "ambiguous"; hint: string }
  | { status: "unresolved"; hint: string }
  | { status: "budget_exhausted"; hint: string };

export function containedRealpath(candidate: string, boundary: string): string | null {
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

/** Open a regular file by descriptor and read at most `maxBytes` UTF-8 bytes. */
export function readBoundedRegularFile(path: string, maxBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`${path} is not a regular file`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const buf = Buffer.allocUnsafe(Math.min(65536, maxBytes + 1));
    while (total <= maxBytes) {
      const want = Math.min(buf.length, maxBytes + 1 - total);
      const n = readSync(fd, buf, 0, want, null);
      if (n === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
      total += n;
    }
    if (total > maxBytes) {
      throw new Error(`${path} exceeds ${maxBytes} byte safety cap`);
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function readManifestIdentity(manifestPath: string): { name: string; version?: string; workspaceVersion: boolean } | null {
  try {
    const raw = readBoundedRegularFile(manifestPath, MAX_MANIFEST_BYTES);
    const parsed = parseToml(raw) as { package?: { name?: unknown; version?: unknown } };
    const name = typeof parsed.package?.name === "string" ? parsed.package.name : null;
    if (!name) return null;
    const ver = parsed.package?.version;
    if (typeof ver === "string") return { name, version: ver, workspaceVersion: false };
    if (ver && typeof ver === "object" && (ver as { workspace?: unknown }).workspace === true) {
      return { name, workspaceVersion: true };
    }
    return { name, workspaceVersion: false };
  } catch {
    return null;
  }
}

function resolveWorkspaceVersion(crateDir: string, boundary: string): string | null {
  let canonBound: string;
  let cur: string;
  try {
    canonBound = realpathSync(boundary);
    cur = realpathSync(crateDir);
  } catch {
    return null;
  }
  for (let i = 0; i < 8; i++) {
    const inBound = cur === canonBound || cur.startsWith(canonBound.endsWith(sep) ? canonBound : `${canonBound}${sep}`);
    if (!inBound) break;
    const manifest = containedRealpath(join(cur, "Cargo.toml"), canonBound);
    if (manifest) {
      try {
        const parsed = parseToml(readBoundedRegularFile(manifest, MAX_MANIFEST_BYTES)) as {
          workspace?: { package?: { version?: unknown } };
        };
        if (typeof parsed.workspace?.package?.version === "string") {
          return parsed.workspace.package.version;
        }
      } catch {
        /* continue walking up */
      }
    }
    if (cur === canonBound) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export function verifyManifestIdentity(
  dir: string,
  boundary: string,
  expectedName: string,
  expectedVersion: string,
): VerifiedDir | null {
  const canonDir = containedRealpath(dir, boundary);
  if (!canonDir) return null;
  try {
    if (!statSync(canonDir).isDirectory()) return null;
  } catch {
    return null;
  }
  const canonManifest = containedRealpath(join(canonDir, "Cargo.toml"), canonDir);
  if (!canonManifest) return null;
  try {
    if (!statSync(canonManifest).isFile()) return null;
  } catch {
    return null;
  }
  const ident = readManifestIdentity(canonManifest);
  if (!ident || ident.name !== expectedName) return null;
  const actualVersion = ident.version ?? (ident.workspaceVersion ? resolveWorkspaceVersion(canonDir, boundary) : null);
  if (actualVersion !== expectedVersion) return null;

  const canonSrc = containedRealpath(join(canonDir, "src"), canonDir);
  let srcDir: string | undefined;
  if (canonSrc) {
    try {
      if (statSync(canonSrc).isDirectory()) srcDir = canonSrc;
    } catch {
      /* omit srcDir */
    }
  }
  return { dir: canonDir, manifestPath: canonManifest, ...(srcDir ? { srcDir } : {}) };
}

function registryDirMatchesSource(indexDirName: string, sourceUrl: string): boolean | null {
  if (!sourceUrl.startsWith("registry+")) return null;
  const url = sourceUrl.slice("registry+".length);
  if (url === "https://github.com/rust-lang/crates.io-index" || url === "sparse+https://index.crates.io/") {
    return indexDirName.startsWith("index.crates.io-") || indexDirName.startsWith("github.com-1ecc6299db9ec823");
  }
  const schemeIdx = url.indexOf("://");
  if (schemeIdx === -1) return null;
  const hostPort = url.slice(schemeIdx + 3).split("/")[0] ?? "";
  const host = (hostPort.split(":")[0] ?? "").toLowerCase();
  if (!host) return null;
  return indexDirName.toLowerCase().startsWith(`${host}-`);
}

export function resolveRegistry(
  cargoHome: string,
  sourceUrl: string,
  name: string,
  version: string,
): ResolveOutcome {
  const regSrc = join(cargoHome, "registry", "src");
  let entries;
  try {
    entries = readdirSync(regSrc, { withFileTypes: true });
  } catch {
    return { status: "not_cached" };
  }
  if (entries.length > MAX_REGISTRY_DIRS) {
    return {
      status: "budget_exhausted",
      hint: `registry index directory count under ${regSrc} exceeds ${MAX_REGISTRY_DIRS}`,
    };
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => ({ dirName: e.name, idxDir: join(regSrc, e.name) }))
    .sort((a, b) => (a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0));

  const folderName = `${name}-${version}`;
  const matched: { exact: boolean; verified: VerifiedDir }[] = [];
  for (const { dirName, idxDir } of dirs) {
    const verified = verifyManifestIdentity(join(idxDir, folderName), idxDir, name, version);
    if (!verified) continue;
    const srcMatch = registryDirMatchesSource(dirName, sourceUrl);
    if (srcMatch === false) continue;
    matched.push({ exact: srcMatch === true, verified });
  }

  const exact = matched.filter((m) => m.exact);
  if (exact.length === 1) return { status: "found", verified: exact[0].verified };
  if (exact.length > 1) {
    return { status: "ambiguous", hint: `multiple local registry directories match ${name} ${version} for ${sourceUrl}` };
  }
  if (matched.length === 1) return { status: "found", verified: matched[0].verified };
  if (matched.length > 1) {
    return {
      status: "ambiguous",
      hint: `multiple local registry directories match ${name} ${version} and registry cannot be disambiguated`,
    };
  }
  return { status: "not_cached" };
}

function normaliseGitUrl(url: string): string {
  const base = url.split("?")[0] ?? url;
  const trimmed = base.trim().replace(/\/+$/, "");
  return trimmed.replace(/\.git$/i, "").toLowerCase();
}

function extractGitOriginUrl(gitDir: string, boundary: string): string | null {
  const canon = containedRealpath(join(gitDir, "config"), boundary);
  if (!canon) return null;
  try {
    const text = readBoundedRegularFile(canon, MAX_MANIFEST_BYTES);
    let inOrigin = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("[") && line.endsWith("]")) {
        inOrigin = line === '[remote "origin"]';
        continue;
      }
      if (inOrigin) {
        const eq = line.indexOf("=");
        if (eq !== -1 && line.slice(0, eq).trim() === "url") {
          return normaliseGitUrl(line.slice(eq + 1).trim());
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function resolveGitDirPointer(revDir: string, cargoHome: string): { gitDir: string; boundary: string } | null {
  const dotGit = join(revDir, ".git");
  const canon = containedRealpath(dotGit, revDir);
  if (!canon) return null;
  try {
    if (statSync(canon).isDirectory()) return { gitDir: canon, boundary: revDir };
    const text = readBoundedRegularFile(canon, 4096).trim();
    if (!text.startsWith("gitdir:")) return null;
    const target = text.slice("gitdir:".length).trim();
    const joined = isAbsolute(target) ? target : join(revDir, target);
    const gitRoot = join(cargoHome, "git");
    const canonTarget = containedRealpath(joined, gitRoot);
    if (canonTarget && statSync(canonTarget).isDirectory()) {
      return { gitDir: canonTarget, boundary: gitRoot };
    }
  } catch {
    return null;
  }
  return null;
}

function readVerifiedGitSha(revDir: string, cargoHome: string): { sha: string; origin: string | null } | null {
  const ptr = resolveGitDirPointer(revDir, cargoHome);
  if (ptr) {
    const origin = extractGitOriginUrl(ptr.gitDir, ptr.boundary);
    const canonHead = containedRealpath(join(ptr.gitDir, "HEAD"), ptr.boundary);
    if (canonHead) {
      try {
        const trimmed = readBoundedRegularFile(canonHead, 4096).trim();
        if (/^[0-9a-fA-F]{40}$/.test(trimmed)) return { sha: trimmed.toLowerCase(), origin };
        if (trimmed.startsWith("ref:")) {
          const refPath = containedRealpath(join(ptr.gitDir, trimmed.slice(4).trim()), ptr.boundary);
          if (refPath) {
            const refSha = readBoundedRegularFile(refPath, 4096).trim();
            if (/^[0-9a-fA-F]{40}$/.test(refSha)) return { sha: refSha.toLowerCase(), origin };
          }
        }
      } catch {
        /* fall through to vcs-info */
      }
    }
  }
  const canonVcs = containedRealpath(join(revDir, ".cargo-vcs-info.json"), revDir);
  if (canonVcs) {
    try {
      const parsed = JSON.parse(readBoundedRegularFile(canonVcs, MAX_MANIFEST_BYTES)) as { git?: { sha1?: unknown } };
      if (typeof parsed.git?.sha1 === "string" && /^[0-9a-fA-F]{40}$/.test(parsed.git.sha1)) {
        return { sha: parsed.git.sha1.toLowerCase(), origin: null };
      }
    } catch {
      /* ignore invalid json */
    }
  }
  return null;
}

export function resolveGit(cargoHome: string, source: string, name: string, version: string): ResolveOutcome {
  const hashIdx = source.lastIndexOf("#");
  if (hashIdx === -1) return { status: "unresolved", hint: `git source "${source}" lacks a commit SHA` };
  const urlPart = source.slice(0, hashIdx);
  const rawRev = source.slice(hashIdx + 1);
  if (!/^[0-9a-fA-F]{40}$/.test(rawRev)) {
    return { status: "unresolved", hint: `git source "${source}" does not carry a 40-char commit SHA` };
  }
  const expectedUrl = urlPart.startsWith("git+") ? urlPart.slice(4) : urlPart;
  const fullRev = rawRev.toLowerCase();
  const shortRev = fullRev.slice(0, 7);
  const normExpectedUrl = normaliseGitUrl(expectedUrl);
  const expectedSlug = normExpectedUrl.split("/").filter(Boolean).at(-1);

  const gitRoot = join(cargoHome, "git", "checkouts");
  let entries;
  try {
    entries = readdirSync(gitRoot, { withFileTypes: true });
  } catch {
    return { status: "not_cached" };
  }
  if (entries.length > MAX_GIT_CHECKOUTS) {
    return { status: "budget_exhausted", hint: `git checkout directory count under ${gitRoot} exceeds ${MAX_GIT_CHECKOUTS}` };
  }
  const repoDirs = entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => ({ dirName: e.name, repoDir: join(gitRoot, e.name) }))
    .sort((a, b) => (a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0));

  const verifiedHits: VerifiedDir[] = [];
  let unverifiedCandidate = false;

  for (const { dirName, repoDir } of repoDirs) {
    const revDir = join(repoDir, shortRev);
    try {
      const st = lstatSync(revDir);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
    } catch {
      continue;
    }
    const canonRev = containedRealpath(revDir, repoDir);
    if (!canonRev) continue;
    const shaInfo = readVerifiedGitSha(canonRev, cargoHome);
    if (!shaInfo) {
      if (findVerifiedCratesUnder(canonRev, canonRev, name, version, 2).matches.length > 0) {
        unverifiedCandidate = true;
      }
      continue;
    }
    if (shaInfo.sha !== fullRev) continue;
    if (shaInfo.origin !== null) {
      if (shaInfo.origin !== normExpectedUrl) continue;
    } else if (expectedSlug && !dirName.toLowerCase().startsWith(`${expectedSlug}-`)) {
      continue;
    }
    const sub = findVerifiedCratesUnder(canonRev, canonRev, name, version, 2);
    if (sub.exhausted) {
      return { status: "budget_exhausted", hint: `directory scan budget exceeded inside ${canonRev}` };
    }
    verifiedHits.push(...sub.matches);
  }

  if (verifiedHits.length === 1) return { status: "found", verified: verifiedHits[0] };
  if (verifiedHits.length > 1) {
    return { status: "ambiguous", hint: `multiple verified git checkouts match ${name} ${version} at ${shortRev}` };
  }
  if (unverifiedCandidate) {
    return {
      status: "unresolved",
      hint: `git checkout at ${shortRev} lacks verifiable full commit SHA (.git/HEAD or .cargo-vcs-info.json)`,
    };
  }
  return { status: "not_cached" };
}

export function resolvePathCrate(
  lockfileDir: string,
  repoCanon: string,
  name: string,
  version: string,
): ResolveOutcome {
  const res = findVerifiedCratesUnder(lockfileDir, repoCanon, name, version, 3);
  if (res.exhausted) {
    return { status: "budget_exhausted", hint: `directory scan budget exceeded under ${lockfileDir}` };
  }
  if (res.matches.length === 1) return { status: "found", verified: res.matches[0] };
  if (res.matches.length > 1) {
    return { status: "ambiguous", hint: `multiple local workspace/path crates match ${name} ${version}` };
  }
  return { status: "not_cached" };
}

function findVerifiedCratesUnder(
  rootDir: string,
  boundary: string,
  crateName: string,
  expectedVersion: string,
  maxDepth: number,
): { matches: VerifiedDir[]; exhausted: boolean } {
  const stack: { dir: string; depth: number }[] = [{ dir: rootDir, depth: 0 }];
  let visited = 0;
  const matches: VerifiedDir[] = [];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const canonDir = containedRealpath(cur.dir, boundary);
    if (!canonDir) continue;
    const verified = verifyManifestIdentity(canonDir, boundary, crateName, expectedVersion);
    if (verified) {
      matches.push(verified);
      if (matches.length > 1) return { matches, exhausted: false };
    }
    if (cur.depth >= maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(canonDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const children: string[] = [];
    for (const e of entries) {
      visited++;
      if (visited > MAX_SCAN_ENTRIES) return { matches, exhausted: true };
      if (e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.has(e.name)) {
        children.push(join(canonDir, e.name));
      }
    }
    children.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ dir: children[i], depth: cur.depth + 1 });
    }
  }
  return { matches, exhausted: false };
}
