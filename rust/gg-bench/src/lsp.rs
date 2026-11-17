//! The language-server column: starts a language server in a copy of each pinned repository, asks
//! it for the callers of each truth symbol through call hierarchy or references, and scores the
//! answers with the rules `run` uses. A server gives locations, not callers, so each location is
//! named by the innermost definition around it in the server's own document symbols.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::{Map, Value, json};

mod scope;
mod server;

use scope::csharp_name;
pub(crate) use scope::{LOCAL, enclosing, go_receiver, position};
pub use scope::{Scope, caller_chain, clean_scope, flatten, targets};
pub use server::{Server, path_to_uri, read_frame, relative, uri_to_path};

use crate::run::{copy_tree, fetch_repo, read_truth, remove, under, utc_date};
use crate::score::{
    Entry, Repo, Summaries, SymbolScore, detail_table, overall_line, score_symbol, summarise,
};

/// How long a server may take to load a repository, and to answer one request.
pub(crate) const READY_LIMIT: Duration = Duration::from_secs(25 * 60);
pub(crate) const REQUEST_LIMIT: Duration = Duration::from_secs(20 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum Ask {
    /// `textDocument/prepareCallHierarchy`, then `callHierarchy/incomingCalls`.
    Calls,
    /// `textDocument/references`, without the declaration.
    References,
}

pub struct LspOptions {
    pub bench: PathBuf,
    pub repos: Vec<Repo>,
    pub work: PathBuf,
    pub server: Vec<OsString>,
    pub ask: Ask,
    pub verbose: bool,
}

/// One repository's server session: its checkout copy, the symbols read so far and the files
/// held open.
pub(crate) struct Session<'a> {
    pub(crate) server: Server,
    pub(crate) root: &'a Path,
    pub(crate) root_text: String,
    pub(crate) symbols: HashMap<String, Vec<Scope>>,
    pub(crate) open: HashSet<String>,
    pub(crate) outside: usize,
}

impl Session<'_> {
    /// A file's flattened symbols, opening it for the request when it is not open already.
    pub(crate) fn scopes(&mut self, path: &str) -> Result<&[Scope], String> {
        if !self.symbols.contains_key(path) {
            let opened = self.open.insert(path.to_owned());
            if opened {
                self.server.open(self.root, path)?;
            }
            let uri = path_to_uri(&self.root.join(path));
            let answer = self.server.request(
                "textDocument/documentSymbol",
                json!({ "textDocument": { "uri": uri } }),
                REQUEST_LIMIT,
            )?;
            if opened {
                self.server.close(self.root, path)?;
                self.open.remove(path);
            }
            let mut scopes = flatten(&answer)?;
            if path.ends_with(".cs") {
                for scope in &mut scopes {
                    scope.name = csharp_name(&scope.name);
                }
            }
            self.symbols.insert(path.to_owned(), scopes);
        }
        Ok(&self.symbols[path])
    }

    /// The references to the definition at `at`, without the declaration: (uri, range) pairs.
    pub(crate) fn references(
        &mut self,
        uri: &str,
        at: &Value,
    ) -> Result<Vec<(String, Value)>, String> {
        let params = json!({
            "textDocument": { "uri": uri },
            "position": at,
            "context": { "includeDeclaration": false },
        });
        let found = self
            .server
            .request("textDocument/references", params, REQUEST_LIMIT)?;
        Ok(found
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|l| {
                (
                    l["uri"].as_str().unwrap_or_default().to_owned(),
                    l["range"].clone(),
                )
            })
            .collect())
    }

    /// The locations the server gives for one definition: (uri, position) pairs.
    fn locations(
        &mut self,
        uri: &str,
        at: &Value,
        ask: Ask,
    ) -> Result<Vec<(String, Value)>, String> {
        if ask == Ask::References {
            let found = self.references(uri, at)?;
            return Ok(found
                .into_iter()
                .map(|(uri, range)| (uri, range["start"].clone()))
                .collect());
        }
        let doc = json!({ "textDocument": { "uri": uri }, "position": at });
        let mut out = Vec::new();
        let items = self
            .server
            .request("textDocument/prepareCallHierarchy", doc, REQUEST_LIMIT)?;
        for item in items.as_array().map_or(&[][..], Vec::as_slice) {
            let calls = self.server.request(
                "callHierarchy/incomingCalls",
                json!({ "item": item }),
                REQUEST_LIMIT,
            )?;
            for call in calls.as_array().map_or(&[][..], Vec::as_slice) {
                let from = call["from"]["uri"].as_str().unwrap_or_default().to_owned();
                let ranges = call["fromRanges"].as_array().map_or(&[][..], Vec::as_slice);
                if ranges.is_empty() {
                    out.push((
                        from.clone(),
                        call["from"]["selectionRange"]["start"].clone(),
                    ));
                }
                for range in ranges {
                    out.push((from.clone(), range["start"].clone()));
                }
            }
        }
        Ok(out)
    }

    /// Hits in `callers --json` shape: one per calling definition, spanning its calls' lines, or
    /// one per file for module-level calls.
    fn hits(&mut self, locations: Vec<(String, Value)>) -> Result<Vec<Value>, String> {
        let mut grouped: BTreeMap<String, (String, Option<String>, i64, i64)> = BTreeMap::new();
        for (uri, at) in locations {
            let Some(path) = uri_to_path(&uri).and_then(|p| relative(&self.root_text, &p)) else {
                self.outside += 1;
                continue;
            };
            let at = position(&at);
            let line = at.0 as i64 + 1;
            let scopes = self.scopes(&path)?;
            let chain = caller_chain(scopes, at);
            let (id, name) = match chain.last() {
                None => (path.clone(), None),
                Some(&inner) => {
                    let names: Vec<String> = chain
                        .iter()
                        .map(|&i| clean_scope(&scopes[i].name))
                        .collect();
                    (
                        format!("{path}#{}~{}", names.join("."), scopes[inner].start.0 + 1),
                        names.last().cloned(),
                    )
                }
            };
            let entry = grouped.entry(id).or_insert((path, name, line, line));
            entry.2 = entry.2.min(line);
            entry.3 = entry.3.max(line);
        }
        Ok(grouped
            .into_iter()
            .map(|(id, (path, name, low, high))| json!({ "id": id, "name": name, "path": path, "span": format!("L{low}-L{high}") }))
            .collect())
    }

    fn answer(
        &mut self,
        symbol: &str,
        entry: &Entry,
        ask: Ask,
        span_rules: bool,
    ) -> Result<Value, String> {
        let uri = path_to_uri(&self.root.join(&entry.target));
        let chosen: Vec<(Value, String)> =
            targets(self.scopes(&entry.target)?, symbol, entry, span_rules)
                .into_iter()
                .map(|(scope, span)| (scope.selection.clone(), span))
                .collect();
        let mut matches = Vec::new();
        for (at, span) in chosen {
            let locations = self.locations(&uri, &at, ask)?;
            let hits = self.hits(locations)?;
            matches.push(json!({ "symbol": { "path": entry.target, "span": span }, "hits": hits }));
        }
        Ok(json!({ "query": symbol, "matches": matches }))
    }
}

fn label(ask: Ask) -> &'static str {
    match ask {
        Ask::Calls => "calls",
        Ask::References => "references",
    }
}

fn verbose_line(repo: &str, symbol: &str, score: &SymbolScore) {
    let misses: Vec<String> = score
        .missed
        .iter()
        .take(10)
        .map(|row| format!("{}:{}", row.file, row.chain))
        .collect();
    eprintln!(
        "lsp {repo} {symbol}: {}/{} {} {}",
        score.found,
        score.required,
        score.undercount,
        misses.join(" ")
    );
}

/// A fresh copy of the pinned checkout, and the path the server is given: on Unix with links
/// resolved, as servers report locations by their real path.
pub(crate) fn fresh_copy(work: &Path, repo: &Repo) -> Result<(PathBuf, PathBuf), String> {
    let source = fetch_repo(repo, work)?;
    let copy = under(work, &["run", "lsp", &repo.name]);
    remove(&copy)?;
    copy_tree(&source, &copy).map_err(|e| format!("cannot copy {}: {e}", source.display()))?;
    let root = if cfg!(unix) {
        fs::canonicalize(&copy).map_err(|e| e.to_string())?
    } else {
        copy.clone()
    };
    Ok((copy, root))
}

/// One repository: copy the checkout, start the server, open the target files, wait for it to
/// load, then ask for each symbol. The answers are kept beside the report for `gg-bench score`.
fn score_repo(
    opts: &LspOptions,
    repo: &Repo,
    info: &mut Value,
) -> Result<(crate::score::Summary, usize), String> {
    let truth = read_truth(&opts.bench, &repo.name)?;
    let (copy, root) = fresh_copy(&opts.work, repo)?;
    let out = under(&opts.work, &["lsp", label(opts.ask)]);
    fs::create_dir_all(&out).map_err(|e| format!("cannot create {}: {e}", out.display()))?;
    let (server, server_info) = Server::start(
        &opts.server,
        &root,
        &out.join(format!("{}.stderr", repo.name)),
    )?;
    *info = server_info;
    let mut session = Session {
        server,
        root: &root,
        root_text: root.to_string_lossy().replace('\\', "/"),
        symbols: HashMap::new(),
        open: HashSet::new(),
        outside: 0,
    };
    for (_, entry) in &truth {
        if session.open.insert(entry.target.clone()) {
            session.server.open(&root, &entry.target)?;
        }
    }
    session.server.wait_ready(READY_LIMIT)?;
    let span_rules = repo.rules == crate::score::Rules::Span;
    let (mut answers, mut scores) = (Map::new(), Vec::new());
    for (symbol, entry) in &truth {
        let answer = session.answer(symbol, entry, opts.ask, span_rules)?;
        let score = score_symbol(entry, &answer, repo.rules)
            .map_err(|e| format!("{} {symbol}: {e}", repo.name))?;
        if opts.verbose {
            verbose_line(&repo.name, symbol, &score);
        }
        scores.push(score);
        answers.insert(symbol.clone(), answer);
    }
    let outside = session.outside;
    session.server.stop();
    let file = out.join(format!("{}.json", repo.name));
    fs::write(&file, format!("{:#}\n", Value::Object(answers)))
        .map_err(|e| format!("cannot write {}: {e}", file.display()))?;
    remove(&copy)?;
    Ok((summarise(&scores), outside))
}

/// Scores every repository with the server and returns the report.
pub fn run(opts: &LspOptions) -> Result<String, String> {
    let (mut summaries, mut info, mut outside) = (Summaries::new(), Value::Null, 0);
    for repo in &opts.repos {
        let (summary, left_out) = score_repo(opts, repo, &mut info)?;
        summaries.insert(repo.name.clone(), summary);
        outside += left_out;
    }
    let server: Vec<String> = opts
        .server
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let in_order: Vec<_> = opts
        .repos
        .iter()
        .map(|repo| summaries[&repo.name].clone())
        .collect();
    // serverInfo is optional in the protocol, and pyright sends none.
    let named: Vec<&str> = [&info["name"], &info["version"]]
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    let named = if named.is_empty() {
        String::new()
    } else {
        format!(" ({})", named.join(" "))
    };
    let mut report = format!(
        "Server: `{}`{named}, asked for {}, {} UTC\n\n",
        server.join(" "),
        label(opts.ask),
        utc_date(SystemTime::now())
    );
    report += &overall_line(None, &in_order);
    if outside > 0 {
        report += &format!(" {outside} locations outside the checkout were left out.");
    }
    report += &format!(
        "\n\n{}\n",
        detail_table(&opts.repos, "Language server", &summaries)
    );
    Ok(report)
}
