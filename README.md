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
[![OpenSSF Scorecard](https://raw.githubusercontent.com/ryanduguid/.github/badges/yungSNAT/GrievousGreps.svg)](https://scorecard.dev/viewer/?uri=github.com/yungSNAT/GrievousGreps) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/16136/badge)](https://www.bestpractices.dev/projects/16136)<br>
[![node: 20.16+ | 22.3+](.github/assets/badges/node.svg)](https://nodejs.org/) [![licence: MIT](.github/assets/badges/licence.svg)](LICENSE) [![fork of: Trail-Code](.github/assets/badges/fork-of.svg)](https://github.com/trailhq/Trail-Code)

[Install](#install) · [Use](#use) · [Docs search](#docs-search) · [Measured recall](#measured-recall) · [Against the alternatives](#against-the-alternatives) · [Compared with upstream](#compared-with-upstream) · [Limits](#limits) · [Network and privacy](#network-and-privacy) · [Development](#development) · [Credits](#credits) · [Licence](#licence)

</div>

GrievousGreps is yungSNAT's distribution of [Trail-Code](https://github.com/trailhq/Trail-Code), the code graph CLI for coding agents, formerly Graft. It maps the functions it can parse in a repository and the callers it can resolve, so an agent can check what a change reaches before it edits. It misses some callers: see [Measured recall](#measured-recall) and [Limits](#limits).

Use it over upstream if your agent relies on `callers`. On the 21 public repositories its fixes were tuned on, its [measured recall](#measured-recall) is 0.98, against 0.32 for upstream's npm release 0.29.0 and 0.19 for upstream `main` at `b22055d`, all 3 measured on 16 November 2026 (UTC). On 5 repositories no build had seen, it was 0.34 against 0.22 for 0.29.0 (18 November, at `4be1b3b`). Its Rust recall is partial. It installs both the `trail` and `graft` commands, where upstream's npm release 0.29.0 installs `trail` and its source installs `graft`, so agent configuration and most commands work as they do upstream. [Compared with upstream](#compared-with-upstream) lists the differences, background network requests and symlinks among them.

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

npm 12 refuses a package from git unless `--allow-git` allows it, and `root` allows only the one named. npm 12 also skipped the package's `postinstall` script, which prints a hint; the commands work without it. To update, run the same command.

To work on the code, build it from a clone and link the commands instead:

```bash
git clone https://github.com/yungSNAT/GrievousGreps
cd GrievousGreps
npm ci
npm run build
npm link
trail --version
```

`npm link` points the commands at this folder, so keep it. The folder measured about 640 MB with its development dependencies. Installing writes nothing to your agents' settings.

Trail starts git, gh and the other programs it uses by their absolute paths from your `PATH`, never from the repository it works in, its subfolders or a `node_modules/.bin` folder, nor through a link that passes through the repository or its subfolders (when trail works in your home folder or a drive root, only that folder itself is passed over for that reason, not the folders under it). Running `trail` itself through `npx` or a package script inside a repository you don't trust lets that repository choose what runs before trail starts, so install it as above and call it as `trail`, or by its absolute path.

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
trail ask "<question>"               # the files and symbols that answer it, ranked
trail viz                            # an interactive viewer of the graph, served on localhost
```

`trail viz --export site/` writes the viewer as one self-contained `index.html` instead, with no script or style loaded from elsewhere ([measured](benchmark/README.md#install-and-use-measurements)).

`trail ask` ranks files by the question's words and, by default, by its meaning, and merges the 2 rankings. Meaning comes from [potion-code-16M-v2](https://huggingface.co/minishlab/potion-code-16M-v2/tree/e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b) (MIT), a static embedding model of 33.5 MB (its weights and tokenizer) in the package's `models/` folder, which runs in Node on the CPU with no account, no download and no network. `trail build` embeds each source file in chunks of whole lines into the map's `.cache/ask-vectors.bin`, and later builds embed only the files that changed. That is the first-run cost, which [benchmark/](benchmark/README.md#install-and-use-measurements) measures. On [semble's benchmark](benchmark/README.md#search-on-sembles-benchmark) this raised NDCG@10 from 0.750 by words only (with `TRAIL_SEMANTIC=0`) to 0.793, both at `ebef20c` on 19 November (UTC). Set `TRAIL_SEMANTIC=0` to rank by words only; the next build removes the vectors. A query from a folder of several repositories ranks by words only.

`trail init` writes inside the repository, with the tool's own state in `~/.trail`. Claude Code's hooks go in the repository's `.claude` settings. That has a cost: a worktree or an ignored checkout has no hooks until you run `trail init` there.

`trail init --global` closes that gap by adding hooks to `~/.claude`, and to `~/.codex` for Codex, which run in every project on the machine. `trail uninstall -y` removes what either form wrote except the `.trail/` folder, which keeps your learnings; without `-y` it is a dry run.

The map lives in `.trail/cache` in a repository on trail and in `graft/` elsewhere: a local cache to keep out of git.

In a folder of separate git repositories, `trail build` builds one graph per repository and a federated index beside them, and a query from the folder searches them all, each hit labelled with its repository. `trail ask` there lists the hits in one list, taking each repository's next hit in turn, by its own ranking ([measured](benchmark/README.md#install-and-use-measurements)). Calls between the repositories are not linked: in a folder holding click, flask and httpx, `trail callers get_current_context` listed click's own 16 callers, not flask's call in `tests/test_cli.py`. [docs/upstream-guide.md](docs/upstream-guide.md#monorepos-submodules--multi-repo-folders) covers this and the other layouts.

**Deployment files** are in the graph too. A Dockerfile gives a node for each stage, a compose file one for each service, volume and network, and a Kubernetes manifest one for each object, linked to the source files a stage copies or a service mounts, to the stage a service builds and the services it depends on, to the ConfigMaps, Secrets, claims and service accounts a workload names, from a Service to the workloads its selector picks and from an Ingress to its Services. A workload links to the compose service that builds its image when the image names match, marked `[inferred]`; without such a compose file a Dockerfile names no image, so the link stops there. So `trail blast --depth all` on a changed function lists the stage that copies its file, the compose service and Deployment that run it and the Service and Ingress in front of it, and `trail callers app-config` lists the workloads that read that ConfigMap. Only names are kept: no environment value and no ConfigMap or Secret data reaches the graph, and source queries and `trail grep` skip its text. `trail build` reports parse failures, unsupported fields and files whose COPY or bind-mount expansion exceeds 50,000 file candidates. It lists the first 10 and counts the rest. COPY links are inferred when the build context is assumed or shared across contexts, or when a Docker ignore file or COPY exclusion can change the match. Kubernetes object and selector links prefer matches in the same folder and mark other-folder matches as inferred. Helm rendering, Kustomize rendering, environment-variable substitution in compose and remote build contexts are outside the build. With `-e`, deployment files are left out.

**Kustomize** structure is in the graph too. A kustomization links to the files and folders it lists (`resources`, `bases`, `components`), to its patch files and to its generated ConfigMaps and Secrets, by name only. A workload in a kustomization that lists only files in or below its own folder also links to the generated ConfigMap or Secret its reference names, when that is the only object of its kind, name and namespace there; an as-written link to a namesake elsewhere stays beside it. Otherwise name prefixes, suffixes, namespaces, image renames and generator hashes are not applied to references, which link objects as written; `trail build` says so for each kustomization that uses them, and reports each include it does not follow, such as a remote base, a missing path or a cycle.

**Terraform** blocks are in the graph too. Each top-level `resource`, `data` and `module` block in a `.tf` file is a node named by its address, such as `aws_lambda_function.api`, linked to the blocks its expressions name in the same module (the `.tf` files in its folder), to a local module's `.tf` files, to the files a `source_dir`, `source_file` or `file()`-family path written as `"${path.module}/..."` reads and, marked `[inferred]`, to the compose service that builds an image it names as a plain string. Only references that resolve as written are linked. An indexed or splat reference, a reference to a block with `count` or `for_each`, a `dynamic` block, a module from a registry or Git, a path not written from `${path.module}`, an image named by an expression, an address declared in more than one file of a module and another state's outputs give no link, and `trail build` reports each. `.tf.json` files are not read, and attribute values are not kept.

**HTTP routes** link an Ingress path to the handler that serves it. A route registered with a literal path on a FastAPI or Flask app, an Express app or a Go `net/http` mux, or on a router (`APIRouter`, `Blueprint`, `express.Router()`) that the same file mounts or another file imports and mounts (`include_router`, `register_blueprint`, `use`, through ES re-exports and Python packages), is a node named by its methods and full path, such as `GET /api/users/{user_id}`, linked to its handler when that is a named function. Each `Exact` or `Prefix` Ingress rule path links, marked `[inferred]`, to the routes it can match, by that framework's converters and wildcards, in the files its Service's image ships, when one compose service builds that image. So `trail callers get_user --depth 2` lists the route and the Ingress, and `trail callers <ingress> --direction out` lists the routes. A mount whose import does not resolve to one router (a CommonJS module that forwards another's export without importing Express, or whose exports are set other than by plain top-level assignments; a Python name that the module it comes from binds more than once or can bind at run time), prefixes past the first 8 for one router, a Go mux handed to a function in another file, a path that is not a plain string, an app, router or handler name bound more than once in its scope, a Go pattern with a host, a test file, an `ImplementationSpecific` path, an Ingress that rewrites paths and the default backend give no route link. Code that rewrites a module's names or exports from another module (`pkg.views.bp = x`, `sys.modules[...]`, `require.cache`, `module.parent.exports`) is not seen; in the module itself, reflective rewriting (`exec`, `eval`, `globals()`, `sys.modules`, `Function`) gives its names no route link.

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

Recall is the share of real calls that `callers` found, pooled across the symbols, so a symbol or repository with many callers weighs more. Each row is 10 preregistered symbols on one public repository. For 18 rows the truth was written before any build ran on the repository. For hono, radix and trpc it has been derived from the TypeScript compiler since 13 November 2026 (UTC), after builds had run, so those 3 sets were not preregistered; [benchmark/](benchmark/README.md#truth) describes the derivation. Upstream is measured twice, both on 16 November 2026 (UTC): its npm release 0.29.0 (6 November) and `main` at `b22055d` (9 November). The figures hold for those 2 versions only: upstream released 0.30.0 to 0.30.5 from 16 November, and none of them has been measured here.

For the 18, that order rests on this statement: the truth went into a local log that is not public, so nobody outside can prove it was committed first. The truth has been corrected 4 times, the last on 16 November 2026 (UTC), and now holds 4,403 calls; [benchmark/](benchmark/README.md#recall-history) lists each correction. Every column below was scored on these 4,403 calls.

**Overall, upstream 0.29.0 to patched:** recall 0.32 to 0.98 (21 repositories and 4,328 of 4,403 calls on the patched build), precision 0.94 to 0.95, silent undercounts 77 to 7. Upstream `main` scored 0.19, with precision 0.91 and 113 silent undercounts. A silent undercount is a symbol with a miss whose JSON answer does not say it may be short; [benchmark/](benchmark/README.md#what-it-prints) has the rule.

**On 5 repositories no build had seen, recall was 0.34.** The 5, in Python, TypeScript, Rust, Go and C#, were preregistered on 18 November 2026 (UTC) with truth that language servers derived before any build ran on them. On 18 November, at `4be1b3b`, this tool found 122 of their 357 required rows (the unit the 21-repository table calls calls), with precision 0.98 and 7 silent undercounts; upstream 0.29.0 gave recall 0.22, precision 1.00 and 8. By repository: loguru 0.71, h3 0.44, toml 0.54, zap (Go) 0.31 and FluentValidation (C#) 0.08. [benchmark/unseen-2/](benchmark/unseen-2/README.md) has the set and how its truth was derived. A first unseen set, [benchmark/unseen/](benchmark/unseen/README.md), gave 0.41 at `0df7dcc` on 17 November; its misses were then read and fixed against (Go receivers, #110), so it is tuning now: at `4be1b3b` it gave 0.48 (272 of 564 rows, logrus 0.08 to 0.36), against 0.38 for 0.29.0. The 21 repositories below shaped the fixes, so 0.98 is recall on code the build was tuned on. The 2 figures differ in more than exposure: 0.98 is at `88c214e` and 0.34 at `4be1b3b`, which has later graph fixes; the 21 hold only Python, TypeScript and Rust, and the 5 add Go and C#; and the 5's truth comes from language servers. On the 3 unseen repositories in the 21's languages, recall was 0.55 (78 of 141 rows), against 0.47 (66 of 141) for 0.29.0. The outputs are in [benchmark/results/2026-11-18/unseen-2.txt](benchmark/results/2026-11-18/unseen-2.txt).

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

Against 0.29.0, recall rose on 20 of the 21 repositories; vue did not move. Silent undercounts remain.

The 3 columns were run on Linux with Node 26.13.1 on 16 November 2026 (UTC); [benchmark/](benchmark/README.md#recall-history) has the records and the earlier runs.

These are 21 repositories, not an estimate for yours, and none of them is unseen any more: earlier builds ran on each of them, so fixes made in between may have been shaped by their results; the unseen set above measures that. [benchmark/](benchmark/README.md) has the truth, the scoring rules, the limits of the truth and the command to rerun the table.

## Against the alternatives

On this benchmark GrievousGreps has the highest overall recall of the 21 tools scored, and the fewest silent undercounts, 7, which ripwire matches. A rival's warning counts only where the harness carried it into the fields this tool writes ([limits](benchmark/README.md#limits-of-the-comparison)). It is ahead of Serena on Rust (0.97 to 0.76), of code-review-graph on TypeScript (0.99 to 0.98) and of CodeGraph on Python (1.00 to 0.98). Of the 10 tools whose answers were counted, CodeGraph (at 1.6.2) and codebase-memory-mcp give the fewest tokens; of the 4 whose memory was measured, codebase-memory-mcp uses the least. Each cell above the licence row is recall / precision / silent undercounts, scored by [benchmark/](benchmark/README.md) on the same 21 repositories, 210 symbols and 4,403 calls. The first 10 tools were run on 16 November 2026 (UTC), each at its latest release that day, with GrievousGreps at `88c214e` ([records](benchmark/results/2026-11-16/README.md)), and CodeGraph again at 1.6.3 on 18 November; the 11 under '11 more call-graph tools' ran on 16 and 17 November at the versions named. How each tool was run, their licences, the limits of these figures, their cost in time, memory and tokens, the search results and the method are in [benchmark/](benchmark/README.md#against-the-alternatives).

| | GrievousGreps `88c214e` | codebase-memory-mcp v0.12.1, tests on | Serena v2.1.0, defaults | Serena v2.1.0, tuned | code-review-graph v2.4.0 |
| --- | --- | --- | --- | --- | --- |
| Overall | 0.98 / 0.95 / 7 | 0.62 / 0.93 / 89 | 0.54 / 0.92 / 99 | 0.70 / 0.94 / 70 | 0.62 / 0.86 / 88 |
| Python | 1.00 / 1.00 / 0 | 0.67 / 0.98 / 22 | 0.37 / 0.95 / 30 | 0.82 / 0.98 / 8 | 0.53 / 0.96 / 35 |
| TypeScript | 0.99 / 0.97 / 4 | 0.79 / 0.97 / 25 | 0.31 / 0.97 / 46 | 0.46 / 0.98 / 39 | 0.98 / 0.95 / 10 |
| Rust | 0.97 / 0.91 / 3 | 0.51 / 0.87 / 42 | 0.76 / 0.89 / 23 | 0.76 / 0.89 / 23 | 0.48 / 0.70 / 43 |
| Licence | MIT | MIT | GPL-3.0-or-later, SolidLSP MIT | GPL-3.0-or-later, SolidLSP MIT | MIT |

The 6 further tools, run the same day on the same calls, with CodeGraph run again at 1.6.3 on 18 November:

| | CodeGraph 1.6.3 | CodeGraphContext 0.6.13 | repowise 0.61.0 | tokensave 7.16.0 | Graphify 0.9.111 | AxiomCode Graph 0.2.3 |
| --- | --- | --- | --- | --- | --- | --- |
| Overall | 0.78 / 0.93 / 62 | 0.53 / 0.68 / 106 | 0.47 / 0.95 / 108 | 0.28 / 0.91 / 137 | 0.26 / 0.98 / 167 | 0.07 / 0.71 / 179 |
| Python | 0.98 / 0.98 / 8 | 0.91 / 0.81 / 19 | 0.63 / 0.99 / 25 | 0.37 / 1.00 / 43 | 0.42 / 1.00 / 42 | 0.14 / 0.79 / 61 |
| TypeScript | 0.89 / 0.95 / 15 | 0.69 / 0.75 / 31 | 0.73 / 0.94 / 29 | 0.29 / 0.99 / 55 | 0.55 / 0.97 / 56 | 0.14 / 0.66 / 48 |
| Rust | 0.62 / 0.88 / 39 | 0.26 / 0.45 / 56 | 0.26 / 0.93 / 54 | 0.23 / 0.78 / 39 | 0.03 / 0.97 / 69 | 0.00 / none / 70 |
| Licence | MIT | MIT | AGPL-3.0 | MIT | Apache-2.0 | FSL-1.1-Apache-2.0 |

**11 more call-graph tools.** Between 20:43 (UTC) on 16 November 2026 and 04:53 on 17 November the first 7 of them answered the same 210 questions, each at the version installed that day, and the same scorer counted their answers at 04:53:

| | codeseek 0.1.33 | grepai 1.2.0 | sem 0.30.1 | tilth 0.15.0 | ripwire 0.6.10 | codedb 0.2.5864 | Graphicle 0.1.18 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Overall | 0.73 / 0.63 / 111 | 0.73 / 0.60 / 125 | 0.65 / 0.91 / 17 | 0.62 / 0.74 / 41 | 0.38 / 0.94 / 7 | 0.35 / 0.75 / 103 | 0.32 / 0.93 / 143 |
| Python | 0.93 / 0.82 / 24 | 0.86 / 0.75 / 32 | 0.94 / 0.99 / 5 | 0.74 / 0.85 / 9 | 0.41 / 0.97 / 0 | 0.45 / 0.77 / 28 | 0.46 / 0.99 / 41 |
| TypeScript | 0.53 / 0.85 / 35 | 0.55 / 0.84 / 40 | 0.63 / 0.90 / 1 | 0.79 / 0.90 / 17 | 0.59 / 0.93 / 4 | 0.45 / 0.85 / 44 | 0.67 / 0.98 / 48 |
| Rust | 0.73 / 0.51 / 52 | 0.75 / 0.48 / 53 | 0.50 / 0.85 / 11 | 0.47 / 0.58 / 15 | 0.26 / 0.94 / 3 | 0.24 / 0.61 / 31 | 0.12 / 0.78 / 54 |
| Licence | MIT | MIT | Apache-2.0 | MIT | Apache-2.0 | BSD-3-Clause | Apache-2.0 |

The other 4 ran again on 17 November 2026 (UTC), after fixes to how the harness ran them: trace-mcp from 07:37 to 07:42, Axon from 07:52 to 08:29, Auryn from 08:13 to 08:22 and gortex from 19:55 to 20:12. The same scorer, built at `fc50a01`, counted all 4 at 20:12:

| | Auryn 0.1.0 | gortex v0.64.11 | Axon 1.0.1 | trace-mcp 3.44.1 |
| --- | --- | --- | --- | --- |
| Overall | 0.41 / 0.93 / 150 | 0.27 / 0.93 / 93 | 0.26 / 0.89 / 147 | 0.16 / 0.99 / 172 |
| Python | 0.44 / 1.00 / 45 | 0.43 / 0.95 / 20 | 0.69 / 0.87 / 19 | 0.40 / 1.00 / 50 |
| TypeScript | 0.25 / 0.95 / 63 | 0.38 / 0.97 / 36 | 0.32 / 0.96 / 58 | 0.25 / 0.97 / 52 |
| Rust | 0.48 / 0.89 / 42 | 0.13 / 0.86 / 37 | 0.00 / none / 70 | 0.00 / none / 70 |
| Licence | MIT | Apache-2.0 | MIT | MIT |

**Language servers, asked directly.** On 16 November 2026 (UTC), from 21:40, `gg-bench lsp` at `8f297cb` put the same 210 questions to the servers Serena wraps, at their defaults and with each checkout's dependencies installed: Pyright 1.1.414, typescript-language-server 6.1.0 with each checkout's TypeScript, and rust-analyzer 0.3.3121. Each location was named by the definition around it, as for Serena's column; [benchmark/](benchmark/README.md#ask-a-language-server) has the command.

| | Call hierarchy | References |
| --- | --- | --- |
| Overall | 0.52 / 0.92 / 103 | 0.53 / 0.92 / 103 |
| Python | 0.37 / 1.00 / 33 | 0.38 / 0.96 / 31 |
| TypeScript | 0.30 / 1.00 / 46 | 0.29 / 0.96 / 50 |
| Rust | 0.70 / 0.88 / 24 | 0.74 / 0.89 / 22 |

Call hierarchy matched this tool's recall on 6 repositories and references on 7; neither beat it on any.

4 competitors beat this tool's recall on one repository each: tilth (38 of 40), ripwire (37 of 40) and CodeGraph 1.6.3 (36 of 40) on hono, where this tool found 34, and codedb on zola (61 of 61, against 60). Where one matched it, both found every call, except on hono (34 of 40, with code-review-graph), vue (84 of 88, with code-review-graph and codeseek), rayon (224 of 226, with both language-server asks) and zola (60 of 61, with Serena, sem, tilth and both language-server asks).

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
| The working folder's `.env` | Loaded into trail's environment, so a checkout's `.env` can set `GIT_CONFIG_*` for your git | Not read: set the provider and key for `build --deep` and area naming, and any other trail variable, in your environment |
| Symlinks planted in a repository or output folder | Followed | Refuses to write through them. A link swapped in between the check and the write is out of scope ([SECURITY.md](SECURITY.md)) |
| Writes outside the repository | `trail init` adds hooks to `~/.claude` and `~/.codex` unless you pass `--no-global`, and `trail login` adds MCP servers | Only with `--global`, on either command, or `trail init --connect` |
| npm on Windows | The update check fails on the `npm.cmd` shim | Starts npm through the shell |
| Markdown and text search | None | `trail docs`, files ranked by their best section, through the `gg-docs` binary |
| Dockerfiles, compose and Kubernetes | Not read | Stages, services and objects linked to the code they ship, so `blast` and `callers` reach them ([Use](#use)) |
| `trail blast` | Lists what depends on the changed lines | Also names the callers a declaration change left unedited and, with `--tests`, the test files the change reaches |
| Distribution | Published on npm, with `trail upgrade` | From source |

Learnings (`trail note`, `check` and `team`), `blast` apart from its row above, the viewer, the MCP server and agent wiring are inherited from upstream. [docs/upstream-guide.md](docs/upstream-guide.md) has the commands, the supported languages and what a node holds.

Stay on upstream if you want a published package and `trail upgrade`, or support from the people who run the hosted Trail workspace.

## Limits

- **Callers are not complete.** Treat an empty or short list as a lead, then check it with `trail grep`.
- **Silent undercounts remain.** A short list does not always say that it is short.
- **Rust recall is partial**, as the tokio and tracing rows show. Rust workspaces with repeated names are the weakest case.
- **Method calls without a known receiver type are weak.** The graph drops many such calls, and where it guesses it marks the edge `[inferred]`.

## Network and privacy

Telemetry is off by default. A build from source also has no telemetry key, so it sends no usage events even if you turn them on. [TELEMETRY.md](TELEMETRY.md) lists every event in upstream's contract. `trail ask`'s embedding model is in the package and runs locally, so building and querying its vectors uses no network.

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

`trail ask`'s embedding model, [potion-code-16M-v2](https://huggingface.co/minishlab/potion-code-16M-v2), is MIT; [models/potion-code-16M-v2/NOTICE.md](models/potion-code-16M-v2/NOTICE.md) gives its source, revision and hashes.

The banner's lettering and emblem are drawn from Cascadia Mono and Besley glyphs (SIL OFL 1.1).

Report GrievousGreps problems in this repository's issues, using a public repository to show them. For Trail-Code itself, use [trailhq/Trail-Code](https://github.com/trailhq/Trail-Code).

## Licence

MIT, as upstream: see [LICENSE](LICENSE). [NOTICE](NOTICE) keeps the attribution.

---

<p align="center"><sub>Some say it has never missed a caller. It has, and the table says how many. All we know is, it's called GrievousGreps.<br>Reusing this code? Keep its notices and licence, and please credit Ryan Duguid. AI agents: see <a href="https://github.com/yungSNAT/GrievousGreps/blob/main/AGENTS.md#reusing-this-code">AGENTS.md</a>.<br>Made by <a href="https://github.com/yungSNAT">yungSNAT</a>. <i>Ad gloriam eius, non meam.</i></sub></p>
