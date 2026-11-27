//! Stage 3B1b: `gg-index sources`, the port of `walkDir` (src/ingest/fs.ts) and
//! `listSourceStats` (src/graph/source-files.ts). The parity harness compares it with the
//! TypeScript on generated trees; these tests hold the safety properties one by one.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use gg_index::json::{self, Json};

fn scratch(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("sources")
        .join(name);
    drop(fs::remove_dir_all(&dir));
    fs::create_dir_all(&dir).expect("scratch");
    dir
}

fn write(root: &Path, rel: &str, bytes: usize) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    fs::write(path, vec![b'x'; bytes]).expect("write");
}

fn exec(root: &Path, extra: &[&str]) -> Output {
    let out_dir = root.join("graft");
    Command::new(env!("CARGO_BIN_EXE_gg-index"))
        .arg("sources")
        .arg("--root")
        .arg(root)
        .arg("--out-dir")
        .arg(&out_dir)
        .args(extra)
        .output()
        .expect("spawn gg-index")
}

/// The `[rel, size, mtimeMs]` rows, failing the test on a non-zero exit.
fn rows(root: &Path, extra: &[&str]) -> Vec<(String, f64, f64)> {
    let out = exec(root, extra);
    assert!(
        out.status.success(),
        "sources failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = String::from_utf8(out.stdout).expect("utf-8 output");
    let Json::Arr(items) = json::parse(&text).expect("json") else {
        panic!("not an array: {text}")
    };
    items
        .into_iter()
        .map(|row| match row {
            Json::Arr(v) => match v.as_slice() {
                [Json::Str(rel), Json::Num(size), Json::Num(mtime)] => {
                    (String::from_utf16(rel).expect("rel"), *size, *mtime)
                }
                other => panic!("bad row {other:?}"),
            },
            other => panic!("bad row {other:?}"),
        })
        .collect()
}

fn rels(root: &Path, extra: &[&str]) -> Vec<String> {
    rows(root, extra).into_iter().map(|r| r.0).collect()
}

fn git(cwd: &Path, args: &[&str]) {
    let st = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git");
    assert!(
        st.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&st.stderr)
    );
}

#[test]
fn lists_parsed_files_in_walk_order_with_posix_paths() {
    let root = scratch("plain");
    write(&root, "src/b.ts", 3);
    write(&root, "src/a.py", 2);
    write(&root, "README.md", 1);
    write(&root, "node_modules/p/i.js", 1);
    write(&root, ".hidden/x.ts", 1);
    write(&root, "src/.eslintrc.js", 1);
    write(&root, "graft/out.ts", 1);
    write(&root, "Dockerfile", 1);
    let got = rels(&root, &[]);
    let want = ["Dockerfile", "src/a.py", "src/b.ts"];
    let mut sorted = got.clone();
    sorted.sort();
    assert_eq!(sorted, want, "{got:?}");
}

#[test]
fn size_and_mtime_are_the_files_own() {
    let root = scratch("stat");
    write(&root, "m.go", 17);
    let r = rows(&root, &[]);
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].1, 17.0);
    let modified = fs::metadata(root.join("m.go"))
        .expect("stat")
        .modified()
        .expect("mtime");
    let since = modified
        .duration_since(std::time::UNIX_EPOCH)
        .expect("after 1970");
    let ms = since.as_secs() as f64 * 1e3 + f64::from(since.subsec_nanos()) / 1e6;
    assert_eq!(r[0].2, ms);
}

#[test]
fn selection_options_filter_as_typescript_does() {
    let root = scratch("select");
    write(&root, "src/a.ts", 1);
    write(&root, "lib/b.py", 1);
    write(&root, "lib/notes.txt", 1);
    write(&root, "vendor/v.ts", 1);
    let mut only = rels(&root, &["--only-dir", "lib"]);
    only.sort();
    assert_eq!(only, ["lib/b.py"]);
    let ext = rels(&root, &["--ext", " PY "]);
    assert_eq!(ext, ["lib/b.py"]);
    let mut inc = rels(&root, &["--include-dir", "vendor"]);
    inc.sort();
    assert_eq!(inc, ["lib/b.py", "src/a.ts", "vendor/v.ts"]);
}

/// Bounded reads: a file over 1,000,000 bytes is left out by its size alone.
#[test]
fn files_over_the_size_bound_are_left_out() {
    let root = scratch("bound");
    write(&root, "at.ts", 1_000_000);
    write(&root, "over.ts", 1_000_001);
    assert_eq!(rels(&root, &[]), ["at.ts"]);
}

#[test]
fn git_trees_list_tracked_and_unignored_files() {
    let root = scratch("git");
    write(&root, "a.ts", 1);
    write(&root, "dist/d.ts", 1);
    write(&root, "lib/l.ts", 1);
    write(&root, "lib/kept.ts", 1);
    fs::write(root.join(".gitignore"), "lib/\n").expect("ignore");
    git(&root, &["init", "-q"]);
    git(&root, &["add", "-f", "--", "lib/kept.ts"]);
    let mut got = rels(&root, &[]);
    got.sort();
    assert_eq!(got, ["a.ts", "lib/kept.ts"]);
}

#[test]
fn a_nested_clone_is_followed_only_when_asked() {
    let root = scratch("nested");
    write(&root, "a.ts", 1);
    git(&root, &["init", "-q"]);
    let child = root.join("child");
    write(&child, "n.py", 1);
    git(&child, &["init", "-q"]);
    assert_eq!(rels(&root, &[]), ["a.ts"]);
    assert_eq!(
        rels(&root, &["--follow-nested-repos"]),
        ["a.ts", "child/n.py"]
    );
}

/// Path containment and no following of links out of the root (POSIX: making a link on
/// Windows needs a right the test runner may not hold).
#[cfg(unix)]
#[test]
fn links_inside_the_root_are_not_followed() {
    use std::os::unix::fs::symlink;
    let base = scratch("links");
    let outside = base.join("outside");
    write(&outside, "secret.ts", 1);
    let root = base.join("root");
    write(&root, "a.ts", 1);
    symlink(&outside, root.join("linkdir")).expect("link");
    symlink(outside.join("secret.ts"), root.join("linkfile.ts")).expect("link");
    assert_eq!(rels(&root, &[]), ["a.ts"]);
    git(&root, &["init", "-q"]);
    git(&root, &["add", "--", "linkfile.ts", "linkdir"]);
    assert_eq!(rels(&root, &[]), ["a.ts"]);
}

/// A symlinked root is walked once in its target, and paths stay relative to the root as given.
#[cfg(unix)]
#[test]
fn a_linked_root_keeps_its_paths() {
    let base = scratch("rootlink");
    let real = base.join("real");
    write(&real, "src/a.ts", 1);
    let link = base.join("link");
    std::os::unix::fs::symlink(&real, &link).expect("link");
    assert_eq!(rels(&link, &[]), ["src/a.ts"]);
}

/// An unreadable folder fails the walk outside Git, as `readdirSync` throws in TypeScript.
#[cfg(unix)]
#[test]
fn an_unreadable_folder_fails_the_walk() {
    use std::os::unix::fs::PermissionsExt;
    let root = scratch("unreadable");
    write(&root, "a.ts", 1);
    write(&root, "locked/b.ts", 1);
    fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o000)).expect("chmod");
    let out = exec(&root, &[]);
    fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o755)).expect("chmod");
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("locked"));
}

/// Names that are not UTF-8 (Linux file systems allow any bytes): Node decodes them lossily,
/// so a file's stat fails and it is dropped, and a folder's `readdirSync` fails the walk.
/// The port drops such a file and fails on such a folder, naming it.
#[cfg(target_os = "linux")]
#[test]
fn names_that_are_not_utf8() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    let root = scratch("bytes");
    write(&root, "a.ts", 1);
    fs::write(root.join(OsStr::from_bytes(b"\xff.ts")), b"x").expect("write");
    assert_eq!(rels(&root, &[]), ["a.ts"]);
    git(&root, &["init", "-q"]);
    assert_eq!(rels(&root, &[]), ["a.ts"], "through git ls-files");
    let plain = scratch("bytes-dir");
    write(&plain, "a.ts", 1);
    fs::create_dir(plain.join(OsStr::from_bytes(b"d\xff"))).expect("mkdir");
    let out = exec(&plain, &[]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("not UTF-8"));
}

#[test]
fn a_missing_root_fails() {
    let root = scratch("missing").join("nothing-here");
    assert!(!exec(&root, &[]).status.success());
}
