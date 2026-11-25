//! Git diff extraction and hunk parsing matching `src/blast/diff.ts`.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::program::locate_program;

const MAX_HUNK_LINES: usize = 24;
const MAX_FILE_LINES: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LineRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiffLine {
    pub n: Option<usize>,
    pub sign: &'static str,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Hunk {
    pub start: usize,
    pub end: usize,
    pub lines: Vec<DiffLine>,
    pub dropped: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChangedFile {
    pub path: String,
    pub status: ChangeStatus,
    #[serde(rename = "oldPath", skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub ranges: Vec<LineRange>,
    pub hunks: Vec<Hunk>,
}

#[derive(Debug, Clone)]
pub struct DiffResult {
    pub basis: String,
    pub files: Vec<ChangedFile>,
}

pub(crate) fn git_run(root: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let git = locate_program("git", root).ok()?;
    let mut full_args = Vec::with_capacity(args.len() + 2);
    full_args.extend(["-c", "core.quotePath=false"]);
    full_args.extend_from_slice(args);
    let out = Command::new(git)
        .args(&full_args)
        .current_dir(root)
        .output()
        .ok()?;
    out.status.success().then_some(out.stdout)
}

pub fn ref_exists(root: &Path, git_ref: &str) -> bool {
    if git_ref.is_empty() || git_ref.starts_with('-') {
        return false;
    }
    let spec = format!("{git_ref}^{{commit}}");
    git_run(root, &["rev-parse", "--verify", "--quiet", &spec]).is_some()
}

pub fn changed_files(root: &Path, base: Option<&str>) -> Option<DiffResult> {
    if let Some(b) = base {
        let range = format!("{b}...HEAD");
        let files = diff_files(root, &[&range])?;
        return Some(DiffResult {
            basis: range,
            files,
        });
    }
    let working = diff_files(root, &["HEAD"])?;
    if !working.is_empty() {
        return Some(DiffResult {
            basis: "working tree vs HEAD".to_string(),
            files: working,
        });
    }
    match diff_files(root, &["HEAD~1...HEAD"]) {
        Some(last) => Some(DiffResult {
            basis: "HEAD~1...HEAD".to_string(),
            files: last,
        }),
        None => Some(DiffResult {
            basis: "working tree vs HEAD".to_string(),
            files: Vec::new(),
        }),
    }
}

fn diff_files(root: &Path, range: &[&str]) -> Option<Vec<ChangedFile>> {
    let mut status_args = vec!["diff", "--name-status", "--find-renames", "-z"];
    status_args.extend_from_slice(range);
    status_args.push("--");
    let status_raw = git_run(root, &status_args)?;
    let mut files = parse_name_status(&status_raw);
    if files.is_empty() {
        return Some(files);
    }

    let mut patch_args = vec![
        "diff",
        "--unified=0",
        "--no-color",
        "--no-ext-diff",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--find-renames",
    ];
    patch_args.extend_from_slice(range);
    patch_args.push("--");
    if let Some(patch_raw) = git_run(root, &patch_args) {
        let patch = String::from_utf8_lossy(&patch_raw);
        apply_hunks(&mut files, &patch);
    }
    Some(files)
}

fn parse_name_status(raw: &[u8]) -> Vec<ChangedFile> {
    let fields: Vec<String> = raw
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect();
    let mut files = Vec::new();
    let mut i = 0;
    while i < fields.len() {
        let code = &fields[i];
        i += 1;
        if code.starts_with('R') || code.starts_with('C') {
            let Some(old_path) = fields.get(i).cloned() else {
                break;
            };
            let Some(path) = fields.get(i + 1).cloned() else {
                break;
            };
            i += 2;
            files.push(ChangedFile {
                path,
                status: ChangeStatus::Renamed,
                old_path: Some(old_path),
                ranges: Vec::new(),
                hunks: Vec::new(),
            });
            continue;
        }
        let Some(path) = fields.get(i).cloned() else {
            break;
        };
        i += 1;
        let status = if code.starts_with('A') {
            ChangeStatus::Added
        } else if code.starts_with('D') {
            ChangeStatus::Deleted
        } else {
            ChangeStatus::Modified
        };
        files.push(ChangedFile {
            path,
            status,
            old_path: None,
            ranges: Vec::new(),
            hunks: Vec::new(),
        });
    }
    files
}

fn parse_hunk_header(line: &str) -> Option<(usize, usize)> {
    let plus_idx = line.find(" +")?;
    let rest = &line[plus_idx + 2..];
    let header_end = rest.find(" @@")?;
    let spec = &rest[..header_end];
    let (start, count) = match spec.split_once(',') {
        Some((s, c)) => (s.parse::<usize>().ok()?, c.parse::<usize>().ok()?),
        None => (spec.parse::<usize>().ok()?, 1),
    };
    let range = if count == 0 {
        (start, start)
    } else {
        (start, start + count - 1)
    };
    Some(range)
}

fn strip_prefix(raw: &str) -> &str {
    let untabbed = raw.split('\t').next().unwrap_or(raw);
    untabbed.strip_prefix("b/").unwrap_or(untabbed)
}

fn apply_hunks(files: &mut [ChangedFile], patch: &str) {
    let mut by_path: HashMap<String, usize> = HashMap::with_capacity(files.len());
    for (idx, f) in files.iter().enumerate() {
        by_path.insert(f.path.clone(), idx);
    }

    let mut current: Option<usize> = None;
    let mut open_hunk: Option<Hunk> = None;
    let mut next_line = 0_usize;
    let mut kept = 0_usize;

    let flush_hunk = |cur: Option<usize>, hunk: &mut Option<Hunk>, files: &mut [ChangedFile]| {
        if let (Some(idx), Some(h)) = (cur, hunk.take()) {
            files[idx].ranges.push(LineRange {
                start: h.start,
                end: h.end,
            });
            files[idx].hunks.push(h);
        } else {
            *hunk = None;
        }
    };

    for line in patch.split('\n') {
        if line.starts_with("diff --git ") {
            flush_hunk(current, &mut open_hunk, files);
            current = None;
            continue;
        }
        if let Some(raw) = line.strip_prefix("+++ ") {
            flush_hunk(current, &mut open_hunk, files);
            current = if raw == "/dev/null" {
                None
            } else {
                by_path.get(strip_prefix(raw)).copied()
            };
            kept = 0;
            continue;
        }
        if line.starts_with("@@") {
            flush_hunk(current, &mut open_hunk, files);
            let Some(_idx) = current else {
                continue;
            };
            let Some((start, end)) = parse_hunk_header(line) else {
                continue;
            };
            open_hunk = Some(Hunk {
                start,
                end,
                lines: Vec::new(),
                dropped: 0,
            });
            next_line = start;
            continue;
        }
        let Some(ref mut h) = open_hunk else {
            continue;
        };
        if let Some(text) = line.strip_prefix('+') {
            push_diff_line(
                h,
                DiffLine {
                    n: Some(next_line),
                    sign: "+",
                    text: text.to_string(),
                },
                kept < MAX_FILE_LINES,
            );
            kept += 1;
            next_line += 1;
        } else if let Some(text) = line.strip_prefix('-') {
            push_diff_line(
                h,
                DiffLine {
                    n: None,
                    sign: "-",
                    text: text.to_string(),
                },
                kept < MAX_FILE_LINES,
            );
            kept += 1;
        }
    }
    flush_hunk(current, &mut open_hunk, files);
}

fn push_diff_line(hunk: &mut Hunk, line: DiffLine, within_file: bool) {
    if !within_file || hunk.lines.len() >= MAX_HUNK_LINES {
        hunk.dropped += 1;
        return;
    }
    hunk.lines.push(line);
}
