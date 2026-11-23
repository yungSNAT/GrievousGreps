/**
 * A CLI query's `--json` answer carries the freshness of the graph it came from,
 * as `index`, once the query's refresh gate has run (`cli.ts` refreshBefore). One
 * command runs per process, so the state is set once and read by the printer.
 */
import type { IndexState } from "./refresh.js";

let current: IndexState | undefined;

export function setQueryIndex(index: IndexState | undefined): void {
  current = index;
}

/** `JSON.stringify(value, null, 2)`, with `index` added to an object answer. */
export function queryJson(value: unknown): string {
  const withIndex = current && value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...value, index: current }
    : value;
  return JSON.stringify(withIndex, null, 2);
}
