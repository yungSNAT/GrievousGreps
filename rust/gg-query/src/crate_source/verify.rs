//! Registry and path crate identity verification and bounded tree search.

use std::fs;
use std::net::Ipv6Addr;
use std::path::{Path, PathBuf};

use super::git::extract_git_origin_url;
use super::lockfile::{MAX_SCAN_ENTRIES, SKIP_DIRS, contained_canonical};
use super::manifest::{ReadFileError, read_manifest_identity, resolve_workspace_version};

const MAX_REGISTRY_DIRS: usize = 64;

pub(super) struct VerifiedDir {
    pub dir: PathBuf,
    pub manifest_path: PathBuf,
    pub src_dir: Option<PathBuf>,
}

pub(super) enum ResolveOutcome {
    Found(VerifiedDir),
    NotCached,
    Ambiguous(String),
    Unresolved(String),
    BudgetExhausted(String),
}

pub(super) enum SearchResult {
    Matches(Vec<VerifiedDir>),
    Unresolved(String),
    BudgetExhausted(String),
}

enum VerifyResult {
    Matched(VerifiedDir),
    NotMatched,
    Unresolved(String),
    BudgetExhausted(String),
}

fn verify_manifest_identity(
    dir: &Path,
    boundary: &Path,
    expected_name: &str,
    expected_version: &str,
) -> VerifyResult {
    let Some(canon_dir) = contained_canonical(dir, boundary) else {
        return VerifyResult::NotMatched;
    };
    if !canon_dir.is_dir() {
        return VerifyResult::NotMatched;
    }
    let manifest = canon_dir.join("Cargo.toml");
    let Some(canon_manifest) = contained_canonical(&manifest, &canon_dir) else {
        return VerifyResult::NotMatched;
    };
    if !fs::symlink_metadata(&canon_manifest).is_ok_and(|m| m.file_type().is_file()) {
        return VerifyResult::NotMatched;
    }
    let ident = match read_manifest_identity(&canon_manifest) {
        Ok(Some(id)) => id,
        Ok(None) | Err(ReadFileError::Other(_)) => return VerifyResult::NotMatched,
        Err(ReadFileError::BudgetExhausted(m)) => return VerifyResult::BudgetExhausted(m),
    };
    if ident.name != expected_name {
        return VerifyResult::NotMatched;
    }
    let actual_version = match ident.version {
        Some(v) => v,
        None if ident.workspace_version => match resolve_workspace_version(&canon_dir, boundary) {
            Ok(Some(v)) => v,
            Ok(None) => return VerifyResult::NotMatched,
            Err(ReadFileError::Other(m)) => return VerifyResult::Unresolved(m),
            Err(ReadFileError::BudgetExhausted(m)) => return VerifyResult::BudgetExhausted(m),
        },
        None => return VerifyResult::NotMatched,
    };
    if actual_version != expected_version {
        return VerifyResult::NotMatched;
    }
    let src_candidate = canon_dir.join("src");
    let src_dir = contained_canonical(&src_candidate, &canon_dir).filter(|p| p.is_dir());
    VerifyResult::Matched(VerifiedDir {
        dir: canon_dir,
        manifest_path: canon_manifest,
        src_dir,
    })
}

fn is_valid_url_host(host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    if host.starts_with('[') && host.ends_with(']') {
        let inner = &host[1..host.len() - 1];
        return inner.parse::<Ipv6Addr>().is_ok();
    }
    if host.starts_with('.') || host.ends_with('.') || host.contains("..") {
        return false;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

fn parse_registry_authority(authority: &str, default_port: u16) -> Option<String> {
    if authority.is_empty()
        || authority
            .bytes()
            .any(|b| b <= 0x20 || b == 0x7f || matches!(b, b'@' | b'?' | b'#' | b'\\'))
    {
        return None;
    }
    let (host, port_str) = if authority.starts_with('[') {
        let close = authority.find(']')?;
        let host = &authority[..=close];
        let rest = &authority[close + 1..];
        if rest.is_empty() {
            (host, None)
        } else {
            let p = rest.strip_prefix(':')?;
            (host, Some(p))
        }
    } else {
        if authority.contains('[') || authority.contains(']') {
            return None;
        }
        match authority.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        }
    };
    if !is_valid_url_host(host) {
        return None;
    }
    let port = match port_str {
        Some(p) => {
            if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let n: u16 = p.parse().ok()?;
            if n == 0 {
                return None;
            }
            Some(n)
        }
        None => None,
    };
    let host_low = if host.starts_with('[') && host.ends_with(']') {
        let addr: Ipv6Addr = host[1..host.len() - 1].parse().ok()?;
        format!("[{addr}]")
    } else {
        host.to_ascii_lowercase()
    };
    Some(match port {
        Some(p) if p != default_port => format!("{host_low}:{p}"),
        _ => host_low,
    })
}

fn normalise_registry_url(raw: &str) -> Option<String> {
    let no_sparse = raw.strip_prefix("sparse+").unwrap_or(raw);
    if no_sparse
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '?' | '#' | '\\'))
    {
        return None;
    }
    let (scheme, rest) = no_sparse.split_once("://")?;
    let scheme_low = scheme.to_ascii_lowercase();
    let default_port = match scheme_low.as_str() {
        "https" => 443,
        "http" => 80,
        _ => return None,
    };
    let (authority, path_raw) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, ""),
    };
    let norm_authority = parse_registry_authority(authority, default_port)?;
    let path_clean = path_raw.trim_end_matches('/');
    let path_no_git = path_clean.strip_suffix(".git").unwrap_or(path_clean);
    Some(format!("{scheme_low}://{norm_authority}{path_no_git}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RegistryIdentity {
    Verified,
    Mismatch,
    Unverifiable,
}

fn verify_registry_index_identity(
    cargo_home: &Path,
    index_dir_name: &str,
    locked_url: &str,
    norm_locked_url: &str,
) -> Result<RegistryIdentity, String> {
    if locked_url == "https://github.com/rust-lang/crates.io-index"
        || locked_url == "sparse+https://index.crates.io/"
    {
        return Ok(
            if index_dir_name.starts_with("index.crates.io-")
                || index_dir_name.starts_with("github.com-1ecc6299db9ec823")
            {
                RegistryIdentity::Verified
            } else {
                RegistryIdentity::Mismatch
            },
        );
    }

    let reg_index_root = cargo_home.join("registry").join("index");
    let index_git_dir = reg_index_root.join(index_dir_name).join(".git");
    let Some(canon_git) = contained_canonical(&index_git_dir, &reg_index_root) else {
        return Ok(RegistryIdentity::Unverifiable);
    };
    match extract_git_origin_url(&canon_git, &canon_git) {
        Ok(Some(origin)) => {
            let Some(norm_origin) = normalise_registry_url(&origin) else {
                return Ok(RegistryIdentity::Unverifiable);
            };
            if norm_origin == norm_locked_url {
                Ok(RegistryIdentity::Verified)
            } else {
                Ok(RegistryIdentity::Mismatch)
            }
        }
        Ok(None) => Ok(RegistryIdentity::Unverifiable),
        Err(ReadFileError::BudgetExhausted(m)) => Err(m),
        Err(ReadFileError::Other(_)) => Ok(RegistryIdentity::Unverifiable),
    }
}

pub(super) fn resolve_registry(
    cargo_home: &Path,
    source_url: &str,
    name: &str,
    version: &str,
) -> ResolveOutcome {
    let Some(locked_url) = source_url.strip_prefix("registry+") else {
        return ResolveOutcome::Unresolved(format!("invalid registry source \"{source_url}\""));
    };
    let Some(norm_locked) = normalise_registry_url(locked_url) else {
        return ResolveOutcome::Unresolved(format!(
            "registry source \"{source_url}\" cannot be verified (invalid registry URL)"
        ));
    };

    let reg_src = cargo_home.join("registry").join("src");
    let Ok(entries) = fs::read_dir(&reg_src) else {
        return ResolveOutcome::NotCached;
    };
    let mut scanned = 0_usize;
    let mut dirs: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        scanned += 1;
        if scanned > MAX_REGISTRY_DIRS {
            return ResolveOutcome::BudgetExhausted(format!(
                "registry index directory count under {} exceeds {MAX_REGISTRY_DIRS}",
                reg_src.display()
            ));
        }
        if entry
            .file_type()
            .is_ok_and(|ft| ft.is_dir() && !ft.is_symlink())
        {
            dirs.push((
                entry.file_name().to_string_lossy().into_owned(),
                entry.path(),
            ));
        }
    }
    dirs.sort_by(|a, b| a.0.cmp(&b.0));

    let folder_name = format!("{name}-{version}");
    let mut verified_hits: Vec<VerifiedDir> = Vec::new();
    let mut unverifiable = false;

    for (dir_name, idx_dir) in dirs {
        let candidate = idx_dir.join(&folder_name);
        let verified = match verify_manifest_identity(&candidate, &idx_dir, name, version) {
            VerifyResult::Matched(v) => v,
            VerifyResult::NotMatched => continue,
            VerifyResult::Unresolved(msg) => return ResolveOutcome::Unresolved(msg),
            VerifyResult::BudgetExhausted(m) => return ResolveOutcome::BudgetExhausted(m),
        };
        match verify_registry_index_identity(cargo_home, &dir_name, locked_url, &norm_locked) {
            Ok(RegistryIdentity::Verified) => verified_hits.push(verified),
            Ok(RegistryIdentity::Mismatch) => {}
            Ok(RegistryIdentity::Unverifiable) => unverifiable = true,
            Err(m) => return ResolveOutcome::BudgetExhausted(m),
        }
    }

    if verified_hits.len() == 1 {
        return ResolveOutcome::Found(verified_hits.into_iter().next().unwrap());
    }
    if verified_hits.len() > 1 {
        return ResolveOutcome::Ambiguous(format!(
            "multiple local registry directories match {name} {version} for {source_url}"
        ));
    }
    if unverifiable {
        return ResolveOutcome::Unresolved(format!(
            "local cache for {name} {version} could not be verified against registry {source_url}"
        ));
    }
    ResolveOutcome::NotCached
}

pub(super) fn resolve_path_crate(
    lockfile_dir: &Path,
    repo_canon: &Path,
    name: &str,
    version: &str,
) -> ResolveOutcome {
    let hits = match find_verified_crates_under(lockfile_dir, repo_canon, name, version, 3) {
        SearchResult::Matches(m) => m,
        SearchResult::Unresolved(msg) => return ResolveOutcome::Unresolved(msg),
        SearchResult::BudgetExhausted(msg) => return ResolveOutcome::BudgetExhausted(msg),
    };
    if hits.len() == 1 {
        return ResolveOutcome::Found(hits.into_iter().next().unwrap());
    }
    if hits.len() > 1 {
        return ResolveOutcome::Ambiguous(format!(
            "multiple local workspace/path crates match {name} {version}"
        ));
    }
    ResolveOutcome::NotCached
}

pub(super) fn find_verified_crates_under(
    root: &Path,
    boundary: &Path,
    crate_name: &str,
    expected_version: &str,
    max_depth: usize,
) -> SearchResult {
    let mut queue: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    let mut visited = 0_usize;
    let mut matches = Vec::new();
    while let Some((dir, depth)) = queue.pop() {
        let Some(canon_dir) = contained_canonical(&dir, boundary) else {
            continue;
        };
        match verify_manifest_identity(&canon_dir, boundary, crate_name, expected_version) {
            VerifyResult::Matched(verified) => {
                matches.push(verified);
                if matches.len() > 1 {
                    return SearchResult::Matches(matches);
                }
            }
            VerifyResult::NotMatched => {}
            VerifyResult::Unresolved(msg) => return SearchResult::Unresolved(msg),
            VerifyResult::BudgetExhausted(msg) => return SearchResult::BudgetExhausted(msg),
        }
        if depth >= max_depth {
            continue;
        }
        let Ok(entries) = fs::read_dir(&canon_dir) else {
            continue;
        };
        let mut children: Vec<PathBuf> = Vec::new();
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_SCAN_ENTRIES {
                return SearchResult::BudgetExhausted(format!(
                    "directory scan budget exceeded under {}",
                    root.display()
                ));
            }
            if entry
                .file_type()
                .is_ok_and(|ft| ft.is_dir() && !ft.is_symlink())
                && !SKIP_DIRS.contains(&entry.file_name().to_string_lossy().as_ref())
            {
                children.push(entry.path());
            }
        }
        children.sort();
        for c in children.into_iter().rev() {
            queue.push((c, depth + 1));
        }
    }
    SearchResult::Matches(matches)
}
