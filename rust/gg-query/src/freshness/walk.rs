//! Source-file discovery for freshness probing (`src/graph/source-files.ts`).

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

use serde::Deserialize;

use crate::graph::{is_deploy_file, normalize_path_prefix};
use crate::program::locate_program;
use crate::safe_io::{
    RootAnchor, anchor_root, open_contained_anchored, read_contained_anchored_to_string,
};

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

pub(super) struct WalkContext {
    pub(super) walk_root: PathBuf,
    pub(super) canon_root: PathBuf,
    pub(super) anchor: RootAnchor,
}

impl WalkContext {
    pub(super) fn open(root: &Path) -> Option<Self> {
        let walk_root = canonical_walk_root(root);
        let (anchor, canon_root) = anchor_root(&walk_root).ok()?;
        Some(Self {
            walk_root,
            canon_root,
            anchor,
        })
    }
}

fn read_build_config(ctx: &WalkContext) -> BuildConfig {
    let Some(raw) = read_contained_anchored_to_string(
        &ctx.canon_root,
        &ctx.anchor,
        ".graft/config.json",
        Some(1024 * 1024),
    ) else {
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

/// Verify containment through an anchored handle open and return leaf metadata.
fn stat_contained_file(ctx: &WalkContext, rel: &str) -> Option<fs::Metadata> {
    open_contained_anchored(&ctx.canon_root, &ctx.anchor, rel, Some(MAX_FILE_BYTES)).map(|(_, m)| m)
}

fn git_visible_files_shallow(
    ctx: &WalkContext,
    includes: &HashSet<String>,
) -> Option<Vec<(String, fs::Metadata)>> {
    let git = locate_program("git", &ctx.walk_root).ok()?;
    let out = Command::new(git)
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
        ])
        .current_dir(&ctx.walk_root)
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
        let Some(meta) = stat_contained_file(ctx, rel) else {
            continue;
        };
        files.push((normalize_path_prefix(rel), meta));
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
    dir: &Path,
    ctx: &WalkContext,
    includes: &HashSet<String>,
    cfg: &BuildConfig,
    seen_roots: &mut HashSet<PathBuf>,
) -> Option<Vec<(String, fs::Metadata)>> {
    let key = fs::canonicalize(dir).ok()?;
    if !key.starts_with(&ctx.canon_root) || !seen_roots.insert(key.clone()) {
        return Some(Vec::new());
    }
    let git = locate_program("git", dir).ok()?;
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
        .current_dir(dir)
        .output()
        .ok()?;
    if !out.status.success() {
        seen_roots.remove(&key);
        return None;
    }

    let entries = parse_stage_entries(&out.stdout);
    let mut files = Vec::new();
    for (rel, (gitlink, nested)) in entries {
        let abs = dir.join(&rel);
        let top_rel = abs
            .strip_prefix(&ctx.walk_root)
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
            if let Some(child) = git_visible_files_recursive(&abs, ctx, includes, cfg, seen_roots) {
                files.extend(child);
            } else {
                files.extend(walk_filesystem(&abs, ctx, includes));
            }
            continue;
        }
        if let Some(meta) = stat_contained_file(ctx, &top_rel) {
            files.push((top_rel, meta));
        }
    }
    seen_roots.remove(&key);
    Some(files)
}

fn walk_filesystem(
    dir: &Path,
    ctx: &WalkContext,
    includes: &HashSet<String>,
) -> Vec<(String, fs::Metadata)> {
    let mut out = Vec::new();
    let Ok(dir_meta) = fs::symlink_metadata(dir) else {
        return out;
    };
    if dir_meta.file_type().is_symlink() || !dir_meta.is_dir() {
        return out;
    }
    if !fs::canonicalize(dir).is_ok_and(|c| c.starts_with(&ctx.canon_root)) {
        return out;
    }
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
                out.extend(walk_filesystem(&full, ctx, includes));
            }
        } else if ft.is_file()
            && !name.starts_with('.')
            && let Ok(rel) = full.strip_prefix(&ctx.walk_root)
        {
            let norm = normalize_path_prefix(&rel.to_string_lossy());
            if let Some(meta) = stat_contained_file(ctx, &norm) {
                out.push((norm, meta));
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
    ctx: &WalkContext,
    out_dir: &Path,
    only_dirs: &[String],
    extensions: &[String],
) -> Vec<(String, u64, f64)> {
    let cfg = read_build_config(ctx);
    let includes: HashSet<String> = cfg.include_dirs.iter().cloned().collect();

    let candidates = if cfg.follow_submodules || cfg.follow_nested_repos {
        let mut seen = HashSet::new();
        git_visible_files_recursive(&ctx.walk_root, ctx, &includes, &cfg, &mut seen)
            .unwrap_or_else(|| walk_filesystem(&ctx.walk_root, ctx, &includes))
    } else {
        git_visible_files_shallow(ctx, &includes)
            .unwrap_or_else(|| walk_filesystem(&ctx.walk_root, ctx, &includes))
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
    let out_rel = canon_out
        .as_ref()
        .and_then(|co| co.strip_prefix(&ctx.canon_root).ok())
        .or_else(|| out_dir.strip_prefix(&ctx.walk_root).ok())
        .or_else(|| out_dir.strip_prefix(root).ok())
        .and_then(|p| p.to_str())
        .map(normalize_path_prefix)
        .filter(|s| !s.is_empty());

    let mut out = Vec::new();
    for (rel, meta) in candidates {
        if out_rel
            .as_ref()
            .is_some_and(|prefix| rel == *prefix || rel.starts_with(&format!("{prefix}/")))
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
        out.push((rel, meta.len(), mtime_ms));
    }
    out
}
