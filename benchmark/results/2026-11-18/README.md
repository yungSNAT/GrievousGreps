# Reruns of 17 and 18 November 2026, and the records checked

Run on the benchmark machine (Linux, Node 26.13.1). Local paths are replaced with `<checkout>` or `<path>`.

| What | Output |
| --- | --- |
| The 21 repositories at `fc50a01` (main after #88 and #89) against upstream 0.29.0: 4,333 of 4,403 (0.98), precision 0.95, 7 silent undercounts; 0.29.0 1,410 (0.32) | [callers-21.txt](callers-21.txt), each repository run from 22:13 to 22:55 UTC on 17 November and pooled from the per-repository outputs |
| The 5 unseen repositories at `fc50a01`: 232 of 564 (0.41) | [unseen-callers.txt](unseen-callers.txt), 22:57 UTC on 17 November |
| `trail viz --export` on httpx at `fc50a01`: 1,016,743 bytes, as at `88c214e` | the exported `index.html` (22:58 UTC on 17 November); not copied |
| The language-server column again, with `gg-bench` at `6a4c63f`, and the bisect of its TypeScript change | [language-servers-rerun.txt](language-servers-rerun.txt), 00:41 to 01:28 UTC on 18 November |

## The language-server column at `6a4c63f`

With the servers and prepared checkouts of the 16 November run, recall matched on every Python and Rust repository. On TypeScript, jotai fell from 57 to 38 of 58 calls and hono from 18 to 9 of 40, and fewer locations were returned for query, radix, table, trpc and vue at the same recall. `27f8489`, the commit before #98, gave the 16 November figures, as did the revert of #98's `caller_chain` change: typescript-language-server reports a function held in a `const` as a value, which #98 stopped naming as a caller. The README's column, at `8f297cb`, is unaffected.

## Records checked on the benchmark machine

- `8f297cb`: the source the 16 November column ran from (`rust/` and `benchmark/`) is identical to that commit's, and its files carry that commit's time.
- 21:40 and 00:23 UTC: the column's job started at 21:40:33 on 16 November and its pooled table was written at 00:23:01 on 17 November.
- Graphicle on table: its runner's record reads `timeout 517 s`.
- sem on tokio and tracing: its index command exited with 1 on both (`index_exit` in the runner's records).
- The 7 scored tools' window: their httpx answers were written from 20:43:36 to 21:02:32 UTC on 16 November, during the adapter tests; the done markers for those tests are from 21:04:35. The README now starts the window at 20:43. Scoring was at 04:53:06 on 17 November.
