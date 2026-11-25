//! TOCTOU-resistant contained file reads within an anchored root directory.

#[cfg(windows)]
#[path = "safe_io_win.rs"]
mod win;

use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileId {
    pub dev: u64,
    pub ino: u64,
}

/// Live directory handle and identity anchoring a workspace or cache root before canonicalization.
pub struct RootAnchor {
    _dir: File,
    id: FileId,
}

impl RootAnchor {
    #[must_use]
    pub fn id(&self) -> FileId {
        self.id
    }
}

pub(crate) fn rel_components(rel: &str) -> Option<Vec<&OsStr>> {
    if rel.is_empty() || rel.contains('\0') {
        return None;
    }
    let mut parts = Vec::new();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(seg) => parts.push(seg),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts)
}

pub fn anchor_root(root: &Path) -> io::Result<(RootAnchor, PathBuf)> {
    #[cfg(unix)]
    {
        let (dir, id, canon) = unix::anchor_root(root)?;
        Ok((RootAnchor { _dir: dir, id }, canon))
    }
    #[cfg(windows)]
    {
        let (dir, id, canon) = win::anchor_root(root)?;
        Ok((RootAnchor { _dir: dir, id }, canon))
    }
}

/// Open a regular file strictly below `canon_root`, verifying root identity against `anchor`.
pub fn open_contained_anchored(
    canon_root: &Path,
    anchor: &RootAnchor,
    rel: &str,
    max_bytes: Option<u64>,
) -> Option<(File, fs::Metadata)> {
    let parts = rel_components(rel)?;
    #[cfg(unix)]
    {
        unix::open_contained_anchored(canon_root, anchor.id, &parts, max_bytes)
    }
    #[cfg(windows)]
    {
        win::open_contained_anchored(canon_root, anchor.id, &parts, max_bytes)
    }
}

/// Anchor `root` and open `rel` as a contained regular file.
pub fn open_contained_file(
    root: &Path,
    rel: &str,
    max_bytes: Option<u64>,
) -> Option<(File, fs::Metadata)> {
    let (anchor, canon_root) = anchor_root(root).ok()?;
    open_contained_anchored(&canon_root, &anchor, rel, max_bytes)
}

/// Read a contained UTF-8 regular file inside `root`, rejecting escapes and symlinks.
pub fn read_contained_to_string(root: &Path, rel: &str, max_bytes: Option<u64>) -> Option<String> {
    let (file, meta) = open_contained_file(root, rel, max_bytes)?;
    if let Some(limit) = max_bytes {
        if meta.len() > limit {
            return None;
        }
        let mut bytes = Vec::new();
        file.take(limit.saturating_add(1))
            .read_to_end(&mut bytes)
            .ok()?;
        if (bytes.len() as u64) > limit {
            return None;
        }
        return String::from_utf8(bytes).ok();
    }
    let mut out = String::new();
    io::BufReader::new(file).read_to_string(&mut out).ok()?;
    Some(out)
}

#[cfg(unix)]
mod unix {
    use super::FileId;
    use rustix::fd::{AsFd, BorrowedFd};
    use rustix::fs::{CWD, Mode, OFlags, Stat, fstat, openat};
    use std::ffi::OsStr;
    use std::fs::{self, File};
    use std::io;
    use std::path::{Component, Path, PathBuf};

    fn dir_open_flags(nofollow: bool) -> OFlags {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let base = OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC;
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        let base = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC;
        if nofollow {
            base | OFlags::NOFOLLOW
        } else {
            base
        }
    }

    #[allow(clippy::unnecessary_cast)]
    fn stat_id(st: &Stat) -> FileId {
        FileId {
            dev: st.st_dev as u64,
            ino: st.st_ino as u64,
        }
    }

    fn step_dir(dir: BorrowedFd<'_>, seg: &OsStr) -> io::Result<File> {
        let owned =
            openat(dir, seg, dir_open_flags(true), Mode::empty()).map_err(io::Error::from)?;
        Ok(File::from(owned))
    }

    fn open_canon_dir(canon_root: &Path) -> io::Result<File> {
        let root_flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC;
        let mut cur =
            File::from(openat(CWD, "/", root_flags, Mode::empty()).map_err(io::Error::from)?);
        for comp in canon_root.components() {
            match comp {
                Component::RootDir | Component::CurDir => {}
                Component::Normal(seg) => cur = step_dir(cur.as_fd(), seg)?,
                Component::ParentDir | Component::Prefix(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "non-canonical root path",
                    ));
                }
            }
        }
        Ok(cur)
    }

    pub(super) fn anchor_root(root: &Path) -> io::Result<(File, FileId, PathBuf)> {
        let fd =
            openat(CWD, root, dir_open_flags(false), Mode::empty()).map_err(io::Error::from)?;
        let st = fstat(&fd).map_err(io::Error::from)?;
        let canon = fs::canonicalize(root)?;
        Ok((File::from(fd), stat_id(&st), canon))
    }

    pub(super) fn open_contained_anchored(
        canon_root: &Path,
        anchor_id: FileId,
        parts: &[&OsStr],
        max_bytes: Option<u64>,
    ) -> Option<(File, fs::Metadata)> {
        let (leaf, ancestors) = parts.split_last()?;
        let mut cur = open_canon_dir(canon_root).ok()?;
        let root_st = fstat(&cur).ok()?;
        if stat_id(&root_st) != anchor_id {
            return None;
        }
        for seg in ancestors {
            cur = step_dir(cur.as_fd(), seg).ok()?;
        }
        let leaf_flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let leaf_fd = openat(cur.as_fd(), *leaf, leaf_flags, Mode::empty()).ok()?;
        let file = File::from(leaf_fd);
        let meta = file.metadata().ok()?;
        if !meta.file_type().is_file() || max_bytes.is_some_and(|m| meta.len() > m) {
            return None;
        }
        Some((file, meta))
    }
}

#[cfg(test)]
mod tests {
    use super::{anchor_root, open_contained_anchored, read_contained_to_string};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn rejects_traversal_and_reads_valid_contained_file() {
        let tmp = tempdir().expect("tmp");
        let root = tmp.path().join("ws");
        fs::create_dir_all(root.join("src")).expect("mkdir");
        fs::write(root.join("src").join("a.ts"), "export const x = 1;\n").expect("write");
        fs::write(tmp.path().join("secret.txt"), "top secret\n").expect("secret");

        assert!(read_contained_to_string(&root, "../secret.txt", None).is_none());
        assert!(read_contained_to_string(&root, "", None).is_none());
        let body = read_contained_to_string(&root, "src/a.ts", Some(1024)).expect("read");
        assert!(body.contains("export const x = 1;"));
        assert!(read_contained_to_string(&root, "src/a.ts", Some(4)).is_none());
    }

    #[test]
    fn mismatched_root_anchor_is_rejected() {
        let tmp = tempdir().expect("tmp");
        let ws1 = tmp.path().join("ws1");
        let ws2 = tmp.path().join("ws2");
        fs::create_dir_all(&ws1).expect("ws1");
        fs::create_dir_all(&ws2).expect("ws2");
        fs::write(ws1.join("a.ts"), "1").expect("w1");
        fs::write(ws2.join("a.ts"), "2").expect("w2");

        let (anchor1, _) = anchor_root(&ws1).expect("anchor1");
        let (_anchor2, canon2) = anchor_root(&ws2).expect("anchor2");
        assert!(open_contained_anchored(&canon2, &anchor1, "a.ts", None).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_and_root_swap_on_unix() {
        use std::os::unix::fs::symlink;

        let tmp = tempdir().expect("tmp");
        let outside = tmp.path().join("outside");
        let root = tmp.path().join("ws");
        let alt = tmp.path().join("ws-alt");
        fs::create_dir_all(&outside).expect("out");
        fs::create_dir_all(root.join("sub")).expect("sub");
        fs::create_dir_all(&alt).expect("alt");
        fs::write(outside.join("secret.ts"), "secret").expect("secret");
        fs::write(root.join("sub").join("ok.ts"), "ok").expect("ok");
        fs::write(alt.join("pwn.ts"), "pwn").expect("pwn");

        symlink(outside.join("secret.ts"), root.join("leaf-link.ts")).expect("leaf");
        symlink(&outside, root.join("dir-link")).expect("dir");
        assert!(read_contained_to_string(&root, "leaf-link.ts", None).is_none());
        assert!(read_contained_to_string(&root, "dir-link/secret.ts", None).is_none());

        let (anchor, canon_root) = anchor_root(&root).expect("anchor");
        fs::rename(&root, tmp.path().join("ws-old")).expect("mv1");
        fs::rename(&alt, &root).expect("mv2");
        assert!(open_contained_anchored(&canon_root, &anchor, "pwn.ts", None).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_junction_and_blocks_anchored_root_rename_on_windows() {
        use std::process::Command;

        let tmp = tempdir().expect("tmp");
        let outside = tmp.path().join("outside");
        let root = tmp.path().join("ws");
        fs::create_dir_all(&outside).expect("out");
        fs::create_dir_all(&root).expect("root");
        fs::write(outside.join("secret.ts"), "secret").expect("secret");
        fs::write(root.join("ok.ts"), "ok").expect("ok");

        let link = root.join("junc");
        let st = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&link)
            .arg(&outside)
            .status()
            .expect("mklink");
        assert!(st.success());
        assert!(read_contained_to_string(&root, "junc/secret.ts", None).is_none());

        let (anchor, canon_root) = anchor_root(&root).expect("anchor");
        assert!(fs::rename(&root, tmp.path().join("ws-moved")).is_err());
        assert!(open_contained_anchored(&canon_root, &anchor, "ok.ts", None).is_some());
    }
}
