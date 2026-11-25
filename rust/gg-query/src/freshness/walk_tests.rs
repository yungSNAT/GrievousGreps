use super::{WalkContext, read_build_config};
use std::fs;
use tempfile::tempdir;

#[test]
fn read_build_config_reads_regular_and_skips_oversized() {
    let tmp = tempdir().expect("tmp");
    let root = tmp.path().join("ws");
    fs::create_dir_all(root.join(".graft")).expect("mkdir");
    fs::write(
        root.join(".graft").join("config.json"),
        r#"{"includeDirs":["vendor"],"followSubmodules":true,"followNestedRepos":true}"#,
    )
    .expect("write cfg");

    let ctx = WalkContext::open(&root).expect("ctx");
    let cfg = read_build_config(&ctx);
    assert_eq!(cfg.include_dirs, vec!["vendor"]);
    assert!(cfg.follow_submodules);
    assert!(cfg.follow_nested_repos);

    fs::write(
        root.join(".graft").join("config.json"),
        vec![b' '; 1024 * 1024 + 8],
    )
    .expect("huge");
    let fallback = read_build_config(&ctx);
    assert!(fallback.include_dirs.is_empty());
    assert!(!fallback.follow_submodules);
    assert!(!fallback.follow_nested_repos);
}

#[cfg(unix)]
#[test]
fn read_build_config_rejects_symlinks_and_root_swap_on_unix() {
    use std::os::unix::fs::symlink;

    let tmp = tempdir().expect("tmp");
    let outside = tmp.path().join("outside");
    let alt = tmp.path().join("alt-ws");
    fs::create_dir_all(&outside).expect("outside");
    fs::create_dir_all(alt.join(".graft")).expect("alt");
    fs::write(
        outside.join("config.json"),
        r#"{"includeDirs":["vendor"],"followSubmodules":true}"#,
    )
    .expect("out cfg");
    fs::write(
        alt.join(".graft").join("config.json"),
        r#"{"followNestedRepos":true}"#,
    )
    .expect("alt cfg");

    let ws_sym_file = tmp.path().join("ws-sym-file");
    fs::create_dir_all(ws_sym_file.join(".graft")).expect("sym file dir");
    symlink(
        outside.join("config.json"),
        ws_sym_file.join(".graft").join("config.json"),
    )
    .expect("sym file");
    let ctx_file = WalkContext::open(&ws_sym_file).expect("ctx file");
    assert!(!read_build_config(&ctx_file).follow_submodules);

    let ws_sym_dir = tmp.path().join("ws-sym-dir");
    fs::create_dir_all(&ws_sym_dir).expect("sym dir");
    symlink(&outside, ws_sym_dir.join(".graft")).expect("sym dir");
    let ctx_dir = WalkContext::open(&ws_sym_dir).expect("ctx dir");
    assert!(read_build_config(&ctx_dir).include_dirs.is_empty());

    let ws_swap = tmp.path().join("ws-swap");
    fs::create_dir_all(&ws_swap).expect("ws swap");
    let ctx_swap = WalkContext::open(&ws_swap).expect("ctx swap");
    fs::rename(&ws_swap, tmp.path().join("ws-old")).expect("mv1");
    fs::rename(&alt, &ws_swap).expect("mv2");
    assert!(!read_build_config(&ctx_swap).follow_nested_repos);
}

#[cfg(windows)]
#[test]
fn read_build_config_rejects_junction_dir_and_root_swap_on_windows() {
    use std::process::Command;

    let tmp = tempdir().expect("tmp");
    let outside = tmp.path().join("outside");
    let ws = tmp.path().join("ws");
    fs::create_dir_all(&outside).expect("outside");
    fs::create_dir_all(&ws).expect("ws");
    fs::write(outside.join("config.json"), r#"{"includeDirs":["vendor"]}"#).expect("out cfg");

    let st = Command::new("cmd")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(ws.join(".graft"))
        .arg(&outside)
        .status()
        .expect("mklink");
    assert!(st.success());

    let ctx = WalkContext::open(&ws).expect("ctx");
    assert!(read_build_config(&ctx).include_dirs.is_empty());
    assert!(fs::rename(&ws, tmp.path().join("ws-moved")).is_err());
}
