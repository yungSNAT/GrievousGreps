/**
 * CLI wiring for `trail gate`: loads the wiring graph, rejects missing or stale
 * graphs, validates config and baseline safely inside the repo, runs rule
 * evaluation, and writes baseline updates/ratchets atomically.
 */
import { dirname, resolve } from "node:path";
import { cmd } from "../brand.js";
import { assertRealContextDir, contextDirFor } from "../context/node-file.js";
import { driftCount, isClean, probeDrift, type Drift } from "../graph/fingerprint.js";
import { readGraph, wiringPath } from "../graph/write.js";
import { readFileInside, resolveInside, trustedBaseFor, writeFileInside } from "../util/safe-fs.js";
import {
  buildBaseline,
  DEFAULT_GATE_BASELINE_FILE,
  DEFAULT_GATE_CONFIG_FILE,
  evaluateGate,
  formatGateJson,
  formatGateMarkdown,
  formatGateText,
  parseGateBaseline,
  parseGateConfig,
  type GateBaseline,
  type GateConfig,
  type GateFormat,
} from "./gate.js";

export interface GateCliOptions {
  config?: string;
  baseline?: string;
  updateBaseline?: boolean;
  ratchet?: boolean;
  format?: string;
  globalDir?: string;
}

function resolveFormat(raw: string | undefined): GateFormat | null {
  if (raw === undefined) return "text";
  if (raw === "text" || raw === "json" || raw === "markdown") return raw;
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function staleSample(drift: Drift): string {
  const files = [...drift.changed, ...drift.added, ...drift.removed];
  const shown = files.slice(0, 3).join(", ");
  return files.length > 3 ? `${shown}, … (+${files.length - 3} more)` : shown;
}

function readCheckedText(root: string, filePath: string): string | null {
  const base = trustedBaseFor(root, filePath);
  resolveInside(base, filePath);
  return readFileInside(base, filePath);
}

export async function runGateCommand(dir: string, opts: GateCliOptions = {}): Promise<number> {
  const format = resolveFormat(opts.format);
  if (!format) {
    console.error(`✗ --format must be text, markdown, or json, got "${opts.format}"`);
    return 2;
  }

  const root = resolve(dir);
  let contextDir: string;
  try {
    contextDir = contextDirFor(root, opts.globalDir);
    assertRealContextDir(root, contextDir);
  } catch (err) {
    console.error(`✗ ${errorMessage(err)}`);
    return 2;
  }

  const graph = readGraph(wiringPath(contextDir), dirname(contextDir));
  if (!graph) {
    console.error(`✗ no graph found at ${contextDir} — run \`${cmd("graft build")}\` first`);
    return 2;
  }

  const drift = probeDrift(root, contextDir);
  if (drift === null) {
    console.error(`✗ graph at ${contextDir} has no build fingerprint (stale) — run \`${cmd("graft build")}\` first`);
    return 2;
  }
  if (!isClean(drift)) {
    const n = driftCount(drift);
    console.error(
      `✗ graph is stale (${n} file${n === 1 ? "" : "s"} changed since last build: ${staleSample(drift)}) — run \`${cmd("graft build")}\` first`,
    );
    return 2;
  }

  const configPath = resolve(root, opts.config ?? DEFAULT_GATE_CONFIG_FILE);
  let config: GateConfig;
  try {
    const rawText = readCheckedText(root, configPath);
    if (rawText === null) {
      console.error(`✗ no gate config found at ${configPath}`);
      return 2;
    }
    config = parseGateConfig(JSON.parse(rawText));
  } catch (err) {
    console.error(`✗ invalid gate config (${configPath}): ${errorMessage(err)}`);
    return 2;
  }

  const baselinePath = resolve(root, opts.baseline ?? DEFAULT_GATE_BASELINE_FILE);
  let existingBaseline: GateBaseline | null = null;
  try {
    const rawBaseline = readCheckedText(root, baselinePath);
    if (rawBaseline !== null) {
      existingBaseline = parseGateBaseline(JSON.parse(rawBaseline));
    }
  } catch (err) {
    console.error(`✗ invalid gate baseline (${baselinePath}): ${errorMessage(err)}`);
    return 2;
  }

  let result = evaluateGate(graph, config, existingBaseline);

  if (opts.updateBaseline || opts.ratchet) {
    const ratchet = Boolean(opts.ratchet);
    const nextBaseline = buildBaseline(result, existingBaseline, { ratchet });
    const shouldWrite = Boolean(opts.updateBaseline) || (existingBaseline !== null && result.resolved.length > 0);
    const pruned = ratchet ? result.resolved.length : 0;
    if (shouldWrite) {
      try {
        const base = trustedBaseFor(root, baselinePath);
        writeFileInside(base, baselinePath, JSON.stringify(nextBaseline, null, 2) + "\n", { atomic: true });
      } catch (err) {
        console.error(`✗ failed to write baseline (${baselinePath}): ${errorMessage(err)}`);
        return 2;
      }
    }
    result = evaluateGate(graph, config, nextBaseline);
    result.baselineUpdated = shouldWrite;
    if (pruned > 0) result.prunedFromBaseline = pruned;
  }

  if (format === "json") {
    process.stdout.write(formatGateJson(result));
  } else if (format === "markdown") {
    process.stdout.write(formatGateMarkdown(result));
  } else {
    process.stdout.write(formatGateText(result));
  }

  return result.ok ? 0 : 1;
}
