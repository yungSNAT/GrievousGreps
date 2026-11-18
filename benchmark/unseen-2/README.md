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

The server versions are recorded with the truth.
