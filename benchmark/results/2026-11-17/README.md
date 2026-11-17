# Run outputs behind the README's 16 and 17 November 2026 figures

The figures that pull requests #90, #91 and #92 added to the README, and where each one's run output is. The files here are copied from the benchmark machine unchanged, except that `unseen-callers.txt` has local paths replaced with `<checkout>` and `call-graph-tools.md` keeps only the 7 scored tools' columns.

| README figure | Output |
| --- | --- |
| Unseen repositories: recall 0.41 and 0.38, precision, silent undercounts, the per-repository rows, and 0.52 (166 of 319) and 0.47 (150 of 319) on the 3 shared languages | [unseen-callers.txt](unseen-callers.txt), the `gg-bench` run of 02:08 UTC on 17 November |
| The 7 further call-graph tools' table, the 3 repositories where one beat this tool and the ties on vue and zola | [call-graph-tools.md](call-graph-tools.md), scored at 04:53 UTC on 17 November (`cs` codeseek, `sm` sem, `tl` tilth, `rp` ripwire, `cd` codedb, `gx` Graphicle, `ga` grepai) |
| Graphicle's timeout on table (517 s) and sem's index errors on tokio and tracing | The runner's records on the benchmark machine; not copied |
| The 4 unscored tools: gortex's 176 of 237 answers marked incomplete, trace-mcp's 33 TypeScript rows, Auryn's none | [unscored-tools.md](unscored-tools.md), read from the same scorer output and answers |
| Language-server column (recall, precision and silent undercounts) | [language-servers.md](language-servers.md), pooled at 00:23 UTC on 17 November |
| Tokens a callers answer, `rg`, `skeleton`, `map` and Repomix | [answer-tokens.md](answer-tokens.md), counted at 04:10 UTC on 17 November |
| `trail ask` on semble's benchmark: NDCG@10, hit@1, hit@3, hit@10, 0 on Haskell | [ask-on-semble.md](ask-on-semble.md), 04:47 UTC on 17 November |
| Federation: click's 16 callers of `get_current_context` | [federation-callers.txt](federation-callers.txt) |
| `trail viz --export` on httpx: 1,016,743 bytes | the exported `index.html` on the benchmark machine (21:11 UTC on 16 November); not copied |
| Licences of the 7 tools | [licences.txt](licences.txt), read again at 05:29 UTC on 17 November |
| Tool versions | [versions.txt](versions.txt) |

## Times kept on the benchmark machine only

These README times rest on records that were not copied here:

- 21:04 UTC on 16 November, the start of the 7 scored tools' window: the earliest of their runner's done markers (the httpx runs).
- 21:40 UTC on 16 November, the language-server column's start: its job's start record.
- 00:23 UTC on 17 November, the column's pooling: the modification time of its pooled table, copied here as `language-servers.md`.
- 02:08, 04:10 and 04:47 UTC on 17 November and 21:11 on 16 November in the table above: the job logs and output files of those runs.

## No surviving output

These figures were in the README, but no output of their runs was kept, so they are now out of it:

- the number of code nodes in httpx's `trail viz --export` (1,301);
- the time to build the 3-repository folder (10.5 s);
- that `trail ask` from that folder ranked click's and flask's definitions together.
