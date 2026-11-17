# Unseen repositories, preregistered

This set tests `callers` on 5 repositories that no build of this tool or its benchmark has run on, with truth that a language server derives rather than a person. Its order is fixed here, before anything runs on them:

1. This file and `repos.json` are committed first. The 5 were chosen on 16 November 2026 (UTC) as active public projects in 5 languages that appear in neither the 21-repository benchmark nor [semble's retrieval set](https://github.com/MinishLab/semble/tree/main/benchmarks), on which `trail ask` is measured. Each is pinned to its default branch's head that day.
2. Each repository's truth is then derived and committed, before any GrievousGreps or rival build runs on it:

   ```bash
   cargo run --release --manifest-path rust/gg-bench/Cargo.toml -- --bench benchmark/unseen lsp-truth --repo <name> --pick 10 --seed 20261117 -- <server>
   ```

3. Only then do the tools run, and the scorer is unchanged: `span` rules, as for 14 of the 21.

| Repository | Language | Server |
| --- | --- | --- |
| marshmallow-code/marshmallow @ 777ff66 | Python | pyright 1.1.414 (`pyright-langserver --stdio`) |
| immerjs/immer @ 784c86b | TypeScript | typescript-language-server 6.1.0 with the checkout's own TypeScript |
| serde-rs/json @ f51fa15 | Rust | rust-analyzer 2026-11-16 |
| sirupsen/logrus @ 6ef0748 | Go | gopls, the latest release on the day of the run |
| serilog/serilog @ 43105b3 | C# | csharp-ls 0.28.0 (Roslyn), with the .NET SDK the checkout needs |

## How symbols are picked

`--pick 10` lists every function and method (LSP symbol kinds 12 and 6) that the server reports in the repository's source files, outside folders named for tests, examples, benchmarks, documentation, fixtures, vendored or built code, and outside test files. Names shorter than 3 characters and Python's `__dunder__` methods are left out. The list, in file and line order, is shuffled with SplitMix64 from the seed 20261117. In that order each candidate's references are derived, and it is kept if it has 3 to 300 calls, until 10 are kept. A name already kept is qualified with its owner, such as `Logger.info`, and skipped if that is taken too.

## How truth is derived

For each kept definition the server is asked for every reference, without the declaration. A reference is a call when the line continues with `(`, after any generic arguments (`::<T>` in Rust, `[T]` in Go, `<T>` in C# and TypeScript), or when it is a Python or TypeScript decorator, a JSX element or a tagged template. Calls become required rows, grouped by file and by the named definition around them, or by file (`<file>`) at module level. Any other reference inside a named definition is an optional row; one at module level, such as an import, gets no row. This follows `tsc-truth.mjs`, with 2 differences: the call test reads the line rather than a syntax tree, so a call whose `(` starts the next line counts as a reference, and a calling definition is any symbol the server reports other than a module, namespace or package or a value such as a variable, field or constant whose line does not assign a function, rather than the compiler's syntax kinds.

serilog's project lists its target frameworks with a leading empty entry when not on Windows, which Roslyn's MSBuild workspace cannot load ([dotnet/vscode-csharp#5786](https://github.com/dotnet/vscode-csharp/issues/5786)), so csharp-ls runs with `TargetFramework=net10.0` in its environment.

A first derivation on 16 November 2026 (UTC), before any tool had run on the 5, had 3 faults, which were fixed before the truth was derived again: gopls names a method by its receiver, as `(*Logger).WithFields`, so Go methods were neither picked nor named as callers; a TypeScript arrow function held in a variable, as `let has = (...) =>`, was not named as a caller; and csharp-ls loaded no serilog project, as above, so no C# symbol was picked. A pick now fails rather than write fewer than 10 symbols.

The truth in `truth/` was derived on 16 November 2026 (UTC), on Linux, with the servers above; gopls was v0.24.0 and rust-analyzer reported 0.3.3121.

| Repository | Candidates derived | Required rows | Calls | Optional rows |
| --- | ---: | ---: | ---: | ---: |
| marshmallow | 32 | 228 | 272 | 0 |
| immer | 53 | 30 | 37 | 0 |
| serde_json | 42 | 49 | 89 | 1 |
| logrus | 29 | 143 | 195 | 2 |
| serilog | 55 | 102 | 309 | 4 |

## Limits

- The truth is the server's. A call the server cannot resolve, such as one through Python's dynamic attributes, is missing from it, so a tool that finds such a call is charged a false positive.
- The language-server column of the main benchmark is not run here, because these servers wrote the truth.
- 5 repositories with 10 symbols each estimate nothing about recall on other code; they only test whether the 21-repository figures hold on code no build has seen.
