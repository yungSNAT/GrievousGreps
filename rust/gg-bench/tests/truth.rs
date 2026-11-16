//! `lsp-truth` against a fake server on a local repository, so nothing here reaches the network.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use gg_bench::run::select_repos;
use gg_bench::truth::{TruthOptions, run};
use serde_json::{Value, json};

/// Answers for `lib.py`'s `run`: references in `main.py` at a call and a value inside `main`, a
/// value inside `other`, 2 module-level calls and a module-level import.
const FAKE_SERVER: &str = r#"
const send = (m) => { const b = JSON.stringify({ jsonrpc: '2.0', ...m }); process.stdout.write(`Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`); };
const at = (line, a, b) => ({ start: { line, character: a }, end: { line, character: b } });
const span = (a, b, c, d) => ({ start: { line: a, character: b }, end: { line: c, character: d } });
let buffer = Buffer.alloc(0);
let root = null;
function answer(m) {
  const p = m.params || {};
  const uri = p.textDocument && p.textDocument.uri;
  switch (m.method) {
    case 'initialize': root = p.rootUri; return { capabilities: {} };
    case 'textDocument/documentSymbol':
      if (uri.endsWith('lib.py')) return [{ name: 'run', kind: 12, range: span(0, 0, 1, 8), selectionRange: at(0, 4, 7) }];
      return [
        { name: 'main', kind: 12, range: span(2, 0, 4, 15), selectionRange: at(2, 4, 8) },
        { name: 'other', kind: 12, range: span(6, 0, 7, 18), selectionRange: at(6, 4, 9) },
      ];
    case 'textDocument/references': {
      if (!uri.endsWith('lib.py') || p.position.line !== 0 || p.position.character !== 4) return [];
      const main = root + '/main.py';
      return [at(3, 12, 15), at(4, 12, 15), at(7, 15, 18), at(8, 4, 7), at(9, 16, 19), at(10, 4, 7)]
        .map((range) => ({ uri: main, range }));
    }
    default: return null;
  }
}
function handle(m) {
  if (m.method === 'exit') process.exit(0);
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

const MAIN: &str = "import lib\n\ndef main():\n    x = lib.run()\n    f = lib.run\n\ndef other():\n    return lib.run\nlib.run()\nfrom lib import run\nlib.run()\n";

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

struct Fixture {
    _tmp: tempfile::TempDir,
    bench: PathBuf,
    server: PathBuf,
    work: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let (bench, work) = (tmp.path().join("bench"), tmp.path().join("work"));
    let checkout = work.join("repos").join("demo");
    fs::create_dir_all(&checkout).unwrap();
    fs::write(checkout.join("lib.py"), "def run():\n    pass\n").unwrap();
    fs::write(checkout.join("main.py"), MAIN).unwrap();
    git(&checkout, &["init", "--quiet"]);
    git(&checkout, &["add", "."]);
    git(&checkout, &["commit", "--quiet", "-m", "demo"]);
    let sha = git(&checkout, &["rev-parse", "HEAD"]);
    fs::create_dir_all(bench.join("truth")).unwrap();
    let repos = json!([
        { "name": "demo", "repository": "o/demo", "sha": sha, "language": "Python", "rules": "span" },
    ]);
    fs::write(bench.join("repos.json"), repos.to_string()).unwrap();
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
    fn options(&self, pick: Option<usize>) -> TruthOptions {
        let [repo] = select_repos(&self.bench, None)
            .unwrap()
            .try_into()
            .ok()
            .unwrap();
        TruthOptions {
            bench: self.bench.clone(),
            repo,
            work: self.work.clone(),
            server: vec![OsString::from("node"), self.server.clone().into_os_string()],
            pick,
            seed: 7,
        }
    }

    fn truth(&self) -> Value {
        serde_json::from_str(
            &fs::read_to_string(self.bench.join("truth").join("demo.json")).unwrap(),
        )
        .unwrap()
    }
}

/// Calls in `main` and at module level are required; a value in `other` is optional; the value
/// in `main` is covered by its call; the import gets no row.
fn expected_rows() -> (Value, Value) {
    (
        json!([
            { "file": "main.py", "chain": "main", "lines": [4] },
            { "file": "main.py", "chain": "<file>", "lines": [9, 11] },
        ]),
        json!([{ "file": "main.py", "chain": "other", "lines": [8] }]),
    )
}

#[test]
fn rows_are_derived_for_the_truth_symbols() {
    let f = fixture();
    let truth = json!({ "run": { "target": "lib.py", "target_lines": [1], "category": "kept", "required": [] } });
    fs::write(f.bench.join("truth").join("demo.json"), truth.to_string()).unwrap();
    let report = run(&f.options(None)).unwrap();
    assert!(report.contains("run 3 calls"), "{report}");
    let (required, optional) = expected_rows();
    let written = f.truth();
    assert_eq!(written["run"]["required"], required);
    assert_eq!(written["run"]["optional"], optional);
    assert_eq!(written["run"]["category"], "kept");
    assert!(
        !f.work.join("run").join("lsp").join("demo").exists(),
        "the copy is removed"
    );
}

#[test]
fn pick_chooses_symbols_with_enough_calls_and_refuses_to_replace_truth() {
    let f = fixture();
    let report = run(&f.options(Some(1))).unwrap();
    assert!(report.contains("Picked 1 of 1 with seed 7"), "{report}");
    let (required, optional) = expected_rows();
    assert_eq!(
        f.truth(),
        json!({ "run": { "target": "lib.py", "target_lines": [1], "required": required, "optional": optional } })
    );
    let err = run(&f.options(Some(1))).err().unwrap();
    assert!(
        err.contains("--pick only starts a new repository's truth"),
        "{err}"
    );
}
