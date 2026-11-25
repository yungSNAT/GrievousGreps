//! Windows directory pinning and handle containment verification for `safe_io`.

use super::FileId;
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

const FILE_LIST_DIRECTORY: u32 = 0x0001;
const FILE_READ_ATTRIBUTES: u32 = 0x0080;
const FILE_SHARE_READ_WRITE: u32 = 0x0001 | 0x0002;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

fn is_reparse(meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink() || (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0
}

fn file_id(file: &File) -> io::Result<FileId> {
    let info = winapi_util::file::information(file)?;
    Ok(FileId {
        dev: info.volume_serial_number(),
        ino: info.file_index(),
    })
}

fn open_dir_handle(path: &Path, access: u32, extra_flags: u32) -> io::Result<File> {
    OpenOptions::new()
        .read(false)
        .write(false)
        .access_mode(access)
        .share_mode(FILE_SHARE_READ_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | extra_flags)
        .open(path)
}

fn open_pinned_dir(path: &Path, allow_attr_fallback: bool) -> io::Result<File> {
    let file = match open_dir_handle(path, FILE_LIST_DIRECTORY, FILE_FLAG_OPEN_REPARSE_POINT) {
        Ok(f) => f,
        Err(e) if allow_attr_fallback && e.kind() == io::ErrorKind::PermissionDenied => {
            open_dir_handle(path, FILE_READ_ATTRIBUTES, FILE_FLAG_OPEN_REPARSE_POINT)?
        }
        Err(e) => return Err(e),
    };
    let meta = file.metadata()?;
    if is_reparse(&meta) || !meta.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "symlink, reparse point, or non-directory refused",
        ));
    }
    Ok(file)
}

fn pin_strict_prefixes(canon_root: &Path, out: &mut Vec<File>) -> io::Result<()> {
    let mut cur = PathBuf::new();
    let comps: Vec<Component<'_>> = canon_root.components().collect();
    for (idx, comp) in comps.iter().enumerate() {
        cur.push(comp.as_os_str());
        let is_last = idx + 1 == comps.len();
        if !is_last && matches!(comp, Component::Normal(_)) {
            out.push(open_pinned_dir(&cur, true)?);
        }
    }
    Ok(())
}

fn pin_dir_chain(
    canon_root: &Path,
    anchor_id: FileId,
    ancestors: &[&OsStr],
    out: &mut Vec<File>,
) -> Option<()> {
    pin_strict_prefixes(canon_root, out).ok()?;
    let pinned_root = open_pinned_dir(canon_root, false).ok()?;
    if file_id(&pinned_root).ok()? != anchor_id {
        return None;
    }
    out.push(pinned_root);
    let mut cur = canon_root.to_path_buf();
    for seg in ancestors {
        cur.push(seg);
        out.push(open_pinned_dir(&cur, false).ok()?);
    }
    Some(())
}

fn verify_handle_containment(
    canon_root: &Path,
    anchor_id: FileId,
    leaf_path: &Path,
    open_leaf: &File,
) -> Option<()> {
    let resolved = fs::canonicalize(leaf_path).ok()?;
    let rel = resolved.strip_prefix(canon_root).ok()?;
    let mut rel_parts = Vec::new();
    for comp in rel.components() {
        match comp {
            Component::Normal(s) => rel_parts.push(s),
            _ => return None,
        }
    }
    let (_, rel_ancestors) = rel_parts.split_last()?;
    let mut verify_dirs = Vec::new();
    pin_dir_chain(canon_root, anchor_id, rel_ancestors, &mut verify_dirs)?;
    let check_leaf = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&resolved)
        .ok()?;
    let check_meta = check_leaf.metadata().ok()?;
    if is_reparse(&check_meta) || !check_meta.file_type().is_file() {
        return None;
    }
    (file_id(&check_leaf).ok()? == file_id(open_leaf).ok()?).then_some(())
}

pub(super) fn anchor_root(root: &Path) -> io::Result<(File, FileId, PathBuf)> {
    let dir = open_dir_handle(root, FILE_LIST_DIRECTORY, 0)?;
    let meta = dir.metadata()?;
    if !meta.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "workspace root is not a directory",
        ));
    }
    let id = file_id(&dir)?;
    let canon = fs::canonicalize(root)?;
    Ok((dir, id, canon))
}

pub(super) fn open_contained_anchored(
    canon_root: &Path,
    anchor_id: FileId,
    parts: &[&OsStr],
    max_bytes: Option<u64>,
) -> Option<(File, fs::Metadata)> {
    let (leaf, ancestors) = parts.split_last()?;
    let mut pinned = Vec::new();
    pin_dir_chain(canon_root, anchor_id, ancestors, &mut pinned)?;

    let mut leaf_path = canon_root.to_path_buf();
    for seg in ancestors {
        leaf_path.push(seg);
    }
    leaf_path.push(leaf);

    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&leaf_path)
        .ok()?;
    let meta = file.metadata().ok()?;
    if is_reparse(&meta) || !meta.file_type().is_file() || max_bytes.is_some_and(|m| meta.len() > m)
    {
        return None;
    }
    verify_handle_containment(canon_root, anchor_id, &leaf_path, &file)?;
    Some((file, meta))
}

pub(super) fn anchor_dir_no_follow(dir: &Path) -> io::Result<Option<(File, FileId, PathBuf)>> {
    let dir_handle = match open_pinned_dir(dir, false) {
        Ok(f) => f,
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::InvalidData | io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(None);
        }
        Err(e) => return Err(e),
    };
    let id = file_id(&dir_handle)?;
    let canon = match fs::canonicalize(dir) {
        Ok(c) => c,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut pinned = Vec::new();
    if pin_strict_prefixes(&canon, &mut pinned).is_err() {
        return Ok(None);
    }
    let Ok(check) = open_pinned_dir(&canon, false) else {
        return Ok(None);
    };
    if file_id(&check)? != id {
        return Ok(None);
    }
    Ok(Some((dir_handle, id, canon)))
}

pub(super) fn list_anchored_filenames(
    _dir: &File,
    canon_dir: &Path,
    anchor_id: FileId,
) -> io::Result<Option<Vec<String>>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(canon_dir)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        if ft.is_symlink() || !ft.is_file() {
            continue;
        }
        out.push(entry.file_name().to_string_lossy().into_owned());
    }
    let Ok(check) = open_pinned_dir(canon_dir, false) else {
        return Ok(None);
    };
    if file_id(&check)? != anchor_id {
        return Ok(None);
    }
    out.sort();
    Ok(Some(out))
}
