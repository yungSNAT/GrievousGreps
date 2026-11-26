#![forbid(unsafe_code)]

use std::io::Write;
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
        #[arg(long, value_name = "DIR")]
        out_dir: Option<PathBuf>,
    },
}

fn main() -> ExitCode {
    let Cmd::Wiring { graph, out_dir } = Cli::parse().command;
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
            None => std::io::stdout()
                .lock()
                .write_all(text.as_bytes())
                .map_err(|e| e.to_string()),
        });
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("gg-index: {e}");
            ExitCode::FAILURE
        }
    }
}
