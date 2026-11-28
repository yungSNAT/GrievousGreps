//! `Cargo.lock`-anchored resolved-dependency source lookup (`crate-source`).
//!
//! Read-only, fail-closed, bounded lookup that resolves a crate's exact locked
//! version from `Cargo.lock` to its local Cargo registry, git checkout or
//! workspace path source directory so agents never read wrong or stale versions.

mod git;
mod lockfile;
mod manifest;
mod toml_scalars;
mod toml_strings;
mod toml_syntax;
mod verify;

use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use git::resolve_git;
use lockfile::{LockPackage, discover_lockfiles, parse_cargo_lock};
use verify::{ResolveOutcome, resolve_path_crate, resolve_registry};

const MAX_RESULTS: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CrateSourceKind {
    Registry,
    Git,
    Path,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionStatus {
    Found,
    NotCached,
    Ambiguous,
    Unresolved,
    BudgetExhausted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrateSourceMatch {
    pub name: String,
    pub version: String,
    pub kind: CrateSourceKind,
    pub status: ResolutionStatus,
    pub lockfile: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrateSourceReport {
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_filter: Option<String>,
    pub cargo_home: String,
    pub matches: Vec<CrateSourceMatch>,
    pub truncated: usize,
}

pub struct CrateSourceArgs<'a> {
    pub crate_name: &'a str,
    pub repo: &'a Path,
    pub version: Option<&'a str>,
    pub cargo_home: Option<&'a Path>,
    pub lockfile: Option<&'a Path>,
}

fn validate_crate_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 128 {
        return Err(format!("invalid crate name \"{name}\""));
    }
    let bytes = name.as_bytes();
    if !bytes[0].is_ascii_alphanumeric() {
        return Err(format!("invalid crate name \"{name}\""));
    }
    if !bytes
        .iter()
        .all(|&b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(format!(
            "invalid crate name \"{name}\": only ASCII letters, digits, '-' and '_' are allowed"
        ));
    }
    Ok(())
}

fn validate_version(ver: &str) -> Result<(), String> {
    if ver.is_empty() || ver.len() > 128 || ver.contains("..") {
        return Err(format!("invalid version filter \"{ver}\""));
    }
    if !ver
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
    {
        return Err(format!("invalid version filter \"{ver}\""));
    }
    Ok(())
}

fn canonical_crate_key(name: &str) -> String {
    name.replace('-', "_")
}

fn normalise_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(comp.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                } else if !out.is_absolute() {
                    out.push(comp.as_os_str());
                }
            }
            Component::Normal(seg) => out.push(seg),
        }
    }
    out
}

fn normalise_absolute(path: PathBuf) -> Result<PathBuf, String> {
    let joined = if path.is_absolute() {
        path
    } else {
        let cwd = env::current_dir().map_err(|e| format!("cannot read current directory: {e}"))?;
        cwd.join(path)
    };
    Ok(normalise_lexical(&joined))
}

fn resolve_cargo_home(override_dir: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(d) = override_dir {
        return normalise_absolute(d.to_path_buf());
    }
    if let Ok(env_home) = env::var("CARGO_HOME")
        && !env_home.trim().is_empty()
    {
        return normalise_absolute(PathBuf::from(env_home));
    }
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map_err(|_| {
            "cannot determine CARGO_HOME (set CARGO_HOME or pass --cargo-home)".to_string()
        })?;
    Ok(PathBuf::from(home).join(".cargo"))
}

fn build_match_entry(
    pkg: &LockPackage,
    lockfile_rel: &str,
    lockfile_dir: &Path,
    repo_canon: &Path,
    cargo_home: &Path,
) -> Result<CrateSourceMatch, String> {
    let (kind, outcome) = match pkg.source.as_deref() {
        Some(src) if src.starts_with("registry+") => (
            CrateSourceKind::Registry,
            resolve_registry(cargo_home, src, &pkg.name, &pkg.version),
        ),
        Some(src) if src.starts_with("git+") => (
            CrateSourceKind::Git,
            resolve_git(cargo_home, src, &pkg.name, &pkg.version),
        ),
        Some(other) => {
            return Err(format!(
                "unsupported source scheme \"{other}\" for crate \"{}\" in Cargo.lock",
                pkg.name
            ));
        }
        None => (
            CrateSourceKind::Path,
            resolve_path_crate(lockfile_dir, repo_canon, &pkg.name, &pkg.version),
        ),
    };

    Ok(match outcome {
        ResolveOutcome::Found(v) => CrateSourceMatch {
            name: pkg.name.clone(),
            version: pkg.version.clone(),
            kind,
            status: ResolutionStatus::Found,
            lockfile: lockfile_rel.to_string(),
            source: pkg.source.clone(),
            path: Some(v.dir.to_string_lossy().into_owned()),
            manifest_path: Some(v.manifest_path.to_string_lossy().into_owned()),
            src_dir: v.src_dir.map(|p| p.to_string_lossy().into_owned()),
            hint: None,
        },
        ResolveOutcome::NotCached => CrateSourceMatch {
            name: pkg.name.clone(),
            version: pkg.version.clone(),
            kind: kind.clone(),
            status: ResolutionStatus::NotCached,
            lockfile: lockfile_rel.to_string(),
            source: pkg.source.clone(),
            path: None,
            manifest_path: None,
            src_dir: None,
            hint: Some(match kind {
                CrateSourceKind::Path => format!(
                    "workspace/path crate {} {} not found under repository root",
                    pkg.name, pkg.version
                ),
                CrateSourceKind::Registry | CrateSourceKind::Git => format!(
                    "locked version {} is not unpacked in {}; run `cargo fetch` to populate it",
                    pkg.version,
                    cargo_home.display()
                ),
            }),
        },
        ResolveOutcome::Ambiguous(msg) => CrateSourceMatch {
            name: pkg.name.clone(),
            version: pkg.version.clone(),
            kind,
            status: ResolutionStatus::Ambiguous,
            lockfile: lockfile_rel.to_string(),
            source: pkg.source.clone(),
            path: None,
            manifest_path: None,
            src_dir: None,
            hint: Some(msg),
        },
        ResolveOutcome::Unresolved(msg) => CrateSourceMatch {
            name: pkg.name.clone(),
            version: pkg.version.clone(),
            kind,
            status: ResolutionStatus::Unresolved,
            lockfile: lockfile_rel.to_string(),
            source: pkg.source.clone(),
            path: None,
            manifest_path: None,
            src_dir: None,
            hint: Some(msg),
        },
        ResolveOutcome::BudgetExhausted(msg) => CrateSourceMatch {
            name: pkg.name.clone(),
            version: pkg.version.clone(),
            kind,
            status: ResolutionStatus::BudgetExhausted,
            lockfile: lockfile_rel.to_string(),
            source: pkg.source.clone(),
            path: None,
            manifest_path: None,
            src_dir: None,
            hint: Some(msg),
        },
    })
}

/// Resolve a crate's locked source location(s) from `Cargo.lock`.
pub fn resolve_crate_source(args: &CrateSourceArgs<'_>) -> Result<CrateSourceReport, String> {
    validate_crate_name(args.crate_name)?;
    if let Some(v) = args.version {
        validate_version(v)?;
    }
    let repo_canon = fs::canonicalize(args.repo)
        .map_err(|e| format!("cannot resolve repo {}: {e}", args.repo.display()))?;
    let cargo_home = resolve_cargo_home(args.cargo_home)?;
    let lockfiles = discover_lockfiles(&repo_canon, args.lockfile)?;

    let mut exact_hits: Vec<(LockPackage, PathBuf)> = Vec::new();
    let mut canon_hits: Vec<(LockPackage, PathBuf)> = Vec::new();
    let query_canon = canonical_crate_key(args.crate_name);

    for lf in &lockfiles {
        for pkg in parse_cargo_lock(lf)? {
            if let Some(v) = args.version
                && pkg.version != v
            {
                continue;
            }
            if pkg.name == args.crate_name {
                exact_hits.push((pkg, lf.clone()));
            } else if canonical_crate_key(&pkg.name) == query_canon {
                canon_hits.push((pkg, lf.clone()));
            }
        }
    }

    let chosen = if !exact_hits.is_empty() {
        exact_hits
    } else {
        canon_hits
    };
    if chosen.is_empty() {
        let ver_note = args
            .version
            .map(|v| format!(" version {v}"))
            .unwrap_or_default();
        return Err(format!(
            "crate \"{}\"{ver_note} not found in {} Cargo.lock file(s)",
            args.crate_name,
            lockfiles.len()
        ));
    }

    let mut seen_keys: BTreeSet<(String, String, Option<String>, String)> = BTreeSet::new();
    let mut matches = Vec::new();
    let mut truncated = 0_usize;

    for (pkg, lf) in chosen {
        let lf_rel = lf
            .strip_prefix(&repo_canon)
            .unwrap_or(&lf)
            .to_string_lossy()
            .replace('\\', "/");
        let dedup_key = (
            pkg.name.clone(),
            pkg.version.clone(),
            pkg.source.clone(),
            lf_rel.clone(),
        );
        if !seen_keys.insert(dedup_key) {
            continue;
        }
        if matches.len() >= MAX_RESULTS {
            truncated += 1;
            continue;
        }
        validate_crate_name(&pkg.name)?;
        validate_version(&pkg.version)?;
        let lf_dir = lf.parent().unwrap_or(&repo_canon);
        matches.push(build_match_entry(
            &pkg,
            &lf_rel,
            lf_dir,
            &repo_canon,
            &cargo_home,
        )?);
    }

    Ok(CrateSourceReport {
        query: args.crate_name.to_string(),
        version_filter: args.version.map(String::from),
        cargo_home: cargo_home.to_string_lossy().into_owned(),
        matches,
        truncated,
    })
}

pub fn format_crate_source_text(report: &CrateSourceReport) -> String {
    let mut lines = Vec::new();
    for m in &report.matches {
        let kind_label = match m.kind {
            CrateSourceKind::Registry => "registry",
            CrateSourceKind::Git => "git",
            CrateSourceKind::Path => "path",
        };
        match (&m.status, &m.path) {
            (ResolutionStatus::Found, Some(path)) => {
                lines.push(format!(
                    "{} {} ({kind_label}, {}) → {path}",
                    m.name, m.version, m.lockfile
                ));
            }
            _ => {
                let hint = m.hint.as_deref().unwrap_or("not cached locally");
                lines.push(format!(
                    "⚠ {} {} ({kind_label}, {}): {hint}",
                    m.name, m.version, m.lockfile
                ));
            }
        }
    }
    if report.truncated > 0 {
        lines.push(format!("… and {} more match(es)", report.truncated));
    }
    format!("{}\n", lines.join("\n"))
}

pub fn format_crate_source_json(report: &CrateSourceReport) -> Result<String, String> {
    serde_json::to_string_pretty(report).map_err(|e| e.to_string())
}

#[cfg(test)]
mod unit_tests;
