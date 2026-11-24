//! Bounded, fail-closed `Cargo.lock` and `Cargo.toml` readers for `crate-source`.

use std::fs;
use std::path::{Path, PathBuf};

pub(super) const MAX_LOCKFILE_BYTES: u64 = 16 * 1024 * 1024;
pub(super) const MAX_LOCKFILES: usize = 16;
pub(super) const MAX_SCAN_DEPTH: usize = 2;

pub(super) const SKIP_DIRS: &[&str] = &[
    ".git",
    "target",
    "node_modules",
    ".trail",
    "graft",
    "dist",
    "vendor",
];

#[derive(Debug, Clone)]
pub(super) struct LockPackage {
    pub name: String,
    pub version: String,
    pub source: Option<String>,
}

pub(super) fn contained_canonical(candidate: &Path, boundary: &Path) -> Option<PathBuf> {
    let canon_bound = fs::canonicalize(boundary).ok()?;
    let canon_cand = fs::canonicalize(candidate).ok()?;
    canon_cand.starts_with(&canon_bound).then_some(canon_cand)
}

pub(super) fn discover_lockfiles(
    repo_canon: &Path,
    explicit: Option<&Path>,
) -> Result<Vec<PathBuf>, String> {
    if let Some(lf) = explicit {
        let joined = if lf.is_absolute() {
            lf.to_path_buf()
        } else {
            repo_canon.join(lf)
        };
        let canon = contained_canonical(&joined, repo_canon).ok_or_else(|| {
            format!(
                "lockfile {} is missing or escapes repository root {}",
                lf.display(),
                repo_canon.display()
            )
        })?;
        if !canon.is_file() {
            return Err(format!("lockfile {} is not a regular file", lf.display()));
        }
        return Ok(vec![canon]);
    }

    let root_lock = repo_canon.join("Cargo.lock");
    if let Some(canon) = contained_canonical(&root_lock, repo_canon)
        && canon.is_file()
    {
        return Ok(vec![canon]);
    }

    let mut found = Vec::new();
    scan_lockfiles(repo_canon, repo_canon, 0, &mut found);
    found.sort();
    if found.is_empty() {
        return Err(format!(
            "no Cargo.lock found under {}",
            repo_canon.display()
        ));
    }
    Ok(found)
}

fn scan_lockfiles(repo_canon: &Path, dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_SCAN_DEPTH || out.len() >= MAX_LOCKFILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_symlink() {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let path = entry.path();
        if ft.is_file() && name_str == "Cargo.lock" {
            if let Some(canon) = contained_canonical(&path, repo_canon) {
                out.push(canon);
                if out.len() >= MAX_LOCKFILES {
                    return;
                }
            }
        } else if ft.is_dir() && !SKIP_DIRS.contains(&name_str.as_ref()) {
            subdirs.push(path);
        }
    }
    subdirs.sort();
    for sub in subdirs {
        scan_lockfiles(repo_canon, &sub, depth + 1, out);
    }
}

fn unquote_toml_string(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.len() < 2 {
        return None;
    }
    if trimmed.starts_with('\'') && trimmed.ends_with('\'') {
        return Some(trimmed[1..trimmed.len() - 1].to_string());
    }
    if !trimmed.starts_with('"') {
        return None;
    }
    let mut out = String::new();
    let mut chars = trimmed[1..].chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => match chars.next()? {
                '\\' => out.push('\\'),
                '"' => out.push('"'),
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                other => out.push(other),
            },
            other => out.push(other),
        }
    }
    None
}

pub(super) fn parse_cargo_lock(path: &Path) -> Result<Vec<LockPackage>, String> {
    let meta = fs::metadata(path).map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
    if meta.len() > MAX_LOCKFILE_BYTES {
        return Err(format!(
            "Cargo.lock {} exceeds {MAX_LOCKFILE_BYTES} byte safety cap",
            path.display()
        ));
    }
    let text =
        fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut packages = Vec::new();
    let mut in_pkg = false;
    let mut cur_name: Option<String> = None;
    let mut cur_ver: Option<String> = None;
    let mut cur_src: Option<String> = None;

    let flush = |pkgs: &mut Vec<LockPackage>,
                 name: &mut Option<String>,
                 ver: &mut Option<String>,
                 src: &mut Option<String>| {
        if let (Some(n), Some(v)) = (name.take(), ver.take()) {
            pkgs.push(LockPackage {
                name: n,
                version: v,
                source: src.take(),
            });
        } else {
            *name = None;
            *ver = None;
            *src = None;
        }
    };

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line == "[[package]]" {
            flush(&mut packages, &mut cur_name, &mut cur_ver, &mut cur_src);
            in_pkg = true;
            continue;
        }
        if line.starts_with('[') {
            flush(&mut packages, &mut cur_name, &mut cur_ver, &mut cur_src);
            in_pkg = false;
            continue;
        }
        if !in_pkg {
            continue;
        }
        if let Some((key, val)) = line.split_once('=') {
            match key.trim() {
                "name" => cur_name = unquote_toml_string(val),
                "version" => cur_ver = unquote_toml_string(val),
                "source" => cur_src = unquote_toml_string(val),
                _ => {}
            }
        }
    }
    flush(&mut packages, &mut cur_name, &mut cur_ver, &mut cur_src);
    Ok(packages)
}

fn manifest_package_name(manifest: &Path) -> Option<String> {
    let text = fs::read_to_string(manifest).ok()?;
    let mut in_pkg = false;
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            in_pkg = line == "[package]";
            continue;
        }
        if in_pkg
            && let Some((k, v)) = line.split_once('=')
            && k.trim() == "name"
        {
            return unquote_toml_string(v);
        }
    }
    None
}

pub(super) fn find_crate_dir_under(
    root: &Path,
    boundary: &Path,
    crate_name: &str,
    max_depth: usize,
) -> Option<PathBuf> {
    let mut queue: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    let mut visited = 0_usize;
    while let Some((dir, depth)) = queue.pop() {
        visited += 1;
        if visited > 256 {
            break;
        }
        let Some(canon_dir) = contained_canonical(&dir, boundary) else {
            continue;
        };
        let manifest = canon_dir.join("Cargo.toml");
        if let Some(canon_manifest) = contained_canonical(&manifest, boundary)
            && canon_manifest.is_file()
            && manifest_package_name(&canon_manifest).as_deref() == Some(crate_name)
        {
            return Some(canon_dir);
        }
        if depth >= max_depth {
            continue;
        }
        let Ok(entries) = fs::read_dir(&canon_dir) else {
            continue;
        };
        let mut children: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| {
                e.file_type()
                    .is_ok_and(|ft| ft.is_dir() && !ft.is_symlink())
                    && !SKIP_DIRS.contains(&e.file_name().to_string_lossy().as_ref())
            })
            .map(|e| e.path())
            .collect();
        children.sort();
        for c in children.into_iter().rev() {
            queue.push((c, depth + 1));
        }
    }
    None
}
