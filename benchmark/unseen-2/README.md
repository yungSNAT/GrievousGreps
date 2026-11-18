# Unseen repositories, second set, preregistered

[unseen/](../unseen/README.md) tested `callers` on 5 repositories no build had run on. Its misses have since been read and fixed against, so from 18 November 2026 (UTC) those 5 are tuning, like the 21. This set replaces them as the held-out measure, with the same rules, in the same order:

1. This file and `repos.json` are committed first. The 5 were chosen on 18 November 2026 (UTC) as active public projects in the same 5 languages that appear in neither the 21-repository benchmark, [unseen/](../unseen/README.md) nor [semble's retrieval set](https://github.com/MinishLab/semble/tree/main/benchmarks). Each is pinned to its default branch's head that day.
2. Each repository's truth is then derived with `lsp-truth` and committed, before any GrievousGreps or rival build runs on it:

   ```bash
   cargo run --release --manifest-path rust/gg-bench/Cargo.toml -- --bench benchmark/unseen-2 lsp-truth --repo <name> --pick 10 --seed 20261118 -- <server>
   ```

3. Only then do the tools run, and the scorer is unchanged: `span` rules.

Symbols are picked and truth is derived as [unseen/](../unseen/README.md#how-symbols-are-picked) describes, with the seed 20261118 and the servers below.

| Repository | Language | Server |
| --- | --- | --- |
| Delgan/loguru @ 28349be | Python | pyright (`pyright-langserver --stdio`) |
| h3js/h3 @ 2f29b87 | TypeScript | typescript-language-server with the checkout's own TypeScript |
| toml-rs/toml @ 02d4d8d | Rust | rust-analyzer |
| uber-go/zap @ 4892335 | Go | gopls |
| FluentValidation/FluentValidation @ 5903fa6 | C# | csharp-ls 0.28.0 (Roslyn), with the .NET SDK the checkout needs |

## Truth

The truth in `truth/` was derived on Linux on 18 November 2026 (UTC), from 04:05 to 04:25, with `gg-bench` built from the preregistration commit `9252e6c`: pyright 1.1.414, typescript-language-server 6.1.0, rust-analyzer 0.3.3121, gopls v0.24.0 and csharp-ls 0.28.0 with the .NET SDK 10.0.404. For h3 this departs from the table above: h3's own TypeScript, 7.0.2, provides no `tsserver.js`, so typescript-language-server used its bundled TypeScript 6.0.3. h3's dependencies were installed with the pnpm its `devEngines` names, 12.3.4, from its lockfile; a first derivation of h3 without them, which picked the same 10 symbols with the same call counts, was discarded before any tool ran.

| Repository | Candidates derived | Required rows | Call lines | Optional rows |
| --- | ---: | ---: | ---: | ---: |
| loguru | 56 | 45 | 91 | 0 |
| h3 | 19 | 61 | 397 | 1 |
| toml | 69 | 35 | 48 | 0 |
| zap | 17 | 115 | 152 | 3 |
| fluentvalidation | 32 | 101 | 120 | 0 |

h3's `use` has 297 of its 397 call lines. The 5 were chosen by the criteria above, with no candidate list or random draw; zap was chosen whilst the Go receiver fix (#110) was in review, and #110 moved zap from 0.03 to 0.31. The build scored in the README, `4be1b3b`, has the graph code of `cc81761`, pushed at 03:54:05 before the set was chosen; only a test file and #109's hook shim changed afterwards. The limits in [unseen/](../unseen/README.md#limits) apply here too.
