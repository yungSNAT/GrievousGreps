/**
 * Records the TypeScript answers `rust/gg-query/tests/blast_owners_parity.rs` compares against.
 *
 *   npx tsx rust/gg-query/parity/owners-parity.ts --record rust/gg-query/tests/fixtures/owners/table.json
 *
 * Reads the inputs already in the file (`handles`, `since`, `iso`) and rewrites it with the
 * answers of `githubHandle`, `sinceLabel` and `Date.parse` (null for NaN), which `ownersFor`
 * reads each commit's `%aI` date with.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { githubHandle, sinceLabel } from "../../../src/blast/owners.js";

const args = process.argv.slice(2);
const at = args.indexOf("--record");
const file = at >= 0 ? args[at + 1] : undefined;
if (!file) {
  console.error("usage: owners-parity.ts --record <table.json>");
  process.exit(2);
}
const table = JSON.parse(readFileSync(file, "utf8")) as {
  handles: [string, unknown][];
  since: [number, number, unknown][];
  iso: [string, unknown][];
};
const out = {
  handles: table.handles.map(([email]) => [email, githubHandle(email)]),
  since: table.since.map(([last, now]) => [last, now, sinceLabel(last, now)]),
  iso: table.iso.map(([raw]) => {
    const ms = Date.parse(raw);
    return [raw, Number.isFinite(ms) ? ms : null];
  }),
};
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`recorded ${out.handles.length + out.since.length + out.iso.length} answers`);
