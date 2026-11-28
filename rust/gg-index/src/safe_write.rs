//! Contained, atomic file writes: `writeFileInside(base, path, data, { atomic: true })`
//! from `src/util/safe-fs.ts`, without its check-then-use gap.
//!
//! `base` is trusted. Every component below it must be a real directory: an existing
//! symlink, junction or other reparse point is refused, never followed, and a missing
//! directory is created. The data goes to a fresh, unpredictably named sibling of the
//! leaf, opened exclusively, which is then renamed over the leaf; a symlink leaf is
//! replaced, never written through. On Unix each step opens the next directory relative
//! to the one before (`openat` with `O_NOFOLLOW`), so a component swapped for a link
//! mid-write is refused. On Windows each directory stays open without delete sharing
//! until the rename, so it cannot be renamed, removed or replaced meanwhile; the temp file
//! and the rename still go by path, so an empty leaf directory turned into a junction in
//! place is caught only by a check just before the rename. That narrows, not closes, the
//! check-then-use gap `writeFileInside` accepts.

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

fn validate_components(dirs: &[&OsStr], leaf: &OsStr) -> io::Result<()> {
    for seg in dirs.iter().chain([&leaf]) {
        let ok = !seg.is_empty()
            && *seg != "."
            && *seg != ".."
            && Path::new(seg).components().count() == 1;
        if !ok {
            return Err(refuse(format!(
                "refusing a path component: {}",
                seg.to_string_lossy()
            )));
        }
    }
    Ok(())
}

/// Write `data` atomically to `base/<dirs...>/<leaf>`, creating missing directories.
/// Returns the path written.
pub fn write_atomic_inside(
    base: &Path,
    dirs: &[&OsStr],
    leaf: &OsStr,
    data: &[u8],
) -> io::Result<PathBuf> {
    stream_atomic_inside(base, dirs, leaf, |file| file.write_all(data))
}

/// Stream into an exclusive sibling of `base/<dirs...>/<leaf>` and rename it into place,
/// creating missing directories. Returns the path written.
pub fn stream_atomic_inside<F>(
    base: &Path,
    dirs: &[&OsStr],
    leaf: &OsStr,
    mut fill: F,
) -> io::Result<PathBuf>
where
    F: FnMut(&mut File) -> io::Result<()>,
{
    validate_components(dirs, leaf)?;
    imp::write_with(base, dirs, leaf, &mut fill)?;
    let mut path = base.to_path_buf();
    path.extend(dirs);
    path.push(leaf);
    Ok(path)
}

/// Read up to `max_bytes` from the regular file at `base/<dirs...>/<leaf>`, or `Ok(None)`
/// when a component is missing or the leaf is a link or not a regular file. Refuses any
/// symlinked directory or escape below `base`.
pub fn read_inside(
    base: &Path,
    dirs: &[&OsStr],
    leaf: &OsStr,
    max_bytes: u64,
) -> io::Result<Option<Vec<u8>>> {
    validate_components(dirs, leaf)?;
    imp::read(base, dirs, leaf, max_bytes)
}

/// `writeGraph`'s file step: `<out_dir>/.graph/wiring.json`, contained by `dirname(out_dir)`,
/// so a symlinked `out_dir` or `.graph` is refused. As TypeScript does, the base is the raw
/// `dirname` before `..` is collapsed lexically, so a trailing `..` is refused and a trailing `.`
/// makes `out_dir` the base. A missing base is created: the base is trusted.
pub fn write_wiring(out_dir: &Path, text: &str) -> io::Result<PathBuf> {
    let shown = out_dir.display();
    split_under(out_dir, ".graph")
        .and_then(|(base, dirs)| {
            std::fs::create_dir_all(&base)?;
            let dirs: Vec<&OsStr> = dirs.iter().map(OsString::as_os_str).collect();
            write_atomic_inside(&base, &dirs, OsStr::new("wiring.json"), text.as_bytes())
        })
        .map_err(|e| io::Error::new(e.kind(), format!("{shown}: {e}")))
}

/// Stream `<out_dir>/.cache/<leaf>` atomically inside `dirname(out_dir)`.
pub fn stream_in_cache<F>(out_dir: &Path, leaf: &OsStr, fill: F) -> io::Result<PathBuf>
where
    F: FnMut(&mut File) -> io::Result<()>,
{
    let (base, dirs) = split_under(out_dir, ".cache")?;
    std::fs::create_dir_all(&base)?;
    let dirs: Vec<&OsStr> = dirs.iter().map(OsString::as_os_str).collect();
    stream_atomic_inside(&base, &dirs, leaf, fill)
}

/// Write `<out_dir>/.cache/<leaf>` atomically inside `dirname(out_dir)`.
pub fn write_in_cache(out_dir: &Path, leaf: &OsStr, data: &[u8]) -> io::Result<PathBuf> {
    stream_in_cache(out_dir, leaf, |file| file.write_all(data))
}

/// Read `<out_dir>/.cache/<leaf>` inside `dirname(out_dir)` without creating directories or
/// following symlinks.
pub fn read_in_cache(
    out_dir: &Path,
    leaf: &OsStr,
    max_bytes: u64,
) -> io::Result<Option<Vec<u8>>> {
    let (base, dirs) = split_under(out_dir, ".cache")?;
    let dirs: Vec<&OsStr> = dirs.iter().map(OsString::as_os_str).collect();
    read_inside(&base, &dirs, leaf, max_bytes)
}

/// `pruneSidecars`: drop all but the newest `keep` regular `<prefix>.*.json` files in a real
/// `<out_dir>/.cache` inside `dirname(out_dir)`. Best-effort; errors are ignored.
pub fn prune_cache(out_dir: &Path, prefix: &str, keep: usize) {
    if let Ok((base, dirs)) = split_under(out_dir, ".cache") {
        let dirs: Vec<&OsStr> = dirs.iter().map(OsString::as_os_str).collect();
        let _ = imp::prune(&base, &dirs, prefix, keep);
    }
}

/// The trusted base, `resolve(dirname(out_dir))`, and the directories from it to
/// `resolve(out_dir, sub)`. A file-system root is its own `dirname`.
fn split_under(out_dir: &Path, sub: &str) -> io::Result<(PathBuf, Vec<OsString>)> {
    // `Path::parent` matches `dirname` except on a trailing `.`, which `components` drops,
    // and on one relative component, whose parent is `""` where `dirname` gives `.`.
    let raw_base = match out_dir.parent() {
        Some(parent) if !ends_in_dot(out_dir) => parent,
        _ => out_dir,
    };
    // As Node's `resolve`, an empty path is the current directory.
    let resolve = |p: &Path| {
        let p = if p.as_os_str().is_empty() {
            Path::new(".")
        } else {
            p
        };
        std::path::absolute(p).map(|p| lexical(&p))
    };
    let base = resolve(raw_base)?;
    let target = resolve(out_dir)?.join(sub);
    let below = target
        .strip_prefix(&base)
        .map_err(|_| refuse(format!("refusing a path outside {}", base.display())))?;
    let dirs = below.iter().map(OsStr::to_os_string).collect();
    Ok((base, dirs))
}

fn read_bounded(file: File, max_bytes: u64) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    file.take(max_bytes + 1).read_to_end(&mut out)?;
    if out.len() as u64 > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("file exceeds {max_bytes} bytes"),
        ));
    }
    Ok(out)
}

fn matches_sidecar(name: &OsStr, prefix: &str) -> bool {
    name.to_str().is_some_and(|n| {
        n.strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('.') && n.ends_with(".json"))
    })
}

/// Whether the last component of `path`, ignoring trailing separators, is `.`.
fn ends_in_dot(path: &Path) -> bool {
    let bytes = path.as_os_str().as_encoded_bytes();
    let sep = |b: &u8| std::path::is_separator(char::from(*b));
    let end = bytes.iter().rposition(|b| !sep(b)).map_or(0, |i| i + 1);
    let trimmed = &bytes[..end];
    trimmed.ends_with(b".") && (end == 1 || sep(&trimmed[end - 2]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(p: &Path) -> (PathBuf, Vec<OsString>) {
        split_under(p, ".graph").unwrap()
    }

    #[test]
    fn a_root_output_directory_is_its_own_base() {
        let root = std::path::absolute(Path::new("/")).unwrap();
        assert_eq!(split(&root), (root.clone(), vec![".graph".into()]));
        assert_eq!(
            split(&root.join("graft")),
            (root.clone(), vec!["graft".into(), ".graph".into()])
        );
        assert_eq!(split(&root.join("..")), (root, vec![".graph".into()]));
    }

    #[test]
    fn a_relative_output_directory_resolves_against_the_current_directory() {
        let here = std::path::absolute(Path::new(".")).unwrap();
        assert_eq!(
            split(Path::new("graft")),
            (here.clone(), vec!["graft".into(), ".graph".into()])
        );
        assert_eq!(
            split(Path::new("a/graft")),
            (here.join("a"), vec!["graft".into(), ".graph".into()])
        );
        assert!(split_under(Path::new(".."), ".graph").is_err());
        assert!(split_under(Path::new("graft/.."), ".graph").is_err());
    }

    #[test]
    fn the_base_is_the_raw_dirname_as_in_typescript() {
        let r = std::path::absolute(Path::new("/r")).unwrap();
        let graph: OsString = ".graph".into();
        assert_eq!(
            split(&r.join("graft").join(".")),
            (r.join("graft"), vec![graph.clone()])
        );
        assert_eq!(
            split(&r.join("graft").join(".").join("")),
            (r.join("graft"), vec![graph.clone()])
        );
        assert_eq!(
            split(&r.join("link").join("..").join("graft")),
            (r.clone(), vec!["graft".into(), graph])
        );
        assert!(split_under(&r.join("graft").join(".."), ".graph").is_err());
        assert!(!ends_in_dot(Path::new("a/b..")));
        assert!(ends_in_dot(Path::new(".")));
    }

    #[test]
    fn bounded_read_and_sidecar_prune_handle_edges() {
        let dir = std::env::temp_dir().join(format!("gg-index-sw-{}", std::process::id()));
        drop(std::fs::remove_dir_all(&dir));
        let out = dir.join("graft");
        write_in_cache(&out, OsStr::new("extract.a.json"), b"0123456789abcdef0").unwrap();
        assert_eq!(
            read_in_cache(&out, OsStr::new("extract.a.json"), 17).unwrap(),
            Some(b"0123456789abcdef0".to_vec())
        );
        assert!(read_in_cache(&out, OsStr::new("extract.a.json"), 16).is_err());
        assert!(read_in_cache(&out, OsStr::new("../evil"), 16).is_err());
        prune_cache(&dir.join("absent"), "extract", 2);
        prune_cache(Path::new("graft/.."), "extract", 2);
        assert!(matches_sidecar(OsStr::new("extract.a.json"), "extract"));
        assert!(matches_sidecar(OsStr::new("extract.json"), "extract"));
        assert!(!matches_sidecar(OsStr::new("extract2.a.json"), "extract"));
        assert!(!matches_sidecar(OsStr::new("extract.a.tmp"), "extract"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

/// `path` with `.` and `..` removed without consulting the file system.
fn lexical(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

fn refuse(msg: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, msg)
}

/// `<leaf>.<pid>.<12 hex digits>.tmp`, as `replaceAtomically` names it.
fn temp_name(leaf: &OsStr) -> OsString {
    use std::hash::{BuildHasher, Hasher};
    // RandomState is seeded from the OS once a process and stepped for each instance.
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
    );
    let mut name = leaf.to_os_string();
    name.push(format!(
        ".{}.{:012x}.tmp",
        std::process::id(),
        h.finish() & 0xffff_ffff_ffff
    ));
    name
}

#[cfg(unix)]
mod imp {
    use std::ffi::{OsStr, OsString};
    use std::fs::File;
    use std::io;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    use rustix::fd::{AsFd, OwnedFd};
    use rustix::fs::{
        AtFlags, CWD, Dir, FileType, Mode, OFlags, mkdirat, openat, renameat, statat, unlinkat,
    };
    use rustix::io::Errno;

    const DIR: OFlags = OFlags::RDONLY
        .union(OFlags::DIRECTORY)
        .union(OFlags::CLOEXEC);

    fn step(dir: &OwnedFd, seg: &OsStr) -> io::Result<OwnedFd> {
        let open = || openat(dir, seg, DIR | OFlags::NOFOLLOW, Mode::empty());
        let fd = match open() {
            Err(Errno::NOENT) => match mkdirat(dir, seg, Mode::from_raw_mode(0o777)) {
                Ok(()) | Err(Errno::EXIST) => open(),
                Err(e) => Err(e),
            },
            other => other,
        };
        fd.map_err(|e| match e {
            Errno::LOOP | Errno::NOTDIR => super::refuse(format!(
                "refusing a symlink or non-directory: {}",
                seg.to_string_lossy()
            )),
            e => io::Error::from(e),
        })
    }

    fn open_dir_opt(dir: impl AsFd, seg: &OsStr, flags: OFlags) -> io::Result<Option<OwnedFd>> {
        match openat(dir, seg, flags, Mode::empty()) {
            Ok(fd) => Ok(Some(fd)),
            Err(Errno::NOENT) => Ok(None),
            Err(Errno::LOOP | Errno::NOTDIR) => Err(super::refuse(format!(
                "refusing a symlink or non-directory: {}",
                seg.to_string_lossy()
            ))),
            Err(e) => Err(io::Error::from(e)),
        }
    }

    fn open_existing(base: &Path, dirs: &[&OsStr]) -> io::Result<Option<OwnedFd>> {
        let Some(mut dir) = open_dir_opt(CWD, base.as_os_str(), DIR)? else {
            return Ok(None);
        };
        for seg in dirs {
            let Some(next) = open_dir_opt(&dir, seg, DIR | OFlags::NOFOLLOW)? else {
                return Ok(None);
            };
            dir = next;
        }
        Ok(Some(dir))
    }

    pub(super) fn write_with(
        base: &Path,
        dirs: &[&OsStr],
        leaf: &OsStr,
        fill: &mut dyn FnMut(&mut File) -> io::Result<()>,
    ) -> io::Result<()> {
        let mut dir = openat(CWD, base, DIR, Mode::empty())?;
        for seg in dirs {
            dir = step(&dir, seg)?;
        }
        let tmp = super::temp_name(leaf);
        let flags =
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let fd = openat(&dir, &tmp, flags, Mode::from_raw_mode(0o666))?;
        let mut file = File::from(fd);
        let result = fill(&mut file)
            .and_then(|()| renameat(&dir, &tmp, &dir, leaf).map_err(io::Error::from));
        if result.is_err() {
            let _ = unlinkat(dir.as_fd(), &tmp, AtFlags::empty());
        }
        result
    }

    pub(super) fn read(
        base: &Path,
        dirs: &[&OsStr],
        leaf: &OsStr,
        max_bytes: u64,
    ) -> io::Result<Option<Vec<u8>>> {
        let Some(dir) = open_existing(base, dirs)? else {
            return Ok(None);
        };
        let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
        let fd = match openat(&dir, leaf, flags, Mode::empty()) {
            Ok(fd) => fd,
            Err(Errno::NOENT | Errno::LOOP) => return Ok(None),
            Err(e) => return Err(io::Error::from(e)),
        };
        let file = File::from(fd);
        if !file.metadata()?.is_file() {
            return Ok(None);
        }
        super::read_bounded(file, max_bytes).map(Some)
    }

    pub(super) fn prune(
        base: &Path,
        dirs: &[&OsStr],
        prefix: &str,
        keep: usize,
    ) -> io::Result<()> {
        let Some(dir) = open_existing(base, dirs)? else {
            return Ok(());
        };
        let mut mine: Vec<(OsString, f64)> = Vec::new();
        for entry in Dir::read_from(&dir)? {
            let entry = entry?;
            let name = OsStr::from_bytes(entry.file_name().to_bytes());
            if !super::matches_sidecar(name, prefix) {
                continue;
            }
            let st = statat(&dir, name, AtFlags::SYMLINK_NOFOLLOW)?;
            if FileType::from_raw_mode(st.st_mode) != FileType::RegularFile {
                continue;
            }
            let ms = st.st_mtime as f64 * 1e3 + st.st_mtime_nsec as f64 / 1e6;
            mine.push((name.to_os_string(), ms));
        }
        mine.sort_by(|a, b| b.1.total_cmp(&a.1));
        for (name, _) in mine.into_iter().skip(keep) {
            let _ = unlinkat(&dir, &name, AtFlags::empty());
        }
        Ok(())
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::{OsStr, OsString};
    use std::fs::{self, File, OpenOptions};
    use std::io;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::path::{Path, PathBuf};

    const FILE_LIST_DIRECTORY: u32 = 0x0001;
    const FILE_SHARE_READ_WRITE: u32 = 0x0001 | 0x0002;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

    fn open_dir(path: &Path, extra_flags: u32) -> io::Result<File> {
        OpenOptions::new()
            .access_mode(FILE_LIST_DIRECTORY)
            .share_mode(FILE_SHARE_READ_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | extra_flags)
            .open(path)
    }

    /// Open `path` itself (a link is not followed) and hold it without delete sharing,
    /// so it cannot be renamed, removed or replaced whilst the handle lives.
    fn pin_dir(path: &Path) -> io::Result<File> {
        let file = open_dir(path, FILE_FLAG_OPEN_REPARSE_POINT)?;
        let meta = file.metadata()?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !meta.is_dir() {
            return Err(super::refuse(format!(
                "refusing a symlink or non-directory: {}",
                path.display()
            )));
        }
        Ok(file)
    }

    fn maybe<T>(r: io::Result<T>) -> io::Result<Option<T>> {
        match r {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn pin_existing(base: &Path, dirs: &[&OsStr]) -> io::Result<Option<(PathBuf, Vec<File>)>> {
        let Some(mut cur) = maybe(fs::canonicalize(base))? else {
            return Ok(None);
        };
        let mut pins = vec![open_dir(&cur, 0)?];
        for seg in dirs {
            cur.push(seg);
            let Some(pin) = maybe(pin_dir(&cur))? else {
                return Ok(None);
            };
            pins.push(pin);
        }
        Ok(Some((cur, pins)))
    }

    pub(super) fn write_with(
        base: &Path,
        dirs: &[&OsStr],
        leaf: &OsStr,
        fill: &mut dyn FnMut(&mut File) -> io::Result<()>,
    ) -> io::Result<()> {
        // The base is trusted, so it is resolved; everything below it is pinned.
        let mut cur: PathBuf = fs::canonicalize(base)?;
        let mut pins = vec![open_dir(&cur, 0)?];
        for seg in dirs {
            cur.push(seg);
            match fs::create_dir(&cur) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
            pins.push(pin_dir(&cur)?);
        }
        let tmp = cur.join(super::temp_name(leaf));
        let result = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .and_then(|mut f| fill(&mut f))
            .and_then(|()| pin_dir(&cur).map(drop))
            .and_then(|()| fs::rename(&tmp, cur.join(leaf)));
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        drop(pins);
        result
    }

    pub(super) fn read(
        base: &Path,
        dirs: &[&OsStr],
        leaf: &OsStr,
        max_bytes: u64,
    ) -> io::Result<Option<Vec<u8>>> {
        let Some((cur, _pins)) = pin_existing(base, dirs)? else {
            return Ok(None);
        };
        let open = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(cur.join(leaf));
        let Some(file) = maybe(open)? else {
            return Ok(None);
        };
        let meta = file.metadata()?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !meta.is_file() {
            return Ok(None);
        }
        super::read_bounded(file, max_bytes).map(Some)
    }

    pub(super) fn prune(
        base: &Path,
        dirs: &[&OsStr],
        prefix: &str,
        keep: usize,
    ) -> io::Result<()> {
        let Some((cur, _pins)) = pin_existing(base, dirs)? else {
            return Ok(());
        };
        let mut mine: Vec<(OsString, f64)> = Vec::new();
        for entry in fs::read_dir(&cur)? {
            let entry = entry?;
            let name = entry.file_name();
            if !super::matches_sidecar(&name, prefix) {
                continue;
            }
            let meta = fs::symlink_metadata(cur.join(&name))?;
            if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !meta.is_file() {
                continue;
            }
            mine.push((name, crate::sources::mtime_ms(&meta)));
        }
        mine.sort_by(|a, b| b.1.total_cmp(&a.1));
        for (name, _) in mine.into_iter().skip(keep) {
            let _ = fs::remove_file(cur.join(name));
        }
        Ok(())
    }
}
