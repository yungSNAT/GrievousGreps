//! The file set a graph build parses and its stat metadata: `walkDir` and
//! `canonicalWalkRoot` (src/ingest/fs.ts) and `listSourceFiles` and `listSourceStats`
//! (src/graph/source-files.ts).
//!
//! Safety properties, each with a test in `tests/sources.rs`:
//! - Containment: every path listed is under the root; a path Git or the walk yields
//!   outside it is dropped, and the output directory is left out.
//! - Links: only the root itself is unwrapped when it is a link to a folder; inside the
//!   tree a link is never followed (Git's entries are `lstat`ed, the walk takes only real
//!   files and folders).
//! - Bounded reads: no file is opened; size comes from metadata, and files over
//!   1,000,000 bytes are left out. Git's listing is read to 64 MiB at most, past which Git is
//!   stopped and the walk falls back to the file system, as Node's `maxBuffer` makes it.
//! - Unreadable folders: outside Git a folder that cannot be listed fails the command with
//!   its path, as `readdirSync` throws in TypeScript.
//! - Names that are not UTF-8: Node decodes them lossily, so such a file never stats and is
//!   dropped, and such a folder fails the walk unless its lossy name is skipped. The port
//!   does the same, naming the folder.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use crate::deploy::deploy_format_of;
use crate::json::js_number;
use crate::program::{find_program, fold, unverbatim};
use crate::source_files::parser_claims;

/// `SKIP_DIRS`: dependency and build output, never source.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "_build",
    "out",
    "target",
    "vendor",
    "coverage",
    "__pycache__",
    "venv",
];

/// `DOT_SKIP_DIRS`: dot folders of tools' caches and state.
const DOT_SKIP_DIRS: &[&str] = &[
    ".git",
    ".graft",
    ".trail",
    ".venv",
    ".tox",
    ".nox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".yarn",
    ".pnpm-store",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
    ".gradle",
    ".dart_tool",
    ".pub-cache",
    ".bundle",
    ".ipynb_checkpoints",
    ".terraform",
];

/// `NEVER_INCLUDE_DIRS`: names `--include-dir` never un-skips.
const NEVER_INCLUDE_DIRS: &[&str] = &[".git", ".trail", ".graft"];

/// `MAX_FILE_BYTES`.
pub const MAX_FILE_BYTES: u64 = 1_000_000;

/// Node's `maxBuffer` for the `git ls-files` call.
pub const MAX_GIT_OUTPUT: usize = 64 << 20;

/// What `walkDir` and `listSourceStats` take besides the root and output directory.
#[derive(Default)]
pub struct Options {
    pub includes: Vec<String>,
    pub follow_submodules: bool,
    pub follow_nested_repos: bool,
    pub only_dirs: Vec<String>,
    pub extensions: Vec<String>,
}

/// One `SourceStat` as the parity harness prints it: `[rel, size, mtimeMs]`.
pub struct SourceStat {
    pub rel: String,
    pub size: u64,
    pub mtime_ms: f64,
}

/// `shouldSkipDir`.
fn should_skip_dir(name: &str, includes: &HashSet<&str>) -> bool {
    if NEVER_INCLUDE_DIRS.contains(&name) {
        return true;
    }
    if includes.contains(name) {
        return false;
    }
    name.starts_with('.') || SKIP_DIRS.contains(&name)
}

/// `skippedPath`: a path Git lists (either separator).
fn skipped_path(path: &str, includes: &HashSet<&str>) -> bool {
    let mut segments: Vec<&str> = path.split(['/', '\\']).collect();
    let last = segments.pop().unwrap_or("");
    should_skip_dir(last, includes)
        || segments.iter().any(|s| {
            if s.starts_with('.') {
                DOT_SKIP_DIRS.contains(s)
                    && (NEVER_INCLUDE_DIRS.contains(s) || !includes.contains(s))
            } else {
                should_skip_dir(s, includes)
            }
        })
}

/// `path.resolve`: absolute against the current folder, `.` and `..` removed lexically
/// (`components` already drops each `.` of an absolute path).
pub fn resolve(path: &Path) -> Result<PathBuf, String> {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("current folder: {e}"))?
            .join(path)
    };
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    Ok(out)
}

/// `canonicalWalkRoot`: a link to a folder as the root is unwrapped once.
fn canonical_walk_root(abs: &Path) -> Result<PathBuf, String> {
    match fs::symlink_metadata(abs) {
        Ok(m) if m.file_type().is_symlink() => {}
        _ => return Ok(abs.to_path_buf()),
    }
    let real = fs::canonicalize(abs).map_err(|e| {
        if is_loop(&e) {
            format!("symbolic link loop: {}", abs.display())
        } else {
            format!("broken symbolic link: {}", abs.display())
        }
    })?;
    let real = unverbatim(&real);
    let broken = |_| format!("broken symbolic link: {}", abs.display());
    let is_dir = fs::metadata(&real).map_err(broken)?.is_dir();
    Ok(if is_dir { real } else { abs.to_path_buf() })
}

#[cfg(unix)]
fn is_loop(e: &std::io::Error) -> bool {
    e.raw_os_error() == Some(rustix::io::Errno::LOOP.raw_os_error())
}

#[cfg(not(unix))]
fn is_loop(_: &std::io::Error) -> bool {
    false
}

/// `walkDir`: absolute paths of the repository's files, on the root as given.
pub fn walk_dir(dir: &Path, opts: &Options) -> Result<Vec<PathBuf>, String> {
    let requested = resolve(dir)?;
    let root = canonical_walk_root(&requested)?;
    let includes: HashSet<&str> = opts.includes.iter().map(String::as_str).collect();
    let files = match Git::find(&root) {
        Some(git) => git.visible_files(&root, &includes, opts)?,
        None => None,
    };
    let files = match files {
        Some(f) => f,
        None => walk_filesystem(&root, &includes)?,
    };
    if requested == root {
        return Ok(files);
    }
    // Remap onto the root as given, so relative paths do not escape through the real path.
    Ok(files
        .into_iter()
        .filter_map(|abs| {
            let rel = abs.strip_prefix(&root).ok()?;
            (!rel.as_os_str().is_empty()).then(|| requested.join(rel))
        })
        .collect())
}

struct Git(PathBuf);

impl Git {
    fn find(root: &Path) -> Option<Self> {
        find_program("git", &[root]).map(Git)
    }

    /// `git <args>` in `root`; None when it cannot start, fails, or writes over the bound.
    fn list(&self, root: &Path, args: &[&str]) -> Option<Vec<u8>> {
        let mut cmd = Command::new(&self.0);
        cmd.args(args)
            .current_dir(root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, Node's windowsHide
        }
        let mut child = cmd.spawn().ok()?;
        let mut out = Vec::new();
        let read = child
            .stdout
            .take()?
            .take(MAX_GIT_OUTPUT as u64 + 1)
            .read_to_end(&mut out);
        if read.is_err() || out.len() > MAX_GIT_OUTPUT {
            drop(child.kill());
            drop(child.wait());
            return None;
        }
        child.wait().ok()?.success().then_some(out)
    }

    /// `gitVisibleFiles`: None when Git does not list this root.
    fn visible_files(
        &self,
        root: &Path,
        includes: &HashSet<&str>,
        opts: &Options,
    ) -> Result<Option<Vec<PathBuf>>, String> {
        if !opts.follow_submodules && !opts.follow_nested_repos {
            return Ok(self.shallow(root, includes));
        }
        let mut active = HashSet::new();
        self.recursive(root, root, includes, opts, &mut active)
    }

    fn shallow(&self, root: &Path, includes: &HashSet<&str>) -> Option<Vec<PathBuf>> {
        let out = self.list(
            root,
            &[
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
            ],
        )?;
        Some(
            records(&out)
                .filter(|rel| !skipped_path(rel, includes))
                .map(|rel| join(root, rel))
                .filter(|abs| small_file(abs))
                .collect(),
        )
    }

    fn recursive(
        &self,
        root: &Path,
        top: &Path,
        includes: &HashSet<&str>,
        opts: &Options,
        active: &mut HashSet<String>,
    ) -> Result<Option<Vec<PathBuf>>, String> {
        let key = fold(root);
        if active.contains(&key) {
            return Ok(Some(Vec::new()));
        }
        active.insert(key.clone());
        let args = [
            "ls-files",
            "-t",
            "--stage",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
        ];
        let Some(out) = self.list(root, &args) else {
            active.remove(&key);
            return Ok(None);
        };
        let mut files = Vec::new();
        for (rel, gitlink, nested) in stage_records(&out) {
            let abs = join(root, rel);
            let from_top = abs.strip_prefix(top).unwrap_or(&abs).to_string_lossy();
            if skipped_path(&from_top, includes) {
                continue;
            }
            if (gitlink && opts.follow_submodules) || (nested && opts.follow_nested_repos) {
                if !abs.join(".git").exists() {
                    continue;
                }
                let child = match self.recursive(&abs, top, includes, opts, active)? {
                    Some(f) => f,
                    None => walk_filesystem(&abs, includes)?,
                };
                files.extend(child);
                continue;
            }
            if small_file(&abs) {
                files.push(abs);
            }
        }
        active.remove(&key);
        // A Set sorted by UTF-16 code units, as JavaScript's default sort orders strings.
        let mut keyed: Vec<(Vec<u16>, PathBuf)> = files
            .into_iter()
            .map(|p| (p.to_string_lossy().encode_utf16().collect(), p))
            .collect();
        keyed.sort_by(|a, b| a.0.cmp(&b.0));
        keyed.dedup_by(|a, b| a.0 == b.0);
        Ok(Some(keyed.into_iter().map(|(_, p)| p).collect()))
    }
}

/// `git ls-files -t --stage` records as `(path, gitlink, nested repository)`. A path has
/// several stage records during a merge: they collapse, in first-seen order.
fn stage_records(out: &[u8]) -> Vec<(&str, bool, bool)> {
    let mut order: Vec<(&str, bool, bool)> = Vec::new();
    let mut at: HashMap<&str, usize> = HashMap::new();
    for record in records(out) {
        let Some((tag, body)) = record.split_at_checked(2).filter(|(t, _)| t.ends_with(' ')) else {
            continue;
        };
        let (rel, gitlink, nested) = if tag == "? " {
            body.strip_suffix('/')
                .map_or((body, false, false), |r| (r, false, true))
        } else {
            let Some((head, rel)) = body.split_once('\t') else {
                continue;
            };
            (rel, head.starts_with("160000 "), false)
        };
        if rel.is_empty() {
            continue;
        }
        let i = *at.entry(rel).or_insert_with(|| {
            order.push((rel, false, false));
            order.len() - 1
        });
        order[i].1 |= gitlink;
        order[i].2 |= nested;
    }
    order
}

/// NUL-separated records that are UTF-8; others name no file Node could stat.
fn records(out: &[u8]) -> impl Iterator<Item = &str> {
    out.split(|&b| b == 0)
        .filter_map(|r| std::str::from_utf8(r).ok())
        .filter(|r| !r.is_empty())
}

/// `resolve(root, rel)` for a Git-relative path.
fn join(root: &Path, rel: &str) -> PathBuf {
    let mut out = root.to_path_buf();
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    out
}

/// A regular file (not a link) of at most [`MAX_FILE_BYTES`].
fn small_file(abs: &Path) -> bool {
    fs::symlink_metadata(abs).is_ok_and(|m| m.is_file() && m.len() <= MAX_FILE_BYTES)
}

/// `walkFilesystem`: depth first, each folder in Node's `readdirSync` order (byte order on
/// POSIX, where libuv sorts; the system's order on Windows).
fn walk_filesystem(dir: &Path, includes: &HashSet<&str>) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    let mut stack = vec![(dir.to_path_buf(), list_dir(dir)?.into_iter())];
    while let Some((at, entries)) = stack.last_mut() {
        let Some((name, kind)) = entries.next() else {
            stack.pop();
            continue;
        };
        let full = at.join(&name);
        match name.to_str() {
            None if kind.is_dir() => {
                let lossy = name.to_string_lossy();
                if !should_skip_dir(&lossy, includes) {
                    return Err(format!("folder name is not UTF-8: {}", full.display()));
                }
            }
            None => {}
            Some(n) if kind.is_dir() => {
                if !should_skip_dir(n, includes) {
                    let next = list_dir(&full)?;
                    stack.push((full, next.into_iter()));
                }
            }
            Some(n) if kind.is_file() && !n.starts_with('.') => {
                if fs::metadata(&full).is_ok_and(|m| m.len() <= MAX_FILE_BYTES) {
                    out.push(full);
                }
            }
            Some(_) => {}
        }
    }
    Ok(out)
}

fn list_dir(dir: &Path) -> Result<Vec<(std::ffi::OsString, fs::FileType)>, String> {
    let fail = |e: std::io::Error| format!("{}: {e}", dir.display());
    let mut v = Vec::new();
    for entry in fs::read_dir(dir).map_err(fail)? {
        let entry = entry.map_err(fail)?;
        v.push((entry.file_name(), entry.file_type().map_err(fail)?));
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        v.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    }
    Ok(v)
}

/// JavaScript's `String.prototype.trim` set: White_Space plus U+FEFF.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `normExt`.
fn norm_ext(e: &str) -> String {
    let t = js_trim(e).to_lowercase();
    if t.starts_with('.') {
        t
    } else {
        format!(".{t}")
    }
}

/// Node's `path.extname` of a file name.
fn extname(base: &str) -> &str {
    let Some(dot) = base.rfind('.') else {
        return "";
    };
    let before = &base[..dot];
    if before.is_empty() || (base == "..") {
        return "";
    }
    &base[dot..]
}

/// `listSourceStats(root, outDir, walkDir(root, ...), onlyDirs, extensions)`.
pub fn list_source_stats(
    root: &Path,
    out_dir: &Path,
    opts: &Options,
) -> Result<Vec<SourceStat>, String> {
    let files = walk_dir(root, opts)?;
    let root = resolve(root)?;
    let selected: Option<HashSet<String>> = (!opts.extensions.is_empty())
        .then(|| opts.extensions.iter().map(|e| norm_ext(e)).collect());
    let abs_out = resolve(out_dir)?.to_string_lossy().into_owned();
    let sep = std::path::MAIN_SEPARATOR;
    let out_prefix = if abs_out.ends_with(sep) {
        abs_out.clone()
    } else {
        format!("{abs_out}{sep}")
    };
    let stat = |abs: PathBuf| -> Option<SourceStat> {
        let text = abs.to_str()?;
        if text == abs_out || text.starts_with(&out_prefix) {
            return None;
        }
        let base = abs.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if let Some(sel) = &selected
            && !sel.contains(&extname(base).to_lowercase())
        {
            return None;
        }
        if !(parser_claims(text) || (selected.is_none() && deploy_format_of(text).is_some())) {
            return None;
        }
        let rel: Vec<&str> = abs
            .strip_prefix(&root)
            .ok()?
            .components()
            .filter_map(|c| c.as_os_str().to_str())
            .collect();
        let rel = rel.join("/");
        let only = &opts.only_dirs;
        if !only.is_empty()
            && !only
                .iter()
                .any(|d| rel == *d || rel.starts_with(&format!("{d}/")))
        {
            return None;
        }
        let meta = fs::metadata(&abs).ok()?;
        Some(SourceStat {
            rel,
            size: meta.len(),
            mtime_ms: mtime_ms(&meta),
        })
    };
    Ok(files.into_iter().filter_map(stat).collect())
}

/// Node's `mtimeMs`: `sec * 1e3 + nsec / 1e6`, from the time as libuv gives it.
#[cfg(unix)]
fn mtime_ms(meta: &fs::Metadata) -> f64 {
    use std::os::unix::fs::MetadataExt;
    meta.mtime() as f64 * 1e3 + meta.mtime_nsec() as f64 / 1e6
}

#[cfg(windows)]
fn mtime_ms(meta: &fs::Metadata) -> f64 {
    use std::os::windows::fs::MetadataExt;
    // libuv's uv__filetime_to_timespec: 100 ns ticks since 1601.
    const TICKS: i64 = 10_000_000;
    let t = meta.last_write_time() as i64 - 11_644_473_600 * TICKS;
    let (mut sec, mut nsec) = (t / TICKS, (t % TICKS) * 100);
    if nsec < 0 {
        sec -= 1;
        nsec += 1_000_000_000;
    }
    sec as f64 * 1e3 + nsec as f64 / 1e6
}

/// `JSON.stringify(stats.map((s) => [s.rel, s.size, s.mtimeMs]))`.
#[must_use]
pub fn to_json(stats: &[SourceStat]) -> String {
    let mut out = String::from("[");
    for (i, s) in stats.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("[\"");
        for c in s.rel.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\u{8}' => out.push_str("\\b"),
                '\u{c}' => out.push_str("\\f"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => {
                    let _ = write!(out, "\\u{:04x}", c as u32);
                }
                c => out.push(c),
            }
        }
        let _ = write!(
            out,
            "\",{},{}]",
            js_number(s.size as f64),
            js_number(s.mtime_ms)
        );
    }
    out.push_str("]\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extname_follows_node() {
        for (name, want) in [
            ("a.ts", ".ts"),
            (".x", ""),
            ("..x", ".x"),
            ("..", ""),
            ("...", "."),
            ("a.", "."),
            ("a", ""),
            (".x.ts", ".ts"),
        ] {
            assert_eq!(extname(name), want, "{name}");
        }
    }

    #[test]
    fn skipped_paths_follow_typescript() {
        let none = HashSet::new();
        assert!(skipped_path("node_modules/a.ts", &none));
        assert!(skipped_path(".venv/a.py", &none));
        assert!(!skipped_path("examples/.test/a.ts", &none));
        assert!(skipped_path("src/.eslintrc.js", &none));
        let kb: HashSet<&str> = [".cache", ".git"].into();
        assert!(!skipped_path(".cache/a.ts", &kb));
        assert!(skipped_path(".git/a.ts", &kb));
    }

    #[test]
    fn json_escapes_as_json_stringify() {
        let s = [SourceStat {
            rel: "a\"\\\u{1}ü😀".into(),
            size: 3,
            mtime_ms: 1.5,
        }];
        assert_eq!(to_json(&s), "[[\"a\\\"\\\\\\u0001ü😀\",3,1.5]]\n");
        let c = [SourceStat {
            rel: "\u{8}\u{c}\n\r\t".into(),
            size: 0,
            mtime_ms: 0.0,
        }];
        assert_eq!(to_json(&c), "[[\"\\b\\f\\n\\r\\t\",0,0]]\n");
    }

    #[test]
    fn never_included_folders_stay_skipped() {
        let all: HashSet<&str> = [".git", ".trail", "dist"].into();
        assert!(should_skip_dir(".git", &all));
        assert!(should_skip_dir(".trail", &all));
        assert!(!should_skip_dir("dist", &all));
    }

    #[test]
    fn paths_resolve_lexically_as_node_does() {
        let cwd = std::env::current_dir().expect("cwd");
        assert_eq!(
            resolve(Path::new("./a/../b")).expect("resolve"),
            cwd.join("b")
        );
        let root = cwd.join("r");
        assert_eq!(join(&root, "a/./../b.ts"), root.join("b.ts"));
    }

    #[test]
    fn stage_records_collapse_and_skip_what_is_not_a_record() {
        let out = b"H 100644 aa 1\ta.ts\0x\0Hx\0H 100644 no-tab\0? \0? nested/\0\
S 160000 bb 0\tsub\0M 100644 cc 2\ta.ts\0M 160000 dd 3\ta.ts\0? new.py\0";
        assert_eq!(
            stage_records(out),
            [
                ("a.ts", true, false),
                ("nested", false, true),
                ("sub", true, false),
                ("new.py", false, false),
            ]
        );
    }

    #[test]
    fn a_root_already_being_listed_yields_nothing() {
        let git = Git(PathBuf::from("/nonexistent/git"));
        let root = Path::new("/r");
        let mut active: HashSet<String> = [fold(root)].into();
        let got = git
            .recursive(
                root,
                root,
                &HashSet::new(),
                &Options::default(),
                &mut active,
            )
            .expect("ok");
        assert_eq!(got, Some(Vec::new()));
    }

    /// Bounded reads: past 64 MiB Git's listing is dropped and the program stopped.
    #[cfg(unix)]
    #[test]
    fn git_output_over_the_bound_is_refused() {
        let head = Git(PathBuf::from("/usr/bin/head"));
        let over = (MAX_GIT_OUTPUT + 1).to_string();
        assert!(
            head.list(Path::new("/"), &["-c", &over, "/dev/zero"])
                .is_none()
        );
        let at = MAX_GIT_OUTPUT.to_string();
        let got = head.list(Path::new("/"), &["-c", &at, "/dev/zero"]);
        assert_eq!(got.map(|v| v.len()), Some(MAX_GIT_OUTPUT));
    }

    #[test]
    fn extensions_are_normalised() {
        assert_eq!(norm_ext(" PY "), ".py");
        assert_eq!(norm_ext("\u{feff}.Go"), ".go");
    }
}
