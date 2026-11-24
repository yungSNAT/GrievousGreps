/**
 * God-node / hub summary for cold-start repository orientation.
 *
 * Mirrors `rust/gg-query/src/hubs.rs`: ranks connected symbols by global
 * uniform-seed PageRank (reusing `src/ask/graphrank.ts`) alongside directed
 * walk-edge degrees and `EXTRACTED` vs `INFERRED` edge counts in compact,
 * bounded output.
 */
import type { GraphV1, NodeV1 } from "./types.js";
import { WALK_RELATIONS } from "./relations.js";
import { assertPrefixIndexed, pathUnderPrefix } from "./scopes.js";
import { normalizePathPrefix } from "../util/paths.js";
import { personalizedPageRankPrepared, preparePageRankTopology } from "../ask/graphrank.js";
import { savingsFor, withSavings, type Savings } from "../context/savings.js";
import { parseConfidence, provenanceOf } from "./provenance.js";

export const DEFAULT_HUB_LIMIT = 15;
export const MAX_HUB_LIMIT = 100;

export interface HubEntry {
  id: string;
  name: string;
  kind: string;
  path: string;
  span: string;
  pagerank: number;
  inDegree: number;
  outDegree: number;
  totalDegree: number;
  extractedEdges: number;
  inferredEdges: number;
}

export interface HubsTotals {
  totalSymbols: number;
  connectedSymbols: number;
  walkEdges: number;
  shown: number;
  truncated: number;
}

export interface HubsReport {
  prefix?: string;
  totals: HubsTotals;
  hubs: HubEntry[];
  saved?: Savings;
}

export interface HubsOptions {
  limit?: number;
  in?: string;
}

interface DegreeCounts {
  inDeg: number;
  outDeg: number;
  extracted: number;
  inferred: number;
}

export function parseHubLimit(raw: string | number | undefined): number {
  if (raw === undefined) return DEFAULT_HUB_LIMIT;
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`--limit must be an integer between 1 and ${MAX_HUB_LIMIT}, got "${raw}"`);
    }
    n = Number.parseInt(trimmed, 10);
  }
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > MAX_HUB_LIMIT) {
    throw new Error(`--limit must be an integer between 1 and ${MAX_HUB_LIMIT}, got "${raw}"`);
  }
  return n;
}

function round6(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

function groupDigits(n: number): string {
  return n.toLocaleString("en-US");
}

function compareHubs(a: HubEntry, b: HubEntry): number {
  return (
    b.pagerank - a.pagerank ||
    b.inDegree - a.inDegree ||
    b.totalDegree - a.totalDegree ||
    a.name.localeCompare(b.name) ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function computeHubs(graph: GraphV1, opts: HubsOptions = {}): HubsReport {
  const limit = parseHubLimit(opts.limit);
  let prefix: string | undefined;
  if (opts.in) {
    prefix = normalizePathPrefix(opts.in);
    assertPrefixIndexed(graph, prefix);
  }

  const symbols: NodeV1[] = [];
  const symbolIds = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind === "file" || node.kind === "resource") continue;
    symbols.push(node);
    symbolIds.add(node.id);
  }

  const counts = new Map<string, DegreeCounts>();
  const bump = (id: string): DegreeCounts => {
    let rec = counts.get(id);
    if (!rec) {
      rec = { inDeg: 0, outDeg: 0, extracted: 0, inferred: 0 };
      counts.set(id, rec);
    }
    return rec;
  };

  let walkEdges = 0;
  for (const edge of graph.edges) {
    if (!WALK_RELATIONS.has(edge.relation)) continue;
    const hasSrc = symbolIds.has(edge.source);
    const hasDst = symbolIds.has(edge.target);
    const isInferred = provenanceOf(parseConfidence(edge.confidence)) === "INFERRED";
    if (hasSrc) {
      const rec = bump(edge.source);
      rec.outDeg++;
      if (isInferred) rec.inferred++;
      else rec.extracted++;
    }
    if (hasDst) {
      const rec = bump(edge.target);
      rec.inDeg++;
      if (isInferred) rec.inferred++;
      else rec.extracted++;
    }
    if (hasSrc && hasDst && edge.source !== edge.target) {
      walkEdges++;
    }
  }

  const topo = preparePageRankTopology(graph, (id) => symbolIds.has(id));
  const seeds = new Map<string, number>();
  for (const [id, c] of counts) {
    if (c.inDeg + c.outDeg > 0) seeds.set(id, 1);
  }
  const prScores = personalizedPageRankPrepared(topo, seeds, { alpha: 0.25, iters: 25 });

  const entries: HubEntry[] = [];
  let totalSymbols = 0;
  const seenPaths: string[] = [];

  for (const sym of symbols) {
    if (prefix && !pathUnderPrefix(sym.path, prefix)) continue;
    totalSymbols++;
    seenPaths.push(sym.path);
    const c = counts.get(sym.id);
    if (!c) continue;
    const totalDegree = c.inDeg + c.outDeg;
    if (totalDegree === 0) continue;
    entries.push({
      id: sym.id,
      name: sym.name,
      kind: sym.kind,
      path: sym.path,
      span: sym.span,
      pagerank: round6(prScores.get(sym.id) ?? 0),
      inDegree: c.inDeg,
      outDegree: c.outDeg,
      totalDegree,
      extractedEdges: c.extracted,
      inferredEdges: c.inferred,
    });
  }

  entries.sort(compareHubs);
  const connectedSymbols = entries.length;
  const shown = Math.min(connectedSymbols, limit);
  const truncated = Math.max(0, connectedSymbols - shown);
  const hubs = entries.slice(0, shown);
  const saved = savingsFor(graph, seenPaths);

  return {
    ...(prefix ? { prefix } : {}),
    totals: { totalSymbols, connectedSymbols, walkEdges, shown, truncated },
    hubs,
    ...(saved ? { saved } : {}),
  };
}

export function formatHubsText(report: HubsReport): string {
  const scope = report.prefix ? ` under ${report.prefix}/` : "";
  const lines = [
    `hubs${scope} · ${groupDigits(report.totals.shown)} of ${groupDigits(report.totals.connectedSymbols)} connected symbols (${groupDigits(report.totals.totalSymbols)} total symbols, ${groupDigits(report.totals.walkEdges)} walk edges)`,
  ];
  if (report.hubs.length === 0) {
    lines.push("  no connected symbols in graph");
  } else {
    for (let i = 0; i < report.hubs.length; i++) {
      const h = report.hubs[i];
      lines.push(
        `  ${i + 1}. ${h.name} (${h.kind}) · ${h.path}:${h.span} · pr ${h.pagerank.toFixed(2)} · deg ${h.totalDegree} (in ${h.inDegree}, out ${h.outDegree} · ${h.extractedEdges} EXTRACTED, ${h.inferredEdges} INFERRED)`,
      );
    }
    if (report.totals.truncated > 0) {
      lines.push(
        `  … and ${groupDigits(report.totals.truncated)} more connected symbol(s) (pass --limit <n> to show more)`,
      );
    }
  }
  return withSavings(`${lines.join("\n")}\n`, report.saved);
}
