/**
 * Edge provenance (`EXTRACTED` vs `INFERRED`) and weakest-hop confidence rating.
 *
 * Mirrors `rust/gg-query/src/provenance.rs`: distinguishes AST/compiler-verified
 * links from heuristic/inferred links and rates multi-hop paths by their weakest
 * hop.
 */
import type { Confidence, NodeV1, Relation, UnresolvedCallV1 } from "./types.js";
import { withSavings, type Savings } from "../context/savings.js";
import { isTestPath } from "../util/paths.js";

export type EdgeProvenance = "EXTRACTED" | "INFERRED";

export interface WeakestHop {
  from: string;
  to: string;
  relation: Relation;
  confidence: Confidence;
  provenance: EdgeProvenance;
  depth: number;
}

export interface ProvenanceHitView {
  node: NodeV1 | null;
  id: string;
  relation: Relation;
  depth: number;
  inferred?: true;
  confidence?: Confidence;
  weakestHop?: WeakestHop;
}

export interface ProvenanceSummary {
  extracted: number;
  inferred: number;
  weakestConfidence: Confidence | null;
  weakestProvenance: EdgeProvenance | null;
}

export interface ProvenanceHitJson {
  id: string;
  name?: string;
  kind?: string;
  path?: string;
  span?: string;
  relation: string;
  depth: number;
  inferred?: true;
  provenance: EdgeProvenance;
  weakestConfidence: Confidence;
  weakestHop?: WeakestHop;
}

export interface ProvenanceMatchJson {
  symbol: { id: string; name: string; kind: string; path: string; span: string };
  provenanceSummary: ProvenanceSummary;
  hits: ProvenanceHitJson[];
  unresolvedCalls?: UnresolvedCallV1[];
}

const CONFIDENCE_RANK: Record<Confidence, number> = {
  lsp_resolved: 3,
  lsp_dispatch: 2,
  extracted: 1,
  inferred: 0,
};

/** Parse an edge confidence string, failing closed to `"inferred"` on unknown values. */
export function parseConfidence(raw: string | undefined): Confidence {
  if (raw === "lsp_resolved" || raw === "lsp_dispatch" || raw === "extracted" || raw === "inferred") {
    return raw;
  }
  return "inferred";
}

export function confidenceRank(confidence: Confidence): number {
  return CONFIDENCE_RANK[confidence];
}

export function provenanceOf(confidence: Confidence): EdgeProvenance {
  return confidence === "inferred" ? "INFERRED" : "EXTRACTED";
}

export function weakestConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

export function effectiveConfidence(hit: Pick<ProvenanceHitView, "confidence" | "inferred">): Confidence {
  if (hit.confidence) return hit.confidence;
  return hit.inferred ? "inferred" : "extracted";
}

export function summariseProvenance(hits: readonly ProvenanceHitView[]): ProvenanceSummary {
  let extracted = 0;
  let inferred = 0;
  let weakest: Confidence | null = null;
  for (const hit of hits) {
    const conf = effectiveConfidence(hit);
    if (provenanceOf(conf) === "INFERRED") inferred++;
    else extracted++;
    weakest = weakest === null ? conf : weakestConfidence(weakest, conf);
  }
  return {
    extracted,
    inferred,
    weakestConfidence: weakest,
    weakestProvenance: weakest ? provenanceOf(weakest) : null,
  };
}

function provenanceTag(hit: ProvenanceHitView): string {
  const conf = effectiveConfidence(hit);
  const prov = provenanceOf(conf);
  if (hit.depth > 1) {
    if (hit.weakestHop) {
      return ` [${prov} · weakest: ${hit.weakestHop.confidence} @ hop ${hit.weakestHop.depth}]`;
    }
    return ` [${prov} · weakest: ${conf}]`;
  }
  if (conf === "lsp_resolved" || conf === "lsp_dispatch") {
    return ` [${prov} · ${conf}]`;
  }
  return ` [${prov}]`;
}

export interface ProvenanceTextOptions {
  direction: "in" | "out";
  showDepth: boolean;
  results: { symbol: NodeV1; hits: ProvenanceHitView[] }[];
  quote?: (hit: ProvenanceHitView, name: string) => { n: number; text: string } | undefined;
  unresolvedNote?: (name: string) => string | null;
  saved?: Savings;
}

export function formatProvenanceText(opts: ProvenanceTextOptions): string {
  const arrow = opts.direction === "out" ? "→" : "←";
  const label = opts.direction === "out" ? "callees" : "callers";
  const blocks: string[] = [];
  for (const { symbol, hits } of opts.results) {
    const lines = [`${symbol.name} · ${symbol.kind} · ${symbol.path}:${symbol.span}`];
    if (hits.length === 0) {
      lines.push(`  no indexed ${label} for ${symbol.name}`);
    } else {
      const summary = summariseProvenance(hits);
      if (summary.weakestProvenance && summary.weakestConfidence) {
        lines.push(
          `  provenance: ${summary.extracted} EXTRACTED, ${summary.inferred} INFERRED · weakest: ${summary.weakestProvenance} (${summary.weakestConfidence})`,
        );
      }
      for (const hit of hits) {
        const depthTag = opts.showDepth ? ` [depth ${hit.depth}]` : "";
        const tag = provenanceTag(hit);
        if (!hit.node) {
          lines.push(`  ${hit.relation} ${arrow} ${hit.id} (unresolved import)${depthTag}${tag}`);
          continue;
        }
        const q = hit.depth === 1 && !isTestPath(hit.node.path) ? opts.quote?.(hit, symbol.name) : undefined;
        if (q) {
          lines.push(`  ${hit.relation} ${arrow} ${hit.node.name} (${hit.node.path}:L${q.n})${depthTag}${tag}: ${q.text.trim()}`);
        } else {
          lines.push(`  ${hit.relation} ${arrow} ${hit.node.name} (${hit.node.path}:${hit.node.span})${depthTag}${tag}`);
        }
      }
    }
    const note = opts.unresolvedNote?.(symbol.name);
    if (note) lines.push(note);
    blocks.push(lines.join("\n"));
  }
  return withSavings(`${blocks.join("\n\n")}\n`, opts.saved);
}

export function provenanceMatchJson(
  r: { symbol: NodeV1; hits: ProvenanceHitView[] },
  unresolvedCalls?: UnresolvedCallV1[],
): ProvenanceMatchJson {
  const hits: ProvenanceHitJson[] = r.hits.map((h) => {
    const conf = effectiveConfidence(h);
    const out: ProvenanceHitJson = {
      id: h.id,
      relation: h.relation,
      depth: h.depth,
      ...(h.inferred ? { inferred: true as const } : {}),
      provenance: provenanceOf(conf),
      weakestConfidence: conf,
      ...(h.weakestHop ? { weakestHop: h.weakestHop } : {}),
    };
    if (h.node) {
      out.name = h.node.name;
      out.kind = h.node.kind;
      out.path = h.node.path;
      out.span = h.node.span;
    }
    return out;
  });
  const out: ProvenanceMatchJson = {
    symbol: {
      id: r.symbol.id,
      name: r.symbol.name,
      kind: r.symbol.kind,
      path: r.symbol.path,
      span: r.symbol.span,
    },
    provenanceSummary: summariseProvenance(r.hits),
    hits,
  };
  if (unresolvedCalls && unresolvedCalls.length > 0) out.unresolvedCalls = unresolvedCalls;
  return out;
}
