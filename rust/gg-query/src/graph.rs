//! Graph data types, symbol resolution helpers, scopes and savings calculations.
//!
//! Mirrors `src/graph/types.ts`, `src/graph/traverse.ts`, `src/graph/scopes.ts`
//! and `src/context/savings.ts`.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize, Serializer};

use crate::brand::tag;
use crate::evidence::{code_of, syntax_of};
use crate::provenance::{Confidence, WeakestHop};
use crate::safe_io::read_contained_to_string;

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

/// Mirrors `quoteFor` in `src/graph/traverse-cli.ts`: a file that imports the name, or imports it as
/// another name (`name as alias`), calls it on a later line, so that line is quoted; else the first mention.
pub fn call_reference_line(
    root: &Path,
    path: &str,
    span: &str,
    symbol_name: &str,
    cache: &mut HashMap<String, Option<Vec<String>>>,
) -> Option<Quote> {
    if is_deploy_file(path) || symbol_name.is_empty() {
        return None;
    }
    // Fills the cache, so the reads below see the file.
    let first = reference_line(root, path, span, symbol_name, cache);
    let lines = cache.get(path)?.as_ref()?;
    let imports = import_lines(lines);
    let mut names = vec![symbol_name.to_string()];
    for (line, _) in lines.iter().zip(&imports).filter(|(_, i)| **i) {
        for alias in aliases_in(&import_code(line), symbol_name) {
            if !names.contains(&alias) {
                names.push(alias);
            }
        }
    }
    let (start, end) = span_range(span)?;
    let syntax = syntax_of(path);
    let mut open: Option<String> = None;
    for (idx, line) in lines
        .iter()
        .enumerate()
        .take(end.min(lines.len()))
        .skip(start.saturating_sub(1))
    {
        let (code, next_open) = code_of(line, syntax, open);
        open = next_open;
        if !imports[idx] && names.iter().any(|n| !word_positions(&code, n).is_empty()) {
            return Some(Quote {
                n: idx + 1,
                text: line.clone(),
            });
        }
    }
    first
}

/// A line that starts an import, in Python (`import x`, `from x import y`) or JavaScript (`import { y } from`),
/// not `import.meta` or a dynamic `import(...)`.
fn is_import_line(code: &str) -> bool {
    let t = code.trim_start();
    let starts_word = |s: &str, w: &str| {
        s.starts_with(w) && !s[w.len()..].bytes().next().is_some_and(is_word_char)
    };
    if starts_word(t, "import") {
        return !t["import".len()..].trim_start().starts_with(['.', '(']);
    }
    if starts_word(t, "from") {
        let rest = t["from".len()..].trim_start();
        let after = rest
            .find(char::is_whitespace)
            .map(|i| rest[i..].trim_start());
        return after.is_some_and(|a| starts_word(a, "import"));
    }
    false
}

/// Each word-bounded occurrence of `word` in `s`, by byte offset.
fn word_positions(s: &str, word: &str) -> Vec<usize> {
    let b = s.as_bytes();
    s.match_indices(word)
        .map(|(i, _)| i)
        .filter(|&i| {
            (i == 0 || !is_word_char(b[i - 1]))
                && b.get(i + word.len()).is_none_or(|&c| !is_word_char(c))
        })
        .collect()
}

/// The text after ` as ` when it follows `s[at..]`'s word, if any.
fn as_follows(rest: &str) -> Option<&str> {
    let t = rest.trim_start();
    if t.len() == rest.len() {
        return None;
    }
    let t = t.strip_prefix("as")?;
    if t.bytes().next().is_some_and(is_word_char) || t.len() == t.trim_start().len() {
        return None;
    }
    Some(t.trim_start())
}

/// The names `name as alias` binds on a line.
fn aliases_in(line: &str, name: &str) -> Vec<String> {
    word_positions(line, name)
        .into_iter()
        .filter_map(|i| as_follows(&line[i + name.len()..]))
        .filter_map(|t| {
            let end = t
                .bytes()
                .position(|c| !(is_word_char(c) || c == b'$'))
                .unwrap_or(t.len());
            let first = t.bytes().next()?;
            (end > 0 && !first.is_ascii_digit()).then(|| t[..end].to_string())
        })
        .filter(|a| a != name && !a.contains('$'))
        .collect()
}

/// An import line's code: quoted text (a module path) and a `/* ... */` comment emptied, and a
/// `#`, `//` or unclosed `/*` comment outside quotes dropped. Mirrors `importCode` in
/// `src/graph/traverse-cli.ts`.
fn import_code(line: &str) -> String {
    let mut out = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut i = 0;
    while let Some(c) = line[i..].chars().next() {
        let at = i;
        i += c.len_utf8();
        if escaped {
            escaped = false;
        } else if let Some(q) = quote {
            if c == '\\' {
                escaped = true;
            } else if c == q {
                quote = None;
                out.push(c);
            }
        } else if line[at..].starts_with("/*") {
            let Some(close) = line[at + 2..].find("*/") else {
                break;
            };
            i = at + 2 + close + 2;
            out.push(' ');
        } else if c == '#' || line[at..].starts_with("//") {
            break;
        } else {
            if matches!(c, '"' | '\'' | '`') {
                quote = Some(c);
            }
            out.push(c);
        }
    }
    out
}

/// Which lines belong to an import statement: its first line and, when it opens `{` or `(`, the
/// lines up to the close. Mirrors `importLines` in `src/graph/traverse-cli.ts`.
fn import_lines(lines: &[String]) -> Vec<bool> {
    let mut open = false;
    lines
        .iter()
        .map(|l| {
            if !open && !is_import_line(l) {
                return false;
            }
            let code = import_code(l);
            open = if open {
                !code.contains([')', '}'])
            } else {
                code.rfind(['(', '{'])
                    .is_some_and(|i| !code[i..].contains([')', '}']))
            };
            true
        })
        .collect()
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
            read_contained_to_string(root, path, None)
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
