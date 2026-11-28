//! Focused edge-case coverage for `embed.rs` and `vectors.rs`.

use std::fs::{self, OpenOptions};
use std::io;
use std::path::Path;

use gg_query::embed::{
    MODEL_ID, SafetensorsEmbedder, f32_to_f16, load_tokenizer, model_available, token_ids,
};
use gg_query::vectors::{
    CACHE_DIR, DenseFile, FuseHit, VECTORS_FILE, VectorFile, VectorIndex, dense_files,
    fuse_by_file, pointer_file, read_vectors,
};
use tempfile::tempdir;

fn write_safetensors(path: &Path, header_json: &[u8], payload: &[u8]) {
    let mut bytes = Vec::with_capacity(8 + header_json.len() + payload.len());
    bytes.extend_from_slice(&(header_json.len() as u64).to_le_bytes());
    bytes.extend_from_slice(header_json);
    bytes.extend_from_slice(payload);
    fs::write(path, bytes).expect("write safetensors");
}

fn valid_tokenizer_json(vocab_json: &str) -> String {
    format!(
        r###"{{"model":{{"type":"WordPiece","continuing_subword_prefix":"##","unk_token":"[UNK]","max_input_chars_per_word":64,"vocab":{vocab_json}}}}}"###
    )
}

fn write_vectors_bin(out_dir: &Path, header_json: &[u8], payload: &[u8]) {
    let cache = out_dir.join(CACHE_DIR);
    fs::create_dir_all(&cache).expect("mkdir .cache");
    let mut bytes = Vec::with_capacity(8 + header_json.len() + payload.len());
    bytes.extend_from_slice(&(header_json.len() as u64).to_le_bytes());
    bytes.extend_from_slice(header_json);
    bytes.extend_from_slice(payload);
    fs::write(cache.join(VECTORS_FILE), bytes).expect("write vectors");
}

#[test]
fn model_available_requires_both_safetensors_and_tokenizer() {
    let tmp = tempdir().expect("tmp");
    assert!(!model_available(tmp.path()));

    fs::write(tmp.path().join("model.safetensors"), b"").expect("sf");
    assert!(!model_available(tmp.path()));

    fs::remove_file(tmp.path().join("model.safetensors")).expect("rm");
    fs::write(tmp.path().join("tokenizer.json"), b"{}").expect("tok");
    assert!(!model_available(tmp.path()));

    fs::write(tmp.path().join("model.safetensors"), b"").expect("sf2");
    assert!(model_available(tmp.path()));
}

#[test]
fn load_tokenizer_rejects_malformed_configs() {
    let tmp = tempdir().expect("tmp");
    let cases = [
        ("{not-json", "tokenizer.json:"),
        ("{}", "missing model"),
        (
            r###"{"model":{"type":"BPE","continuing_subword_prefix":"##"}}"###,
            "unsupported tokenizer",
        ),
        (
            r###"{"model":{"type":"WordPiece","continuing_subword_prefix":"@@"}}"###,
            "unsupported tokenizer",
        ),
        (
            r###"{"model":{"type":"WordPiece","continuing_subword_prefix":"##"}}"###,
            "missing unknown entry",
        ),
        (
            r###"{"model":{"type":"WordPiece","continuing_subword_prefix":"##","unk_token":"[UNK]"}}"###,
            "missing max_input_chars_per_word",
        ),
        (
            r###"{"model":{"type":"WordPiece","continuing_subword_prefix":"##","unk_token":"[UNK]","max_input_chars_per_word":10}}"###,
            "missing vocab",
        ),
        (
            r###"{"model":{"type":"WordPiece","continuing_subword_prefix":"##","unk_token":"[UNK]","max_input_chars_per_word":10,"vocab":{"a":"bad"}}}"###,
            "invalid vocab id",
        ),
        (
            r###"{"model":{"type":"WordPiece","continuing_subword_prefix":"##","unk_token":"[UNK]","max_input_chars_per_word":10,"vocab":{}}}"###,
            "empty vocabulary",
        ),
    ];
    for (body, needle) in cases {
        fs::write(tmp.path().join("tokenizer.json"), body).expect("write");
        let err = load_tokenizer(tmp.path()).expect_err("must reject");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(err.to_string().contains(needle), "got: {err}");
    }
}

#[test]
fn token_ids_supports_absent_unk_token() {
    let tmp = tempdir().expect("tmp");
    fs::write(
        tmp.path().join("tokenizer.json"),
        valid_tokenizer_json(r#"{"alpha":0,"beta":1}"#),
    )
    .expect("write valid");
    let tok = load_tokenizer(tmp.path()).expect("valid without unk in vocab");
    assert!(tok.unk.is_none());
    assert_eq!(tok.max_chars, 512 * 4);
    assert_eq!(token_ids(&tok, "alpha missing beta"), vec![0, 1]);
}

#[test]
fn safetensors_open_rejects_corrupt_headers() {
    let tmp = tempdir().expect("tmp");
    fs::write(
        tmp.path().join("tokenizer.json"),
        valid_tokenizer_json(r#"{"alpha":0,"beta":1}"#),
    )
    .expect("tok");
    let sf = tmp.path().join("model.safetensors");

    fs::write(&sf, b"short").expect("short");
    let e = SafetensorsEmbedder::open(tmp.path(), false)
        .err()
        .expect("short");
    assert!(e.to_string().contains("ends early"));

    let bad_headers: &[(&[u8], &str)] = &[
        (b"{not-json", "not a safetensors file"),
        (b"{}", "expected an F16 'embeddings' table"),
        (
            br#"{"embeddings":{"dtype":"F32","shape":[2,2],"data_offsets":[0,16]}}"#,
            "expected an F16 'embeddings' table",
        ),
        (
            br#"{"embeddings":{"dtype":"F16","shape":[4],"data_offsets":[0,8]}}"#,
            "expected an F16 'embeddings' table",
        ),
    ];
    for (hdr, needle) in bad_headers {
        write_safetensors(&sf, hdr, &[]);
        let err = SafetensorsEmbedder::open(tmp.path(), false)
            .err()
            .expect("must fail");
        assert!(err.to_string().contains(needle), "got: {err}");
    }
}

#[test]
fn safetensors_open_rejects_bad_offsets_and_overflows() {
    let tmp = tempdir().expect("tmp");
    fs::write(
        tmp.path().join("tokenizer.json"),
        valid_tokenizer_json(r#"{"alpha":0,"beta":1}"#),
    )
    .expect("tok");
    let sf = tmp.path().join("model.safetensors");
    let bad_headers: &[(&[u8], &str)] = &[
        (
            br#"{"embeddings":{"dtype":"F16","shape":[2,0],"data_offsets":[0,0]}}"#,
            "bad table shape or offsets",
        ),
        (
            br#"{"embeddings":{"dtype":"F16","shape":[2,2],"data_offsets":[8,0]}}"#,
            "bad table shape or offsets",
        ),
        (
            br#"{"embeddings":{"dtype":"F16","shape":[9223372036854775808,2],"data_offsets":[0,0]}}"#,
            "bad table shape or offsets",
        ),
        (
            br#"{"embeddings":{"dtype":"F16","shape":[2,1],"data_offsets":[18446744073709551615,18446744073709551615]}}"#,
            "runs past the file",
        ),
    ];
    for (hdr, needle) in bad_headers {
        write_safetensors(&sf, hdr, &[]);
        let err = SafetensorsEmbedder::open(tmp.path(), false)
            .err()
            .expect("must fail");
        assert!(err.to_string().contains(needle), "got: {err}");
    }
}

#[test]
fn safetensors_tokenizer_getter_and_post_open_truncation_error() {
    let tmp = tempdir().expect("tmp");
    fs::write(
        tmp.path().join("tokenizer.json"),
        valid_tokenizer_json(r#"{"alpha":0,"beta":1}"#),
    )
    .expect("tok");
    let sf = tmp.path().join("model.safetensors");
    let vals = f32_to_f16(&[1.0, 0.0, 0.0, 1.0]);
    let payload: Vec<u8> = vals.iter().flat_map(|v| v.to_le_bytes()).collect();
    write_safetensors(
        &sf,
        br#"{"embeddings":{"dtype":"F16","shape":[2,2],"data_offsets":[0,8]}}"#,
        &payload,
    );

    let mut emb = SafetensorsEmbedder::open(tmp.path(), false).expect("open");
    assert_eq!(emb.dim(), 2);
    assert_eq!(emb.tokenizer().vocab.get("alpha"), Some(&0));
    assert_eq!(emb.embed("alpha").expect("embed"), vec![1.0, 0.0]);

    OpenOptions::new()
        .write(true)
        .open(&sf)
        .expect("reopen")
        .set_len(0)
        .expect("truncate");
    let err = emb
        .embed("beta")
        .expect_err("truncated file must fail on demand");
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(err.to_string().contains("ends early"));
}

#[test]
fn read_vectors_handles_missing_open_errors_and_malformed_sidecars() {
    let tmp = tempdir().expect("tmp");
    assert!(read_vectors(tmp.path()).expect("missing").is_none());

    let cache = tmp.path().join(CACHE_DIR);
    fs::create_dir_all(&cache).expect("mkdir");
    fs::write(cache.join(VECTORS_FILE), b"tiny").expect("tiny");
    assert!(read_vectors(tmp.path()).expect("tiny").is_none());

    write_vectors_bin(tmp.path(), b"{bad-json", &[]);
    assert!(read_vectors(tmp.path()).expect("bad json").is_none());

    let overflow_hdr = format!(
        r#"{{"version":1,"model":"{MODEL_ID}","chunk":750,"dim":{},"files":[{{"path":"a.rs","hash":"h","lines":[1,2]}}]}}"#,
        usize::MAX
    );
    write_vectors_bin(tmp.path(), overflow_hdr.as_bytes(), &[]);
    assert!(read_vectors(tmp.path()).expect("overflow").is_none());

    let mismatch_hdr = format!(
        r#"{{"version":1,"model":"{MODEL_ID}","chunk":750,"dim":2,"files":[{{"path":"a.rs","hash":"h","lines":[1,2]}}]}}"#
    );
    write_vectors_bin(tmp.path(), mismatch_hdr.as_bytes(), &[0, 0]);
    assert!(read_vectors(tmp.path()).expect("mismatch").is_none());

    let err_dir = tempdir().expect("err_dir");
    #[cfg(unix)]
    fs::write(err_dir.path().join(CACHE_DIR), b"not a dir").expect("file");
    #[cfg(windows)]
    fs::create_dir_all(err_dir.path().join(CACHE_DIR).join(VECTORS_FILE)).expect("dir");
    assert!(read_vectors(err_dir.path()).is_err());
}

#[test]
fn dense_files_rejects_invalid_queries_and_ranks_multi_chunk_ties() {
    let data = f32_to_f16(&[1.0, 0.0, 0.5, 0.0, 0.0, 1.0, 1.0, 0.0]);
    let idx = VectorIndex {
        model: MODEL_ID.to_string(),
        dim: 2,
        files: vec![
            VectorFile {
                path: "z.rs".into(),
                hash: "h1".into(),
                lines: vec![1, 5, 6, 10],
            },
            VectorFile {
                path: "zero.rs".into(),
                hash: "h2".into(),
                lines: vec![1, 3],
            },
            VectorFile {
                path: "a.rs".into(),
                hash: "h3".into(),
                lines: vec![1, 4],
            },
        ],
        data,
    };

    assert!(dense_files(&idx, &[1.0], |_| true).is_empty());
    assert!(dense_files(&idx, &[f32::NAN, 1.0], |_| true).is_empty());
    assert!(dense_files(&idx, &[0.0, 0.0], |_| true).is_empty());

    let hits = dense_files(&idx, &[1.0, 0.0], |_| true);
    let paths: Vec<&str> = hits.iter().map(|h| h.path.as_str()).collect();
    assert_eq!(paths, vec!["a.rs", "z.rs"]);
    assert_eq!((hits[1].start, hits[1].end), (1, 5));
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
fn pointer_file_and_fuse_by_file_tie_break_equal_dense_scores() {
    assert_eq!(pointer_file("src/a.rs:L10-L20"), "src/a.rs");
    assert_eq!(pointer_file("src/a.rs:L10"), "src/a.rs");
    assert_eq!(pointer_file("src/a.rs:Lfoo"), "src/a.rs:Lfoo");
    assert_eq!(pointer_file("src/a.rs:L10-Lfoo"), "src/a.rs:L10-Lfoo");

    let mut dense: Vec<DenseFile> = (0..132)
        .map(|i| DenseFile {
            path: format!("f{i:03}.rs"),
            score: 1.0,
            start: 1,
            end: 2,
        })
        .collect();
    // 1/(60+3+1) == 1/64 == 1/(60+35+1) + 1/(60+131+1) == 1/96 + 1/192 in IEEE-754 f64.
    dense[3].path = "z_tie.rs".into();
    dense[35].path = "a_tie.rs".into();
    dense[131].path = "a_tie.rs".into();

    let fused = fuse_by_file(&[] as &[SimpleHit], &dense, 10, |d| SimpleHit {
        pointer: format!("{}:L{}-L{}", d.path, d.start, d.end),
        concept: false,
    });
    let pos_a = fused
        .iter()
        .position(|h| h.pointer.starts_with("a_tie.rs:"))
        .expect("a_tie present");
    let pos_z = fused
        .iter()
        .position(|h| h.pointer.starts_with("z_tie.rs:"))
        .expect("z_tie present");
    assert!(
        pos_a < pos_z,
        "lexicographical tie-break must order a_tie before z_tie"
    );
}
