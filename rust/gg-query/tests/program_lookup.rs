//! `locate_program` on POSIX: the `findProgram` cases of `test/program.test.ts` that a real
//! file system can build, plus rules of the Rust's own where a test says so.
//!
//! The lookup reads `PATH`, `HOME` and `BERRY_BIN_FOLDER`, so every call goes through
//! [`lookup`], which holds one lock whilst it sets them, calls and puts them back. Windows
//! lookups add `PATHEXT` endings and are not covered here.
#![cfg(unix)]

use std::env;
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use gg_query::program::locate_program;
use tempfile::TempDir;

static ENV: Mutex<()> = Mutex::new(());

const KEYS: [&str; 3] = ["PATH", "HOME", "BERRY_BIN_FOLDER"];

/// `locate_program(name, cwd)` with `PATH` set to `path` (unset for `None`), `HOME` set when
/// given and left alone otherwise, and `BERRY_BIN_FOLDER` set only when given.
fn lookup(
    name: &str,
    cwd: &Path,
    path: Option<&str>,
    home: Option<&Path>,
    berry: Option<&str>,
) -> Result<PathBuf, String> {
    let _guard = ENV.lock().unwrap_or_else(PoisonError::into_inner);
    let saved: Vec<(&str, Option<OsString>)> = KEYS.iter().map(|k| (*k, env::var_os(k))).collect();
    let wanted = [
        ("PATH", path.map(OsString::from)),
        (
            "HOME",
            home.map(OsString::from).or_else(|| env::var_os("HOME")),
        ),
        ("BERRY_BIN_FOLDER", berry.map(OsString::from)),
    ];
    for (key, value) in &wanted {
        set(key, value.as_ref());
    }
    let found = locate_program(name, cwd);
    for (key, value) in &saved {
        set(key, value.as_ref());
    }
    found
}

fn set(key: &str, value: Option<&OsString>) {
    // SAFETY: `lookup` holds `ENV` around every change. The other readers in this binary
    // (`tempfile` reading `TMPDIR`, the panic hook reading `RUST_BACKTRACE`) go through
    // std's environment lock, which `set_var` takes too, and no C code reads it.
    unsafe {
        match value {
            Some(v) => env::set_var(key, v),
            None => env::remove_var(key),
        }
    }
}

struct Fixture {
    _tmp: TempDir,
    root: PathBuf,
    work: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = fs::canonicalize(tmp.path()).expect("canonical tempdir");
        let work = root.join("work");
        fs::create_dir_all(&work).expect("work");
        Self {
            _tmp: tmp,
            root,
            work,
        }
    }

    fn at(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    fn s(&self, rel: &str) -> String {
        self.at(rel).to_str().expect("utf-8 path").to_string()
    }

    /// `rel` spelt relative to the process's working folder, by climbing to `/` first.
    fn spelt_from_process(&self, rel: &str) -> String {
        let cwd = env::current_dir().expect("cwd");
        let up = "../".repeat(cwd.components().count() - 1);
        let spelt = format!("{up}{}", self.s(rel).trim_start_matches('/'));
        assert_eq!(
            fs::canonicalize(&spelt).ok(),
            fs::canonicalize(self.at(rel)).ok()
        );
        spelt
    }

    /// An executable `tool` in `rel`, which is created.
    fn tool(&self, rel: &str) -> PathBuf {
        let dir = self.at(rel);
        fs::create_dir_all(&dir).expect("tool dir");
        let file = dir.join("tool");
        fs::write(&file, "#!/bin/sh\nexit 0\n").expect("write tool");
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).expect("chmod");
        file
    }

    /// A symlink at `rel` pointing to `target`, written as given.
    fn link(&self, target: &str, rel: &str) {
        let at = self.at(rel);
        fs::create_dir_all(at.parent().expect("parent")).expect("link dir");
        symlink(target, at).expect("symlink");
    }

    fn find(&self, path: &str) -> Result<PathBuf, String> {
        lookup("tool", &self.work, Some(path), None, None)
    }
}

const NOT_FOUND: &str = "tool was not found on PATH outside the working folder and its subfolders";

#[test]
fn the_first_path_folder_holding_the_program_wins() {
    let f = Fixture::new();
    let a = f.tool("out/a");
    f.tool("out/b");
    let path = format!("{}:{}", f.s("out/a"), f.s("out/b"));
    assert_eq!(f.find(&path), Ok(a));
}

#[test]
fn without_path_the_lookup_reads_the_system_folders() {
    // On merged-`/usr` hosts `/bin` is `/usr/bin`, so the order of the two is not checked.
    let f = Fixture::new();
    let sh = lookup("sh", &f.work, None, None, None).expect("sh in /usr/bin or /bin");
    let first = ["/usr/bin/sh", "/bin/sh"]
        .into_iter()
        .map(Path::new)
        .find(|p| p.is_file())
        .expect("a system sh");
    let dir = fs::canonicalize(first.parent().expect("bin folder")).expect("canonical bin");
    assert_eq!(sh, dir.join("sh"));
}

#[test]
fn an_empty_path_is_no_path_entry_at_all() {
    let f = Fixture::new();
    assert_eq!(
        lookup("sh", &f.work, Some(""), None, None),
        Err("sh was not found on PATH outside the working folder and its subfolders".to_string())
    );
}

#[test]
fn empty_relative_and_missing_entries_find_nothing() {
    // The relative entry is refused twice over: skipped as relative, and refused by the link
    // trace, which cannot climb the leading `..` of a relative path. The empty entry
    // resolves to nothing. So this pins the result, not which rule gives it.
    let f = Fixture::new();
    f.tool("out/rel");
    let relative = f.spelt_from_process("out/rel");
    let missing = f.s("out/missing");
    assert_eq!(
        f.find(&format!(":{relative}:{missing}")),
        Err(NOT_FOUND.to_string())
    );
    let b = f.tool("out/b");
    assert_eq!(f.find(&format!("{relative}::{}", f.s("out/b"))), Ok(b));
}

#[test]
fn a_file_that_cannot_run_or_a_folder_of_that_name_is_passed_over() {
    let f = Fixture::new();
    let plain = f.tool("out/plain");
    fs::set_permissions(&plain, fs::Permissions::from_mode(0o644)).expect("chmod");
    fs::create_dir_all(f.at("out/dir/tool")).expect("folder named tool");
    let b = f.tool("out/b");
    let path = [f.s("out/plain"), f.s("out/dir"), f.s("out/b")].join(":");
    assert_eq!(f.find(&path), Ok(b));
}

#[test]
fn a_path_folder_at_or_under_the_working_folder_is_passed_over() {
    let f = Fixture::new();
    fs::rename(f.tool("out/x"), f.work.join("tool")).expect("move tool");
    f.tool("work/bin");
    let path = format!("{}:{}", f.work.display(), f.work.join("bin").display());
    assert_eq!(f.find(&path), Err(NOT_FOUND.to_string()));
    fs::create_dir_all(f.at("work/sub")).expect("sub");
    assert_eq!(
        lookup("tool", &f.at("work/sub"), Some(&path), None, None),
        Ok(f.work.join("tool")),
        "elsewhere in the checkout: the person's own entry, used"
    );
}

#[test]
fn a_path_folder_under_the_processs_own_working_folder_is_passed_over() {
    let f = Fixture::new();
    let here = tempfile::tempdir_in(env::current_dir().expect("cwd")).expect("tempdir here");
    let bin = here.path().join("bin");
    fs::create_dir_all(&bin).expect("bin");
    fs::rename(f.tool("out/x"), bin.join("tool")).expect("move tool");
    assert_eq!(
        f.find(bin.to_str().expect("utf-8")),
        Err(NOT_FOUND.to_string())
    );
}

#[test]
fn a_link_to_the_working_folder_is_judged_by_its_real_path() {
    // `under_by_id` would refuse this too.
    let f = Fixture::new();
    f.tool("work");
    f.link(&f.work.display().to_string(), "out/alias");
    assert_eq!(f.find(&f.s("out/alias")), Err(NOT_FOUND.to_string()));
}

#[test]
fn a_working_folder_spelt_with_dot_dot_after_a_link_is_its_real_folder() {
    // `lk/../work` is `deep/work` to the system (`lk` is `deep/x`) but `work` when cleaned
    // as text. The real path and the identity both catch it; on POSIX only a bind mount
    // shows a folder by identity that its real path hides, so no test here pins identity alone.
    let f = Fixture::new();
    fs::create_dir_all(f.at("deep/x")).expect("x");
    f.link(&f.s("deep/x"), "lk");
    f.tool("deep/work/bin");
    let got = lookup(
        "tool",
        &f.at("lk/../work"),
        Some(&f.s("deep/work/bin")),
        None,
        None,
    );
    assert_eq!(got, Err(NOT_FOUND.to_string()));
}

#[test]
fn a_working_folder_named_through_a_link_is_judged_by_its_real_path_too() {
    // Identity also catches this case, so it holds with either rule removed.
    let f = Fixture::new();
    f.tool("work/bin");
    f.link(&f.work.display().to_string(), "out/worklink");
    let got = lookup(
        "tool",
        &f.at("out/worklink"),
        Some(&f.work.join("bin").display().to_string()),
        None,
        None,
    );
    assert_eq!(got, Err(NOT_FOUND.to_string()));
}

#[test]
fn a_relative_working_folder_is_read_from_the_process_folder() {
    let f = Fixture::new();
    f.tool("work/bin");
    let bin = f.s("work/bin");
    let rel = f.spelt_from_process("work");
    assert_eq!(
        lookup("tool", Path::new(&rel), Some(&bin), None, None),
        Err(NOT_FOUND.to_string())
    );
    // Identity would catch the spelling above without the join, so this spelling has none:
    // `lk/../work` is the missing `deep/work` to the system and `work` once joined and
    // cleaned as text.
    fs::create_dir_all(f.at("deep/x")).expect("x");
    f.link(&f.s("deep/x"), "lk");
    let rel = f.spelt_from_process("lk/../work");
    assert_eq!(
        lookup("tool", Path::new(&rel), Some(&bin), None, None),
        Err(NOT_FOUND.to_string())
    );
}

#[test]
fn yarns_own_bin_folder_is_passed_over_and_a_relative_one_is_ignored() {
    let f = Fixture::new();
    let berry = f.tool("out/berry");
    let path = f.s("out/berry");
    assert_eq!(
        lookup("tool", &f.work, Some(&path), None, Some(&path)),
        Err(NOT_FOUND.to_string())
    );
    assert_eq!(
        lookup(
            "tool",
            &f.work,
            Some(&path),
            None,
            Some(&f.spelt_from_process("out/berry"))
        ),
        Ok(berry)
    );
}

#[test]
fn yarns_own_bin_folder_is_known_by_its_real_path_as_written() {
    // `lk/../bin` is `deep/bin` to the system (`lk` is `deep/x`) but `bin` cleaned as text.
    let f = Fixture::new();
    fs::create_dir_all(f.at("deep/x")).expect("x");
    f.link(&f.s("deep/x"), "lk");
    f.tool("deep/bin");
    assert_eq!(
        lookup(
            "tool",
            &f.work,
            Some(&f.s("deep/bin")),
            None,
            Some(&f.s("lk/../bin"))
        ),
        Err(NOT_FOUND.to_string())
    );
}

#[test]
fn a_node_modules_bin_folder_is_passed_over_wherever_it_is() {
    let f = Fixture::new();
    f.tool("out/node_modules/.bin");
    assert_eq!(
        f.find(&f.s("out/node_modules/.bin")),
        Err(NOT_FOUND.to_string())
    );
    let other = f.tool("out/other/.bin");
    assert_eq!(f.find(&f.s("out/other/.bin")), Ok(other.clone()));
    let path = format!("{}:{}", f.s("out/node_modules/.bin"), f.s("out/other/.bin"));
    assert_eq!(f.find(&path), Ok(other), "a later entry is still found");
}

#[test]
fn a_root_or_home_working_folder_passes_over_only_itself() {
    let f = Fixture::new();
    let a = f.tool("out/a");
    assert_eq!(
        lookup("tool", Path::new("/"), Some(&f.s("out/a")), None, None),
        Ok(a.clone())
    );
    let home = f.at("out");
    assert_eq!(
        lookup("tool", &home, Some(&f.s("out/a")), Some(&home), None),
        Ok(a)
    );
    f.tool("out");
    assert_eq!(
        lookup("tool", &home, Some(&f.s("out")), Some(&home), None),
        Err(NOT_FOUND.to_string())
    );
}

#[test]
fn a_program_file_that_links_into_the_working_folder_is_passed_over() {
    let f = Fixture::new();
    let inside = f.tool("work/real");
    f.link(&inside.display().to_string(), "out/bin/tool");
    assert_eq!(f.find(&f.s("out/bin")), Err(NOT_FOUND.to_string()));
}

#[test]
fn a_folder_reached_through_the_working_folder_is_passed_over_though_it_links_out_again() {
    let f = Fixture::new();
    f.tool("out/real");
    f.link(&f.s("out/real"), "work/hop");
    f.link(&f.work.join("hop").display().to_string(), "out/entry");
    assert_eq!(f.find(&f.s("out/entry")), Err(NOT_FOUND.to_string()));
    assert_eq!(
        f.find(&f.s("out/real")),
        Ok(f.at("out/real/tool")),
        "the folder it links to, named as itself, is used"
    );
}

#[test]
fn yarn_classic_global_links_through_its_own_node_modules_bin_are_used() {
    let f = Fixture::new();
    let real = f.tool("out/global/pkg/bin");
    f.link("../../pkg/bin/tool", "out/global/node_modules/.bin/tool");
    f.link("../global/node_modules/.bin/tool", "out/gbin/tool");
    assert_eq!(f.find(&f.s("out/gbin")), Ok(f.at("out/gbin/tool")));
    assert_eq!(
        fs::canonicalize(f.at("out/gbin/tool")).expect("resolves"),
        real
    );
}

#[test]
fn dot_dot_after_a_link_is_taken_from_the_links_target() {
    let f = Fixture::new();
    let tool = f.tool("out/deep/bin");
    fs::create_dir_all(f.at("out/deep/x")).expect("x");
    f.link(&f.s("out/deep/x"), "out/lk");
    assert_eq!(f.find(&f.s("out/lk/../bin")), Ok(tool.clone()));
    // A `..` at the root stays at the root.
    assert_eq!(f.find(&format!("/..{}", f.s("out/deep/bin"))), Ok(tool));
}

#[test]
fn a_link_whose_target_climbs_with_dot_dot_is_followed() {
    let f = Fixture::new();
    let tool = f.tool("out/deep/bin");
    f.link("../deep/bin", "out/up/bin");
    assert_eq!(f.find(&f.s("out/up/bin")), Ok(tool));
}

#[test]
fn an_absolute_program_path_is_used_only_outside_the_working_folder() {
    // The Rust's own rule, not a `findProgram` case: the nearest TypeScript, `admitted`,
    // needs no exec bit and admits `/`.
    let f = Fixture::new();
    let out = f.tool("out/a");
    let inside = f.tool("work/a");
    assert_eq!(
        lookup(&f.s("out/a/tool"), &f.work, None, None, None),
        Ok(out)
    );
    let refused = |name: &str| {
        format!(
            "{name} was not started: trail starts programs only by an absolute path outside the working folder and its subfolders"
        )
    };
    let inside = inside.display().to_string();
    assert_eq!(
        lookup(&inside, &f.work, None, None, None),
        Err(refused(&inside))
    );
    assert_eq!(lookup("/", &f.work, None, None, None), Err(refused("/")));
    let missing = f.s("missing/tool");
    assert_eq!(
        lookup(&missing, &f.work, None, None, None),
        Err(refused(&missing))
    );
}
