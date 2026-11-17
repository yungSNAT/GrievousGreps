import { posix } from "node:path";
import { parse } from "smol-toml";
import type { RustTargets } from "./resolve.js";

type Table = Record<string, unknown>;
const isTable = (v: unknown): v is Table => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
const optionalString = (v: unknown) => v === undefined || typeof v === "string";

/** The kinds of target Cargo can find by itself, and the folder it finds each in. */
const KINDS = [["test", "tests"], ["example", "examples"], ["bench", "benches"]] as const;

/** A string that Rust's `str::trim` empties: only characters with the Unicode `White_Space`
 * property, which differs from JavaScript's `trim` in U+0085 (white space) and U+FEFF (not). */
const BLANK = /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/;

/** Whether a manifest's target tables have the shapes Cargo accepts: a `[lib]` table, whose name,
 * if given, has no hyphen, and `[[bin]]`, `[[test]]`, `[[example]]` and `[[bench]]` tables that
 * each name their target; every name not blank, every `path` a string. */
function targetTablesShaped(doc: Table): boolean {
  const named = (name: unknown): name is string => typeof name === "string" && !BLANK.test(name);
  const list = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((t) => isTable(t) && optionalString(t.path) && named(t.name)));
  const lib = doc.lib;
  const libShaped = lib === undefined || (isTable(lib) && optionalString(lib.path) && (lib.name === undefined || (named(lib.name) && !lib.name.includes("-"))));
  return libShaped && list(doc.bin) && KINDS.every(([kind]) => list(doc[kind]));
}

/** An edition as Cargo states one, such as "2018"; undefined for anything else. */
const year = (v: unknown) => (typeof v === "string" && /^\d{4}$/.test(v) ? v : undefined);

/**
 * Which files Cargo builds as crates, from each Cargo.toml's text by folder (`.` at the root;
 * null when unreadable), parsed as TOML. Whatever a manifest leaves unknown is unsure, never
 * assumed, and reported in `errors`:
 * - a manifest that is unreadable or not TOML, or a target table of another shape: its folder
 *   in `unsure`, as it could list any file below;
 * - whether Cargo finds a kind's files by itself, when the `auto*` key is not true or false, or
 *   when the answer turns on an edition not read or inherited for certain: that kind in `unknown`.
 */
export function readCargoTargets(manifests: ReadonlyMap<string, string | null>, errors: string[]): RustTargets {
  const targets: RustTargets = { off: new Map(), unknown: new Map(), listed: new Set(), dropped: new Set(), unsure: new Set() };
  const where = (dir: string) => posix.join(dir, "Cargo.toml");
  const unsure = (dir: string, why: string) => {
    targets.unsure.add(dir);
    errors.push(`${where(dir)}: ${why}, so which files below it Cargo builds is unknown`);
  };
  const docs = new Map<string, Table | undefined>();
  for (const [dir, text] of manifests) {
    docs.set(dir, undefined);
    if (text === null) {
      unsure(dir, "unreadable");
      continue;
    }
    try {
      docs.set(dir, parse(text));
    } catch (err) {
      unsure(dir, `not TOML (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
    }
  }
  for (const [dir, doc] of docs) {
    if (!doc) continue;
    // Cargo reads `[project]` as `[package]` before the 2024 edition. With neither, the manifest
    // is a virtual one, which builds no targets.
    const pkg = doc.package ?? doc.project;
    if (pkg === undefined) continue;
    if (!isTable(pkg) || !targetTablesShaped(doc)) {
      unsure(dir, "a package or target table of another shape");
      continue;
    }
    const at = (p: string) => posix.normalize(posix.join(dir, p));
    for (const t of [doc.lib, ...((doc.bin as Table[] | undefined) ?? [])]) if (isTable(t) && typeof t.path === "string") targets.listed.add(at(t.path));
    const edition = packageEdition(dir, pkg, docs);
    for (const [kind, folder] of KINDS) {
      const tables = doc[kind] as Array<{ name: string; path?: string }> | undefined;
      for (const { name, path } of tables ?? []) {
        const named = [`${folder}/${name}.rs`, `${folder}/${name}/main.rs`].map(at);
        // Given another path, the name's own files are no target: Cargo drops a found file whose
        // name a table already uses.
        if (path === undefined) named.forEach((p) => targets.listed.add(p));
        else {
          targets.listed.add(at(path));
          named.forEach((p) => targets.dropped.add(p));
        }
      }
      const finds = findsByItself(pkg[`auto${folder}`], tables !== undefined, edition);
      if (finds === false) targets.off.set(dir, (targets.off.get(dir) ?? new Set()).add(folder));
      if (finds === undefined) {
        targets.unknown.set(dir, (targets.unknown.get(dir) ?? new Set()).add(folder));
        errors.push(`${where(dir)}: \`auto${folder}\` or the edition is not read for certain, so whether Cargo builds each file in ${folder}/ is unknown`);
      }
    }
  }
  return targets;
}

/** Whether Cargo finds a kind's files by itself: the `auto*` key decides; unset, it does unless
 * the package is 2015 and has a table of that kind. Undefined when that is unknown. */
function findsByItself(auto: unknown, tabled: boolean, edition: string | undefined): boolean | undefined {
  if (auto !== undefined) return typeof auto === "boolean" ? auto : undefined;
  if (!tabled) return true;
  return edition === undefined ? undefined : edition !== "2015";
}

/** The package's edition: 2015 when unstated; undefined when neither read nor inherited for certain. */
function packageEdition(dir: string, pkg: Table, docs: ReadonlyMap<string, Table | undefined>): string | undefined {
  if (pkg.edition === undefined) return "2015";
  if (isTable(pkg.edition) && pkg.edition.workspace === true) return inheritedEdition(dir, pkg, docs);
  return year(pkg.edition);
}

/** The `[workspace.package]` edition of the package's workspace root, found as Cargo does: its
 * own `[workspace]`, the folder its `package.workspace` names, else the nearest folder above whose
 * manifest has a `[workspace]` and does not exclude the package ({@link excludes}). Undefined when
 * that root or its edition is uncertain: the walk meets a manifest that is not TOML, a root whose
 * `exclude` or `members` it cannot read, or another package's `package.workspace`, or finds no
 * root in the repo. */
function inheritedEdition(dir: string, pkg: Table, docs: ReadonlyMap<string, Table | undefined>): string | undefined {
  const editionOf = (ws: unknown) => (isTable(ws) && isTable(ws.package) ? year(ws.package.edition) : undefined);
  const own = docs.get(dir)?.workspace;
  if (own !== undefined) return editionOf(own);
  if (pkg.workspace !== undefined) return typeof pkg.workspace === "string" ? editionOf(docs.get(posix.join(dir, pkg.workspace))?.workspace) : undefined;
  for (let d = dir; d !== "."; ) {
    d = posix.dirname(d);
    if (!docs.has(d)) continue;
    const doc = docs.get(d);
    if (doc?.workspace !== undefined) {
      const excluded = isTable(doc.workspace) ? excludes(d, dir, doc.workspace) : undefined;
      if (excluded === undefined) return undefined;
      if (!excluded) return editionOf(doc.workspace);
      continue;
    }
    const member = doc && (doc.package ?? doc.project);
    if (!isTable(member) || member.workspace !== undefined) return undefined;
  }
  return undefined;
}

/** Whether the workspace at `root` excludes the package at `dir`, as Cargo's `is_excluded` reads
 * it: the package's manifest path starts with `root` joined to an `exclude` entry and with no
 * `members` entry, compared component by component as written, globs included, `.` dropped.
 * It is read as Linux and macOS read it, and as Windows does, where a backslash separates and a
 * drive letter makes an entry absolute. An absolute entry may or may not hold the package, as
 * where the repository sits is unknown. Undefined when the 2 readings differ or either is unsure,
 * or when either list is not strings. */
function excludes(root: string, dir: string, ws: Table): boolean | undefined {
  const [exclude, members] = [ws.exclude ?? [], ws.members ?? []];
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
  if (!strings(exclude) || !strings(members)) return undefined;
  const parts = (p: string) => p.split("/").filter((c) => c !== "" && c !== ".");
  const manifest = parts(posix.join(dir, "Cargo.toml"));
  const under = (entry: string, absolute: RegExp) => (absolute.test(entry) ? undefined : [...parts(root), ...parts(entry)].every((c, i) => manifest[i] === c));
  // Whether some entry holds the package: one that does decides, else one that may leaves it unsure.
  const any = (list: string[], read: (entry: string) => boolean | undefined) => {
    const held = list.map(read);
    return held.includes(true) || (held.includes(undefined) ? undefined : false);
  };
  const reading = (read: (entry: string) => boolean | undefined) => {
    const [excluded, member] = [any(exclude, read), any(members, read)];
    return excluded === false || member === true ? false : excluded === true && member === false ? true : undefined;
  };
  const unix = reading((entry) => under(entry, /^\//));
  const windows = reading((entry) => under(entry.replaceAll("\\", "/"), /^\/|^[A-Za-z]:/));
  return unix === windows ? unix : undefined;
}
