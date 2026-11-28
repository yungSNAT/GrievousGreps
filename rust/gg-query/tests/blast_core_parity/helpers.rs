//! Shared fixtures and isolated git helpers for `blast_core_parity`.

use std::fs;
use std::path::Path;
use std::process::Command;

use gg_query::blast::diff::{ChangeStatus, ChangedFile, DiffLine, Hunk, LineRange};
use gg_query::blast::types::BlastReport;
use gg_query::blast::{BlastOptions, compute_blast_report};
use gg_query::store::GraphStore;
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

/// Run git isolated from global/system config so hooks, signing or autocrlf cannot interfere.
pub fn git_out(repo: &Path, args: &[&str]) -> String {
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_GLOBAL", null)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

pub fn init_git(repo: &Path) {
    git_out(repo, &["init", "-q", "-b", "main"]);
    git_out(repo, &["config", "user.name", "Blast Test"]);
    git_out(repo, &["config", "user.email", "blast-test@example.com"]);
    git_out(repo, &["config", "commit.gpgsign", "false"]);
    git_out(repo, &["config", "tag.gpgsign", "false"]);
    git_out(repo, &["config", "core.autocrlf", "false"]);
    git_out(repo, &["config", "diff.interHunkContext", "0"]);
}

pub fn commit_all(repo: &Path, msg: &str) {
    git_out(repo, &["add", "-A"]);
    git_out(repo, &["commit", "-q", "-m", msg]);
}

pub fn write_file(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("mkdir");
    }
    fs::write(path, text).expect("write");
}

pub fn build_store(
    files: &[(&str, &str)],
    concepts: &[(&str, &str)],
    graph: &Value,
) -> (TempDir, GraphStore) {
    let tmp = tempdir().expect("tempdir");
    let root = tmp.path();
    for &(rel, text) in files {
        write_file(root, rel, text);
    }
    let ctx = root.join("graft");
    fs::create_dir_all(ctx.join(".graph")).expect("mkdir .graph");
    for &(name, text) in concepts {
        write_file(&ctx, name, text);
    }
    fs::write(ctx.join(".graph/wiring.json"), graph.to_string()).expect("write wiring.json");
    let store = GraphStore::open_or_sync(&ctx)
        .expect("open_or_sync")
        .expect("store");
    (tmp, store)
}

pub fn file_node(path: &str, span: &str) -> Value {
    let name = path.rsplit('/').next().unwrap_or(path);
    json!({
        "id": format!("f:{path}"), "name": name, "kind": "file", "path": path,
        "span": span, "exported": false, "origin": "ast", "body_hash": "0"
    })
}

pub fn sym_node(
    id: &str,
    name: &str,
    kind: &str,
    path: &str,
    span: &str,
    sig: Option<&str>,
) -> Value {
    json!({
        "id": id, "name": name, "kind": kind, "path": path, "span": span,
        "signature": sig, "exported": true, "origin": "ast", "body_hash": "1"
    })
}

pub fn method_node(
    id: &str,
    name: &str,
    owner: Option<&str>,
    path: &str,
    span: &str,
    sig: Option<&str>,
) -> Value {
    json!({
        "id": id, "name": name, "kind": "method", "owner": owner, "path": path,
        "span": span, "signature": sig, "exported": true, "origin": "ast", "body_hash": "1"
    })
}

pub fn edge(source: &str, target: &str, relation: &str, confidence: &str) -> Value {
    json!({
        "source": source, "target": target, "relation": relation, "confidence": confidence
    })
}

pub fn hunk(start: usize, end: usize, lines: &[(&'static str, &str)]) -> Hunk {
    let mut n = start;
    let built = lines
        .iter()
        .map(|&(sign, text)| {
            let line_no = if sign == "+" {
                let cur = n;
                n += 1;
                Some(cur)
            } else {
                None
            };
            DiffLine {
                n: line_no,
                sign,
                text: text.to_string(),
            }
        })
        .collect();
    Hunk {
        start,
        end,
        lines: built,
        dropped: 0,
    }
}

pub fn modified(path: &str, ranges: &[(usize, usize)], hunks: Vec<Hunk>) -> ChangedFile {
    ChangedFile {
        path: path.to_string(),
        status: ChangeStatus::Modified,
        old_path: None,
        ranges: ranges
            .iter()
            .map(|&(start, end)| LineRange { start, end })
            .collect(),
        hunks,
    }
}

pub fn deleted(path: &str) -> ChangedFile {
    ChangedFile {
        path: path.to_string(),
        status: ChangeStatus::Deleted,
        old_path: None,
        ranges: Vec::new(),
        hunks: Vec::new(),
    }
}

pub fn run_blast(
    store: &GraphStore,
    root: &Path,
    changed: Vec<ChangedFile>,
    depth: usize,
    tests: bool,
    seed_all_on_empty_ranges: bool,
) -> BlastReport {
    compute_blast_report(
        store,
        root,
        &root.join("graft"),
        changed,
        "main...HEAD".to_string(),
        &BlastOptions {
            depth,
            tests,
            seed_all_on_empty_ranges,
        },
    )
    .expect("blast report")
}
