/**
 * Records the TypeScript answers the `crate_source` TOML parity test compares against.
 *
 *   npx tsx rust/gg-query/parity/toml-parity.ts --record rust/gg-query/tests/fixtures/toml/table.json
 *
 * Reads the documents already in the file and rewrites it with whether `smol-toml`'s `parse`, which
 * `src/graph/crate-source.ts` and `src/graph/crate-source-fs.ts` read `Cargo.toml` with, accepts each one,
 * and the string `package.name` it gives (null when it refuses the document or the name is not a string).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "smol-toml";

const args = process.argv.slice(2);
const at = args.indexOf("--record");
const file = at >= 0 ? args[at + 1] : undefined;
if (!file) {
  console.error("usage: toml-parity.ts --record <table.json>");
  process.exit(2);
}
const table = JSON.parse(readFileSync(file, "utf8")) as { docs: [string, unknown, unknown][] };
const docs = table.docs.map(([doc]) => {
  try {
    const parsed = parse(doc) as { package?: { name?: unknown } };
    const name = parsed.package?.name;
    return [doc, true, typeof name === "string" ? name : null];
  } catch {
    return [doc, false, null];
  }
});
writeFileSync(file, JSON.stringify({ docs }, null, 2) + "\n");
console.log(`recorded ${docs.length} documents, ${docs.filter((d) => d[1]).length} accepted`);
