//! Source-file discovery for freshness probing (`src/graph/source-files.ts`).

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

use serde::Deserialize;

use crate::graph::{is_deploy_file, normalize_path_prefix, safe_resolve_inside};
use crate::program::locate_program;

use super::MAX_FILE_BYTES;

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "_build",
    "out",
    "target",
    "vendor",
    "coverage",
    "__pycache__",
    "venv",
];

const DOT_SKIP_DIRS: &[&str] = &[
    ".git",
    ".graft",
    ".trail",
    ".venv",
    ".tox",
    ".nox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".yarn",
    ".pnpm-store",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
    ".gradle",
    ".dart_tool",
    ".pub-cache",
    ".bundle",
    ".ipynb_checkpoints",
    ".terraform",
];

const NEVER_INCLUDE_DIRS: &[&str] = &[".git", ".trail", ".graft"];

const CODE_EXTENSIONS: &[&str] = &[
    ".tsx", ".jsx", ".mts", ".cts", ".ts", ".mjs", ".cjs", ".js", ".pyi", ".py", ".go", ".java",
    ".kt", ".kts", ".swift", ".php", ".r", ".rs", ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh",
    ".rb", ".cs", ".scala", ".sc", ".ex", ".exs", ".sol", ".ml", ".mli", ".zig", ".dart", ".clj",
    ".cljs", ".cljc", ".bb", ".nix", ".lua", ".gleam", ".ps1", ".psm1", ".jl", ".glsl", ".sh",
    ".bash", ".pl", ".pm", ".m", ".mm", ".gd", ".res", ".resi", ".groovy", ".gradle", ".elm",
    ".hs", ".f90", ".f95", ".f03", ".f08", ".vue", ".svelte", ".astro",
];

#[derive(Deserialize, Default)]
struct BuildConfig {
    #[serde(rename = "includeDirs", default)]
    include_dirs: Vec<String>,
    #[serde(rename = "followSubmodules", default)]
    follow_submodules: bool,
    #[serde(rename = "followNestedRepos", default)]
    follow_nested_repos: bool,
}

fn read_build_config(root: &Path) -> BuildConfig {
    let Some(path) = safe_resolve_inside(root, ".graft/config.json") else {
        return BuildConfig::default();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return BuildConfig::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn should_skip_dir(name: &str, includes: &HashSet<String>) -> bool {
    if NEVER_INCLUDE_DIRS.contains(&name) {
        return true;
    }
    if includes.contains(name) {
        return false;
    }
    name.starts_with('.') || SKIP_DIRS.contains(&name)
}

fn skipped_path(rel: &str, includes: &HashSet<String>) -> bool {
    let clean = rel.replace('\\', "/");
    let mut parts: Vec<&str> = clean.split('/').collect();
    let Some(last) = parts.pop() else {
        return true;
    };
    if should_skip_dir(last, includes) {
        return true;
    }
    parts.into_iter().any(|seg| {
        if seg.starts_with('.') {
            DOT_SKIP_DIRS.contains(&seg)
                && (NEVER_INCLUDE_DIRS.contains(&seg) || !includes.contains(seg))
        } else {
            should_skip_dir(seg, includes)
        }
    })
}

fn canonical_walk_root(dir: &Path) -> PathBuf {
    let Ok(meta) = fs::symlink_metadata(dir) else {
        return dir.to_path_buf();
    };
    if !meta.file_type().is_symlink() {
        return dir.to_path_buf();
    }
    let Ok(real) = fs::canonicalize(dir) else {
        return dir.to_path_buf();
    };
    if fs::metadata(&real).is_ok_and(|m| m.is_dir()) {
        real
    } else {
        dir.to_path_buf()
    }
}

/// Reject intermediate symlink directories, non-regular leaves, oversize files, and escapes.
fn resolve_contained_file(
    root: &Path,
    canon_root: &Path,
    rel: &str,
) -> Option<(PathBuf, fs::Metadata)> {
    let mut parts = Vec::new();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(seg) => parts.push(seg),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    let (leaf, ancestors) = parts.split_last()?;
    let mut cur = root.to_path_buf();
    for seg in ancestors {
        cur.push(seg);
        let meta = fs::symlink_metadata(&cur).ok()?;
        if meta.file_type().is_symlink() || !meta.file_type().is_dir() {
            return None;
        }
    }
    cur.push(leaf);
    let meta = fs::symlink_metadata(&cur).ok()?;
    if meta.file_type().is_symlink() || !meta.file_type().is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let canon = fs::canonicalize(&cur).ok()?;
    if !canon.starts_with(canon_root) {
        return None;
    }
    Some((cur, meta))
}

fn git_visible_files_shallow(
    root: &Path,
    canon_root: &Path,
    includes: &HashSet<String>,
) -> Option<Vec<(String, PathBuf, fs::Metadata)>> {
    let git = locate_program("git", root).ok()?;
    let out = Command::new(git)
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
        ])
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mut files = Vec::new();
    for raw in out.stdout.split(|&b| b == 0) {
        if raw.is_empty() {
            continue;
        }
        let Ok(rel) = std::str::from_utf8(raw) else {
            continue;
        };
        if skipped_path(rel, includes) {
            continue;
        }
        let Some((abs, meta)) = resolve_contained_file(root, canon_root, rel) else {
            continue;
        };
        files.push((normalize_path_prefix(rel), abs, meta));
    }
    Some(files)
}

fn parse_stage_entries(stdout: &[u8]) -> BTreeMap<String, (bool, bool)> {
    let mut entries: BTreeMap<String, (bool, bool)> = BTreeMap::new();
    for raw in stdout.split(|&b| b == 0) {
        let Ok(rec) = std::str::from_utf8(raw) else {
            continue;
        };
        if rec.len() < 2 || !rec.as_bytes()[1].is_ascii_whitespace() {
            continue;
        }
        let tag = rec.as_bytes()[0];
        let body = &rec[2..];
        let (rel, gitlink, nested) = if tag == b'?' {
            if let Some(stripped) = body.strip_suffix('/') {
                (stripped.to_string(), false, true)
            } else {
                (body.to_string(), false, false)
            }
        } else if let Some(tab) = body.find('\t') {
            (
                body[tab + 1..].to_string(),
                body.starts_with("160000 "),
                false,
            )
        } else {
            continue;
        };
        if rel.is_empty() {
            continue;
        }
        let prev = entries.get(&rel).copied().unwrap_or((false, false));
        entries.insert(rel, (gitlink || prev.0, nested || prev.1));
    }
    entries
}

fn git_visible_files_recursive(
    root: &Path,
    top_root: &Path,
    canon_top: &Path,
    includes: &HashSet<String>,
    cfg: &BuildConfig,
    seen_roots: &mut HashSet<PathBuf>,
) -> Option<Vec<(String, PathBuf, fs::Metadata)>> {
    let key = fs::canonicalize(root).ok()?;
    if !key.starts_with(canon_top) || !seen_roots.insert(key.clone()) {
        return Some(Vec::new());
    }
    let git = locate_program("git", root).ok()?;
    let out = Command::new(git)
        .args([
            "ls-files",
            "-t",
            "--stage",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
        ])
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        seen_roots.remove(&key);
        return None;
    }

    let entries = parse_stage_entries(&out.stdout);
    let mut files = Vec::new();
    for (rel, (gitlink, nested)) in entries {
        let abs = root.join(&rel);
        let top_rel = abs
            .strip_prefix(top_root)
            .ok()
            .and_then(|p| p.to_str())
            .map(normalize_path_prefix)
            .unwrap_or_else(|| normalize_path_prefix(&rel));
        if skipped_path(&top_rel, includes) {
            continue;
        }
        let follow = (gitlink && cfg.follow_submodules) || (nested && cfg.follow_nested_repos);
        if follow {
            if !fs::symlink_metadata(&abs).is_ok_and(|m| !m.file_type().is_symlink() && m.is_dir())
                || !abs.join(".git").exists()
            {
                continue;
            }
            if let Some(child) =
                git_visible_files_recursive(&abs, top_root, canon_top, includes, cfg, seen_roots)
            {
                files.extend(child);
            } else {
                files.extend(walk_filesystem(&abs, top_root, canon_top, includes));
            }
            continue;
        }
        if let Some((safe_abs, meta)) = resolve_contained_file(root, canon_top, &rel) {
            files.push((top_rel, safe_abs, meta));
        }
    }
    seen_roots.remove(&key);
    Some(files)
}

fn walk_filesystem(
    dir: &Path,
    top_root: &Path,
    canon_top: &Path,
    includes: &HashSet<String>,
) -> Vec<(String, PathBuf, fs::Metadata)> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let full = entry.path();
        if ft.is_dir() {
            if !should_skip_dir(&name, includes) {
                out.extend(walk_filesystem(&full, top_root, canon_top, includes));
            }
        } else if ft.is_file() && !name.starts_with('.') {
            let Ok(meta) = fs::symlink_metadata(&full) else {
                continue;
            };
            if meta.file_type().is_symlink()
                || !meta.file_type().is_file()
                || meta.len() > MAX_FILE_BYTES
            {
                continue;
            }
            if !fs::canonicalize(&full).is_ok_and(|c| c.starts_with(canon_top)) {
                continue;
            }
            if let Ok(rel) = full.strip_prefix(top_root) {
                out.push((normalize_path_prefix(&rel.to_string_lossy()), full, meta));
            }
        }
    }
    out
}

fn is_code_extension(lower_rel: &str) -> bool {
    CODE_EXTENSIONS.iter().any(|ext| lower_rel.ends_with(ext))
}

fn ext_lower(rel: &str) -> String {
    let base = rel.rsplit('/').next().unwrap_or(rel);
    match base.rfind('.') {
        Some(idx) if idx > 0 => base[idx..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

fn mtime_ms_of(meta: &fs::Metadata) -> Option<f64> {
    let dur = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some((dur.as_secs() as f64) * 1000.0 + (dur.subsec_nanos() as f64) / 1_000_000.0)
}

pub(super) fn list_source_files(
    root: &Path,
    out_dir: &Path,
    only_dirs: &[String],
    extensions: &[String],
) -> Vec<(String, PathBuf, u64, f64)> {
    let cfg = read_build_config(root);
    let includes: HashSet<String> = cfg.include_dirs.iter().cloned().collect();
    let walk_root = canonical_walk_root(root);
    let canon_root = fs::canonicalize(&walk_root).unwrap_or_else(|_| walk_root.clone());

    let candidates = if cfg.follow_submodules || cfg.follow_nested_repos {
        let mut seen = HashSet::new();
        git_visible_files_recursive(
            &walk_root,
            &walk_root,
            &canon_root,
            &includes,
            &cfg,
            &mut seen,
        )
        .unwrap_or_else(|| walk_filesystem(&walk_root, &walk_root, &canon_root, &includes))
    } else {
        git_visible_files_shallow(&walk_root, &canon_root, &includes)
            .unwrap_or_else(|| walk_filesystem(&walk_root, &walk_root, &canon_root, &includes))
    };

    let selected: Option<Vec<String>> = (!extensions.is_empty()).then(|| {
        extensions
            .iter()
            .map(|e| {
                let t = e.trim().to_ascii_lowercase();
                if t.starts_with('.') {
                    t
                } else {
                    format!(".{t}")
                }
            })
            .collect()
    });
    let canon_out = fs::canonicalize(out_dir).ok();
    let abs_out = walk_root.join(out_dir.strip_prefix(root).unwrap_or(out_dir));

    let mut out = Vec::new();
    for (rel, abs, meta) in candidates {
        if abs == abs_out || abs.starts_with(&abs_out) {
            continue;
        }
        let Ok(canon_abs) = fs::canonicalize(&abs) else {
            continue;
        };
        if !canon_abs.starts_with(&canon_root)
            || canon_out
                .as_ref()
                .is_some_and(|co| canon_abs.starts_with(co))
        {
            continue;
        }
        let matches_ext = match &selected {
            Some(exts) => exts.contains(&ext_lower(&rel)),
            None => true,
        };
        let lower_rel = rel.to_ascii_lowercase();
        let supported =
            is_code_extension(&lower_rel) || (selected.is_none() && is_deploy_file(&rel));
        if !matches_ext || !supported {
            continue;
        }
        if !only_dirs.is_empty()
            && !only_dirs
                .iter()
                .any(|d| rel == *d || rel.starts_with(&format!("{d}/")))
        {
            continue;
        }
        let Some(mtime_ms) = mtime_ms_of(&meta) else {
            continue;
        };
        out.push((rel, abs, meta.len(), mtime_ms));
    }
    out
}
