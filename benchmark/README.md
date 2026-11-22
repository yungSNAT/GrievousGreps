# Caller benchmark

This harness measures how many real calls `callers` finds. It builds a graph of 21 pinned public repositories with the tool you name, asks for the callers of 10 symbols in each and prints recall against committed truth. It is `gg-bench`, a Rust binary in [`rust/gg-bench`](../rust/gg-bench). It needs Rust (`cargo`), Node, git and network access to GitHub.

## Run it

Build the tool first, then:

```bash
cargo run --release --manifest-path rust/gg-bench/Cargo.toml -- run --tool dist/bin/graft.js
```

The README's table has 2 upstream columns, each from its own run with that build as the baseline. For the npm release, install it in another folder; `DO_NOT_TRACK=1` stops its install script sending a usage event:

```bash
DO_NOT_TRACK=1 npm install --prefix ../upstream-0.29.0 @trailhq/trail-code@0.29.0
cargo run --release --manifest-path rust/gg-bench/Cargo.toml -- run --tool dist/bin/graft.js --baseline ../upstream-0.29.0/node_modules/@trailhq/trail-code/dist/bin/graft.js
```

For upstream `main`, build it at the commit the README names:

```bash
git clone https://github.com/trailhq/Trail-Code ../upstream
git -C ../upstream checkout b22055dce3c3ff22722793ed0a5a3be4491a9140
(cd ../upstream && npm ci)
cargo run --release --manifest-path rust/gg-bench/Cargo.toml -- run --tool dist/bin/graft.js --baseline ../upstream/dist/bin/graft.js
```

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

`--ask calls`, the default, uses call hierarchy: `textDocument/prepareCallHierarchy`, then `callHierarchy/incomingCalls`. `--ask references` uses `textDocument/references` without the declaration, which also returns imports and other references that are not calls. A server gives locations, not callers, so each location is named by the innermost definition around it in the server's own document symbols, as Serena's column is mapped: modules and anonymous callbacks drop out, and a value inside a definition gives way to the definition. The answers go to the work folder's `lsp/<ask>/<repository>.json` in `callers --json` shape, with the server's stderr beside them. The report's first line, and the first line `lsp-truth` prints, name the server's version: its `serverInfo` version, or else the last line it prints to standard output when started in the checkout with `--version` in place of `--stdio` and exiting cleanly. Install each checkout's dependencies first where the server reads them, as rust-analyzer and the TypeScript server do. `--repos`, `--work` and `--verbose` work as they do for `run`.

## Ask: which files a question is about

`gg-bench ask` measures `trail ask` on [semble's retrieval benchmark](https://github.com/MinishLab/semble/tree/a1ba6c18a4b0a58a3d1a15217d64bc92678d1d9d/benchmarks): 1,251 questions on 63 repositories in 19 languages, each naming the files that answer it. [`ask/semble/`](ask/semble) holds its `repos.json` and `annotations/` as they are at semble's commit `a1ba6c1`, under semble's MIT licence ([`ask/semble/LICENSE`](ask/semble/LICENSE)). Nobody working on this tool wrote or chose its questions.

```bash
cargo run --release --manifest-path rust/gg-bench/Cargo.toml -- ask --tool dist/bin/graft.js
```

For each repository it fetches the pinned revision, builds the graph of the folder semble names (`benchmark_root`), asks each question once with `ask <question> <folder> --json -n 10` and removes the graph. It takes each answer's first 10 distinct files, from each hit's `pointer`, and scores them as semble's scripts score a search tool by file: NDCG@10 counts the question's `relevant` and `secondary` files, and a file, taken with its path under the checkout (`benchmark_root` joined to the pointer), matches a target when that path ends with the target's. hit@1, hit@3 and hit@10 are the share of questions with a `relevant` file among the first 1, 3 or 10. A question whose answer fails or has no JSON scores 0 and is counted as failed.

It prints the table (all questions, by category, by language), then every question with no relevant file among the first 3, with its first relevant rank and the first 3 files returned. The answers go to the work folder's `answers/<repository>.json`, in question order with the tool's version, the revision, `benchmark_root` and the questions they answer. A later run in the same work folder grades a repository from that file, without asking again, only when all 4 match and the tool's version is known, so a stopped run resumes and any other run asks again. A repository is kept once all its questions are asked, so a run stopped part way through one asks that repository again. `--category symbol` asks only that category's questions, `--repos` only those repositories, and `--set` reads another folder in the same format; `--work` and `--node` work as they do for `run`. The scratch environment is the one `run` uses.

## What it prints

The overall line and first table are what the README carries. Recall is required calls found divided by required calls, pooled across the repository's 10 symbols, so a symbol with many callers weighs more. The overall line pools every repository the same way, so tokio and tracing hold more than a third of its weight. The detail tables add:

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

The records behind the main README's [Measured recall](../README.md#measured-recall) table.

**Corrections to the truth.** One correction came after a first scoring pass: the target lines of httpx `to_bytes` and `create_ssl_context` were off by one. No required row changed. A second came on 15 November 2026 (UTC): tokio `channel` lacked 49 calls written with a turbofish, such as `mpsc::channel::<()>(1)`, which [Truth](#truth) lists with how they were found and checked. They are now required rows, so tokio holds 894 calls and the 21 repositories 4,359. A third came later that day: attrs `resolve_types` lacked 5 calls that apply it as a decorator without arguments, which [Truth](#truth) also lists. They are now required rows, so attrs holds 282 calls and the 21 repositories 4,364. A fourth came on 16 November: table lacked 39 calls in Svelte and Vue components, which [Truth](#truth) lists too. They are now required rows, so table holds 397 calls and the 21 repositories 4,403. Every column below was scored on these 4,403 calls.

**Earlier runs.** On the hand-written truth for all 21, the 13 November runs gave recall 0.31, 0.77 and 0.20 and silent undercounts 74, 14 and 113 (0.29.0, patched at `219b118`, `main`). The 12 November runs, on that truth, counted under an earlier rule, which searched the plain output for words such as 'undercount', and gave 50, 5 and 90 silent undercounts.

**Upstream's history.** On the hand-written truth, 0.29.0 gave the same figures on all 21 repositories as `a44da3d` (30 October), the `main` commit whose package version is 0.28.0, gave on 31 October. Since 0.29.0, upstream `main`'s Python and Rust rows held or rose (rich 0.57 to 0.80), but 6 of its 7 TypeScript rows fell, from 0.90 to 0.33 on jotai and from 0.73 to 0.02 on radix: `main` no longer finds some symbols, such as radix `FocusScope`, which it reports as not in the graph. A rerun of `a44da3d` on the same machine on 12 November gave its earlier TypeScript figures, so the fall is upstream's change, not the run.

**The runs behind the table.** All 3 columns were run on Linux with Node 26.13.1 on 16 November 2026 (UTC) and scored on the truth with all 4 corrections: the patched column at `88c214e`, whose code is that of `3e066a2`, 0.29.0 as the npm package `@trailhq/trail-code@0.29.0` with its install script skipped, and `main` built from source; their records are in [benchmark/results/2026-11-16/](results/2026-11-16/README.md). Against the 15 November runs, only the table row of the 2 upstream columns changed, for its 39 new calls, and the patched figures matched those of `3e066a2` on every row. On the hand-written truth every recall figure matched the 12 November runs (patched at `166c2fd` and `eaa8393`). Linux and Windows gave identical benchmark results at `e37a764` on all 21 repositories, and `e8f73b9` matched them. `a44da3d` was run on Windows and, for those 6 TypeScript rows, again on Linux. Rerun on Linux on 17 November at `fc50a01`, which is `0df7dcc` plus #88 to #93 (#88 and #89 change the graph), the patched column found 4,333 of the 4,403 calls (0.98), with precision 0.95 and 7 silent undercounts, and the 5 unseen repositories gave 232 of 564 (0.41) ([benchmark/results/2026-11-18/](results/2026-11-18/README.md)).

## Against the alternatives

How the tools in the main README's [Against the alternatives](../README.md#against-the-alternatives) tables were run and scored, and what they cost.

Licences were checked against each project's LICENSE file at its latest release, which is the version tested: [codebase-memory-mcp v0.12.1](https://github.com/DeusData/codebase-memory-mcp/blob/v0.12.1/LICENSE) and [Serena v2.1.0](https://github.com/oraios/serena/blob/v2.1.0/LICENSE) and [code-review-graph v2.4.0](https://github.com/tirth8205/code-review-graph/blob/v2.4.0/LICENSE), on 15 November 2026. Serena's application has been GPL-3.0-or-later since commit `6707cd9b` (14 September 2026), and its `serena-agent` package declares that licence; its SolidLSP library stays MIT, as do Serena releases up to v1.7.0.

**The 6 further tools.** CodeGraph 1.6.2, on 16 November, gave 0.54 / 0.94 / 90 overall and 0.17 on Rust; 1.6.3, through the same adapter, found more on tokio, tracing, rayon, mdbook and table, and fewer on trpc (184 of 221, against 191) ([benchmark/results/2026-11-18/codegraph-1.6.3.md](results/2026-11-18/codegraph-1.6.3.md)). AxiomCode Graph returned no Rust callers, so it has no Rust precision, and its run on query hit its time limit, so its cells pool the other 20 repositories. Each tool built its index with its documented command and answered its documented callers question: CodeGraph `codegraph callers`, CodeGraphContext's MCP `find_callers`, repowise `context --include callers`, tokensave's MCP symbol lookup and callers, Graphify `explain`, and AxiomCode Graph `impact`. These 6 licences are GitHub's reading of each repository's licence on 16 November 2026, and AxiomCode Graph's from its npm package; they were not checked file by file at each release.

**The first 7 of the 11 more call-graph tools.** Graphicle timed out on table after 517 s, so its figures pool the other 20 repositories. sem's index command exited with an error on tokio and tracing, and its answers there are scored as it gave them. grepai builds its symbol index only with an embedding endpoint; a local stand-in that returns one fixed vector served it, as its `trace callers` reads the symbol index, not the vectors. These licences are GitHub's reading of each repository's licence on 17 November 2026, except tilth's, from its README of 16 November, as GitHub no longer finds the repository.

**The other 4.** Axon reads Python, TypeScript and JavaScript only, as its README says, so it gave no Rust callers; its index command exited with an error on rayon, ripgrep, tokio and tracing. Every trace-mcp answer on a Rust repository that named a definition says its index has no Rust call edges. trace-mcp's language presets index only `src` for Rust and `src`, `lib`, `test` and `tests` for TypeScript, which leaves out a workspace's other crates and packages, so the harness set its `.trace.json` `include` to every Python, Rust, or TypeScript and JavaScript file, which is not its default, and ran it without its shared daemon. gortex ran with state folders of its own for each repository, and each question was asked again until the answer no longer said its daemon was warming up; it marked 67 of the 236 definitions it answered `coverage_incomplete`, which the scorer counts as stated. Auryn names some callers by module rather than file, so the harness took the file from the caller's node, else from the file node that defines it, else from its module path, and read every page of a query past Auryn's 1,000-row limit. The licences are GitHub's reading of each repository on 17 November 2026, except Axon's: its repository has no licence file, and its package, axoniq 1.0.1, declares MIT.

**Language servers.** The servers' lowest rows, radix, structlog, attrs and click (0.02 to 0.10 by call hierarchy), are 4 of the 5 that Serena's tuned row reconfigures; these servers ran at defaults only. The column opens only the target files, and the TypeScript server searches only the projects of open files: asked for references by `gg-bench lsp-truth` on 17 November, the same server found 255 of the 261 call lines in hono's compiler-derived truth with every file open, against 31 with only the targets open.

### Limits of the comparison

Read the tables with these limits:

- The truth was written alongside this tool and all 21 repositories have been seen in development, so the table does not predict recall on other code: on 5 repositories no build had seen it was 0.34.
- A silent undercount is a symbol whose answer misses a caller and whose JSON does not say it may be short. The scorer reads 2 fields on each answer as the harness shaped it into `callers --json` form: `unresolved`, or a `note` containing 'may undercount', which are the fields this tool writes when calls went unresolved or a name is shared. A rival's warning counts as stated only where the harness carried it into one of them, as it did gortex's `coverage_incomplete`; any other warning is counted silent. The earlier rule, which searched the plain output for words such as 'undercount', gives 5, 89, 94, 66 and 86 on the 15 November answers, with this tool at `491b060`.
- codebase-memory-mcp used documented non-default settings because the truth counts test callers: `depth=1`, `include_tests=true`, `limit=5000` and `max_output_tokens=1000000`. At its defaults its overall recall is 0.29.
- code-review-graph was asked through its MCP server's `query_graph_tool` with `callers_of` and `max_results=100000`, as its default of 100 would cut long answers, after a `code-review-graph build`. Each target came from the tool's `file_summary` of the target file. Its `file_summary` listed no matching definition for 4 targets: hono `createFactory`, an arrow function, and tokio `spawn`, `spawn_blocking` and `block_in_place`, which sit inside `cfg_rt!` and `cfg_rt_multi_thread!` macros.
- Serena's tuned row was chosen after seeing its scores. It removes the `[tool.pyright]` table on attrs, click and structlog, and adds generated TypeScript project references on radix and trpc. Serena's Pyright, typescript-language-server and rust-analyzer ran at their documented defaults, with dependencies fetched first.
- The scorer's precision understates the first 3 tools. On 15 November, with this tool at `491b060`, 22, 16 and 21 of 25 edges the scorer called false were judged true by reading the source (this tool, codebase-memory-mcp, Serena), and 25, 23 and 25 of 25 random edges per tool were true; a sample that size does not separate them. The check of 31 October, with this tool at `e37a764`, gave 25, 19 and 24, and 23, 24 and 25. code-review-graph was not in the sample.

### Cost

**Cost, as medians across the 21 repositories** (this tool, codebase-memory-mcp, Serena, code-review-graph): index time 4.24, 4.33, 10.92 and 5.92 s, with Serena's first query adding 4.18 s; peak memory when querying 100, 41, 1,123 and 101 MiB. Answers across all queries came to 719,535, 291,999, 1,488,043 and 4,650,547 bytes, before target lookups of 178,457 bytes for codebase-memory-mcp, 37,086 for Serena and 1,954,645 for code-review-graph. codebase-memory-mcp and code-review-graph name each caller with the checkout's path, so their byte counts grow with that path. 3 runs each on httpx, mdbook and hono gave the same recall every time; index times varied by up to 1.55 s for this tool (hono), 0.71 s for codebase-memory-mcp (mdbook), 7.90 s for Serena (hono) and 7.87 s for code-review-graph (hono). These runs do not rank latency, because a CLI process per query and an MCP server are not like for like.

### What an agent reads, in tokens

On 17 November 2026 (UTC) the plain answers of the 16 November runs, as each tool prints them, were counted with tiktoken's `o200k_base` encoding. This tool's 210 callers answers came to 203,627 tokens, against 1,098,195 for `rg -n -w <name>` on the same names. In those runs codebase-memory-mcp and CodeGraph 1.6.2 spent fewer tokens on each call they found; this tool found more calls.

On 21 November 2026 (UTC) this tool's answers were counted again the same way, on the same 210 symbols. At `b3c7345` they came to 203,706 tokens, 47.0 a call found, with 4,333 calls found (`gg-bench run` at `b3c7345`). The report now prints a file's path once for each group of its hits (by relation and inferred mark), a group's unquoted callers on one line, a shared relation once, and a quoted caller at the line of its call: on top of `b3c7345` it came to 132,037 tokens, 30.5 a call found, with the same hits in every answer, 6,743 in all, and `--json` unchanged ([benchmark/results/2026-11-21/answer-tokens.md](results/2026-11-21/answer-tokens.md)). That is fewer tokens a call found than codebase-memory-mcp's 34.0 and CodeGraph 1.6.2's 31.7 from the 16 November runs (table below), whose answers were not rerun; both still spent fewer tokens in all, as they found fewer calls.

| Tool | Answers | Tokens | Median tokens an answer | Calls found | Tokens a call found |
| --- | ---: | ---: | ---: | ---: | ---: |
| GrievousGreps, grouped by file, on `b3c7345` (21 Nov) | 210 | 132,037 | 230 | 4,333 | 30.5 |
| GrievousGreps `88c214e` | 210 | 203,627 | 290 | 4,328 | 47.0 |
| codebase-memory-mcp, tests on | 210 | 92,944 | 219 | 2,733 | 34.0 |
| Serena, defaults | 210 | 441,692 | 703 | 2,397 | 184.3 |
| code-review-graph | 210 | 1,472,912 | 2,378 | 2,735 | 538.5 |
| CodeGraph 1.6.2 | 210 | 75,450 | 137 | 2,381 | 31.7 |
| CodeGraphContext | 210 | 721,235 | 966 | 2,353 | 306.5 |
| repowise | 210 | 290,159 | 844 | 2,087 | 139.0 |
| tokensave | 210 | 290,917 | 775 | 1,243 | 234.0 |
| Graphify | 210 | 112,845 | 300 | 1,156 | 97.6 |
| AxiomCode Graph | 133 | 181,552 | 1,374 | 307 | 591.4 |

AxiomCode Graph printed answers for 133 of the 210 symbols. This tool's other views, at `88c214e`, cost less than the files they stand for: `skeleton` of the 145 target files came to 90,849 tokens against 498,559 for the files, and `map` of the 21 repositories to 70,501 tokens against 24,877,541 for [Repomix](https://github.com/yamadashy/repomix) 1.19.0 packs of the same checkouts in its XML style.

### Search on semble's benchmark

On 19 November 2026 (UTC), `trail ask` at `57122b3` answered the 1,251 queries of [semble's retrieval benchmark](https://github.com/MinishLab/semble/tree/a1ba6c18a4b0a58a3d1a15217d64bc92678d1d9d/benchmarks), 63 repositories in 19 languages at the revisions semble pins (its commit `a1ba6c1`), scored by `gg-bench ask` as semble's scripts score a search tool by file: NDCG@10 0.750. A relevant file came first for 54.3% of queries, in the top 3 for 79.2% and in the top 10 for 93.1%. On the 204 symbol queries NDCG@10 was 0.851, with a relevant file first for 69.6% and in the top 3 for 89.7%; the 344 architecture queries scored lowest, at 0.694. The 260 queries with no relevant file in the top 3 are listed with the files that came first ([benchmark/results/2026-11-19/ask-on-semble.md](results/2026-11-19/ask-on-semble.md)). This is not a held-out score. On 17 November, `88c214e` scored 0.714 on this set, with 0 on all 60 Haskell queries, as it indexed no Haskell file ([benchmark/results/2026-11-17/ask-on-semble.md](results/2026-11-17/ask-on-semble.md)). Haskell indexing (#102) and the other changes from `88c214e` to `57122b3` came after that result was seen. With Haskell at 0 this run scores 0.716, so Haskell gives about 0.033 of the 0.036 rise. Semble's `benchmarks/README.md` at `a1ba6c1` reports 0.855 for semble, 0.630 for codebase-memory-mcp's `search_graph` in `fast` mode and 0.126 for ripgrep, from its own runs, which were not repeated here. Its scripts at that commit score semble's own results and CodeRankEmbed's by chunk, each chunk taking a rank and counting when it covers a target (34 of the 1,496 targets name lines), and the other search tools, codebase-memory-mcp and ripgrep among them, by file, as here. Its published figures are means of repository means, as its results files show, though its README says they are averaged across all queries; this run's matching figure is 0.749.

**Search with semantic ranking.** On 19 November 2026 (UTC), the same 1,251 queries were asked of this change at `ebef20c` with semantic ranking, the default, and with `TRAIL_SEMANTIC=0`, and graded the same way: NDCG@10 0.793 against 0.750. A relevant file came first for 59.8% of queries (54.3% by words only), in the top 3 for 83.8% (79.2%) and in the top 10 for 94.8% (93.1%). Architecture queries rose most, from 0.694 to 0.764, and 17 of the 19 languages rose; symbol queries fell from 0.851 to 0.836, PHP from 0.751 to 0.689 and C# from 0.784 to 0.761 ([ask-semantic-on.md](results/2026-11-19/ask-semantic-on.md), [ask-semantic-off.md](results/2026-11-19/ask-semantic-off.md)). The merge rule (reciprocal rank, k = 60, equal weights) was fixed before a prototype first ran on this set; that run decided that semantic ranking ships on by default, so this is not a held-out score.

### Network, method and rerunning

**Network:** in a separate pass on 15 November on httpx, mdbook and hono, in a namespace with only loopback, Serena made DNS lookups at its default settings on all 3, for `pypi.org` and `oraios-software.de`, and it documents an opt-out. This tool and codebase-memory-mcp made none. code-review-graph was not in that pass.

**Method:** the recall figures come from runs on one Linux machine on 16 November 2026 (UTC), one job at a time, between 07:33 (Serena) and 18:09 (this tool), and were scored together at 18:17. The 7 tools under '11 more call-graph tools' ran between 20:43 on 16 November and 04:53 on 17 November with the commands their adapters use, and were scored at 04:53, and the other 4 ran between 07:37 and 20:12 on 17 November and were scored at 20:12; the language-server column ran with `gg-bench lsp` at `8f297cb` from 21:40 on 16 November and was pooled at 00:23 on 17 November; CodeGraph 1.6.3 ran from 02:42 to 02:47 on 18 November, outside the no-network sandbox the other runs used, and was scored at 02:47, beside 1.6.2's kept answers, which the same scoring returned to 0.54 / 0.94 / 90. The records of the 16 November runs are in [benchmark/results/2026-11-16/](results/2026-11-16/README.md), and the outputs behind the figures added on 16 and 17 November in [benchmark/results/2026-11-17/](results/2026-11-17/README.md). Callers came from `graft callers`, codebase-memory-mcp's `trace_path`, Serena's `find_referencing_symbols`, code-review-graph's `callers_of` and the 6 commands above, with Serena's references mapped to their enclosing definition. All went through the benchmark's scorer unchanged. The cost, network and precision-sample figures above come from the 15 November runs of the first 4 tools, with this tool at `491b060`; they ran between 07:42 and 10:42 UTC that day, with a load average of 3.5 to 19.6 when a run started, so the timings are rough.

**To rerun it:** `cargo run --release --manifest-path rust/gg-bench/Cargo.toml -- run --tool dist/bin/graft.js` reproduces this tool's column, as [Run it](#run-it) describes. The comparison scripts are not shipped, because they are tied to that machine's sandbox. To repeat the other columns, install the versions above, query each tool as described here and score the answers with `gg-bench score`.

## Install and use measurements

The measurements behind the main README's [Install](../README.md#install) and [Use](../README.md#use) sections.

**Install.** With npm 12.2.2 and Node 26.13.1 on Linux, on 16 November 2026 (UTC) at `2a68b91`, the install took 103 s and 131 MiB of disk. At `1244ddf` on 18 November both commands printed `0.28.0+gg.1244ddf626b8`, the version and the commit.

**Viewer export.** `trail viz --export site/` wrote httpx's 1,301 code nodes as an `index.html` of 1,016,743 bytes at `57122b3` on 19 November 2026 (UTC), with no script or style loaded from elsewhere ([output](results/2026-11-19/README.md)); at `88c214e` on 16 November it was the same size, from an export not kept.

**Semantic ranking's first-run cost.** On Linux on 19 November (UTC), at `ebef20c`, cold builds of the 63 checkouts of semble's benchmark took 266.6 s in all against 158.6 s with `TRAIL_SEMANTIC=0` (zig, the largest, 31.7 s against 14.7 s), the vectors came to 76.7 MB (11.9 MB for zig), and `trail ask` took 0.60 s longer on zig, 0.23 s longer on zig-clap and no longer on flask, by the median of 5 questions on each ([builds](results/2026-11-19/ask-semantic-builds.tsv), [ask times](results/2026-11-19/ask-semantic-ask-times.tsv)).

**A folder of several repositories.** On 16 November 2026 (UTC), on Linux at `88c214e`, a folder holding click, flask and httpx built a graph for each. On 19 November, at `57122b3`, the same folder built in 20 to 28 s in 3 runs on a shared machine (load average 13 to 16), and `trail ask "current context"` from it listed hits from all 3 in one list, taking each repository's next hit in turn, by its own ranking: click's `get_current_context`, flask's `copy_current_request_context`, httpx's `create_ssl_context`, then click again ([output](results/2026-11-19/README.md)).

## Recorded runs

The README's draft figures came from upstream `a44da3dfb5894c8e316e320526041ef8e5ddbb8c` (0.28.0) and an earlier patched build, `949d829`, using the verifier's own scripts. Applying this harness's scorer to those stored outputs gave the same figures for all 21 repositories, including the overall 0.31 to 0.78. Regenerate them with this harness on the final build. On 12 November 2026 this harness gave the README's table of that day on Linux with Node 26.13.1: upstream `main` at `b22055dce3c3ff22722793ed0a5a3be4491a9140` against `166c2fd`, and `a44da3d` again on jotai, query, radix, table, trpc and vue, which matched its earlier figures there. On 12 November 2026 (UTC), with the same Node, the npm package `@trailhq/trail-code@0.29.0`, installed with its postinstall script skipped, against `eaa8393` gave the README's 0.29.0 column, the same figures as `a44da3d`, and the patched column unchanged. Those runs counted a statement anywhere in the plain `callers` output, so their silent and stated counts predate the JSON rule above; recall and precision do not depend on it. On 13 November 2026 (UTC), with the same Node, this harness ran with the JSON rule on the hand-written truth: the patched build at `219b118`, the npm package 0.29.0 with its postinstall script skipped, and upstream `main` at `b22055d` built from source. Recall and precision matched the 12 November runs in every row; silent undercounts were 14, 74 and 113, where the plain-output rule had given 5, 50 and 90. Later that day the same 3 builds ran on hono, radix and trpc with the compiler-derived truth (`--repos hono,radix,trpc`), which gave the README's current rows for those 3. With the other 18 rows unchanged, overall recall was 0.78, 0.32 and 0.19 and silent undercounts were 14, 75 and 113 (patched, 0.29.0, `main`). On 15 November 2026 (UTC), with the same Node, this harness ran the patched build at `6994515` against the npm package 0.29.0 on all 21: overall recall 0.96 and 0.32, precision 0.95 and 0.94, silent undercounts 11 and 75. Only the patched tokio and tracing rows changed. Later that day, on the corrected tokio truth, the same Node ran the patched build at `491b060` against the npm package 0.29.0, and in a second run upstream `main` at `b22055d` alone as the tool: overall recall 0.97, 0.32 and 0.19, precision 0.95, 0.94 and 0.91, silent undercounts 11, 75 and 113. These are the README's current figures. On 16 November 2026 (UTC), with the same Node, `gg-bench run` and the JavaScript runner it replaced, `run.mjs`, printed the same stdout, stderr and exit code for the patched build at `88c214e` against the npm package 0.29.0 on all 21 repositories, in 3 runs of 7, and on 7 fixture cases that cover each error path.
