//! Non-blocking bounded regular-file reading and multiline-string-aware
//! `Cargo.toml` manifest identity parsing.
//!
//! Assumes a stable repository/cache tree during a single CLI invocation; checks
//! `symlink_metadata` before opening to reject FIFOs/devices/symlinks without
//! blocking, then verifies `is_file()` on the opened handle and caps reads with
//! `Read::take(max_bytes + 1)`.

use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use super::lockfile::{contained_canonical, parse_toml_string_strict, strip_toml_comment};

pub(super) const MAX_MANIFEST_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone)]
pub(super) enum ReadFileError {
    BudgetExhausted(String),
    Other(String),
}

impl ReadFileError {
    pub fn into_string(self) -> String {
        match self {
            Self::BudgetExhausted(m) | Self::Other(m) => m,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct ManifestIdentity {
    pub name: String,
    pub version: Option<String>,
    pub workspace_version: bool,
}

/// Reject non-regular files (including FIFOs and symlinks) before opening, then
/// open by handle and read at most `max_bytes` UTF-8 bytes.
pub(super) fn read_bounded_regular_file(
    path: &Path,
    max_bytes: u64,
) -> Result<String, ReadFileError> {
    let pre = fs::symlink_metadata(path)
        .map_err(|e| ReadFileError::Other(format!("cannot stat {}: {e}", path.display())))?;
    if !pre.file_type().is_file() {
        return Err(ReadFileError::Other(format!(
            "{} is not a regular file",
            path.display()
        )));
    }
    let file = File::open(path)
        .map_err(|e| ReadFileError::Other(format!("cannot open {}: {e}", path.display())))?;
    let meta = file
        .metadata()
        .map_err(|e| ReadFileError::Other(format!("cannot stat {}: {e}", path.display())))?;
    if !meta.is_file() {
        return Err(ReadFileError::Other(format!(
            "{} is not a regular file",
            path.display()
        )));
    }
    let mut buf = Vec::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut buf)
        .map_err(|e| ReadFileError::Other(format!("cannot read {}: {e}", path.display())))?;
    if (buf.len() as u64) > max_bytes {
        return Err(ReadFileError::BudgetExhausted(format!(
            "{} exceeds {max_bytes} byte safety cap",
            path.display()
        )));
    }
    String::from_utf8(buf)
        .map_err(|e| ReadFileError::Other(format!("{} is not valid UTF-8: {e}", path.display())))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MultilineDelim {
    Basic,
    Literal,
}

/// Scan a single line updating multiline string state (`"""` or `'''`).
/// Returns `Ok(true)` if the line started inside a multiline string (and must
/// not be interpreted as a TOML header or key-value pair), or `Err` on illegal
/// 6+ consecutive unescaped quotes in a multiline string or unterminated
/// single-line strings.
fn advance_multiline_state(
    line: &str,
    state: &mut Option<MultilineDelim>,
) -> Result<bool, ReadFileError> {
    let started_inside = state.is_some();
    let bytes = line.as_bytes();
    let mut i = 0_usize;
    let mut in_single_line: Option<u8> = None;

    while i < bytes.len() {
        if let Some(delim) = *state {
            match delim {
                MultilineDelim::Basic => {
                    if bytes[i] == b'\\' {
                        i = (i + 2).min(bytes.len());
                        continue;
                    }
                    if bytes[i] == b'"' {
                        let mut run = 0;
                        while i + run < bytes.len() && bytes[i + run] == b'"' {
                            run += 1;
                        }
                        if run >= 6 {
                            return Err(ReadFileError::Other(
                                "invalid run of 6 or more quotes in multiline basic string"
                                    .to_string(),
                            ));
                        }
                        if run >= 3 {
                            *state = None;
                        }
                        i += run;
                        continue;
                    }
                    i += 1;
                }
                MultilineDelim::Literal => {
                    if bytes[i] == b'\'' {
                        let mut run = 0;
                        while i + run < bytes.len() && bytes[i + run] == b'\'' {
                            run += 1;
                        }
                        if run >= 6 {
                            return Err(ReadFileError::Other(
                                "invalid run of 6 or more quotes in multiline literal string"
                                    .to_string(),
                            ));
                        }
                        if run >= 3 {
                            *state = None;
                        }
                        i += run;
                        continue;
                    }
                    i += 1;
                }
            }
            continue;
        }

        if let Some(q) = in_single_line {
            if q == b'"' && bytes[i] == b'\\' {
                i = (i + 2).min(bytes.len());
                continue;
            }
            if bytes[i] == q {
                in_single_line = None;
            }
            i += 1;
            continue;
        }

        if bytes[i] == b'#' {
            break;
        }
        if bytes[i..].starts_with(b"\"\"\"") {
            *state = Some(MultilineDelim::Basic);
            i += 3;
            continue;
        }
        if bytes[i..].starts_with(b"'''") {
            *state = Some(MultilineDelim::Literal);
            i += 3;
            continue;
        }
        if bytes[i] == b'"' || bytes[i] == b'\'' {
            in_single_line = Some(bytes[i]);
        }
        i += 1;
    }

    if in_single_line.is_some() {
        return Err(ReadFileError::Other(
            "unterminated single-line string in Cargo.toml".to_string(),
        ));
    }

    Ok(started_inside)
}

fn is_workspace_version_inline(raw_val: &str) -> bool {
    let s = strip_toml_comment(raw_val).trim();
    if !(s.starts_with('{') && s.ends_with('}')) {
        return false;
    }
    let inner = &s[1..s.len() - 1];
    inner.split(',').any(|part| {
        part.split_once('=')
            .is_some_and(|(k, v)| k.trim() == "workspace" && v.trim() == "true")
    })
}

/// Parse `[package]` `name` and `version` (including `version.workspace = true`),
/// skipping content inside multiline TOML strings and failing closed if any
/// multiline string is unterminated or the file exceeds `MAX_MANIFEST_BYTES`.
pub(super) fn read_manifest_identity(
    manifest: &Path,
) -> Result<Option<ManifestIdentity>, ReadFileError> {
    let text = read_bounded_regular_file(manifest, MAX_MANIFEST_BYTES)?;
    let mut section = String::new();
    let mut name: Option<String> = None;
    let mut version: Option<String> = None;
    let mut workspace_version = false;
    let mut ml_state: Option<MultilineDelim> = None;

    for raw_line in text.lines() {
        let was_in_ml = advance_multiline_state(raw_line, &mut ml_state)?;
        if was_in_ml {
            continue;
        }
        let stripped = strip_toml_comment(raw_line);
        if stripped.is_empty() {
            continue;
        }
        if stripped.starts_with('[') && stripped.ends_with(']') {
            section = stripped[1..stripped.len() - 1].trim().to_string();
            continue;
        }
        let Some((raw_k, raw_v)) = stripped.split_once('=') else {
            continue;
        };
        let k = raw_k.trim();
        let v = raw_v.trim();
        if ml_state.is_some() {
            continue;
        }
        if section == "package" {
            if k == "name" {
                name = parse_toml_string_strict(v).ok();
            } else if k == "version" {
                if is_workspace_version_inline(v) {
                    workspace_version = true;
                } else {
                    version = parse_toml_string_strict(v).ok();
                }
            } else if k == "version.workspace" && v == "true" {
                workspace_version = true;
            }
        } else if section == "package.version" && k == "workspace" && v == "true" {
            workspace_version = true;
        }
    }

    if ml_state.is_some() {
        return Err(ReadFileError::Other(format!(
            "unterminated multiline string in {}",
            manifest.display()
        )));
    }

    Ok(name.map(|n| ManifestIdentity {
        name: n,
        version,
        workspace_version,
    }))
}

fn extract_workspace_package_version(text: &str) -> Result<Option<String>, ReadFileError> {
    let mut in_ws_pkg = false;
    let mut found: Option<String> = None;
    let mut ml_state: Option<MultilineDelim> = None;

    for raw_line in text.lines() {
        let was_in_ml = advance_multiline_state(raw_line, &mut ml_state)?;
        if was_in_ml {
            continue;
        }
        let stripped = strip_toml_comment(raw_line);
        if stripped.is_empty() {
            continue;
        }
        if stripped.starts_with('[') && stripped.ends_with(']') {
            in_ws_pkg = stripped[1..stripped.len() - 1].trim() == "workspace.package";
            continue;
        }
        if ml_state.is_some() {
            continue;
        }
        if in_ws_pkg
            && let Some((k, v)) = stripped.split_once('=')
            && k.trim() == "version"
        {
            found = Some(parse_toml_string_strict(v).map_err(|e| {
                ReadFileError::Other(format!("invalid workspace.package.version: {e}"))
            })?);
        }
    }

    if ml_state.is_some() {
        return Err(ReadFileError::Other(
            "unterminated multiline string in workspace Cargo.toml".to_string(),
        ));
    }
    Ok(found)
}

/// Resolve `[workspace.package] version = "..."` by walking up from `crate_dir`
/// without escaping `boundary`, failing closed on unparseable nearer manifests
/// and propagating `BudgetExhausted` cleanly.
pub(super) fn resolve_workspace_version(
    crate_dir: &Path,
    boundary: &Path,
) -> Result<Option<String>, ReadFileError> {
    let Ok(canon_bound) = fs::canonicalize(boundary) else {
        return Ok(None);
    };
    let Ok(mut cur) = fs::canonicalize(crate_dir) else {
        return Ok(None);
    };
    for _ in 0..8 {
        if !cur.starts_with(&canon_bound) {
            break;
        }
        let manifest = cur.join("Cargo.toml");
        if let Some(canon_m) = contained_canonical(&manifest, &canon_bound) {
            let text = read_bounded_regular_file(&canon_m, MAX_MANIFEST_BYTES)?;
            if let Some(ver) = extract_workspace_package_version(&text)? {
                return Ok(Some(ver));
            }
        }
        if cur == canon_bound {
            break;
        }
        let Some(parent) = cur.parent() else {
            break;
        };
        cur = parent.to_path_buf();
    }
    Ok(None)
}
