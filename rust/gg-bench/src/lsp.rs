//! The language-server column: starts a language server in a copy of each pinned repository, asks
//! it for the callers of each truth symbol through call hierarchy or references, and scores the
//! answers with the rules `run` uses. A server gives locations, not callers, so each location is
//! named by the innermost definition around it in the server's own document symbols.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde_json::{Map, Value, json};

use crate::process::command;
use crate::run::{copy_tree, fetch_repo, read_truth, remove, under, utc_date};
use crate::score::{
    Entry, Repo, Summaries, SymbolScore, detail_table, overall_line, score_symbol, summarise,
};

/// How long a server may take to load a repository, and to answer one request.
pub(crate) const READY_LIMIT: Duration = Duration::from_secs(25 * 60);
pub(crate) const REQUEST_LIMIT: Duration = Duration::from_secs(20 * 60);
/// A server counts as ready once its progress has ended and it has been quiet this long.
const QUIET: Duration = Duration::from_secs(3);

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

/// A JSON-RPC connection to a language server over its standard streams.
pub struct Server {
    child: Child,
    stdin: ChildStdin,
    messages: Receiver<Value>,
    root_uri: String,
    next_id: i64,
    /// Work-done progress tokens begun and not yet ended.
    progress: HashSet<String>,
    /// rust-analyzer's `experimental/serverStatus`, once it has sent one.
    quiescent: Option<bool>,
}

/// Reads one `Content-Length` framed message, or none at the end of the stream.
pub fn read_frame(reader: &mut impl BufRead) -> Result<Option<Value>, String> {
    let mut length = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Ok(None);
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = Some(value.trim().parse::<usize>().map_err(|e| e.to_string())?);
        }
    }
    let length = length.ok_or("a message without Content-Length")?;
    let mut body = vec![0; length];
    reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// A `file:` URI for an absolute path, as LSP clients write them.
pub fn path_to_uri(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = if text.starts_with('/') {
        text
    } else {
        format!("/{text}")
    };
    let mut uri = String::from("file://");
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/:".contains(&byte) {
            uri.push(char::from(byte));
        } else {
            uri += &format!("%{byte:02X}");
        }
    }
    uri
}

/// The path a `file:` URI names, with `/` separators, or none for another scheme.
pub fn uri_to_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    let (bytes, mut out, mut at) = (rest.as_bytes(), Vec::new(), 0);
    while at < bytes.len() {
        let hex = (bytes[at] == b'%')
            .then(|| rest.get(at + 1..at + 3))
            .flatten()
            .and_then(|digits| u8::from_str_radix(digits, 16).ok());
        if let Some(byte) = hex {
            out.push(byte);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    let path = String::from_utf8_lossy(&out).into_owned();
    // `/c:/x` on Windows is the drive path `c:/x`.
    let drive = path.len() > 2 && path.as_bytes()[2] == b':' && path.starts_with('/');
    Some(if drive { path[1..].to_owned() } else { path })
}

/// A path relative to the checkout, or none outside it. Windows compares without case.
pub fn relative(root: &str, path: &str) -> Option<String> {
    let fold = |text: &str| {
        if cfg!(windows) {
            text.to_lowercase()
        } else {
            text.to_owned()
        }
    };
    let prefix = format!("{}/", root.trim_end_matches('/'));
    fold(path)
        .starts_with(&fold(&prefix))
        .then(|| path[prefix.len()..].to_owned())
}

fn language_id(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or_default() {
        "py" | "pyi" => "python",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "rs" => "rust",
        "go" => "go",
        "cs" => "csharp",
        _ => "plaintext",
    }
}

impl Server {
    /// Starts the server in `root` and completes the initialize handshake. Its stderr goes to `log`.
    pub fn start(server: &[OsString], root: &Path, log: &Path) -> Result<(Self, Value), String> {
        let (program, args) = server.split_first().ok_or("no server command")?;
        let stderr =
            File::create(log).map_err(|e| format!("cannot create {}: {e}", log.display()))?;
        let mut child = command(program)
            .args(args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr)
            .spawn()
            .map_err(|e| format!("cannot start {}: {e}", program.to_string_lossy()))?;
        let stdout = child.stdout.take().ok_or("no server stdout")?;
        let stdin = child.stdin.take().ok_or("no server stdin")?;
        let (send, messages) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Ok(Some(message)) = read_frame(&mut reader) {
                if send.send(message).is_err() {
                    break;
                }
            }
        });
        let mut server = Server {
            child,
            stdin,
            messages,
            root_uri: path_to_uri(root),
            next_id: 0,
            progress: HashSet::new(),
            quiescent: None,
        };
        let info = server.initialize(root)?;
        Ok((server, info))
    }

    fn initialize(&mut self, root: &Path) -> Result<Value, String> {
        let name = root.file_name().map(|n| n.to_string_lossy().into_owned());
        let params = json!({
            "processId": std::process::id(),
            "rootUri": self.root_uri,
            "rootPath": root.to_string_lossy(),
            "workspaceFolders": [{ "uri": self.root_uri, "name": name }],
            "capabilities": {
                "textDocument": {
                    "synchronization": {},
                    "documentSymbol": { "hierarchicalDocumentSymbolSupport": true },
                    "callHierarchy": {},
                    "references": {},
                },
                "window": { "workDoneProgress": true },
                "workspace": { "configuration": true, "workspaceFolders": true },
                "experimental": { "serverStatusNotification": true },
            },
        });
        let result = self.request("initialize", params, REQUEST_LIMIT)?;
        self.notify("initialized", json!({}))?;
        Ok(result.get("serverInfo").cloned().unwrap_or(Value::Null))
    }

    fn send(&mut self, message: &Value) -> Result<(), String> {
        let body = message.to_string();
        write!(self.stdin, "Content-Length: {}\r\n\r\n{body}", body.len())
            .and_then(|()| self.stdin.flush())
            .map_err(|e| format!("cannot write to the server: {e}"))
    }

    pub fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    /// The next message, or none once `wait` passes. A closed stream is an error.
    fn receive(&mut self, wait: Duration) -> Result<Option<Value>, String> {
        match self.messages.recv_timeout(wait) {
            Ok(message) => Ok(Some(message)),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => Err("the server closed its output".to_owned()),
        }
    }

    /// Answers a request from the server and records progress; returns a response to a request of ours.
    fn handle(&mut self, message: Value) -> Result<Option<Value>, String> {
        let method = message.get("method").and_then(Value::as_str);
        match (method, message.get("id")) {
            (None, Some(_)) => Ok(Some(message)),
            (Some(method), Some(id)) => {
                let result = match method {
                    "workspace/configuration" => {
                        let items = message["params"]["items"].as_array().map_or(0, Vec::len);
                        Value::Array(vec![Value::Null; items])
                    }
                    "workspace/workspaceFolders" => {
                        json!([{ "uri": self.root_uri, "name": "root" }])
                    }
                    _ => Value::Null,
                };
                self.send(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))?;
                Ok(None)
            }
            (Some(method), None) => {
                let params = &message["params"];
                match method {
                    "$/progress" => {
                        let token = params["token"].to_string();
                        match params["value"]["kind"].as_str() {
                            Some("begin") => {
                                self.progress.insert(token);
                            }
                            Some("end") => {
                                self.progress.remove(&token);
                            }
                            _ => {}
                        }
                    }
                    "experimental/serverStatus" => self.quiescent = params["quiescent"].as_bool(),
                    // Kept on stderr: which TypeScript or Python the server chose is evidence.
                    "window/logMessage" | "window/showMessage" => {
                        eprintln!("server: {}", params["message"].as_str().unwrap_or_default());
                    }
                    _ => {}
                }
                Ok(None)
            }
            (None, None) => Ok(None),
        }
    }

    pub fn request(
        &mut self,
        method: &str,
        params: Value,
        limit: Duration,
    ) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        let deadline = Instant::now() + limit;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(format!("{method}: no answer within {} s", limit.as_secs()));
            }
            let Some(message) = self.receive(left)? else {
                continue;
            };
            let Some(response) = self.handle(message)? else {
                continue;
            };
            if response["id"] != json!(id) {
                continue;
            }
            if let Some(error) = response.get("error") {
                return Err(format!("{method}: {error}"));
            }
            return Ok(response.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    /// Waits until every progress the server began has ended, rust-analyzer (where it reports a
    /// status) says it is quiescent, and nothing has arrived for `QUIET`.
    pub fn wait_ready(&mut self, limit: Duration) -> Result<(), String> {
        let deadline = Instant::now() + limit;
        loop {
            if Instant::now() >= deadline {
                return Err(format!(
                    "the server was not ready within {} s",
                    limit.as_secs()
                ));
            }
            match self.receive(QUIET)? {
                Some(message) => {
                    self.handle(message)?;
                }
                None if self.progress.is_empty() && self.quiescent != Some(false) => return Ok(()),
                None => {}
            }
        }
    }

    pub fn open(&mut self, root: &Path, path: &str) -> Result<(), String> {
        let text =
            fs::read_to_string(root.join(path)).map_err(|e| format!("cannot read {path}: {e}"))?;
        let uri = path_to_uri(&root.join(path));
        let item =
            json!({ "uri": uri, "languageId": language_id(path), "version": 1, "text": text });
        self.notify("textDocument/didOpen", json!({ "textDocument": item }))
    }

    pub fn close(&mut self, root: &Path, path: &str) -> Result<(), String> {
        let uri = path_to_uri(&root.join(path));
        self.notify(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": uri } }),
        )
    }

    /// Asks the server to shut down, and gives it 5 seconds before it is killed on drop.
    pub fn stop(mut self) {
        let _ = self.request("shutdown", Value::Null, Duration::from_secs(10));
        let _ = self.notify("exit", Value::Null);
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && !matches!(self.child.try_wait(), Ok(Some(_))) {
            thread::sleep(Duration::from_millis(50));
        }
    }
}

/// A server is killed when dropped, so a run that stops on an error does not leave it running.
impl Drop for Server {
    fn drop(&mut self) {
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// One document symbol, flattened: 1-based lines, its range's start and end as (line, character)
/// from 0, and the index of the symbol around it.
#[derive(Clone, Debug)]
pub struct Scope {
    pub name: String,
    pub kind: u64,
    pub start: (u64, u64),
    pub end: (u64, u64),
    pub selection: Value,
    pub parent: Option<usize>,
}

pub(crate) fn position(value: &Value) -> (u64, u64) {
    (
        value["line"].as_u64().unwrap_or_default(),
        value["character"].as_u64().unwrap_or_default(),
    )
}

/// Flattens hierarchical document symbols, parents first. Flat `SymbolInformation` has no ranges
/// for nesting, so it is refused.
pub fn flatten(symbols: &Value) -> Result<Vec<Scope>, String> {
    fn walk(symbols: &[Value], parent: Option<usize>, out: &mut Vec<Scope>) -> Result<(), String> {
        for symbol in symbols {
            if symbol.get("location").is_some() {
                return Err(
                    "the server sent flat symbols; the column needs hierarchical ones".to_owned(),
                );
            }
            out.push(Scope {
                name: symbol["name"].as_str().unwrap_or_default().to_owned(),
                kind: symbol["kind"].as_u64().unwrap_or_default(),
                start: position(&symbol["range"]["start"]),
                end: position(&symbol["range"]["end"]),
                selection: symbol["selectionRange"]["start"].clone(),
                parent,
            });
            let at = out.len() - 1;
            walk(
                symbol["children"].as_array().map_or(&[], Vec::as_slice),
                Some(at),
                out,
            )?;
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(
        symbols.as_array().map_or(&[], Vec::as_slice),
        None,
        &mut out,
    )?;
    Ok(out)
}

/// LSP symbol kinds: File, Module, Namespace and Package only scope a name; the others listed in
/// `LOCAL` are values inside a definition, not callers.
const SCOPE_ONLY: [u64; 4] = [1, 2, 3, 4];
pub(crate) const LOCAL: [u64; 12] = [7, 8, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];

/// gopls names a method by its receiver, as `(*Logger).WithFields`; this is the method's own name.
fn go_method(name: &str) -> Option<&str> {
    name.strip_prefix('(')?
        .split_once(").")
        .map(|(_, method)| method)
}

/// The receiver type of a method gopls names as `(*Logger).WithFields`: `Logger`.
pub(crate) fn go_receiver(name: &str) -> Option<String> {
    let (receiver, _) = name.strip_prefix('(')?.split_once(").")?;
    let receiver = receiver.trim_start_matches('*');
    Some(receiver.split('[').next().unwrap_or(receiver).to_owned())
}

/// csharp-ls names a method with its parameters, as `Write(LogEventLevel level)`; this is the
/// name without them, which would otherwise read as an anonymous scope.
fn csharp_name(name: &str) -> String {
    match name.split_once('(') {
        Some((head, _)) if name.ends_with(')') && !head.is_empty() => head.trim_end().to_owned(),
        _ => name.to_owned(),
    }
}

/// tsserver names a test callback like `it('x') callback`, and other anonymous scopes `<function>`.
fn anonymous(name: &str) -> bool {
    name.ends_with(" callback")
        || name.starts_with('<')
        || (name.contains('(') && go_method(name).is_none())
}

/// `impl<T> Trait for Foo<T>` and `impl Foo<T>` become `Foo`, as the graph tools name them.
pub fn clean_scope(name: &str) -> String {
    if let Some(method) = go_method(name) {
        return method.to_owned();
    }
    let name = if let Some(rest) = name
        .strip_prefix("impl")
        .filter(|rest| rest.starts_with(['<', ' ']))
    {
        match rest.rsplit_once(" for ") {
            Some((_, owner)) => owner.to_owned(),
            None if rest.starts_with('<') => {
                rest.split_once('>').map_or(rest, |(_, r)| r).to_owned()
            }
            None => rest.to_owned(),
        }
    } else {
        name.to_owned()
    };
    let name = name.split('<').next().unwrap_or_default().trim();
    name.rsplit("::").next().unwrap_or_default().to_owned()
}

/// The names of the definition around a position, outermost first, as Serena's column maps a
/// reference: scope-only symbols and anonymous callbacks drop out, and an innermost value inside
/// a definition gives way to the definition. Empty at module level.
pub fn caller_chain(scopes: &[Scope], at: (u64, u64)) -> Vec<usize> {
    let mut chain = enclosing(scopes, at);
    while chain.len() > 1 && LOCAL.contains(&scopes[chain[chain.len() - 1]].kind) {
        chain.pop();
    }
    chain
}

/// The symbols around a position, outermost first, without scope-only symbols and anonymous
/// callbacks.
pub(crate) fn enclosing(scopes: &[Scope], at: (u64, u64)) -> Vec<usize> {
    let depth = |mut index: usize| {
        let mut depth = 0;
        while let Some(parent) = scopes[index].parent {
            depth += 1;
            index = parent;
        }
        depth
    };
    let innermost = (0..scopes.len())
        .filter(|&i| scopes[i].start <= at && at <= scopes[i].end)
        .max_by_key(|&i| depth(i));
    let mut chain = Vec::new();
    let mut next = innermost;
    while let Some(index) = next {
        let scope = &scopes[index];
        if !SCOPE_ONLY.contains(&scope.kind) && !anonymous(&scope.name) {
            chain.push(index);
        }
        next = scope.parent;
    }
    chain.reverse();
    chain
}

/// The cleaned names of the symbols around one, innermost first, starting with a Go method's
/// receiver.
fn owners(scopes: &[Scope], scope: &Scope) -> Vec<String> {
    let mut names: Vec<String> = go_receiver(&scope.name).into_iter().collect();
    let mut next = scope.parent;
    while let Some(index) = next {
        names.push(clean_scope(&scopes[index].name));
        next = scopes[index].parent;
    }
    names
}

/// A symbol's first and last line, from 1.
pub(crate) fn lines(scope: &Scope) -> (i64, i64) {
    (scope.start.0 as i64 + 1, scope.end.0 as i64 + 1)
}

/// The truth target's definitions among a file's symbols, with the span each is scored at. Under
/// `span` rules a definition must hold a target line, or be the only one within a few lines of it
/// (a decorator moves the start), as the other rivals' adapters choose.
pub fn targets<'a>(
    scopes: &'a [Scope],
    symbol: &str,
    entry: &Entry,
    span_rules: bool,
) -> Vec<(&'a Scope, String)> {
    let mut parts: Vec<&str> = symbol.split('.').collect();
    let leaf = parts.pop().unwrap_or_default();
    let cands: Vec<&Scope> = scopes
        .iter()
        .filter(|s| {
            let owners = owners(scopes, s);
            clean_scope(&s.name) == leaf && parts.iter().all(|p| owners.iter().any(|o| o == p))
        })
        .collect();
    let span = |s: &Scope| format!("L{}-L{}", lines(s).0, lines(s).1);
    if !span_rules || entry.target_lines.is_empty() {
        return cands.into_iter().map(|s| (s, span(s))).collect();
    }
    let holds = |s: &&Scope| {
        entry
            .target_lines
            .iter()
            .any(|&l| lines(s).0 <= l && l <= lines(s).1)
    };
    let exact: Vec<_> = cands.iter().copied().filter(holds).collect();
    if !exact.is_empty() {
        return exact.into_iter().map(|s| (s, span(s))).collect();
    }
    match cands.as_slice() {
        [only]
            if entry
                .target_lines
                .iter()
                .any(|&l| (-10..=5).contains(&(lines(only).0 - l))) =>
        {
            let low = entry
                .target_lines
                .iter()
                .copied()
                .min()
                .unwrap_or_default()
                .min(lines(only).0);
            let high = entry
                .target_lines
                .iter()
                .copied()
                .max()
                .unwrap_or_default()
                .max(lines(only).1);
            vec![(*only, format!("L{low}-L{high}"))]
        }
        _ => Vec::new(),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(name: &str, kind: u64, lines: (u64, u64), parent: Option<usize>) -> Scope {
        Scope {
            name: name.to_owned(),
            kind,
            start: (lines.0, 0),
            end: (lines.1, 80),
            selection: json!({ "line": lines.0, "character": 4 }),
            parent,
        }
    }

    #[test]
    fn a_frame_is_read_by_its_length() {
        let body = r#"{"id":1,"result":"é"}"#;
        let text = format!(
            "Content-Type: x\r\ncontent-length: {}\r\n\r\n{body}rest",
            body.len()
        );
        let value = read_frame(&mut text.as_bytes()).unwrap().unwrap();
        assert_eq!(value["result"], "é");
        assert!(read_frame(&mut &b""[..]).unwrap().is_none());
    }

    #[test]
    fn a_path_survives_the_round_trip_through_a_uri() {
        let uri = path_to_uri(Path::new("/tmp/a b/c#d.py"));
        assert_eq!(uri, "file:///tmp/a%20b/c%23d.py");
        assert_eq!(uri_to_path(&uri).unwrap(), "/tmp/a b/c#d.py");
        assert_eq!(uri_to_path("file:///c%3A/x/y.ts").unwrap(), "c:/x/y.ts");
        assert_eq!(uri_to_path("untitled:1"), None);
        assert_eq!(
            relative("/w/run", "/w/run/src/a.py").as_deref(),
            Some("src/a.py")
        );
        assert_eq!(relative("/w/run", "/w/runner/a.py"), None);
    }

    #[test]
    fn a_caller_is_the_innermost_definition_that_is_not_a_value() {
        // module > class Foo > method bar > variable x; and a test callback at the top.
        let scopes = vec![
            scope("mod.py", 2, (0, 100), None),
            scope("Foo", 5, (1, 20), Some(0)),
            scope("bar", 6, (2, 10), Some(1)),
            scope("x", 13, (3, 3), Some(2)),
            scope("describe('a') callback", 12, (30, 40), None),
        ];
        assert_eq!(caller_chain(&scopes, (3, 10)), vec![1, 2]);
        assert_eq!(caller_chain(&scopes, (15, 0)), vec![1]);
        assert!(caller_chain(&scopes, (35, 0)).is_empty());
        assert!(caller_chain(&scopes, (60, 0)).is_empty());
    }

    #[test]
    fn rust_impl_blocks_are_named_by_their_type() {
        assert_eq!(clean_scope("impl<T> Service<T> for Router<S>"), "Router");
        assert_eq!(clean_scope("impl<S> Router<S>"), "Router");
        assert_eq!(clean_scope("impl Builder"), "Builder");
        assert_eq!(clean_scope("render"), "render");
    }

    #[test]
    fn go_methods_are_named_and_not_anonymous() {
        assert_eq!(clean_scope("(*Logger).WithFields"), "WithFields");
        assert_eq!(clean_scope("(Level).String"), "String");
        assert_eq!(clean_scope("implementation"), "implementation");
        assert_eq!(csharp_name("Write(LogEventLevel level)"), "Write");
        assert_eq!(
            clean_scope(&csharp_name("ForContext<TSource>()")),
            "ForContext"
        );
        assert_eq!(csharp_name("LoggerTests"), "LoggerTests");
        assert_eq!(clean_scope("impl<T> Iterator for Iter<T>"), "Iter");
        assert!(!anonymous("(*Logger).WithFields"));
        assert!(anonymous("describe('x') callback"));
        assert!(anonymous("map(x)"));
    }

    #[test]
    fn a_span_target_must_hold_a_target_line_or_be_the_only_one_near_it() {
        let scopes = vec![
            scope("Foo", 5, (0, 30), None),
            scope("run", 6, (4, 9), Some(0)),
            scope("run", 12, (40, 45), None),
        ];
        let entry = |lines: Vec<i64>| Entry {
            target: "a.py".into(),
            target_lines: lines,
            required: vec![],
            optional: vec![],
        };
        let names = |found: Vec<(&Scope, String)>| {
            found
                .into_iter()
                .map(|(s, span)| format!("{}@{span}", s.start.0))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names(targets(&scopes, "run", &entry(vec![42]), true)),
            ["40@L41-L46"]
        );
        assert_eq!(
            names(targets(&scopes, "Foo.run", &entry(vec![3]), true)),
            ["4@L3-L10"]
        );
        assert!(targets(&scopes, "run", &entry(vec![20]), true).is_empty());
        assert_eq!(targets(&scopes, "run", &entry(vec![]), false).len(), 2);
        assert!(targets(&scopes, "Bar.run", &entry(vec![]), false).is_empty());
        let go = vec![scope("(*Logger).WithField", 6, (10, 12), None)];
        assert_eq!(
            names(targets(&go, "Logger.WithField", &entry(vec![11]), true)),
            ["10@L11-L13"]
        );
        assert!(targets(&go, "Entry.WithField", &entry(vec![11]), true).is_empty());
    }
}
