//! Stage 3B1 discovery against goldens recorded from the TypeScript.
//!
//! `tests/fixtures/discovery/` holds `supportedExtensions()` and, for each name in
//! `classify-input.txt` (NUL-separated), whether a parser claims it and its
//! `deployFormatOf`. Regenerate with
//! `npx tsx rust/gg-index/parity/discovery-parity.ts --record rust/gg-index/tests/fixtures/discovery`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/discovery")
        .join(name);
    fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Runs gg-index in `cwd`, feeding `input` from another thread; a write the child
/// cuts short (it stopped reading) is not an error here.
fn exec(args: &[&str], input: Vec<u8>, cwd: &Path) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_gg-index"))
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn gg-index");
    let mut stdin = child.stdin.take().expect("stdin");
    let feeder = std::thread::spawn(move || drop(stdin.write_all(&input)));
    let out = child.wait_with_output().expect("wait");
    feeder.join().expect("feeder");
    out
}

fn run(args: &[&str], input: &[u8]) -> Vec<u8> {
    let out = exec(args, input.to_vec(), Path::new(env!("CARGO_MANIFEST_DIR")));
    assert!(
        out.status.success(),
        "gg-index {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    out.stdout
}

#[test]
fn supported_extensions_match_typescript() {
    assert_eq!(
        String::from_utf8(run(&["extensions"], b"")).unwrap(),
        String::from_utf8(fixture("extensions.json")).unwrap()
    );
}

#[test]
fn classification_matches_typescript() {
    assert_eq!(
        String::from_utf8(run(&["classify"], &fixture("classify-input.txt"))).unwrap(),
        String::from_utf8(fixture("classify.json")).unwrap()
    );
}

/// Safety: classify reads names only. Paths that climb out of the working directory,
/// name an absolute file or name a real directory are answered from the name, and the
/// empty working directory is left as it was.
#[test]
fn classify_reads_names_and_never_the_file_system() {
    let cwd = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("classify-names-only");
    let _ = fs::remove_dir_all(&cwd);
    fs::create_dir_all(cwd.join("compose.yml")).unwrap();
    let input = "../../etc/Dockerfile\0/no/such/main.tf\0compose.yml\0..\0";
    let out = exec(&["classify"], input.as_bytes().to_vec(), &cwd);
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        "[[false,\"dockerfile\"],[false,\"terraform\"],[false,\"compose\"],[false,null],[false,null]]\n"
    );
    let left: Vec<_> = fs::read_dir(&cwd)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(left, ["compose.yml"]);
}

/// Safety: classify's stdin read is bounded (64 MiB); more is refused, not buffered.
#[test]
fn classify_refuses_input_past_its_bound() {
    let cwd = Path::new(env!("CARGO_MANIFEST_DIR"));
    let at_bound = exec(&["classify"], vec![b'a'; 64 << 20], cwd);
    assert!(at_bound.status.success(), "64 MiB exactly is accepted");
    let past = exec(&["classify"], vec![b'a'; (64 << 20) + 1], cwd);
    assert!(!past.status.success());
    assert!(String::from_utf8_lossy(&past.stderr).contains("more than 67108864 bytes"));
}

/// Input that is not UTF-8 is outside the contract (TypeScript paths are strings): refused.
#[test]
fn classify_refuses_input_that_is_not_utf8() {
    let out = exec(
        &["classify"],
        b"a\xff.ts".to_vec(),
        Path::new(env!("CARGO_MANIFEST_DIR")),
    );
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("not UTF-8"));
}
