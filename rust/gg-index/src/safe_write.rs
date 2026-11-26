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
use std::io;
use std::path::{Path, PathBuf};

/// Write `data` atomically to `base/<dirs...>/<leaf>`, creating missing directories.
/// Returns the path written.
pub fn write_atomic_inside(
    base: &Path,
    dirs: &[&OsStr],
    leaf: &OsStr,
    data: &[u8],
) -> io::Result<PathBuf> {
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
    imp::write(base, dirs, leaf, data)?;
    let mut path = base.to_path_buf();
    path.extend(dirs);
    path.push(leaf);
    Ok(path)
}

/// `writeGraph`'s file step: `<out_dir>/.graph/wiring.json`, contained by `out_dir`'s parent,
/// so a symlinked `out_dir` or `.graph` is refused. As TypeScript's `resolve` does, `..` in
/// `out_dir` is collapsed lexically, and a missing parent is created: the parent is trusted.
pub fn write_wiring(out_dir: &Path, text: &str) -> io::Result<PathBuf> {
    let out_dir = lexical(&std::path::absolute(out_dir)?);
    let (Some(base), Some(name)) = (out_dir.parent(), out_dir.file_name()) else {
        return Err(refuse(format!(
            "refusing an output directory with no parent: {}",
            out_dir.display()
        )));
    };
    std::fs::create_dir_all(base)
        .and_then(|()| {
            write_atomic_inside(
                base,
                &[name, OsStr::new(".graph")],
                OsStr::new("wiring.json"),
                text.as_bytes(),
            )
        })
        .map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", out_dir.display())))
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
    use std::ffi::OsStr;
    use std::fs::File;
    use std::io::{self, Write};
    use std::path::Path;

    use rustix::fd::{AsFd, OwnedFd};
    use rustix::fs::{AtFlags, CWD, Mode, OFlags, mkdirat, openat, renameat, unlinkat};
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

    pub(super) fn write(base: &Path, dirs: &[&OsStr], leaf: &OsStr, data: &[u8]) -> io::Result<()> {
        let mut dir = openat(CWD, base, DIR, Mode::empty())?;
        for seg in dirs {
            dir = step(&dir, seg)?;
        }
        let tmp = super::temp_name(leaf);
        let flags =
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let fd = openat(&dir, &tmp, flags, Mode::from_raw_mode(0o666))?;
        let result = File::from(fd)
            .write_all(data)
            .and_then(|()| renameat(&dir, &tmp, &dir, leaf).map_err(io::Error::from));
        if result.is_err() {
            let _ = unlinkat(dir.as_fd(), &tmp, AtFlags::empty());
        }
        result
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::OsStr;
    use std::fs::{self, File, OpenOptions};
    use std::io::{self, Write};
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

    pub(super) fn write(base: &Path, dirs: &[&OsStr], leaf: &OsStr, data: &[u8]) -> io::Result<()> {
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
            .and_then(|mut f| f.write_all(data))
            .and_then(|()| pin_dir(&cur).map(drop))
            .and_then(|()| fs::rename(&tmp, cur.join(leaf)));
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        drop(pins);
        result
    }
}
