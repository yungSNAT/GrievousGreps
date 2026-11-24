/**
 * Polyglot auto-detection audit for `build` and `init`.
 *
 * Reports every indexed language with file counts and explicitly warns about
 * present source-code extensions that were skipped (no parser, excluded by
 * `--extensions`, or outside `--only`), so multi-language repositories never
 * suffer silent blind spots.
 */
import { extname, resolve, sep } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { walkDir } from "../ingest/fs.js";
import { relPosix } from "../util/paths.js";
import { readFollowNestedRepos, readFollowSubmodules, readIncludeDirs } from "../util/state.js";
import { containerLangOf } from "./container.js";
import { deployFormatOf } from "./deploy.js";
import { languageLabelOf, languageOf } from "./extract.js";
import { genericLangOf } from "./generic.js";
import { listSourceFiles, normalizeExtensions, supportedExtensions } from "./source-files.js";

export type SkipReason = "unsupported" | "excluded_by_extensions" | "excluded_by_only_dirs";

export interface DetectedLanguage {
  language: string;
  files: number;
  extensions: string[];
}

export interface SkippedSourceExtension {
  extension: string;
  language: string;
  files: number;
  reason: SkipReason;
}

export interface PolyglotAudit {
  detected: DetectedLanguage[];
  skipped: SkippedSourceExtension[];
}

export interface PolyglotAuditOptions {
  extensions?: readonly string[];
  onlyDirs?: ReadonlySet<string>;
}

/**
 * Known programming, shader, schema and UI template source extensions beyond
 * documentation, configuration and asset formats. Any extension already claimed
 * by a built-in grammar is handled dynamically via `supportedExtensions()`.
 */
const KNOWN_SOURCE_EXTENSIONS: Readonly<Record<string, string>> = {
  ".ada": "Ada",
  ".adb": "Ada",
  ".ads": "Ada",
  ".asm": "Assembly",
  ".avdl": "Avro IDL",
  ".bicep": "Bicep",
  ".cairo": "Cairo",
  ".capnp": "Cap'n Proto",
  ".cbl": "COBOL",
  ".cob": "COBOL",
  ".coffee": "CoffeeScript",
  ".cr": "Crystal",
  ".cu": "CUDA",
  ".cuh": "CUDA",
  ".d": "D",
  ".el": "Emacs Lisp",
  ".erl": "Erlang",
  ".fbs": "FlatBuffers",
  ".fs": "F#",
  ".fsi": "F#",
  ".fsx": "F#",
  ".gql": "GraphQL",
  ".graphql": "GraphQL",
  ".hcl": "HCL",
  ".hlsl": "HLSL",
  ".hrl": "Erlang",
  ".hx": "Haxe",
  ".lisp": "Common Lisp",
  ".lsp": "Common Lisp",
  ".mojo": "Mojo",
  ".move": "Move",
  ".nim": "Nim",
  ".odin": "Odin",
  ".pas": "Pascal",
  ".proto": "Protocol Buffers",
  ".raku": "Raku",
  ".rkt": "Racket",
  ".s": "Assembly",
  ".scm": "Scheme",
  ".sql": "SQL",
  ".sv": "SystemVerilog",
  ".thrift": "Thrift",
  ".v": "Verilog/V",
  ".vb": "Visual Basic",
  ".vhd": "VHDL",
  ".vhdl": "VHDL",
  ".vy": "Vyper",
  ".wat": "WebAssembly Text",
  ".wgsl": "WGSL",
  ".wit": "WebAssembly WIT",
};

const MAX_WARNING_EXTENSIONS = 10;

function supportedLanguageLabel(filePath: string): string | null {
  const depthLabel = languageLabelOf(filePath);
  if (depthLabel) return depthLabel;
  const depth = languageOf(filePath);
  if (depth) return depth;
  const container = containerLangOf(filePath);
  if (container) return container.name;
  const generic = genericLangOf(filePath);
  if (generic) return generic.name;
  const deploy = deployFormatOf(filePath);
  if (deploy) return "deploy";
  return null;
}

function insideOnlyDirs(rel: string, onlyDirs?: ReadonlySet<string>): boolean {
  if (!onlyDirs || onlyDirs.size === 0) return true;
  for (const d of onlyDirs) {
    if (rel === d || rel.startsWith(`${d}/`)) return true;
  }
  return false;
}

/**
 * Audit a repository's walked file set against its indexed file set.
 * Runs in one linear pass over `repoFiles` with zero extra disk I/O.
 */
export function auditPolyglotFiles(
  root: string,
  outDir: string,
  repoFiles: readonly string[],
  indexedFiles: readonly string[],
  opts: PolyglotAuditOptions = {},
): PolyglotAudit {
  const absRoot = resolve(root);
  const absOut = resolve(outDir);
  const absOutPrefix = absOut.endsWith(sep) ? absOut : `${absOut}${sep}`;
  const indexedSet = new Set(indexedFiles.map((f) => resolve(f)));
  const supportedSet = new Set(supportedExtensions());
  const selectedExts = normalizeExtensions(opts.extensions);
  const selectedSet = selectedExts ? new Set(selectedExts) : null;

  const detectedMap = new Map<string, { files: number; exts: Set<string> }>();
  for (const file of indexedFiles) {
    const label = supportedLanguageLabel(file);
    if (!label) continue;
    const ext = extname(file).toLowerCase();
    let rec = detectedMap.get(label);
    if (!rec) {
      rec = { files: 0, exts: new Set() };
      detectedMap.set(label, rec);
    }
    rec.files++;
    if (ext) rec.exts.add(ext);
  }

  const skippedMap = new Map<string, SkippedSourceExtension>();
  for (const file of repoFiles) {
    const absFile = resolve(file);
    if (absFile === absOut || absFile.startsWith(absOutPrefix) || indexedSet.has(absFile)) continue;
    const ext = extname(absFile).toLowerCase();
    if (!ext) continue;

    let reason: SkipReason | null = null;
    let language: string | null = null;

    if (supportedSet.has(ext)) {
      const rel = relPosix(absRoot, absFile);
      if (!insideOnlyDirs(rel, opts.onlyDirs)) {
        reason = "excluded_by_only_dirs";
      } else if (selectedSet && !selectedSet.has(ext)) {
        reason = "excluded_by_extensions";
      }
      language = supportedLanguageLabel(absFile);
    } else if (Object.prototype.hasOwnProperty.call(KNOWN_SOURCE_EXTENSIONS, ext)) {
      reason = "unsupported";
      language = KNOWN_SOURCE_EXTENSIONS[ext];
    }

    if (!reason || !language) continue;
    const key = `${ext}\0${reason}`;
    const existing = skippedMap.get(key);
    if (existing) {
      existing.files++;
    } else {
      skippedMap.set(key, { extension: ext, language, files: 1, reason });
    }
  }

  const detected: DetectedLanguage[] = [...detectedMap.entries()]
    .map(([language, rec]) => ({
      language,
      files: rec.files,
      extensions: [...rec.exts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    }))
    .sort((a, b) => b.files - a.files || (a.language < b.language ? -1 : a.language > b.language ? 1 : 0));

  const skipped: SkippedSourceExtension[] = [...skippedMap.values()].sort(
    (a, b) => b.files - a.files || (a.extension < b.extension ? -1 : a.extension > b.extension ? 1 : 0),
  );

  return { detected, skipped };
}

/** Convenience audit for `init` when the graph is already built or `--no-build` is passed. */
export function auditPolyglotRepo(
  root: string,
  globalDir?: string,
  opts: PolyglotAuditOptions = {},
): PolyglotAudit {
  const absRoot = resolve(root);
  const outDir = contextDirFor(absRoot, globalDir);
  const repoFiles = walkDir(absRoot, readIncludeDirs(absRoot), {
    followSubmodules: readFollowSubmodules(absRoot),
    followNestedRepos: readFollowNestedRepos(absRoot),
  });
  const indexed = listSourceFiles(absRoot, outDir, repoFiles, opts.onlyDirs, opts.extensions);
  return auditPolyglotFiles(absRoot, outDir, repoFiles, indexed, opts);
}

function reasonText(reason: SkipReason): string {
  switch (reason) {
    case "excluded_by_extensions":
      return "excluded by -e";
    case "excluded_by_only_dirs":
      return "outside --only";
    case "unsupported":
      return "no parser";
  }
}

/** Format human-readable detected-languages line and optional warning line for skipped extensions. */
export function formatPolyglotAuditLines(audit: PolyglotAudit): {
  detectedLine: string | null;
  warningLine: string | null;
} {
  const detectedLine =
    audit.detected.length > 0
      ? `languages: ${audit.detected.map((d) => `${d.language} (${d.files})`).join(", ")}`
      : null;

  if (audit.skipped.length === 0) {
    return { detectedLine, warningLine: null };
  }
  const shown = audit.skipped.slice(0, MAX_WARNING_EXTENSIONS);
  const parts = shown.map(
    (s) => `${s.extension} (${s.language}, ${s.files} file${s.files === 1 ? "" : "s"}: ${reasonText(s.reason)})`,
  );
  const more = audit.skipped.length > MAX_WARNING_EXTENSIONS
    ? ` and ${audit.skipped.length - MAX_WARNING_EXTENSIONS} more`
    : "";
  return {
    detectedLine,
    warningLine: `⚠ unindexed source extensions: ${parts.join(", ")}${more}`,
  };
}
