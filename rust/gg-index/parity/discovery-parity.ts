/**
 * Differential check of Stage 3B1 (discovery and cache identity) against the TypeScript
 * it ports: `walkDir` (src/ingest/fs.ts), `listSourceStats` and `supportedExtensions`
 * (src/graph/source-files.ts), `deployFormatOf` (src/graph/deploy.ts), the extraction
 * cache (src/graph/extract-cache.ts) and the fingerprint sidecar (src/graph/fingerprint.ts).
 *
 * Both sides run on the same generated inputs:
 *   - extensions: `gg-index extensions` against `supportedExtensions()`;
 *   - classify: NUL-separated paths on stdin; per path `[parser claims it, deploy format]`;
 *   - sources: generated trees (skip dirs, dot dirs and dot files, `--include-dir`, files
 *     over 1 MB, symlinks, a symlinked root, Git with `.gitignore`, a nested clone and a
 *     submodule, `--only-dir`, `-e`, an output dir inside the root, case pairs);
 *     `[rel, size, mtimeMs]` per file, in order;
 *   - cache and fingerprint: generated entries (absent and present `via`, `error`,
 *     `deploy`, `skipped`, non-ASCII and astral text, foreign `path`, older sidecars to
 *     prune); the bytes written, the files left in `.cache`, and what each side reads back.
 *
 * The extractor stamp hashes the TypeScript modules, so the Rust side is handed it with
 * `--extractor` rather than computing it.
 *
 *   npx tsx rust/gg-index/parity/discovery-parity.ts --bin <gg-index> [--kinds sources,cache] [--count N] [--seed S] [--keep <dir>]
 *   npx tsx rust/gg-index/parity/discovery-parity.ts --record rust/gg-index/tests/fixtures/discovery
 *
 * Exit 1 when any case differs, and throw when the binary cannot start.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { walkDir } from "../../../src/ingest/fs.js";
import { listSourceStats, supportedExtensions } from "../../../src/graph/source-files.js";
import { deployFormatOf } from "../../../src/graph/deploy.js";
import { languageOf } from "../../../src/graph/extract.js";
import { genericLangOf } from "../../../src/graph/generic.js";
import { containerLangOf } from "../../../src/graph/container.js";
import { extractCachePath, extractorStamp, readExtractCache, writeExtractCache, type ExtractCache } from "../../../src/graph/extract-cache.js";
import { fingerprintPath, readFingerprint, writeFingerprint } from "../../../src/graph/fingerprint.js";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

let seed = Number(opt("--seed") ?? 1) >>> 0;
const firstSeed = seed;
const count = Number(opt("--count") ?? 100);
const keep = opt("--keep");
const stamp = extractorStamp();
if (stamp === null) throw new Error("no extractor stamp: run from a checkout under tsx");

// mulberry32, as wiring-parity.ts
function rand(): number {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const some = <T>(xs: readonly T[], p: number): T[] => xs.filter(() => rand() < p);

const EXTS = supportedExtensions();
const DEPLOY_NAMES = [
  "Dockerfile", "dockerfile", "Dockerfile.dev", "DOCKERFILE", "api.Dockerfile", "Containerfile", ".dockerignore",
  "app.dockerignore", "docker-compose.yml", "compose.yaml", "compose.prod.yml", "Docker-Compose.YML",
  "kustomization.yaml", "kustomization.yml", "Kustomization", "KUSTOMIZATION.yaml", "main.tf", "main.TF", "x.tf.json",
  "deploy.yaml", "values.YML", "a.yaml.bak",
];
const OTHER_NAMES = ["README.md", "notes.txt", "App.vue", "x", ".eslintrc.js", ".env", "LICENSE", "a.b.c"];
// Edges of the name rules, for classify only: case, line terminators, a trailing slash,
// characters that lower-case to ASCII (U+212A) or to 2 code points (U+0130).
const PREFIXES = ["docker-", "Docker-", "api.", "compose.", "dockerfile.", ".", "\u212A", "\u0130", "\u03A3", "\n", "x\u2028", "x\u2029"];
const SUFFIXES = ["/", "//", ".bak", "\n", "\r", "\u2028", "\u2029", "\u03A3", ".yml", ".YAML", ".\u212At", ".tf", ".json", "_", "-"];

// Which comparisons run beyond extensions and classify, as each lands in Rust (3B1b sources, 3B1c cache).
const kinds = new Set(["extensions", "classify", ...(opt("--kinds") ?? "sources,cache").split(",").filter(Boolean)]);

/** Per path: whether a parser claims it and its deploy format, as `listSourceStats` reads it. */
function tsClassify(p: string): [boolean, string | null] {
  return [languageOf(p) !== null || genericLangOf(p) !== null || containerLangOf(p) !== null, deployFormatOf(p)];
}

function fileName(): string {
  const r = rand();
  if (r < 0.2) return pick(DEPLOY_NAMES);
  if (r < 0.3) return pick(OTHER_NAMES);
  const stem = pick(["main", "index", "Foo", "foo", "a b", "ü", "日本", "x.test", "mod"]);
  const ext = pick(EXTS);
  return `${stem}${rand() < 0.15 ? ext.toUpperCase() : ext}`;
}
const DIRS = ["src", "lib/a", "node_modules/pkg", "dist", "_build", "vendor", "target", ".github/workflows", ".kb", ".venv", ".cache", "examples/.test", "deep/a/b/c", "Src", "graft"];

let differ = 0;
function compare(kind: string, index: number, ts: string, rs: string, detail: string): void {
  if (ts === rs) return;
  differ++;
  console.error(`${kind} ${index} differs (${detail})\n  ts ${ts.slice(0, 400)}\n  rs ${rs.slice(0, 400)}`);
  if (keep) {
    mkdirSync(keep, { recursive: true });
    writeFileSync(join(keep, `${kind}-${index}.ts.json`), ts);
    writeFileSync(join(keep, `${kind}-${index}.rs.json`), rs);
  }
}

const bin = opt("--bin") ? resolve(opt("--bin")!) : null;
function run(argv: string[], input = "", cwd?: string): { out: string; status: number | null } {
  if (!bin) throw new Error("--bin <gg-index binary> is required");
  const r = spawnSync(bin, argv, { input, cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  // A binary that cannot start is a harness failure, never a match. EPIPE is a binary that
  // exited before reading its input (as one without the subcommand does): its status counts.
  if (r.error && (r.error as NodeJS.ErrnoException).code !== "EPIPE") throw r.error;
  return { out: r.stdout, status: r.status };
}

/** Output of a run that exited 0, else its exit status, so a failing binary reads as such. */
const checked = (r: { out: string; status: number | null }): string => (r.status === 0 ? r.out.trim() : `exit ${r.status}`);

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=p", "-c", "user.email=p@example.invalid", "-c", "protocol.file.allow=always", ...a], { cwd, stdio: "ignore" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")} failed in ${cwd}`);
};

interface TreeCase { root: string; outDir: string; includes: string[]; subs: boolean; nested: boolean; onlyDirs: string[]; exts: string[] }

/** One generated tree under `work`. */
function makeTree(work: string, i: number): TreeCase {
  const real = join(work, `tree-${i}`);
  mkdirSync(real);
  const dirs = ["", ...some(DIRS, 0.5)];
  const filled = new Set<string>(); // `git add` refuses a pathspec that matches no file
  for (const d of dirs) {
    mkdirSync(join(real, d), { recursive: true });
    for (let n = Math.floor(rand() * 4); n > 0; n--) {
      writeFileSync(join(real, d, fileName()), `x${i}\n`.repeat(1 + Math.floor(rand() * 5)));
      filled.add(d);
    }
  }
  if (rand() < 0.2) {
    mkdirSync(join(real, "src"), { recursive: true });
    writeFileSync(join(real, "src", "big.ts"), "a".repeat(1_000_001));
    filled.add("src");
  }
  if (rand() < 0.3) {
    try {
      symlinkSync(join(real, dirs[dirs.length - 1] || "."), join(real, "linkdir"), "dir");
      symlinkSync("missing.ts", join(real, "dangling.ts"));
    } catch { /* no symlink right (Windows without developer mode) */ }
  }
  if (rand() < 0.6) {
    git(real, "init", "-q");
    if (rand() < 0.5) writeFileSync(join(real, ".gitignore"), some(["dist/", "*.md", "!README.md", "lib/", "/graft", "*.yml"], 0.4).join("\n"));
    const tracked = some([...filled].filter(Boolean), 0.5);
    if (tracked.length) git(real, "add", "-f", "--", ...tracked);
    if (rand() < 0.3) {
      const child = join(real, "nested");
      mkdirSync(child);
      writeFileSync(join(child, "n.py"), "def f(): pass\n");
      git(child, "init", "-q");
    }
  }
  let root = real;
  if (rand() < 0.15) {
    try {
      symlinkSync(real, join(work, `root-link-${i}`), "dir");
      root = join(work, `root-link-${i}`);
    } catch { /* as above */ }
  }
  return {
    root,
    outDir: join(root, "graft"),
    includes: some(["vendor", ".kb", "_build", ".git", "target", ".cache"], 0.25),
    subs: rand() < 0.3,
    nested: rand() < 0.3,
    onlyDirs: rand() < 0.2 ? some(["src", "lib", "deep/a"], 0.5) : [],
    exts: rand() < 0.2 ? some([".ts", "PY", ".yaml", "rs", ".tf", " .Go "], 0.4) : [],
  };
}

function tsSources(c: TreeCase): string {
  const files = walkDir(c.root, new Set(c.includes), { followSubmodules: c.subs, followNestedRepos: c.nested });
  const stats = listSourceStats(c.root, c.outDir, files, c.onlyDirs.length ? new Set(c.onlyDirs) : undefined, c.exts.length ? c.exts : undefined);
  return JSON.stringify(stats.map((s) => [s.rel, s.size, s.mtimeMs]));
}
function rsSources(c: TreeCase): string {
  const a = ["sources", "--root", c.root, "--out-dir", c.outDir];
  for (const d of c.includes) a.push("--include-dir", d);
  if (c.subs) a.push("--follow-submodules");
  if (c.nested) a.push("--follow-nested-repos");
  for (const d of c.onlyDirs) a.push("--only-dir", d);
  for (const e of c.exts) a.push("--ext", e);
  const r = run(a);
  return r.status === 0 ? r.out.trimEnd() : `exit ${r.status}`;
}

/** A submodule case, fixed rather than drawn, as it needs a committed child repository. */
function submoduleCase(work: string): TreeCase {
  const upstream = join(work, "sub-upstream");
  mkdirSync(upstream);
  writeFileSync(join(upstream, "s.go"), "package s\n");
  git(upstream, "init", "-q");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "s");
  const root = join(work, "super");
  mkdirSync(root);
  writeFileSync(join(root, "a.ts"), "export {}\n");
  git(root, "init", "-q");
  git(root, "submodule", "add", "-q", upstream, "vendor/sub");
  git(root, "submodule", "add", "-q", upstream, "libs/sub");
  return { root, outDir: join(root, "graft"), includes: [], subs: true, nested: false, onlyDirs: [], exts: [] };
}

const NON_ASCII = ["ü", "日本", "😀", " ", "é", "\u0000"];
function text(): string {
  return `${pick(["a", "b c", "\"q\"", "\\"])}${rand() < 0.4 ? pick(NON_ASCII) : ""}`;
}
function cacheCase(): ExtractCache {
  const files: ExtractCache["files"] = {};
  for (let n = Math.floor(rand() * 6); n > 0; n--) {
    const rel = `${pick(["src", "k8s", "ü"])}/${fileName()}`;
    const entry: Record<string, unknown> = {
      size: Math.floor(rand() * 1e6), mtimeMs: 1.7e12 + rand() * 1e9, hash: "ab".repeat(32),
      nodes: [{ id: rel, name: text(), kind: "file", path: rand() < 0.1 ? "other" : rel, span: "L1-L2", signature: null }],
      rawEdges: rand() < 0.5 ? [] : [{ from: rel, to: text(), kind: "calls" }],
    };
    if (rand() < 0.3) entry.error = text();
    if (rand() < 0.3) entry.via = pick(["javascript", "c"]);
    if (rand() < 0.3) entry.deploy = [{ kind: "image", value: text(), line: 3 }];
    if (rand() < 0.2) entry.skipped = text();
    files[rand() < 0.05 ? "__proto__" : rel] = entry as never;
  }
  return { version: 1, extractor: stamp!, files };
}

function cacheRound(work: string, i: number): void {
  const c = cacheCase();
  const sides = { ts: join(work, `cache-ts-${i}`, "graft"), rs: join(work, `cache-rs-${i}`, "graft") };
  for (const out of Object.values(sides)) {
    mkdirSync(join(out, ".cache"), { recursive: true });
    for (let k = 0; k < 3; k++) {
      const old = join(out, ".cache", `extract.old${k}.json`);
      writeFileSync(old, "{}");
      utimesSync(old, 1e9 + k, 1e9 + k);
    }
  }
  const tsOk = writeExtractCache(sides.ts, c);
  const rsOk = run(["cache", "write", "--out-dir", sides.rs, "--extractor", stamp!], JSON.stringify(c)).out.trim();
  compare("cache-write", i, String(tsOk), rsOk, "returned");
  const tsPath = extractCachePath(sides.ts)!;
  const rsPath = join(sides.rs, ".cache", `extract.${stamp}.json`);
  compare("cache-bytes", i, existsSync(tsPath) ? readFileSync(tsPath, "latin1") : "absent", existsSync(rsPath) ? readFileSync(rsPath, "latin1") : "absent", "file bytes");
  compare("cache-pruned", i, readdirSync(join(sides.ts, ".cache")).sort().join(","), readdirSync(join(sides.rs, ".cache")).sort().join(","), ".cache listing");
  compare("cache-read", i, JSON.stringify(readExtractCache(sides.ts)), run(["cache", "read", "--out-dir", sides.ts, "--extractor", stamp!]).out.trim(), "read back");

  const only = rand() < 0.3 ? ["src"] : [];
  const exts = rand() < 0.3 ? [".ts"] : [];
  const fpTs = writeFingerprint(sides.ts, c.files, only, exts);
  const fa = ["fingerprint", "write", "--out-dir", sides.rs, "--extractor", stamp!];
  for (const d of only) fa.push("--only-dir", d);
  for (const e of exts) fa.push("--ext", e);
  compare("fp-write", i, String(fpTs), run(fa, JSON.stringify(c.files)).out.trim(), "returned");
  const fpRs = join(sides.rs, ".cache", `fingerprint.${stamp}.json`);
  compare("fp-bytes", i, readFileSync(fingerprintPath(sides.ts), "latin1"), existsSync(fpRs) ? readFileSync(fpRs, "latin1") : "absent", "file bytes");
  compare("fp-read", i, JSON.stringify(readFingerprint(sides.ts)), run(["fingerprint", "read", "--out-dir", sides.ts, "--extractor", stamp!]).out.trim(), "read back");
}

const record = opt("--record");
if (record) {
  // Goldens for the Rust tests: the extension list and the classification of a fixed name list.
  mkdirSync(record, { recursive: true });
  writeFileSync(join(record, "extensions.json"), `${JSON.stringify(EXTS)}\n`);
  const names = [...DEPLOY_NAMES, ...OTHER_NAMES, ...EXTS.map((e) => `src/m${e}`), ...EXTS.map((e) => `M${e.toUpperCase()}`), "a\\b\\Dockerfile", "k/Kustomization"];
  writeFileSync(join(record, "classify-input.txt"), names.join("\0"));
  writeFileSync(join(record, "classify.json"), `${JSON.stringify(names.map(tsClassify))}\n`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "gg-index-discovery-"));
try {
  compare("extensions", 0, JSON.stringify(EXTS), checked(run(["extensions"])), "supportedExtensions");
  const paths = Array.from({ length: 2000 }, () => `${pick(["", "a/", "a\\b\\", "deep/x/", "x/"])}${pick(["", ...PREFIXES])}${fileName()}${pick(["", "", "", ...SUFFIXES])}`);
  compare("classify", 0, JSON.stringify(paths.map(tsClassify)), checked(run(["classify"], paths.join("\0"))), "per path");
  if (kinds.has("sources")) {
    const cases = [submoduleCase(work)];
    for (let i = 0; i < count; i++) cases.push(makeTree(work, i));
    cases.forEach((c, i) => compare("sources", i, tsSources(c), rsSources(c), c.root));
  }
  if (kinds.has("cache")) for (let i = 0; i < count; i++) cacheRound(work, i);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify({ kinds: [...kinds], classified: 2000, trees: kinds.has("sources") ? count + 1 : 0, cacheRounds: kinds.has("cache") ? count : 0, differ, seed: firstSeed }));
process.exit(differ ? 1 : 0);
