# Reruns of 19 November 2026

Run on the benchmark machine (Linux, Node 26.13.1) at `57122b3`, built from source. Local paths are replaced with `<path>`.

| README figure | Output |
| --- | --- |
| `trail viz --export` on httpx: 1,301 code nodes, 1,016,743 bytes, no script or style loaded from elsewhere | [federation-and-viz.txt](federation-and-viz.txt), the `viz --export on httpx` section |
| A folder holding click, flask and httpx: `trail build` in 28.23, 26.14 and 19.88 s, each from a fresh copy, at load averages of 13.04, 14.73 and 15.78 | the `multi-repository folder build` section |
| `trail callers get_current_context` from that folder: click's 16 callers, none in flask's `tests/test_cli.py` | the `trail callers` section |
| `trail ask "current context"` from that folder: one list taking each repository's next hit in turn | the first `trail ask` section; 3 more queries follow it |
| `trail ask` on semble's 1,251 questions at `57122b3`: NDCG@10, hit@1, hit@3 and hit@10, by category and language, and the 260 questions with no relevant file in the first 3 | [ask-on-semble.md](ask-on-semble.md), from `gg-bench ask` ([cmd-ask.sh](cmd-ask.sh), [ask-log.txt](ask-log.txt)); the ranked files are in [ask-files.json](ask-files.json) |

`cmd-ask.sh` and `ask-log.txt` are the job and its log as run, with local paths replaced by `<path>` and `<bench>`. R0731 and R3051 in them are internal tracking labels; 'wave 6' is the 17 November run in [../2026-11-17/](../2026-11-17/README.md) and its Python scorer, whose checkouts this run reused. That run matched a file to a target by its path under `benchmark_root`; the published table is the same kept answers graded again with each file's path under the checkout, as semble's file baselines match, which moves 4 questions (see [ask-on-semble.md](ask-on-semble.md)). Semble's annotations hold 2 questions twice, `HandlerStack` in guzzle and `IndifferentHash` in sinatra, with the same targets: each is asked twice and graded twice, but the kept answers, keyed by question, hold the second answer only, so `ask-files.json` has 1,249 entries.

[cmd-fed.sh](cmd-fed.sh) is the job, with local paths replaced by `<path>` and `<bench>`; it shows each command and how much of each output it kept (the last 4 lines of each build, so click's own line is cut). The output runs from 03:27:27 to 03:29:21 UTC, after the job built the tool, on the benchmark's pinned checkouts of click (`2247b35`), flask (`d086db8`) and httpx (`b5addb6`), each with a clean tree. The machine was running other jobs, so the build times are rough.

These rerun the 3 figures that [../2026-11-17/](../2026-11-17/README.md#no-surviving-output) lists as having no surviving output. The node count, 1,301, is this run's: no output of the 16 November count was kept. The 10.5 s build of that day is not restored: these runs shared the machine, so they do not test it. The third, that `trail ask` ranked click's and flask's definitions together, is now stated with what this run returned.
