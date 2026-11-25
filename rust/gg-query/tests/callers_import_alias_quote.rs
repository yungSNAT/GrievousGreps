//! `callers` quotes the call, not the import, when a file imports the name under another one.

use std::fs;
use std::path::Path;

use snapbox::cmd::{Command, cargo_bin};
use tempfile::tempdir;

fn write(repo: &Path, rel: &str, text: &str) {
    let path = repo.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

#[test]
fn callers_quotes_the_call_of_an_imported_alias_not_the_import() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    write(repo, "pkg/util.py", "def helper(x):\n    return x + 1\n");
    write(repo, "py_alias.py", "from pkg.util import helper as h\n\nh(3)\n");
    write(
        repo,
        "py_plain.py",
        "from pkg.util import helper\n\nVALUES = [helper(i) for i in range(2)]\n",
    );
    write(
        repo,
        "pkg/py_relative.py",
        "from .util import helper as rel\n\n\ndef run():\n    return rel(6)\n",
    );
    let graph = r#"{
  "meta": { "version": 1, "nodeCount": 5, "edgeCount": 3, "languages": ["python"] },
  "nodes": [
    { "id": "pkg/util.py#helper", "name": "helper", "kind": "function", "path": "pkg/util.py", "span": "L1-L2", "exported": true, "origin": "ast", "body_hash": "h1" },
    { "id": "py_alias.py", "name": "py_alias.py", "kind": "file", "path": "py_alias.py", "span": "L1-L3", "exported": false, "origin": "ast", "body_hash": "f1", "chars": 40 },
    { "id": "py_plain.py", "name": "py_plain.py", "kind": "file", "path": "py_plain.py", "span": "L1-L3", "exported": false, "origin": "ast", "body_hash": "f2", "chars": 70 },
    { "id": "pkg/py_relative.py#run", "name": "run", "kind": "function", "path": "pkg/py_relative.py", "span": "L4-L5", "exported": true, "origin": "ast", "body_hash": "h2" }
  ],
  "edges": [
    { "source": "py_alias.py", "target": "pkg/util.py#helper", "relation": "calls", "confidence": "extracted" },
    { "source": "py_plain.py", "target": "pkg/util.py#helper", "relation": "calls", "confidence": "extracted" },
    { "source": "pkg/py_relative.py#run", "target": "pkg/util.py#helper", "relation": "calls", "confidence": "extracted" }
  ]
}"#;
    let gdir = repo.join("graft").join(".graph");
    fs::create_dir_all(&gdir).unwrap();
    fs::write(gdir.join("wiring.json"), graph).unwrap();

    let out = Command::new(cargo_bin!("gg-query"))
        .args(["callers", "helper"])
        .arg(repo)
        .output()
        .unwrap();
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.contains("py_alias.py L3: h(3)"), "{text}");
    assert!(
        text.contains("py_plain.py L3: VALUES = [helper(i) for i in range(2)]"),
        "{text}"
    );
    assert!(text.contains("run L5: return rel(6)"), "{text}");
    assert!(!text.contains("L1: from "), "{text}");
}
