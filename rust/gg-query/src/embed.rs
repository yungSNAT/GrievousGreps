//! Native F16 safetensors Model2Vec embedder (`potion-code-16M-v2`).
//!
//! Reproduces `src/ask/embed.ts` (and model2vec 0.10.0 `encode`): BERT
//! normalisation and pre-tokenisation, WordPiece, unknown tokens dropped,
//! capped at 512 tokens after slicing the input to `512 * floor(median_token_len)`
//! Unicode scalar values, mean pooling in float32 over float16 rows and
//! L2 normalisation.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::OnceLock;

use serde::Deserialize;
use unicode_general_category::{GeneralCategory, get_general_category};
use unicode_normalization::UnicodeNormalization;

pub const MODEL_ID: &str = "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b";
const MAX_TOKENS: usize = 512;

/// IEEE-754 half-precision bit pattern to float32 lookup table (all 65,536 entries).
pub fn f16_table() -> &'static [f32; 65536] {
    static TABLE: OnceLock<Box<[f32; 65536]>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = Box::new([0.0_f32; 65536]);
        for (h, slot) in table.iter_mut().enumerate() {
            let sign: f32 = if (h & 0x8000) != 0 { -1.0 } else { 1.0 };
            let exp = (h >> 10) & 0x1f;
            let frac = (h & 0x3ff) as f32;
            *slot = if exp == 0 {
                sign * 2.0_f32.powi(-14) * (frac / 1024.0)
            } else if exp == 31 {
                if (h & 0x3ff) != 0 {
                    f32::NAN
                } else {
                    sign * f32::INFINITY
                }
            } else {
                sign * 2.0_f32.powi(exp as i32 - 15) * (1.0 + frac / 1024.0)
            };
        }
        table
    })
}

#[inline]
fn round_shift(v: u32, s: u32) -> u32 {
    let q = v >> s;
    let rest = v & ((1_u32 << s) - 1);
    let half = 1_u32 << (s - 1);
    if rest > half || (rest == half && (q & 1) != 0) {
        q + 1
    } else {
        q
    }
}

/// Convert one float32 to the nearest IEEE-754 float16 bit pattern (ties to even).
pub fn to_half(x: f32) -> u16 {
    let bits = x.to_bits();
    let sign = (bits >> 16) & 0x8000;
    let exp = ((bits >> 23) & 0xff) as i32 - 112;
    let mant = bits & 0x7f_ffff;
    if exp >= 31 {
        let nan_bit = if exp == 143 && mant != 0 { 0x200 } else { 0 };
        return (sign | 0x7c00 | nan_bit) as u16;
    }
    if exp <= 0 {
        if exp < -10 {
            return sign as u16;
        }
        return (sign | round_shift(mant | 0x80_0000, (14 - exp) as u32)) as u16;
    }
    (sign | round_shift(((exp as u32) << 23) | mant, 13)) as u16
}

pub fn f32_to_f16(values: &[f32]) -> Vec<u16> {
    values.iter().copied().map(to_half).collect()
}

#[derive(Debug, Clone)]
pub struct Tokenizer {
    pub vocab: HashMap<String, usize>,
    pub unk: Option<usize>,
    pub max_word_chars: usize,
    pub max_chars: usize,
}

pub fn model_available(dir: &Path) -> bool {
    dir.join("model.safetensors").is_file() && dir.join("tokenizer.json").is_file()
}

pub fn load_tokenizer(dir: &Path) -> io::Result<Tokenizer> {
    let text = std::fs::read_to_string(dir.join("tokenizer.json"))?;
    let raw: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("tokenizer.json: {e}")))?;
    let model = raw
        .get("model")
        .ok_or_else(|| invalid("tokenizer.json: missing model"))?;
    let kind = model
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let prefix = model
        .get("continuing_subword_prefix")
        .and_then(serde_json::Value::as_str);
    if kind != "WordPiece" || prefix != Some("##") {
        return Err(invalid(format!(
            "unsupported tokenizer in {}: {kind}",
            dir.display()
        )));
    }
    let unk_field = ["unk", "token"].join("_");
    let unk_label = model
        .get(&unk_field)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| invalid("tokenizer.json: missing unknown entry"))?;
    let max_word_chars = model
        .get("max_input_chars_per_word")
        .and_then(serde_json::Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| invalid("tokenizer.json: missing max_input_chars_per_word"))?;
    let vocab_obj = model
        .get("vocab")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| invalid("tokenizer.json: missing vocab"))?;
    let mut vocab = HashMap::with_capacity(vocab_obj.len());
    for (k, v) in vocab_obj {
        let id = v
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| invalid("tokenizer.json: invalid vocab id"))?;
        vocab.insert(k.clone(), id);
    }
    if vocab.is_empty() {
        return Err(invalid("tokenizer.json: empty vocabulary"));
    }
    // JavaScript String.length counts UTF-16 code units; match median length exactly.
    let mut lengths: Vec<usize> = vocab.keys().map(|k| k.encode_utf16().count()).collect();
    lengths.sort_unstable();
    let mid = lengths.len() / 2;
    let median = if lengths.len() % 2 == 1 {
        lengths[mid]
    } else if mid > 0 {
        (lengths[mid - 1] + lengths[mid]) / 2
    } else {
        0
    };
    let unk = vocab.get(unk_label).copied();
    Ok(Tokenizer {
        vocab,
        unk,
        max_word_chars,
        max_chars: MAX_TOKENS * median,
    })
}

#[inline]
fn is_cjk(cp: u32) -> bool {
    (0x4e00..=0x9fff).contains(&cp)
        || (0x3400..=0x4dbf).contains(&cp)
        || (0x20000..=0x2a6df).contains(&cp)
        || (0x2a700..=0x2b73f).contains(&cp)
        || (0x2b740..=0x2b81f).contains(&cp)
        || (0x2b920..=0x2ceaf).contains(&cp)
        || (0xf900..=0xfaff).contains(&cp)
        || (0x2f800..=0x2fa1f).contains(&cp)
}

#[inline]
fn is_control(ch: char) -> bool {
    matches!(
        get_general_category(ch),
        GeneralCategory::Control
            | GeneralCategory::Format
            | GeneralCategory::Surrogate
            | GeneralCategory::PrivateUse
            | GeneralCategory::Unassigned
    )
}

#[inline]
fn is_nonspacing_mark(ch: char) -> bool {
    get_general_category(ch) == GeneralCategory::NonspacingMark
}

#[inline]
fn is_bert_punct(ch: char) -> bool {
    let cp = ch as u32;
    if (0x21..=0x2f).contains(&cp)
        || (0x3a..=0x40).contains(&cp)
        || (0x5b..=0x60).contains(&cp)
        || (0x7b..=0x7e).contains(&cp)
    {
        return true;
    }
    matches!(
        get_general_category(ch),
        GeneralCategory::ConnectorPunctuation
            | GeneralCategory::DashPunctuation
            | GeneralCategory::OpenPunctuation
            | GeneralCategory::ClosePunctuation
            | GeneralCategory::InitialPunctuation
            | GeneralCategory::FinalPunctuation
            | GeneralCategory::OtherPunctuation
    )
}

/// BertNormalizer + BertPreTokenizer matching `src/ask/embed.ts::preTokenize`.
pub fn pre_tokenize(text: &str) -> Vec<String> {
    let mut clean = String::with_capacity(text.len());
    for ch in text.chars() {
        let cp = ch as u32;
        if cp == 0 || cp == 0xfffd || (is_control(ch) && ch != '\t' && ch != '\n' && ch != '\r') {
            continue;
        }
        if ch.is_whitespace() {
            clean.push(' ');
        } else if is_cjk(cp) {
            clean.push(' ');
            clean.push(ch);
            clean.push(' ');
        } else {
            clean.push(ch);
        }
    }

    let mut words = Vec::new();
    let mut word = String::new();
    for ch in clean.nfd() {
        if is_nonspacing_mark(ch) {
            continue;
        }
        for low in ch.to_lowercase() {
            if low.is_whitespace() {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
            } else if is_bert_punct(low) {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
                words.push(low.to_string());
            } else {
                word.push(low);
            }
        }
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

fn word_pieces(tok: &Tokenizer, word: &str) -> Vec<usize> {
    let chars: Vec<char> = word.chars().collect();
    if chars.len() > tok.max_word_chars {
        return tok.unk.into_iter().collect();
    }
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut buf = String::new();
    while start < chars.len() {
        let mut end = chars.len();
        let mut found = None;
        while end > start {
            buf.clear();
            if start > 0 {
                buf.push_str("##");
            }
            for &c in &chars[start..end] {
                buf.push(c);
            }
            if let Some(&id) = tok.vocab.get(&buf) {
                found = Some(id);
                break;
            }
            end -= 1;
        }
        let Some(id) = found else {
            return tok.unk.into_iter().collect();
        };
        pieces.push(id);
        start = end;
    }
    pieces
}

/// Token IDs matching `src/ask/embed.ts::tokenIds` (cut by code points, max 512, unk dropped).
pub fn token_ids(tok: &Tokenizer, text: &str) -> Vec<usize> {
    let cut: String;
    let slice = if text.len() > tok.max_chars {
        cut = text.chars().take(tok.max_chars).collect();
        cut.as_str()
    } else {
        text
    };
    let mut ids = Vec::new();
    for word in pre_tokenize(slice) {
        for id in word_pieces(tok, &word) {
            ids.push(id);
            if ids.len() == MAX_TOKENS {
                break;
            }
        }
        if ids.len() == MAX_TOKENS {
            break;
        }
    }
    if let Some(unk) = tok.unk {
        ids.retain(|&id| id != unk);
    }
    ids
}

#[derive(Deserialize)]
struct SafetensorsHeader {
    embeddings: Option<TensorMeta>,
}

#[derive(Deserialize)]
struct TensorMeta {
    dtype: String,
    shape: Vec<usize>,
    data_offsets: Vec<u64>,
}

struct TableMeta {
    rows: usize,
    dim: usize,
    offset: u64,
}

fn invalid(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.into())
}

fn read_table(file: &mut File, vocab_rows: usize) -> io::Result<TableMeta> {
    let size = file.metadata()?.len();
    let mut len_buf = [0_u8; 8];
    file.read_exact(&mut len_buf)
        .map_err(|_| invalid("model.safetensors: the file ends early"))?;
    let header_len_u64 = u64::from_le_bytes(len_buf);
    if size < 8 || header_len_u64 > size - 8 {
        return Err(invalid("model.safetensors: not a safetensors file"));
    }
    let header_len = usize::try_from(header_len_u64)
        .map_err(|_| invalid("model.safetensors: not a safetensors file"))?;
    let mut header_bytes = vec![0_u8; header_len];
    file.read_exact(&mut header_bytes)
        .map_err(|_| invalid("model.safetensors: the file ends early"))?;
    let parsed: SafetensorsHeader = serde_json::from_slice(&header_bytes)
        .map_err(|_| invalid("model.safetensors: not a safetensors file"))?;
    let Some(t) = parsed.embeddings else {
        return Err(invalid(
            "model.safetensors: expected an F16 'embeddings' table",
        ));
    };
    if t.dtype != "F16" || t.shape.len() != 2 {
        return Err(invalid(
            "model.safetensors: expected an F16 'embeddings' table",
        ));
    }
    let (rows, dim) = (t.shape[0], t.shape[1]);
    if t.data_offsets.len() != 2 || dim == 0 || t.data_offsets[1] < t.data_offsets[0] {
        return Err(invalid("model.safetensors: a bad table shape or offsets"));
    }
    let (start, end) = (t.data_offsets[0], t.data_offsets[1]);
    let expected = (rows as u64)
        .checked_mul(dim as u64)
        .and_then(|n| n.checked_mul(2))
        .ok_or_else(|| invalid("model.safetensors: a bad table shape or offsets"))?;
    let offset = 8_u64
        .checked_add(header_len_u64)
        .and_then(|n| n.checked_add(start))
        .ok_or_else(|| invalid("model.safetensors: the table runs past the file"))?;
    if end - start != expected || offset.saturating_add(expected) > size {
        return Err(invalid("model.safetensors: the table runs past the file"));
    }
    if rows < vocab_rows {
        return Err(invalid(format!(
            "model.safetensors: {rows} rows for a vocabulary of {vocab_rows}"
        )));
    }
    Ok(TableMeta { rows, dim, offset })
}

pub struct SafetensorsEmbedder {
    tok: Tokenizer,
    file: File,
    table: TableMeta,
    whole: Option<Vec<u16>>,
    row_buf: Vec<u8>,
}

impl SafetensorsEmbedder {
    pub fn open(dir: &Path, whole: bool) -> io::Result<Self> {
        let tok = load_tokenizer(dir)?;
        let vocab_rows = tok
            .vocab
            .values()
            .copied()
            .max()
            .ok_or_else(|| invalid("tokenizer.json: empty vocabulary"))?
            .checked_add(1)
            .ok_or_else(|| invalid("tokenizer.json: vocab id overflow"))?;
        let mut file = File::open(dir.join("model.safetensors"))?;
        let table = read_table(&mut file, vocab_rows)?;
        let row_bytes = table
            .dim
            .checked_mul(2)
            .ok_or_else(|| invalid("model.safetensors: row size overflow"))?;
        let whole_data = if whole {
            let byte_len = table
                .rows
                .checked_mul(row_bytes)
                .ok_or_else(|| invalid("model.safetensors: table size overflow"))?;
            let mut raw = vec![0_u8; byte_len];
            file.seek(SeekFrom::Start(table.offset))?;
            file.read_exact(&mut raw)
                .map_err(|_| invalid("model.safetensors: the file ends early"))?;
            let f16 = f16_table();
            let values: Vec<u16> = raw
                .as_chunks::<2>()
                .0
                .iter()
                .map(|&c| u16::from_le_bytes(c))
                .collect();
            if values.iter().any(|&b| !f16[b as usize].is_finite()) {
                return Err(invalid("model.safetensors: non-finite embedding value"));
            }
            Some(values)
        } else {
            None
        };
        let row_buf = vec![0_u8; row_bytes];
        Ok(Self {
            tok,
            file,
            table,
            whole: whole_data,
            row_buf,
        })
    }

    pub fn dim(&self) -> usize {
        self.table.dim
    }

    pub fn tokenizer(&self) -> &Tokenizer {
        &self.tok
    }

    pub fn embed(&mut self, text: &str) -> io::Result<Vec<f32>> {
        let dim = self.table.dim;
        let f16 = f16_table();
        let mut out = vec![0.0_f32; dim];
        let ids = token_ids(&self.tok, text);
        for id in ids {
            if let Some(ref all) = self.whole {
                let base = id * dim;
                for (slot, &bits) in out.iter_mut().zip(&all[base..base + dim]) {
                    *slot += f16[bits as usize];
                }
            } else {
                let pos = self.table.offset + (id as u64) * (dim as u64) * 2;
                self.file.seek(SeekFrom::Start(pos))?;
                self.file
                    .read_exact(&mut self.row_buf)
                    .map_err(|_| invalid("model.safetensors: the file ends early"))?;
                for (slot, &pair) in out.iter_mut().zip(self.row_buf.as_chunks::<2>().0) {
                    let bits = u16::from_le_bytes(pair);
                    let v = f16[bits as usize];
                    if !v.is_finite() {
                        return Err(invalid("model.safetensors: non-finite embedding value"));
                    }
                    *slot += v;
                }
            }
        }
        let norm: f32 = out.iter().map(|&v| v * v).sum::<f32>().sqrt();
        if norm > 0.0 {
            for slot in &mut out {
                *slot /= norm;
            }
        }
        Ok(out)
    }
}
