# CodeGraph 1.6.3 and 1.6.2 on the 21 repositories

Recall / precision / silent undercounts, then each repository's calls found. `cg` is CodeGraph 1.6.3 (`@colbymchenry/codegraph` from npm, run 02:42 to 02:47 UTC on 18 November 2026); `cg162` is 1.6.2's answers from the 16 November run, rescored with them at 02:47. Scored with `gg-bench score` on the truth behind the README's table, which returns 1.6.2's answers to its figures. Both ran through the same adapter (`codegraph init .`, then `codegraph callers <name> --file <target file> --limit 1000000`; adapter file unchanged since 16 November). The 16 November run was in a sandbox with no network; this one had its own home folder and no sandbox.

| | cg:default | cg162:default |
| --- | --- | --- |
| Overall | 0.78 / 0.93 / 62 | 0.54 / 0.94 / 90 |
| Python | 0.98 / 0.98 / 8 | 0.97 / 0.98 / 12 |
| TypeScript | 0.89 / 0.95 / 15 | 0.82 / 0.95 / 22 |
| Rust | 0.62 / 0.88 / 39 | 0.17 / 0.82 / 56 |
| attrs | 277/282 0.98 | 275/282 0.98 |
| axum | 68/127 0.54 | 64/127 0.50 |
| click | 391/401 0.98 | 391/401 0.98 |
| flask | 26/33 0.79 | 21/33 0.64 |
| hono | 36/40 0.90 | 34/40 0.85 |
| httpx | 42/42 1.00 | 42/42 1.00 |
| jotai | 52/58 0.90 | 52/58 0.90 |
| mdbook | 40/51 0.78 | 20/51 0.39 |
| query | 73/73 1.00 | 72/73 0.99 |
| radix | 186/252 0.74 | 186/252 0.74 |
| rayon | 220/226 0.97 | 144/226 0.64 |
| rich | 131/132 0.99 | 131/132 0.99 |
| ripgrep | 25/45 0.56 | 22/45 0.49 |
| seaborn | 147/147 1.00 | 147/147 1.00 |
| structlog | 84/84 1.00 | 84/84 1.00 |
| table | 394/397 0.99 | 313/397 0.79 |
| tokio | 457/894 0.51 | 45/894 0.05 |
| tracing | 476/749 0.64 | 13/749 0.02 |
| trpc | 184/221 0.83 | 191/221 0.86 |
| vue | 83/88 0.94 | 82/88 0.93 |
| zola | 57/61 0.93 | 52/61 0.85 |
