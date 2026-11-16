import { posix } from "node:path";
import { parse } from "smol-toml";
import type { RustTargets } from "./resolve.js";

type Table = Record<string, unknown>;
const isTable = (v: unknown): v is Table => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

/** An array of `[[test]]`-style tables, each `name` and `path` a string where present. */
const isTargetList = (v: unknown): v is Array<{ name?: string; path?: string }> =>
  Array.isArray(v) && v.every((t) => isTable(t) && [t.name, t.path].every((s) => s === undefined || typeof s === "string"));

/** An edition as Cargo states one, such as "2018"; undefined for anything else. */
const year = (v: unknown) => (typeof v === "string" && /^\d{4}$/.test(v) ? v : undefined);

/**
 * Which files Cargo builds as test, example and bench crates, from each Cargo.toml's text by
 * folder (`.` at the root; null when unreadable), parsed as TOML. Whatever a manifest leaves
 * unknown is unsure, never assumed:
 * - a manifest that is unreadable or not TOML, or a target table of another shape: its folder,
 *   as it could list any file below;
 * - whether Cargo finds a kind's files by itself, when the `auto*` key is not true or false, or
 *   when the answer turns on an edition not read or inherited for certain: that kind's folder.
 */
export function readCargoTargets(manifests: ReadonlyMap<string, string | null>): RustTargets {
  const targets: RustTargets = { off: new Map(), listed: new Set(), unsure: new Set() };
  const docs = new Map<string, Table | undefined>();
  for (const [dir, text] of manifests) {
    try {
      docs.set(dir, text === null ? undefined : parse(text));
    } catch {
      docs.set(dir, undefined);
    }
  }
  for (const [dir, doc] of docs) {
    if (!doc) {
      targets.unsure.add(dir);
      continue;
    }
    // Cargo reads `[project]` as `[package]` before the 2024 edition. With neither, the manifest
    // is a virtual one, which builds no targets.
    const pkg = doc.package ?? doc.project;
    if (pkg === undefined) continue;
    if (!isTable(pkg)) {
      targets.unsure.add(dir);
      continue;
    }
    const edition = packageEdition(dir, pkg, docs);
    for (const [kind, folder] of [["test", "tests"], ["example", "examples"], ["bench", "benches"]] as const) {
      const tables = doc[kind];
      if (tables !== undefined && !isTargetList(tables)) {
        targets.unsure.add(dir);
        continue;
      }
      for (const { name, path } of tables ?? []) {
        const paths = path ? [path] : [`${folder}/${name}.rs`, `${folder}/${name}/main.rs`];
        if (path || name) for (const p of paths) targets.listed.add(posix.normalize(posix.join(dir, p)));
      }
      const finds = findsByItself(pkg[`auto${folder}`], tables !== undefined, edition);
      if (finds === undefined) targets.unsure.add(posix.join(dir, folder));
      else if (!finds) targets.off.set(dir, (targets.off.get(dir) ?? new Set()).add(folder));
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
 * manifest has a `[workspace]`. Undefined when that root or its edition is uncertain: the walk
 * meets a manifest that is not TOML, a root with an `exclude` list (which Cargo passes over when
 * it names the package), or another package's `package.workspace`, or finds no root in the repo. */
function inheritedEdition(dir: string, pkg: Table, docs: ReadonlyMap<string, Table | undefined>): string | undefined {
  const editionOf = (ws: unknown) => (isTable(ws) && isTable(ws.package) ? year(ws.package.edition) : undefined);
  const own = docs.get(dir)?.workspace;
  if (own !== undefined) return editionOf(own);
  if (pkg.workspace !== undefined) return typeof pkg.workspace === "string" ? editionOf(docs.get(posix.join(dir, pkg.workspace))?.workspace) : undefined;
  for (let d = dir; d !== "."; ) {
    d = posix.dirname(d);
    if (!docs.has(d)) continue;
    const doc = docs.get(d);
    if (doc?.workspace !== undefined) return isTable(doc.workspace) && doc.workspace.exclude === undefined ? editionOf(doc.workspace) : undefined;
    const member = doc && (doc.package ?? doc.project);
    if (!isTable(member) || member.workspace !== undefined) return undefined;
  }
  return undefined;
}
