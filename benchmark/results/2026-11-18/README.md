# Reruns of 17 and 18 November 2026

Run on the benchmark machine (Linux, Node 26.13.1). Local paths are replaced with `<checkout>` or `<path>`. The outputs of other tools' runs were removed on 26 November 2026, with the README figures they stood behind.

| What | Output |
| --- | --- |
| The 21 repositories at `fc50a01` (main at #93, after #88 and #89) against upstream 0.29.0: 4,333 of 4,403 (0.98), precision 0.95, 7 silent undercounts; 0.29.0 1,410 (0.32) | [callers-21.txt](callers-21.txt), each repository run from 22:13 to 22:55 UTC on 17 November and pooled from the per-repository outputs |
| The 5 unseen repositories at `fc50a01`: 232 of 564 (0.41) | [unseen-callers.txt](unseen-callers.txt), 22:57 UTC on 17 November |
| Both unseen sets at `4be1b3b` (#110): the second, held out, 122 of 357 (0.34); the first, tuning since #110, 272 of 564 (0.48) | [unseen-2.txt](unseen-2.txt), 05:29 to 05:32 UTC on 18 November |
| `trail viz --export` on httpx at `fc50a01`: 1,016,743 bytes, as at `88c214e` | the exported `index.html` (22:58 UTC on 17 November); not copied |
| `trail ask` on semble's 60 Haskell queries at `4fcf41b`: NDCG@10 0.697 | [ask-haskell.md](ask-haskell.md), 01:33 to 01:35 UTC on 18 November |
