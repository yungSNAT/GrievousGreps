//! Bounded, handle-based `Cargo.lock` discovery and strict TOML parsing.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use super::manifest::{ReadFileError, read_bounded_regular_file};

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
                if out.len() >= MAX_LOCKFILES {
                    *exhausted = true;
                    return;
                }
                out.push(canon);
            }
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

/// Strip `# comment` outside quoted strings on a single TOML line.
pub(super) fn strip_toml_comment(line: &str) -> &str {
    let mut in_double = false;
    let mut in_single = false;
    let mut escape = false;
    for (idx, ch) in line.char_indices() {
        if escape {
            escape = false;
            continue;
        }
        match ch {
            '\\' if in_double => escape = true,
            '"' if !in_single => in_double = !in_double,
            '\'' if !in_double => in_single = !in_single,
            '#' if !in_double && !in_single => return line[..idx].trim(),
            _ => {}
        }
    }
    line.trim()
}

fn parse_unicode_escape(chars: &mut std::str::Chars<'_>, digits: usize) -> Result<char, String> {
    let mut hex = String::with_capacity(digits);
    for _ in 0..digits {
        let Some(c) = chars.next() else {
            return Err("truncated unicode escape in TOML string".to_string());
        };
        if !c.is_ascii_hexdigit() {
            return Err(format!("invalid unicode escape digit '{c}' in TOML string"));
        }
        hex.push(c);
    }
    let code = u32::from_str_radix(&hex, 16)
        .map_err(|_| "invalid unicode scalar in TOML string".to_string())?;
    char::from_u32(code).ok_or_else(|| "invalid unicode scalar in TOML string".to_string())
}

/// Strict single-line TOML string parser matching `smol-toml` rules:
/// rejects unknown escapes, unterminated strings and trailing non-comment text.
pub(super) fn parse_toml_string_strict(raw: &str) -> Result<String, String> {
    let trimmed = strip_toml_comment(raw).trim();
    if let Some(rest) = trimmed.strip_prefix('\'') {
        let Some(end) = rest.find('\'') else {
            return Err("unterminated literal string in TOML".to_string());
        };
        if !rest[end + 1..].trim().is_empty() {
            return Err("unexpected trailing tokens after TOML string".to_string());
        }
        return Ok(rest[..end].to_string());
    }
    if !trimmed.starts_with('"') {
        return Err(format!("expected TOML string value, got \"{trimmed}\""));
    }
    let mut out = String::new();
    let mut chars = trimmed[1..].chars();
    let mut closed = false;
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                closed = true;
                break;
            }
            '\\' => match chars.next() {
                Some('\\') => out.push('\\'),
                Some('"') => out.push('"'),
                Some('b') => out.push('\u{0008}'),
                Some('f') => out.push('\u{000C}'),
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some('u') => out.push(parse_unicode_escape(&mut chars, 4)?),
                Some('U') => out.push(parse_unicode_escape(&mut chars, 8)?),
                Some(other) => return Err(format!("unknown TOML escape sequence '\\{other}'")),
                None => return Err("unterminated escape in TOML string".to_string()),
            },
            other => out.push(other),
        }
    }
    if !closed {
        return Err("unterminated basic string in TOML".to_string());
    }
    if !chars.as_str().trim().is_empty() {
        return Err("unexpected trailing tokens after TOML string".to_string());
    }
    Ok(out)
}

/// Decode a bare or quoted TOML key, failing closed on invalid key syntax.
fn parse_toml_key_strict(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty key in TOML".to_string());
    }
    if trimmed.starts_with('"') || trimmed.starts_with('\'') {
        return parse_toml_string_strict(trimmed);
    }
    if trimmed
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Ok(trimmed.to_string());
    }
    Err(format!("invalid TOML key \"{trimmed}\""))
}

fn split_toml_key_val(line: &str) -> Option<(&str, &str)> {
    let mut in_double = false;
    let mut in_single = false;
    let mut escape = false;
    for (idx, ch) in line.char_indices() {
        if escape {
            escape = false;
            continue;
        }
        match ch {
            '\\' if in_double => escape = true,
            '"' if !in_single => in_double = !in_double,
            '\'' if !in_double => in_single = !in_single,
            '=' if !in_double && !in_single => return Some((&line[..idx], &line[idx + 1..])),
            _ => {}
        }
    }
    None
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
