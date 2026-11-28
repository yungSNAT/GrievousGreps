//! Focused unit tests for private and `pub(super)` fail-closed guards in `crate_source`.

use std::fs;
use std::path::{Path, PathBuf};

use super::manifest::{ReadFileError, read_bounded_regular_file, resolve_workspace_version};
use super::normalise_lexical;
use super::verify::{ResolveOutcome, SearchResult, find_verified_crates_under, resolve_registry};

#[cfg(unix)]
struct ModeGuard {
    path: PathBuf,
    mode: u32,
}

#[cfg(unix)]
impl Drop for ModeGuard {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(self.mode));
    }
}

#[test]
fn normalise_lexical_resolves_cur_dir_and_parent_segments() {
    assert_eq!(
        normalise_lexical(Path::new("../a/./b/../c")),
        PathBuf::from("../a/c")
    );
    assert_eq!(normalise_lexical(Path::new("./a/../b")), PathBuf::from("b"));
    assert_eq!(
        normalise_lexical(Path::new("/../a/./b")),
        PathBuf::from("/a/b")
    );
}

#[test]
fn read_bounded_regular_file_rejects_missing_non_regular_unreadable_and_non_utf8() {
    let tmp = tempfile::tempdir().expect("tempdir");

    let missing = tmp.path().join("nope.toml");
    assert!(matches!(
        read_bounded_regular_file(&missing, 1024),
        Err(ReadFileError::Other(msg)) if msg.contains("cannot stat")
    ));

    let dir = tmp.path().join("subdir");
    fs::create_dir(&dir).unwrap();
    assert!(matches!(
        read_bounded_regular_file(&dir, 1024),
        Err(ReadFileError::Other(msg)) if msg.contains("not a regular file")
    ));

    let bad_utf8 = tmp.path().join("bad.toml");
    fs::write(&bad_utf8, [0xff, 0xfe, 0x80]).unwrap();
    assert!(matches!(
        read_bounded_regular_file(&bad_utf8, 1024),
        Err(ReadFileError::Other(msg)) if msg.contains("not valid UTF-8")
    ));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let locked = tmp.path().join("locked.toml");
        fs::write(&locked, "x = 1\n").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let _guard = ModeGuard {
            path: locked.clone(),
            mode: 0o644,
        };
        assert!(matches!(
            read_bounded_regular_file(&locked, 1024),
            Err(ReadFileError::Other(msg)) if msg.contains("cannot open")
        ));
    }
}

#[test]
fn resolve_workspace_version_fails_closed_on_missing_or_escaped_paths_and_permission_errors() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let bound = tmp.path().join("bound");
    let outside = tmp.path().join("outside");
    let crate_dir = bound.join("member");
    fs::create_dir_all(&crate_dir).unwrap();
    fs::create_dir_all(&outside).unwrap();

    assert!(
        resolve_workspace_version(&crate_dir, &tmp.path().join("missing-bound"))
            .unwrap()
            .is_none()
    );
    assert!(
        resolve_workspace_version(&bound.join("missing-crate"), &bound)
            .unwrap()
            .is_none()
    );
    assert!(
        resolve_workspace_version(&outside, &bound)
            .unwrap()
            .is_none()
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let blocked = bound.join("blocked");
        fs::create_dir(&blocked).unwrap();
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o000)).unwrap();
        let _guard = ModeGuard {
            path: blocked.clone(),
            mode: 0o755,
        };
        assert!(matches!(
            resolve_workspace_version(&blocked, &bound),
            Err(ReadFileError::Other(msg)) if msg.contains("cannot inspect workspace manifest")
        ));
    }
}

#[test]
fn verify_guards_reject_missing_registry_prefix_and_escaped_search_root() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let bound = tmp.path().join("bound");
    let outside = tmp.path().join("outside");
    fs::create_dir_all(&bound).unwrap();
    fs::create_dir_all(&outside).unwrap();

    assert!(matches!(
        resolve_registry(tmp.path(), "https://example.com/index", "demo", "1.0.0"),
        ResolveOutcome::Unresolved(msg) if msg.contains("invalid registry source")
    ));

    assert!(matches!(
        find_verified_crates_under(&outside, &bound, "demo", "1.0.0", 2),
        SearchResult::Matches(found) if found.is_empty()
    ));
}
