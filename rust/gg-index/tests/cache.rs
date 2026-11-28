//! Stage 3B1c: `gg-index cache write|read` and `gg-index fingerprint write|read`, the port
//! of `src/graph/extract-cache.ts` and `src/graph/fingerprint.ts`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, SystemTime};

struct Scratch(PathBuf);

impl std::ops::Deref for Scratch {
    type Target = Path;
    fn deref(&self) -> &Path {
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
        .join("gg-index-cache")
        .join(format!("{name}-{}", std::process::id()));
    drop(fs::remove_dir_all(&dir));
    fs::create_dir_all(&dir).expect("scratch");
    Scratch(dir)
}

fn exec_in(args: &[&str], input: &[u8], cwd: &Path) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_gg-index"))
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn gg-index");
    let mut stdin = child.stdin.take().expect("stdin");
    let bytes = input.to_vec();
    let feeder = std::thread::spawn(move || drop(stdin.write_all(&bytes)));
    let out = child.wait_with_output().expect("wait");
    feeder.join().expect("feeder");
    out
}

fn run(args: &[&str], input: &str) -> String {
    let out = exec_in(
        args,
        input.as_bytes(),
        Path::new(env!("CARGO_MANIFEST_DIR")),
    );
    assert!(
        out.status.success(),
        "gg-index {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).expect("utf-8 stdout")
}

fn cache_op(verb: &str, out: &Path, stamp: &str, input: &str) -> String {
    let out_s = out.to_str().expect("utf-8");
    run(
        &["cache", verb, "--out-dir", out_s, "--extractor", stamp],
        input,
    )
}

fn fp_op(verb: &str, out: &Path, stamp: &str, extra: &[&str], input: &str) -> String {
    let out_s = out.to_str().expect("utf-8");
    let mut args = vec![
        "fingerprint",
        verb,
        "--out-dir",
        out_s,
        "--extractor",
        stamp,
    ];
    args.extend_from_slice(extra);
    run(&args, input)
}

fn touch_at(path: &Path, secs: u64) {
    let file = fs::File::create(path).expect("create");
    file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(secs))
        .expect("set_modified");
}

fn sorted_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .expect("readdir")
        .map(|e| e.expect("e").file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn extract_cache_writes_ascii_prunes_sidecars_and_reads_back() {
    let base = scratch("cache-roundtrip");
    let out = base.join("graft");
    let cache_dir = out.join(".cache");
    fs::create_dir_all(&cache_dir).expect("mkdir");
    for k in 0..3u64 {
        touch_at(&cache_dir.join(format!("extract.old{k}.json")), 1_000_000_000 + k);
    }
    fs::write(cache_dir.join("fingerprint.keep.json"), "{}").expect("fp");
    fs::create_dir(cache_dir.join("extract.dir.json")).expect("dir");

    let stamp = "0123456789abcdef";
    let payload = format!(
        "{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{\
        \"src/café.ts\":{{\"size\":42,\"mtimeMs\":1.5,\"hash\":\"h1\",\
        \"nodes\":[{{\"id\":\"src/café.ts#g\",\"name\":\"g\",\"path\":\"src/café.ts\",\
        \"body_text\":\"naïve — ✓ 😀 \\u2028 \\u0000\"}}],\"rawEdges\":[],\
        \"via\":\"javascript\",\"error\":\"e\",\"deploy\":[{{\"kind\":\"image\",\"value\":\"ü\",\"line\":3}}],\
        \"skipped\":\"s\"}},\
        \"src/plain.ts\":{{\"size\":7,\"mtimeMs\":2,\"hash\":\"h2\",\"nodes\":[],\"rawEdges\":[]}}}}}}"
    );
    assert_eq!(cache_op("write", &out, stamp, &payload), "true\n");
    let written = fs::read(cache_dir.join(format!("extract.{stamp}.json"))).expect("read");
    assert!(written.iter().all(|&b| b < 0x80), "extract cache must be pure ASCII");
    assert!(!written.ends_with(b"\n"), "no trailing newline");
    assert_eq!(
        sorted_names(&cache_dir),
        [
            format!("extract.{stamp}.json"),
            "extract.dir.json".into(),
            "extract.old2.json".into(),
            "fingerprint.keep.json".into(),
        ]
    );
    let expected = format!(
        "{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{\
        \"src/café.ts\":{{\"size\":42,\"mtimeMs\":1.5,\"hash\":\"h1\",\
        \"nodes\":[{{\"id\":\"src/café.ts#g\",\"name\":\"g\",\"path\":\"src/café.ts\",\
        \"body_text\":\"naïve — ✓ 😀 \u{2028} \\u0000\"}}],\"rawEdges\":[],\
        \"via\":\"javascript\",\"error\":\"e\",\"deploy\":[{{\"kind\":\"image\",\"value\":\"ü\",\"line\":3}}],\
        \"skipped\":\"s\"}},\
        \"src/plain.ts\":{{\"size\":7,\"mtimeMs\":2,\"hash\":\"h2\",\"nodes\":[],\"rawEdges\":[]}}}}}}\n"
    );
    assert_eq!(cache_op("read", &out, stamp, ""), expected);
}

#[test]
fn extract_cache_read_filters_forged_entries() {
    let base = scratch("cache-trust");
    let out = base.join("graft");
    let cache_dir = out.join(".cache");
    fs::create_dir_all(&cache_dir).expect("mkdir");
    let stamp = "fedcba9876543210";
    let file = cache_dir.join(format!("extract.{stamp}.json"));
    let forged = format!(
        "{{\"version\":1,\"extractor\":\"{stamp}\",\"extra\":9,\"files\":{{\
        \"__proto__\":{{\"src/a.ts\":{{\"nodes\":[],\"rawEdges\":[]}}}},\
        \"src/ok.ts\":{{\"size\":1,\"mtimeMs\":2,\"hash\":\"h\",\"nodes\":[{{\"path\":\"src/ok.ts\"}}],\"rawEdges\":[]}},\
        \"src/escape.ts\":{{\"size\":1,\"mtimeMs\":2,\"hash\":\"h\",\"nodes\":[{{\"path\":\"../secret.ts\"}}],\"rawEdges\":[]}},\
        \"src/nopath.ts\":{{\"size\":1,\"mtimeMs\":2,\"hash\":\"h\",\"nodes\":[{{}}],\"rawEdges\":[]}},\
        \"src/badnodes.ts\":{{\"size\":1,\"mtimeMs\":2,\"hash\":\"h\",\"nodes\":{{}},\"rawEdges\":[]}},\
        \"src/badedges.ts\":{{\"size\":1,\"mtimeMs\":2,\"hash\":\"h\",\"nodes\":[],\"rawEdges\":null}},\
        \"src/null.ts\":null,\
        \"src/empty.ts\":{{\"size\":1,\"mtimeMs\":2,\"hash\":\"h\",\"nodes\":[],\"rawEdges\":[]}}}}}}"
    );
    fs::write(&file, forged).expect("write");
    assert_eq!(
        cache_op("read", &out, stamp, ""),
        format!(
            "{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{\
            \"src/ok.ts\":{{\"size\":1,\"mtimeMs\":2,\"hash\":\"h\",\"nodes\":[{{\"path\":\"src/ok.ts\"}}],\"rawEdges\":[]}},\
            \"src/empty.ts\":{{\"size\":1,\"mtimeMs\":2,\"hash\":\"h\",\"nodes\":[],\"rawEdges\":[]}}}}}}\n"
        )
    );
}

#[test]
fn extract_cache_rejects_malformed_files_and_bad_extractors() {
    let base = scratch("cache-bad");
    let out = base.join("graft");
    let cache_dir = out.join(".cache");
    fs::create_dir_all(&cache_dir).expect("mkdir");
    let stamp = "fedcba9876543210";
    let file = cache_dir.join(format!("extract.{stamp}.json"));
    let empty = format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}\n");
    for bad in [
        format!("{{\"version\":2,\"extractor\":\"{stamp}\",\"files\":{{}}}}"),
        "{\"version\":1,\"extractor\":\"other\",\"files\":{}}".into(),
        format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":null}}"),
        format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":[]}}"),
        format!("{{\"version\":1,\"extractor\":\"{stamp}\"}}"),
        "{not json".into(),
        "[]".into(),
    ] {
        fs::write(&file, bad).expect("write bad");
        assert_eq!(cache_op("read", &out, stamp, ""), empty);
    }
    fs::write(&file, b"\xff").expect("write bad utf-8");
    assert_eq!(cache_op("read", &out, stamp, ""), empty);
    assert_eq!(
        cache_op("write", &out, "", "{\"version\":1,\"extractor\":\"\",\"files\":{}}"),
        "false\n"
    );
    assert_eq!(cache_op("read", &out, "", ""), "{\"version\":1,\"extractor\":\"\",\"files\":{}}\n");
    let evil = "{\"version\":1,\"extractor\":\"../evil\",\"files\":{}}";
    assert_eq!(cache_op("write", &out, "../evil", evil), "false\n");
    assert_eq!(
        cache_op("read", &out, "../evil", ""),
        "{\"version\":1,\"extractor\":\"../evil\",\"files\":{}}\n"
    );
}

#[test]
fn fingerprint_writes_utf8_prunes_and_reads_back() {
    let base = scratch("fp-roundtrip");
    let out = base.join("graft");
    let cache_dir = out.join(".cache");
    fs::create_dir_all(&cache_dir).expect("mkdir");
    for k in 0..3u64 {
        touch_at(&cache_dir.join(format!("fingerprint.old{k}.json")), 1_000_000_000 + k);
    }
    fs::write(cache_dir.join("extract.keep.json"), "{}").expect("extract");

    let stamp = "1122334455667788";
    let entries = r#"{"ü/a.ts":{"size":12,"mtimeMs":3.5,"hash":"ab","nodes":[],"rawEdges":[]},"src/b.py":{"size":4,"mtimeMs":9,"hash":"cd"}}"#;
    let extra = ["--only-dir", "src", "--ext", ".ts"];
    assert_eq!(fp_op("write", &out, stamp, &extra, entries), "true\n");

    let fp_path = cache_dir.join(format!("fingerprint.{stamp}.json"));
    let expected = format!(
        "{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{\"ü/a.ts\":[12,3.5,\"ab\"],\"src/b.py\":[4,9,\"cd\"]}},\"onlyDirs\":[\"src\"],\"extensions\":[\".ts\"]}}"
    );
    assert_eq!(fs::read_to_string(&fp_path).expect("read"), expected);
    assert_eq!(fp_op("read", &out, stamp, &[], ""), format!("{expected}\n"));
    assert_eq!(
        sorted_names(&cache_dir),
        [
            "extract.keep.json".into(),
            format!("fingerprint.{stamp}.json"),
            "fingerprint.old2.json".into(),
        ]
    );
}

#[test]
fn fingerprint_handles_empty_extractor_and_corrupt_files() {
    let base = scratch("fp-edges");
    let out = base.join("graft");
    let cache_dir = out.join(".cache");
    fs::create_dir_all(&cache_dir).expect("mkdir");
    let stamp = "1122334455667788";
    assert_eq!(
        cache_op("read", &out, stamp, ""),
        format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}\n")
    );
    assert_eq!(fp_op("read", &out, stamp, &[], ""), "null\n");
    assert_eq!(fp_op("write", &out, "", &[], "{}"), "true\n");
    assert_eq!(
        fp_op("read", &out, "", &[], ""),
        "{\"version\":1,\"extractor\":\"nostamp\",\"files\":{}}\n"
    );
    let fp_path = cache_dir.join(format!("fingerprint.{stamp}.json"));
    for bad in [
        format!("{{\"version\":2,\"extractor\":\"{stamp}\",\"files\":{{}}}}"),
        "{\"version\":1,\"extractor\":\"other\",\"files\":{}}".into(),
        format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":null}}"),
        "{bad".into(),
    ] {
        fs::write(&fp_path, bad).expect("write bad");
        assert_eq!(fp_op("read", &out, stamp, &[], ""), "null\n");
    }
    fs::write(&fp_path, b"\xff").expect("write bad utf-8");
    assert_eq!(fp_op("read", &out, stamp, &[], ""), "null\n");
}

#[test]
fn containment_refuses_blocked_cache_dirs_and_dir_leaves() {
    let base = scratch("containment");
    let stamp = "aabbccdd11223344";
    let empty_cache = format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}\n");
    let valid_cache = format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}");

    let absent = base.join("missing").join("graft");
    assert_eq!(cache_op("read", &absent, stamp, ""), empty_cache);
    assert_eq!(fp_op("read", &absent, stamp, &[], ""), "null\n");
    assert!(!base.join("missing").exists());

    let blocked = base.join("blocked");
    fs::create_dir_all(&blocked).expect("mkdir");
    fs::write(blocked.join(".cache"), "not a dir").expect("write");
    assert_eq!(cache_op("write", &blocked, stamp, &valid_cache), "false\n");
    assert_eq!(fp_op("write", &blocked, stamp, &[], "{}"), "false\n");
    assert_eq!(cache_op("read", &blocked, stamp, ""), empty_cache);
    assert_eq!(fp_op("read", &blocked, stamp, &[], ""), "null\n");

    let dirleaf = base.join("dirleaf");
    let dc = dirleaf.join(".cache");
    fs::create_dir_all(dc.join(format!("extract.{stamp}.json"))).expect("mkdir");
    fs::create_dir_all(dc.join(format!("fingerprint.{stamp}.json"))).expect("mkdir");
    assert_eq!(cache_op("write", &dirleaf, stamp, &valid_cache), "false\n");
    assert_eq!(cache_op("read", &dirleaf, stamp, ""), empty_cache);
    assert_eq!(fp_op("read", &dirleaf, stamp, &[], ""), "null\n");
}

#[test]
fn containment_refuses_escape_and_handles_empty_out_dir() {
    let base = scratch("containment-escape");
    let stamp = "aabbccdd11223344";
    let valid_cache = format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}");
    let esc = base.join("esc");
    fs::create_dir_all(&esc).expect("mkdir");
    assert_eq!(
        cache_op("write", &esc.join(".."), stamp, &valid_cache),
        "false\n"
    );
    assert!(!base.join(".cache").exists());

    let empty_cwd = base.join("empty-cwd");
    fs::create_dir_all(&empty_cwd).expect("mkdir");
    let out = exec_in(
        &[
            "fingerprint",
            "write",
            "--out-dir",
            "",
            "--extractor",
            stamp,
        ],
        b"{}",
        &empty_cwd,
    );
    assert!(out.status.success());
    assert_eq!(String::from_utf8(out.stdout).unwrap(), "true\n");
    assert!(empty_cwd.join(".cache").join(format!("fingerprint.{stamp}.json")).is_file());
}

#[test]
fn cache_and_fingerprint_writes_handle_bad_stdin() {
    let base = scratch("containment-stdin");
    let stamp = "aabbccdd11223344";
    let ok = base.join("ok");
    assert_eq!(cache_op("write", &ok, stamp, "[]"), "false\n");
    assert_eq!(cache_op("write", &ok, stamp, "{\"version\":1}"), "false\n");
    assert_eq!(fp_op("write", &ok, stamp, &[], "[]"), "false\n");

    let ok_s = ok.to_str().expect("utf-8");
    let bad_json = exec_in(
        &["cache", "write", "--out-dir", ok_s, "--extractor", stamp],
        b"{bad",
        &base,
    );
    assert!(!bad_json.status.success());
    let bad_utf8 = exec_in(
        &[
            "fingerprint",
            "write",
            "--out-dir",
            ok_s,
            "--extractor",
            stamp,
        ],
        b"\xff",
        &base,
    );
    assert!(!bad_utf8.status.success());
}

#[cfg(unix)]
#[test]
fn symlinked_dirs_and_leaves_are_refused_on_unix() {
    use std::os::unix::fs::symlink;
    let base = scratch("unix-links");
    let outside = base.join("outside");
    fs::create_dir_all(&outside).expect("mkdir");
    let stamp = "0011223344556677";
    let empty = format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}\n");
    let valid_cache = format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}");

    let link_out = base.join("graft");
    symlink(&outside, &link_out).expect("link");
    assert_eq!(cache_op("write", &link_out, stamp, &valid_cache), "false\n");
    assert_eq!(fs::read_dir(&outside).expect("readdir").count(), 0);
    fs::remove_file(&link_out).expect("rm");

    fs::create_dir_all(&link_out).expect("mkdir");
    symlink(&outside, link_out.join(".cache")).expect("link");
    fs::write(outside.join(format!("extract.{stamp}.json")), &valid_cache).expect("write");
    assert_eq!(cache_op("write", &link_out, stamp, &valid_cache), "false\n");
    assert_eq!(cache_op("read", &link_out, stamp, ""), empty);
    fs::remove_file(link_out.join(".cache")).expect("rm");

    let cache_dir = link_out.join(".cache");
    fs::create_dir_all(&cache_dir).expect("mkdir");
    let victim = outside.join("victim.json");
    fs::write(&victim, &valid_cache).expect("write");
    let leaf = cache_dir.join(format!("extract.{stamp}.json"));
    symlink(&victim, &leaf).expect("link");
    let link_sidecar = cache_dir.join("extract.link.json");
    symlink(&victim, &link_sidecar).expect("link");
    assert_eq!(cache_op("read", &link_out, stamp, ""), empty);
    let fresh = format!(
        "{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{\"a.ts\":{{\"size\":1,\"mtimeMs\":1,\"hash\":\"h\",\"nodes\":[],\"rawEdges\":[]}}}}}}"
    );
    assert_eq!(cache_op("write", &link_out, stamp, &fresh), "true\n");
    assert_eq!(fs::read_to_string(&victim).expect("victim"), valid_cache);
    assert!(!fs::symlink_metadata(&leaf).expect("lstat").file_type().is_symlink());
    assert!(fs::symlink_metadata(&link_sidecar).expect("lstat").file_type().is_symlink());
}

#[cfg(unix)]
#[test]
fn unreadable_cache_entries_return_empty_on_unix() {
    use std::os::unix::fs::PermissionsExt;
    let base = scratch("unix-unreadable");
    let out = base.join("graft");
    let cache_dir = out.join(".cache");
    fs::create_dir_all(&cache_dir).expect("mkdir");
    let stamp = "0011223344556677";
    let empty = format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}\n");
    let leaf = cache_dir.join(format!("extract.{stamp}.json"));
    fs::write(&leaf, format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}"))
        .expect("write");
    fs::set_permissions(&leaf, fs::Permissions::from_mode(0o000)).expect("chmod");
    assert_eq!(cache_op("read", &out, stamp, ""), empty);
    fs::set_permissions(&leaf, fs::Permissions::from_mode(0o644)).expect("chmod");
    fs::set_permissions(&cache_dir, fs::Permissions::from_mode(0o000)).expect("chmod");
    assert_eq!(cache_op("read", &out, stamp, ""), empty);
    fs::set_permissions(&cache_dir, fs::Permissions::from_mode(0o755)).expect("chmod");
}

#[cfg(windows)]
fn make_junction(link: &Path, target: &Path) {
    let made = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .expect("mklink");
    assert!(
        made.status.success(),
        "{}",
        String::from_utf8_lossy(&made.stderr)
    );
}

#[cfg(windows)]
#[test]
fn junctioned_cache_paths_and_leaves_are_refused_on_windows() {
    let base = scratch("win-junctions");
    let outside = base.join("outside");
    fs::create_dir_all(&outside).expect("mkdir");
    let stamp = "0011223344556677";
    let empty = format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}\n");
    let valid_cache = format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}");
    fs::write(outside.join(format!("extract.{stamp}.json")), &valid_cache).expect("write");
    for k in 0..3u64 {
        touch_at(&outside.join(format!("extract.old{k}.json")), 1_000_000_000 + k);
    }

    let junc_out = base.join("graft");
    make_junction(&junc_out, &outside);
    assert_eq!(cache_op("write", &junc_out, stamp, &valid_cache), "false\n");
    assert_eq!(cache_op("read", &junc_out, stamp, ""), empty);
    fs::remove_dir(&junc_out).expect("rm junction");

    fs::create_dir_all(&junc_out).expect("mkdir");
    make_junction(&junc_out.join(".cache"), &outside);
    assert_eq!(cache_op("write", &junc_out, stamp, &valid_cache), "false\n");
    assert_eq!(cache_op("read", &junc_out, stamp, ""), empty);
    gg_index::safe_write::prune_cache(&junc_out, "extract", 2);
    assert_eq!(sorted_names(&outside).len(), 4);
    fs::remove_dir(junc_out.join(".cache")).expect("rm junction");

    let cache_dir = junc_out.join(".cache");
    fs::create_dir_all(&cache_dir).expect("mkdir");
    let junc_leaf = cache_dir.join(format!("extract.{stamp}.json"));
    let junc_sidecar = cache_dir.join("extract.junc.json");
    make_junction(&junc_leaf, &outside);
    make_junction(&junc_sidecar, &outside);
    assert_eq!(cache_op("read", &junc_out, stamp, ""), empty);
    let other = "1111222233334444";
    let other_cache = format!("{{\"version\":1,\"extractor\":\"{other}\",\"files\":{{}}}}");
    assert_eq!(cache_op("write", &junc_out, other, &other_cache), "true\n");
    assert!(junc_sidecar.exists(), "prune leaves junction sidecars alone");
    fs::remove_dir(&junc_leaf).expect("rm junction");
    fs::remove_dir(&junc_sidecar).expect("rm junction");
}
