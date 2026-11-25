# Caller benchmark

This harness measures how many real calls `callers` finds. It builds a graph of 21 pinned public repositories with the tool you name, asks for the callers of 10 symbols in each and prints recall against committed truth. It is `gg-bench`, a Rust binary in [`rust/gg-bench`](../rust/gg-bench). It needs Rust (`cargo`), Node, git and network access to GitHub.

## Run it

Build the tool first, then:

```bash
cargo run --release --manifest-path rust/gg-bench/Cargo.toml -- run --tool dist/bin/graft.js
```

`--baseline <path>` scores a second build in the same run, beside the first.

| Option | Effect |
| --- | --- |
| `--tool <path>` | The JavaScript entry point to score. Required. |
| `--baseline <path>` | A second entry point, shown as the Upstream column. |
| `--repos httpx,click` | Score only these repositories. |
| `--work <dir>` | Where clones and graphs go. The default is a folder in the system temp directory. |
| `--verbose` | Print each symbol's score and first 10 misses to stderr. |
| `--node <path>` | The Node that runs the tool. The default is `node` on the path. |
| `--bench <dir>` | The folder with `repos.json` and `truth/`. The default is this folder. |

The harness runs one repository at a time at below normal priority. It keeps the shallow clones for the next run and deletes each graph copy after scoring. Each build's answers stay in the work folder's `answers/<upstream or patched>/<repository>.json`, keyed by symbol, with `null` for an answer that held no JSON, so `gg-bench score` can score them again. Each file is the latest answer set for its repository, overwritten by the next run in the same work folder; the files do not record which build or run wrote them. It only builds and queries, and never runs the tool's test suite.

Each run points `HOME`, `USERPROFILE`, `TRAIL_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` at a scratch folder under the work folder, and `DOTENV_CONFIG_PATH` at a missing file. The tool therefore leaves your graphs, agent settings and hooks alone and loads no `.env` file. Telemetry and the hosted workspace are off for the run.

On Windows with Node 26, httpx took about 40 seconds per build at 60 files. tokio, tracing and the larger TypeScript repositories have not been timed through this harness, so run the full set on a machine that is otherwise idle.

## Score another tool

`gg-bench score` scores one repository's answers from any tool, shaped as `callers --json` gives them: per symbol, a list of `matches`, each with the definition's `symbol` (its `path`, and its `span` under `span` rules) and its `hits` (each with `id`, `path`, `span` and `name`). Put the answers in one JSON object keyed by symbol:

```bash
cargo run --release --manifest-path rust/gg-bench/Cargo.toml -- score --repo httpx --answers httpx-answers.json
```

It prints each symbol's score and the repository's summary as JSON. A symbol with no answer scores as one with no callers, with a warning on stderr; an answer the rules cannot read, such as a hit without a `path`, stops it with an error.

## Ask a language server

`gg-bench lsp` asks a language server instead of a tool, for a column to set beside the graph tools. It starts the server in a copy of each pinned repository of one language, opens the target files, waits until the server reports no work in progress, finds each target among the server's document symbols and asks for its callers:

```bash
cargo run --release --manifest-path rust/gg-bench/Cargo.toml -- lsp --language Python --ask calls -- pyright-langserver --stdio
```

`--ask calls`, the default, uses call hierarchy: `textDocument/prepareCallHierarchy`, then `callHierarchy/incomingCalls`. `--ask references` uses `textDocument/references` without the declaration, which also returns imports and other references that are not calls. A server gives locations, not callers, so each location is named by the innermost definition around it in the server's own document symbols: modules and anonymous callbacks drop out, and a value inside a definition gives way to the definition. The answers go to the work folder's `lsp/<ask>/<repository>.json` in `callers --json` shape, with the server's stderr beside them. The report's first line, and the first line `lsp-truth` prints, name the server's version: its `serverInfo` version, or else the last line it prints to standard output when started in the checkout with `--version` in place of `--stdio` and exiting cleanly. Install each checkout's dependencies first where the server reads them, as rust-analyzer and the TypeScript server do. `--repos`, `--work` and `--verbose` work as they do for `run`.

## Ask: which files a question is about

`gg-bench ask` measures `trail ask` on [semble's retrieval benchmark](https://github.com/MinishLab/semble/tree/a1ba6c18a4b0a58a3d1a15217d64bc92678d1d9d/benchmarks): 1,251 questions on 63 repositories in 19 languages, each naming the files that answer it. [`ask/semble/`](ask/semble) holds its `repos.json` and `annotations/` as they are at semble's commit `a1ba6c1`, under semble's MIT licence ([`ask/semble/LICENSE`](ask/semble/LICENSE)). Nobody working on this tool wrote or chose its questions.

```bash
cargo run --release --manifest-path rust/gg-bench/Cargo.toml -- ask --tool dist/bin/graft.js
```

For each repository it fetches the pinned revision, builds the graph of the folder semble names (`benchmark_root`), asks each question once with `ask <question> <folder> --json -n 10` and removes the graph. It takes each answer's first 10 distinct files, from each hit's `pointer`, and scores them as semble's scripts score a search tool by file: NDCG@10 counts the question's `relevant` and `secondary` files, and a file, taken with its path under the checkout (`benchmark_root` joined to the pointer), matches a target when that path ends with the target's. hit@1, hit@3 and hit@10 are the share of questions with a `relevant` file among the first 1, 3 or 10. A question whose answer fails or has no JSON scores 0 and is counted as failed.

It prints the table (all questions, by category, by language), then every question with no relevant file among the first 3, with its first relevant rank and the first 3 files returned. The answers go to the work folder's `answers/<repository>.json`, in question order with the tool's version, the revision, `benchmark_root` and the questions they answer. A later run in the same work folder grades a repository from that file, without asking again, only when all 4 match and the tool's version is known, so a stopped run resumes and any other run asks again. A repository is kept once all its questions are asked, so a run stopped part way through one asks that repository again. `--category symbol` asks only that category's questions, `--repos` only those repositories, and `--set` reads another folder in the same format; `--work` and `--node` work as they do for `run`. The scratch environment is the one `run` uses.

## What it prints

The overall line is what the README carries. Recall is required calls found divided by required calls, pooled across the repository's 10 symbols, so a symbol with many callers weighs more. The overall line pools every repository the same way, so tokio and tracing hold more than a third of its weight. The detail tables add:

- macro recall, the mean of each symbol's recall
- precision, the reported callers that match a required call, divided by all reported callers
- silent, the symbols with a miss and no statement on the target's own JSON match that the answer may be short
- stated, the symbols with a miss and such a statement: an `unresolved` field, or a `note` saying the shared name may undercount. Notes on other definitions of the name do not count
- perfect, the symbols with every required call found and no false positive

## Scoring rules

- Only hits under the target definition count. Hits under another definition of the same name neither help nor hurt.
- A required row is a real call that resolves to the target. Definitions, comments, strings, same-named locals and other definitions' callers are excluded.
- An optional row is a true reference that is not a call, such as an import line. It neither helps recall nor hurts precision.
- A module-level row (`<file>`) needs only a hit in the file.
- The harness stops with an error if a tool gives no readable JSON for any symbol in a repository, so a broken build cannot show as a recall of 0.00.

The truth was written in 3 rounds, and each repository keeps the rules it was preregistered under. `repos.json` names them:

| Rules | Repositories | The target matches on | A hit satisfies a row when |
| --- | --- | --- | --- |
| `names` | flask, hono, ripgrep | File | Any part of its qualified name is one of the row's names |
| `chain` | jotai, mdbook, seaborn, structlog | File | Every part of its qualified name is in the row's chain of enclosing names |
| `span` | The other 14 | File and definition line | Its span contains one of the row's call lines |

`span` is the strictest. Rows under different rules are therefore not strictly comparable, and the overall line pools them anyway.

Under `span`, a file-level hit is never a false positive. Under the other 2, any hit that matches no required or optional row is one.

## Truth

`truth/<repo>.json` holds, per symbol, the target file, a note on what makes the symbol hard (`category`, where one was written), the required rows and any optional rows. `span` truth also has the definition lines. `repos.json` pins each repository to a commit.

A verifier wrote each set with tree-sitter, `rg` and reading, and committed it to a local log before any build ran on that repository. That log is not public, so the order of events rests on this statement.

On 13 November 2026 (UTC) the rows for hono, radix and trpc were replaced by rows that the TypeScript compiler derives. `tsc-truth.mjs` keeps each symbol and target, asks the compiler's language service for every reference to the target, and writes:

- a required row for each call, `new`, tagged template, decorator or JSX element whose callee is the target, also inside parentheses, `as`, `satisfies` or `!` and as `obj['name']`, grouped by file and calling definition. A call inside an anonymous callback belongs to the named definition around it, or to the file (`<file>`) at module level.
- an optional row for any other reference inside a named definition, such as the function passed as a value.
- no row for a module-level reference that is not a call, such as an import or re-export.

It follows a function stored in an object literal, such as `const Jwt = { verify }`, one level to calls such as `Jwt.verify()`. Workspace packages resolve to their source through the root `tsconfig.json`'s `paths` and each manifest's exports. Each checkout's own TypeScript ran: 6.0.3 for hono and trpc, 5.9.3 for radix. To regenerate a set, install the checkout's dependencies (`pnpm install --frozen-lockfile --ignore-scripts`; trpc's lockfile and manifest disagree, so it needs `--no-frozen-lockfile`), then:

```bash
node benchmark/tsc-truth.mjs --repo <checkout> --name radix --out benchmark/truth/radix.json
```

Every hand-written row of the 3 has a derived row in the same file, on the same line for radix and trpc and with the same calling name for hono. The compiler found calls the reading missed, mostly in radix's storybook and server-rendering apps and tests, and a recursive call in hono's `mergePath`. It also names the calling definition where a hand-written row said `<file>` or grouped several callers, so radix went from 129 rows to 252, trpc from 192 to 221 and hono from 39 to 40.

Limits of the truth:

- It has one author and no second reviewer, and it may hold errors. The 3 compiler-derived sets rest on the compiler instead, but they were made after builds had run on those repositories, so they were not preregistered.
- One correction came after a first scoring pass: the target lines of httpx `to_bytes` and `create_ssl_context` were off by one (79 and 23). No required row changed.
- A second came on 15 November 2026 (UTC): tokio `channel` lacked 49 calls written with a turbofish, such as `mpsc::channel::<()>(1)`, mostly in `tokio/tests/sync_mpsc.rs`. A build that reads that form returned them and the scorer counted them false. A scan of the checkout for every `channel::<` call that resolves to `tokio::sync::mpsc::channel` found the same 49 and no others, and each was read. They were added as required rows, so tokio holds 894 calls and the 21 repositories 4,359.
- A third came later that day: attrs `resolve_types` lacked 5 tests in `tests/test_annotations.py` that apply it as a decorator without arguments (`@attr.resolve_types`), which calls it with the class. A build that reads that form returned them and the scorer counted them false. A scan of the checkout for every decorator without arguments naming one of attrs' 10 symbols found these 7 uses in 5 tests and no others, and each was read. They were added as required rows, so attrs holds 282 calls and the 21 repositories 4,364.
- A fourth came on 16 November 2026 (UTC): table lacked 39 calls in Svelte and Vue components. A build that reads Svelte returned one of them, an `isFunction` call in `packages/svelte-table/src/FlexRender.svelte`, and the scorer counted it false. A scan of every `.svelte`, `.vue` and `.astro` file in the 7 TypeScript checkouts for calls of their 10 symbols found 37 `createColumnHelper` calls through `@tanstack/svelte-table` and `@tanstack/vue-table`, which re-export it from table-core, and 2 `isFunction` calls, and each was read. Calls that reach another package's own function of the same name, such as svelte-table's `createTable`, are not calls of the target. query, trpc and vue had none, and hono, jotai and radix have no component files. They were added as required rows, so table holds 397 calls and the 21 repositories 4,403.
- Two symbols were replaced before any run, because the first choice had no call rows or no longer existed: click `get_app_dir` and table `getMemoOptions`.
- Earlier builds have run on all 21 repositories, so fixes made in between may have been shaped by their results. None is an unseen holdout any more. [unseen/](unseen/README.md) holds 5 repositories that no build had run on, preregistered on 16 November 2026 (UTC), with truth that `gg-bench lsp-truth` derived from their language servers. Their misses were read and fixed against on 18 November, so [unseen-2/](unseen-2/README.md), preregistered that day the same way, is the held-out set now.
- The tracing and tokio symbols were chosen for repeated names and cross-crate calls, so those rows test the known weak spot on purpose.
- It is 210 symbols on 21 repositories. It does not estimate recall on your code.

## Recall history

The records behind the main README's [Measured recall](../README.md#measured-recall) figures.

**Corrections to the truth.** One correction came after a first scoring pass: the target lines of httpx `to_bytes` and `create_ssl_context` were off by one. No required row changed. A second came on 15 November 2026 (UTC): tokio `channel` lacked 49 calls written with a turbofish, such as `mpsc::channel::<()>(1)`, which [Truth](#truth) lists with how they were found and checked. They are now required rows, so tokio holds 894 calls and the 21 repositories 4,359. A third came later that day: attrs `resolve_types` lacked 5 calls that apply it as a decorator without arguments, which [Truth](#truth) also lists. They are now required rows, so attrs holds 282 calls and the 21 repositories 4,364. A fourth came on 16 November: table lacked 39 calls in Svelte and Vue components, which [Truth](#truth) lists too. They are now required rows, so table holds 397 calls and the 21 repositories 4,403. The README's figures were scored on these 4,403 calls.

**The run behind the figures.** This build ran on Linux with Node 26.13.1 on 16 November 2026 (UTC) at `88c214e`, whose code is that of `3e066a2`, and was scored on the truth with all 4 corrections. Linux and Windows gave identical benchmark results at `e37a764` on all 21 repositories, and `e8f73b9` matched them. Rerun on Linux on 17 November at `fc50a01`, which is `0df7dcc` plus #88 to #93 (#88 and #89 change the graph), it found 4,333 of the 4,403 calls (0.98), with precision 0.95 and 7 silent undercounts, and the 5 unseen repositories gave 232 of 564 (0.41). The records of these runs also scored other builds, so they are not published; the command in [Run it](#run-it) repeats them.

## Install and use measurements

The measurements behind the main README's [Install](../README.md#install) and [Use](../README.md#use) sections.

**Install.** With npm 12.2.2 and Node 26.13.1 on Linux, on 16 November 2026 (UTC) at `2a68b91`, the install took 103 s and 131 MiB of disk. At `1244ddf` on 18 November both commands printed `0.28.0+gg.1244ddf626b8`, the version and the commit.

**Viewer export.** `trail viz --export site/` wrote httpx's 1,301 code nodes as an `index.html` of 1,016,743 bytes at `57122b3` on 19 November 2026 (UTC), with no script or style loaded from elsewhere ([output](results/2026-11-19/README.md)); at `88c214e` on 16 November it was the same size, from an export not kept.

**Semantic ranking's first-run cost.** On Linux on 19 November (UTC), at `ebef20c`, cold builds of the 63 checkouts of semble's benchmark took 266.6 s in all against 158.6 s with `TRAIL_SEMANTIC=0` (zig, the largest, 31.7 s against 14.7 s), the vectors came to 76.7 MB (11.9 MB for zig), and `trail ask` took 0.60 s longer on zig, 0.23 s longer on zig-clap and no longer on flask, by the median of 5 questions on each ([builds](results/2026-11-19/ask-semantic-builds.tsv), [ask times](results/2026-11-19/ask-semantic-ask-times.tsv)).

**A folder of several repositories.** On 16 November 2026 (UTC), on Linux at `88c214e`, a folder holding click, flask and httpx built a graph for each. On 19 November, at `57122b3`, the same folder built in 20 to 28 s in 3 runs on a shared machine (load average 13 to 16), and `trail ask "current context"` from it listed hits from all 3 in one list, taking each repository's next hit in turn, by its own ranking: click's `get_current_context`, flask's `copy_current_request_context`, httpx's `create_ssl_context`, then click again ([output](results/2026-11-19/README.md)).
