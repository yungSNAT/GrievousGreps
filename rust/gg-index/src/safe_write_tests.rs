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
fn matches_sidecar_names() {
    assert!(matches_sidecar(OsStr::new("extract.a.json"), "extract"));
    assert!(matches_sidecar(OsStr::new("extract.json"), "extract"));
    assert!(!matches_sidecar(OsStr::new("extract2.a.json"), "extract"));
    assert!(!matches_sidecar(OsStr::new("extract.a.tmp"), "extract"));
}

#[cfg(windows)]
#[test]
fn pinned_directories_block_rename_and_delete_on_windows() {
    let base = std::env::temp_dir().join(format!("gg-index-pin-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let graft = base.join("graft");
    let cache = graft.join(".cache");
    std::fs::create_dir_all(&cache).unwrap();
    let (_cur, pins) = imp::pin_existing(&base, &[OsStr::new("graft"), OsStr::new(".cache")])
        .unwrap()
        .unwrap();
    assert!(std::fs::rename(&graft, base.join("moved-graft")).is_err());
    assert!(std::fs::rename(&cache, base.join("moved-cache")).is_err());
    assert!(std::fs::remove_dir(&cache).is_err());
    drop(pins);
    std::fs::rename(&graft, base.join("moved-graft")).unwrap();
    let _ = std::fs::remove_dir_all(&base);
}
