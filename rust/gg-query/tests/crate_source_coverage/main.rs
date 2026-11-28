//! Behaviour and fail-closed boundary tests for `crate_source` (`mod.rs`, `lockfile.rs`,
//! `manifest.rs`, `git.rs` and `verify.rs`).

mod git;
mod lockfile_manifest;
mod registry;

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use gg_query::crate_source::{
    CrateSourceArgs, CrateSourceKind, CrateSourceMatch, CrateSourceReport, ResolutionStatus,
    format_crate_source_json, format_crate_source_text, resolve_crate_source,
};

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvGuard {
    saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
}

impl EnvGuard {
    fn save(keys: &[&'static str]) -> Self {
        let saved = keys.iter().map(|&k| (k, env::var_os(k))).collect();
        Self { saved }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (k, v) in &self.saved {
            // SAFETY: this integration test binary serialises every env mutation under `ENV_LOCK`,
            // and no other test in this binary reads `CARGO_HOME`, `HOME` or `USERPROFILE`.
            unsafe {
                match v {
                    Some(val) => env::set_var(k, val),
                    None => env::remove_var(k),
                }
            }
        }
    }
}

#[cfg(unix)]
pub(crate) struct ModeGuard {
    pub path: PathBuf,
    pub mode: u32,
}

#[cfg(unix)]
impl Drop for ModeGuard {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(self.mode));
    }
}

pub(crate) fn write_file(path: &Path, content: impl AsRef<[u8]>) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, content).unwrap();
}

pub(crate) fn make_lock(name: &str, version: &str, source: Option<&str>) -> String {
    match source {
        Some(s) => format!(
            "version = 4\n\n[[package]]\nname = \"{name}\"\nversion = \"{version}\"\nsource = \"{s}\"\n"
        ),
        None => format!("version = 4\n\n[[package]]\nname = \"{name}\"\nversion = \"{version}\"\n"),
    }
}

pub(crate) fn resolve_one(
    repo: &Path,
    cargo_home: &Path,
    name: &str,
    version: Option<&str>,
    lockfile: Option<&Path>,
) -> Result<CrateSourceReport, String> {
    resolve_crate_source(&CrateSourceArgs {
        crate_name: name,
        repo,
        version,
        cargo_home: Some(cargo_home),
        lockfile,
    })
}

pub(crate) fn status_of(repo: &Path, ch: &Path, name: &str) -> ResolutionStatus {
    resolve_one(repo, ch, name, None, None).unwrap().matches[0]
        .status
        .clone()
}

fn resolve_env_home(repo: &Path) -> Result<CrateSourceReport, String> {
    resolve_crate_source(&CrateSourceArgs {
        crate_name: "demo",
        repo,
        version: None,
        cargo_home: None,
        lockfile: None,
    })
}

fn sample_match(
    ver: &str,
    kind: CrateSourceKind,
    status: ResolutionStatus,
    lockfile: &str,
    path: Option<&str>,
    hint: Option<&str>,
) -> CrateSourceMatch {
    CrateSourceMatch {
        name: "demo".to_string(),
        version: ver.to_string(),
        kind,
        status,
        lockfile: lockfile.to_string(),
        source: None,
        path: path.map(String::from),
        manifest_path: path.map(|p| format!("{p}/Cargo.toml")),
        src_dir: None,
        hint: hint.map(String::from),
    }
}

#[test]
fn validates_crate_names_versions_missing_repo_not_found_dedup_and_truncation() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let ch = tmp.path().join("cargo_home");
    fs::create_dir_all(&repo).unwrap();
    fs::create_dir_all(&ch).unwrap();

    for bad in ["", &"a".repeat(129), "-bad", "foo/bar"] {
        assert!(
            resolve_one(&repo, &ch, bad, None, None)
                .unwrap_err()
                .contains("invalid crate name")
        );
    }
    for bad_ver in ["", &"1".repeat(129), "1..2", "1.0.0/evil"] {
        assert!(
            resolve_one(&repo, &ch, "demo", Some(bad_ver), None)
                .unwrap_err()
                .contains("invalid version filter")
        );
    }
    assert!(
        resolve_one(&tmp.path().join("missing"), &ch, "demo", None, None)
            .unwrap_err()
            .contains("cannot resolve repo")
    );

    let mut lock = String::from("version = 4\n");
    for i in 0..17 {
        lock.push_str(&format!(
            "\n[[package]]\nname = \"many\"\nversion = \"0.1.{i}\"\n"
        ));
    }
    lock.push_str("\n[[package]]\nname = \"many\"\nversion = \"0.1.0\"\n");
    write_file(&repo.join("Cargo.lock"), &lock);

    assert!(
        resolve_one(&repo, &ch, "absent", None, None)
            .unwrap_err()
            .contains("crate \"absent\" not found")
    );
    assert!(
        resolve_one(&repo, &ch, "many", Some("9.9.9"), None)
            .unwrap_err()
            .contains("version 9.9.9 not found")
    );
    let report = resolve_one(&repo, &ch, "many", None, None).unwrap();
    assert_eq!(report.matches.len(), 16);
    assert_eq!(report.truncated, 1);
}

#[test]
fn formats_text_and_json_across_kinds_statuses_hints_and_truncation() {
    let mut rep = CrateSourceReport {
        query: "demo".to_string(),
        version_filter: None,
        cargo_home: "/cache".to_string(),
        matches: vec![
            sample_match(
                "1.0.0",
                CrateSourceKind::Registry,
                ResolutionStatus::Found,
                "Cargo.lock",
                Some("/cache/demo-1.0.0"),
                None,
            ),
            sample_match(
                "2.0.0",
                CrateSourceKind::Git,
                ResolutionStatus::NotCached,
                "Cargo.lock",
                None,
                Some("run cargo fetch"),
            ),
            sample_match(
                "3.0.0",
                CrateSourceKind::Path,
                ResolutionStatus::Unresolved,
                "sub/Cargo.lock",
                None,
                None,
            ),
        ],
        truncated: 2,
    };

    let text = format_crate_source_text(&rep);
    assert!(text.contains("demo 1.0.0 (registry, Cargo.lock) → /cache/demo-1.0.0"));
    assert!(text.contains("⚠ demo 2.0.0 (git, Cargo.lock): run cargo fetch"));
    assert!(text.contains("⚠ demo 3.0.0 (path, sub/Cargo.lock): not cached locally"));
    assert!(text.contains("… and 2 more match(es)"));

    rep.truncated = 0;
    assert!(!format_crate_source_text(&rep).contains("more match(es)"));
    assert!(
        format_crate_source_json(&rep)
            .unwrap()
            .contains("\"query\": \"demo\"")
    );
}

#[test]
fn resolves_cargo_home_from_env_vars_and_fails_when_unset() {
    let _lock = ENV_LOCK.lock().unwrap();
    let _guard = EnvGuard::save(&["CARGO_HOME", "HOME", "USERPROFILE"]);

    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let custom_ch = tmp.path().join("env_cargo");
    let fake_home = tmp.path().join("fake_home");
    let fake_profile = tmp.path().join("fake_profile");
    fs::create_dir_all(&custom_ch).unwrap();
    fs::create_dir_all(&fake_home).unwrap();
    fs::create_dir_all(&fake_profile).unwrap();
    write_file(&repo.join("Cargo.lock"), make_lock("demo", "1.0.0", None));

    let raw_ch = custom_ch.join(".").join("sub").join("..");
    // SAFETY: guarded by `ENV_LOCK`; no other test in this binary reads these variables.
    unsafe { env::set_var("CARGO_HOME", &raw_ch) };
    assert_eq!(
        PathBuf::from(&resolve_env_home(&repo).unwrap().cargo_home),
        custom_ch
    );

    // SAFETY: guarded by `ENV_LOCK`.
    unsafe {
        env::set_var("CARGO_HOME", "   ");
        env::set_var("HOME", &fake_home);
        env::remove_var("USERPROFILE");
    }
    assert_eq!(
        PathBuf::from(&resolve_env_home(&repo).unwrap().cargo_home),
        fake_home.join(".cargo")
    );

    // SAFETY: guarded by `ENV_LOCK`.
    unsafe {
        env::remove_var("CARGO_HOME");
        env::remove_var("HOME");
        env::set_var("USERPROFILE", &fake_profile);
    }
    assert_eq!(
        PathBuf::from(&resolve_env_home(&repo).unwrap().cargo_home),
        fake_profile.join(".cargo")
    );

    // SAFETY: guarded by `ENV_LOCK`.
    unsafe { env::remove_var("USERPROFILE") };
    assert!(
        resolve_env_home(&repo)
            .unwrap_err()
            .contains("cannot determine CARGO_HOME")
    );
}
