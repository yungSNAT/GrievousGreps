/**
 * CLI command registration for `hubs` (god-node orientation) and `crate-source`
 * (`Cargo.lock`-anchored dependency source lookup), kept out of `src/cli.ts` to
 * preserve modular file sizes.
 */
import type { Command } from "commander";
import { resolve } from "node:path";
import { cmd } from "./brand.js";
import { contextDirFor } from "./context/node-file.js";
import { loadGraphCached } from "./graph/load.js";
import { queryJson } from "./graph/query-json.js";
import { computeHubs, formatHubsText, parseHubLimit } from "./graph/hubs.js";
import { formatCrateSourceText, resolveCrateSource } from "./graph/crate-source.js";

export interface DiscoverCliHooks {
  program: Command;
  groupFind: string;
  dirArg: readonly [string, string];
  noRefreshFlag: readonly [string, string];
  queryRoot: (dir?: string) => string;
  noteQuery: (dir: string) => string;
  refreshBefore: (dir: string, opts: { refresh?: boolean }) => Promise<void>;
  grouped: (c: Command, group: string) => Command;
}

export function registerDiscoverCommands(hooks: DiscoverCliHooks): void {
  const { program, groupFind, dirArg, noRefreshFlag, queryRoot, noteQuery, refreshBefore, grouped } = hooks;

  grouped(program.command("hubs"), groupFind)
    .description("Surface top god-node / hub symbols by PageRank and walk-edge connectivity ($0, no LLM)")
    .argument(...dirArg)
    .option("-n, --limit <n>", "max hub symbols shown (1..100, default 15)")
    .option("--in <path>", "narrow to symbols at or under this path prefix")
    .option("--json", "output as JSON")
    .option(...noRefreshFlag)
    .action(async (dirArgVal: string | undefined, opts: { limit?: string; in?: string; json?: boolean; refresh?: boolean }) => {
      let limit: number;
      try {
        limit = parseHubLimit(opts.limit);
      } catch (err) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
        return;
      }
      const dir = noteQuery(queryRoot(dirArgVal));
      const root = resolve(dir);
      await refreshBefore(dir, opts);
      const globalOpts = program.opts<{ dir?: string }>();
      const contextDir = contextDirFor(root, globalOpts.dir);
      const graph = loadGraphCached(contextDir);
      if (!graph) {
        console.error(`✗ no graph: run ${cmd("graft build")} first`);
        process.exit(1);
        return;
      }
      try {
        const report = computeHubs(graph, { limit, in: opts.in });
        if (opts.json) {
          console.log(queryJson(report));
        } else {
          process.stdout.write(formatHubsText(report));
        }
      } catch (err) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  grouped(program.command("crate-source"), groupFind)
    .description("Resolve a Rust crate from Cargo.lock to its exact local registry, git or path source directory")
    .argument("<crate>", "Rust crate name as listed in Cargo.lock")
    .argument(...dirArg)
    .option("--version <semver>", "pin one version when multiple versions appear in Cargo.lock")
    .option("--cargo-home <dir>", "override CARGO_HOME directory")
    .option("--lockfile <path>", "explicit Cargo.lock path inside the repository")
    .option("--json", "output as JSON")
    .action(
      (
        crateName: string,
        dirArgVal: string | undefined,
        opts: { version?: string; cargoHome?: string; lockfile?: string; json?: boolean },
      ) => {
        const repo = resolve(dirArgVal ?? ".");
        try {
          const report = resolveCrateSource({
            crateName,
            repo,
            version: opts.version,
            cargoHome: opts.cargoHome,
            lockfile: opts.lockfile,
          });
          if (opts.json) {
            console.log(JSON.stringify(report, null, 2));
          } else {
            process.stdout.write(formatCrateSourceText(report));
          }
          const anyHardErr = report.matches.some(
            (m) => m.status === "ambiguous" || m.status === "unresolved" || m.status === "budget_exhausted",
          );
          if (anyHardErr || report.matches.every((m) => m.status !== "found")) {
            console.error(
              `✗ crate "${report.query}" could not be verified locally under ${report.cargoHome}`,
            );
            process.exit(1);
          }
        } catch (err) {
          console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      },
    );
}
