/**
 * Records the TypeScript renderings `rust/gg-query/tests/blast_render_parity.rs` compares against.
 *
 *   TRAIL_INVOKED_AS=trail npx tsx rust/gg-query/parity/render-parity.ts --record rust/gg-query/tests/fixtures/render
 *
 * For each `<case>.report.json` (written from the Rust test's reports) it writes `<case>.md`
 * (`markdownReport`, quoting from `<dir>/root`), `<case>.txt` (`textReport`) and `<case>.mmd`
 * (`mermaidDiagram`; removed when that draws nothing).
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { markdownReport, mermaidDiagram, textReport } from "../../../src/blast/render.js";

const args = process.argv.slice(2);
const at = args.indexOf("--record");
const dir = at >= 0 ? args[at + 1] : undefined;
if (!dir) {
  console.error("usage: render-parity.ts --record <fixture dir>");
  process.exit(2);
}
const root = join(dir, "root");
for (const file of readdirSync(dir).filter((f) => f.endsWith(".report.json")).sort()) {
  const name = file.slice(0, -".report.json".length);
  const report = JSON.parse(readFileSync(join(dir, file), "utf8"));
  writeFileSync(join(dir, `${name}.md`), markdownReport(report, { root }));
  writeFileSync(join(dir, `${name}.txt`), textReport(report));
  const diagram = mermaidDiagram(report);
  const mmd = join(dir, `${name}.mmd`);
  if (diagram !== null) writeFileSync(mmd, diagram);
  else if (existsSync(mmd)) rmSync(mmd);
  console.log(`recorded ${name}`);
}
