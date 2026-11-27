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
}

/// The most `classify` reads from stdin; more is refused rather than buffered.
const MAX_CLASSIFY_INPUT: u64 = 64 << 20;

fn main() -> ExitCode {
    let (graph, out_dir) = match Cli::parse().command {
        Cmd::Wiring { graph, out_dir } => (graph, out_dir),
        Cmd::Extensions => return report(print(&extensions())),
        Cmd::Classify => {
            return report(
                read_stdin()
                    .map(|text| classify(&text))
                    .and_then(|o| print(&o)),
            );
        }
    };
    // Deeply nested graphs recurse once a level; give them the stack they need.
    std::thread::Builder::new()
        .stack_size(gg_index::json::STACK_BYTES)
        .spawn(move || wiring(&graph, out_dir.as_deref()))
        .map(|worker| worker.join().unwrap_or(ExitCode::FAILURE))
        .unwrap_or_else(|e| {
            eprintln!("gg-index: cannot start the worker thread: {e}");
            ExitCode::FAILURE
        })
}

fn extensions() -> String {
    let quoted: Vec<String> = gg_index::source_files::supported_extensions()
        .iter()
        .map(|e| format!("\"{e}\""))
        .collect();
    format!("[{}]\n", quoted.join(","))
}

fn read_stdin() -> Result<String, String> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .lock()
        .take(MAX_CLASSIFY_INPUT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("stdin: {e}"))?;
    if bytes.len() as u64 > MAX_CLASSIFY_INPUT {
        return Err(format!("stdin: more than {MAX_CLASSIFY_INPUT} bytes"));
    }
    String::from_utf8(bytes).map_err(|e| format!("stdin: not UTF-8: {e}"))
}

/// One `[claims, format]` pair a path, split as JavaScript's `split("\0")` splits.
fn classify(text: &str) -> String {
    let rows: Vec<String> = text
        .split('\0')
        .map(|p| {
            let format = gg_index::deploy::deploy_format_of(p)
                .map_or_else(|| "null".to_owned(), |f| format!("\"{f}\""));
            format!("[{},{format}]", gg_index::source_files::parser_claims(p))
        })
        .collect();
    format!("[{}]\n", rows.join(","))
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
