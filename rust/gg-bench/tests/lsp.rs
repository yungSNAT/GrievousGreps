//! The language-server column against a fake server on a local repository, so nothing here
//! reaches the network.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use gg_bench::lsp::{Ask, LspOptions, run};
use gg_bench::run::select_repos;
use serde_json::{Value, json};

mod common;
use common::git;

/// Speaks just enough LSP: it asks the client for configuration and reports progress before it
/// is ready, then answers for `lib.py`'s `run`, called from `main` on line 4 and at module level
/// on line 6 of `main.py`, and once from a file outside the checkout. With `die` it exits after
/// the handshake; with `fail` it answers call hierarchy with an error and, until it is stopped,
/// appends to `beat` beside it.
const FAKE_SERVER: &str = r#"
const fs = require('node:fs');
const path = require('node:path');
const log = (m) => fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(m) + '\n');
const send = (m) => { const b = JSON.stringify({ jsonrpc: '2.0', ...m }); process.stdout.write(`Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`); };
const range = (a, b) => ({ start: { line: a, character: 4 }, end: { line: b, character: 9 } });
let buffer = Buffer.alloc(0);
let mainUri = null;
function answer(m) {
  const p = m.params || {};
  const uri = p.textDocument && p.textDocument.uri;
  switch (m.method) {
    case 'initialize': return { capabilities: {}, serverInfo: { name: 'fake-ls', version: '0.1' } };
    case 'textDocument/documentSymbol':
      if (uri.endsWith('lib.py')) return [{ name: 'run', kind: 12, range: range(0, 1), selectionRange: range(0, 0) }];
      return [{ name: 'main', kind: 12, range: range(2, 3), selectionRange: range(2, 2), children: [{ name: 'x', kind: 13, range: range(3, 3), selectionRange: range(3, 3) }] }];
    case 'textDocument/prepareCallHierarchy':
      return p.position.line === 0 && p.position.character === 4 ? [{ name: 'run', kind: 12, uri, range: range(0, 1), selectionRange: range(0, 0) }] : [];
    case 'callHierarchy/incomingCalls':
      return [
        { from: { name: 'main', kind: 12, uri: mainUri, range: range(2, 3), selectionRange: range(2, 2) }, fromRanges: [range(3, 3)] },
        { from: { name: 'main.py', kind: 1, uri: mainUri, range: range(0, 6), selectionRange: range(0, 0) }, fromRanges: [range(5, 5)] },
        { from: { name: 'other', kind: 12, uri: 'file:///elsewhere/other.py', range: range(0, 1), selectionRange: range(0, 0) }, fromRanges: [range(1, 1)] },
      ];
    case 'textDocument/references':
      return [{ uri: mainUri, range: range(3, 3) }, { uri: mainUri, range: range(5, 5) }];
    default: return null;
  }
}
function handle(m) {
  log(m);
  if (m.method === 'initialized') {
    if (process.argv[2] === 'die') process.exit(0);
    if (process.argv[2] === 'fail') setInterval(() => fs.appendFileSync(path.join(__dirname, 'beat'), '.'), 50);
    send({ id: 'c1', method: 'workspace/configuration', params: { items: [{ section: 'a' }, { section: 'b' }] } });
    send({ method: '$/progress', params: { token: 7, value: { kind: 'begin', title: 'indexing' } } });
    setTimeout(() => send({ method: '$/progress', params: { token: 7, value: { kind: 'end' } } }), 500);
    return;
  }
  if (m.method === 'textDocument/didOpen' && m.params.textDocument.uri.endsWith('lib.py')) {
    mainUri = m.params.textDocument.uri.replace(/lib\.py$/, 'main.py');
  }
  if (m.method === 'exit') process.exit(0);
  if (process.argv[2] === 'fail' && m.method === 'textDocument/prepareCallHierarchy') {
    send({ id: m.id, error: { code: -32603, message: 'broken' } });
    return;
  }
  if (m.id !== undefined && m.method) send({ id: m.id, result: answer(m) });
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    handle(JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString()));
    buffer = buffer.subarray(end + 4 + length);
  }
});
"#;

struct Fixture {
    _tmp: tempfile::TempDir,
    bench: PathBuf,
    server: PathBuf,
    work: PathBuf,
}

/// One Python repository, fetched into the work folder at its pinned commit, and the fake server.
fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let (bench, work) = (tmp.path().join("bench"), tmp.path().join("work"));
    let checkout = work.join("repos").join("demo");
    fs::create_dir_all(&checkout).unwrap();
    fs::write(checkout.join("lib.py"), "def run():\n    pass\n").unwrap();
    fs::write(
        checkout.join("main.py"),
        "import lib\n\ndef main():\n    x = lib.run()\n\nlib.run()\n",
    )
    .unwrap();
    git(&checkout, &["init", "--quiet"]);
    git(&checkout, &["add", "."]);
    git(&checkout, &["commit", "--quiet", "-m", "demo"]);
    let sha = git(&checkout, &["rev-parse", "HEAD"]);
    fs::create_dir_all(bench.join("truth")).unwrap();
    let repos = json!([
        { "name": "demo", "repository": "o/demo", "sha": sha, "language": "Python", "rules": "span" },
    ]);
    fs::write(bench.join("repos.json"), repos.to_string()).unwrap();
    let truth = json!({ "run": { "target": "lib.py", "target_lines": [1], "required": [
        { "file": "main.py", "chain": "main", "lines": [4] },
        { "file": "main.py", "chain": "<file>", "lines": [6] },
    ] } });
    fs::write(bench.join("truth").join("demo.json"), truth.to_string()).unwrap();
    let server = tmp.path().join("server").join("fake.js");
    fs::create_dir_all(server.parent().unwrap()).unwrap();
    fs::write(&server, FAKE_SERVER).unwrap();
    Fixture {
        _tmp: tmp,
        bench,
        server,
        work,
    }
}

impl Fixture {
    fn options(&self, ask: Ask, extra: &[&str]) -> LspOptions {
        let mut server = vec![OsString::from("node"), self.server.clone().into_os_string()];
        server.extend(extra.iter().map(OsString::from));
        LspOptions {
            bench: self.bench.clone(),
            repos: select_repos(&self.bench, None).unwrap(),
            work: self.work.clone(),
            server,
            ask,
            verbose: true,
        }
    }

    fn answers(&self, ask: &str) -> Value {
        let file = self.work.join("lsp").join(ask).join("demo.json");
        serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap()
    }

    fn received(&self) -> Vec<Value> {
        fs::read_to_string(self.server.with_file_name("calls.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

#[test]
fn call_hierarchy_answers_are_named_by_their_definition_and_scored() {
    let f = fixture();
    let report = run(&f.options(Ask::Calls, &[])).unwrap();
    let (first, rest) = report.split_once("\n\n").unwrap();
    assert!(
        first.starts_with("Server: `node ") && first.contains("` (fake-ls 0.1), asked for calls, "),
        "{first}"
    );
    assert_eq!(
        rest,
        "**Overall:** recall 1.00 (1 repositories and 2 of 2 calls), precision 1.00, silent undercounts 0. 1 locations outside the checkout were left out.\n\nLanguage server:\n| Repository | Recall | Macro recall | Precision | Silent | Stated | Perfect |\n| --- | --- | --- | --- | --- | --- | --- |\n| demo | 2/2 = 1.00 | 1.00 | 2/2 = 1.00 | 0 | 0 | 1/1 |\n"
    );
    // The call inside `x = ...` belongs to `main`, not to the value; the module-level call to the file.
    let hits = &f.answers("calls")["run"]["matches"][0]["hits"];
    assert_eq!(
        *hits,
        json!([
            { "id": "main.py", "name": null, "path": "main.py", "span": "L6-L6" },
            { "id": "main.py#main~3", "name": "main", "path": "main.py", "span": "L4-L4" },
        ])
    );
    assert_eq!(
        f.answers("calls")["run"]["matches"][0]["symbol"],
        json!({ "path": "lib.py", "span": "L1-L2" })
    );
    let received = f.received();
    let reply = received.iter().find(|m| m["id"] == "c1").unwrap();
    assert_eq!(
        reply["result"],
        json!([null, null]),
        "the configuration request is answered per item"
    );
    assert!(received.iter().any(|m| m["method"] == "shutdown"));
    assert!(
        !f.work.join("run").join("lsp").join("demo").exists(),
        "the copy is removed"
    );
}

#[test]
fn references_are_asked_without_the_declaration() {
    let f = fixture();
    let report = run(&f.options(Ask::References, &[])).unwrap();
    assert!(
        report.contains("**Overall:** recall 1.00 (1 repositories and 2 of 2 calls)"),
        "{report}"
    );
    assert!(!report.contains("outside the checkout"), "{report}");
    let asked = f
        .received()
        .into_iter()
        .find(|m| m["method"] == "textDocument/references")
        .unwrap();
    assert_eq!(
        asked["params"]["context"],
        json!({ "includeDeclaration": false })
    );
    assert_eq!(
        asked["params"]["position"],
        json!({ "line": 0, "character": 4 })
    );
}

#[test]
fn a_server_that_exits_stops_the_run() {
    let f = fixture();
    let err = run(&f.options(Ask::Calls, &["die"])).err().unwrap();
    // It dies after the handshake, so the next write or read finds it gone.
    assert!(
        err.contains("closed its output") || err.contains("cannot write to the server"),
        "{err}"
    );
}

#[test]
fn a_server_that_answers_with_an_error_is_stopped() {
    let f = fixture();
    let err = run(&f.options(Ask::Calls, &["fail"])).err().unwrap();
    assert!(err.contains("broken"), "{err}");
    let beat = f.server.with_file_name("beat");
    let size = || fs::metadata(&beat).map_or(0, |m| m.len());
    std::thread::sleep(std::time::Duration::from_millis(300));
    let before = size();
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert_eq!(size(), before, "the server still runs");
}
