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
    let out = exec_in(args, input.as_bytes(), Path::new(env!("CARGO_MANIFEST_DIR")));
    assert!(
        out.status.success(),
        "gg-index {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).expect("utf-8 stdout")
}

fn touch_at(path: &Path, secs: u64) {
    let file = fs::File::create(path).expect("create");
    file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(secs))
        .expect("set_modified");
}

#[test]
fn extract_cache_writes_ascii_prunes_sidecars_and_reads_back() {
    let base = scratch("cache-roundtrip");
    let out = base.join("graft");
    let cache_dir = out.join(".cache");
    fs::create_dir_all(&cache_dir).expect("mkdir");
    for k in 0..3u64 {
        touch_at(
            &cache_dir.join(format!("extract.old{k}.json")),
            1_000_000_000 + k,
        );
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
    let out_s = out.to_str().expect("utf-8");
    let wrote = run(
        &["cache", "write", "--out-dir", out_s, "--extractor", stamp],
        &payload,
    );
    assert_eq!(wrote, "true\n");

    let written = fs::read(cache_dir.join(format!("extract.{stamp}.json"))).expect("read");
    assert!(
        written.iter().all(|&b| b < 0x80),
        "extract cache must be pure ASCII"
    );
    assert!(!written.ends_with(b"\n"), "no trailing newline");

    let mut left: Vec<String> = fs::read_dir(&cache_dir)
        .expect("readdir")
        .map(|e| e.expect("e").file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    assert_eq!(
        left,
        [
            format!("extract.{stamp}.json"),
            "extract.dir.json".into(),
            "extract.old2.json".into(),
            "fingerprint.keep.json".into(),
        ]
    );

    let got = run(
        &["cache", "read", "--out-dir", out_s, "--extractor", stamp],
        "",
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
    assert_eq!(got, expected);
}

#[test]
fn extract_cache_read_filters_forged_and_malformed_entries() {
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
    let out_s = out.to_str().expect("utf-8");
    let got = run(
        &["cache", "read", "--out-dir", out_s, "--extractor", stamp],
        "",
    );
    assert_eq!(
        got,
        format!(
            "{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{\
            \"src/ok.ts\":{{\"size\":1,\"mtimeMs\":2,\"hash\":\"h\",\"nodes\":[{{\"path\":\"src/ok.ts\"}}],\"rawEdges\":[]}},\
            \"src/empty.ts\":{{\"size\":1,\"mtimeMs\":2,\"hash\":\"h\",\"nodes\":[],\"rawEdges\":[]}}}}}}\n"
        )
    );

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
        assert_eq!(
            run(
                &["cache", "read", "--out-dir", out_s, "--extractor", stamp],
                ""
            ),
            empty
        );
    }

    // Empty extractor: no memo is written or read.
    assert_eq!(
        run(
            &["cache", "write", "--out-dir", out_s, "--extractor", ""],
            &format!("{{\"version\":1,\"extractor\":\"\",\"files\":{{}}}}"),
        ),
        "false\n"
    );
    assert_eq!(
        run(
            &["cache", "read", "--out-dir", out_s, "--extractor", ""],
            ""
        ),
        "{\"version\":1,\"extractor\":\"\",\"files\":{}}\n"
    );
    // Traversal in extractor is refused.
    assert_eq!(
        run(
            &[
                "cache",
                "write",
                "--out-dir",
                out_s,
                "--extractor",
                "../evil"
            ],
            "{\"version\":1,\"extractor\":\"../evil\",\"files\":{}}",
        ),
        "false\n"
    );
    assert_eq!(
        run(
            &[
                "cache",
                "read",
                "--out-dir",
                out_s,
                "--extractor",
                "../evil"
            ],
            "",
        ),
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
        touch_at(
            &cache_dir.join(format!("fingerprint.old{k}.json")),
            1_000_000_000 + k,
        );
    }
    fs::write(cache_dir.join("extract.keep.json"), "{}").expect("extract");

    let stamp = "1122334455667788";
    let entries = r#"{"ü/a.ts":{"size":12,"mtimeMs":3.5,"hash":"ab","nodes":[],"rawEdges":[]},"src/b.py":{"size":4,"mtimeMs":9,"hash":"cd"}}"#;
    let out_s = out.to_str().expect("utf-8");
    let wrote = run(
        &[
            "fingerprint",
            "write",
            "--out-dir",
            out_s,
            "--extractor",
            stamp,
            "--only-dir",
            "src",
            "--ext",
            ".ts",
        ],
        entries,
    );
    assert_eq!(wrote, "true\n");

    let fp_path = cache_dir.join(format!("fingerprint.{stamp}.json"));
    let expected = format!(
        "{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{\"ü/a.ts\":[12,3.5,\"ab\"],\"src/b.py\":[4,9,\"cd\"]}},\"onlyDirs\":[\"src\"],\"extensions\":[\".ts\"]}}"
    );
    assert_eq!(fs::read_to_string(&fp_path).expect("read"), expected);
    assert_eq!(
        run(
            &[
                "fingerprint",
                "read",
                "--out-dir",
                out_s,
                "--extractor",
                stamp
            ],
            ""
        ),
        format!("{expected}\n")
    );

    let mut left: Vec<String> = fs::read_dir(&cache_dir)
        .expect("readdir")
        .map(|e| e.expect("e").file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    assert_eq!(
        left,
        [
            "extract.keep.json".into(),
            format!("fingerprint.{stamp}.json"),
            "fingerprint.old2.json".into(),
        ]
    );

    // Empty extractor falls back to "nostamp" as fingerprint.ts does.
    assert_eq!(
        run(
            &["fingerprint", "write", "--out-dir", out_s, "--extractor", ""],
            "{}",
        ),
        "true\n"
    );
    assert_eq!(
        run(
            &["fingerprint", "read", "--out-dir", out_s, "--extractor", ""],
            ""
        ),
        "{\"version\":1,\"extractor\":\"nostamp\",\"files\":{}}\n"
    );

    for bad in [
        format!("{{\"version\":2,\"extractor\":\"{stamp}\",\"files\":{{}}}}"),
        "{\"version\":1,\"extractor\":\"other\",\"files\":{}}".into(),
        format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":null}}"),
        "{bad".into(),
    ] {
        fs::write(&fp_path, bad).expect("write bad");
        assert_eq!(
            run(
                &[
                    "fingerprint",
                    "read",
                    "--out-dir",
                    out_s,
                    "--extractor",
                    stamp
                ],
                ""
            ),
            "null\n"
        );
    }
}

#[test]
fn containment_and_bad_inputs_are_handled_safely() {
    let base = scratch("containment");
    let stamp = "aabbccdd11223344";

    // Missing parent directory on read: returns empty/null without creating anything.
    let absent = base.join("missing").join("graft");
    let absent_s = absent.to_str().expect("utf-8");
    assert_eq!(
        run(
            &["cache", "read", "--out-dir", absent_s, "--extractor", stamp],
            ""
        ),
        format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}\n")
    );
    assert_eq!(
        run(
            &[
                "fingerprint",
                "read",
                "--out-dir",
                absent_s,
                "--extractor",
                stamp
            ],
            ""
        ),
        "null\n"
    );
    assert!(!base.join("missing").exists());

    // `.cache` is a file, not a directory.
    let blocked = base.join("blocked");
    fs::create_dir_all(&blocked).expect("mkdir");
    fs::write(blocked.join(".cache"), "not a dir").expect("write");
    let blocked_s = blocked.to_str().expect("utf-8");
    let valid_cache = format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}");
    assert_eq!(
        run(
            &[
                "cache",
                "write",
                "--out-dir",
                blocked_s,
                "--extractor",
                stamp
            ],
            &valid_cache
        ),
        "false\n"
    );
    assert_eq!(
        run(
            &[
                "fingerprint",
                "write",
                "--out-dir",
                blocked_s,
                "--extractor",
                stamp
            ],
            "{}"
        ),
        "false\n"
    );
    assert_eq!(
        run(
            &[
                "cache",
                "read",
                "--out-dir",
                blocked_s,
                "--extractor",
                stamp
            ],
            ""
        ),
        format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}\n")
    );
    assert_eq!(
        run(
            &[
                "fingerprint",
                "read",
                "--out-dir",
                blocked_s,
                "--extractor",
                stamp
            ],
            ""
        ),
        "null\n"
    );

    // Leaf is a directory.
    let dirleaf = base.join("dirleaf");
    fs::create_dir_all(dirleaf.join(".cache").join(format!("extract.{stamp}.json")))
        .expect("mkdir");
    fs::create_dir_all(
        dirleaf
            .join(".cache")
            .join(format!("fingerprint.{stamp}.json")),
    )
    .expect("mkdir");
    let dirleaf_s = dirleaf.to_str().expect("utf-8");
    assert_eq!(
        run(
            &[
                "cache",
                "write",
                "--out-dir",
                dirleaf_s,
                "--extractor",
                stamp
            ],
            &valid_cache
        ),
        "false\n"
    );
    assert_eq!(
        run(
            &[
                "cache",
                "read",
                "--out-dir",
                dirleaf_s,
                "--extractor",
                stamp
            ],
            ""
        ),
        format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}\n")
    );
    assert_eq!(
        run(
            &[
                "fingerprint",
                "read",
                "--out-dir",
                dirleaf_s,
                "--extractor",
                stamp
            ],
            ""
        ),
        "null\n"
    );

    // Trailing `..` escapes base and is refused.
    let esc = base.join("esc");
    fs::create_dir_all(&esc).expect("mkdir");
    let esc_s = esc.join("..").to_string_lossy().into_owned();
    assert_eq!(
        run(
            &["cache", "write", "--out-dir", &esc_s, "--extractor", stamp],
            &valid_cache
        ),
        "false\n"
    );
    assert!(!base.join(".cache").exists());

    // Empty `--out-dir ""` writes under the current directory.
    let empty_cwd = base.join("empty-cwd");
    fs::create_dir_all(&empty_cwd).expect("mkdir");
    let out = exec_in(
        &["fingerprint", "write", "--out-dir", "", "--extractor", stamp],
        b"{}",
        &empty_cwd,
    );
    assert!(out.status.success());
    assert_eq!(String::from_utf8(out.stdout).unwrap(), "true\n");
    assert!(
        empty_cwd
            .join(".cache")
            .join(format!("fingerprint.{stamp}.json"))
            .is_file()
    );

    // Non-object JSON input returns false on write.
    let ok = base.join("ok");
    let ok_s = ok.to_str().expect("utf-8");
    assert_eq!(
        run(
            &["cache", "write", "--out-dir", ok_s, "--extractor", stamp],
            "[]"
        ),
        "false\n"
    );
    assert_eq!(
        run(
            &["cache", "write", "--out-dir", ok_s, "--extractor", stamp],
            "{\"version\":1}"
        ),
        "false\n"
    );
    assert_eq!(
        run(
            &[
                "fingerprint",
                "write",
                "--out-dir",
                ok_s,
                "--extractor",
                stamp
            ],
            "[]"
        ),
        "false\n"
    );

    // Invalid JSON or invalid UTF-8 fails with a non-zero exit.
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
fn symlinks_and_unreadable_entries_are_refused_on_unix() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let base = scratch("unix-links");
    let outside = base.join("outside");
    fs::create_dir_all(&outside).expect("mkdir");
    let stamp = "0011223344556677";
    let valid_cache = format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}");

    // Symlinked outDir and symlinked .cache are refused for write and read.
    let link_out = base.join("graft");
    symlink(&outside, &link_out).expect("link");
    let link_s = link_out.to_str().expect("utf-8");
    assert_eq!(
        run(
            &["cache", "write", "--out-dir", link_s, "--extractor", stamp],
            &valid_cache
        ),
        "false\n"
    );
    assert_eq!(fs::read_dir(&outside).expect("readdir").count(), 0);
    fs::remove_file(&link_out).expect("rm");

    fs::create_dir_all(&link_out).expect("mkdir");
    symlink(&outside, link_out.join(".cache")).expect("link");
    fs::write(outside.join(format!("extract.{stamp}.json")), &valid_cache).expect("write");
    assert_eq!(
        run(
            &["cache", "write", "--out-dir", link_s, "--extractor", stamp],
            &valid_cache
        ),
        "false\n"
    );
    assert_eq!(
        run(
            &["cache", "read", "--out-dir", link_s, "--extractor", stamp],
            ""
        ),
        format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}\n")
    );
    fs::remove_file(link_out.join(".cache")).expect("rm");

    // Symlink leaf is never read through, and write replaces the link without touching target.
    let cache_dir = link_out.join(".cache");
    fs::create_dir_all(&cache_dir).expect("mkdir");
    let victim = outside.join("victim.json");
    fs::write(&victim, &valid_cache).expect("write");
    let leaf = cache_dir.join(format!("extract.{stamp}.json"));
    symlink(&victim, &leaf).expect("link");
    // Symlink leaf is also never deleted by pruneSidecars.
    let link_sidecar = cache_dir.join("extract.link.json");
    symlink(&victim, &link_sidecar).expect("link");
    assert_eq!(
        run(
            &["cache", "read", "--out-dir", link_s, "--extractor", stamp],
            ""
        ),
        format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}\n")
    );
    let fresh = format!(
        "{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{\"a.ts\":{{\"size\":1,\"mtimeMs\":1,\"hash\":\"h\",\"nodes\":[],\"rawEdges\":[]}}}}}}"
    );
    assert_eq!(
        run(
            &["cache", "write", "--out-dir", link_s, "--extractor", stamp],
            &fresh
        ),
        "true\n"
    );
    assert_eq!(fs::read_to_string(&victim).expect("victim"), valid_cache);
    assert!(
        !fs::symlink_metadata(&leaf)
            .expect("lstat")
            .file_type()
            .is_symlink()
    );
    assert!(
        fs::symlink_metadata(&link_sidecar)
            .expect("lstat")
            .file_type()
            .is_symlink(),
        "prune leaves symlinks alone"
    );

    // Unreadable leaf and unreadable .cache return empty without panicking.
    fs::set_permissions(&leaf, fs::Permissions::from_mode(0o000)).expect("chmod");
    assert_eq!(
        run(
            &["cache", "read", "--out-dir", link_s, "--extractor", stamp],
            ""
        ),
        format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}\n")
    );
    fs::set_permissions(&leaf, fs::Permissions::from_mode(0o644)).expect("chmod");
    fs::set_permissions(&cache_dir, fs::Permissions::from_mode(0o000)).expect("chmod");
    assert_eq!(
        run(
            &["cache", "read", "--out-dir", link_s, "--extractor", stamp],
            ""
        ),
        format!("{{\"version\":1,\"extractor\":\"{stamp}\",\"files\":{{}}}}\n")
    );
    fs::set_permissions(&cache_dir, fs::Permissions::from_mode(0o755)).expect("chmod");
}
