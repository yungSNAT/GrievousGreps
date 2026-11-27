//! Finding a program to start, by the rule of `src/util/program.ts`: a bare name is looked
//! up only in PATH's absolute folders, passing over each folder that is a working folder or
//! under one, a `node_modules/.bin` folder (case-folded on Windows) and Yarn's
//! `BERRY_BIN_FOLDER`, and the program is started by its absolute path. A checkout's own
//! `git` therefore never runs in place of the person's.
//!
//! A working folder that is a file system root or the home folder (`holdsAll`) passes over
//! only itself.
//!
//! This is the subset of that rule the port needs. Left out of the TypeScript's rule:
//! - identity: each folder is also tested by volume and file identity (shares and bind
//!   mounts that spell a working folder another way); here a folder is judged by its real
//!   path alone;
//! - `linkFolders` and `stands`: a program whose path passes through a link inside a
//!   working folder is refused even when the file itself is outside; here only the real
//!   file's folder is judged;
//! - `bothWays`: working folders and `BERRY_BIN_FOLDER` are taken in their real spelling
//!   only (the home folder in both);
//! - the home folder comes from `HOME` (`USERPROFILE` on Windows) alone, without
//!   `os.homedir()`'s fallback to the password database; an empty `HOME` or `USERPROFILE`
//!   matches nothing rather than resolving to the process folder as TypeScript's
//!   `bothWays("")` does.
//!
//! Known Windows gaps (deferred to the Windows pass; `node_modules/.bin` case folding is
//! handled here, and `sources.rs` lists the file-walk gaps):
//! - PATH entries are split by `std::env::split_paths` without trimming leading or trailing
//!   whitespace (so `" C:\Git\cmd"` is passed over), and a quoted entry containing `;`
//!   stays 1 entry where `program.ts` splits on `;` first and strips surrounding quotes.

use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Program `name` (`git`), found as above; `trees` are the working folders to pass over
/// besides this process's current folder.
#[must_use]
pub fn find_program(name: &str, trees: &[&Path]) -> Option<PathBuf> {
    // Node's `os.homedir()` from the environment, in its given and real spellings.
    let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let homes: Vec<PathBuf> = home
        .iter()
        .flat_map(|h| [Some(h.clone()), real(h)])
        .flatten()
        .collect();
    let mut working: Vec<PathBuf> = trees.iter().filter_map(|t| real(t)).collect();
    if let Some(cwd) = env::current_dir().ok().and_then(|c| real(&c)) {
        working.push(cwd);
    }
    let working: Vec<(PathBuf, bool)> = working
        .into_iter()
        .map(|w| {
            let all = holds_all(&w, &homes);
            (w, all)
        })
        .collect();
    let path = env::var_os("PATH").unwrap_or_else(default_path);
    let berry = env::var_os("BERRY_BIN_FOLDER")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .and_then(|p| real(&p));
    find_in(name, &path, &working, berry.as_deref())
}

/// `holdsAll`: a file system root or the home folder holds every folder the person installs
/// to, so as a working folder only the folder itself is passed over.
fn holds_all(tree: &Path, homes: &[PathBuf]) -> bool {
    tree.parent().is_none() || homes.iter().any(|h| same(h, tree))
}

/// Whether `dir` is in one of the working folders `(real path, holds all)`.
fn in_tree(dir: &Path, working: &[(PathBuf, bool)]) -> bool {
    working
        .iter()
        .any(|(w, all)| if *all { same(dir, w) } else { under(dir, w) })
}

/// [`find_program`] over a given PATH value, working folders (real paths, with
/// [`holds_all`]) and Yarn's `BERRY_BIN_FOLDER` (a real path).
fn find_in(
    name: &str,
    path: &OsString,
    working: &[(PathBuf, bool)],
    berry: Option<&Path>,
) -> Option<PathBuf> {
    let passed_over = |dir: &Path| {
        let package_bin = dir
            .file_name()
            .is_some_and(|n| same(Path::new(n), Path::new(".bin")))
            && dir
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|n| same(Path::new(n), Path::new("node_modules")));
        package_bin || berry.is_some_and(|b| same(b, dir)) || in_tree(dir, working)
    };
    for entry in env::split_paths(path) {
        if !entry.is_absolute() || passed_over(&entry) {
            continue;
        }
        let Some(dir) = real(&entry) else { continue };
        if passed_over(&dir) {
            continue;
        }
        for file in candidates(&dir, name) {
            let Some(found) = real(&file) else { continue };
            let inside = found.parent().is_some_and(|p| in_tree(p, working));
            if !inside && runnable(&found) {
                return Some(file);
            }
        }
    }
    None
}

/// With no PATH at all, POSIX looks in /usr/bin and /bin, as libuv does.
#[cfg(not(windows))]
fn default_path() -> OsString {
    OsString::from("/usr/bin:/bin")
}

#[cfg(windows)]
fn default_path() -> OsString {
    OsString::new()
}

/// The names Node can start without a shell: the name itself off Windows.
#[cfg(not(windows))]
fn candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    vec![dir.join(name)]
}

/// On Windows, `.com` and `.exe` in PATHEXT's order.
#[cfg(windows)]
fn candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    let pathext = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    pathext
        .split(';')
        .map(|e| e.trim().to_ascii_lowercase())
        .filter(|e| e == ".com" || e == ".exe")
        .map(|e| dir.join(format!("{name}{e}")))
        .collect()
}

#[cfg(unix)]
fn runnable(file: &Path) -> bool {
    // `access(X_OK)`, as `accessSync` asks: it weighs ownership and `noexec` mounts too.
    std::fs::metadata(file).is_ok_and(|m| m.is_file())
        && rustix::fs::access(file, rustix::fs::Access::EXEC_OK).is_ok()
}

#[cfg(not(unix))]
fn runnable(file: &Path) -> bool {
    std::fs::metadata(file).is_ok_and(|m| m.is_file())
}

/// The real path, without Windows' `\\?\` prefix (Node's `realpathSync` gives none).
pub(crate) fn real(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok().map(|p| unverbatim(&p))
}

pub(crate) fn unverbatim(path: &Path) -> PathBuf {
    let Some(s) = path.to_str() else {
        return path.to_path_buf();
    };
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

/// A path as compared: letter case ignored on Windows.
#[cfg(windows)]
pub(crate) fn fold(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

#[cfg(not(windows))]
pub(crate) fn fold(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn same(a: &Path, b: &Path) -> bool {
    fold(a) == fold(b)
}

/// Whether `dir` is `tree` or under it (letter case ignored on Windows).
fn under(dir: &Path, tree: &Path) -> bool {
    let (d, t) = (PathBuf::from(fold(dir)), PathBuf::from(fold(tree)));
    d.starts_with(&t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_root_or_home_folder_holds_all() {
        let home = env::temp_dir().join("gg-index-home");
        assert!(holds_all(Path::new("/"), &[]));
        assert!(holds_all(&home, std::slice::from_ref(&home)));
        assert!(!holds_all(&home.join("sub"), std::slice::from_ref(&home)));
        assert!(!holds_all(&home, &[]));
    }

    #[test]
    fn verbatim_prefixes_are_removed() {
        assert_eq!(unverbatim(Path::new(r"\\?\C:\x")), PathBuf::from(r"C:\x"));
        assert_eq!(
            unverbatim(Path::new(r"\\?\UNC\h\s\x")),
            PathBuf::from(r"\\h\s\x")
        );
        assert_eq!(unverbatim(Path::new("/usr/bin")), PathBuf::from("/usr/bin"));
    }

    #[cfg(unix)]
    #[test]
    fn a_program_inside_a_working_folder_or_a_package_bin_is_passed_over() {
        use std::os::unix::fs::PermissionsExt;
        let base = env::temp_dir().join(format!("gg-index-find-program-{}", std::process::id()));
        drop(std::fs::remove_dir_all(&base));
        let make = |dir: &str| {
            let d = base.join(dir);
            std::fs::create_dir_all(&d).expect("mkdir");
            let f = d.join("tool");
            std::fs::write(
                &f,
                "#!/bin/sh
",
            )
            .expect("write");
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).expect("chmod");
            real(&d).expect("real")
        };
        let (tree, bin, sys) = (make("tree/bin"), make("p/node_modules/.bin"), make("sys"));
        let working = [(real(&base.join("tree")).expect("real"), false)];
        let path =
            env::join_paths(["relative".into(), tree.clone(), bin, sys.clone()]).expect("join");
        assert_eq!(
            find_in("tool", &path, &working, None),
            Some(sys.join("tool"))
        );
        // A working folder that holds all passes over only itself.
        let all = [(real(&base).expect("real"), true)];
        assert_eq!(find_in("tool", &path, &all, None), Some(tree.join("tool")));
        let only_tree = env::join_paths([&tree]).expect("join");
        assert_eq!(find_in("tool", &only_tree, &working, None), None);
        assert_eq!(find_in("absent", &path, &working, None), None);
        // Yarn's bin folder is passed over like a package bin.
        assert_eq!(find_in("tool", &path, &working, Some(&sys)), None);
        // A folder that does not exist is passed over; a file without the execute bit is not run.
        let plain = base.join("plain");
        std::fs::create_dir_all(&plain).expect("mkdir");
        std::fs::write(plain.join("tool"), "").expect("write");
        let gone = base.join("gone");
        // A link whose real path is in the working folder is passed over too.
        let alias = base.join("alias");
        std::os::unix::fs::symlink(&tree, &alias).expect("link");
        let path = env::join_paths([gone, plain, alias, sys.clone()]).expect("join");
        assert_eq!(
            find_in("tool", &path, &working, None),
            Some(sys.join("tool"))
        );
        std::fs::remove_dir_all(&base).expect("clean up");
    }

    #[cfg(windows)]
    #[test]
    fn a_case_variant_package_bin_is_passed_over() {
        let base = env::temp_dir().join(format!("gg-index-find-program-{}", std::process::id()));
        drop(std::fs::remove_dir_all(&base));
        let make = |dir: &str| {
            let d = base.join(dir);
            std::fs::create_dir_all(&d).expect("mkdir");
            std::fs::write(d.join("tool.exe"), "").expect("write");
            real(&d).expect("real")
        };
        let (upper, mixed_parent, mixed_child, sys) = (
            make(r"p1\NODE_MODULES\.BIN"),
            make(r"p2\Node_Modules\.bin"),
            make(r"p3\node_modules\.BIN"),
            make("sys"),
        );
        let path = env::join_paths([upper, mixed_parent, mixed_child, sys.clone()]).expect("join");
        let got = find_in("tool", &path, &[], None);
        std::fs::remove_dir_all(&base).expect("clean up");
        assert_eq!(got, Some(sys.join("tool.exe")));
    }

    #[cfg(unix)]
    #[test]
    fn a_name_that_is_not_utf8_is_kept_as_it_is() {
        use std::os::unix::ffi::OsStrExt;
        let p = Path::new(std::ffi::OsStr::from_bytes(b"/x/\xff"));
        assert_eq!(unverbatim(p), p);
    }
}
