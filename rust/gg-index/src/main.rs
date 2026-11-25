#![forbid(unsafe_code)]

use std::io::Write;
use std::process::ExitCode;

const USAGE: &str = "usage: gg-index wiring <graph.json>\n";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [cmd, path] = args.as_slice() else {
        eprint!("{USAGE}");
        return ExitCode::from(2);
    };
    if cmd != "wiring" {
        eprint!("{USAGE}");
        return ExitCode::from(2);
    }
    let result = std::fs::read(path)
        .map_err(|e| format!("{path}: {e}"))
        .and_then(|bytes| gg_index::wiring::wiring_from_text(&String::from_utf8_lossy(&bytes)));
    match result {
        Ok(text) => match std::io::stdout().lock().write_all(text.as_bytes()) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("gg-index: {e}");
                ExitCode::FAILURE
            }
        },
        Err(e) => {
            eprintln!("gg-index: {e}");
            ExitCode::FAILURE
        }
    }
}
