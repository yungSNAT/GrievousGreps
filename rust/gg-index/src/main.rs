#![forbid(unsafe_code)]

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "gg-index",
    about = "Native Rust indexing engine for GrievousGreps (staged port of src/graph)"
)]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Print the wiring.json bytes the TypeScript writer would write for a graph
    Wiring {
        /// Graph JSON file
        graph: PathBuf,
        /// Write <DIR>/.graph/wiring.json atomically instead of printing
        // An OsString parser, as clap's PathBuf parser refuses `""`, which `writeGraph` takes as `.`.
        #[arg(long, value_name = "DIR", value_parser = clap::builder::TypedValueParser::map(clap::builder::OsStringValueParser::new(), PathBuf::from))]
        out_dir: Option<PathBuf>,
    },
    /// Print `supportedExtensions()` as JSON (a test interface)
    Extensions,
    /// Read NUL-separated paths on stdin; print `[parser claims it, deployFormatOf]` for each (a test interface)
    Classify,
    /// Print `[rel, size, mtimeMs]` for each file `listSourceStats` lists (a test interface)
    Sources {
        #[arg(long)]
        root: String,
        #[arg(long)]
        out_dir: String,
        /// A name `--include-dir` un-skips (repeatable)
        #[arg(long = "include-dir")]
        include_dir: Vec<String>,
        #[arg(long)]
        follow_submodules: bool,
        #[arg(long)]
        follow_nested_repos: bool,
        /// Keep only files at or under this repository-relative folder (repeatable)
        #[arg(long = "only-dir")]
        only_dir: Vec<String>,
        /// Keep only files with this extension (repeatable)
        #[arg(long = "ext", allow_hyphen_values = true)]
        ext: Vec<String>,
    },
    /// Read or write the per-file extraction cache sidecar (a test interface)
    Cache {
        #[command(subcommand)]
        action: CacheCmd,
    },
    /// Read or write the fingerprint sidecar (a test interface)
    Fingerprint {
        #[command(subcommand)]
        action: FingerprintCmd,
    },
}

#[derive(Subcommand)]
enum CacheCmd {
    /// Write the cache JSON from stdin to <DIR>/.cache/extract.<STAMP>.json; print true or false
    Write {
        #[arg(long, value_name = "DIR", value_parser = clap::builder::TypedValueParser::map(clap::builder::OsStringValueParser::new(), PathBuf::from))]
        out_dir: PathBuf,
        #[arg(long)]
        extractor: String,
    },
    /// Read <DIR>/.cache/extract.<STAMP>.json; print compact JSON
    Read {
        #[arg(long, value_name = "DIR", value_parser = clap::builder::TypedValueParser::map(clap::builder::OsStringValueParser::new(), PathBuf::from))]
        out_dir: PathBuf,
        #[arg(long)]
        extractor: String,
    },
}

#[derive(Subcommand)]
enum FingerprintCmd {
    /// Write the fingerprint projected from entries JSON on stdin; print true or false
    Write {
        #[arg(long, value_name = "DIR", value_parser = clap::builder::TypedValueParser::map(clap::builder::OsStringValueParser::new(), PathBuf::from))]
        out_dir: PathBuf,
        #[arg(long)]
        extractor: String,
        /// Repo-relative folder prefixes persisted in the fingerprint (repeatable)
        #[arg(long = "only-dir")]
        only_dir: Vec<String>,
        /// Normalised extension selection persisted in the fingerprint (repeatable)
        #[arg(long = "ext", allow_hyphen_values = true)]
        ext: Vec<String>,
    },
    /// Read <DIR>/.cache/fingerprint.<STAMP>.json; print compact JSON or null
    Read {
        #[arg(long, value_name = "DIR", value_parser = clap::builder::TypedValueParser::map(clap::builder::OsStringValueParser::new(), PathBuf::from))]
        out_dir: PathBuf,
        #[arg(long)]
        extractor: String,
    },
}

/// The most `classify` reads from stdin; more is refused rather than buffered.
const MAX_CLASSIFY_INPUT: u64 = 64 << 20;

fn main() -> ExitCode {
    let work: Box<dyn FnOnce() -> ExitCode + Send> = match Cli::parse().command {
        Cmd::Wiring { graph, out_dir } => Box::new(move || wiring(&graph, out_dir.as_deref())),
        Cmd::Extensions => return report(print(&extensions())),
        Cmd::Sources {
            root,
            out_dir,
            include_dir,
            follow_submodules,
            follow_nested_repos,
            only_dir,
            ext,
        } => {
            let opts = gg_index::sources::Options {
                includes: include_dir,
                follow_submodules,
                follow_nested_repos,
                only_dirs: only_dir,
                extensions: ext,
            };
            return report(
                gg_index::sources::list_source_stats(Path::new(&root), Path::new(&out_dir), &opts)
                    .and_then(|rows| print(&gg_index::sources::to_json(&rows))),
            );
        }
        Cmd::Classify => {
            return report(read_stdin(MAX_CLASSIFY_INPUT).and_then(|text| {
                let mut out = std::io::BufWriter::new(std::io::stdout().lock());
                classify(&text, &mut out)
                    .and_then(|()| out.flush())
                    .map_err(|e| e.to_string())
            }));
        }
        Cmd::Cache { action } => Box::new(move || cache_cmd(action)),
        Cmd::Fingerprint { action } => Box::new(move || fingerprint_cmd(action)),
    };
    // Deeply nested graphs recurse once a level; give them the stack they need.
    std::thread::Builder::new()
        .stack_size(gg_index::json::STACK_BYTES)
        .spawn(work)
        .map(|worker| worker.join().unwrap_or(ExitCode::FAILURE))
        .unwrap_or_else(|e| {
            eprintln!("gg-index: cannot start the worker thread: {e}");
            ExitCode::FAILURE
        })
}

fn cache_cmd(action: CacheCmd) -> ExitCode {
    let result = match action {
        CacheCmd::Write { out_dir, extractor } => {
            read_stdin(gg_index::extract_cache::MAX_CACHE_BYTES)
                .and_then(|text| gg_index::json::parse(&text))
                .and_then(|val| {
                    let ok =
                        gg_index::extract_cache::write_extract_cache(&out_dir, &extractor, &val);
                    print(if ok { "true\n" } else { "false\n" })
                })
        }
        CacheCmd::Read { out_dir, extractor } => {
            let val = gg_index::extract_cache::read_extract_cache(&out_dir, &extractor);
            print(&format!("{}\n", gg_index::json::stringify_compact(&val)))
        }
    };
    report(result)
}

fn fingerprint_cmd(action: FingerprintCmd) -> ExitCode {
    let result = match action {
        FingerprintCmd::Write {
            out_dir,
            extractor,
            only_dir,
            ext,
        } => read_stdin(gg_index::extract_cache::MAX_CACHE_BYTES)
            .and_then(|text| gg_index::json::parse(&text))
            .and_then(|val| {
                let ok = gg_index::fingerprint::write_fingerprint(
                    &out_dir, &extractor, &val, &only_dir, &ext,
                );
                print(if ok { "true\n" } else { "false\n" })
            }),
        FingerprintCmd::Read { out_dir, extractor } => {
            let line = match gg_index::fingerprint::read_fingerprint(&out_dir, &extractor) {
                Some(val) => format!("{}\n", gg_index::json::stringify_compact(&val)),
                None => "null\n".into(),
            };
            print(&line)
        }
    };
    report(result)
}

fn extensions() -> String {
    let quoted: Vec<String> = gg_index::source_files::supported_extensions()
        .iter()
        .map(|e| format!("\"{e}\""))
        .collect();
    format!("[{}]\n", quoted.join(","))
}

fn read_stdin(limit: u64) -> Result<String, String> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .lock()
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| format!("stdin: {e}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!("stdin: more than {limit} bytes"));
    }
    String::from_utf8(bytes).map_err(|e| format!("stdin: not UTF-8: {e}"))
}

/// One `[claims, format]` pair a path, split as JavaScript's `split("\0")` splits.
/// Rows stream to `out`: NUL-only input makes a row per byte, about 13 bytes each.
fn classify(text: &str, out: &mut impl Write) -> std::io::Result<()> {
    out.write_all(b"[")?;
    for (i, p) in text.split('\0').enumerate() {
        let claims = gg_index::source_files::parser_claims(p);
        let sep = if i > 0 { "," } else { "" };
        match gg_index::deploy::deploy_format_of(p) {
            Some(f) => write!(out, "{sep}[{claims},\"{f}\"]")?,
            None => write!(out, "{sep}[{claims},null]")?,
        }
    }
    out.write_all(b"]\n")
}

fn print(text: &str) -> Result<(), String> {
    std::io::stdout()
        .lock()
        .write_all(text.as_bytes())
        .map_err(|e| e.to_string())
}

fn report(result: Result<(), String>) -> ExitCode {
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("gg-index: {e}");
            ExitCode::FAILURE
        }
    }
}

fn wiring(graph: &Path, out_dir: Option<&Path>) -> ExitCode {
    let result = std::fs::read(graph)
        .map_err(|e| format!("{}: {e}", graph.display()))
        .and_then(|bytes| {
            String::from_utf8(bytes).map_err(|e| format!("{}: not UTF-8: {e}", graph.display()))
        })
        .and_then(|text| gg_index::wiring::wiring_from_text(&text))
        .and_then(|text| match out_dir {
            Some(dir) => gg_index::safe_write::write_wiring(dir, &text)
                .map(drop)
                .map_err(|e| e.to_string()),
            None => print(&text),
        });
    report(result)
}
