# Reruns of 19 November 2026

Run on the benchmark machine (Linux, Node 26.13.1) at `57122b3`, built from source. Local paths are replaced with `<path>`.

| README figure | Output |
| --- | --- |
| `trail viz --export` on httpx: 1,301 code nodes, 1,016,743 bytes, no script or style loaded from elsewhere | [federation-and-viz.txt](federation-and-viz.txt), the `viz --export on httpx` section |
| A folder holding click, flask and httpx: `trail build` in 28.23, 26.14 and 19.88 s, each from a fresh copy, at load averages of 13.04, 14.73 and 15.78 | the `multi-repository folder build` section |
| `trail callers get_current_context` from that folder: click's 16 callers, none in flask's `tests/test_cli.py` | the `trail callers` section |
| `trail ask "current context"` from that folder: one list taking each repository's hits in turn | the first `trail ask` section; 3 more queries follow it |

The job ran from 03:23:57 to 03:29:21 UTC, on the benchmark's pinned checkouts of click (`2247b35`), flask (`d086db8`) and httpx (`b5addb6`), each with a clean tree. The machine was running other jobs, so the build times are rough.

These rerun the 3 figures that [../2026-11-17/](../2026-11-17/README.md#no-surviving-output) lists as having no surviving output. The node count matches the 1,301 measured at `88c214e` on 16 November. The 10.5 s build of that day is not restored: these runs shared the machine, so they do not test it. The third, that `trail ask` ranked click's and flask's definitions together, is now stated with what this run returned.
