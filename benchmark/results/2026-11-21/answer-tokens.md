# Tokens of the plain `callers` answers, 21 November 2026 (UTC)

The 210 symbols of the caller benchmark's truth on its 21 pinned repositories, asked with `callers <symbol> <checkout copy>` and no `--json`, stdout and stderr together, as the 16 November runs kept them. Each graph was built with `build <copy> --no-gitignore --no-ignore` and the environment `gg-bench` sets (`DO_NOT_TRACK=1`, `TRAIL_CLOUD=0`, `GRAFT_NO_GITIGNORE=1`, `GRAFT_NO_IGNORE=1`, `GRAFT_NO_TRAIL_SWITCH=1`, a scratch home). Tokens are tiktoken 0.14.0's `o200k_base`. Linux, Node 26.13.1.

| Build | Answers | Bytes | Tokens | Median tokens an answer | Calls found | Tokens a call found |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `b3c7345` | 210 | 739,781 | 203,706 | 289.5 | 4,333 | 47.0 |
| `b3c7345` with each file printed once | 210 | 496,111 | 132,037 | 229.5 | 4,333 | 30.5 |

Calls found are from `gg-bench run --tool dist/bin/graft.js` at `b3c7345`: recall 0.98, 4,333 of 4,403 calls, precision 0.95, 7 silent undercounts. The change leaves `--json`, which `gg-bench` scores, as it was. Every one of the 210 answers lists the same number of hits in both builds, 6,743 in all.
