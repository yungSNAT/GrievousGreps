/**
 * Non-blocking regular-file reading, incremental directory enumeration and
 * manifest identity helpers for `crate-source`.
 *
 * Assumes a stable repository/cache tree during a single invocation; checks
 * `lstatSync(path).isFile()` before opening to reject FIFOs/devices/symlinks
 * without blocking, then verifies `fstatSync(fd).isFile()` and caps bytes on
 * the opened descriptor.
 */
import {
  closeSync,
  type Dirent,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { parse as parseToml } from "smol-toml";

export const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_SCAN_ENTRIES = 512;

export const SKIP_DIRS = new Set([".git", "target", "node_modules", ".trail", "graft", "dist", "vendor"]);

export class BudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

export interface VerifiedDir {
  dir: string;
  manifestPath: string;
  srcDir?: string;
}

/** Read at most `maxEntries` directory entries incrementally via `opendirSync`. */
export function readDirIncremental(
  dir: string,
  maxEntries: number,
): { entries: Dirent[]; exhausted: boolean } | null {
  let handle;
  try {
    handle = opendirSync(dir);
  } catch {
    return null;
  }
  const entries: Dirent[] = [];
  let count = 0;
  try {
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) return { entries, exhausted: false };
      count++;
      if (count > maxEntries) return { entries, exhausted: true };
      entries.push(entry);
    }
  } finally {
    handle.closeSync();
  }
}

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

/** Reject non-regular files (including FIFOs and symlinks) before opening, then
 * open by descriptor and read at most `maxBytes` UTF-8 bytes. */
export function readBoundedRegularFile(path: string, maxBytes: number): string {
  let pre;
  try {
    pre = lstatSync(path);
  } catch (err) {
    throw new Error(`cannot stat ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!pre.isFile()) {
    throw new Error(`${path} is not a regular file`);
  }
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
      throw new BudgetExhaustedError(`${path} exceeds ${maxBytes} byte safety cap`);
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function readManifestIdentity(manifestPath: string): { name: string; version?: string; workspaceVersion: boolean } | null {
  let raw: string;
  try {
    raw = readBoundedRegularFile(manifestPath, MAX_MANIFEST_BYTES);
  } catch (err) {
    if (err instanceof BudgetExhaustedError) throw err;
    return null;
  }
  try {
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
  const boundPrefix = canonBound.endsWith(sep) ? canonBound : `${canonBound}${sep}`;
  for (let i = 0; i < 8; i++) {
    if (cur !== canonBound && !cur.startsWith(boundPrefix)) break;
    const manifest = containedRealpath(join(cur, "Cargo.toml"), canonBound);
    if (manifest) {
      let raw: string | null = null;
      try {
        raw = readBoundedRegularFile(manifest, MAX_MANIFEST_BYTES);
      } catch (err) {
        if (err instanceof BudgetExhaustedError) throw err;
      }
      if (raw !== null) {
        try {
          const parsed = parseToml(raw) as { workspace?: { package?: { version?: unknown } } };
          if (typeof parsed.workspace?.package?.version === "string") {
            return parsed.workspace.package.version;
          }
        } catch {
          /* continue walking up */
        }
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
    if (!lstatSync(canonManifest).isFile()) return null;
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
