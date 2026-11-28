//! Containment and atomicity of `safe_write`, the Rust form of `writeFileInside(..., { atomic: true })`.

use std::ffi::OsStr;
use std::path::PathBuf;

use gg_index::safe_write::{
    prune_cache, read_in_cache, read_inside, stream_atomic_inside, write_atomic_inside,
    write_in_cache, write_wiring,
};

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
fn creates_a_missing_parent() {
    let base = scratch("missing-parent");
    let out = base.join("new").join("deeper").join("graft");
    write_wiring(&out, "x").unwrap();
    assert_eq!(
        std::fs::read_to_string(out.join(".graph").join("wiring.json")).unwrap(),
        "x"
    );
}

#[test]
fn errors_name_the_output_directory() {
    let base = scratch("error-path");
    std::fs::write(base.join("graft"), "a file").unwrap();
    let err = write_wiring(&base.join("graft"), "x").unwrap_err();
    assert!(err.to_string().contains("graft"), "{err}");
}

#[test]
fn refuses_bad_components() {
    let base = scratch("components");
    for bad in [
        "", ".", "..", "a/b", "a\\b", "/", "\\", "sub/", "sub\\", "\0", "a\0b",
    ] {
        assert!(
            write_atomic_inside(&base, &[OsStr::new(bad)], OsStr::new("f"), b"x").is_err(),
            "write dir {bad:?}"
        );
        assert!(
            stream_atomic_inside(&base, &[], OsStr::new(bad), |_| Ok(())).is_err(),
            "stream leaf {bad:?}"
        );
        assert!(
            read_inside(&base, &[OsStr::new(bad)], OsStr::new("f"), 4096).is_err(),
            "read dir {bad:?}"
        );
        assert!(
            read_inside(&base, &[], OsStr::new(bad), 4096).is_err(),
            "read leaf {bad:?}"
        );
    }
    assert!(
        read_inside(
            &base,
            &[OsStr::new("/"), OsStr::new("etc")],
            OsStr::new("hosts"),
            4096,
        )
        .is_err()
    );
    #[cfg(windows)]
    for bad in ["C:", "C:foo"] {
        assert!(
            read_inside(&base, &[OsStr::new(bad)], OsStr::new("f"), 4096).is_err(),
            "win prefix {bad:?}"
        );
        assert!(
            stream_atomic_inside(&base, &[OsStr::new(bad)], OsStr::new("f"), |_| Ok(())).is_err(),
            "win stream {bad:?}"
        );
    }
}

#[test]
fn refuses_nul_components_before_disk_io() {
    let base = scratch("nul-before-io");
    let absent = base.join("absent");
    for bad in ["\0", "a\0b"] {
        let err = read_inside(&absent, &[], OsStr::new(bad), 4096).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        let err =
            write_atomic_inside(&base, &[OsStr::new("newdir")], OsStr::new(bad), b"x").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        assert!(!base.join("newdir").exists(), "dir created before refusal");
    }
}

#[test]
fn bounded_cache_read_and_prune_edges() {
    let dir = scratch("cache-read-edges");
    let out = dir.join("graft");
    write_in_cache(&out, OsStr::new("extract.a.json"), b"0123456789abcdef0").unwrap();
    assert_eq!(
        read_in_cache(&out, OsStr::new("extract.a.json"), 17).unwrap(),
        Some(b"0123456789abcdef0".to_vec())
    );
    assert!(read_in_cache(&out, OsStr::new("extract.a.json"), 16).is_err());
    assert!(read_in_cache(&out, OsStr::new("../evil"), 16).is_err());
    prune_cache(&dir.join("absent"), "extract", 2);
    prune_cache(std::path::Path::new("graft/.."), "extract", 2);
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

#[cfg(unix)]
#[test]
fn collapses_dot_dot_lexically_as_typescript_does() {
    use std::os::unix::fs::symlink;
    let base = scratch("dot-dot");
    let outside = base.join("outside").join("deep");
    std::fs::create_dir_all(&outside).unwrap();
    symlink(&outside, base.join("link")).unwrap();
    // The kernel would resolve `link/..` to `outside`; TypeScript's `resolve` gives `base`.
    write_wiring(&base.join("link").join("..").join("graft"), "x").unwrap();
    assert!(
        base.join("graft")
            .join(".graph")
            .join("wiring.json")
            .is_file()
    );
    assert!(!base.join("outside").join("graft").exists());
}

#[test]
fn refuses_a_trailing_dot_dot_as_typescript_does() {
    // `dirname("<base>/graft/..")` is `<base>/graft`, and `.graph` resolves outside it.
    let base = scratch("trailing-dot-dot");
    std::fs::create_dir_all(base.join("graft")).unwrap();
    assert!(write_wiring(&base.join("graft").join(".."), "x").is_err());
    assert!(!base.join(".graph").exists());
}

#[cfg(unix)]
#[test]
fn a_trailing_dot_makes_the_output_directory_the_base() {
    use std::os::unix::fs::symlink;
    // `dirname("<base>/graft/.")` is `<base>/graft`: trusted, so TypeScript follows a link there.
    let base = scratch("trailing-dot");
    let outside = base.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    symlink(&outside, base.join("graft")).unwrap();
    write_wiring(&base.join("graft").join("."), "x").unwrap();
    let leaf = outside.join(".graph").join("wiring.json");
    assert_eq!(std::fs::read_to_string(leaf).unwrap(), "x");
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
