//! Git checkout verification for `crate-source`.

use std::fs;
use std::path::{Path, PathBuf};

use super::lockfile::contained_canonical;
use super::manifest::{MAX_MANIFEST_BYTES, ReadFileError, read_bounded_regular_file};
use super::verify::{ResolveOutcome, SearchResult, VerifiedDir, find_verified_crates_under};

const MAX_GIT_CHECKOUTS: usize = 128;

pub(super) fn normalise_git_url(url: &str) -> String {
    let base = url.split('?').next().unwrap_or(url);
    let trimmed = base.trim().trim_end_matches('/');
    let no_git = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    no_git.to_ascii_lowercase()
}

pub(super) fn extract_git_origin_url(
    git_dir: &Path,
    boundary: &Path,
) -> Result<Option<String>, ReadFileError> {
    let cfg = git_dir.join("config");
    let Some(canon) = contained_canonical(&cfg, boundary) else {
        return Ok(None);
    };
    let text = read_bounded_regular_file(&canon, MAX_MANIFEST_BYTES)?;
    let mut in_origin = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_origin = line == "[remote \"origin\"]";
            continue;
        }
        if in_origin
            && let Some((k, v)) = line.split_once('=')
            && k.trim() == "url"
        {
            return Ok(Some(v.trim().to_string()));
        }
    }
    Ok(None)
}

fn resolve_git_dir_pointer(
    rev_dir: &Path,
    cargo_home: &Path,
) -> Result<Option<(PathBuf, PathBuf)>, ReadFileError> {
    let dot_git = rev_dir.join(".git");
    let Some(canon) = contained_canonical(&dot_git, rev_dir) else {
        return Ok(None);
    };
    if canon.is_dir() {
        return Ok(Some((canon, rev_dir.to_path_buf())));
    }
    let text = match read_bounded_regular_file(&canon, 4096) {
        Ok(t) => t,
        Err(err @ ReadFileError::BudgetExhausted(_)) => return Err(err),
        Err(ReadFileError::Other(_)) => return Ok(None),
    };
    let Some(target) = text.trim().strip_prefix("gitdir:").map(str::trim) else {
        return Ok(None);
    };
    let joined = if Path::new(target).is_absolute() {
        PathBuf::from(target)
    } else {
        rev_dir.join(target)
    };
    let git_root = cargo_home.join("git");
    let Some(canon_target) = contained_canonical(&joined, &git_root) else {
        return Ok(None);
    };
    Ok(canon_target.is_dir().then_some((canon_target, git_root)))
}

fn read_verified_git_sha(
    rev_dir: &Path,
    cargo_home: &Path,
) -> Result<Option<(String, Option<String>)>, ReadFileError> {
    let mut discovered_origin: Option<String> = None;
    if let Some((git_dir, boundary)) = resolve_git_dir_pointer(rev_dir, cargo_home)? {
        discovered_origin = match extract_git_origin_url(&git_dir, &boundary) {
            Ok(Some(url)) => Some(normalise_git_url(&url)),
            Ok(None) | Err(ReadFileError::Other(_)) => None,
            Err(err @ ReadFileError::BudgetExhausted(_)) => return Err(err),
        };
        let head = git_dir.join("HEAD");
        if let Some(canon_head) = contained_canonical(&head, &boundary) {
            match read_bounded_regular_file(&canon_head, 4096) {
                Ok(text) => {
                    let trimmed = text.trim();
                    if trimmed.len() == 40 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
                        return Ok(Some((trimmed.to_ascii_lowercase(), discovered_origin)));
                    }
                    if let Some(ref_name) = trimmed.strip_prefix("ref:") {
                        let ref_path = git_dir.join(ref_name.trim());
                        if let Some(canon_ref) = contained_canonical(&ref_path, &boundary) {
                            match read_bounded_regular_file(&canon_ref, 4096) {
                                Ok(ref_text) => {
                                    let sha = ref_text.trim();
                                    if sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit())
                                    {
                                        return Ok(Some((
                                            sha.to_ascii_lowercase(),
                                            discovered_origin,
                                        )));
                                    }
                                }
                                Err(err @ ReadFileError::BudgetExhausted(_)) => return Err(err),
                                Err(ReadFileError::Other(_)) => {}
                            }
                        }
                    }
                }
                Err(err @ ReadFileError::BudgetExhausted(_)) => return Err(err),
                Err(ReadFileError::Other(_)) => {}
            }
        }
    }
    let vcs_info = rev_dir.join(".cargo-vcs-info.json");
    if let Some(canon_vcs) = contained_canonical(&vcs_info, rev_dir) {
        match read_bounded_regular_file(&canon_vcs, MAX_MANIFEST_BYTES) {
            Ok(text) => {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text)
                    && let Some(sha) = val.pointer("/git/sha1").and_then(|v| v.as_str())
                    && sha.len() == 40
                    && sha.bytes().all(|b| b.is_ascii_hexdigit())
                {
                    return Ok(Some((sha.to_ascii_lowercase(), discovered_origin)));
                }
            }
            Err(err @ ReadFileError::BudgetExhausted(_)) => return Err(err),
            Err(ReadFileError::Other(_)) => {}
        }
    }
    Ok(None)
}

fn repo_slug_from_url(url: &str) -> Option<String> {
    let norm = normalise_git_url(url);
    norm.rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn collect_git_repo_dirs(git_root: &Path) -> Result<Vec<(String, PathBuf)>, ResolveOutcome> {
    let Ok(entries) = fs::read_dir(git_root) else {
        return Err(ResolveOutcome::NotCached);
    };
    let mut scanned = 0_usize;
    let mut repo_dirs: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        scanned += 1;
        if scanned > MAX_GIT_CHECKOUTS {
            return Err(ResolveOutcome::BudgetExhausted(format!(
                "git checkout directory count under {} exceeds {MAX_GIT_CHECKOUTS}",
                git_root.display()
            )));
        }
        if entry
            .file_type()
            .is_ok_and(|ft| ft.is_dir() && !ft.is_symlink())
        {
            repo_dirs.push((
                entry.file_name().to_string_lossy().into_owned(),
                entry.path(),
            ));
        }
    }
    repo_dirs.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(repo_dirs)
}

pub(super) fn resolve_git(
    cargo_home: &Path,
    source: &str,
    name: &str,
    version: &str,
) -> ResolveOutcome {
    let Some((url_part, raw_rev)) = source.rsplit_once('#') else {
        return ResolveOutcome::Unresolved(format!("git source \"{source}\" lacks a commit SHA"));
    };
    if raw_rev.len() != 40 || !raw_rev.bytes().all(|b| b.is_ascii_hexdigit()) {
        return ResolveOutcome::Unresolved(format!(
            "git source \"{source}\" does not carry a 40-char commit SHA"
        ));
    }
    let expected_url = url_part.strip_prefix("git+").unwrap_or(url_part);
    let full_rev = raw_rev.to_ascii_lowercase();
    let short_rev = &full_rev[..7];
    let norm_expected_url = normalise_git_url(expected_url);
    let expected_slug = repo_slug_from_url(expected_url);

    let repo_dirs = match collect_git_repo_dirs(&cargo_home.join("git").join("checkouts")) {
        Ok(d) => d,
        Err(outcome) => return outcome,
    };

    let mut verified_hits: Vec<VerifiedDir> = Vec::new();
    let mut unverified_candidate = false;

    for (repo_dir_name, repo_dir) in repo_dirs {
        let rev_dir = repo_dir.join(short_rev);
        if !fs::symlink_metadata(&rev_dir)
            .is_ok_and(|m| m.file_type().is_dir() && !m.file_type().is_symlink())
        {
            continue;
        }
        let Some(canon_rev) = contained_canonical(&rev_dir, &repo_dir) else {
            continue;
        };
        let sha_res = match read_verified_git_sha(&canon_rev, cargo_home) {
            Ok(v) => v,
            Err(ReadFileError::BudgetExhausted(m)) => return ResolveOutcome::BudgetExhausted(m),
            Err(ReadFileError::Other(_)) => None,
        };
        let Some((actual_sha, origin_url)) = sha_res else {
            match find_verified_crates_under(&canon_rev, &canon_rev, name, version, 2) {
                SearchResult::Matches(found) if !found.is_empty() => unverified_candidate = true,
                SearchResult::Matches(_) => {}
                SearchResult::Unresolved(m) => return ResolveOutcome::Unresolved(m),
                SearchResult::BudgetExhausted(m) => return ResolveOutcome::BudgetExhausted(m),
            }
            continue;
        };
        if actual_sha != full_rev {
            continue;
        }
        if let Some(origin) = origin_url {
            if origin != norm_expected_url {
                continue;
            }
        } else {
            let Some(ref slug) = expected_slug else {
                continue;
            };
            if !repo_dir_name
                .to_ascii_lowercase()
                .starts_with(&format!("{slug}-"))
            {
                continue;
            }
        }
        match find_verified_crates_under(&canon_rev, &canon_rev, name, version, 2) {
            SearchResult::Matches(mut found) => verified_hits.append(&mut found),
            SearchResult::Unresolved(m) => return ResolveOutcome::Unresolved(m),
            SearchResult::BudgetExhausted(m) => return ResolveOutcome::BudgetExhausted(m),
        }
    }

    if verified_hits.len() == 1 {
        return ResolveOutcome::Found(verified_hits.into_iter().next().unwrap());
    }
    if verified_hits.len() > 1 {
        return ResolveOutcome::Ambiguous(format!(
            "multiple verified git checkouts match {name} {version} at {short_rev}"
        ));
    }
    if unverified_candidate {
        return ResolveOutcome::Unresolved(format!(
            "git checkout at {short_rev} lacks verifiable full commit SHA (.git/HEAD or .cargo-vcs-info.json)"
        ));
    }
    ResolveOutcome::NotCached
}
