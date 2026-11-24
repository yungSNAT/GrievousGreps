//! Non-blocking bounded regular-file reading and strict TOML-validated
//! `Cargo.toml` manifest identity parsing.
//!
//! Assumes a stable repository/cache tree during a single CLI invocation; checks
//! `symlink_metadata` before opening to reject FIFOs/devices/symlinks without
//! blocking, then verifies `is_file()` on the opened handle and caps reads with
//! `Read::take(max_bytes + 1)`.

use std::fs::{self, File};
use std::io::{ErrorKind, Read};
use std::path::Path;

use super::lockfile::contained_canonical;
use super::toml_scalars::HeaderKind;
use super::toml_syntax::{TomlValue, parse_toml_document};

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

fn is_inline_workspace_true(pairs: &[(Vec<String>, TomlValue)]) -> bool {
    pairs
        .iter()
        .any(|(k, v)| k.len() == 1 && k[0] == "workspace" && matches!(v, TomlValue::Bool(true)))
}

/// Parse `[package]` `name` and `version` (including `version.workspace = true`),
/// validating the full TOML document fail-closed and rejecting array-of-tables
/// headers (`[[package]]`) as package identity.
pub(super) fn read_manifest_identity(
    manifest: &Path,
) -> Result<Option<ManifestIdentity>, ReadFileError> {
    let text = read_bounded_regular_file(manifest, MAX_MANIFEST_BYTES)?;
    let entries = parse_toml_document(&text)?;
    let mut name: Option<String> = None;
    let mut version: Option<String> = None;
    let mut workspace_version = false;

    for entry in entries {
        if entry.header_kind != HeaderKind::Table {
            continue;
        }
        let path: Vec<&str> = entry.full_path.iter().map(String::as_str).collect();
        match path.as_slice() {
            ["package", "name"] => {
                if let TomlValue::Str(s) = entry.value {
                    name = Some(s);
                }
            }
            ["package", "version"] => match entry.value {
                TomlValue::Str(s) => version = Some(s),
                TomlValue::InlineTable(pairs) if is_inline_workspace_true(&pairs) => {
                    workspace_version = true;
                }
                _ => {}
            },
            ["package", "version", "workspace"] => {
                if matches!(entry.value, TomlValue::Bool(true)) {
                    workspace_version = true;
                }
            }
            _ => {}
        }
    }

    Ok(name.map(|n| ManifestIdentity {
        name: n,
        version,
        workspace_version,
    }))
}

fn extract_workspace_package_version(text: &str) -> Result<Option<String>, ReadFileError> {
    let entries = parse_toml_document(text)?;
    let mut found: Option<String> = None;
    for entry in entries {
        if entry.header_kind != HeaderKind::Table {
            continue;
        }
        let path: Vec<&str> = entry.full_path.iter().map(String::as_str).collect();
        if path.as_slice() == ["workspace", "package", "version"] {
            match entry.value {
                TomlValue::Str(s) => found = Some(s),
                _ => {
                    return Err(ReadFileError::Other(
                        "invalid non-string workspace.package.version".to_string(),
                    ));
                }
            }
        }
    }
    Ok(found)
}

/// Resolve `[workspace.package] version = "..."` by walking up from `crate_dir`
/// without escaping `boundary`, failing closed on unparseable or broken nearer
/// manifests (including dangling symlinks) and propagating `BudgetExhausted`.
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
        match fs::symlink_metadata(&manifest) {
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => {
                return Err(ReadFileError::Other(format!(
                    "cannot inspect workspace manifest {}: {e}",
                    manifest.display()
                )));
            }
            Ok(_) => {
                let Some(canon_m) = contained_canonical(&manifest, &canon_bound) else {
                    return Err(ReadFileError::Other(format!(
                        "workspace manifest {} cannot be resolved within boundary",
                        manifest.display()
                    )));
                };
                let text = read_bounded_regular_file(&canon_m, MAX_MANIFEST_BYTES)?;
                if let Some(ver) = extract_workspace_package_version(&text)? {
                    return Ok(Some(ver));
                }
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
