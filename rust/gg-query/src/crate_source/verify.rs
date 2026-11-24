//! Identity, containment and incremental budget verification for `crate-source`.

use std::fs;
use std::path::{Path, PathBuf};

use super::lockfile::{
    MAX_MANIFEST_BYTES, MAX_SCAN_ENTRIES, SKIP_DIRS, contained_canonical,
    read_bounded_regular_file, read_manifest_identity, resolve_workspace_version,
};

const MAX_REGISTRY_DIRS: usize = 64;
const MAX_GIT_CHECKOUTS: usize = 128;

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

pub(super) fn verify_manifest_identity(
    dir: &Path,
    boundary: &Path,
    expected_name: &str,
    expected_version: &str,
) -> Option<VerifiedDir> {
    let canon_dir = contained_canonical(dir, boundary)?;
    if !canon_dir.is_dir() {
        return None;
    }
    let manifest = canon_dir.join("Cargo.toml");
    let canon_manifest = contained_canonical(&manifest, &canon_dir)?;
    if !fs::metadata(&canon_manifest).is_ok_and(|m| m.is_file()) {
        return None;
    }
    let ident = read_manifest_identity(&canon_manifest).ok()??;
    if ident.name != expected_name {
        return None;
    }
    let actual_version = match ident.version {
        Some(v) => v,
        None if ident.workspace_version => resolve_workspace_version(&canon_dir, boundary)?,
        None => return None,
    };
    if actual_version != expected_version {
        return None;
    }
    let src_candidate = canon_dir.join("src");
    let src_dir = contained_canonical(&src_candidate, &canon_dir).filter(|p| p.is_dir());
    Some(VerifiedDir {
        dir: canon_dir,
        manifest_path: canon_manifest,
        src_dir,
    })
}

fn registry_dir_matches_source(index_dir_name: &str, source_url: &str) -> Option<bool> {
    let url = source_url.strip_prefix("registry+")?;
    if url == "https://github.com/rust-lang/crates.io-index"
        || url == "sparse+https://index.crates.io/"
    {
        return Some(
            index_dir_name.starts_with("index.crates.io-")
                || index_dir_name.starts_with("github.com-1ecc6299db9ec823"),
        );
    }
    let after_scheme = url.split_once("://").map(|(_, rest)| rest)?;
    let host_port = after_scheme.split('/').next()?;
    let host = host_port.split(':').next()?.to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    let lower_name = index_dir_name.to_ascii_lowercase();
    Some(lower_name.starts_with(&format!("{host}-")))
}

pub(super) fn resolve_registry(
    cargo_home: &Path,
    source_url: &str,
    name: &str,
    version: &str,
) -> ResolveOutcome {
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
    let mut matched: Vec<(bool, VerifiedDir)> = Vec::new();
    for (dir_name, idx_dir) in dirs {
        let candidate = idx_dir.join(&folder_name);
        if let Some(verified) = verify_manifest_identity(&candidate, &idx_dir, name, version) {
            let source_match = registry_dir_matches_source(&dir_name, source_url);
            if source_match == Some(false) {
                continue;
            }
            matched.push((source_match == Some(true), verified));
        }
    }

    let exact: Vec<VerifiedDir> = matched
        .iter()
        .filter(|(ok, _)| *ok)
        .map(|(_, v)| VerifiedDir {
            dir: v.dir.clone(),
            manifest_path: v.manifest_path.clone(),
            src_dir: v.src_dir.clone(),
        })
        .collect();
    if exact.len() == 1 {
        return ResolveOutcome::Found(exact.into_iter().next().unwrap());
    }
    if exact.len() > 1 {
        return ResolveOutcome::Ambiguous(format!(
            "multiple local registry directories match {name} {version} for {source_url}"
        ));
    }
    if matched.len() == 1 {
        return ResolveOutcome::Found(matched.into_iter().next().unwrap().1);
    }
    if matched.len() > 1 {
        return ResolveOutcome::Ambiguous(format!(
            "multiple local registry directories match {name} {version} and registry cannot be disambiguated"
        ));
    }
    ResolveOutcome::NotCached
}

fn normalise_git_url(url: &str) -> String {
    let base = url.split('?').next().unwrap_or(url);
    let trimmed = base.trim().trim_end_matches('/');
    let no_git = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    no_git.to_ascii_lowercase()
}

fn extract_git_origin_url(git_dir: &Path, boundary: &Path) -> Option<String> {
    let cfg = git_dir.join("config");
    let canon = contained_canonical(&cfg, boundary)?;
    let text = read_bounded_regular_file(&canon, MAX_MANIFEST_BYTES).ok()?;
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
            return Some(normalise_git_url(v.trim()));
        }
    }
    None
}

fn resolve_git_dir_pointer(rev_dir: &Path, cargo_home: &Path) -> Option<(PathBuf, PathBuf)> {
    let dot_git = rev_dir.join(".git");
    if let Some(canon) = contained_canonical(&dot_git, rev_dir)
        && canon.is_dir()
    {
        return Some((canon, rev_dir.to_path_buf()));
    }
    let canon_file = contained_canonical(&dot_git, rev_dir)?;
    let text = read_bounded_regular_file(&canon_file, 4096).ok()?;
    let target = text.trim().strip_prefix("gitdir:")?.trim();
    let joined = if Path::new(target).is_absolute() {
        PathBuf::from(target)
    } else {
        rev_dir.join(target)
    };
    let git_root = cargo_home.join("git");
    let canon_target = contained_canonical(&joined, &git_root)?;
    canon_target.is_dir().then_some((canon_target, git_root))
}

fn read_verified_git_sha(rev_dir: &Path, cargo_home: &Path) -> Option<(String, Option<String>)> {
    if let Some((git_dir, boundary)) = resolve_git_dir_pointer(rev_dir, cargo_home) {
        let origin = extract_git_origin_url(&git_dir, &boundary);
        let head = git_dir.join("HEAD");
        if let Some(canon_head) = contained_canonical(&head, &boundary)
            && let Ok(text) = read_bounded_regular_file(&canon_head, 4096)
        {
            let trimmed = text.trim();
            if trimmed.len() == 40 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Some((trimmed.to_ascii_lowercase(), origin));
            }
            if let Some(ref_name) = trimmed.strip_prefix("ref:") {
                let ref_path = git_dir.join(ref_name.trim());
                if let Some(canon_ref) = contained_canonical(&ref_path, &boundary)
                    && let Ok(ref_text) = read_bounded_regular_file(&canon_ref, 4096)
                {
                    let sha = ref_text.trim();
                    if sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()) {
                        return Some((sha.to_ascii_lowercase(), origin));
                    }
                }
            }
        }
    }
    let vcs_info = rev_dir.join(".cargo-vcs-info.json");
    if let Some(canon_vcs) = contained_canonical(&vcs_info, rev_dir)
        && let Ok(text) = read_bounded_regular_file(&canon_vcs, MAX_MANIFEST_BYTES)
        && let Ok(val) = serde_json::from_str::<serde_json::Value>(&text)
        && let Some(sha) = val.pointer("/git/sha1").and_then(|v| v.as_str())
        && sha.len() == 40
        && sha.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Some((sha.to_ascii_lowercase(), None));
    }
    None
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
        let Some((actual_sha, origin_url)) = read_verified_git_sha(&canon_rev, cargo_home) else {
            if !find_verified_crates_under(&canon_rev, &canon_rev, name, version, 2)
                .0
                .is_empty()
            {
                unverified_candidate = true;
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
        let (mut found, exhausted) =
            find_verified_crates_under(&canon_rev, &canon_rev, name, version, 2);
        if exhausted {
            return ResolveOutcome::BudgetExhausted(format!(
                "directory scan budget exceeded inside {}",
                canon_rev.display()
            ));
        }
        verified_hits.append(&mut found);
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

pub(super) fn resolve_path_crate(
    lockfile_dir: &Path,
    repo_canon: &Path,
    name: &str,
    version: &str,
) -> ResolveOutcome {
    let (hits, exhausted) = find_verified_crates_under(lockfile_dir, repo_canon, name, version, 3);
    if exhausted {
        return ResolveOutcome::BudgetExhausted(format!(
            "directory scan budget exceeded under {}",
            lockfile_dir.display()
        ));
    }
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

fn find_verified_crates_under(
    root: &Path,
    boundary: &Path,
    crate_name: &str,
    expected_version: &str,
    max_depth: usize,
) -> (Vec<VerifiedDir>, bool) {
    let mut queue: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    let mut visited = 0_usize;
    let mut matches = Vec::new();
    while let Some((dir, depth)) = queue.pop() {
        let Some(canon_dir) = contained_canonical(&dir, boundary) else {
            continue;
        };
        if let Some(verified) =
            verify_manifest_identity(&canon_dir, boundary, crate_name, expected_version)
        {
            matches.push(verified);
            if matches.len() > 1 {
                return (matches, false);
            }
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
                return (matches, true);
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
    (matches, false)
}
