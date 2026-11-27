/**
 * CLI wiring for `trail gate`: loads the wiring graph, rejects missing or stale
 * graphs, validates config and baseline inside the repository root, runs rule
 * evaluation, and writes baseline updates/ratchets atomically.
 */
import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cmd } from "../brand.js";
import { assertRealContextDir, contextDirFor } from "../context/node-file.js";
import { driftCount, isClean, probeDrift, type Drift } from "../graph/fingerprint.js";
import type { GraphV1 } from "../graph/types.js";
import { readGraph, wiringPath } from "../graph/write.js";
import { readFileInside, resolveInside, writeFileInside } from "../util/safe-fs.js";
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

function isValidGraph(graph: unknown): graph is GraphV1 {
  if (typeof graph !== "object" || graph === null) return false;
  const g = graph as Partial<GraphV1>;
  return (
    typeof g.meta === "object" &&
    g.meta !== null &&
    g.meta.version === 1 &&
    Array.isArray(g.nodes) &&
    Array.isArray(g.edges)
  );
}

function readConfinedFile(root: string, filePath: string, label: string): string | null {
  const abs = resolveInside(root, filePath);
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (!st.isFile()) {
    throw new Error(`${label} at ${abs} is not a regular file`);
  }
  return readFileInside(root, abs);
}

export async function runGateCommand(dir: string, opts: GateCliOptions = {}): Promise<number> {
  const format = resolveFormat(opts.format);
  if (!format) {
    console.error(`✗ --format must be text, markdown, or json, got "${opts.format}"`);
    return 2;
  }

  if (opts.ratchet && !opts.updateBaseline) {
    console.error("✗ --ratchet requires --update-baseline");
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
  if (!isValidGraph(graph)) {
    console.error(`✗ invalid wiring graph at ${wiringPath(contextDir)} — run \`${cmd("graft build")}\` first`);
    return 2;
  }

  let drift: Drift | null;
  try {
    drift = probeDrift(root, contextDir);
  } catch (err) {
    console.error(`✗ failed to check graph freshness: ${errorMessage(err)} — run \`${cmd("graft build")}\` first`);
    return 2;
  }
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
    const rawText = readConfinedFile(root, configPath, "gate config");
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
    const rawBaseline = readConfinedFile(root, baselinePath, "gate baseline");
    if (rawBaseline === null) {
      if (opts.baseline !== undefined && !opts.updateBaseline) {
        console.error(`✗ gate baseline not found at ${baselinePath}`);
        return 2;
      }
    } else {
      existingBaseline = parseGateBaseline(JSON.parse(rawBaseline));
    }
  } catch (err) {
    console.error(`✗ invalid gate baseline (${baselinePath}): ${errorMessage(err)}`);
    return 2;
  }

  let result = evaluateGate(graph, config, existingBaseline);

  if (opts.updateBaseline) {
    const ratchet = Boolean(opts.ratchet);
    const nextBaseline = buildBaseline(result, existingBaseline, { ratchet });
    const pruned = ratchet ? result.resolved.length : 0;
    try {
      writeFileInside(root, baselinePath, JSON.stringify(nextBaseline, null, 2) + "\n", { atomic: true });
    } catch (err) {
      console.error(`✗ failed to write baseline (${baselinePath}): ${errorMessage(err)}`);
      return 2;
    }
    result = evaluateGate(graph, config, nextBaseline);
    result.baselineUpdated = true;
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
