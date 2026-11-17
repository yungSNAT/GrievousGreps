<p align="center">
  <picture>
    <source media="(max-width: 600px) and (prefers-color-scheme: light)" srcset=".github/assets/banner-phone-light.svg">
    <source media="(max-width: 600px)" srcset=".github/assets/banner-phone.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/banner-light.svg">
    <img src=".github/assets/banner.svg" width="100%" alt="GrievousGreps. A code graph for coding agents, with its misses measured. Pixel art of a call tree, with one empty box among its callers, beside the GrievousGreps wordmark in slab-serif block letters.">
  </picture>
</p>

<div align="center">

[![tests](https://github.com/yungSNAT/GrievousGreps/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yungSNAT/GrievousGreps/actions/workflows/ci.yml) [![Codecov](https://codecov.io/gh/yungSNAT/GrievousGreps/graph/badge.svg)](https://codecov.io/gh/yungSNAT/GrievousGreps) [![CodeQL](https://github.com/yungSNAT/GrievousGreps/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/yungSNAT/GrievousGreps/actions/workflows/codeql.yml) [![OSV-Scanner](https://github.com/yungSNAT/GrievousGreps/actions/workflows/osv-scanner.yml/badge.svg?branch=main)](https://github.com/yungSNAT/GrievousGreps/actions/workflows/osv-scanner.yml) [![SonarCloud](https://sonarcloud.io/api/project_badges/measure?project=EquityBot_GrievousGreps&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=EquityBot_GrievousGreps) [![Codacy code quality](https://app.codacy.com/project/badge/Grade/bd4014dc59804ad5af9125a492369d2c)](https://app.codacy.com/gh/yungSNAT/GrievousGreps/dashboard)<br>
[![OpenSSF Scorecard](https://raw.githubusercontent.com/ryanduguid/.github/badges/EquityBot/GrievousGreps.svg)](https://scorecard.dev/viewer/?uri=github.com/yungSNAT/GrievousGreps) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/16136/badge)](https://www.bestpractices.dev/projects/16136)<br>
[![node: 20.16+ | 22.3+](.github/assets/badges/node.svg)](https://nodejs.org/) [![licence: MIT](.github/assets/badges/licence.svg)](LICENSE) [![fork of: Trail-Code](.github/assets/badges/fork-of.svg)](https://github.com/trailhq/Trail-Code)

[Install](#install) · [Use](#use) · [Docs search](#docs-search) · [Measured recall](#measured-recall) · [Against the alternatives](#against-the-alternatives) · [Compared with upstream](#compared-with-upstream) · [Limits](#limits) · [Network and privacy](#network-and-privacy) · [Development](#development) · [Credits](#credits) · [Licence](#licence)

</div>

GrievousGreps is yungSNAT's distribution of [Trail-Code](https://github.com/trailhq/Trail-Code), the code graph CLI for coding agents, formerly Graft. It maps the functions it can parse in a repository and the callers it can resolve, so an agent can check what a change reaches before it edits. It misses some callers: see [Measured recall](#measured-recall) and [Limits](#limits).

Use it over upstream if your agent relies on `callers`. On 21 public repositories its [measured recall](#measured-recall) is 0.98, against 0.32 for upstream's npm release 0.29.0 and 0.19 for upstream `main` at `b22055d`, all 3 measured on 16 November 2026 (UTC). It is higher than 0.29.0 on 20 of the 21 and level on the other, its precision is 0.95 against 0.94, and its Rust recall is partial. It also makes no background network request until you ask for one, and it refuses to write through a symlink planted in a repository. It installs both the `trail` and `graft` commands, where upstream's npm release 0.29.0 installs `trail` and its source installs `graft`, so agent configuration and most commands work as they do upstream. [Compared with upstream](#compared-with-upstream) lists the differences.

## Install

GrievousGreps has no npm package, so npm builds it from this repository. You need Node 20.16 or later on the 20 line, or 22.3 or later, plus git and a C++ toolchain for the native grammars.

GrievousGreps provides `trail` and `graft`, and each upstream package provides one of them, so remove any upstream copy first:

```bash
npm uninstall -g @trailhq/trail-code @nanonets/graft
```

Then install it from GitHub:

```bash
npm install -g --allow-git=root git+https://github.com/yungSNAT/GrievousGreps.git
trail --version
```

npm 12 refuses a package from git unless `--allow-git` allows it, and `root` allows only the one named. With npm 12.2.2 and Node 26.13.1 on Linux, on 16 November 2026 (UTC) at `2a68b91`, the install took 103 s and 131 MiB of disk, and both commands printed `0.28.0+gg`, without the commit. npm 12 also skipped the package's `postinstall` script, which prints a hint; the commands work without it. To update, run the same command.

To work on the code, build it from a clone and link the commands instead:

```bash
git clone https://github.com/yungSNAT/GrievousGreps
cd GrievousGreps
npm ci
npm run build
npm link
trail --version
```

`npm link` points the commands at this folder, so keep it. The folder measured about 610 MB with its development dependencies. Installing writes nothing to your agents' settings.

A repository already wired to upstream with `npx` keeps starting upstream's package until you run `trail init` there, which replaces those entries in `.cursor/mcp.json` with the installed command and removes them from `.mcp.json`. `~/.codex/config.toml` changes only with `--global`.

To update a clone, run `git pull`, `npm ci` and `npm run build` in the folder. `trail upgrade` refuses on this build, because the package on npm is upstream's.

## Use

In your repository:

```bash
trail init                           # build the map, create .trail/ and wire your agents
trail callers <symbol>               # who calls it
trail callers <symbol> --direction out   # what it calls
trail map                            # directory clusters, hubs and hotspots
trail grep <pattern>                 # every occurrence, grouped by enclosing symbol
trail viz                            # an interactive viewer of the graph, served on localhost
```

`trail viz --export site/` writes the viewer as one self-contained `index.html` instead: for httpx's 1,301 code nodes it was 993 kB, with no script or style loaded from elsewhere.

`trail init` writes inside the repository, with the tool's own state in `~/.trail`. Claude Code's hooks go in the repository's `.claude` settings. That has a cost: a worktree or an ignored checkout has no hooks until you run `trail init` there.

`trail init --global` closes that gap by adding hooks to `~/.claude`, and to `~/.codex` for Codex, which run in every project on the machine. `trail uninstall -y` removes what either form wrote except the `.trail/` folder, which keeps your learnings; without `-y` it is a dry run.

The map lives in `.trail/cache` in a repository on trail and in `graft/` elsewhere: a local cache to keep out of git.

In a folder of separate git repositories, `trail build` builds one graph per repository and a federated index beside them, and a query from the folder searches them all, each hit labelled with its repository. On 16 November 2026 (UTC), on Linux at `88c214e`, a folder holding click, flask and httpx built in 10.5 s, and `trail ask` from it ranked click's and flask's definitions together. Calls between the repositories are not linked: `trail callers get_current_context` there listed click's own 16 callers, not flask's call in its tests. [docs/upstream-guide.md](docs/upstream-guide.md#monorepos-submodules--multi-repo-folders) covers this and the other layouts.

## Docs search

`trail docs` (or `graft docs`) searches a repository's Markdown and text files and ranks the files that best match, each at its best-matching section, so an agent finds the handoff, design note or README section it needs without reading whole files. It is separate from the code map: `ask` and the MCP tools do not use it.

```bash
trail docs search claim lapse                  # best file first, one section each: path:line, title, heading, snippet
trail docs get notes/claims.md --from 12 -l 20 # those lines of one file
trail docs status                              # documents and sections indexed
trail docs search claim lapse --json           # the same as JSON, for scripts
```

It searches the enclosing git checkout unless you pass `--root`, skips what `.gitignore` ignores, and before every answer re-reads each file whose size or modification time has changed, so its answers follow your edits. `get` reads files up to 4 MiB, the index's limit. The index is one file per folder under `~/.trail/docs`, or `$TRAIL_HOME/docs`. It makes no network request.

The search runs in `gg-docs`, a Rust program in `rust/gg-docs`. No release of it exists yet, so build it once in your checkout, which needs a Rust toolchain:

```bash
cargo build --release --locked --manifest-path rust/gg-docs/Cargo.toml
```

`trail docs` uses the first of these that exists: the file `TRAIL_DOCS_BIN` names; a release binary at `rust/gg-docs/prebuilt/<version>/<target>/`, for `x86_64-pc-windows-msvc` and `x86_64-unknown-linux-musl`; and `rust/gg-docs/target/release/`. A `--json` answer carries a `protocol` number, and the CLI refuses a binary that speaks another.

## Measured recall

Recall is the share of real calls that `callers` found, pooled across the symbols, so a symbol or repository with many callers weighs more. Each row is 10 preregistered symbols on one public repository. For 18 rows the truth was written before any build ran on the repository. For hono, radix and trpc it has been derived from the TypeScript compiler since 13 November 2026 (UTC), after builds had run, so those 3 sets were not preregistered; [benchmark/](benchmark/README.md#truth) describes the derivation. Upstream is measured twice, both on 16 November 2026 (UTC): its npm release 0.29.0 (6 November), the version `npm install` gives and still its latest; and `main` at `b22055d` (9 November), still its head.

For the 18, that order rests on this statement: the truth went into a local log that is not public, so nobody outside can prove it was committed first. One correction came after a first scoring pass: the target lines of httpx `to_bytes` and `create_ssl_context` were off by one. No required row changed. A second came on 15 November 2026 (UTC): tokio `channel` lacked 49 calls written with a turbofish, such as `mpsc::channel::<()>(1)`, which [benchmark/](benchmark/README.md#truth) lists with how they were found and checked. They are now required rows, so tokio holds 894 calls and the 21 repositories 4,359. A third came later that day: attrs `resolve_types` lacked 5 calls that apply it as a decorator without arguments, which [benchmark/](benchmark/README.md#truth) also lists. They are now required rows, so attrs holds 282 calls and the 21 repositories 4,364. A fourth came on 16 November: table lacked 39 calls in Svelte and Vue components, which [benchmark/](benchmark/README.md#truth) lists too. They are now required rows, so table holds 397 calls and the 21 repositories 4,403. Every column below was scored on these 4,403 calls.

**Overall, upstream 0.29.0 to patched:** recall 0.32 to 0.98 (21 repositories and 4,328 of 4,403 calls on the patched build), precision 0.94 to 0.95, silent undercounts 77 to 7. Upstream `main` scored 0.19, with precision 0.91 and 113 silent undercounts. A silent undercount is a symbol with a miss whose JSON answer does not say it may be short; [benchmark/](benchmark/README.md#what-it-prints) has the rule. On the hand-written truth for all 21, the 13 November runs gave recall 0.31, 0.77 and 0.20 and silent undercounts 74, 14 and 113 (0.29.0, patched at `219b118`, `main`). The 12 November runs, on that truth, counted under an earlier rule, which searched the plain output for words such as 'undercount', and gave 50, 5 and 90 silent undercounts.

**On 5 repositories no build had seen, recall was 0.41, not 0.98.** The 5, in Python, TypeScript, Rust, Go and C#, were preregistered with truth that language servers derived before any build ran on them. On 17 November 2026 (UTC), at `0df7dcc`, this tool found 231 of their 564 required rows, with precision 0.98 and 18 silent undercounts; upstream 0.29.0 gave recall 0.38, precision 0.98 and 21. By repository: marshmallow 0.57, immer 0.57, serde_json 0.27, logrus (Go) 0.08 and serilog (C#) 0.53. The 21 repositories below shaped the fixes, so 0.98 is recall on code the build was tuned on. [benchmark/unseen/](benchmark/unseen/README.md) has the set, how its truth was derived and the faults found in that derivation.

On the hand-written truth, 0.29.0 gave the same figures on all 21 repositories as `a44da3d` (30 October), the `main` commit whose package version is 0.28.0, gave on 31 October. Since 0.29.0, upstream `main`'s Python and Rust rows held or rose (rich 0.57 to 0.80), but 6 of its 7 TypeScript rows fell, from 0.90 to 0.33 on jotai and from 0.73 to 0.02 on radix: `main` no longer finds some symbols, such as radix `FocusScope`, which it reports as not in the graph. A rerun of `a44da3d` on the same machine on 12 November gave its earlier TypeScript figures, so the fall is upstream's change, not the run.

| Repository | Language | Calls in truth | Upstream 0.29.0 | Upstream `main` | Patched |
| --- | --- | --- | --- | --- | --- |
| python-attrs/attrs @ c8bb9bf | Python | 282 | 0.05 | 0.05 | 1.00 |
| tokio-rs/axum @ bebe175 | Rust | 127 | 0.48 | 0.48 | 0.99 |
| pallets/click @ 2247b35 | Python | 401 | 0.03 | 0.03 | 1.00 |
| pallets/flask @ d086db8 | Python | 33 | 0.33 | 0.33 | 1.00 |
| honojs/hono @ ee88684 | TypeScript | 40 | 0.70 | 0.75 | 0.85 |
| encode/httpx @ b5addb6 | Python | 42 | 0.52 | 0.52 | 1.00 |
| pmndrs/jotai @ e5971ba | TypeScript | 58 | 0.90 | 0.33 | 1.00 |
| rust-lang/mdBook @ b21095b | Rust | 51 | 0.73 | 0.73 | 1.00 |
| TanStack/query @ 979695d | TypeScript | 73 | 0.95 | 0.49 | 1.00 |
| radix-ui/primitives @ eb3a2b7 | TypeScript | 252 | 0.73 | 0.02 | 1.00 |
| rayon-rs/rayon @ 599425d | Rust | 226 | 0.31 | 0.31 | 0.99 |
| Textualize/rich @ 9d8f9a3 | Python | 132 | 0.57 | 0.80 | 1.00 |
| BurntSushi/ripgrep @ 91f5d22 | Rust | 45 | 0.56 | 0.56 | 1.00 |
| mwaskom/seaborn @ c1cb287 | Python | 147 | 0.24 | 0.24 | 1.00 |
| hynek/structlog @ 19c4f21 | Python | 84 | 0.77 | 0.79 | 1.00 |
| TanStack/table @ c14e022 | TypeScript | 397 | 0.68 | 0.21 | 1.00 |
| tokio-rs/tokio @ 6470b5e | Rust | 894 | 0.04 | 0.04 | 0.94 |
| tokio-rs/tracing @ 79b80a9 | Rust | 749 | 0.00 | 0.00 | 0.99 |
| trpc/trpc @ 708753f | TypeScript | 221 | 0.94 | 0.25 | 1.00 |
| vuejs/core @ 24c9d0b | TypeScript | 88 | 0.95 | 0.56 | 0.95 |
| getzola/zola @ 628926f | Rust | 61 | 0.90 | 0.90 | 0.98 |

Rust recall is partial. tokio is the weakest Rust row at 0.94, and tracing is at 0.99. Together they hold 1,643 of the 4,403 calls, and their symbols were chosen for names repeated across crates and types.

About 1 in 6 `[inferred]` edges were wrong, in 2 samples totalling 80 edges (14 false, 95% interval 11% to 27%), at `e37a764` and `949d829`. An edge with that mark is a lead. `callers`, its JSON and the MCP tool show the mark, and at depth 2 or more they also show it on any hit whose every shortest path crosses such an edge. `blast` shows the mark too, counts those dependents and lists them after the definite ones at each depth. Definite edges: 2 of 80 false over the same 2 samples.

Against 0.29.0, recall did not rise everywhere: vue did not move. Silent undercounts remain.

All 3 columns were run on Linux with Node 26.13.1 on 16 November 2026 (UTC) and scored on the truth with all 4 corrections: the patched column at `88c214e`, whose code is that of `3e066a2`, 0.29.0 as the npm package `@trailhq/trail-code@0.29.0` with its install script skipped, and `main` built from source. Against the 15 November runs, only the table row of the 2 upstream columns changed, for its 39 new calls, and the patched figures matched those of `3e066a2` on every row. On the hand-written truth every recall figure matched the 12 November runs (patched at `166c2fd` and `eaa8393`). Linux and Windows gave identical benchmark results at `e37a764` on all 21 repositories, and `e8f73b9` matched them. `a44da3d` was run on Windows and, for those 6 TypeScript rows, again on Linux.

These are 21 repositories, not an estimate for yours, and none of them is unseen any more: earlier builds ran on each of them, so fixes made in between may have been shaped by their results; the unseen set above measures that. [benchmark/](benchmark/README.md) has the truth, the scoring rules, the limits of the truth and the command to rerun the table.

## Against the alternatives

On this benchmark GrievousGreps has the highest overall recall of 10 tools and the fewest silent undercounts. It is ahead of Serena on Rust (0.97 to 0.76), of code-review-graph on TypeScript (0.99 to 0.98) and of CodeGraph on Python (1.00 to 0.97). codebase-memory-mcp leads on answer size and memory. Each cell above the licence row is recall / precision / silent undercounts, scored by [benchmark/](benchmark/README.md) on the same 21 repositories, 210 symbols and 4,403 calls. Every tool was run on 16 November 2026 (UTC), each at its latest release that day and GrievousGreps at `88c214e`.

| | GrievousGreps `88c214e` | codebase-memory-mcp v0.12.1, tests on | Serena v2.1.0, defaults | Serena v2.1.0, tuned | code-review-graph v2.4.0 |
| --- | --- | --- | --- | --- | --- |
| Overall | 0.98 / 0.95 / 7 | 0.62 / 0.93 / 89 | 0.54 / 0.92 / 99 | 0.70 / 0.94 / 70 | 0.62 / 0.86 / 88 |
| Python | 1.00 / 1.00 / 0 | 0.67 / 0.98 / 22 | 0.37 / 0.95 / 30 | 0.82 / 0.98 / 8 | 0.53 / 0.96 / 35 |
| TypeScript | 0.99 / 0.97 / 4 | 0.79 / 0.97 / 25 | 0.31 / 0.97 / 46 | 0.46 / 0.98 / 39 | 0.98 / 0.95 / 10 |
| Rust | 0.97 / 0.91 / 3 | 0.51 / 0.87 / 42 | 0.76 / 0.89 / 23 | 0.76 / 0.89 / 23 | 0.48 / 0.70 / 43 |
| Licence | MIT | MIT | GPL-3.0-or-later, SolidLSP MIT | GPL-3.0-or-later, SolidLSP MIT | MIT |

Licences were checked against each project's LICENSE file at its latest release, which is the version tested: [codebase-memory-mcp v0.12.1](https://github.com/DeusData/codebase-memory-mcp/blob/v0.12.1/LICENSE) and [Serena v2.1.0](https://github.com/oraios/serena/blob/v2.1.0/LICENSE) and [code-review-graph v2.4.0](https://github.com/tirth8205/code-review-graph/blob/v2.4.0/LICENSE), on 15 November 2026. Serena's application has been GPL-3.0-or-later since commit `6707cd9b` (14 September 2026), and its `serena-agent` package declares that licence; its SolidLSP library stays MIT, as do Serena releases up to v1.7.0.

The 6 further tools, run the same day on the same calls:

| | CodeGraph 1.6.2 | CodeGraphContext 0.6.13 | repowise 0.61.0 | tokensave 7.16.0 | Graphify 0.9.111 | AxiomCode Graph 0.2.3 |
| --- | --- | --- | --- | --- | --- | --- |
| Overall | 0.54 / 0.94 / 90 | 0.53 / 0.68 / 106 | 0.47 / 0.95 / 108 | 0.28 / 0.91 / 137 | 0.26 / 0.98 / 167 | 0.07 / 0.71 / 179 |
| Python | 0.97 / 0.98 / 12 | 0.91 / 0.81 / 19 | 0.63 / 0.99 / 25 | 0.37 / 1.00 / 43 | 0.42 / 1.00 / 42 | 0.14 / 0.79 / 61 |
| TypeScript | 0.82 / 0.95 / 22 | 0.69 / 0.75 / 31 | 0.73 / 0.94 / 29 | 0.29 / 0.99 / 55 | 0.55 / 0.97 / 56 | 0.14 / 0.66 / 48 |
| Rust | 0.17 / 0.82 / 56 | 0.26 / 0.45 / 56 | 0.26 / 0.93 / 54 | 0.23 / 0.78 / 39 | 0.03 / 0.97 / 69 | 0.00 / none / 70 |
| Licence | MIT | MIT | AGPL-3.0 | MIT | Apache-2.0 | FSL-1.1-Apache-2.0 |

AxiomCode Graph returned no Rust callers, so it has no Rust precision. Each tool built its index with its documented command and answered its documented callers question: CodeGraph `codegraph callers`, CodeGraphContext's MCP `find_callers`, repowise `context --include callers`, tokensave's MCP symbol lookup and callers, Graphify `explain`, and AxiomCode Graph `impact`. These 6 licences are GitHub's reading of each repository's licence on 16 November 2026, and AxiomCode Graph's from its npm package; they were not checked file by file at each release.

No competitor's recall beat this tool's on any repository. Where one matched it, both found every call, except on hono (34 of 40, with code-review-graph and CodeGraph), vue (84 of 88, with code-review-graph) and zola (60 of 61, with Serena).

**Read the table with these limits:**

- The truth was written alongside this tool and all 21 repositories have been seen in development, so the table does not predict recall on other code.
- A silent undercount is a symbol whose answer misses a caller and whose JSON does not say it may be short. The scorer reads the 2 fields this tool writes, `unresolved` and a shared-name `note`, and no rival field, so each rival's count is every symbol it missed. The earlier rule, which searched the plain output for words such as 'undercount', gives 5, 89, 94, 66 and 86 on the 15 November answers, with this tool at `491b060`.
- codebase-memory-mcp used documented non-default settings because the truth counts test callers: `depth=1`, `include_tests=true`, `limit=5000` and `max_output_tokens=1000000`. At its defaults its overall recall is 0.29.
- code-review-graph was asked through its MCP server's `query_graph_tool` with `callers_of` and `max_results=100000`, as its default of 100 would cut long answers, after a `code-review-graph build`. Each target came from the tool's `file_summary` of the target file. Its `file_summary` listed no matching definition for 4 targets: hono `createFactory`, an arrow function, and tokio `spawn`, `spawn_blocking` and `block_in_place`, which sit inside `cfg_rt!` and `cfg_rt_multi_thread!` macros.
- Serena's tuned row was chosen after seeing its scores. It removes the `[tool.pyright]` table on attrs, click and structlog, and adds generated TypeScript project references on radix and trpc. Serena's Pyright, typescript-language-server and rust-analyzer ran at their documented defaults, with dependencies fetched first.
- The scorer's precision understates the first 3 tools. On 15 November, with this tool at `491b060`, 22, 16 and 21 of 25 edges the scorer called false were judged true by reading the source (this tool, codebase-memory-mcp, Serena), and 25, 23 and 25 of 25 random edges per tool were true; a sample that size does not separate them. The check of 31 October, with this tool at `e37a764`, gave 25, 19 and 24, and 23, 24 and 25. code-review-graph was not in the sample.

**Cost, as medians across the 21 repositories** (this tool, codebase-memory-mcp, Serena, code-review-graph): index time 4.24, 4.33, 10.92 and 5.92 s, with Serena's first query adding 4.18 s; peak memory when querying 100, 41, 1,123 and 101 MiB. Answers across all queries came to 719,535, 291,999, 1,488,043 and 4,650,547 bytes, before target lookups of 178,457 bytes for codebase-memory-mcp, 37,086 for Serena and 1,954,645 for code-review-graph. codebase-memory-mcp and code-review-graph name each caller with the checkout's path, so their byte counts grow with that path. 3 runs each on httpx, mdbook and hono gave the same recall every time; index times varied by up to 1.55 s for this tool (hono), 0.71 s for codebase-memory-mcp (mdbook), 7.90 s for Serena (hono) and 7.87 s for code-review-graph (hono). These runs do not rank latency, because a CLI process per query and an MCP server are not like for like.

**Network:** in a separate pass on 15 November on httpx, mdbook and hono, in a namespace with only loopback, Serena made DNS lookups at its default settings on all 3, for `pypi.org` and `oraios-software.de`, and it documents an opt-out. This tool and codebase-memory-mcp made none. code-review-graph was not in that pass.

**Method:** the recall figures come from runs on one Linux machine on 16 November 2026 (UTC), one job at a time, between 07:38 (Serena) and 18:11 (this tool), and were scored together at 18:15. Callers came from `graft callers`, codebase-memory-mcp's `trace_path`, Serena's `find_referencing_symbols`, code-review-graph's `callers_of` and the 6 commands above, with Serena's references mapped to their enclosing definition. All went through the benchmark's scorer unchanged. The cost, network and precision-sample figures above come from the 15 November runs of the first 4 tools, with this tool at `491b060`; they ran between 07:42 and 10:42 UTC that day, with a load average of 3.5 to 19.6 when a run started, so the timings are rough.

**To rerun it:** `cargo run --release --manifest-path rust/gg-bench/Cargo.toml -- run --tool dist/bin/graft.js` reproduces this tool's column, as [benchmark/](benchmark/README.md) describes. The comparison scripts are not shipped, because they are tied to that machine's sandbox. To repeat the other columns, install the versions above, query each tool as described here and score the answers with `gg-bench score`.

## Compared with upstream

This table lists what the code changes from upstream `a44da3d` (30 October 2026, package version 0.28.0), the base of this build. Upstream's npm release 0.29.0 (6 November 2026) gave the same recall as `a44da3d` on the hand-written truth; its other rows were not rerun against it. It adds `trail share-session`, which is off unless `TRAIL_SHARE_SESSION=1` is set. Upstream `main` has changed since. Only [the recall table](#measured-recall) measures the effect on callers. Upstream's agent benchmarks are not repeated here, because they have not been rerun on this build.

| | Upstream `a44da3d` | GrievousGreps |
| --- | --- | --- |
| Python calls | Calls through a module alias or a re-exported name lose their edge | Follows named imports, module aliases, re-exports and local imports, and picks the nearest of several modules with one name |
| TypeScript calls | Bound by name lookup where an import is not followed | Follows barrels, namespaces, tsconfig paths and exports maps, and counts JSX elements as calls |
| Rust calls | Path calls not resolved by owner, and calls inside macros not seen | Scopes `use` to its module, resolves path calls by owner and reads macro bodies where the tokens decide the target. Still partial: see [Limits](#limits) |
| Usage stats | On by default in published builds, with a notice on first run, unless `DO_NOT_TRACK` or CI is set. `trail telemetry disable` stops them. A build from source has no key, so it sends none | Off by default, and no key in the build |
| Daily npm version check | On by default, unless `DO_NOT_TRACK` is set | Off unless `GRAFT_UPDATE_CHECK=1` |
| Workspace background reads | The sign-in link is on wherever usage stats are, and `TRAIL_CLOUD` overrides that. In a repository that keeps learnings, `trail` sessions also run a background `git fetch` and `gh` reads unless `TRAIL_NO_FETCH` is set | Off unless `TRAIL_CLOUD=1` or you sign in |
| Symlinks planted in a repository or output folder | Followed | Refuses to write through them. A link swapped in between the check and the write is out of scope ([SECURITY.md](SECURITY.md)) |
| Writes outside the repository | `trail init` adds hooks to `~/.claude` and `~/.codex` unless you pass `--no-global`, and `trail login` adds MCP servers | Only with `--global`, on either command, or `trail init --connect` |
| npm on Windows | The update check fails on the `npm.cmd` shim | Starts npm through the shell |
| Markdown and text search | None | `trail docs`, files ranked by their best section, through the `gg-docs` binary |
| Distribution | Published on npm, with `trail upgrade` | From source |

Learnings (`trail note`, `check` and `team`), `blast`, the viewer, the MCP server and agent wiring are inherited from upstream. [docs/upstream-guide.md](docs/upstream-guide.md) has the commands, the supported languages and what a node holds.

Stay on upstream if you want a published package and `trail upgrade`, or support from the people who run the hosted Trail workspace.

## Limits

- **Callers are not complete.** Treat an empty or short list as a lead, then check it with `trail grep`.
- **Silent undercounts remain.** A short list does not always say that it is short.
- **Rust recall is partial**, as the tokio and tracing rows show. Rust workspaces with repeated names are the weakest case.
- **Method calls without a known receiver type are weak.** The graph drops many such calls, and where it guesses it marks the edge `[inferred]`.

## Network and privacy

Telemetry is off by default. A build from source also has no telemetry key, so it sends no usage events even if you turn them on. [TELEMETRY.md](TELEMETRY.md) lists every event in upstream's contract.

These use the network when you run them:

- `trail team` fetches `origin` to read teammates' branches.
- `trail login` and `trail init --connect` go to upstream's hosted service, `team.trailhq.com`. After you connect a workspace, the learnings committed in the repositories you added go there too. `trail init --connect` also adds a server to `~/.claude.json`, unless you pass `--no-global`.
- `GRAFT_UPDATE_CHECK=1` asks npm for this package's version once a day.

## Development

```bash
npm ci
npm run build
npm test
```

[CONTRIBUTING.md](CONTRIBUTING.md) lists the checks a pull request must pass.

## Credits

GrievousGreps is built on [Trail-Code](https://github.com/trailhq/Trail-Code) by trailhq, with Shrish Dwivedi and anirudhkumar-nanonets as its main authors. [CREDITS.md](CREDITS.md) lists the contributors of its language support.

Fixes and languages ported from upstream pull requests and other forks, each MIT:

| Author | Source | Fix |
| --- | --- | --- |
| jeglov | [#437](https://github.com/trailhq/Trail-Code/pull/437) | Python calls through an imported module alias |
| Alem Basic | [#389](https://github.com/trailhq/Trail-Code/pull/389) | JSX elements as component calls |
| anirudhkumar-nanonets | [#726](https://github.com/trailhq/Trail-Code/pull/726) | Barrel files and generic supertypes in TypeScript |
| anirudhkumar-nanonets | [#736](https://github.com/trailhq/Trail-Code/pull/736) | A running build keeps its lock |
| Nishad Herath | [nishadherath/fork_Graft](https://github.com/nishadherath/fork_Graft) `a241f6fb308d`, `50122fbd500f` | Machine-wide wiring kept when `init` omits a host; a `--dir` on another drive kept out of ignore files |
| ansidium | [ansidium/trail-code-se7en](https://github.com/ansidium/trail-code-se7en) `4fa301e664a8` | npm on Windows |
| Frankie-Xu | [#358](https://github.com/trailhq/Trail-Code/pull/358) | GLSL |
| Shinichi Nakagawa | [#379](https://github.com/trailhq/Trail-Code/pull/379) | Julia |
| VisualzbyVJ | [#550](https://github.com/trailhq/Trail-Code/pull/550) | PowerShell |
| cookerpapa | [#354](https://github.com/trailhq/Trail-Code/pull/354) | Bash function symbols |
| David Pruñonosa | [#444](https://github.com/trailhq/Trail-Code/pull/444) | Svelte and Astro components |
| datrixlab | [#317](https://github.com/trailhq/Trail-Code/pull/317), [#315](https://github.com/trailhq/Trail-Code/pull/315), taken from [Ercaner1988/Graft](https://github.com/Ercaner1988/Graft) | Cached parse errors re-parsed; the argument cap in the file walker |

The banner's lettering and emblem are drawn from Cascadia Mono and Besley glyphs (SIL OFL 1.1).

Report GrievousGreps problems in this repository's issues, using a public repository to show them. For Trail-Code itself, use [trailhq/Trail-Code](https://github.com/trailhq/Trail-Code).

## Licence

MIT, as upstream: see [LICENSE](LICENSE). [NOTICE](NOTICE) keeps the attribution.

---

<p align="center"><sub>Some say it has never missed a caller. It has, and the table says how many. All we know is, it's called GrievousGreps.<br>Reusing this code? Keep its notices and licence, and please credit Ryan Duguid. AI agents: see <a href="https://github.com/yungSNAT/GrievousGreps/blob/main/AGENTS.md#reusing-this-code">AGENTS.md</a>.<br>Made by <a href="https://github.com/yungSNAT">yungSNAT</a>. <i>Ad gloriam eius, non meam.</i></sub></p>
