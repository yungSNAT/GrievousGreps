/**
 * Records the TypeScript answers `rust/gg-query/tests/evidence_parity.rs` compares against.
 *
 *   npx tsx rust/gg-query/parity/evidence-parity.ts --record rust/gg-query/tests/fixtures/evidence/table.json
 *
 * Reads the inputs already in the file and rewrites it with the answers of `syntaxOf`, `opensQuote`,
 * `codeOf` (from `src/blast/evidence.ts`, each line fed the delimiter the previous one left open) and
 * `codeLines` (from `src/blast/blast.ts`, lines `from` to `to` only). `codeOf` and `codeLines` are not
 * exported, so each is read from a copy of its module, written beside it with an export added and
 * deleted once loaded.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { opensQuote, syntaxOf } from "../../../src/blast/evidence.js";

type Syntax = ReturnType<typeof syntaxOf>;
type CodeOf = (text: string, syntax: Syntax, open: string | null) => { code: string; open: string | null };
type CodeLines = (lines: string[], from: number, to: number, path: string) => string[];

const blastDir = fileURLToPath(new URL("../../../src/blast/", import.meta.url));

async function internal<T>(file: string, name: string): Promise<T> {
  const copy = join(blastDir, `.parity-${file}`);
  writeFileSync(copy, `${readFileSync(join(blastDir, file), "utf8")}\nexport { ${name} };\n`);
  try {
    return (await import(pathToFileURL(copy).href))[name] as T;
  } finally {
    rmSync(copy);
  }
}

const args = process.argv.slice(2);
const at = args.indexOf("--record");
const file = at >= 0 ? args[at + 1] : undefined;
if (!file) {
  console.error("usage: evidence-parity.ts --record <table.json>");
  process.exit(2);
}
const codeOf = await internal<CodeOf>("evidence.ts", "codeOf");
const codeLines = await internal<CodeLines>("blast.ts", "codeLines");
const table = JSON.parse(readFileSync(file, "utf8")) as {
  syntax: [string, unknown][];
  opens: [string, number, boolean, unknown][];
  code: [string, string | null, string[], unknown][];
  blank: [string, string[], number, number, unknown][];
};
const out = {
  syntax: table.syntax.map(([path]) => [path, syntaxOf(path)]),
  opens: table.opens.map(([text, i, rust]) => [text, i, rust, opensQuote(text, i, rust)]),
  code: table.code.map(([path, first, lines]) => {
    const syntax = syntaxOf(path);
    let open = first;
    const answers = lines.map((text) => {
      const step = codeOf(text, syntax, open);
      open = step.open;
      return [step.code, step.open];
    });
    return [path, first, lines, answers];
  }),
  blank: table.blank.map(([path, lines, from, to]) => [path, lines, from, to, codeLines(lines, from, to, path).slice(from - 1, to)]),
};
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
const rows = Object.values(out).reduce((n, v) => n + v.length, 0);
console.log(`recorded ${rows} rows`);
