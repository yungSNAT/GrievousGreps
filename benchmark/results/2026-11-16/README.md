# Run records behind the README's 16 November 2026 figures

The patched build's figures and both upstream builds' figures for the 21 repositories come from runs on the benchmark machine (Linux, Node 26.13.1) on 16 November 2026 (UTC). These files were copied from it on 19 November, unchanged except that `upstream-*.txt` join each run's 3 parts and replace the machine's paths with `<path>`. [runner-records.txt](runner-records.txt) and [versions.txt](versions.txt) were written on 19 November from the runner's logs, the result files' times and the installed builds. On 26 November 2026 the other tools' columns were removed from `table.md`, `scores.json`, `runner-records.txt` and `versions.txt`; this build's column and the upstream records are as they were.

| README figure | Record |
| --- | --- |
| The patched build at `88c214e`: 0.98, precision 0.95, 7 silent undercounts | [table.md](table.md) and [scores.json](scores.json), scored at 18:17 UTC |
| Upstream `main` at `b22055d`: 0.19, precision 0.91, 113 silent undercounts | [upstream-main.txt](upstream-main.txt), 3 `run.mjs` parts, 13:23 to 13:29 UTC |
| Upstream 0.29.0: 0.32, precision 0.94, 77 silent undercounts | [upstream-0.29.0.txt](upstream-0.29.0.txt), the same way, 13:19 to 13:23 UTC, from the npm package `@trailhq/trail-code@0.29.0` |

The column of `table.md`, `gg`, is this tool at `88c214e`. Each cell is recall / scorer precision / silent undercounts.

Each part names the measured build `Patched`, as the runner labels its `--tool`; for these files that build is upstream's. The `main` build is upstream's source at `b22055dce3c3ff22722793ed0a5a3be4491a9140` with a clean tree, which prints its package version, 0.28.0.

## Commands

- `table.md` and `scores.json`: the benchmark machine's driver `score_all.mjs`, not in this repository, which scores each kept answer with the benchmark's scorer, `node score_all.mjs <root> <dest> [tool:variant ...]`; the command line itself was not recorded.
- `upstream-*.txt`: each part is `node benchmark/run.mjs --tool <graft.js> --repos <7 repositories> --work <path> --verbose`, run from `src/gg`, the machine's checkout of this repository, whose runner script names that folder; [versions.txt](versions.txt) has its commit, `88c214e`, and its build time, before these runs; `run.mjs` was the JavaScript runner `gg-bench run` replaced.

## Pooling

The overall and per-language cells pool the repositories: calls found over calls in the truth, true edges over edges reported, and the sum of silent undercounts.

## Times

[runner-records.txt](runner-records.txt) gives these UTC times:

- This tool's scored pass ended at 18:09:25 (`PART gg-3 END`), and its last scored answer was written at 18:09:24. 2 repeat passes, not scored, ended at 18:10:17 and 18:11:02.
- Scoring started at 18:17:30 and wrote these files at 18:17:32.

## Versions

[versions.txt](versions.txt) has the builds behind these records, read on 19 November. The `main` build's checkout is at `b22055dce3c3ff22722793ed0a5a3be4491a9140` with no changed files. This tool's column is that `src/gg` build at `88c214e`; `scores.json` does not name it.
