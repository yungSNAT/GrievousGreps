//! Safe child-process binary lookup outside repository trees (GHSA-xmq8-85qx-9f3q).
//!
//! Mirrors `src/util/program.ts`: never executes bare names out of relative `PATH`
//! entries, cwd, `repo`, `node_modules/.bin`, or symlinks pointing into them.

use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};

const MAX_SYMLINK_DEPTH: usize = 40;

fn home_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        env::var_os("USERPROFILE").map(PathBuf::from).or_else(|| {
            let drive = env::var_os("HOMEDRIVE")?;
            let path = env::var_os("HOMEPATH")?;
            let mut joined = drive;
            joined.push(path);
            Some(PathBuf::from(joined))
        })
    } else {
        env::var_os("HOME").map(PathBuf::from)
    }
}

fn fold_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    if cfg!(windows) {
        s.to_ascii_lowercase()
    } else {
        s.into_owned()
    }
}

fn is_absolute_entry(raw: &str) -> bool {
    if cfg!(windows) {
        let bytes = raw.as_bytes();
        let drive = bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/');
        drive || raw.starts_with("\\\\") || raw.starts_with("//")
    } else {
        raw.starts_with('/')
    }
}

fn is_filesystem_root(path: &Path) -> bool {
    path.parent().is_none_or(|p| p == path)
}

fn lexical_clean(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push(comp);
                }
            }
            _ => out.push(comp),
        }
    }
    out
}

fn both_ways(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::with_capacity(2);
    let abs = if dir.is_absolute() {
        lexical_clean(dir)
    } else if let Ok(cwd) = env::current_dir() {
        lexical_clean(&cwd.join(dir))
    } else {
        dir.to_path_buf()
    };
    out.push(abs.clone());
    if let Ok(real) = fs::canonicalize(&abs)
        && real != abs
    {
        out.push(real);
    }
    out
}

#[cfg(unix)]
fn file_identity(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let m = fs::metadata(path).ok()?;
    Some((m.dev(), m.ino()))
}

#[cfg(not(unix))]
fn file_identity(_path: &Path) -> Option<(u64, u64)> {
    None
}

fn runnable(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        (meta.permissions().mode() & 0o111) != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn link_folders(file: &Path) -> Option<Vec<PathBuf>> {
    let start = if cfg!(windows) {
        lexical_clean(file)
    } else {
        file.to_path_buf()
    };
    let mut iter = start.components();
    let mut at = PathBuf::new();
    let mut todo: Vec<Component<'_>> = Vec::new();
    for comp in &mut iter {
        match comp {
            Component::Prefix(_) | Component::RootDir => at.push(comp),
            Component::CurDir => {}
            other => todo.push(other),
        }
    }
    let mut todo_owned: Vec<OsString> = todo
        .into_iter()
        .map(|c| match c {
            Component::ParentDir => OsString::from(".."),
            Component::Normal(s) => s.to_os_string(),
            _ => OsString::new(),
        })
        .collect();

    let mut found = Vec::new();
    let mut links = 0_usize;
    let mut idx = 0;
    while idx < todo_owned.len() {
        let part = todo_owned[idx].clone();
        idx += 1;
        if part == ".." {
            if let Some(p) = at.parent() {
                at = p.to_path_buf();
            }
            continue;
        }
        let next = at.join(&part);
        let Ok(meta) = fs::symlink_metadata(&next) else {
            return None;
        };
        if !meta.file_type().is_symlink() {
            at = next;
            continue;
        }
        let Ok(target) = fs::read_link(&next) else {
            return None;
        };
        links += 1;
        if links > MAX_SYMLINK_DEPTH {
            return None;
        }
        let has_more = idx < todo_owned.len();
        found.push(if has_more { next.clone() } else { at.clone() });
        let resolved = if target.is_absolute() {
            target
        } else {
            at.join(&target)
        };
        let rest_tail: Vec<OsString> = todo_owned[idx..].to_vec();
        at.clear();
        todo_owned.clear();
        idx = 0;
        let base = if cfg!(windows) {
            lexical_clean(&resolved)
        } else {
            resolved
        };
        for comp in base.components() {
            match comp {
                Component::Prefix(_) | Component::RootDir => at.push(comp),
                Component::CurDir => {}
                Component::ParentDir => todo_owned.push(OsString::from("..")),
                Component::Normal(s) => todo_owned.push(s.to_os_string()),
            }
        }
        todo_owned.extend(rest_tail);
    }
    if let Some(parent) = at.parent() {
        found.push(parent.to_path_buf());
    }
    Some(found)
}

struct LookupRules {
    home: HashSet<String>,
    trees: Vec<PathBuf>,
    tree_ids: Vec<((u64, u64), bool)>,
    yarn_bin: Vec<String>,
}

impl LookupRules {
    fn new(cwd: &Path) -> Self {
        let home: HashSet<String> = home_dir()
            .map(|h| both_ways(&h).into_iter().map(|p| fold_path(&p)).collect())
            .unwrap_or_default();
        let home_id = home_dir().and_then(|h| file_identity(&h));

        let mut work = Vec::new();
        if let Ok(proc_cwd) = env::current_dir() {
            work.push(proc_cwd);
        }
        work.push(cwd.to_path_buf());

        let mut trees = Vec::new();
        let mut tree_ids = Vec::new();
        for dir in &work {
            for p in both_ways(dir) {
                trees.push(p);
            }
            if let Some(id) = file_identity(dir) {
                let root_id = fs::canonicalize(dir)
                    .ok()
                    .and_then(|r| r.ancestors().last().and_then(file_identity));
                let holds_all = Some(id) == home_id || (root_id.is_some() && Some(id) == root_id);
                tree_ids.push((id, holds_all));
            }
        }

        let berry = env::var_os("BERRY_BIN_FOLDER")
            .and_then(|v| v.into_string().ok())
            .filter(|s| is_absolute_entry(s));
        let yarn_bin = berry
            .map(|b| {
                both_ways(Path::new(&b))
                    .into_iter()
                    .map(|p| fold_path(&p))
                    .collect()
            })
            .unwrap_or_default();

        Self {
            home,
            trees,
            tree_ids,
            yarn_bin,
        }
    }

    fn holds_all(&self, tree: &Path) -> bool {
        is_filesystem_root(tree) || self.home.contains(&fold_path(tree))
    }

    fn in_tree(&self, dir: &Path) -> bool {
        let folded = fold_path(dir);
        self.trees.iter().any(|tree| {
            let tf = fold_path(tree);
            if folded == tf {
                return true;
            }
            if self.holds_all(tree) {
                return false;
            }
            let alt_prefix = format!("{}/", tf.trim_end_matches(['/', '\\']));
            let prefix = if tf.ends_with(['/', '\\']) {
                tf
            } else {
                format!("{tf}{}", std::path::MAIN_SEPARATOR)
            };
            folded.starts_with(&prefix) || folded.starts_with(&alt_prefix)
        })
    }

    fn under_by_id(&self, dir: &Path) -> bool {
        if self.tree_ids.is_empty() {
            return false;
        }
        let mut at = lexical_clean(dir);
        let mut is_self = true;
        loop {
            if let Some(id) = file_identity(&at) {
                for &(tid, holds_all) in &self.tree_ids {
                    if tid == id && (is_self || !holds_all) {
                        return true;
                    }
                }
            }
            let Some(parent) = at.parent() else {
                return false;
            };
            if parent == at {
                return false;
            }
            at = parent.to_path_buf();
            is_self = false;
        }
    }

    fn passed_over(&self, dir: &Path) -> bool {
        let is_pkg_bin = dir.file_name().and_then(|s| s.to_str()) == Some(".bin")
            && dir
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|s| s.to_str())
                == Some("node_modules");
        is_pkg_bin
            || self.yarn_bin.contains(&fold_path(dir))
            || self.in_tree(dir)
            || self.under_by_id(dir)
    }

    fn allows(&self, written: &Path, entry_dirs: &[PathBuf]) -> bool {
        if entry_dirs.iter().any(|d| self.passed_over(d)) {
            return false;
        }
        let Some(traced) = link_folders(written) else {
            return false;
        };
        let Ok(real_file) = fs::canonicalize(written) else {
            return false;
        };
        let mut check_dirs = Vec::new();
        if let Some(parent) = real_file.parent() {
            check_dirs.push(parent.to_path_buf());
        }
        for d in &traced {
            check_dirs.push(d.clone());
            if let (Some(dp), Some(base)) = (d.parent(), d.file_name())
                && let Ok(real_parent) = fs::canonicalize(dp)
            {
                check_dirs.push(real_parent.join(base));
            }
        }
        !check_dirs
            .iter()
            .any(|d| self.in_tree(d) || self.under_by_id(d))
    }
}

fn path_endings(name: &str) -> Vec<String> {
    if !cfg!(windows) {
        return vec![String::new()];
    }
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".com") || lower.ends_with(".exe") {
        return vec![String::new()];
    }
    let raw = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let mut out = Vec::new();
    for ext in raw.split(';') {
        let e = ext.trim().to_ascii_lowercase();
        if e == ".com" || e == ".exe" {
            out.push(e);
        }
    }
    out
}

/// Locate a program by bare name strictly from absolute `PATH` directories outside
/// working trees, `node_modules/.bin`, and Yarn bin folders.
pub fn locate_program(name: &str, cwd: &Path) -> Result<PathBuf, String> {
    let rules = LookupRules::new(cwd);
    if name.contains('/') || (cfg!(windows) && name.contains('\\')) {
        let p = Path::new(name);
        if is_absolute_entry(name) {
            let dir = p
                .parent()
                .map(lexical_clean)
                .unwrap_or_else(|| p.to_path_buf());
            let mut dirs = vec![dir.clone()];
            if let Ok(r) = fs::canonicalize(&dir) {
                dirs.push(r);
            }
            if runnable(p) && rules.allows(p, &dirs) {
                return Ok(p.to_path_buf());
            }
        }
        return Err(format!(
            "{name} was not started: trail starts programs only by an absolute path outside the working folder and its subfolders"
        ));
    }

    let path_env = env::var("PATH").unwrap_or_else(|_| {
        if cfg!(windows) {
            String::new()
        } else {
            "/usr/bin:/bin".to_string()
        }
    });
    let endings = path_endings(name);
    let sep = if cfg!(windows) { ';' } else { ':' };

    for raw_entry in path_env.split(sep) {
        let listed = if cfg!(windows) {
            let trimmed = raw_entry.trim();
            trimmed
                .strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .unwrap_or(trimmed)
        } else {
            raw_entry
        };
        if !is_absolute_entry(listed) {
            continue;
        }
        let Ok(real_dir) = fs::canonicalize(listed) else {
            continue;
        };
        for ending in &endings {
            let candidate = real_dir.join(format!("{name}{ending}"));
            if !runnable(&candidate) {
                continue;
            }
            let written = Path::new(listed).join(format!("{name}{ending}"));
            let mut entry_dirs = vec![lexical_clean(Path::new(listed)), real_dir.clone()];
            if let Some(wp) = lexical_clean(&written).parent() {
                entry_dirs.push(wp.to_path_buf());
            }
            if rules.allows(&written, &entry_dirs) {
                return Ok(candidate);
            }
        }
    }
    Err(format!(
        "{name} was not found on PATH outside the working folder and its subfolders"
    ))
}
