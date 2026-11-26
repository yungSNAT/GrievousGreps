//! `callers` quotes the call, not the import, when a file imports the name under another one.

use std::fs;
use std::path::Path;

use serde_json::json;
use snapbox::cmd::{Command, cargo_bin};
use tempfile::tempdir;

/// Each caller of `pkg/util.py#helper`, one record per `~` line: a `path|name|span` header (the
/// name is the path for a file node), then the file's text.
const CALLERS: &str = "\
py_alias.py|py_alias.py|L1-L3
from pkg.util import helper as h

h(3)
~
py_plain.py|py_plain.py|L1-L3
from pkg.util import helper

VALUES = [helper(i) for i in range(2)]
~
pkg/py_relative.py|run|L4-L5
from .util import helper as rel


def run():
    return rel(6)
~
py_except.py|guard|L4-L7
from pkg.util import helper


def guard(xs):
    for e in xs:
        check(e)
    return helper(1)


def retry():
    try:
        guard([])
    except helper as e:
        log(e)
~
py_multi.py|py_multi.py|L1-L5
from pkg.util import (
    helper as hm,
)

hm(4)
~
py_comment.py|py_comment.py|L1-L5
from pkg.util import (  # )
    helper as hc,
)

hc(5)
~
py_comment_tight.py|py_comment_tight.py|L1-L5
from pkg.util import (# )
    helper as hd,
)

hd(7)
~
py_comment_alias.py|scan|L4-L7
from pkg.util import helper  # helper as e


def scan(xs):
    for e in xs:
        check(e)
    return helper(1)
~
use_paren.js|use_paren.js|L1-L3
import { helper } from \"./lib(\";

helper();
~
use_str.js|f|L4-L7
import \"helper as e\";
import { helper } from \"./util\";

function f(xs) {
  for (const e of xs) check(e);
  return helper(2);
}
~
use_meta.js|use_meta.js|L1-L3
import { helper } from \"./util\";

if (import.meta.url) helper(4);
~
use_block.js|use_block.js|L1-L3
import { /* note */ helper as hb } from \"./util\";

export const v = hb(5);
~
use_dollar.js|use_dollar.js|L1-L3
import { helper as h$ } from \"./util\";

export const d = h$(6);
";

/// Writes the files and a graph in which each of [`CALLERS`] calls `helper`.
fn write_repo(repo: &Path) {
    let write = |rel: &str, text: &str| {
        let path = repo.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    };
    write("pkg/util.py", "def helper(x):\n    return x + 1\n");
    let target = "pkg/util.py#helper";
    let mut nodes = vec![json!({ "id": target, "name": "helper", "kind": "function",
        "path": "pkg/util.py", "span": "L1-L2", "exported": true, "origin": "ast", "body_hash": "h0" })];
    let mut edges = Vec::new();
    for (i, record) in CALLERS.split("~\n").enumerate() {
        let (head, text) = record.split_once('\n').unwrap();
        let [path, name, span] = head.split('|').collect::<Vec<_>>()[..] else {
            panic!("bad record {head}")
        };
        write(path, text);
        let file = path == name;
        let id = if file {
            path.to_string()
        } else {
            format!("{path}#{name}")
        };
        let kind = if file { "file" } else { "function" };
        nodes.push(
            json!({ "id": id, "name": name, "kind": kind, "path": path, "span": span,
            "exported": !file, "origin": "ast", "body_hash": format!("h{}", i + 1) }),
        );
        edges.push(json!({ "source": id, "target": target, "relation": "calls", "confidence": "extracted" }));
    }
    let graph = json!({
        "meta": { "version": 1, "nodeCount": nodes.len(), "edgeCount": edges.len(), "languages": ["python"] },
        "nodes": nodes,
        "edges": edges,
    });
    let gdir = repo.join("graft").join(".graph");
    fs::create_dir_all(&gdir).unwrap();
    fs::write(gdir.join("wiring.json"), graph.to_string()).unwrap();
}

#[test]
fn callers_quotes_the_call_of_an_imported_alias_not_the_import() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    write_repo(repo);

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
    // An `except ... as e` binding is no import alias.
    assert!(text.contains("guard L7: return helper(1)"), "{text}");
    // An alias bound inside a parenthesised multi-line import.
    assert!(text.contains("py_multi.py L5: hm(4)"), "{text}");
    // A bracket in a comment does not close the import.
    assert!(text.contains("py_comment.py L5: hc(5)"), "{text}");
    assert!(text.contains("py_comment_tight.py L5: hd(7)"), "{text}");
    // An `as` in a comment binds no alias.
    assert!(text.contains("scan L7: return helper(1)"), "{text}");
    // A bracket or an `as` inside a quoted module path is no syntax.
    assert!(text.contains("use_paren.js L3: helper();"), "{text}");
    assert!(text.contains("f L6: return helper(2);"), "{text}");
    // `import.meta` is no import statement; an inline block comment does not end one.
    assert!(
        text.contains("use_meta.js L3: if (import.meta.url) helper(4);"),
        "{text}"
    );
    assert!(
        text.contains("use_block.js L3: export const v = hb(5);"),
        "{text}"
    );
    // An alias holding `$` is skipped, as `trail callers` skips it: the import is quoted.
    assert!(
        text.contains("use_dollar.js L1: import { helper as h$ }"),
        "{text}"
    );
}
