# Run records behind the README's 16 November 2026 columns

The first 10 tools' columns and both upstream columns of the 21-repository table come from runs on the benchmark machine (Linux, Node 26.13.1) on 16 November 2026 (UTC). These files were copied from it on 19 November, unchanged except that `upstream-*.txt` join each run's 3 parts and replace the machine's paths with `<path>`. [runner-records.txt](runner-records.txt) and [versions.txt](versions.txt) were written on 19 November from the runner's logs, the result files' times and the installed tools.

| README figure | Record |
| --- | --- |
| The table of this tool, codebase-memory-mcp, Serena (defaults) and code-review-graph; the other 5 of the 6 further tools (CodeGraph 1.6.3 is in [../2026-11-18/](../2026-11-18/codegraph-1.6.3.md)); codebase-memory-mcp at its defaults (0.29); CodeGraph 1.6.2 (0.54 / 0.94 / 90, Rust 0.17); the patched column of the recall table | [table.md](table.md) and [scores.json](scores.json), scored at 18:17 UTC |
| Serena's tuned column | [scores.json](scores.json): its `serena-alt.returned` rows for attrs, click, structlog, radix and trpc, the 5 it reconfigures, with `serena.returned` for the other 16, pooled |
| Upstream `main` at `b22055d`: 0.19, precision 0.91, 113 silent undercounts, and its column | [upstream-main.txt](upstream-main.txt), 3 `run.mjs` parts, 13:23 to 13:29 UTC |
| Upstream 0.29.0: 0.32, precision 0.94, 77 silent undercounts, and its column | [upstream-0.29.0.txt](upstream-0.29.0.txt), the same way, 13:19 to 13:23 UTC, from the npm package `@trailhq/trail-code@0.29.0` |

The columns of `table.md`: `gg` this tool at `88c214e`, `cbm` codebase-memory-mcp (`tests` with test callers on, `default` at its defaults), `serena` Serena (`returned` each answer as returned, `calls` keeping only the references at a call; the README uses `returned`), `serena-alt` Serena reconfigured, `crg` code-review-graph, `cg` CodeGraph 1.6.2, `cgc` CodeGraphContext, `ax` AxiomCode Graph, `rw` repowise, `gf` Graphify and `tks` tokensave. Each cell is recall / scorer precision / silent undercounts.

Each part names the measured build `Patched`, as the runner labels its `--tool`; for these files that build is upstream's. The `main` build is upstream's source at `b22055dce3c3ff22722793ed0a5a3be4491a9140` with a clean tree, which prints its package version, 0.28.0.

## Commands

- `table.md` and `scores.json`: the benchmark machine's driver `score_all.mjs`, not in this repository, which scores each tool's kept answers with the benchmark's scorer, `node score_all.mjs <root> <dest> [tool:variant ...]`. Its column order matches `serena-alt:returned crg:default cg:default cgc:default ax:default rw:default gf:default tks:default` after its 5 built-in columns; the command line itself was not recorded.
- `upstream-*.txt`: each part is `node benchmark/run.mjs --tool <graft.js> --repos <7 repositories> --work <path> --verbose`, run from `src/gg`, the machine's checkout of this repository, whose runner script names that folder; [versions.txt](versions.txt) has its commit, `88c214e`, and its build time, before these runs; `run.mjs` was the JavaScript runner `gg-bench run` replaced.

## Pooling

A column's overall and per-language cells pool its repositories: calls found over calls in the truth, true edges over edges reported, and the sum of silent undercounts. In `table.md` a repository with no answers reads `no run`, and pooling leaves it out: AxiomCode Graph's run on query was stopped by its time limit (exit 124 in `runner-records.txt`), so its cells pool the other 20 repositories.

## Times

[runner-records.txt](runner-records.txt) gives these UTC times:

- Serena's first part started at 07:33:54, and its answers that survive were written from 08:03:23, as later parts rewrote the earlier ones (the answer times are not in that file).
- This tool's scored pass ended at 18:09:25 (`PART gg-3 END`), and its last scored answer was written at 18:09:24. 2 repeat passes, not scored, ended at 18:10:17 and 18:11:02.
- Scoring started at 18:17:30 and wrote these files at 18:17:32.

## Versions

[versions.txt](versions.txt) has each tool's version, read on 19 November from the installs the runs used, with each install's file time. Each install time is earlier than that tool's first part started, as `runner-records.txt` gives it, so none was reinstalled between its runs and this reading. The `main` build's checkout is at `b22055dce3c3ff22722793ed0a5a3be4491a9140` with no changed files. This tool's column is that `src/gg` build at `88c214e`; `scores.json` does not name it.
