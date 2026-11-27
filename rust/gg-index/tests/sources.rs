//! Stage 3B1b: `gg-index sources`, the port of `walkDir` (src/ingest/fs.ts) and
//! `listSourceStats` (src/graph/source-files.ts). The parity harness compares it with the
//! TypeScript on generated trees; these tests hold the safety properties one by one.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use gg_index::json::{self, Json};

/// A folder outside any Git checkout (the build's own target folder is inside this
/// repository, where `git ls-files` would answer for the enclosing tree), removed when the
/// test ends.
struct Scratch(PathBuf);

impl std::ops::Deref for Scratch {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for Scratch {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        drop(fs::remove_dir_all(&self.0));
    }
}

fn scratch(name: &str) -> Scratch {
    let dir = std::env::temp_dir()
        .join("gg-index-sources")
        .join(format!("{name}-{}", std::process::id()));
    drop(fs::remove_dir_all(&dir));
    fs::create_dir_all(&dir).expect("scratch");
    Scratch(dir)
}

fn write(root: &Path, rel: &str, bytes: usize) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    fs::write(path, vec![b'x'; bytes]).expect("write");
}

fn command(root: &Path, extra: &[&str]) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_gg-index"));
    cmd.arg("sources")
        .arg("--root")
        .arg(root)
        .arg("--out-dir")
        .arg(root.join("graft"))
        .args(extra);
    cmd
}

fn exec(root: &Path, extra: &[&str]) -> Output {
    command(root, extra).output().expect("spawn gg-index")
}

fn parse_rows(out: Output) -> Vec<String> {
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
            Json::Arr(v) => match v.first() {
                Some(Json::Str(rel)) => String::from_utf16(rel).expect("rel"),
                other => panic!("bad row {other:?}"),
            },
            other => panic!("bad row {other:?}"),
        })
        .collect()
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
    // Byte order on POSIX (libuv sorts) and NTFS's order on Windows agree here.
    assert_eq!(rels(&root, &[]), ["Dockerfile", "src/a.py", "src/b.ts"]);
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

/// Containment: a linked root still leaves out its output folder when `--out-dir`
/// names the folder through the target's real path.
#[cfg(unix)]
#[test]
fn a_linked_root_excludes_an_output_folder_by_its_real_path() {
    let base = scratch("rootlink-out");
    let real = base.join("real");
    write(&real, "src/a.ts", 1);
    write(&real, "graft/gen.ts", 1);
    let link = base.join("link");
    std::os::unix::fs::symlink(&real, &link).expect("link");
    assert_eq!(rels(&link, &[]), ["src/a.ts"], "through the link");
    let out_dir = fs::canonicalize(real.join("graft")).expect("real graft");
    let run = || {
        let out = Command::new(env!("CARGO_BIN_EXE_gg-index"))
            .args(["sources", "--root"])
            .arg(&link)
            .arg("--out-dir")
            .arg(&out_dir)
            .output()
            .expect("spawn");
        parse_rows(out)
    };
    assert_eq!(run(), ["src/a.ts"], "through the real path");
    git(&real, &["init", "-q"]);
    assert_eq!(run(), ["src/a.ts"], "through git ls-files");
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

/// Names that are not UTF-8 (Linux file systems allow any bytes): Node decodes them lossily
/// (U+FFFD) and uses that spelling as the path, and so does the port. A file whose lossy
/// spelling names no file is dropped; one whose lossy spelling is a sibling's name lists the
/// sibling again (once in deep mode, which deduplicates); a folder whose lossy spelling names
/// no folder fails the walk with that path, and one that names a sibling walks it again.
#[cfg(target_os = "linux")]
#[test]
fn names_that_are_not_utf8_are_read_by_their_lossy_spelling() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    let root = scratch("bytes");
    write(&root, "a.ts", 1);
    fs::write(root.join(OsStr::from_bytes(b"\xff.ts")), b"x").expect("write");
    assert_eq!(rels(&root, &[]), ["a.ts"]);
    git(&root, &["init", "-q"]);
    assert_eq!(rels(&root, &[]), ["a.ts"], "through git ls-files");
    let twin = scratch("bytes-twin");
    fs::write(twin.join(OsStr::from_bytes(b"a\xff.ts")), b"x").expect("write");
    write(&twin, "a\u{fffd}.ts", 1);
    let both = ["a\u{fffd}.ts", "a\u{fffd}.ts"];
    assert_eq!(rels(&twin, &[]), both);
    git(&twin, &["init", "-q"]);
    assert_eq!(rels(&twin, &[]), both, "through git ls-files");
    assert_eq!(
        rels(&twin, &["--follow-submodules"]),
        ["a\u{fffd}.ts"],
        "deep mode"
    );
    let plain = scratch("bytes-dir");
    write(&plain, "a.ts", 1);
    fs::create_dir(plain.join(OsStr::from_bytes(b"d\xff"))).expect("mkdir");
    let out = exec(&plain, &[]);
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("d\u{fffd}") && err.contains("os error 2"),
        "{err}"
    );
    let dirs = scratch("bytes-dirs");
    fs::create_dir(dirs.join(OsStr::from_bytes(b"d\xff"))).expect("mkdir");
    write(&dirs, "d\u{fffd}/x.ts", 1);
    assert_eq!(rels(&dirs, &[]), ["d\u{fffd}/x.ts", "d\u{fffd}/x.ts"]);
    // A folder whose lossy name is skipped is passed over, as in TypeScript.
    let skipped = scratch("bytes-skipped");
    write(&skipped, "a.ts", 1);
    fs::create_dir(skipped.join(OsStr::from_bytes(b".d\xff"))).expect("mkdir");
    assert_eq!(rels(&skipped, &[]), ["a.ts"]);
}

/// Without Git on PATH the walk reads the file system, so an ignored file is listed.
#[test]
fn without_git_the_file_system_is_walked() {
    let root = scratch("nogit");
    write(&root, "a.ts", 1);
    write(&root, "lib/l.ts", 1);
    fs::write(root.join(".gitignore"), "lib/\n").expect("ignore");
    git(&root, &["init", "-q"]);
    let mut cmd = command(&root, &[]);
    cmd.env("PATH", "");
    let mut got = parse_rows(cmd.output().expect("spawn"));
    got.sort();
    assert_eq!(got, ["a.ts", "lib/l.ts"]);
}

/// With no PATH at all Git is looked for in /usr/bin and /bin, as libuv does.
#[cfg(unix)]
#[test]
fn with_no_path_git_is_found_in_the_system_folders() {
    let root = scratch("nopath");
    write(&root, "a.ts", 1);
    write(&root, "lib/l.ts", 1);
    fs::write(root.join(".gitignore"), "lib/\n").expect("ignore");
    git(&root, &["init", "-q"]);
    let mut cmd = command(&root, &[]);
    cmd.env_remove("PATH");
    assert_eq!(parse_rows(cmd.output().expect("spawn")), ["a.ts"]);
}

/// A working folder that is the file system's root or the home folder holds every folder
/// the person installs to, so only that folder itself is passed over (`holdsAll` in
/// src/util/program.ts): Git is still found from `/`, and a Git in `~/bin` still runs when
/// the process folder is the home folder.
#[cfg(unix)]
#[test]
fn a_process_folder_at_the_root_or_home_still_finds_git() {
    let root = scratch("holds-all");
    write(&root, "a.ts", 1);
    write(&root, "lib/l.ts", 1);
    fs::write(root.join(".gitignore"), "lib/\n").expect("ignore");
    git(&root, &["init", "-q"]);
    let mut cmd = command(&root, &[]);
    cmd.current_dir("/").env("PATH", "/usr/bin:/bin");
    assert_eq!(parse_rows(cmd.output().expect("spawn")), ["a.ts"], "from /");
    let home = scratch("holds-all-home");
    fs::create_dir(home.join("bin")).expect("mkdir");
    std::os::unix::fs::symlink("/usr/bin/git", home.join("bin/git")).expect("link");
    let mut cmd = command(&root, &[]);
    cmd.current_dir(&*home)
        .env("HOME", &*home)
        .env("PATH", home.join("bin"));
    assert_eq!(parse_rows(cmd.output().expect("spawn")), ["a.ts"], "from ~");
    // A process folder that is neither still passes over the folders under it.
    let mut cmd = command(&root, &[]);
    cmd.current_dir(&*home)
        .env("HOME", "/nonexistent")
        .env("PATH", home.join("bin"));
    let mut got = parse_rows(cmd.output().expect("spawn"));
    got.sort();
    assert_eq!(got, ["a.ts", "lib/l.ts"], "from a plain folder");
}

/// Following repositories: a tree Git does not list is walked on the file system; tracked
/// files under a skipped folder stay out; a submodule with no checkout is left out; one whose
/// `.git` Git cannot read is walked on the file system.
#[test]
fn followed_repositories_fall_back_and_skip_as_typescript_does() {
    let plain = scratch("follow-plain");
    write(&plain, "a.ts", 1);
    assert_eq!(rels(&plain, &["--follow-submodules"]), ["a.ts"]);

    let root = scratch("follow");
    write(&root, "a.ts", 1);
    write(&root, "node_modules/p/i.ts", 1);
    write(&root, "broken/b.ts", 1);
    git(&root, &["init", "-q"]);
    git(&root, &["add", "-f", "--", "a.ts", "node_modules/p/i.ts"]);
    let sha = "1111111111111111111111111111111111111111";
    for sub in ["absent", "broken"] {
        let info = format!("160000,{sha},{sub}");
        git(&root, &["update-index", "--add", "--cacheinfo", &info]);
    }
    fs::write(root.join("broken/.git"), "gitdir: /nonexistent\n").expect("write");
    let got = rels(&root, &["--follow-submodules", "--follow-nested-repos"]);
    assert_eq!(got, ["a.ts", "broken/b.ts"]);
}

/// An output folder at the file system's root leaves every file out.
#[cfg(unix)]
#[test]
fn an_output_folder_at_the_top_leaves_everything_out() {
    let root = scratch("top");
    write(&root, "a.ts", 1);
    let out = Command::new(env!("CARGO_BIN_EXE_gg-index"))
        .args(["sources", "--out-dir", "/", "--root"])
        .arg(&*root)
        .output()
        .expect("spawn");
    assert!(parse_rows(out).is_empty());
}

/// A root that is a link: a loop, a broken link and a link to a file are each refused or
/// kept as TypeScript's `canonicalWalkRoot` does.
#[cfg(unix)]
#[test]
fn a_root_link_that_loops_or_breaks_fails() {
    use std::os::unix::fs::symlink;
    let base = scratch("rootlinks");
    symlink(base.join("loop"), base.join("loop")).expect("link");
    let out = exec(&base.join("loop"), &[]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("symbolic link loop"));
    symlink(base.join("nowhere"), base.join("broken")).expect("link");
    let out = exec(&base.join("broken"), &[]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("broken symbolic link"));
    write(&base, "file.ts", 1);
    symlink(base.join("file.ts"), base.join("tofile")).expect("link");
    let out = exec(&base.join("tofile"), &[]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("tofile"));
}

#[test]
fn a_missing_root_fails() {
    let root = scratch("missing").join("nothing-here");
    let out = exec(&root, &[]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("nothing-here"));
}
