//! `lsp-truth`: derives a repository's caller truth from a language server's references, as
//! `benchmark/tsc-truth.mjs` derives it from the TypeScript compiler. With `pick` it first chooses
//! the symbols by a fixed rule and seed, so a new repository's truth can be committed before any
//! tool is built on it.
//!
//! A required row is a call: a reference followed by `(`, after any generic arguments, or used as
//! a decorator, JSX element or tagged template. Calls are grouped by file and by the named
//! definition around them, or by file at module level. Any other reference inside a named
//! definition is an optional row; one at module level, such as an import, gets no row.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::lsp::{READY_LIMIT, Server, Session, fresh_copy, targets};
use crate::run::{read_truth, remove};
use crate::score::{Entry, Repo, Rules};

mod derive;
mod syntax;

pub use derive::{Derived, PICK_CALLS, shuffle};
use derive::{Deriver, open_files, pick};
pub use syntax::{Language, function_holder, is_call, pickable};

pub struct TruthOptions {
    pub bench: PathBuf,
    pub repo: Repo,
    pub work: PathBuf,
    pub server: Vec<OsString>,
    /// Choose this many symbols first, instead of reading them from the truth file.
    pub pick: Option<usize>,
    pub seed: u64,
}

/// The layout of the committed truth files, one row per line, as tsc-truth.mjs writes it.
pub fn format_truth(entries: &[(String, Value)]) -> String {
    let list = |rows: &[Value]| {
        if rows.is_empty() {
            return "[]".to_owned();
        }
        let inner: Vec<String> = rows.iter().map(|r| format!("      {r}")).collect();
        format!("[\n{}\n    ]", inner.join(",\n"))
    };
    let blocks: Vec<String> = entries
        .iter()
        .map(|(symbol, entry)| {
            let mut fields = vec![format!("\"target\": {}", entry["target"])];
            if let Some(lines) = entry.get("target_lines") {
                fields.push(format!("\"target_lines\": {lines}"));
            }
            if let Some(category) = entry.get("category") {
                fields.push(format!("\"category\": {category}"));
            }
            let rows = |name: &str| entry[name].as_array().map_or(&[][..], Vec::as_slice);
            fields.push(format!("\"required\": {}", list(rows("required"))));
            if !rows("optional").is_empty() {
                fields.push(format!("\"optional\": {}", list(rows("optional"))));
            }
            let body: Vec<String> = fields.iter().map(|f| format!("    {f}")).collect();
            format!(
                "  {}: {{\n{}\n  }}",
                Value::from(symbol.as_str()),
                body.join(",\n")
            )
        })
        .collect();
    format!("{{\n{}\n}}\n", blocks.join(",\n"))
}

fn entry_json(target: &str, lines: &[i64], category: Option<&Value>, derived: Derived) -> Value {
    let mut entry = serde_json::json!({ "target": target });
    if !lines.is_empty() {
        entry["target_lines"] = Value::from(lines.to_vec());
    }
    if let Some(category) = category {
        entry["category"] = category.clone();
    }
    entry["required"] = Value::from(derived.required);
    if !derived.optional.is_empty() {
        entry["optional"] = Value::from(derived.optional);
    }
    entry
}

type Existing = (Vec<(String, Entry)>, serde_json::Map<String, Value>);

/// The truth file's symbols, parsed and raw (for fields the scorer does not read), or none with
/// `--pick`, which refuses to replace a repository's truth.
fn existing(opts: &TruthOptions, file: &Path) -> Result<Existing, String> {
    if opts.pick.is_some() {
        if file.exists() {
            return Err(format!(
                "{} exists; --pick only starts a new repository's truth",
                file.display()
            ));
        }
        return Ok((Vec::new(), serde_json::Map::new()));
    }
    let parsed = read_truth(&opts.bench, &opts.repo.name)?;
    let raw = serde_json::from_str(&fs::read_to_string(file).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok((parsed, raw))
}

/// Derives the truth and writes `truth/<repo>.json`; returns a summary for the terminal.
pub fn run(opts: &TruthOptions) -> Result<String, String> {
    let language = Language::parse(&opts.repo.language)?;
    let file = opts
        .bench
        .join("truth")
        .join(format!("{}.json", opts.repo.name));
    let (existing, raw) = existing(opts, &file)?;
    let (copy, root) = fresh_copy(&opts.work, &opts.repo)?;
    let log = opts
        .work
        .join(format!("lsp-truth-{}.stderr", opts.repo.name));
    let (server, info) = Server::start(&opts.server, &root, &log)?;
    let mut deriver = Deriver {
        session: Session {
            server,
            root: &root,
            root_text: root.to_string_lossy().replace('\\', "/"),
            symbols: HashMap::new(),
            open: HashSet::new(),
            outside: 0,
        },
        language,
        rules: opts.repo.rules,
        texts: HashMap::new(),
    };
    open_files(&mut deriver.session, language, &existing)?;
    deriver.session.server.wait_ready(READY_LIMIT)?;
    let server: Vec<_> = opts.server.iter().map(|a| a.to_string_lossy()).collect();
    let (name, sha) = (&opts.repo.name, &opts.repo.sha);
    let mut report = format!(
        "lsp-truth {name} at {sha} with `{}` ({info})\n",
        server.join(" ")
    );
    let result = derive_all(&mut deriver, opts, &existing, &raw, &mut report);
    let outside = deriver.session.outside;
    deriver.session.server.stop();
    remove(&copy)?;
    let entries = result?;
    fs::create_dir_all(opts.bench.join("truth"))
        .and_then(|()| fs::write(&file, format_truth(&entries)))
        .map_err(|e| format!("cannot write {}: {e}", file.display()))?;
    report += &format!(
        "{} references outside the checkout were left out. Wrote {}.\n",
        outside,
        file.display()
    );
    Ok(report)
}

fn derive_all(
    deriver: &mut Deriver,
    opts: &TruthOptions,
    existing: &[(String, Entry)],
    raw: &serde_json::Map<String, Value>,
    report: &mut String,
) -> Result<Vec<(String, Value)>, String> {
    let mut entries = Vec::new();
    if let Some(count) = opts.pick {
        let (picked, tried) = pick(deriver, count, opts.seed)?;
        if picked.len() < count {
            return Err(format!(
                "only {} of {count} candidates had {} to {} calls, after deriving {tried}; is the server loading the code?",
                picked.len(),
                PICK_CALLS.0,
                PICK_CALLS.1
            ));
        }
        *report += &format!(
            "Picked {} of {count} with seed {} after deriving {tried} candidates.\n",
            picked.len(),
            opts.seed
        );
        for p in picked {
            *report += &format!(
                "{} {}:{} {} calls\n",
                p.symbol, p.target, p.line, p.derived.calls
            );
            entries.push((p.symbol, entry_json(&p.target, &[p.line], None, p.derived)));
        }
        return Ok(entries);
    }
    let span_rules = opts.repo.rules == Rules::Span;
    for (symbol, entry) in existing {
        let scopes = deriver.session.scopes(&entry.target)?.to_vec();
        let found = targets(&scopes, symbol, entry, span_rules);
        let [(scope, _)] = found.as_slice() else {
            return Err(format!(
                "{symbol}: {} definitions in {} match its target",
                found.len(),
                entry.target
            ));
        };
        let derived = deriver.derive(&entry.target, &scope.selection)?;
        *report += &format!("{symbol} {} calls\n", derived.calls);
        let category = raw.get(symbol).and_then(|e| e.get("category"));
        entries.push((
            symbol.clone(),
            entry_json(&entry.target, &entry.target_lines, category, derived),
        ));
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_layout_matches_tsc_truth() {
        let entry = entry_json(
            "a.py",
            &[2],
            None,
            Derived {
                required: vec![
                    serde_json::json!({ "file": "b.py", "chain": "<file>", "lines": [1] }),
                ],
                optional: Vec::new(),
                calls: 1,
            },
        );
        assert_eq!(
            format_truth(&[("run".to_owned(), entry)]),
            "{\n  \"run\": {\n    \"target\": \"a.py\",\n    \"target_lines\": [2],\n    \"required\": [\n      {\"file\":\"b.py\",\"chain\":\"<file>\",\"lines\":[1]}\n    ]\n  }\n}\n"
        );
    }
}
