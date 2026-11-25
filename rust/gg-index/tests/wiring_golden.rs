//! `wiring.json` bytes against goldens recorded from the TypeScript writer.
//!
//! Each `tests/fixtures/wiring/<name>.wiring.json` is what `writeGraph`
//! (src/graph/write.ts) wrote for `<name>.json`; regenerate them with
//! `npx tsx rust/gg-index/parity/wiring-parity.ts --record rust/gg-index/tests/fixtures/wiring`.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn fixtures() -> Vec<(PathBuf, PathBuf)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/wiring");
    let mut cases: Vec<_> = fs::read_dir(&dir)
        .expect("fixture dir")
        .map(|e| e.expect("entry").path())
        .filter(|p| {
            let name = p.file_name().unwrap().to_string_lossy();
            name.ends_with(".json") && !name.ends_with(".wiring.json")
        })
        .map(|p| {
            let golden = p.with_extension("wiring.json");
            (p, golden)
        })
        .collect();
    cases.sort();
    assert!(cases.len() >= 5, "fixtures missing from {}", dir.display());
    cases
}

#[test]
fn library_matches_typescript_goldens() {
    for (input, golden) in fixtures() {
        let text = fs::read_to_string(&input).expect("input");
        let got = gg_index::wiring::wiring_from_text(&text).expect("wiring");
        let want = fs::read(&golden).expect("golden");
        assert!(
            got.as_bytes() == want,
            "{} differs from its golden",
            input.display()
        );
    }
}

#[test]
fn binary_prints_the_golden_bytes() {
    for (input, golden) in fixtures() {
        let out = Command::new(env!("CARGO_BIN_EXE_gg-index"))
            .arg("wiring")
            .arg(&input)
            .output()
            .expect("run gg-index");
        assert!(
            out.status.success(),
            "{}: {}",
            input.display(),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(
            out.stdout == fs::read(&golden).expect("golden"),
            "{} differs",
            input.display()
        );
    }
}

#[test]
fn binary_refuses_bad_input_and_usage() {
    let bin = env!("CARGO_BIN_EXE_gg-index");
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("bad-input");
    fs::create_dir_all(&dir).unwrap();
    let bad = dir.join("bad.json");
    fs::write(&bad, "{\"nodes\":[{\"id\":1}],\"edges\":[]}").unwrap();
    let out = Command::new(bin).arg("wiring").arg(&bad).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("string `id`"));
    let out = Command::new(bin).arg("wiring").output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    let out = Command::new(bin)
        .arg("wiring")
        .arg(dir.join("missing.json"))
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn binary_writes_a_graph_nested_to_the_cap() {
    // A free-form field nested to the cap: TypeScript overflows near depth 4,000; Rust must
    // not overflow below its cap on any platform, debug builds included.
    let depth = gg_index::json::MAX_DEPTH - 2;
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("deep-input");
    fs::create_dir_all(&dir).unwrap();
    let input = dir.join("deep.json");
    let field = format!("{}{}", "[".repeat(depth), "]".repeat(depth));
    fs::write(
        &input,
        format!("{{\"nodes\":[{{\"id\":\"a\",\"x\":{field}}}],\"edges\":[]}}"),
    )
    .unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_gg-index"))
        .arg("wiring")
        .arg(&input)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.ends_with("  \"edges\": []\n}\n"));
    assert_eq!(text.matches('[').count(), depth + 2);
    fs::remove_dir_all(&dir).unwrap();
}
