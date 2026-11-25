//! Graph data types, symbol resolution helpers, scopes and savings calculations.
//!
//! Mirrors `src/graph/types.ts`, `src/graph/traverse.ts`, `src/graph/scopes.ts`
//! and `src/context/savings.ts`.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize, Serializer};

use crate::brand::tag;
use crate::evidence::{code_of, syntax_of};
use crate::provenance::{Confidence, WeakestHop};

pub const WALK_RELATIONS: &[&str] = &["calls", "references", "imports", "implements", "extends"];
pub const INFERRED_MARK: &str = " [inferred]";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    In,
    Out,
}

impl Direction {
    pub fn arrow(self) -> &'static str {
        match self {
            Self::In => "←",
            Self::Out => "→",
        }
    }

    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw {
            None | Some("in") => Ok(Self::In),
            Some("out") => Ok(Self::Out),
            Some(other) => Err(format!(
                "--direction must be \"in\" or \"out\", got \"{other}\""
            )),
        }
    }
}

pub fn parse_depth(raw: Option<&str>, default_depth: usize) -> Result<usize, String> {
    let Some(s) = raw else {
        return Ok(default_depth);
    };
    if s.eq_ignore_ascii_case("all")
        || s.eq_ignore_ascii_case("full")
        || s.eq_ignore_ascii_case("max")
    {
        return Ok(usize::MAX);
    }
    let parsed: f64 = s.parse().unwrap_or(f64::NAN);
    if !parsed.is_finite() || parsed < 1.0 {
        return Err(format!(
            "--depth must be a positive number or \"all\", got \"{s}\""
        ));
    }
    Ok(parsed.floor() as usize)
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ScopeV1 {
    pub prefix: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub markers: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NodeCrux {
    pub code: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GraphMeta {
    #[serde(rename = "nodeCount", default)]
    pub node_count: usize,
    #[serde(rename = "edgeCount", default)]
    pub edge_count: usize,
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    pub scopes: Option<Vec<ScopeV1>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NodeV1 {
    pub id: String,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub owner: Option<String>,
    pub path: String,
    pub span: String,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default)]
    pub exported: bool,
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub body_hash: String,
    #[serde(default)]
    pub chars: Option<u64>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub body_text: Option<String>,
    #[serde(default)]
    pub crux: Option<NodeCrux>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EdgeV1 {
    pub source: String,
    pub target: String,
    pub relation: String,
    #[serde(default)]
    pub confidence: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UnresolvedCall {
    pub name: String,
    pub source: String,
    #[serde(default)]
    pub through: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GraphV1 {
    pub meta: GraphMeta,
    pub nodes: Vec<NodeV1>,
    pub edges: Vec<EdgeV1>,
    #[serde(rename = "unresolvedCalls", default)]
    pub unresolved_calls: Vec<UnresolvedCall>,
}

#[derive(Debug, Clone)]
pub struct EdgeHit {
    pub node: Option<NodeV1>,
    pub id: String,
    pub relation: String,
    pub depth: usize,
    pub inferred: bool,
    pub confidence: Confidence,
    pub weakest_hop: Option<WeakestHop>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Savings {
    pub files: usize,
    #[serde(rename = "baselineChars")]
    pub baseline_chars: usize,
}

pub struct Quote {
    pub n: usize,
    pub text: String,
}

pub fn is_walk_relation(rel: &str) -> bool {
    WALK_RELATIONS.contains(&rel)
}

pub fn canonical_root_scopes() -> Vec<ScopeV1> {
    vec![ScopeV1 {
        prefix: String::new(),
        label: String::new(),
        markers: Vec::new(),
    }]
}

pub fn scopes_of_meta(meta: &GraphMeta) -> Vec<ScopeV1> {
    match &meta.scopes {
        Some(s) if !s.is_empty() => s.clone(),
        _ => canonical_root_scopes(),
    }
}

pub fn scope_of<'a>(path: &str, scopes: &'a [ScopeV1]) -> &'a str {
    for s in scopes {
        if s.prefix.is_empty() {
            continue;
        }
        if path_under_prefix(path, &s.prefix) {
            return &s.prefix;
        }
    }
    ""
}

pub fn scope_label(prefix: &str) -> String {
    if prefix.is_empty() {
        "(root)".to_string()
    } else {
        format!("{prefix}/")
    }
}

pub fn scopes_here_clause(scopes: &[ScopeV1]) -> String {
    if scopes.len() <= 1 {
        return String::new();
    }
    let labels: Vec<String> = scopes.iter().map(|s| scope_label(&s.prefix)).collect();
    format!(" — scopes here: {}", labels.join(" · "))
}

/// Strip mint-time disambiguation ordinals (`~2`, `~3`, ...) at segment ends.
pub fn strip_ordinals(id_tail: &str) -> String {
    let bytes = id_tail.as_bytes();
    let mut out = String::with_capacity(id_tail.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'~' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 1 && (j == bytes.len() || bytes[j] == b'.') {
                i = j;
                continue;
            }
        }
        let ch = id_tail[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

pub fn normalize_path_prefix(p: &str) -> String {
    let mut s = p.replace('\\', "/");
    while let Some(rest) = s.strip_prefix("./") {
        s = rest.to_string();
    }
    while s.ends_with('/') {
        s.pop();
    }
    s
}

pub fn path_under_prefix(path: &str, prefix: &str) -> bool {
    prefix.is_empty()
        || path == prefix
        || (path.starts_with(prefix) && path.as_bytes().get(prefix.len()) == Some(&b'/'))
}

pub fn looks_like_filename(query: &str) -> bool {
    if query.contains('#') {
        return false;
    }
    if query.contains('/') {
        return true;
    }
    let Some((_, ext)) = query.rsplit_once('.') else {
        return false;
    };
    !ext.is_empty() && ext.len() <= 5 && ext.bytes().all(|b| b.is_ascii_alphanumeric())
}

pub fn symbol_matches_node(node: &NodeV1, lower_query: &str) -> bool {
    if node.kind == "file" {
        return false;
    }
    if node.name.to_lowercase() == lower_query {
        return true;
    }
    let lower_id = node.id.to_lowercase();
    let candidate = if let Some(hash_idx) = lower_id.find('#') {
        format!(
            "{}{}",
            &lower_id[..=hash_idx],
            strip_ordinals(&lower_id[hash_idx + 1..])
        )
    } else {
        lower_id
    };
    let suffix_hash = format!("#{lower_query}");
    let suffix_dot = format!(".{lower_query}");
    candidate.ends_with(&suffix_hash) || candidate.ends_with(&suffix_dot)
}

pub fn is_test_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    for seg in ["test/", "tests/", "__tests__/", "spec/"] {
        if lower.starts_with(seg) || lower.contains(&format!("/{seg}")) {
            return true;
        }
    }
    if let Some((stem, ext)) = lower.rsplit_once('.')
        && !ext.is_empty()
        && ext.bytes().all(|b| b.is_ascii_alphabetic())
        && (stem.ends_with("_test") || stem.ends_with(".test") || stem.ends_with(".spec"))
    {
        return true;
    }
    let base = lower.rsplit('/').next().unwrap_or(&lower);
    base == "conftest.py" || (base.starts_with("test_") && base.ends_with(".py"))
}

/// Mirrors `src/graph/deploy.ts::deployFormatOf` truthiness check.
pub fn is_deploy_file(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let exact = normalized.rsplit('/').next().unwrap_or(&normalized);
    if matches!(
        exact,
        "kustomization.yaml" | "kustomization.yml" | "Kustomization"
    ) {
        return true;
    }
    let base = exact.to_ascii_lowercase();
    if base.ends_with(".dockerignore") {
        return false;
    }
    if base == "containerfile"
        || base == "dockerfile"
        || (base.starts_with("dockerfile")
            && matches!(base.as_bytes().get(10), Some(b'.' | b'_' | b'-'))
            && base.len() > 11)
        || (base.ends_with(".dockerfile") && base.len() > ".dockerfile".len())
    {
        return true;
    }
    if exact.ends_with(".tf") {
        return true;
    }
    base.ends_with(".yaml") || base.ends_with(".yml")
}

/// Resolve `rel` strictly inside `root`, refusing traversal and symlink escapes.
pub fn safe_resolve_inside(root: &Path, rel: &str) -> Option<PathBuf> {
    let canon_root = fs::canonicalize(root).ok()?;
    let joined = root.join(rel);
    let meta = fs::symlink_metadata(&joined).ok()?;
    if meta.file_type().is_symlink() || !meta.file_type().is_file() {
        return None;
    }
    let canon = fs::canonicalize(&joined).ok()?;
    if !canon.starts_with(&canon_root) {
        return None;
    }
    Some(canon)
}

pub fn span_range(span: &str) -> Option<(usize, usize)> {
    let rest = span.strip_prefix('L')?;
    if let Some((a, b)) = rest.split_once("-L") {
        let start = a.parse().ok()?;
        let end = b.parse().ok()?;
        Some((start, end))
    } else {
        let start = rest.parse().ok()?;
        Some((start, start))
    }
}

fn is_word_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn contains_word(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let h = haystack.as_bytes();
    let n = needle.as_bytes();
    let mut start = 0;
    while let Some(pos) = haystack[start..].find(needle) {
        let abs = start + pos;
        let left_ok = abs == 0 || !is_word_char(h[abs - 1]);
        let right_idx = abs + n.len();
        let right_ok = right_idx == h.len() || !is_word_char(h[right_idx]);
        if left_ok && right_ok {
            return true;
        }
        let step = haystack[abs..].chars().next().map_or(1, char::len_utf8);
        start = abs + step;
    }
    false
}

pub fn reference_line(
    root: &Path,
    path: &str,
    span: &str,
    symbol_name: &str,
    cache: &mut HashMap<String, Option<Vec<String>>>,
) -> Option<Quote> {
    reference_line_any(root, path, span, &[symbol_name], cache)
}

pub fn reference_line_any(
    root: &Path,
    path: &str,
    span: &str,
    symbol_names: &[&str],
    cache: &mut HashMap<String, Option<Vec<String>>>,
) -> Option<Quote> {
    if is_deploy_file(path) || symbol_names.is_empty() {
        return None;
    }
    let (start, end) = span_range(span)?;
    if start == 0 {
        return None;
    }
    let lines = cache
        .entry(path.to_string())
        .or_insert_with(|| {
            let full = safe_resolve_inside(root, path)?;
            fs::read_to_string(full)
                .ok()
                .map(|s| s.lines().map(String::from).collect())
        })
        .as_ref()?;
    let syntax = syntax_of(path);
    let mut open: Option<String> = None;
    let lo = start - 1;
    let hi = end.min(lines.len());
    for (idx, line) in lines.iter().enumerate().take(hi).skip(lo) {
        let (code, next_open) = code_of(line, syntax, open);
        open = next_open;
        if symbol_names.iter().any(|name| contains_word(&code, name)) {
            return Some(Quote {
                n: idx + 1,
                text: line.clone(),
            });
        }
    }
    None
}

pub fn group_digits(n: usize) -> String {
    let s = n.to_string();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, &b) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(b as char);
    }
    out
}

pub fn to_tokens(chars: usize) -> usize {
    ((chars as f64) / 4.0).round() as usize
}

pub fn with_savings(body: &str, saved: Option<&Savings>) -> String {
    let Some(s) = saved else {
        return body.to_string();
    };
    if s.baseline_chars == 0 {
        return body.to_string();
    }
    let body_len = body.encode_utf16().count();
    let pack = to_tokens(body_len);
    let base = to_tokens(s.baseline_chars);
    if base <= pack {
        return body.to_string();
    }
    let delta = base - pack;
    let pct = ((delta as f64 / base as f64) * 100.0).round() as usize;
    format!(
        "{} tokens saved ≈ {} ({pct}%) at most, against reading the {} file(s) whole\n\n{body}",
        tag(),
        group_digits(delta),
        s.files
    )
}

/// Deterministic approximation of JavaScript's `localeCompare` (case-insensitive primary,
/// lowercase before uppercase on equal letters, byte tiebreak).
pub fn js_locale_cmp(a: &str, b: &str) -> Ordering {
    let al = a.to_lowercase();
    let bl = b.to_lowercase();
    match al.cmp(&bl) {
        Ordering::Equal => {
            for (ca, cb) in a.chars().zip(b.chars()) {
                if ca != cb {
                    let a_upper = ca.is_uppercase();
                    let b_upper = cb.is_uppercase();
                    if a_upper != b_upper {
                        return a_upper.cmp(&b_upper);
                    }
                    return ca.cmp(&cb);
                }
            }
            a.cmp(b)
        }
        other => other,
    }
}

/// Serialize `f64` matching JavaScript `JSON.stringify` (exact integers print without `.0`).
pub fn serialize_js_f64<S: Serializer>(val: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    if val.is_finite() && val.fract() == 0.0 && (-MAX_SAFE..=MAX_SAFE).contains(val) {
        serializer.serialize_i64(*val as i64)
    } else {
        serializer.serialize_f64(*val)
    }
}

pub fn serialize_opt_js_f64<S: Serializer>(
    val: &Option<f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match val {
        Some(v) => serialize_js_f64(v, serializer),
        None => serializer.serialize_none(),
    }
}
