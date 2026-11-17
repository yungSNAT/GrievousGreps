//! `lsp-truth`: derives a repository's caller truth from a language server's references, as
//! `benchmark/tsc-truth.mjs` derives it from the TypeScript compiler. With `pick` it first chooses
//! the symbols by a fixed rule and seed, so a new repository's truth can be committed before any
//! tool is built on it.
//!
//! A required row is a call: a reference followed by `(`, after any generic arguments, or used as
//! a decorator, JSX element or tagged template. Calls are grouped by file and by the named
//! definition around them, or by file at module level. Any other reference inside a named
//! definition is an optional row; one at module level, such as an import, gets no row.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::lsp::{
    READY_LIMIT, Server, Session, clean_scope, enclosing, fresh_copy, go_receiver, path_to_uri,
    position, relative, targets, uri_to_path,
};
use crate::run::{read_truth, remove};
use crate::score::{Entry, Repo, Rules};

pub struct TruthOptions {
    pub bench: PathBuf,
    pub repo: Repo,
    pub work: PathBuf,
    pub server: Vec<OsString>,
    /// Choose this many symbols first, instead of reading them from the truth file.
    pub pick: Option<usize>,
    pub seed: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    Python,
    TypeScript,
    Rust,
    Go,
    CSharp,
}

impl Language {
    pub fn parse(name: &str) -> Result<Self, String> {
        Ok(match name {
            "Python" => Self::Python,
            "TypeScript" => Self::TypeScript,
            "Rust" => Self::Rust,
            "Go" => Self::Go,
            "C#" => Self::CSharp,
            _ => return Err(format!("lsp-truth does not read {name} repositories")),
        })
    }

    fn source(self, file: &str) -> bool {
        match self {
            Self::Python => file.ends_with(".py"),
            Self::TypeScript => {
                [".ts", ".tsx", ".mts", ".cts"]
                    .iter()
                    .any(|e| file.ends_with(e))
                    && ![".d.ts", ".d.mts", ".d.cts"].iter().any(|e| file.ends_with(e))
            }
            Self::Rust => file.ends_with(".rs"),
            Self::Go => file.ends_with(".go"),
            Self::CSharp => file.ends_with(".cs"),
        }
    }
}

/// Folders whose files are never picked from: tests, examples, benchmarks, documentation and
/// vendored or built code. Their calls still count as truth rows.
const NOT_PICKED: [&str; 19] = [
    "test",
    "tests",
    "testing",
    "__tests__",
    "testdata",
    "fixtures",
    "example",
    "examples",
    "bench",
    "benches",
    "benchmark",
    "benchmarks",
    "doc",
    "docs",
    "vendor",
    "node_modules",
    "target",
    "dist",
    "build",
];

/// Whether a file's definitions may be picked: a source file of the language, outside test,
/// example and generated folders, and not itself a test file.
pub fn pickable(language: Language, path: &str) -> bool {
    let mut parts: Vec<&str> = path.split('/').collect();
    let file = parts.pop().unwrap_or_default();
    let folder_ok = parts.iter().all(|d| {
        let lower = d.to_lowercase();
        !d.starts_with('.') && !NOT_PICKED.contains(&lower.as_str()) && !d.ends_with("Tests")
    });
    let test_file = file.starts_with("test_")
        || file.contains(".test.")
        || file.contains(".spec.")
        || file.ends_with("_test.py")
        || file.ends_with("_test.go")
        || file.ends_with("Tests.cs")
        || file.ends_with("Test.cs");
    folder_ok && !test_file && language.source(file)
}

/// The text after a balanced bracket that `text` starts with, or none when it does not close.
fn after_brackets(text: &str, open: char, close: char) -> Option<&str> {
    let mut depth = 0;
    for (at, c) in text.char_indices() {
        if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return Some(&text[at + c.len_utf8()..]);
            }
        }
    }
    None
}

/// Whether the reference between byte offsets `start` and `end` of `line` is called.
///
/// shortcut: one line is read, so a call whose `(` starts the next line counts as a reference,
/// not a call; tsc-truth.mjs, which reads the syntax tree, is the upgrade for TypeScript.
pub fn is_call(language: Language, line: &str, start: usize, end: usize) -> bool {
    let mut after = line[end..].trim_start();
    let generic = match language {
        Language::Rust => after.strip_prefix("::").filter(|r| r.starts_with('<')),
        Language::Go if after.starts_with('[') => Some(after),
        Language::TypeScript | Language::CSharp if after.starts_with('<') => Some(after),
        _ => None,
    };
    if let Some(rest) = generic {
        let (open, close) = if language == Language::Go {
            ('[', ']')
        } else {
            ('<', '>')
        };
        match after_brackets(rest, open, close) {
            Some(rest) => after = rest.trim_start(),
            None => return false,
        }
    }
    if after.starts_with('(') || (language == Language::TypeScript && after.starts_with('`')) {
        return true;
    }
    let before = &line[..start];
    let decorator = before
        .trim_end_matches(|c: char| c.is_alphanumeric() || c == '_' || c == '.')
        .ends_with('@');
    let tag = before.trim_end_matches(|c: char| c.is_alphanumeric() || c == '_' || c == '.');
    let jsx = language == Language::TypeScript && tag.ends_with('<') && !tag.ends_with("</");
    (decorator && matches!(language, Language::Python | Language::TypeScript)) || jsx
}

/// The byte offset of a UTF-16 column, as LSP counts characters.
fn byte_at(line: &str, column: u64) -> usize {
    let mut units = 0;
    for (at, c) in line.char_indices() {
        if units >= column {
            return at;
        }
        units += c.len_utf16() as u64;
    }
    line.len()
}

/// A shuffle that every platform repeats for a seed: Fisher-Yates driven by SplitMix64.
pub fn shuffle<T>(items: &mut [T], seed: u64) {
    let mut state = seed;
    let mut next = || {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    };
    for i in (1..items.len()).rev() {
        let j = (next() % (i as u64 + 1)) as usize;
        items.swap(i, j);
    }
}

/// Rows for one group of references: a file and the named definition around them.
struct Group {
    file: String,
    names: Option<Vec<String>>,
    lines: BTreeSet<i64>,
}

fn rows(groups: BTreeMap<String, Group>, rules: Rules) -> Vec<Value> {
    let mut rows: Vec<(String, i64, Value)> = groups
        .into_values()
        .map(|g| {
            let lines: Vec<i64> = g.lines.iter().copied().collect();
            let chain = match g.names {
                None => Value::from("<file>"),
                Some(names) if rules == Rules::Span => Value::from(names.join("::")),
                Some(names) => Value::from(vec![names.last().cloned().unwrap_or_default()]),
            };
            let first = lines.first().copied().unwrap_or_default();
            let row = serde_json::json!({ "file": g.file, "chain": chain, "lines": lines });
            (g.file, first, row)
        })
        .collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    rows.into_iter().map(|(_, _, row)| row).collect()
}

/// One symbol's derived rows, and how many calls they hold.
pub struct Derived {
    pub required: Vec<Value>,
    pub optional: Vec<Value>,
    pub calls: usize,
}

struct Deriver<'a> {
    session: Session<'a>,
    language: Language,
    rules: Rules,
    texts: HashMap<String, Vec<String>>,
}

impl Deriver<'_> {
    fn line(&mut self, path: &str, line: u64) -> Result<String, String> {
        if !self.texts.contains_key(path) {
            let text = fs::read_to_string(self.session.root.join(path))
                .map_err(|e| format!("cannot read {path}: {e}"))?;
            self.texts
                .insert(path.to_owned(), text.lines().map(str::to_owned).collect());
        }
        Ok(self.texts[path]
            .get(line as usize)
            .cloned()
            .unwrap_or_default())
    }

    /// The references to the definition named at `at` in `target`, opening the file for the
    /// request when it is not open already.
    fn references(&mut self, target: &str, at: &Value) -> Result<Vec<(String, Value)>, String> {
        let opened = self.session.open.insert(target.to_owned());
        if opened {
            self.session.server.open(self.session.root, target)?;
        }
        let uri = path_to_uri(&self.session.root.join(target));
        let found = self.session.references(&uri, at);
        if opened {
            self.session.server.close(self.session.root, target)?;
            self.session.open.remove(target);
        }
        found
    }

    /// The named definitions around a position, outermost first: as the column maps a reference,
    /// except that a value at any depth counts when, and only when, its line assigns a function.
    fn named_chain(&mut self, path: &str, at: (u64, u64)) -> Result<Vec<usize>, String> {
        let around: Vec<(usize, u64, u64)> = {
            let scopes = self.session.scopes(path)?;
            enclosing(scopes, at)
                .into_iter()
                .map(|i| (i, scopes[i].kind, scopes[i].start.0))
                .collect()
        };
        let mut chain = Vec::new();
        for (index, kind, line) in around {
            if !crate::lsp::LOCAL.contains(&kind) || function_holder(&self.line(path, line)?) {
                chain.push(index);
            }
        }
        Ok(chain)
    }

    /// One reference: whether it is a call, its group key, file, enclosing names and line. None
    /// for a reference outside the checkout or a module-level reference that is not a call.
    fn classify(
        &mut self,
        uri: &str,
        range: &Value,
    ) -> Result<Option<(bool, String, Group)>, String> {
        let Some(path) = uri_to_path(uri).and_then(|p| relative(&self.session.root_text, &p))
        else {
            self.session.outside += 1;
            return Ok(None);
        };
        if path.split('/').any(|part| part == "node_modules") {
            return Ok(None);
        }
        let (start, end) = (position(&range["start"]), position(&range["end"]));
        let text = self.line(&path, start.0)?;
        let call = start.0 == end.0
            && is_call(
                self.language,
                &text,
                byte_at(&text, start.1),
                byte_at(&text, end.1),
            );
        let chain = self.named_chain(&path, start)?;
        let scopes = &self.session.symbols[&path];
        if !call && chain.is_empty() {
            return Ok(None);
        }
        let key = match chain.last() {
            Some(&inner) => format!("{path}#{:?}", scopes[inner].start),
            None => format!("{path}#file"),
        };
        let names = (!chain.is_empty()).then(|| {
            chain
                .iter()
                .map(|&i| clean_scope(&scopes[i].name))
                .collect()
        });
        let lines = BTreeSet::from([start.0 as i64 + 1]);
        Ok(Some((
            call,
            key,
            Group {
                file: path,
                names,
                lines,
            },
        )))
    }

    /// Classifies every reference to the definition named at `at` in `target`.
    fn derive(&mut self, target: &str, at: &Value) -> Result<Derived, String> {
        let (mut calls, mut others) = (BTreeMap::new(), BTreeMap::new());
        for (uri, range) in self.references(target, at)? {
            let Some((call, key, group)) = self.classify(&uri, &range)? else {
                continue;
            };
            let into: &mut BTreeMap<String, Group> = if call { &mut calls } else { &mut others };
            match into.get_mut(&key) {
                Some(existing) => existing.lines.extend(group.lines),
                None => {
                    into.insert(key, group);
                }
            }
        }
        for key in calls.keys() {
            others.remove(key);
        }
        let count = calls.values().map(|g| g.lines.len()).sum();
        Ok(Derived {
            required: rows(calls, self.rules),
            optional: rows(others, self.rules),
            calls: count,
        })
    }
}

/// Every file under `dir`, relative and with `/` separators, skipping `.git` and `node_modules`.
fn files(dir: &Path, prefix: &str, out: &mut Vec<String>) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .and_then(Iterator::collect)
        .map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = format!("{prefix}{name}");
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() && name != ".git" && name != "node_modules" {
            files(&entry.path(), &format!("{path}/"), out)?;
        } else if kind.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

/// Opens the target files and, for TypeScript, every source file outside `dist` and `coverage`, as
/// tsc-truth.mjs reads them all: the TypeScript server searches only the projects of open files,
/// and a tsconfig's `files` or `include` can leave the tests out of the targets' project.
fn open_files(
    session: &mut Session,
    language: Language,
    existing: &[(String, Entry)],
) -> Result<(), String> {
    let mut paths: Vec<String> = existing.iter().map(|(_, e)| e.target.clone()).collect();
    if language == Language::TypeScript {
        let mut all = Vec::new();
        files(session.root, "", &mut all)?;
        let built = |path: &str| path.split('/').any(|p| p == "dist" || p == "coverage");
        paths.extend(
            all.into_iter()
                .filter(|path| language.source(path) && !built(path)),
        );
    }
    for path in paths {
        if session.open.insert(path.clone()) {
            session.server.open(session.root, &path)?;
        }
    }
    Ok(())
}

/// Whether a value's first line gives it a function, as `let has = (` or `f = lambda x:`. Such a
/// value names the calls inside it, as tsc-truth.mjs names an arrow function by its variable.
///
/// shortcut: one line is read, so a holder whose function starts on the next line is missed.
pub fn function_holder(line: &str) -> bool {
    let Some((_, value)) = line.split_once('=') else {
        return false;
    };
    if value.starts_with(['=', '>']) {
        return false;
    }
    let value = value.trim();
    let bare_parameter = value.split_once("=>").is_some_and(|(p, _)| {
        !p.trim().is_empty() && p.trim().chars().all(|c| c.is_alphanumeric() || c == '_')
    });
    let keyword = ["async", "function", "lambda", "func"].iter().any(|word| {
        value
            .strip_prefix(word)
            .is_some_and(|rest| !rest.starts_with(|c: char| c.is_alphanumeric() || c == '_'))
    });
    keyword
        || value.starts_with('|')
        || value.starts_with("move |")
        || (value.starts_with('(') && (value.contains("=>") || value == "("))
        || bare_parameter
}

/// The minimum and maximum calls a picked symbol may have.
pub const PICK_CALLS: (usize, usize) = (3, 300);

fn identifier(name: &str) -> bool {
    name.len() >= 3
        && name.chars().all(|c| c.is_alphanumeric() || c == '_')
        && !(name.starts_with("__") && name.ends_with("__"))
}

struct Picked {
    symbol: String,
    target: String,
    line: i64,
    derived: Derived,
}

/// Functions and methods (LSP kinds 12 and 6) in pickable files, in a seeded order, kept while
/// their calls fall within `PICK_CALLS` until `count` are chosen. A name already chosen is
/// qualified with its owner, and skipped if that is taken too.
fn pick(deriver: &mut Deriver, count: usize, seed: u64) -> Result<(Vec<Picked>, usize), String> {
    let mut all = Vec::new();
    files(deriver.session.root, "", &mut all)?;
    let mut candidates: Vec<(String, String, Value, Option<String>)> = Vec::new();
    for path in all.into_iter().filter(|p| pickable(deriver.language, p)) {
        let scopes = deriver.session.scopes(&path)?.to_vec();
        for scope in &scopes {
            let name = clean_scope(&scope.name);
            if [6, 12].contains(&scope.kind) && identifier(&name) {
                let owner = go_receiver(&scope.name)
                    .or_else(|| scope.parent.map(|p| clean_scope(&scopes[p].name)));
                candidates.push((path.clone(), name, scope.selection.clone(), owner));
            }
        }
    }
    shuffle(&mut candidates, seed);
    let (mut chosen, mut keys, mut tried) = (Vec::new(), HashSet::new(), 0);
    for (path, name, selection, owner) in candidates {
        if chosen.len() == count {
            break;
        }
        let key = if keys.contains(&name) {
            match owner {
                Some(owner) if identifier(&owner) => format!("{owner}.{name}"),
                _ => continue,
            }
        } else {
            name
        };
        if keys.contains(&key) {
            continue;
        }
        tried += 1;
        let derived = deriver.derive(&path, &selection)?;
        if (PICK_CALLS.0..=PICK_CALLS.1).contains(&derived.calls) {
            keys.insert(key.clone());
            let line = position(&selection).0 as i64 + 1;
            chosen.push(Picked {
                symbol: key,
                target: path,
                line,
                derived,
            });
        }
    }
    Ok((chosen, tried))
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
            let rows = |name: &str| entry[name].as_array().cloned().unwrap_or_default();
            fields.push(format!("\"required\": {}", list(&rows("required"))));
            if !rows("optional").is_empty() {
                fields.push(format!("\"optional\": {}", list(&rows("optional"))));
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

    fn call(language: Language, line: &str, name: &str) -> bool {
        let start = line.find(name).unwrap();
        is_call(language, line, start, start + name.len())
    }

    #[test]
    fn calls_are_told_from_other_references() {
        assert!(call(Language::Python, "    x = lib.run(1)", "run"));
        assert!(call(
            Language::Python,
            "@attr.resolve_types",
            "resolve_types"
        ));
        assert!(!call(Language::Python, "from lib import run", "run"));
        assert!(!call(Language::Python, "    pool.map(run, xs)", "run"));
        assert!(call(
            Language::Rust,
            "let (tx, rx) = mpsc::channel::<()>(1);",
            "channel"
        ));
        assert!(!call(
            Language::Rust,
            "use tokio::sync::mpsc::channel;",
            "channel"
        ));
        assert!(call(Language::Go, "v := Max[int] (a, b)", "Max"));
        assert!(call(Language::CSharp, "var x = Parse<int>(text);", "Parse"));
        assert!(call(
            Language::TypeScript,
            "return <Presence present>",
            "Presence"
        ));
        assert!(!call(Language::TypeScript, "</Presence>", "Presence"));
        assert!(call(Language::TypeScript, "<UI.Button size={2} />", "Button"));
        assert!(!call(Language::TypeScript, "</UI.Button>", "Button"));
        assert!(call(Language::TypeScript, "const q = sql`select`", "sql"));
        assert!(!call(Language::Go, "f := Max", "Max"));
    }

    #[test]
    fn values_holding_functions_name_their_calls() {
        assert!(function_holder("export let has = ("));
        assert!(function_holder("const f = (a, b) => a + b"));
        assert!(function_holder("const g = async (x) => {"));
        assert!(function_holder("const h = x => x"));
        assert!(function_holder("handler = lambda event: run(event)"));
        assert!(function_holder("let add = |a, b| a + b;"));
        assert!(function_holder("\tf := func(x int) int {"));
        assert!(!function_holder("x = lib.run()"));
        assert!(!function_holder("const total = (a + b) * 2"));
        assert!(!function_holder("if a == b {"));
        assert!(!function_holder("items.map(x => x)"));
        assert!(!function_holder("const data = asyncFetch(url)"));
        assert!(!function_holder("f = functools.partial(run, 1)"));
    }

    #[test]
    fn go_receivers_give_the_owner() {
        assert_eq!(
            go_receiver("(*Logger).WithFields").as_deref(),
            Some("Logger")
        );
        assert_eq!(go_receiver("(List[T]).Len").as_deref(), Some("List"));
        assert_eq!(go_receiver("WithFields"), None);
    }

    #[test]
    fn columns_count_utf16_units() {
        assert_eq!(byte_at("é𝄞x", 3), "é𝄞".len());
        assert_eq!(byte_at("ab", 9), 2);
    }

    #[test]
    fn the_shuffle_repeats_for_a_seed() {
        let mut a: Vec<u32> = (0..20).collect();
        let mut b = a.clone();
        shuffle(&mut a, 2026);
        shuffle(&mut b, 2026);
        assert_eq!(a, b);
        assert_ne!(a, (0..20).collect::<Vec<_>>());
        let mut c: Vec<u32> = (0..20).collect();
        shuffle(&mut c, 2027);
        assert_ne!(a, c);
    }

    #[test]
    fn tests_examples_and_generated_files_are_not_picked() {
        assert!(pickable(Language::Python, "src/marshmallow/fields.py"));
        assert!(!pickable(Language::Python, "tests/test_fields.py"));
        assert!(!pickable(Language::Python, "src/pkg/test_x.py"));
        assert!(!pickable(Language::Go, "hooks/syslog/syslog_test.go"));
        assert!(pickable(Language::Go, "entry.go"));
        assert!(!pickable(
            Language::CSharp,
            "test/Serilog.Tests/LoggerTests.cs"
        ));
        assert!(!pickable(Language::TypeScript, "src/types.d.ts"));
        assert!(!pickable(Language::TypeScript, "src/types.d.mts"));
        assert!(!pickable(Language::Rust, "benches/bench.rs"));
        assert!(!pickable(Language::Rust, ".github/x.rs"));
    }

    #[test]
    fn rows_follow_the_rules_and_sort_by_file_and_line() {
        let mut groups = BTreeMap::new();
        groups.insert(
            "b#1".to_owned(),
            Group {
                file: "b.py".into(),
                names: Some(vec!["A".into(), "f".into()]),
                lines: [9, 3].into(),
            },
        );
        groups.insert(
            "a#file".to_owned(),
            Group {
                file: "a.py".into(),
                names: None,
                lines: [5].into(),
            },
        );
        let span = rows(groups, Rules::Span);
        assert_eq!(
            span,
            vec![
                serde_json::json!({ "file": "a.py", "chain": "<file>", "lines": [5] }),
                serde_json::json!({ "file": "b.py", "chain": "A::f", "lines": [3, 9] }),
            ]
        );
    }

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
