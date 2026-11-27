//! Finding a program to start, by the rule of `src/util/program.ts`: a bare name is looked
//! up only in PATH's absolute folders, passing over each folder that is a working folder or
//! under one, a `node_modules/.bin` folder and Yarn's `BERRY_BIN_FOLDER`, and the program
//! is started by its absolute path. A checkout's own `git` therefore never runs in place
//! of the person's.
//!
//! This is the subset of that rule the port needs. The TypeScript also tests each folder by
//! volume and file identity (shares and bind mounts that spell a working folder another
//! way); here a folder is judged by its real path alone.

use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Program `name` (`git`), found as above; `trees` are the working folders to pass over
/// besides this process's current folder.
#[must_use]
pub fn find_program(name: &str, trees: &[&Path]) -> Option<PathBuf> {
    let mut working: Vec<PathBuf> = trees.iter().filter_map(|t| real(t)).collect();
    if let Some(cwd) = env::current_dir().ok().and_then(|c| real(&c)) {
        working.push(cwd);
    }
    let path = env::var_os("PATH").unwrap_or_else(default_path);
    find_in(name, &path, &working)
}

/// [`find_program`] over a given PATH value and working folders (real paths).
fn find_in(name: &str, path: &OsString, working: &[PathBuf]) -> Option<PathBuf> {
    let berry = env::var_os("BERRY_BIN_FOLDER")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .and_then(|p| real(&p));
    let passed_over = |dir: &Path| {
        let package_bin = dir.file_name().is_some_and(|n| n == ".bin")
            && dir
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|n| n == "node_modules");
        package_bin
            || berry.as_deref().is_some_and(|b| same(b, dir))
            || working.iter().any(|w| under(dir, w))
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
            let in_tree = found
                .parent()
                .is_some_and(|p| working.iter().any(|w| under(p, w)));
            if !in_tree && runnable(&found) {
                return Some(file);
            }
        }
    }
    None
}

/// With no PATH at all, POSIX looks in /usr/bin and /bin, as libuv does.
fn default_path() -> OsString {
    if cfg!(windows) {
        OsString::new()
    } else {
        OsString::from("/usr/bin:/bin")
    }
}

/// The names Node can start without a shell: on Windows `.com` and `.exe` in PATHEXT's order.
fn candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    if !cfg!(windows) {
        return vec![dir.join(name)];
    }
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
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(file).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
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

fn fold(path: &Path) -> String {
    let s = path.to_string_lossy();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.into_owned()
    }
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
        let base = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("find-program");
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
        let working = [real(&base.join("tree")).expect("real")];
        let path =
            env::join_paths(["relative".into(), tree.clone(), bin, sys.clone()]).expect("join");
        assert_eq!(find_in("tool", &path, &working), Some(sys.join("tool")));
        let only_tree = env::join_paths([tree]).expect("join");
        assert_eq!(find_in("tool", &only_tree, &working), None);
        assert_eq!(find_in("absent", &path, &working), None);
    }
}
