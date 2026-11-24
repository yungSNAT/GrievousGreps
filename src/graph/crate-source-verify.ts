/**
 * Registry, git and path source identity verification for `crate-source`.
 *
 * Mirrors `rust/gg-query/src/crate_source/verify.rs`.
 */
import { lstatSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  BudgetExhaustedError,
  containedRealpath,
  MAX_MANIFEST_BYTES,
  MAX_SCAN_ENTRIES,
  readBoundedRegularFile,
  readDirIncremental,
  SKIP_DIRS,
  verifyManifestIdentity,
  WorkspaceManifestParseError,
  type VerifiedDir,
} from "./crate-source-fs.js";

export {
  containedRealpath,
  MAX_LOCKFILE_BYTES,
  MAX_SCAN_ENTRIES,
  readBoundedRegularFile,
  readDirIncremental,
  SKIP_DIRS,
} from "./crate-source-fs.js";

const MAX_REGISTRY_DIRS = 64;
const MAX_GIT_CHECKOUTS = 128;

export type ResolveOutcome =
  | { status: "found"; verified: VerifiedDir }
  | { status: "not_cached" }
  | { status: "ambiguous"; hint: string }
  | { status: "unresolved"; hint: string }
  | { status: "budget_exhausted"; hint: string };

function parseRegistryAuthorityPort(rawAuth: string): boolean {
  let portColon = -1;
  if (rawAuth.startsWith("[")) {
    const close = rawAuth.indexOf("]");
    if (close === -1) return false;
    const tail = rawAuth.slice(close + 1);
    if (tail !== "") {
      if (!tail.startsWith(":")) return false;
      portColon = close + 1;
    }
  } else {
    if (rawAuth.includes("[") || rawAuth.includes("]")) return false;
    portColon = rawAuth.indexOf(":");
  }
  if (portColon === -1) return true;
  const hostPart = rawAuth.slice(0, portColon);
  const portPart = rawAuth.slice(portColon + 1);
  if (!hostPart || !/^\d+$/.test(portPart)) return false;
  const portNum = Number(portPart);
  return Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
}

function normaliseRegistryUrl(raw: string): string | null {
  const noSparse = raw.startsWith("sparse+") ? raw.slice("sparse+".length) : raw;
  if (/[\s\u0000-\u001f\u007f?#\\]/.test(noSparse)) return null;
  const schemeIdx = noSparse.indexOf("://");
  if (schemeIdx === -1) return null;
  const scheme = noSparse.slice(0, schemeIdx).toLowerCase();
  if (scheme !== "https" && scheme !== "http") return null;
  const rest = noSparse.slice(schemeIdx + 3);
  const slashIdx = rest.indexOf("/");
  const rawAuth = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  if (!rawAuth || rawAuth.includes("@") || !parseRegistryAuthorityPort(rawAuth)) return null;
  let parsed: URL;
  try {
    parsed = new URL(noSparse);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${scheme}:` || !parsed.hostname || parsed.username || parsed.password) {
    return null;
  }
  if (
    !parsed.hostname.startsWith("[") &&
    (parsed.hostname.startsWith(".") || parsed.hostname.endsWith(".") || parsed.hostname.includes(".."))
  ) {
    return null;
  }
  const pathClean = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
  return `${scheme}://${parsed.host.toLowerCase()}${pathClean}`;
}

type RegistryIdentity = "verified" | "mismatch" | "unverifiable";

function verifyRegistryIndexIdentity(
  cargoHome: string,
  indexDirName: string,
  lockedUrl: string,
  normLockedUrl: string,
): RegistryIdentity {
  if (lockedUrl === "https://github.com/rust-lang/crates.io-index" || lockedUrl === "sparse+https://index.crates.io/") {
    return indexDirName.startsWith("index.crates.io-") || indexDirName.startsWith("github.com-1ecc6299db9ec823")
      ? "verified"
      : "mismatch";
  }
  const regIndexRoot = join(cargoHome, "registry", "index");
  const canonGit = containedRealpath(join(regIndexRoot, indexDirName, ".git"), regIndexRoot);
  if (!canonGit) return "unverifiable";
  const origin = extractGitOriginUrl(canonGit, canonGit);
  if (!origin) return "unverifiable";
  const normOrigin = normaliseRegistryUrl(origin);
  if (!normOrigin) return "unverifiable";
  return normOrigin === normLockedUrl ? "verified" : "mismatch";
}

export function resolveRegistry(
  cargoHome: string,
  sourceUrl: string,
  name: string,
  version: string,
): ResolveOutcome {
  if (!sourceUrl.startsWith("registry+")) {
    return { status: "unresolved", hint: `invalid registry source "${sourceUrl}"` };
  }
  const lockedUrl = sourceUrl.slice("registry+".length);
  const normLocked = normaliseRegistryUrl(lockedUrl);
  if (!normLocked) {
    return {
      status: "unresolved",
      hint: `registry source "${sourceUrl}" cannot be verified (invalid registry URL)`,
    };
  }

  const regSrc = join(cargoHome, "registry", "src");
  const scanned = readDirIncremental(regSrc, MAX_REGISTRY_DIRS);
  if (!scanned) return { status: "not_cached" };
  if (scanned.exhausted) {
    return {
      status: "budget_exhausted",
      hint: `registry index directory count under ${regSrc} exceeds ${MAX_REGISTRY_DIRS}`,
    };
  }
  const dirs = scanned.entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => ({ dirName: e.name, idxDir: join(regSrc, e.name) }))
    .sort((a, b) => (a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0));

  const folderName = `${name}-${version}`;
  const verifiedHits: VerifiedDir[] = [];
  let unverifiable = false;

  try {
    for (const { dirName, idxDir } of dirs) {
      const verified = verifyManifestIdentity(join(idxDir, folderName), idxDir, name, version);
      if (!verified) continue;
      const ident = verifyRegistryIndexIdentity(cargoHome, dirName, lockedUrl, normLocked);
      if (ident === "verified") verifiedHits.push(verified);
      else if (ident === "unverifiable") unverifiable = true;
    }
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      return { status: "budget_exhausted", hint: err.message };
    }
    if (err instanceof WorkspaceManifestParseError) {
      return { status: "unresolved", hint: err.message };
    }
    throw err;
  }

  if (verifiedHits.length === 1) return { status: "found", verified: verifiedHits[0] };
  if (verifiedHits.length > 1) {
    return { status: "ambiguous", hint: `multiple local registry directories match ${name} ${version} for ${sourceUrl}` };
  }
  if (unverifiable) {
    return {
      status: "unresolved",
      hint: `local cache for ${name} ${version} could not be verified against registry ${sourceUrl}`,
    };
  }
  return { status: "not_cached" };
}

function normaliseGitUrl(url: string): string {
  const base = url.split("?")[0] ?? url;
  const trimmed = base.trim().replace(/\/+$/, "");
  return trimmed.replace(/\.git$/, "").toLowerCase();
}

function extractGitOriginUrl(gitDir: string, boundary: string): string | null {
  const canon = containedRealpath(join(gitDir, "config"), boundary);
  if (!canon) return null;
  let text: string;
  try {
    text = readBoundedRegularFile(canon, MAX_MANIFEST_BYTES);
  } catch (err) {
    if (err instanceof BudgetExhaustedError) throw err;
    return null;
  }
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
        return line.slice(eq + 1).trim();
      }
    }
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
  } catch (err) {
    if (err instanceof BudgetExhaustedError) throw err;
    return null;
  }
  return null;
}

function readVerifiedGitSha(revDir: string, cargoHome: string): { sha: string; origin: string | null } | null {
  let discoveredOrigin: string | null = null;
  const ptr = resolveGitDirPointer(revDir, cargoHome);
  if (ptr) {
    const rawOrigin = extractGitOriginUrl(ptr.gitDir, ptr.boundary);
    discoveredOrigin = rawOrigin ? normaliseGitUrl(rawOrigin) : null;
    const canonHead = containedRealpath(join(ptr.gitDir, "HEAD"), ptr.boundary);
    if (canonHead) {
      try {
        const trimmed = readBoundedRegularFile(canonHead, 4096).trim();
        if (/^[0-9a-fA-F]{40}$/.test(trimmed)) return { sha: trimmed.toLowerCase(), origin: discoveredOrigin };
        if (trimmed.startsWith("ref:")) {
          const refPath = containedRealpath(join(ptr.gitDir, trimmed.slice(4).trim()), ptr.boundary);
          if (refPath) {
            const refSha = readBoundedRegularFile(refPath, 4096).trim();
            if (/^[0-9a-fA-F]{40}$/.test(refSha)) return { sha: refSha.toLowerCase(), origin: discoveredOrigin };
          }
        }
      } catch (err) {
        if (err instanceof BudgetExhaustedError) throw err;
      }
    }
  }
  const canonVcs = containedRealpath(join(revDir, ".cargo-vcs-info.json"), revDir);
  if (canonVcs) {
    let raw: string;
    try {
      raw = readBoundedRegularFile(canonVcs, MAX_MANIFEST_BYTES);
    } catch (err) {
      if (err instanceof BudgetExhaustedError) throw err;
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as { git?: { sha1?: unknown } };
      if (typeof parsed.git?.sha1 === "string" && /^[0-9a-fA-F]{40}$/.test(parsed.git.sha1)) {
        return { sha: parsed.git.sha1.toLowerCase(), origin: discoveredOrigin };
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
  const scanned = readDirIncremental(gitRoot, MAX_GIT_CHECKOUTS);
  if (!scanned) return { status: "not_cached" };
  if (scanned.exhausted) {
    return { status: "budget_exhausted", hint: `git checkout directory count under ${gitRoot} exceeds ${MAX_GIT_CHECKOUTS}` };
  }
  const repoDirs = scanned.entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => ({ dirName: e.name, repoDir: join(gitRoot, e.name) }))
    .sort((a, b) => (a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0));

  const verifiedHits: VerifiedDir[] = [];
  let unverifiedCandidate = false;

  try {
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
        const unvSub = findVerifiedCratesUnder(canonRev, canonRev, name, version, 2);
        if (unvSub.exhausted) {
          return { status: "budget_exhausted", hint: unvSub.hint ?? `directory scan budget exceeded inside ${canonRev}` };
        }
        if (unvSub.matches.length > 0) unverifiedCandidate = true;
        continue;
      }
      if (shaInfo.sha !== fullRev) continue;
      if (shaInfo.origin !== null) {
        if (shaInfo.origin !== normExpectedUrl) continue;
      } else if (!expectedSlug || !dirName.toLowerCase().startsWith(`${expectedSlug}-`)) {
        continue;
      }
      const sub = findVerifiedCratesUnder(canonRev, canonRev, name, version, 2);
      if (sub.exhausted) {
        return { status: "budget_exhausted", hint: sub.hint ?? `directory scan budget exceeded inside ${canonRev}` };
      }
      verifiedHits.push(...sub.matches);
    }
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      return { status: "budget_exhausted", hint: err.message };
    }
    if (err instanceof WorkspaceManifestParseError) {
      return { status: "unresolved", hint: err.message };
    }
    throw err;
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
  try {
    const res = findVerifiedCratesUnder(lockfileDir, repoCanon, name, version, 3);
    if (res.exhausted) {
      return { status: "budget_exhausted", hint: res.hint ?? `directory scan budget exceeded under ${lockfileDir}` };
    }
    if (res.matches.length === 1) return { status: "found", verified: res.matches[0] };
    if (res.matches.length > 1) {
      return { status: "ambiguous", hint: `multiple local workspace/path crates match ${name} ${version}` };
    }
    return { status: "not_cached" };
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      return { status: "budget_exhausted", hint: err.message };
    }
    if (err instanceof WorkspaceManifestParseError) {
      return { status: "unresolved", hint: err.message };
    }
    throw err;
  }
}

function findVerifiedCratesUnder(
  rootDir: string,
  boundary: string,
  crateName: string,
  expectedVersion: string,
  maxDepth: number,
): { matches: VerifiedDir[]; exhausted: boolean; hint?: string } {
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
    const remaining = MAX_SCAN_ENTRIES - visited;
    const scanned = readDirIncremental(canonDir, remaining);
    if (!scanned) continue;
    visited += scanned.entries.length;
    if (scanned.exhausted) return { matches, exhausted: true, hint: `directory scan budget exceeded under ${rootDir}` };
    const children: string[] = [];
    for (const e of scanned.entries) {
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
