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
[![node: 22.3+](.github/assets/badges/node.svg)](https://nodejs.org/) [![licence: MIT](.github/assets/badges/licence.svg)](LICENSE) [![fork of: Trail-Code](.github/assets/badges/fork-of.svg)](https://github.com/trailhq/Trail-Code)

[Install](#install) · [Use](#use) · [Docs search](#docs-search) · [Measured recall](#measured-recall) · [Compared with upstream](#compared-with-upstream) · [Limits](#limits) · [Network and privacy](#network-and-privacy) · [Development](#development) · [Credits](#credits) · [Licence](#licence)

</div>

GrievousGreps is yungSNAT's distribution of [Trail-Code](https://github.com/trailhq/Trail-Code), the code graph CLI for coding agents, formerly Graft. It maps the functions it can parse in a repository and the callers it can resolve, so an agent can check what a change reaches before it edits. It misses some callers: see [Measured recall](#measured-recall) and [Limits](#limits).

On the 21 public repositories its fixes were tuned on, its [measured recall](#measured-recall) is 0.98 (16 November 2026, UTC, at `88c214e`). On 5 repositories no build had seen, it was 0.34 (18 November, at `4be1b3b`). Its Rust recall is partial. It installs both the `trail` and `graft` commands, where upstream's npm release 0.29.0 installs `trail` and its source installs `graft`, so agent configuration and most commands work as they do upstream. [Compared with upstream](#compared-with-upstream) lists the differences, background network requests and symlinks among them.

## Install

GrievousGreps has no npm package, so npm builds it from this repository. You need Node 22.3 or later, plus git and a C++ toolchain for the native grammars.

GrievousGreps provides `trail` and `graft`, and each upstream package provides one of them, so first remove any upstream copy, and any copy installed under this package's earlier name, `@equitybot/grievousgreps` (then run `trail init` again in each repository that uses it, so its hooks find the new name):

```bash
npm uninstall -g @trailhq/trail-code @nanonets/graft @equitybot/grievousgreps
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

`trail ask` ranks files by the question's words and, by default, by its meaning, and merges the 2 rankings. Meaning comes from [potion-code-16M-v2](https://huggingface.co/minishlab/potion-code-16M-v2/tree/e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b) (MIT), a static embedding model of 33.5 MB (its weights and tokenizer) in the package's `models/` folder, which runs in Node on the CPU with no account, no download and no network. `trail build` embeds each source file in chunks of whole lines into the map's `.cache/ask-vectors.bin`, and later builds embed only the files that changed. That is the first-run cost, which [benchmark/](benchmark/README.md#install-and-use-measurements) measures. On the 1,251-query retrieval set in [benchmark/ask/](benchmark/README.md#ask-which-files-a-question-is-about), this raised NDCG@10 from 0.750 by words only (with `TRAIL_SEMANTIC=0`) to 0.793, both at `ebef20c` on 19 November (UTC). Set `TRAIL_SEMANTIC=0` to rank by words only; the next build removes the vectors. A query from a folder of several repositories ranks by words only.

`trail init` writes inside the repository, with the tool's own state in `~/.trail`. Claude Code's hooks go in the repository's `.claude` settings. That has a cost: a worktree or an ignored checkout has no hooks until you run `trail init` there.

`trail init --global` closes that gap by adding hooks to `~/.claude`, and to `~/.codex` for Codex, which run in every project on the machine. `trail uninstall -y` removes what either form wrote except the `.trail/` folder, which keeps your learnings; without `-y` it is a dry run.

The map lives in `.trail/cache` in a repository on trail and in `graft/` elsewhere: a local cache to keep out of git.

In a folder of separate git repositories, `trail build` builds one graph per repository and a federated index beside them, and a query from the folder searches them all, each hit labelled with its repository. `trail ask` there lists the hits in one list, taking each repository's next hit in turn, by its own ranking ([measured](benchmark/README.md#install-and-use-measurements)). Calls between the repositories are not linked: in a folder holding click, flask and httpx, `trail callers get_current_context` listed click's own 16 callers, not flask's call in `tests/test_cli.py`. [docs/upstream-guide.md](docs/upstream-guide.md#monorepos-submodules--multi-repo-folders) covers this and the other layouts.

**Deployment files** are in the graph too. A Dockerfile gives a node for each stage, a compose file one for each service, volume and network, and a Kubernetes manifest one for each object, linked to the source files a stage copies or a service mounts, to the stage a service builds and the services it depends on, to the ConfigMaps, Secrets, claims and service accounts a workload names, from a Service to the workloads its selector picks and from an Ingress to its Services. A workload links to the compose service that builds its image when the image names match, marked `[inferred]`; without such a compose file a Dockerfile names no image, so the link stops there. So `trail blast --depth all` on a changed function lists the stage that copies its file, the compose service and Deployment that run it and the Service and Ingress in front of it, and `trail callers app-config` lists the workloads that read that ConfigMap. Only names are kept: no environment value and no ConfigMap or Secret data reaches the graph, and source queries and `trail grep` skip its text. `trail build` reports parse failures, unsupported fields and files whose COPY or bind-mount expansion exceeds 50,000 file candidates. It lists the first 10 and counts the rest. COPY links are inferred when the build context is assumed or shared across contexts, or when a Docker ignore file or COPY exclusion can change the match. Kubernetes object and selector links prefer matches in the same folder and mark other-folder matches as inferred. Helm rendering, Kustomize rendering, environment-variable substitution in compose and remote build contexts are outside the build. With `-e`, deployment files are left out.

**Kustomize** structure is in the graph too. A kustomization links to the files and folders it lists (`resources`, `bases`, `components`), to its patch files and to its generated ConfigMaps and Secrets, by name only. When a standalone leaf kustomization using only supported leaf fields (`namespace`, `namePrefix`, `nameSuffix`, `resources`, `bases`, `configMapGenerator`, `secretGenerator`) lists only complete local resource files inside its folder (no folders, `components`, escaping symlinks, reserved Kustomize annotations, generator options or `merge`/`replace` strategies, and with non-empty-named generators using valid `literals` or existing local `files` only) with no object collisions in the build, a workload in it also links to the unique generated ConfigMap or Secret of that kind, name and namespace whose generator id is not repeated; so does a workload in such a leaf, or in an overlay listing such leaf folders with no prefix or suffix on either, to the overlay's own unique generator; a build above can still patch or transform references after accumulation, and an as-written link to a namesake elsewhere stays beside it. Otherwise name prefixes, suffixes, namespaces, image renames and generator hashes are not applied to references, which link objects as written; `trail build` says so for each kustomization that uses them, and reports each include it does not follow, such as a remote base, a missing path or a cycle.

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

Recall is the share of real calls that `callers` found, pooled across the symbols, so a symbol or repository with many callers weighs more. Each of the 21 public repositories has 10 preregistered symbols. For 18 of them the truth was written before any build ran on the repository. For hono, radix and trpc it has been derived from the TypeScript compiler since 13 November 2026 (UTC), after builds had run, so those 3 sets were not preregistered; [benchmark/](benchmark/README.md#truth) describes the derivation.

For the 18, that order rests on this statement: the truth went into a local log that is not public, so nobody outside can prove it was committed first. The truth has been corrected 4 times, the last on 16 November 2026 (UTC), and now holds 4,403 calls; [benchmark/](benchmark/README.md#recall-history) lists each correction. The figures below were scored on these 4,403 calls.

**Overall, at `88c214e`:** recall 0.98 (4,328 of 4,403 calls on the 21 repositories), precision 0.95 and 7 silent undercounts. A silent undercount is a symbol with a miss whose JSON answer does not say it may be short; [benchmark/](benchmark/README.md#what-it-prints) has the rule.

**On 5 repositories no build had seen, recall was 0.34.** The 5, in Python, TypeScript, Rust, Go and C#, were preregistered on 18 November 2026 (UTC) with truth that language servers derived before any build ran on them. On 18 November, at `4be1b3b`, this tool found 122 of their 357 required rows (the unit the 21-repository benchmark calls calls), with precision 0.98 and 7 silent undercounts. By repository: loguru 0.71, h3 0.44, toml 0.54, zap (Go) 0.31 and FluentValidation (C#) 0.08. [benchmark/unseen-2/](benchmark/unseen-2/README.md) has the set and how its truth was derived. A first unseen set, [benchmark/unseen/](benchmark/unseen/README.md), gave 0.41 at `0df7dcc` on 17 November; its misses were then read and fixed against (Go receivers, #110), so it is tuning now: at `4be1b3b` it gave 0.48 (272 of 564 rows, logrus 0.08 to 0.36). The 21 repositories shaped the fixes, so 0.98 is recall on code the build was tuned on. The 2 figures differ in more than exposure: 0.98 is at `88c214e` and 0.34 at `4be1b3b`, which has later graph fixes; the 21 hold only Python, TypeScript and Rust, and the 5 add Go and C#; and the 5's truth comes from language servers. On the 3 unseen repositories in the 21's languages, recall was 0.55 (78 of 141 rows). [benchmark/unseen-2/](benchmark/unseen-2/README.md) has the command to rerun it.

Rust recall is partial. Together tokio and tracing hold 1,643 of the 4,403 calls, and their symbols were chosen for names repeated across crates and types.

Edges that are not definite come in 2 grades. `[likely]` marks a link to another file that a stated type, an import path, a crate or a base class picked; `[inferred]` marks one matched by name alone. In a sample of our own edges on 26 November 2026 (UTC) at `e51d321`, judged by reading the code, 108 of 111 typed or scoped edges were right in rich (Python), ripgrep (Rust) and hono (TypeScript), and 30 of 32 in TanStack query and trpc (TypeScript; the other 2 unclear). The 3 wrong ones were calls on the platform's `Response`, which hono's own `Response` type shadows; a TypeScript receiver whose type the file neither declares nor imports now stays `[inferred]`. Name-only edges were right 13 of 48 times. Only Python, TypeScript, JavaScript and Rust edges are graded `[likely]`; other languages keep `[inferred]` until a sample measures them. Before the split, about 1 in 6 `[inferred]` edges were wrong, in 2 samples totalling 80 edges (14 false, 95% interval 11% to 27%), at `e37a764` and `949d829`. An edge with either mark is a lead. `callers`, its JSON and the MCP tool show the mark, and at depth 2 or more they show the weaker mark on any hit whose every shortest path crosses such an edge. `blast` treats both as leads: it marks them `[inferred]`, counts those dependents and lists them after the definite ones at each depth. Definite edges: 2 of 80 false over the same 2 samples.

The 21-repository run was on Linux with Node 26.13.1 on 16 November 2026 (UTC); [benchmark/](benchmark/README.md#recall-history) has the corrections to the truth. Silent undercounts remain.

These are 21 repositories, not an estimate for yours, and none of them is unseen any more: earlier builds ran on each of them, so fixes made in between may have been shaped by their results; the unseen set above measures that. [benchmark/](benchmark/README.md) has the truth, the scoring rules, the limits of the truth and the command to rerun the benchmark.

## Compared with upstream

This table lists what the code changes from upstream `a44da3d` (30 October 2026, package version 0.28.0), the base of this build. It adds `trail share-session`, which is off unless `TRAIL_SHARE_SESSION=1` is set. Upstream `main` has changed since. Upstream's agent benchmarks are not repeated here, because they have not been rerun on this build.

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
- **Rust recall is partial.** Rust workspaces with repeated names are the weakest case.
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

<p align="center"><sub>Some say it has never missed a caller. It has, and the benchmark says how many. All we know is, it's called GrievousGreps.<br>Reusing this code? Keep its notices and licence, and please credit Ryan Duguid. AI agents: see <a href="https://github.com/yungSNAT/GrievousGreps/blob/main/AGENTS.md#reusing-this-code">AGENTS.md</a>.<br>Made by <a href="https://github.com/yungSNAT">yungSNAT</a>. <i>Ad gloriam eius, non meam.</i></sub></p>
