//! Unicode-aware identifier + prose tokenizer and `.cache/ask-index.json` reader.
//!
//! Mirrors `src/ask/index-file.ts`: NFC normalization, `\p{Ll}|\p{N}` → `\p{Lu}`
//! camelCase splitting, lowercase fold, non-`\p{L}\p{N}\p{M}` word boundaries,
//! stop-word filtering, and CJK character bigrams.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use unicode_general_category::{GeneralCategory, get_general_category};
use unicode_normalization::UnicodeNormalization;

use crate::vectors::CACHE_DIR;

pub const ASK_INDEX_FILE: &str = "ask-index.json";

const STOP_WORDS: &[&str] = &[
    "a", "an", "and", "are", "can", "do", "does", "for", "get", "how", "i", "in", "is", "it", "of",
    "on", "or", "set", "that", "the", "this", "to", "use", "used", "using", "we", "what", "when",
    "where", "which", "why", "with",
];

fn is_stop_word(term: &str) -> bool {
    STOP_WORDS.binary_search(&term).is_ok()
}

fn is_lower_or_num(ch: char) -> bool {
    matches!(
        get_general_category(ch),
        GeneralCategory::LowercaseLetter
            | GeneralCategory::DecimalNumber
            | GeneralCategory::LetterNumber
            | GeneralCategory::OtherNumber
    )
}

fn is_upper(ch: char) -> bool {
    matches!(get_general_category(ch), GeneralCategory::UppercaseLetter)
}

fn is_token_char(ch: char) -> bool {
    matches!(
        get_general_category(ch),
        GeneralCategory::UppercaseLetter
            | GeneralCategory::LowercaseLetter
            | GeneralCategory::TitlecaseLetter
            | GeneralCategory::ModifierLetter
            | GeneralCategory::OtherLetter
            | GeneralCategory::DecimalNumber
            | GeneralCategory::LetterNumber
            | GeneralCategory::OtherNumber
            | GeneralCategory::NonspacingMark
            | GeneralCategory::SpacingMark
            | GeneralCategory::EnclosingMark
    )
}

fn is_cjk(ch: char) -> bool {
    let cp = ch as u32;
    matches!(
        cp,
        // Han (CJK Unified, Extensions A-H, Compatibility, Radicals, Ideographic numbers)
        0x2E80..=0x2EFF
            | 0x2F00..=0x2FDF
            | 0x3005
            | 0x3007
            | 0x3021..=0x3029
            | 0x3038..=0x303B
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0x20000..=0x2A6DF
            | 0x2A700..=0x2B73F
            | 0x2B740..=0x2B81F
            | 0x2B820..=0x2CEAF
            | 0x2CEB0..=0x2EBEF
            | 0x2F800..=0x2FA1F
            | 0x30000..=0x323AF
            // Hiragana
            | 0x3041..=0x3096
            | 0x309D..=0x309F
            | 0x1B001..=0x1B11F
            | 0x1B132
            | 0x1B150..=0x1B152
            | 0x1F200
            // Katakana
            | 0x30A1..=0x30FA
            | 0x30FD..=0x30FF
            | 0x31F0..=0x31FF
            | 0x32D0..=0x32FE
            | 0x3300..=0x3357
            | 0xFF66..=0xFF6F
            | 0xFF71..=0xFF9D
            | 0x1B000
            | 0x1B120..=0x1B122
            | 0x1B155
            | 0x1B164..=0x1B167
            // Hangul
            | 0x1100..=0x11FF
            | 0x3131..=0x318E
            | 0x3200..=0x321E
            | 0x3260..=0x327E
            | 0xA960..=0xA97C
            | 0xAC00..=0xD7A3
            | 0xD7B0..=0xD7C6
            | 0xD7CB..=0xD7FB
            | 0xFFA0..=0xFFBE
            | 0xFFC2..=0xFFC7
            | 0xFFCA..=0xFFCF
            | 0xFFD2..=0xFFD7
            | 0xFFDA..=0xFFDC
    )
}

fn push_cjk_bigrams(word: &str, out: &mut Vec<String>) {
    let chars: Vec<char> = word.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if !is_cjk(chars[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && is_cjk(chars[i]) {
            i += 1;
        }
        if i - start >= 2 {
            for w in chars[start..i].windows(2) {
                let mut bg = String::with_capacity(w[0].len_utf8() + w[1].len_utf8());
                bg.push(w[0]);
                bg.push(w[1]);
                if bg != word {
                    out.push(bg);
                }
            }
        }
    }
}

/// Split prose and code identifiers identically to `src/ask/index-file.ts::tokenize`.
pub fn tokenize(text: &str) -> Vec<String> {
    let normalized: String = text.nfc().collect();
    let mut with_breaks = String::with_capacity(normalized.len() + 16);
    let mut prev: Option<char> = None;
    for ch in normalized.chars() {
        if let Some(p) = prev
            && is_lower_or_num(p)
            && is_upper(ch)
        {
            with_breaks.push(' ');
        }
        with_breaks.push(ch);
        prev = Some(ch);
    }
    let lowered = with_breaks.to_lowercase();
    let mut tokens = Vec::new();
    let mut cur = String::new();
    for ch in lowered.chars() {
        if is_token_char(ch) {
            cur.push(ch);
        } else if !cur.is_empty() {
            if cur.encode_utf16().count() > 1 && !is_stop_word(&cur) {
                let word = std::mem::take(&mut cur);
                tokens.push(word.clone());
                push_cjk_bigrams(&word, &mut tokens);
            } else {
                cur.clear();
            }
        }
    }
    if !cur.is_empty() && cur.encode_utf16().count() > 1 && !is_stop_word(&cur) {
        let word = cur;
        tokens.push(word.clone());
        push_cjk_bigrams(&word, &mut tokens);
    }
    tokens
}

/// Term-frequency map preserving deterministic counts.
pub fn counts(tokens: &[String]) -> HashMap<String, usize> {
    let mut m = HashMap::new();
    for t in tokens {
        *m.entry(t.clone()).or_insert(0) += 1;
    }
    m
}

/// Deduplicated query terms in encounter order (matching JS `new Map([...counts(tokenize(q)).keys()])`).
pub fn unique_terms_ordered(text: &str) -> Vec<String> {
    let mut seen = HashMap::new();
    let mut out = Vec::new();
    for t in tokenize(text) {
        if seen.insert(t.clone(), ()).is_none() {
            out.push(t);
        }
    }
    out
}

#[derive(Debug, Clone, Deserialize)]
pub struct AskIndexDoc {
    pub id: String,
    pub name: Vec<(String, usize)>,
    pub path: Vec<(String, usize)>,
    pub body: Vec<(String, usize)>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AskIndex {
    pub version: u32,
    #[serde(rename = "avgBodyLen")]
    pub avg_body_len: f64,
    pub df: Vec<(String, usize)>,
    #[serde(rename = "docCount")]
    pub doc_count: usize,
    pub docs: Vec<AskIndexDoc>,
}

pub fn ask_index_path(out_dir: &Path) -> PathBuf {
    out_dir.join(CACHE_DIR).join(ASK_INDEX_FILE)
}

fn validate_field_bag(bag: &[(String, usize)]) -> Option<usize> {
    let mut per_term: HashMap<&str, usize> = HashMap::new();
    let mut total = 0_usize;
    for (term, count) in bag {
        let count = *count;
        if count == 0 || i64::try_from(count).is_err() {
            return None;
        }
        let entry = per_term.entry(term.as_str()).or_insert(0);
        *entry = entry.checked_add(count)?;
        i64::try_from(*entry).ok()?;
        total = total.checked_add(count)?;
    }
    i64::try_from(total).ok()?;
    Some(total)
}

/// Validate a parsed `ask-index.json` sidecar for unique DF terms, bounded counts,
/// non-negative finite `avgBodyLen`, and overflow-free SQLite `i64` aggregations.
pub fn is_valid_ask_index(idx: &AskIndex) -> bool {
    if idx.version != 2
        || idx.doc_count != idx.docs.len()
        || i64::try_from(idx.doc_count).is_err()
        || !idx.avg_body_len.is_finite()
        || idx.avg_body_len < 0.0
    {
        return false;
    }
    let mut seen_df: HashSet<&str> = HashSet::with_capacity(idx.df.len());
    for (term, df) in &idx.df {
        let df = *df;
        if df == 0
            || df > idx.doc_count
            || i64::try_from(df).is_err()
            || !seen_df.insert(term.as_str())
        {
            return false;
        }
    }
    let mut seen_docs: HashSet<&str> = HashSet::with_capacity(idx.docs.len());
    for doc in &idx.docs {
        if !seen_docs.insert(doc.id.as_str())
            || validate_field_bag(&doc.name).is_none()
            || validate_field_bag(&doc.path).is_none()
            || validate_field_bag(&doc.body).is_none()
        {
            return false;
        }
    }
    true
}

/// Read `<outDir>/.cache/ask-index.json`, returning `None` if absent, symlinked, or malformed.
pub fn read_ask_index(out_dir: &Path) -> io::Result<Option<AskIndex>> {
    let path = ask_index_path(out_dir);
    let meta = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if meta.file_type().is_symlink() || !meta.file_type().is_file() {
        return Ok(None);
    }
    if let Some(base) = out_dir.parent()
        && let (Ok(cb), Ok(cp)) = (fs::canonicalize(base), fs::canonicalize(&path))
        && !cp.starts_with(&cb)
    {
        return Ok(None);
    }
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Ok(None),
    };
    let Ok(idx) = serde_json::from_str::<AskIndex>(&text) else {
        return Ok(None);
    };
    if !is_valid_ask_index(&idx) {
        return Ok(None);
    }
    Ok(Some(idx))
}

#[cfg(test)]
mod tests {
    use super::is_cjk;

    #[test]
    fn is_cjk_matches_every_han_kana_and_hangul_block() {
        let cjk_samples: &[u32] = &[
            0x2E80, 0x2F00, 0x3005, 0x3007, 0x3021, 0x3038, 0x3400, 0x4E00, 0xF900, 0x20000,
            0x2A700, 0x2B740, 0x2B820, 0x2CEB0, 0x2F800, 0x30000, 0x3041, 0x309D, 0x1B001, 0x1B132,
            0x1B150, 0x1F200, 0x30A1, 0x30FD, 0x31F0, 0x32D0, 0x3300, 0xFF66, 0xFF71, 0x1B000,
            0x1B120, 0x1B155, 0x1B164, 0x1100, 0x3131, 0x3200, 0x3260, 0xA960, 0xAC00, 0xD7B0,
            0xD7CB, 0xFFA0, 0xFFC2, 0xFFCA, 0xFFD2, 0xFFDA,
        ];
        for &cp in cjk_samples {
            let ch = char::from_u32(cp).expect("valid scalar");
            assert!(is_cjk(ch), "expected CJK for U+{cp:04X}");
        }
        for non in ['a', 'Z', '0', 'é', 'Ω', '😀'] {
            assert!(!is_cjk(non), "unexpected CJK for {non:?}");
        }
    }
}
