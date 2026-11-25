/**
 * Differential check of `gg-index wiring` against `writeGraph` (src/graph/write.ts).
 *
 * Feeds both the same graph JSON and compares the bytes each writes. Inputs: seeded
 * generated graphs (punctuation, case pairs, combining marks, CJK, Hangul, astral and
 * lone surrogates, controls, extreme numbers, repeated and index-like keys), plus
 * recorded `wiring.json` files given with `--sample`, shuffled and given `body_text`.
 *
 *   npx tsx rust/gg-index/parity/wiring-parity.ts --bin <gg-index> [--count N] [--seed S]
 *       [--sample <wiring.json>]... [--keep <dir>]
 *   npx tsx rust/gg-index/parity/wiring-parity.ts --record rust/gg-index/tests/fixtures/wiring
 *
 * `--record` writes `<name>.wiring.json` beside each `<name>.json` from the TypeScript
 * writer: the goldens the Rust tests compare against. Exit 1 when any case differs.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wiringPath, writeGraph } from "../../../src/graph/write.js";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const all = (name: string): string[] => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));

const work = mkdtempSync(join(tmpdir(), "gg-index-parity-"));
const outDir = join(work, "graft");
mkdirSync(outDir);

/** Bytes `writeGraph` writes for `text`, or null when it (or JSON.parse) throws. */
function tsWiring(text: string): Buffer | null {
  try {
    writeGraph(JSON.parse(text), outDir);
    return readFileSync(wiringPath(outDir));
  } catch {
    return null;
  }
}

const record = opt("--record");
if (record) {
  for (const f of readdirSync(record).filter((f) => f.endsWith(".json") && !f.endsWith(".wiring.json"))) {
    const got = tsWiring(readFileSync(join(record, f), "utf8"));
    if (got === null) throw new Error(`${f}: writeGraph threw`);
    writeFileSync(join(record, f.replace(/\.json$/, ".wiring.json")), got);
  }
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
}

const bin = opt("--bin");
if (!bin) throw new Error("--bin <gg-index binary> is required");
let seed = Number(opt("--seed") ?? 1) >>> 0;
const firstSeed = seed;
const count = Number(opt("--count") ?? 200);
const keep = opt("--keep");

// mulberry32
function rand(): number {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (n: number): number => Math.floor(rand() * n);
const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)];
function shuffle<T>(xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = int(i + 1);
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
const EXOTIC = [
  "\u00e9", "e\u0301", "\u00c4", "A\u0308", "\u00df", "ss", "\u00f8", "\u00e6", "\u0131", "\u0130", "\u01c5", "\ufb01", "\u0323", "\u0301", "a\u0323\u0301",
  "a\u0301\u0323", "\u4e2d", "\u6587", "\ud55c", "\u1100\u1161", "\u0e44\u0e01", "\u0e40", "\u0639", "\u0915\u094d", "\u03a9", "\u2126", "\u03c9", "\u00c5",
  "\u212b", "\u{1f600}", "\u{1d49c}", "\ud800", "\udc00", "\u0000", "\u001f", "\u007f", "\u0085", "\u00a0", "\u2028", "\ufeff",
  "\ufffd", "\ufffe", "\u0378", "\ue000", "\u{10ffff}", "\uff10", "\uff11", "\u0663", "~", "_", "-", "#", ".", "/",
];
const atom = (): string => (rand() < 0.75 ? pick(ASCII) : pick(EXOTIC));
const word = (max: number): string => Array.from({ length: int(max) }, atom).join("");
const ident = (): string => Array.from({ length: 1 + int(6) }, () => pick("aAbBzZ_09".split(""))).join("");

const ids: string[] = [];
const LONE = /[\ud800-\udfff]/gu;
/** Sort keys only rarely carry a lone surrogate: such a graph is outside the contract. */
const keyText = (s: string): string => (rand() < 0.01 ? s : s.replace(LONE, "x"));
function id(): string {
  if (ids.length && rand() < 0.3) {
    const prev = pick(ids);
    const r = rand();
    if (r < 0.25) return prev;
    if (r < 0.5) return prev.toUpperCase();
    if (r < 0.75) return prev.normalize(rand() < 0.5 ? "NFD" : "NFC");
    return keyText(prev + atom());
  }
  const v = keyText(
    rand() < 0.3
      ? word(14)
      : `${ident()}/${ident()}${pick(["", "_", "-", "."])}${ident()}.${pick(["ts", "py", "go", "rs", "TS"])}` +
          (rand() < 0.6 ? `#${ident()}${rand() < 0.5 ? `.${word(4)}` : ""}${rand() < 0.2 ? "~2" : ""}` : ""),
  );
  ids.push(v);
  return v;
}

// JSON text is built by hand so it can carry repeated keys, number lexemes and escapes.
type Gen = string; // JSON text
const ws = (): string => (rand() < 0.8 ? "" : pick([" ", "\n", "\t", "\r\n", "  "]));
function str(s: string): Gen {
  let out = '"';
  for (const ch of s.split("")) {
    const u = ch.charCodeAt(0);
    const mustEscape = u < 0x20 || (u >= 0xd800 && u <= 0xdfff) || ch === '"' || ch === "\\";
    if (mustEscape || rand() < 0.05) {
      const named: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t", "/": "\\/" };
      const hex = u.toString(16).padStart(4, "0");
      out += named[ch] && rand() < 0.5 ? named[ch] : `\\u${rand() < 0.5 ? hex : hex.toUpperCase()}`;
    } else out += ch;
  }
  return out + '"';
}
const NUMS = ["0", "-0", "1", "1.0", "1E2", "1e+2", "1e21", "1e-7", "0.1", "-3.25e-10", "123456789012345678901", "5e-324", "1.7976931348623157e308", "1e400", "-1e400", "2.5", "100", "9007199254740993", "0.000001", "0.0000001", "4.35"];
function scalar(): Gen {
  const r = rand();
  if (r < 0.1) return "null";
  if (r < 0.2) return pick(["true", "false"]);
  if (r < 0.45) return pick(NUMS);
  return str(word(10));
}
function obj(pairs: [string, Gen][]): Gen {
  return pairs.length ? `{${ws()}${pairs.map(([k, v]) => `${str(k)}${ws()}:${ws()}${v}`).join(`,${ws()}`)}${ws()}}` : `{${ws()}}`;
}
const arr = (items: Gen[]): Gen => `[${ws()}${items.join(`,${ws()}`)}${ws()}]`;
const EXTRA_KEYS = ["0", "7", "10", "01", "4294967294", "4294967295", "-1", "__proto__", "", "\u00e9"];
function extras(pairs: [string, Gen][]): [string, Gen][] {
  for (let i = int(3); i > 0; i--) pairs.splice(int(pairs.length + 1), 0, [rand() < 0.7 ? pick(EXTRA_KEYS) : word(5), scalar()]);
  return pairs;
}

function node(): Gen {
  const pairs: [string, Gen][] = [];
  const fields: [string, () => Gen][] = [
    ["name", () => str(word(8))], ["kind", () => str(pick(["file", "class", "function", "method"]))],
    ["owner", () => str(ident())], ["path", () => str(word(10))], ["span", () => str(`L${int(99)}-L${int(999)}`)],
    ["signature", () => (rand() < 0.3 ? "null" : str(word(20)))], ["exported", () => pick(["true", "false"])],
    ["origin", () => str(pick(["ast", "generic", "deploy"]))], ["body_hash", () => str(word(12))],
    ["chars", () => pick(NUMS)], ["body_text", () => str(word(30))], ["arity", () => pick(NUMS)],
    ["variadic", () => pick(["true", "false"])], ["summary_state", () => str("pending")],
    ["summary", () => (rand() < 0.5 ? "null" : str(word(20)))],
    ["crux", () => (rand() < 0.5 ? "null" : obj([["code", str(word(15))], ["span", str("L1-L2")]]))],
  ];
  for (const [k, f] of fields) if (rand() < 0.6) pairs.push([k, f()]);
  shuffle(pairs);
  if (rand() < 0.05) pairs.push(["id", str(id())]); // repeated key: the last value wins
  pairs.splice(int(pairs.length + 1), 0, ["id", str(id())]);
  if (rand() < 0.1) pairs.push(["body_text", str(word(5))]);
  return obj(extras(pairs));
}

const sources: string[] = [];
function edge(): Gen {
  const source = sources.length && rand() < 0.6 ? pick(sources) : id();
  sources.push(source);
  const pairs: [string, Gen][] = shuffle([
    ["source", str(source)],
    ["relation", str(rand() < 0.9 ? pick(["contains", "calls", "imports", "references", "implements", "extends", "Calls"]) : keyText(word(6)))],
    ["target", str(rand() < 0.5 ? pick(ids.length ? ids : ["t"]) : id())],
    ["confidence", str(pick(["extracted", "inferred", "lsp_resolved"]))],
  ]);
  return obj(extras(pairs));
}

function graph(big: boolean): Gen {
  ids.length = 0;
  sources.length = 0;
  const n = big ? 1500 + int(1500) : int(40);
  const nodes = Array.from({ length: n }, node);
  const edges = Array.from({ length: big ? n * 2 : int(80) }, edge);
  const meta = obj(shuffle([
    ["version", "1"], ["nodeCount", String(n)], ["edgeCount", String(edges.length)],
    ["languages", arr(["typescript", "python"].map((s) => str(s)))],
    ["scopes", arr([obj([["prefix", str("")], ["label", str("")], ["markers", arr([])]])])],
  ]));
  const top: [string, Gen][] = shuffle([["meta", meta], ["nodes", arr(nodes)], ["edges", arr(edges)]]);
  if (rand() < 0.4) top.push(["unresolvedCalls", arr([obj([["source", str(id())], ["name", str(word(5))], ["through", "null"]])])]);
  return `${ws()}${obj(extras(top))}${ws()}`;
}

/** A recorded graph with its arrays shuffled and `body_text` put back on symbol nodes. */
function fromSample(text: string): Gen {
  const g = JSON.parse(text) as { nodes: Record<string, unknown>[]; edges: unknown[] };
  shuffle(g.nodes);
  shuffle(g.edges);
  g.nodes = g.nodes.map((nd) => {
    if (nd.kind === "file" || rand() < 0.3) return nd;
    const entries = Object.entries(nd);
    entries.splice(int(entries.length + 1), 0, ["body_text", word(40)]);
    return Object.fromEntries(entries);
  });
  return JSON.stringify(g, null, rand() < 0.5 ? undefined : 1);
}

const MALFORMED = [
  "[]", "null", '{"nodes":[],"edges":{}}', '{"nodes":[{"id":1},{"id":"a"}],"edges":[]}',
  '{"nodes":[{"name":"x"},{"id":"a"}],"edges":[]}', '{"nodes":[],"edges":[{"source":"a","relation":"calls","target":"b"},{"source":2,"relation":"calls","target":"b"}]}',
  '{"nodes":[] "edges":[]}', '{"nodes":[],"edges":[],}', "\ufeff{}",
];

const inputs: { name: string; text: string }[] = MALFORMED.map((text, i) => ({ name: `malformed-${i}`, text }));
for (const s of all("--sample")) {
  const text = readFileSync(s, "utf8");
  for (let v = 0; v < 3; v++) inputs.push({ name: `sample-${inputs.length}`, text: fromSample(text) });
}
for (let i = 0; i < count; i++) inputs.push({ name: `gen-${i}`, text: graph(i % 100 === 99) });

/** The writer's contract: nodes are objects with a string `id`; edges are objects with
 * string `source`, `relation` and `target`. Outside it, what TypeScript does depends on
 * the order V8's sort happens to compare in, and Rust refuses the input. Sort keys must
 * also be well-formed UTF-16: TypeScript never builds one that is not. */
function inDomain(text: string): boolean {
  let g: unknown;
  try {
    g = JSON.parse(text);
  } catch {
    return true; // both must refuse it
  }
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  // A lone surrogate in a sort key: ICU4X compares it as U+FFFD, ICU4C by its own code point.
  const key = (v: unknown): boolean => typeof v === "string" && !/[\ud800-\udfff]/u.test(v);
  const strs = (v: unknown, keys: string[]): boolean => isObj(v) && keys.every((k) => key(v[k]));
  return (
    isObj(g) &&
    Array.isArray(g.nodes) &&
    Array.isArray(g.edges) &&
    g.nodes.every((n) => strs(n, ["id"])) &&
    g.edges.every((e) => strs(e, ["source", "relation", "target"]))
  );
}

const tally = { cases: 0, equal: 0, bothReject: 0, outOfDomainRejected: 0, differ: 0 };
const inputPath = join(work, "input.json");
for (const { name, text } of inputs) {
  tally.cases++;
  writeFileSync(inputPath, text);
  const ts = tsWiring(text);
  const rs = spawnSync(bin, ["wiring", inputPath], { maxBuffer: 1 << 30 });
  const rust = rs.status === 0 ? rs.stdout : null;
  if (ts === null && rust === null) tally.bothReject++;
  else if (ts !== null && rust !== null && ts.equals(rust)) tally.equal++;
  else if (rust === null && !inDomain(text)) tally.outOfDomainRejected++;
  else {
    tally.differ++;
    let at = 0;
    if (ts && rust) while (at < ts.length && ts[at] === rust[at]) at++;
    const lineAt = (b: Buffer): string => {
      const from = b.lastIndexOf(10, at - 1) + 1;
      const to = b.indexOf(10, at);
      return b.subarray(from, to < 0 ? b.length : to).toString().slice(0, 300);
    };
    console.log(
      JSON.stringify({
        name,
        ts: ts ? ts.length : "threw",
        rust: rust ? rust.length : (rs.stderr?.toString() ?? String(rs.error)).trim(),
        firstDiff: at,
        ...(ts && rust ? { tsLine: lineAt(ts), rustLine: lineAt(rust) } : {}),
      }),
    );
    if (keep) {
      mkdirSync(keep, { recursive: true });
      copyFileSync(inputPath, join(keep, `${name}.json`));
      if (ts) writeFileSync(join(keep, `${name}.ts.out`), ts);
      if (rust) writeFileSync(join(keep, `${name}.rust.out`), rust);
    }
  }
}
rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ ...tally, seed: firstSeed }));
process.exit(tally.differ ? 1 : 0);
