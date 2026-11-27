/**
 * Text, Markdown, and JSON formatters for `trail gate`.
 */
import type { GateResult, GateViolation } from "./gate.js";

function formatLocation(path: string, line: number | null): string {
  return line !== null ? `${path}:${line}` : path;
}

function formatViolationLine(v: GateViolation): string {
  const loc = formatLocation(v.sourcePath, v.sourceLine);
  return `  [${v.rule}] ${loc} (${v.sourceId}) -(${v.relation}, ${v.confidence})-> ${v.targetId}`;
}

function countSummaryParts(r: GateResult): string[] {
  const parts: string[] = [];
  if (r.accepted.length > 0) parts.push(`${r.accepted.length} accepted`);
  if (r.warnings.length > 0) parts.push(`${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}`);
  if (r.resolved.length > 0) parts.push(`${r.resolved.length} resolved`);
  if (r.prunedFromBaseline && r.prunedFromBaseline > 0) {
    parts.push(`${r.prunedFromBaseline} pruned from baseline`);
  }
  if (r.baselineUpdated) parts.push("baseline updated");
  return parts;
}

export function formatGateText(result: GateResult): string {
  const lines: string[] = [];
  const extras = countSummaryParts(result);
  const extraSuffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
  if (result.ok) {
    lines.push(
      `gate: PASS — 0 new violations across ${result.rules} rule${result.rules === 1 ? "" : "s"}${extraSuffix}`,
    );
  } else {
    lines.push(
      `gate: FAIL — ${result.violations.length} new violation${result.violations.length === 1 ? "" : "s"}${extraSuffix}`,
    );
  }

  if (result.violations.length > 0) {
    lines.push("", `New violations (${result.violations.length}):`);
    for (const v of result.violations) lines.push(formatViolationLine(v));
  }
  if (result.warnings.length > 0) {
    lines.push("", `Warnings (${result.warnings.length}, non-failing confidence):`);
    for (const w of result.warnings) lines.push(formatViolationLine(w));
  }
  if (result.resolved.length > 0) {
    lines.push("", `Resolved baseline entries (${result.resolved.length}):`);
    for (const r of result.resolved) lines.push(`  [${r.rule}] ${r.sourceId} -> ${r.targetId}`);
  }
  return lines.join("\n") + "\n";
}

function escapeMdCell(s: string): string {
  return s.replace(/[\r\n]+/g, " ").replaceAll("|", "\\|");
}

function mdCode(s: string): string {
  const clean = s.replace(/[\r\n]+/g, " ");
  if (!clean.includes("`")) return `\`${clean}\``;
  let fence = "``";
  while (clean.includes(fence)) fence += "`";
  const pad = clean.startsWith("`") || clean.endsWith("`") ? " " : "";
  return `${fence}${pad}${clean}${pad}${fence}`;
}

function renderMarkdownTable(items: readonly GateViolation[]): string[] {
  const lines = [
    "| Rule | Source | Edge | Target | Confidence |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const v of items) {
    const src = `${escapeMdCell(formatLocation(v.sourcePath, v.sourceLine))} (${escapeMdCell(mdCode(v.sourceId))})`;
    lines.push(
      `| ${escapeMdCell(v.rule)} | ${src} | ${v.relation} | ${escapeMdCell(mdCode(v.targetId))} | ${v.confidence} |`,
    );
  }
  return lines;
}

export function formatGateMarkdown(result: GateResult): string {
  let summary = `Rules: ${result.rules} · New: ${result.violations.length} · Accepted: ${result.accepted.length} · Warnings: ${result.warnings.length} · Resolved: ${result.resolved.length}`;
  if (result.baselineUpdated) summary += " · Baseline updated";
  if (result.prunedFromBaseline !== undefined && result.prunedFromBaseline > 0) {
    summary += ` · Pruned: ${result.prunedFromBaseline}`;
  }
  const lines: string[] = [
    `## Architecture Gate: ${result.ok ? "PASS" : "FAIL"}`,
    "",
    summary,
  ];
  if (result.violations.length > 0) {
    lines.push("", `### New violations (${result.violations.length})`, "", ...renderMarkdownTable(result.violations));
  }
  if (result.warnings.length > 0) {
    lines.push("", `### Warnings (${result.warnings.length})`, "", ...renderMarkdownTable(result.warnings));
  }
  if (result.resolved.length > 0) {
    lines.push("", `### Resolved baseline entries (${result.resolved.length})`, "");
    for (const r of result.resolved) {
      lines.push(`- ${mdCode(r.rule)}: ${mdCode(r.sourceId)} -> ${mdCode(r.targetId)}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function formatGateJson(result: GateResult): string {
  const payload = {
    ok: result.ok,
    rules: result.rules,
    summary: {
      new: result.violations.length,
      accepted: result.accepted.length,
      warnings: result.warnings.length,
      resolved: result.resolved.length,
      ...(result.prunedFromBaseline !== undefined && { prunedFromBaseline: result.prunedFromBaseline }),
    },
    violations: result.violations,
    accepted: result.accepted,
    warnings: result.warnings,
    resolved: result.resolved,
    ...(result.baselineUpdated !== undefined && { baselineUpdated: result.baselineUpdated }),
  };
  return JSON.stringify(payload, null, 2) + "\n";
}
