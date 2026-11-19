//! A JSON-RPC connection to a language server over its standard streams.

use std::collections::HashSet;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::REQUEST_LIMIT;
use crate::process::command;

/// A server counts as ready once its progress has ended and it has been quiet this long.
const QUIET: Duration = Duration::from_secs(3);

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

/// The server's version: its `serverInfo` version, else the last line it prints when started with
/// `--version` in place of `--stdio`, as typescript-language-server and pyright send no
/// `serverInfo` version; 'unknown' if neither gives one.
pub fn version(server: &[OsString], info: &Value) -> String {
    if let Some(version) = info["version"].as_str() {
        return version.to_owned();
    }
    let Some((program, args)) = server.split_first() else {
        return "unknown".to_owned();
    };
    let mut asked = command(program);
    asked.args(args.iter().filter(|arg| *arg != "--stdio")).arg("--version");
    crate::process::output(&mut asked, Duration::from_secs(20))
        .ok()
        .and_then(|out| out.stdout.lines().rev().map(str::trim).find(|l| !l.is_empty()).map(str::to_owned))
        .unwrap_or_else(|| "unknown".to_owned())
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
