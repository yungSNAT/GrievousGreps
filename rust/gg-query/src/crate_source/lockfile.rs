//! Bounded, handle-based `Cargo.lock` discovery and strict TOML parsing.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use super::manifest::{ReadFileError, read_bounded_regular_file};
use super::toml_strings::{parse_basic_string, parse_literal_string, parse_simple_toml_key};

pub(super) const MAX_LOCKFILE_BYTES: u64 = 16 * 1024 * 1024;
pub(super) const MAX_LOCKFILES: usize = 16;
pub(super) const MAX_SCAN_DEPTH: usize = 2;
pub(super) const MAX_SCAN_ENTRIES: usize = 512;

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
    let mut visited = 0_usize;
    let mut exhausted = false;
    scan_lockfiles(
        repo_canon,
        repo_canon,
        0,
        &mut found,
        &mut visited,
        &mut exhausted,
    );
    if exhausted {
        return Err(format!(
            "lockfile scan budget exceeded under {}",
            repo_canon.display()
        ));
    }
    found.sort();
    if found.is_empty() {
        return Err(format!(
            "no Cargo.lock found under {}",
            repo_canon.display()
        ));
    }
    Ok(found)
}

fn scan_lockfiles(
    repo_canon: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<PathBuf>,
    visited: &mut usize,
    exhausted: &mut bool,
) {
    if depth > MAX_SCAN_DEPTH || *exhausted {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        *visited += 1;
        if *visited > MAX_SCAN_ENTRIES {
            *exhausted = true;
            return;
        }
        let Some(ft) = entry.file_type().ok().filter(|ft| !ft.is_symlink()) else {
            continue;
        };
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let path = entry.path();
        if ft.is_file()
            && name_str == "Cargo.lock"
            && let Some(canon) = contained_canonical(&path, repo_canon)
        {
            if out.len() >= MAX_LOCKFILES {
                *exhausted = true;
                return;
            }
            out.push(canon);
        } else if ft.is_dir() && !SKIP_DIRS.contains(&name_str.as_ref()) {
            subdirs.push(path);
        }
    }
    subdirs.sort();
    for sub in subdirs {
        scan_lockfiles(repo_canon, &sub, depth + 1, out, visited, exhausted);
        if *exhausted {
            return;
        }
    }
}

fn find_outside_toml_quotes(line: &str, needle: char) -> Option<usize> {
    let (mut in_double, mut in_single, mut escape) = (false, false, false);
    for (idx, ch) in line.char_indices() {
        if escape {
            escape = false;
            continue;
        }
        match ch {
            '\\' if in_double => escape = true,
            '"' if !in_single => in_double = !in_double,
            '\'' if !in_double => in_single = !in_single,
            c if c == needle && !in_double && !in_single => return Some(idx),
            _ => {}
        }
    }
    None
}

/// Strip `# comment` outside quoted strings on a single TOML line.
pub(super) fn strip_toml_comment(line: &str) -> &str {
    match find_outside_toml_quotes(line, '#') {
        Some(idx) => line[..idx].trim(),
        None => line.trim(),
    }
}

/// Strict single-line TOML string parser shared with `toml_strings`.
pub(super) fn parse_toml_string_strict(raw: &str) -> Result<String, String> {
    let trimmed = strip_toml_comment(raw).trim();
    let mut pos = 0;
    let val = match trimmed.as_bytes().first() {
        Some(b'\'') => parse_literal_string(trimmed, &mut pos, true),
        Some(b'"') => parse_basic_string(trimmed, &mut pos, true),
        _ => return Err(format!("expected TOML string value, got \"{trimmed}\"")),
    }
    .map_err(ReadFileError::into_string)?;
    if !trimmed[pos..].trim().is_empty() {
        return Err("unexpected trailing tokens after TOML string".to_string());
    }
    Ok(val)
}

/// Decode a bare or quoted TOML key, failing closed on invalid key syntax.
fn parse_toml_key_strict(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty key in TOML".to_string());
    }
    let mut pos = 0;
    let key = parse_simple_toml_key(trimmed, &mut pos).map_err(ReadFileError::into_string)?;
    if !trimmed[pos..].trim().is_empty() {
        return Err(format!("invalid TOML key \"{trimmed}\""));
    }
    Ok(key)
}

fn split_toml_key_val(line: &str) -> Option<(&str, &str)> {
    let idx = find_outside_toml_quotes(line, '=')?;
    Some((&line[..idx], &line[idx + 1..]))
}

fn flush_pkg(
    packages: &mut Vec<LockPackage>,
    name: &mut Option<String>,
    ver: &mut Option<String>,
    src: &mut Option<String>,
    seen_keys: &mut HashSet<String>,
) {
    if let (Some(n), Some(v)) = (name.take(), ver.take()) {
        packages.push(LockPackage {
            name: n,
            version: v,
            source: src.take(),
        });
    } else {
        *name = None;
        *ver = None;
        *src = None;
    }
    seen_keys.clear();
}

fn array_bracket_delta(line: &str) -> isize {
    let mut in_double = false;
    let mut in_single = false;
    let mut escape = false;
    let mut delta = 0_isize;
    for ch in line.chars() {
        if escape {
            escape = false;
            continue;
        }
        match ch {
            '\\' if in_double => escape = true,
            '"' if !in_single => in_double = !in_double,
            '\'' if !in_double => in_single = !in_single,
            '[' if !in_double && !in_single => delta += 1,
            ']' if !in_double && !in_single => delta -= 1,
            _ => {}
        }
    }
    delta
}

pub(super) fn parse_cargo_lock(path: &Path) -> Result<Vec<LockPackage>, String> {
    let text =
        read_bounded_regular_file(path, MAX_LOCKFILE_BYTES).map_err(ReadFileError::into_string)?;
    let mut packages = Vec::new();
    let mut in_pkg = false;
    let mut cur_name: Option<String> = None;
    let mut cur_ver: Option<String> = None;
    let mut cur_src: Option<String> = None;
    let mut seen_keys: HashSet<String> = HashSet::new();
    let mut array_depth = 0_isize;

    for raw_line in text.lines() {
        let stripped = strip_toml_comment(raw_line);
        if stripped.is_empty() {
            continue;
        }
        if array_depth > 0 {
            array_depth = (array_depth + array_bracket_delta(stripped)).max(0);
            continue;
        }
        if stripped == "[[package]]" {
            flush_pkg(
                &mut packages,
                &mut cur_name,
                &mut cur_ver,
                &mut cur_src,
                &mut seen_keys,
            );
            in_pkg = true;
            continue;
        }
        if stripped.starts_with('[') {
            flush_pkg(
                &mut packages,
                &mut cur_name,
                &mut cur_ver,
                &mut cur_src,
                &mut seen_keys,
            );
            in_pkg = false;
            continue;
        }
        if !in_pkg {
            continue;
        }
        if let Some((raw_key, raw_val)) = split_toml_key_val(stripped) {
            let key = parse_toml_key_strict(raw_key)?;
            if !seen_keys.insert(key.clone()) {
                return Err(format!(
                    "duplicate key \"{key}\" in [[package]] table in {}",
                    path.display()
                ));
            }
            match key.as_str() {
                "name" => cur_name = Some(parse_toml_string_strict(raw_val)?),
                "version" => cur_ver = Some(parse_toml_string_strict(raw_val)?),
                "source" => cur_src = Some(parse_toml_string_strict(raw_val)?),
                _ => {
                    array_depth = array_bracket_delta(raw_val).max(0);
                }
            }
        }
    }
    flush_pkg(
        &mut packages,
        &mut cur_name,
        &mut cur_ver,
        &mut cur_src,
        &mut seen_keys,
    );
    Ok(packages)
}
