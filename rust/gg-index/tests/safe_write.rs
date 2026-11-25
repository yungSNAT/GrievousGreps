//! Containment and atomicity of `safe_write`, the Rust form of `writeFileInside(..., { atomic: true })`.

use std::ffi::OsStr;
use std::path::PathBuf;

use gg_index::safe_write::{write_atomic_inside, write_wiring};

fn scratch(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("safe-write")
        .join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn creates_directories_and_replaces_the_file() {
    let base = scratch("create");
    let out = base.join("graft");
    let path = write_wiring(&out, "one\n").unwrap();
    assert_eq!(
        path,
        std::path::absolute(&out)
            .unwrap()
            .join(".graph")
            .join("wiring.json")
    );
    write_wiring(&out, "two\n").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "two\n");
    let left: Vec<_> = std::fs::read_dir(out.join(".graph"))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(left, ["wiring.json"], "no temp file stays behind");
}

#[test]
fn refuses_bad_components() {
    let base = scratch("components");
    for bad in ["", ".", "..", "a/b"] {
        assert!(
            write_atomic_inside(&base, &[OsStr::new(bad)], OsStr::new("f"), b"x").is_err(),
            "{bad:?}"
        );
    }
    assert!(write_atomic_inside(&base, &[], OsStr::new(".."), b"x").is_err());
}

#[test]
fn refuses_a_file_where_a_directory_belongs() {
    let base = scratch("file-dir");
    std::fs::create_dir_all(base.join("graft")).unwrap();
    std::fs::write(base.join("graft").join(".graph"), "not a dir").unwrap();
    assert!(write_wiring(&base.join("graft"), "x").is_err());
    assert_eq!(
        std::fs::read_to_string(base.join("graft").join(".graph")).unwrap(),
        "not a dir"
    );
}

#[test]
fn a_directory_leaf_fails_and_leaves_no_temp_file() {
    let base = scratch("dir-leaf");
    std::fs::create_dir_all(base.join("graft").join(".graph").join("wiring.json")).unwrap();
    assert!(write_wiring(&base.join("graft"), "x").is_err());
    let left = std::fs::read_dir(base.join("graft").join(".graph"))
        .unwrap()
        .count();
    assert_eq!(left, 1);
}

#[cfg(unix)]
#[test]
fn refuses_symlinked_directories_and_replaces_a_symlink_leaf() {
    use std::os::unix::fs::symlink;
    let base = scratch("links");
    let outside = base.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    // A symlinked context directory and a symlinked `.graph` are refused.
    symlink(&outside, base.join("graft")).unwrap();
    assert!(write_wiring(&base.join("graft"), "x").is_err());
    std::fs::remove_file(base.join("graft")).unwrap();
    std::fs::create_dir_all(base.join("graft")).unwrap();
    symlink(&outside, base.join("graft").join(".graph")).unwrap();
    assert!(write_wiring(&base.join("graft"), "x").is_err());
    assert_eq!(
        std::fs::read_dir(&outside).unwrap().count(),
        0,
        "nothing written through a link"
    );
    // A symlink leaf is replaced, not written through.
    std::fs::remove_file(base.join("graft").join(".graph")).unwrap();
    std::fs::create_dir_all(base.join("graft").join(".graph")).unwrap();
    let target = outside.join("victim");
    std::fs::write(&target, "keep").unwrap();
    symlink(
        &target,
        base.join("graft").join(".graph").join("wiring.json"),
    )
    .unwrap();
    write_wiring(&base.join("graft"), "new").unwrap();
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
    let leaf = base.join("graft").join(".graph").join("wiring.json");
    assert!(
        !std::fs::symlink_metadata(&leaf)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(std::fs::read_to_string(&leaf).unwrap(), "new");
}

#[cfg(windows)]
#[test]
fn refuses_a_junctioned_directory() {
    let base = scratch("junction");
    let outside = base.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    let made = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(base.join("graft"))
        .arg(&outside)
        .output()
        .unwrap();
    assert!(
        made.status.success(),
        "{}",
        String::from_utf8_lossy(&made.stderr)
    );
    assert!(write_wiring(&base.join("graft"), "x").is_err());
    assert_eq!(
        std::fs::read_dir(&outside).unwrap().count(),
        0,
        "nothing written through a junction"
    );
}
