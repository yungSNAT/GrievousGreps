/**
 * Architecture gate over the wiring graph (`trail gate`, Proposal A).
 *
 * Evaluates named path-glob rules against `GraphV1` edges, enforces definite
 * edges (`extracted`, `lsp_resolved`, `lsp_dispatch`) by default while reporting
 * `likely` and `inferred` edges as warnings unless opted in, and supports a
 * symbol-keyed baseline `(rule, sourceId, targetId)` with ratcheted adoption.
 */
import { spanRange } from "../blast/evidence.js";
import { confidenceRank, parseConfidence } from "../graph/provenance.js";
import { WALK_RELATIONS } from "../graph/relations.js";
import type { Confidence, GraphV1, Relation } from "../graph/types.js";
import { toPosixPath } from "../util/paths.js";
import { compilePosixGlob, matchesCompiledGlob, type CompiledGlob } from "./glob.js";

export type GateFormat = "text" | "json" | "markdown";
export type GateConfidenceThreshold = "extracted" | "likely" | "inferred";

export const DEFAULT_GATE_CONFIG_FILE = "trail.gate.json";
export const DEFAULT_GATE_BASELINE_FILE = "trail.gate.baseline.json";

const ALL_RELATIONS: ReadonlySet<Relation> = new Set<Relation>(["contains", ...WALK_RELATIONS]);

const ALLOWED_CONFIDENCE_THRESHOLDS: ReadonlySet<string> = new Set<string>([
  "extracted",
  "likely",
  "inferred",
]);

const CONFIG_ROOT_KEYS = new Set(["rules"]);
const RULE_KEYS = new Set(["name", "from", "to", "relations", "allowConfidence"]);
const BASELINE_ROOT_KEYS = new Set(["version", "violations"]);
const BASELINE_ENTRY_KEYS = new Set(["rule", "sourceId", "targetId"]);

export interface GateRule {
  name: string;
  from: string[];
  to: string[];
  fromCompiled: CompiledGlob[];
  toCompiled: CompiledGlob[];
  relations: ReadonlySet<Relation>;
  allowConfidence: GateConfidenceThreshold;
}

export interface GateConfig {
  rules: GateRule[];
}

export interface BaselineEntry {
  rule: string;
  sourceId: string;
  targetId: string;
}

export interface GateBaseline {
  version: 1;
  violations: BaselineEntry[];
}

export type ViolationStatus = "new" | "accepted" | "warning";

export interface GateViolation {
  rule: string;
  sourceId: string;
  sourcePath: string;
  sourceLine: number | null;
  sourceSpan: string;
  targetId: string;
  targetPath: string;
  targetLine: number | null;
  relation: Relation;
  confidence: Confidence;
  status: ViolationStatus;
}

export interface GateResult {
  ok: boolean;
  rules: number;
  violations: GateViolation[];
  accepted: GateViolation[];
  warnings: GateViolation[];
  resolved: BaselineEntry[];
  baselineUpdated?: boolean;
  prunedFromBaseline?: number;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>, context: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`unknown key "${key}" in ${context}`);
    }
  }
}

/** Normalize a user-supplied glob pattern to POSIX separators with leading `./` stripped. */
export function normalizeGlob(raw: string): string {
  let out = raw.replaceAll("\\", "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

function parseGlobList(
  raw: unknown,
  field: "from" | "to",
  ruleName: string,
): { globs: string[]; compiled: CompiledGlob[] } {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`rule "${ruleName}" field "${field}" must be a non-empty array of globs`);
  }
  const globs: string[] = [];
  const compiled: CompiledGlob[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`rule "${ruleName}" field "${field}" entries must be non-empty strings`);
    }
    const trimmed = item.trim();
    const norm = normalizeGlob(trimmed);
    if (!norm) {
      throw new Error(`rule "${ruleName}" field "${field}" contains an empty glob "${item}"`);
    }
    if (norm.startsWith("/")) {
      throw new Error(
        `rule "${ruleName}" field "${field}" glob "${item}" must be repo-relative (remove leading "/")`,
      );
    }
    if (norm.endsWith("/")) {
      throw new Error(
        `rule "${ruleName}" field "${field}" glob "${item}" must not end with "/" (use "${norm}**" to match files inside the directory)`,
      );
    }
    const parts = norm.split("/");
    if (parts.some((p) => p === "" || p === "." || p === "..")) {
      throw new Error(
        `rule "${ruleName}" field "${field}" glob "${item}" must be a clean repo-relative path without empty, ".", or ".." segments`,
      );
    }
    compiled.push(compilePosixGlob(norm));
    globs.push(norm);
  }
  return { globs, compiled };
}

function parseRelations(raw: unknown, ruleName: string): ReadonlySet<Relation> {
  if (raw === undefined) return WALK_RELATIONS;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`rule "${ruleName}" field "relations" must be a non-empty array when provided`);
  }
  const set = new Set<Relation>();
  for (const item of raw) {
    if (typeof item !== "string" || !ALL_RELATIONS.has(item as Relation)) {
      throw new Error(
        `rule "${ruleName}" has unknown relation ${JSON.stringify(item)}; expected one of ${[...ALL_RELATIONS].join(", ")}`,
      );
    }
    set.add(item as Relation);
  }
  return set;
}

function parseAllowConfidence(raw: unknown, ruleName: string): GateConfidenceThreshold {
  if (raw === undefined) return "extracted";
  if (typeof raw !== "string" || !ALLOWED_CONFIDENCE_THRESHOLDS.has(raw)) {
    throw new Error(
      `rule "${ruleName}" field "allowConfidence" must be "extracted", "likely", or "inferred", got ${JSON.stringify(raw)}`,
    );
  }
  return raw as GateConfidenceThreshold;
}

/** Validate and normalize a parsed `trail.gate.json` document. */
export function parseGateConfig(raw: unknown): GateConfig {
  if (!isPlainObject(raw)) {
    throw new Error("gate config must be a JSON object");
  }
  assertAllowedKeys(raw, CONFIG_ROOT_KEYS, "gate config");
  if (!Array.isArray(raw.rules)) {
    throw new Error('gate config must contain a "rules" array');
  }
  const seenNames = new Set<string>();
  const rules: GateRule[] = [];
  for (let i = 0; i < raw.rules.length; i++) {
    const item = raw.rules[i];
    if (!isPlainObject(item)) {
      throw new Error(`rules[${i}] must be an object`);
    }
    if (typeof item.name !== "string" || item.name.trim() === "") {
      throw new Error(`rules[${i}].name must be a non-empty string`);
    }
    const name = item.name.trim();
    assertAllowedKeys(item, RULE_KEYS, `rule "${name}"`);
    if (seenNames.has(name)) {
      throw new Error(`duplicate rule name "${name}"`);
    }
    seenNames.add(name);
    const fromParsed = parseGlobList(item.from, "from", name);
    const toParsed = parseGlobList(item.to, "to", name);
    rules.push({
      name,
      from: fromParsed.globs,
      to: toParsed.globs,
      fromCompiled: fromParsed.compiled,
      toCompiled: toParsed.compiled,
      relations: parseRelations(item.relations, name),
      allowConfidence: parseAllowConfidence(item.allowConfidence, name),
    });
  }
  return { rules };
}

/** Validate and normalize a parsed `trail.gate.baseline.json` document. */
export function parseGateBaseline(raw: unknown): GateBaseline {
  if (!isPlainObject(raw)) {
    throw new Error("gate baseline must be a JSON object");
  }
  assertAllowedKeys(raw, BASELINE_ROOT_KEYS, "gate baseline");
  if (raw.version !== 1) {
    throw new Error(`unsupported baseline version ${JSON.stringify(raw.version)}; expected 1`);
  }
  if (!Array.isArray(raw.violations)) {
    throw new Error('gate baseline must contain a "violations" array');
  }
  const deduped = new Map<string, BaselineEntry>();
  for (let i = 0; i < raw.violations.length; i++) {
    const item = raw.violations[i];
    if (!isPlainObject(item)) {
      throw new Error(`violations[${i}] must be an object`);
    }
    assertAllowedKeys(item, BASELINE_ENTRY_KEYS, `violations[${i}]`);
    if (typeof item.rule !== "string" || item.rule.trim() === "") {
      throw new Error(`violations[${i}].rule must be a non-empty string`);
    }
    if (typeof item.sourceId !== "string" || item.sourceId === "") {
      throw new Error(`violations[${i}].sourceId must be a non-empty string`);
    }
    if (typeof item.targetId !== "string" || item.targetId === "") {
      throw new Error(`violations[${i}].targetId must be a non-empty string`);
    }
    const entry: BaselineEntry = {
      rule: item.rule.trim(),
      sourceId: item.sourceId,
      targetId: item.targetId,
    };
    deduped.set(baselineKey(entry.rule, entry.sourceId, entry.targetId), entry);
  }
  return {
    version: 1,
    violations: [...deduped.values()].sort(compareBaselineEntry),
  };
}

export function baselineKey(rule: string, sourceId: string, targetId: string): string {
  return `${rule}\0${sourceId}\0${targetId}`;
}

function compareBaselineEntry(a: BaselineEntry, b: BaselineEntry): number {
  return cmpStr(a.rule, b.rule) || cmpStr(a.sourceId, b.sourceId) || cmpStr(a.targetId, b.targetId);
}

function compareViolation(a: GateViolation, b: GateViolation): number {
  return (
    cmpStr(a.rule, b.rule) ||
    cmpStr(a.sourceId, b.sourceId) ||
    cmpStr(a.targetId, b.targetId) ||
    cmpStr(a.relation, b.relation) ||
    cmpStr(a.confidence, b.confidence)
  );
}

function violationDedupKey(v: GateViolation): string {
  return `${v.rule}\0${v.sourceId}\0${v.targetId}\0${v.relation}\0${v.confidence}`;
}

function matchesAny(path: string, globs: readonly CompiledGlob[]): boolean {
  return globs.some((g) => matchesCompiledGlob(g, path));
}

function normalizeNodePath(path: string): string {
  let out = toPosixPath(path);
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

/** Evaluate architecture rules against a wiring graph and optional baseline. */
export function evaluateGate(
  graph: GraphV1,
  config: GateConfig,
  baseline: GateBaseline | null = null,
): GateResult {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const acceptedMap = new Map<string, BaselineEntry>();
  for (const entry of baseline?.violations ?? []) {
    acceptedMap.set(baselineKey(entry.rule, entry.sourceId, entry.targetId), entry);
  }

  const newMap = new Map<string, GateViolation>();
  const acceptedViolations = new Map<string, GateViolation>();
  const warningMap = new Map<string, GateViolation>();
  const failingKeys = new Set<string>();

  for (const edge of graph.edges) {
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    if (!sourceNode || !targetNode) continue;

    const sourcePath = normalizeNodePath(sourceNode.path);
    const targetPath = normalizeNodePath(targetNode.path);
    const conf = parseConfidence(edge.confidence);
    const confRank = confidenceRank(conf);

    for (const rule of config.rules) {
      if (!rule.relations.has(edge.relation)) continue;
      if (!matchesAny(sourcePath, rule.fromCompiled) || !matchesAny(targetPath, rule.toCompiled)) continue;

      const fails = confRank >= confidenceRank(rule.allowConfidence);
      const bKey = baselineKey(rule.name, edge.source, edge.target);
      const status: ViolationStatus = !fails ? "warning" : acceptedMap.has(bKey) ? "accepted" : "new";

      const record: GateViolation = {
        rule: rule.name,
        sourceId: edge.source,
        sourcePath,
        sourceLine: spanRange(sourceNode.span)?.start ?? null,
        sourceSpan: sourceNode.span,
        targetId: edge.target,
        targetPath,
        targetLine: spanRange(targetNode.span)?.start ?? null,
        relation: edge.relation,
        confidence: conf,
        status,
      };
      const dKey = violationDedupKey(record);

      if (!fails) {
        warningMap.set(dKey, record);
      } else {
        failingKeys.add(bKey);
        if (status === "accepted") {
          acceptedViolations.set(dKey, record);
        } else {
          newMap.set(dKey, record);
        }
      }
    }
  }

  const resolved: BaselineEntry[] = [];
  for (const [key, entry] of acceptedMap) {
    if (!failingKeys.has(key)) resolved.push(entry);
  }

  const violations = [...newMap.values()].sort(compareViolation);
  const accepted = [...acceptedViolations.values()].sort(compareViolation);
  const warnings = [...warningMap.values()].sort(compareViolation);
  resolved.sort(compareBaselineEntry);

  return {
    ok: violations.length === 0,
    rules: config.rules.length,
    violations,
    accepted,
    warnings,
    resolved,
  };
}

/** Build the next baseline document from an evaluation result. */
export function buildBaseline(
  result: GateResult,
  existing: GateBaseline | null,
  opts: { ratchet?: boolean } = {},
): GateBaseline {
  const entries = new Map<string, BaselineEntry>();
  if (opts.ratchet) {
    const resolvedKeys = new Set(result.resolved.map((r) => baselineKey(r.rule, r.sourceId, r.targetId)));
    for (const entry of existing?.violations ?? []) {
      const key = baselineKey(entry.rule, entry.sourceId, entry.targetId);
      if (!resolvedKeys.has(key)) entries.set(key, entry);
    }
  } else {
    for (const v of [...result.accepted, ...result.violations]) {
      const key = baselineKey(v.rule, v.sourceId, v.targetId);
      if (!entries.has(key)) {
        entries.set(key, { rule: v.rule, sourceId: v.sourceId, targetId: v.targetId });
      }
    }
  }
  return {
    version: 1,
    violations: [...entries.values()].sort(compareBaselineEntry),
  };
}

export { formatGateJson, formatGateMarkdown, formatGateText } from "./render.js";
