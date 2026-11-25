#![forbid(unsafe_code)]

use std::io::Write;
use std::path::PathBuf;
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
    },
}

fn main() -> ExitCode {
    let Cmd::Wiring { graph } = Cli::parse().command;
    let result = std::fs::read(&graph)
        .map_err(|e| format!("{}: {e}", graph.display()))
        .and_then(|bytes| gg_index::wiring::wiring_from_text(&String::from_utf8_lossy(&bytes)))
        .and_then(|text| {
            std::io::stdout()
                .lock()
                .write_all(text.as_bytes())
                .map_err(|e| e.to_string())
        });
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("gg-index: {e}");
            ExitCode::FAILURE
        }
    }
}
