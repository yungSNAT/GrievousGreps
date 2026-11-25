# Run outputs behind the README's 16 and 17 November 2026 figures

The figures that pull requests #90, #91 and #92 added to the README, and where each one's run output is. The files here are copied from the benchmark machine unchanged, except that `unseen-callers.txt` has local paths replaced with `<checkout>`. The outputs of other tools' runs were removed on 26 November 2026, with the README figures they stood behind.

| README figure | Output |
| --- | --- |
| Unseen repositories: recall 0.41, precision, silent undercounts, the per-repository rows, and 0.52 (166 of 319) on the 3 shared languages | [unseen-callers.txt](unseen-callers.txt), the `gg-bench` run of 02:08 UTC on 17 November |
| `trail ask` on semble's benchmark: NDCG@10, hit@1, hit@3, hit@10, 0 on Haskell | [ask-on-semble.md](ask-on-semble.md), 04:47 UTC on 17 November |
| Federation: click's 16 callers of `get_current_context` | [federation-callers.txt](federation-callers.txt) |
| `trail viz --export` on httpx: 1,016,743 bytes | the exported `index.html` on the benchmark machine (21:11 UTC on 16 November); not copied |

## Times kept on the benchmark machine only

These README times rest on records that were not copied here: 02:08 and 04:47 UTC on 17 November and 21:11 on 16 November in the table above, the job logs and output files of those runs.

## No surviving output

These figures were in the README, but no output of their runs was kept, so they are now out of it:

- the number of code nodes in httpx's `trail viz --export` (1,301);
- the time to build the 3-repository folder (10.5 s);
- that `trail ask` from that folder ranked click's and flask's definitions together.

All 3 were rerun at `57122b3` on 19 November with the output kept, in [../2026-11-19/](../2026-11-19/README.md).
