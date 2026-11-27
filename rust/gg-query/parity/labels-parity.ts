/**
 * Records the TypeScript answers `rust/gg-query/tests/blast_labels_parity.rs` compares against.
 *
 *   npx tsx rust/gg-query/parity/labels-parity.ts --record rust/gg-query/tests/fixtures/labels/table.json
 *
 * Reads the inputs already in the file and rewrites it with the answers of `shortLabel`,
 * `dirLabel`, `parentDir` (`src/blast/modules.ts`), `hubLabel` and the `TEST_PATH` rule
 * (`src/blast/blast.ts`). `TEST_PATH` is not exported, so its literal is read from the source.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { hubLabel } from "../../../src/blast/blast.js";
import { dirLabel, parentDir, shortLabel } from "../../../src/blast/modules.js";

const args = process.argv.slice(2);
const at = args.indexOf("--record");
const file = at >= 0 ? args[at + 1] : undefined;
if (!file) {
  console.error("usage: labels-parity.ts --record <table.json>");
  process.exit(2);
}
const source = readFileSync(new URL("../../../src/blast/blast.ts", import.meta.url), "utf8");
const literal = /^const TEST_PATH = \/(.+)\/([a-z]*);$/m.exec(source);
if (!literal) throw new Error("TEST_PATH literal not found in src/blast/blast.ts");
const testPath = new RegExp(literal[1], literal[2]);

const table = JSON.parse(readFileSync(file, "utf8")) as {
  short: [string, unknown][];
  dir: [string, unknown][];
  parent: [string, unknown][];
  hub: [string[], string, unknown][];
  test_path: [string, unknown][];
};
const out = {
  short: table.short.map(([label]) => [label, shortLabel(label)]),
  dir: table.dir.map(([path]) => [path, dirLabel(path)]),
  parent: table.parent.map(([dir]) => [dir, parentDir(dir)]),
  hub: table.hub.map(([names, fallback]) => [names, fallback, hubLabel(names, fallback)]),
  test_path: table.test_path.map(([path]) => [path, testPath.test(path)]),
};
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`recorded ${Object.values(out).reduce((n, rows) => n + rows.length, 0)} answers`);
