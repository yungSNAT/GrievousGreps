//! Native F16 Model2Vec embedder parity against `test/fixtures/ask-embed/model2vec.json`.
//!
//! Mirrors `test/ask-embed.test.ts`: asserts exact token IDs, float16 vector
//! agreement (< 2e-3) in both on-demand row-seek and whole-table modes,
//! complete 65,536 float16 round-trip, code-point truncation, malformed model
//! and sidecar rejection, and Reciprocal Rank Fusion (`fuse_by_file`).

use std::fs;
use std::path::PathBuf;

use gg_query::embed::{
    MODEL_ID, SafetensorsEmbedder, f16_table, f32_to_f16, load_tokenizer, token_ids,
};
use gg_query::vectors::{
    CACHE_DIR, DenseFile, FuseHit, VECTORS_FILE, fuse_by_file, pointer_file, read_vectors,
};
use serde::Deserialize;
use tempfile::tempdir;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn model_dir() -> PathBuf {
    repo_root().join("models").join("potion-code-16M-v2")
}

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<FixtureCase>,
}

#[derive(Deserialize)]
struct FixtureCase {
    text: String,
    ids: Vec<usize>,
    vector: Vec<f32>,
}

fn load_fixture() -> Fixture {
    let path = repo_root()
        .join("test")
        .join("fixtures")
        .join("ask-embed")
        .join("model2vec.json");
    let raw = fs::read_to_string(&path).expect("model2vec.json fixture must exist");
    serde_json::from_str(&raw).expect("valid model2vec.json")
}

#[test]
fn token_ids_match_model2vec_for_every_fixture_string() {
    let tok = load_tokenizer(&model_dir()).expect("load tokenizer");
    let fixture = load_fixture();
    assert_eq!(fixture.cases.len(), 18);
    for (idx, c) in fixture.cases.iter().enumerate() {
        let got = token_ids(&tok, &c.text);
        assert_eq!(
            got,
            c.ids,
            "case {idx} token id mismatch for {:?}",
            c.text.chars().take(40).collect::<String>()
        );
    }
}

#[test]
fn vectors_match_model2vec_in_on_demand_and_whole_modes() {
    let fixture = load_fixture();
    for whole in [false, true] {
        let mut emb = SafetensorsEmbedder::open(&model_dir(), whole).expect("open embedder");
        for (idx, c) in fixture.cases.iter().enumerate() {
            let v = emb.embed(&c.text).expect("embed");
            assert_eq!(v.len(), c.vector.len(), "case {idx} dim mismatch");
            let worst = c
                .vector
                .iter()
                .zip(v.iter())
                .map(|(a, b)| (a - b).abs())
                .fold(0.0_f32, f32::max);
            assert!(
                worst < 2e-3,
                "case {idx} (whole={whole}) off by {worst} for {:?}",
                c.text.chars().take(40).collect::<String>()
            );
        }
    }
}

#[test]
fn float16_round_trips_every_finite_value() {
    let table = f16_table();
    let finite: Vec<u16> = (0_u16..=u16::MAX)
        .filter(|&h| ((h >> 10) & 0x1f) != 31)
        .collect();
    let floats: Vec<f32> = finite.iter().map(|&h| table[h as usize]).collect();
    assert_eq!(f32_to_f16(&floats), finite);

    let ties_and_sat = f32_to_f16(&[
        1.0 + 2.0_f32.powi(-11),
        1.0 + 3.0 * 2.0_f32.powi(-11),
        70_000.0,
        -70_000.0,
    ]);
    assert_eq!(ties_and_sat, vec![0x3c00, 0x3c02, 0x7c00, 0xfc00]);
}

fn make_safetensors(rows: usize, dim: usize, data_bytes: usize) -> Vec<u8> {
    let header = serde_json::json!({
        "embeddings": {
            "dtype": "F16",
            "shape": [rows, dim],
            "data_offsets": [0, rows * dim * 2]
        }
    })
    .to_string();
    let mut out = Vec::with_capacity(8 + header.len() + data_bytes);
    out.extend_from_slice(&(header.len() as u64).to_le_bytes());
    out.extend_from_slice(header.as_bytes());
    out.resize(8 + header.len() + data_bytes, 0x3c);
    out
}

#[test]
fn truncated_short_or_corrupt_model_is_rejected() {
    let cases = [
        ("truncated after header", make_safetensors(63457, 256, 1000)),
        (
            "fewer rows than vocab",
            make_safetensors(100, 256, 100 * 256 * 2),
        ),
        (
            "plain text",
            b"this is not a model file at all, just text\n".repeat(4),
        ),
    ];
    for (label, bytes) in cases {
        let dir = tempdir().expect("tempdir");
        fs::copy(
            model_dir().join("tokenizer.json"),
            dir.path().join("tokenizer.json"),
        )
        .expect("copy tokenizer");
        fs::write(dir.path().join("model.safetensors"), &bytes).expect("write model");
        for whole in [false, true] {
            let err = SafetensorsEmbedder::open(dir.path(), whole)
                .err()
                .unwrap_or_else(|| panic!("{label} (whole={whole}) should fail"));
            assert!(
                err.to_string().contains("model.safetensors"),
                "{label}: unexpected error {err}"
            );
        }
    }
}

#[test]
fn corrupt_ask_vectors_header_overflow_and_odd_lines_return_none() {
    let dir = tempdir().expect("tempdir");
    let cache = dir.path().join(CACHE_DIR);
    fs::create_dir_all(&cache).expect("mkdir");
    let bin = cache.join(VECTORS_FILE);

    // header_len = u64::MAX must never overflow `8 + header_len` or panic.
    let mut overflow = Vec::new();
    overflow.extend_from_slice(&u64::MAX.to_le_bytes());
    overflow.extend_from_slice(b"{}");
    fs::write(&bin, &overflow).expect("write overflow");
    assert!(read_vectors(dir.path()).expect("read").is_none());

    // Odd lines array must be rejected as malformed.
    let odd_header = serde_json::json!({
        "version": 1,
        "model": MODEL_ID,
        "chunk": 750,
        "dim": 4,
        "files": [{"path": "src/a.ts", "hash": "abc", "lines": [1, 2, 3]}]
    })
    .to_string();
    let mut odd = Vec::new();
    odd.extend_from_slice(&(odd_header.len() as u64).to_le_bytes());
    odd.extend_from_slice(odd_header.as_bytes());
    odd.extend_from_slice(&[0_u8; 8]);
    fs::write(&bin, &odd).expect("write odd");
    assert!(read_vectors(dir.path()).expect("read").is_none());
}

#[test]
fn text_is_cut_by_code_points() {
    let tok = load_tokenizer(&model_dir()).expect("load tokenizer");
    let text = format!("{} file", "😀".repeat(tok.max_chars / 2));
    let expected = vec![*tok.vocab.get("file").expect("file in vocab")];
    assert_eq!(token_ids(&tok, &text), expected);
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SimpleHit {
    pointer: String,
    concept: bool,
}

impl FuseHit for SimpleHit {
    fn pointer(&self) -> &str {
        &self.pointer
    }

    fn is_concept(&self) -> bool {
        self.concept
    }
}

#[test]
fn fuse_by_file_preserves_rrf_order_and_concept_slots() {
    assert_eq!(pointer_file("src/a.ts:L10-L20"), "src/a.ts");
    assert_eq!(pointer_file("src/a.ts:L10"), "src/a.ts");
    assert_eq!(pointer_file("src/a.ts"), "src/a.ts");

    let lex = vec![
        SimpleHit {
            pointer: "concept/arch".to_string(),
            concept: true,
        },
        SimpleHit {
            pointer: "src/a.ts:L1-L5".to_string(),
            concept: false,
        },
        SimpleHit {
            pointer: "src/b.ts:L2-L8".to_string(),
            concept: false,
        },
    ];
    let dense = vec![
        DenseFile {
            path: "src/b.ts".to_string(),
            score: 0.9,
            start: 1,
            end: 10,
        },
        DenseFile {
            path: "src/c.ts".to_string(),
            score: 0.8,
            start: 3,
            end: 9,
        },
    ];
    let fused = fuse_by_file(&lex, &dense, 5, |d| SimpleHit {
        pointer: format!("{}:L{}-L{}", d.path, d.start, d.end),
        concept: false,
    });
    assert_eq!(fused[0].pointer, "concept/arch");
    assert_eq!(fused[1].pointer, "src/b.ts:L2-L8");
    assert_eq!(fused[2].pointer, "src/a.ts:L1-L5");
    assert_eq!(fused[3].pointer, "src/c.ts:L3-L9");
}
