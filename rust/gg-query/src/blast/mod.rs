//! Blast-radius diff analysis matching `src/blast/blast.ts` & `src/blast/modules.ts`.

pub mod diff;
pub mod owners;
pub mod render;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde::{Serialize, Serializer};

use crate::ask::concepts::load_concepts;
use crate::evidence::blank_comment_lines;
use crate::graph::{
    Direction, EdgeHit, EdgeV1, NodeV1, UnresolvedCall, is_deploy_file, js_locale_cmp,
    safe_resolve_inside, span_range,
};
use crate::store::GraphStore;

use diff::{ChangeStatus, ChangedFile, Hunk, LineRange};
use owners::{Owner, Reviewer};

const MAX_WRAPPED_LINES: usize = 40;
const MAX_AREAS: usize = 5;
const MAX_LABEL: usize = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LabelSource {
    Concept,
    Symbol,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TestSignal {
    Changed,
    Stale,
    None,
    Na,
}

fn serialize_blast_depth<S: Serializer>(depth: &usize, serializer: S) -> Result<S::Ok, S::Error> {
    if *depth == usize::MAX {
        serializer.serialize_none()
    } else {
        serializer.serialize_u64(*depth as u64)
    }
}

fn is_true(v: &bool) -> bool {
    *v
}

#[derive(Debug, Clone, Serialize)]
pub struct Seed {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub path: String,
    pub span: String,
    #[serde(rename = "wholeFile")]
    pub whole_file: bool,
    #[serde(
        rename = "declarationChanged",
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub declaration_changed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LeftBehindSeed {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LeftBehind {
    pub seed: LeftBehindSeed,
    pub id: String,
    pub name: String,
    pub kind: String,
    pub path: String,
    pub span: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub inferred: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct TestReach {
    pub path: String,
    pub depth: usize,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub changed: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub inferred: bool,
    pub symbols: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Impacted {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub path: String,
    pub span: String,
    pub relation: String,
    pub depth: usize,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub inferred: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImpactedModule {
    pub label: String,
    #[serde(rename = "labelSource")]
    pub label_source: LabelSource,
    pub key: String,
    pub files: Vec<String>,
    pub symbols: Vec<Impacted>,
    pub from: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owners: Option<Vec<Owner>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChangedArea {
    pub label: String,
    #[serde(rename = "labelSource")]
    pub label_source: LabelSource,
    pub key: String,
    pub files: Vec<String>,
    pub seeds: usize,
    pub tests: TestSignal,
    #[serde(rename = "testFiles")]
    pub test_files: Vec<String>,
    #[serde(rename = "changedTestFiles")]
    pub changed_test_files: Vec<String>,
    pub reached: usize,
    pub behavioural: usize,
    pub unreached: Vec<String>,
    #[serde(rename = "seedNames")]
    pub seed_names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owners: Option<Vec<Owner>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UnresolvedName {
    pub name: String,
    pub calls: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlastReport {
    pub basis: String,
    #[serde(serialize_with = "serialize_blast_depth")]
    pub depth: usize,
    pub changed: Vec<ChangedFile>,
    pub unindexed: Vec<String>,
    pub deleted: Vec<String>,
    pub seeds: Vec<Seed>,
    pub impacted: Vec<Impacted>,
    pub modules: Vec<ImpactedModule>,
    #[serde(rename = "testModules")]
    pub test_modules: Vec<ImpactedModule>,
    pub areas: Vec<ChangedArea>,
    pub unresolved: Vec<UnresolvedName>,
    #[serde(rename = "leftBehind")]
    pub left_behind: Vec<LeftBehind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tests: Option<Vec<TestReach>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewers: Option<Vec<Reviewer>>,
}

pub struct BlastOptions {
    pub depth: usize,
    pub tests: bool,
    pub seed_all_on_empty_ranges: bool,
}

/// Test-file path rule matching `src/blast/blast.ts::TEST_PATH`.
pub fn is_blast_test_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    for seg in ["test/", "tests/", "spec/", "specs/", "__tests__/"] {
        if lower.starts_with(seg) || lower.contains(&format!("/{seg}")) {
            return true;
        }
    }
    if let Some((stem, ext)) = lower.rsplit_once('.') {
        if matches!(
            ext,
            "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts"
        ) && (stem.ends_with(".test") || stem.ends_with(".spec"))
        {
            return true;
        }
        if matches!(ext, "go" | "py" | "rb") && stem.ends_with("_test") {
            return true;
        }
    }
    false
}

pub(crate) struct ModuleIndex {
    claims: HashMap<String, (String, usize)>,
}

impl ModuleIndex {
    fn load(out_dir: &Path) -> Self {
        let mut claims: HashMap<String, (String, usize)> = HashMap::new();
        if let Ok(docs) = load_concepts(out_dir, None) {
            for doc in docs {
                if doc.name.is_empty() {
                    continue;
                }
                let size = doc.sources.len();
                for src in doc.sources {
                    let replace = claims.get(&src).is_none_or(|prev| size < prev.1);
                    if replace {
                        claims.insert(src, (doc.name.clone(), size));
                    }
                }
            }
        }
        Self { claims }
    }

    fn concept_of(&self, path: &str) -> Option<&str> {
        self.claims.get(path).map(|(label, _)| label.as_str())
    }
}

pub fn dir_label(path: &str) -> String {
    match path.rfind('/') {
        None => "(root)".to_string(),
        Some(idx) => format!("{}/", &path[..idx]),
    }
}

pub fn parent_dir(dir: &str) -> String {
    let trimmed = dir.trim_end_matches('/');
    match trimmed.rfind('/') {
        None => String::new(),
        Some(idx) => format!("{}/", &trimmed[..idx]),
    }
}

fn strip_concept_prefix(label: &str) -> &str {
    let trimmed = label.trim();
    let lower = trimmed.to_ascii_lowercase();
    for pat in ["concepts:", "concept:"] {
        if lower.starts_with(pat) {
            return trimmed[pat.len()..].trim();
        }
    }
    trimmed
}

fn find_clause_break(s: &str) -> Option<usize> {
    let lower = s.to_ascii_lowercase();
    let mut best: Option<usize> = None;
    let mut consider = |idx: usize| {
        if (8..=MAX_LABEL).contains(&idx) && best.is_none_or(|b| idx < b) {
            best = Some(idx);
        }
    };
    for pat in [" (", " —", " - ", ": "] {
        if let Some(pos) = s.find(pat) {
            consider(pos);
        }
    }
    for kw in [
        " via ", " and ", " for ", " with ", " using ", " in ", " across ", " over ", " from ",
        " of ", " by ", " to ",
    ] {
        if let Some(pos) = lower.find(kw) {
            consider(pos);
        }
    }
    best
}

pub fn short_label(label: &str) -> String {
    let bare = strip_concept_prefix(label);
    if bare.encode_utf16().count() <= MAX_LABEL {
        return bare.to_string();
    }
    if let Some(at) = find_clause_break(bare) {
        return bare[..at].trim_end().to_string();
    }
    let mut boundary = bare.len();
    let mut utf16 = 0_usize;
    let mut last_space = None;
    for (idx, ch) in bare.char_indices() {
        let len16 = ch.len_utf16();
        if utf16 + len16 > MAX_LABEL {
            boundary = idx;
            break;
        }
        if ch == ' ' {
            last_space = Some(idx);
        }
        utf16 += len16;
    }
    let cut = match last_space {
        Some(sp) if sp > MAX_LABEL / 2 => sp,
        _ => boundary,
    };
    format!("{}…", bare[..cut].trim_end())
}

fn hub_label(names: &[String], fallback: &str) -> String {
    for n in names {
        if !n.is_empty() {
            return short_label(n);
        }
    }
    fallback.to_string()
}

fn shared_concept(paths: &[String], index: &ModuleIndex) -> Option<String> {
    let first = index.concept_of(paths.first()?)?;
    if paths.iter().all(|p| index.concept_of(p) == Some(first)) {
        Some(short_label(first))
    } else {
        None
    }
}

fn read_lines_safe(
    root: &Path,
    path: &str,
    cache: &mut HashMap<String, Option<Vec<String>>>,
) -> Option<Vec<String>> {
    if let Some(cached) = cache.get(path) {
        return cached.clone();
    }
    let loaded = if is_deploy_file(path) {
        None
    } else {
        safe_resolve_inside(root, path).and_then(|abs| {
            fs::read_to_string(abs)
                .ok()
                .map(|raw| raw.split('\n').map(String::from).collect())
        })
    };
    cache.insert(path.to_string(), loaded.clone());
    loaded
}

fn drop_closing_commas(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b',' {
            let mut j = i + 1;
            while j < text.len() && text[j..].chars().next().is_some_and(char::is_whitespace) {
                j += text[j..].chars().next().unwrap().len_utf8();
            }
            if matches!(bytes.get(j), Some(b')' | b']' | b'}' | b'>')) {
                i += 1;
                continue;
            }
        }
        let ch = text[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn squash(text: &str) -> String {
    drop_closing_commas(text)
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect()
}

struct Squashed {
    text: String,
    starts: HashSet<usize>,
}

fn squash_lines(lines: &[String]) -> Squashed {
    let joined = lines.join("\n");
    let cleaned = drop_closing_commas(&joined);
    let mut text = String::new();
    let mut starts = HashSet::new();
    for line in cleaned.split('\n') {
        starts.insert(text.len());
        for ch in line.chars() {
            if !ch.is_whitespace() {
                text.push(ch);
            }
        }
    }
    Squashed { text, starts }
}

fn at_line_start(hay: &Squashed, needle: &str) -> bool {
    if needle.is_empty() {
        return hay.starts.contains(&0);
    }
    let mut from = 0;
    while let Some(rel) = hay.text[from..].find(needle) {
        let abs = from + rel;
        if hay.starts.contains(&abs) {
            return true;
        }
        let step = hay.text[abs..].chars().next().map_or(1, char::len_utf8);
        from = abs + step;
    }
    false
}

fn pure_deletion(h: &Hunk) -> bool {
    h.dropped == 0 && !h.lines.iter().any(|l| l.sign == "+")
}

fn touches(file: Option<&ChangedFile>, start: usize, end: usize) -> bool {
    let Some(f) = file else {
        return false;
    };
    if f.hunks.is_empty() {
        return f.ranges.iter().any(|r| r.start <= end && r.end >= start);
    }
    f.hunks.iter().any(|h| {
        if pure_deletion(h) {
            h.start >= start && h.start < end
        } else {
            h.start <= end && h.end >= start
        }
    })
}

fn pre_image(file: &ChangedFile, lines: &[String], start: usize, end: usize) -> Squashed {
    let near: Vec<&Hunk> = file
        .hunks
        .iter()
        .filter(|h| h.start <= end && h.end >= start)
        .collect();
    let mut from = start;
    for h in &near {
        if !pure_deletion(h) && h.start < from {
            from = h.start;
        }
    }
    let mut to = end;
    for h in &near {
        if h.end > to {
            to = h.end;
        }
    }
    let mut old = Vec::new();
    let mut n = from;
    while n <= to {
        if let Some(rew) = near.iter().find(|h| !pure_deletion(h) && h.start == n) {
            for l in &rew.lines {
                if l.sign == "-" {
                    old.push(l.text.clone());
                }
            }
            n = rew.end + 1;
            continue;
        }
        if n >= 1 && n <= lines.len() {
            old.push(lines[n - 1].clone());
        }
        for h in &near {
            if pure_deletion(h) && h.start == n {
                for l in &h.lines {
                    if l.sign == "-" {
                        old.push(l.text.clone());
                    }
                }
            }
        }
        n += 1;
    }
    squash_lines(&old)
}

fn call_end(lines: &[String], n: usize, at: usize, last: usize) -> usize {
    let mut depth = 0_usize;
    let limit = last.min(n + MAX_WRAPPED_LINES - 1);
    for (offset, line) in lines
        .iter()
        .enumerate()
        .take(limit)
        .skip(n.saturating_sub(1))
    {
        let slice = if offset + 1 == n {
            &line[at..]
        } else {
            line.as_str()
        };
        for ch in slice.chars() {
            if ch == '(' {
                depth += 1;
            } else if ch == ')' && depth > 0 {
                depth -= 1;
                if depth == 0 {
                    return offset + 1;
                }
            }
        }
        if depth == 0 {
            return n;
        }
    }
    n
}

fn declaration(node: &NodeV1, start: usize, end: usize, lines: &[String]) -> (usize, String) {
    let last = end.min(start + MAX_WRAPPED_LINES - 1).min(lines.len());
    let sig = node.signature.as_deref().map(squash).unwrap_or_default();
    if !sig.is_empty() {
        for n in start..=last {
            let text = squash_lines(&lines[start - 1..n]).text;
            if let Some(at) = text.find(&sig) {
                let open_parens = sig.bytes().filter(|&b| b == b'(').count();
                let close_parens = sig.bytes().filter(|&b| b == b')').count();
                if open_parens <= close_parens {
                    let end_byte = at + sig.len();
                    let next_len = text[end_byte..].chars().next().map_or(0, char::len_utf8);
                    return (n, text[..end_byte + next_len].to_string());
                }
                let decl_end = call_end(lines, start, 0, last).max(n);
                return (decl_end, squash_lines(&lines[start - 1..decl_end]).text);
            }
        }
    }
    (
        start,
        squash(
            lines
                .get(start.saturating_sub(1))
                .map_or("", String::as_str),
        ),
    )
}

fn declaration_changed(
    node: &NodeV1,
    file: &ChangedFile,
    removed: &[Squashed],
    root: &Path,
    cache: &mut HashMap<String, Option<Vec<String>>>,
) -> bool {
    let Some((start, end)) = span_range(&node.span) else {
        return false;
    };
    let Some(lines) = read_lines_safe(root, &node.path, cache) else {
        return touches(Some(file), start, start);
    };
    if start > lines.len() {
        return touches(Some(file), start, start);
    }
    let (decl_end, decl_text) = declaration(node, start, end, &lines);
    if !touches(Some(file), start, decl_end) {
        return false;
    }
    if file.hunks.is_empty() {
        return true;
    }
    if at_line_start(&pre_image(file, &lines, start, decl_end), &decl_text) {
        return false;
    }
    !removed.iter().any(|old| at_line_start(old, &decl_text))
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn matches_call_tail(after: &str) -> bool {
    let mut s = after.trim_start();
    if let Some(rest) = s.strip_prefix('!').or_else(|| s.strip_prefix("?.")) {
        s = rest.trim_start();
    }
    if let Some(rest) = s.strip_prefix('<') {
        let mut depth = 1_usize;
        let mut cut = None;
        for (i, ch) in rest.char_indices() {
            match ch {
                '(' | ')' => return false,
                '<' => depth += 1,
                '>' => {
                    depth -= 1;
                    if depth == 0 {
                        cut = Some(i + 1);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(end) = cut else {
            return false;
        };
        s = rest[end..].trim_start();
    }
    s.starts_with('(')
}

fn contains_word_ascii(line: &str, name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let bytes = line.as_bytes();
    let mut from = 0;
    while let Some(rel) = line[from..].find(name) {
        let at = from + rel;
        let end = at + name.len();
        let left_ok = at == 0 || !is_word_byte(bytes[at - 1]);
        let right_ok = end == bytes.len() || !is_word_byte(bytes[end]);
        if left_ok && right_ok {
            return true;
        }
        let step = line[at..].chars().next().map_or(1, char::len_utf8);
        from = at + step;
    }
    false
}

fn call_columns(code: &str, name: &str) -> Vec<usize> {
    if name.is_empty() {
        return Vec::new();
    }
    let bytes = code.as_bytes();
    let mut cols = Vec::new();
    let mut from = 0;
    while let Some(rel) = code[from..].find(name) {
        let at = from + rel;
        let end = at + name.len();
        let left_ok = at == 0 || !is_word_byte(bytes[at - 1]);
        let right_ok = end == bytes.len() || !is_word_byte(bytes[end]);
        if left_ok && right_ok && matches_call_tail(&code[end..]) {
            cols.push(at);
        }
        let step = code[at..].chars().next().map_or(1, char::len_utf8);
        from = at + step;
    }
    cols
}

enum CallSiteResult {
    Edited,
    Line(usize),
    None,
}

fn call_site(
    caller: &NodeV1,
    target_name: &str,
    file: Option<&ChangedFile>,
    root: &Path,
    cache: &mut HashMap<String, Option<Vec<String>>>,
) -> CallSiteResult {
    let Some((start, end)) = span_range(&caller.span) else {
        return CallSiteResult::None;
    };
    if let Some(lines) = read_lines_safe(root, &caller.path, cache) {
        let last = end.min(lines.len());
        if start >= 1 && start <= last {
            let code = blank_comment_lines(&lines, start, last, &caller.path);
            let mut calls = 0_usize;
            let mut mentions = Vec::new();
            for n in start..=last {
                let found = call_columns(&code[n - 1], target_name);
                for at in &found {
                    calls += 1;
                    if !touches(file, n, call_end(&code, n, *at, last)) {
                        return CallSiteResult::Line(n);
                    }
                }
                if found.is_empty() && contains_word_ascii(&code[n - 1], target_name) {
                    mentions.push(n);
                }
            }
            if calls > 0 {
                return CallSiteResult::Edited;
            }
            if !mentions.is_empty() {
                if mentions.iter().any(|&n| touches(file, n, n)) {
                    return CallSiteResult::Edited;
                }
                return CallSiteResult::Line(mentions[0]);
            }
        }
    }
    if touches(file, start, end) {
        CallSiteResult::Edited
    } else {
        CallSiteResult::None
    }
}

fn callers_left_behind(
    nodes: &[NodeV1],
    edges: &[EdgeV1],
    declared: &[NodeV1],
    changed: &[ChangedFile],
    root: &Path,
    cache: &mut HashMap<String, Option<Vec<String>>>,
) -> Vec<LeftBehind> {
    if declared.is_empty() {
        return Vec::new();
    }
    let by_id: HashMap<&str, &NodeV1> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut watched: HashMap<String, NodeV1> =
        declared.iter().map(|n| (n.id.clone(), n.clone())).collect();

    for seed in declared {
        if seed.kind != "method"
            || !matches!(seed.name.as_str(), "constructor" | "__init__")
            || seed.owner.is_none()
        {
            continue;
        }
        let seed_span = span_range(&seed.span);
        let owner_name = seed.owner.as_deref().unwrap_or("");
        if let Some(owner) = nodes.iter().find(|n| {
            n.kind == "class"
                && n.path == seed.path
                && n.name == owner_name
                && matches!((span_range(&n.span), seed_span), (Some(b), Some(s)) if b.0 <= s.0 && b.1 >= s.1)
        }) {
            watched.entry(owner.id.clone()).or_insert_with(|| seed.clone());
        }
    }

    let file_of: HashMap<&str, &ChangedFile> =
        changed.iter().map(|f| (f.path.as_str(), f)).collect();
    let mut found: HashMap<String, LeftBehind> = HashMap::new();

    for e in edges {
        if e.relation != "calls" || e.source == e.target {
            continue;
        }
        let Some(seed) = watched.get(&e.target) else {
            continue;
        };
        let Some(&target) = by_id.get(e.target.as_str()) else {
            continue;
        };
        let Some(&caller) = by_id.get(e.source.as_str()) else {
            continue;
        };
        let key = format!("{}\0{}", seed.id, caller.id);
        let is_inferred = e.confidence == "inferred";
        if let Some(prev) = found.get_mut(&key) {
            if !is_inferred {
                prev.inferred = false;
            }
            continue;
        }
        let line = match call_site(
            caller,
            &target.name,
            file_of.get(caller.path.as_str()).copied(),
            root,
            cache,
        ) {
            CallSiteResult::Edited => continue,
            CallSiteResult::Line(n) => Some(n),
            CallSiteResult::None => None,
        };
        found.insert(
            key,
            LeftBehind {
                seed: LeftBehindSeed {
                    id: seed.id.clone(),
                    name: seed.name.clone(),
                },
                id: caller.id.clone(),
                name: caller.name.clone(),
                kind: caller.kind.clone(),
                path: caller.path.clone(),
                span: caller.span.clone(),
                line,
                inferred: is_inferred,
            },
        );
    }

    let mut out: Vec<LeftBehind> = found.into_values().collect();
    out.sort_by(|a, b| {
        js_locale_cmp(&a.path, &b.path)
            .then_with(|| a.line.unwrap_or(0).cmp(&b.line.unwrap_or(0)))
            .then_with(|| js_locale_cmp(&a.name, &b.name))
            .then_with(|| js_locale_cmp(&a.seed.name, &b.seed.name))
    });
    out
}

fn seeds_for_file(nodes: &[NodeV1], path: &str, ranges: &[LineRange]) -> Vec<NodeV1> {
    let mut symbols: Vec<(&NodeV1, usize, usize)> = Vec::new();
    for n in nodes {
        if n.kind == "file" || n.path != path {
            continue;
        }
        if let Some((s, e)) = span_range(&n.span) {
            symbols.push((n, s, e));
        }
    }
    if symbols.is_empty() {
        return Vec::new();
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for r in ranges {
        let overlapping: Vec<(usize, &NodeV1, usize, usize)> = symbols
            .iter()
            .enumerate()
            .filter(|(_, (_, s, e))| *s <= r.end && *e >= r.start)
            .map(|(i, (n, s, e))| (i, *n, *s, *e))
            .collect();
        for &(i, node, s, e) in &overlapping {
            let contains_another = overlapping
                .iter()
                .any(|&(j, _, os, oe)| j != i && os >= s && oe <= e);
            if !contains_another && seen.insert(node.id.clone()) {
                out.push(node.clone());
            }
        }
    }
    out
}

fn is_test_only(mod_item: &ImpactedModule) -> bool {
    !mod_item.files.is_empty() && mod_item.files.iter().all(|f| is_blast_test_path(f))
}

fn group_by_module(
    impacted: &[Impacted],
    changed: &[ChangedFile],
    origins: &HashMap<String, HashSet<String>>,
    index: &ModuleIndex,
) -> (Vec<ImpactedModule>, Vec<ImpactedModule>) {
    let changed_paths: HashSet<&str> = changed.iter().map(|c| c.path.as_str()).collect();
    let mut by_key: HashMap<String, ImpactedModule> = HashMap::new();

    for hit in impacted {
        if changed_paths.contains(hit.path.as_str()) {
            continue;
        }
        let key = index
            .concept_of(&hit.path)
            .map_or_else(|| dir_label(&hit.path), str::to_string);
        let mod_entry = by_key.entry(key.clone()).or_insert_with(|| ImpactedModule {
            label: key.clone(),
            label_source: LabelSource::Symbol,
            key,
            files: Vec::new(),
            symbols: Vec::new(),
            from: Vec::new(),
            owners: None,
        });
        mod_entry.symbols.push(hit.clone());
        if !mod_entry.files.contains(&hit.path) {
            mod_entry.files.push(hit.path.clone());
        }
    }

    for mod_item in by_key.values_mut() {
        let mut from_set = HashSet::new();
        for s in &mod_item.symbols {
            if let Some(srcs) = origins.get(&s.id) {
                for p in srcs {
                    from_set.insert(p.clone());
                }
            }
        }
        let mut from: Vec<String> = from_set.into_iter().collect();
        from.sort();
        mod_item.from = from;
        mod_item.files.sort();
        mod_item.symbols.sort_by(|a, b| {
            a.depth
                .cmp(&b.depth)
                .then_with(|| a.inferred.cmp(&b.inferred))
                .then_with(|| js_locale_cmp(&a.path, &b.path))
        });
        let concept = shared_concept(&mod_item.files, index);
        if let Some(c) = concept {
            mod_item.label = c;
            mod_item.label_source = LabelSource::Concept;
        } else {
            let names: Vec<String> = mod_item.symbols.iter().map(|s| s.name.clone()).collect();
            mod_item.label = hub_label(&names, &mod_item.key);
            mod_item.label_source = LabelSource::Symbol;
        }
    }

    let sort_mods = |list: &mut Vec<ImpactedModule>| {
        list.sort_by(|a, b| {
            b.symbols
                .len()
                .cmp(&a.symbols.len())
                .then_with(|| js_locale_cmp(&a.label, &b.label))
        });
    };
    let mut prod = Vec::new();
    let mut tests = Vec::new();
    for m in by_key.into_values() {
        if is_test_only(&m) {
            tests.push(m);
        } else {
            prod.push(m);
        }
    }
    sort_mods(&mut prod);
    sort_mods(&mut tests);
    (prod, tests)
}

fn dir_depth(dir: &str) -> usize {
    dir.split('/').count()
}

fn coarsen(groups: &mut HashMap<String, Vec<String>>, max: usize) {
    while groups.len() > max {
        let mut keys: Vec<String> = groups.keys().cloned().collect();
        keys.sort_by(|a, b| {
            dir_depth(b)
                .cmp(&dir_depth(a))
                .then_with(|| groups[a].len().cmp(&groups[b].len()))
        });
        let pick = keys
            .iter()
            .find(|k| {
                let p = parent_dir(k);
                !p.is_empty() && groups.contains_key(&p)
            })
            .or_else(|| keys.iter().find(|k| !parent_dir(k).is_empty()))
            .cloned();
        let Some(pick_key) = pick else {
            return;
        };
        let parent = parent_dir(&pick_key);
        let moved = groups.remove(&pick_key).unwrap_or_default();
        groups.entry(parent).or_default().extend(moved);
    }
}

fn changed_areas(
    nodes: &[NodeV1],
    edges: &[EdgeV1],
    changed: &[ChangedFile],
    seed_nodes: &HashMap<String, Vec<NodeV1>>,
    index: &ModuleIndex,
    modules: &[ImpactedModule],
) -> Vec<ChangedArea> {
    let changed_tests: HashSet<&str> = changed
        .iter()
        .filter(|c| is_blast_test_path(&c.path))
        .map(|c| c.path.as_str())
        .collect();
    let node_by_id: HashMap<&str, &NodeV1> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut in_degree: HashMap<&str, usize> = HashMap::new();
    let mut incoming: HashMap<&str, HashSet<&str>> = HashMap::new();
    for e in edges {
        *in_degree.entry(e.target.as_str()).or_insert(0) += 1;
        if let Some(path) = node_by_id.get(e.source.as_str()).map(|n| n.path.as_str())
            && is_blast_test_path(path)
        {
            incoming.entry(e.target.as_str()).or_default().insert(path);
        }
    }

    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    for path in seed_nodes.keys() {
        if is_blast_test_path(path) {
            continue;
        }
        groups
            .entry(dir_label(path))
            .or_default()
            .push(path.clone());
    }
    coarsen(&mut groups, MAX_AREAS);

    let mut out = Vec::with_capacity(groups.len());
    for (dir, paths) in groups {
        out.push(build_changed_area(
            dir,
            paths,
            seed_nodes,
            &in_degree,
            &incoming,
            &changed_tests,
            index,
        ));
    }

    let reach_count = |a: &ChangedArea| -> usize {
        modules
            .iter()
            .filter(|m| m.from.iter().any(|f| a.files.contains(f)))
            .count()
    };
    out.sort_by(|a, b| {
        reach_count(b)
            .cmp(&reach_count(a))
            .then_with(|| b.files.len().cmp(&a.files.len()))
            .then_with(|| js_locale_cmp(&a.label, &b.label))
    });
    out
}

fn build_changed_area(
    dir: String,
    paths: Vec<String>,
    seed_nodes: &HashMap<String, Vec<NodeV1>>,
    in_degree: &HashMap<&str, usize>,
    incoming: &HashMap<&str, HashSet<&str>>,
    changed_tests: &HashSet<&str>,
    index: &ModuleIndex,
) -> ChangedArea {
    let mut files = Vec::new();
    let mut seed_count = 0_usize;
    let mut test_files = HashSet::new();
    let mut changed_test_files = HashSet::new();
    let mut reached = 0_usize;
    let mut behavioural_count = 0_usize;
    let mut unreached = Vec::new();
    let mut candidates: Vec<(String, bool, usize)> = Vec::new();

    for p in &paths {
        let ns = seed_nodes.get(p).map(Vec::as_slice).unwrap_or(&[]);
        files.push(p.clone());
        seed_count += ns.len();
        for node in ns {
            let is_behav = matches!(node.kind.as_str(), "function" | "method" | "class");
            let from = incoming.get(node.id.as_str());
            if let Some(tests) = from {
                for &t in tests {
                    test_files.insert(t.to_string());
                    if changed_tests.contains(t) {
                        changed_test_files.insert(t.to_string());
                    }
                }
            }
            candidates.push((
                node.name.clone(),
                is_behav,
                in_degree.get(node.id.as_str()).copied().unwrap_or(0),
            ));
            if !is_behav {
                continue;
            }
            behavioural_count += 1;
            if from.is_some_and(|s| !s.is_empty()) {
                reached += 1;
            } else {
                unreached.push(node.name.clone());
            }
        }
    }

    candidates.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| b.2.cmp(&a.2))
            .then_with(|| js_locale_cmp(&a.0, &b.0))
    });
    let seed_names: Vec<String> = candidates.into_iter().map(|c| c.0).collect();
    let concept = shared_concept(&files, index);
    let (label, label_source) = match concept {
        Some(c) => (c, LabelSource::Concept),
        None => (hub_label(&seed_names, &dir), LabelSource::Symbol),
    };
    files.sort();
    let mut tf: Vec<String> = test_files.into_iter().collect();
    tf.sort();
    let mut ctf: Vec<String> = changed_test_files.into_iter().collect();
    ctf.sort();
    let signal = if behavioural_count == 0 {
        TestSignal::Na
    } else if !ctf.is_empty() {
        TestSignal::Changed
    } else if !tf.is_empty() {
        TestSignal::Stale
    } else {
        TestSignal::None
    };

    ChangedArea {
        label,
        label_source,
        key: dir,
        files,
        seeds: seed_count,
        tests: signal,
        test_files: tf,
        changed_test_files: ctf,
        reached,
        behavioural: behavioural_count,
        unreached,
        seed_names,
        owners: None,
    }
}

fn unresolved_for_seeds(calls: &[UnresolvedCall], seeds: &[Seed]) -> Vec<UnresolvedName> {
    let names: HashSet<&str> = seeds
        .iter()
        .filter(|s| !s.whole_file)
        .map(|s| s.name.as_str())
        .collect();
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for c in calls {
        if names.contains(c.name.as_str()) {
            *counts.entry(c.name.as_str()).or_insert(0) += 1;
        }
    }
    let mut out: Vec<UnresolvedName> = counts
        .into_iter()
        .map(|(name, calls)| UnresolvedName {
            name: name.to_string(),
            calls,
        })
        .collect();
    out.sort_by(|a, b| {
        b.calls
            .cmp(&a.calls)
            .then_with(|| js_locale_cmp(&a.name, &b.name))
    });
    out
}

fn tests_reached(
    store: &GraphStore,
    nodes: &[NodeV1],
    seeds: &[NodeV1],
    changed: &[ChangedFile],
) -> Result<Vec<TestReach>, String> {
    let indexed: HashSet<&str> = nodes
        .iter()
        .filter(|n| n.kind == "file")
        .map(|n| n.path.as_str())
        .collect();
    struct TestAcc {
        depth: usize,
        changed: bool,
        definite: bool,
        hits: Vec<(String, usize)>,
    }
    let mut by_path: HashMap<String, TestAcc> = HashMap::new();
    for f in changed {
        if f.status != ChangeStatus::Deleted
            && indexed.contains(f.path.as_str())
            && is_blast_test_path(&f.path)
        {
            by_path.insert(
                f.path.clone(),
                TestAcc {
                    depth: 0,
                    changed: true,
                    definite: true,
                    hits: Vec::new(),
                },
            );
        }
    }
    let seed_ids: Vec<String> = seeds.iter().map(|s| s.id.clone()).collect();
    if !seed_ids.is_empty() {
        let hits = store
            .impact_of_many(&seed_ids, usize::MAX, Direction::In)
            .map_err(|e| e.to_string())?;
        for h in hits {
            let Some(n) = h.node else {
                continue;
            };
            if !is_blast_test_path(&n.path) {
                continue;
            }
            let entry = by_path.entry(n.path.clone()).or_insert_with(|| TestAcc {
                depth: h.depth,
                changed: false,
                definite: false,
                hits: Vec::new(),
            });
            if h.depth < entry.depth {
                entry.depth = h.depth;
            }
            if !h.inferred {
                entry.definite = true;
            }
            if n.kind != "file" {
                entry.hits.push((n.name, h.depth));
            }
        }
    }

    let mut out: Vec<TestReach> = by_path
        .into_iter()
        .map(|(path, mut acc)| {
            acc.hits
                .sort_by(|a, b| a.1.cmp(&b.1).then_with(|| js_locale_cmp(&a.0, &b.0)));
            let mut seen = HashSet::new();
            let mut symbols = Vec::new();
            for (name, _) in acc.hits {
                if seen.insert(name.clone()) {
                    symbols.push(name);
                }
            }
            TestReach {
                path,
                depth: acc.depth,
                changed: acc.changed,
                inferred: !acc.definite,
                symbols,
            }
        })
        .collect();
    out.sort_by(|a, b| {
        a.depth
            .cmp(&b.depth)
            .then_with(|| js_locale_cmp(&a.path, &b.path))
    });
    Ok(out)
}

fn to_impacted(h: &EdgeHit) -> Option<Impacted> {
    let n = h.node.as_ref()?;
    Some(Impacted {
        id: n.id.clone(),
        name: n.name.clone(),
        kind: n.kind.clone(),
        path: n.path.clone(),
        span: n.span.clone(),
        relation: h.relation.clone(),
        depth: h.depth,
        inferred: h.inferred,
    })
}

/// Compute a full Stage 2 `BlastReport` from `store` and `changed`.
pub fn compute_blast_report(
    store: &GraphStore,
    root: &Path,
    out_dir: &Path,
    changed: Vec<ChangedFile>,
    basis: String,
    opts: &BlastOptions,
) -> Result<BlastReport, String> {
    let (nodes, edges, unresolved_calls) = store
        .with_read_snapshot(|s| Ok((s.all_nodes()?, s.all_edges()?, s.all_unresolved_calls()?)))
        .map_err(|e| e.to_string())?;

    let file_nodes: HashMap<&str, &NodeV1> = nodes
        .iter()
        .filter(|n| n.kind == "file")
        .map(|n| (n.path.as_str(), n))
        .collect();

    let mut file_cache: HashMap<String, Option<Vec<String>>> = HashMap::new();
    let removed = build_removed_squashed(&changed);

    let mut seeds = Vec::new();
    let mut unindexed = Vec::new();
    let mut deleted = Vec::new();
    let mut seed_nodes_by_file: HashMap<String, Vec<NodeV1>> = HashMap::new();
    let mut declared_seeds = Vec::new();
    let mut merged: HashMap<String, (Impacted, HashSet<String>)> = HashMap::new();
    let mut merged_order: Vec<String> = Vec::new();

    for file in &changed {
        if file.status == ChangeStatus::Deleted {
            deleted.push(file.path.clone());
            continue;
        }
        let Some(&file_node) = file_nodes.get(file.path.as_str()) else {
            unindexed.push(file.path.clone());
            continue;
        };
        let walk_seeds = collect_file_seeds(
            &nodes,
            file,
            file_node,
            opts.seed_all_on_empty_ranges,
            &removed,
            root,
            &mut file_cache,
            &mut seeds,
            &mut declared_seeds,
        );
        seed_nodes_by_file.insert(file.path.clone(), walk_seeds.clone());
        let walk_ids: Vec<String> = walk_seeds.into_iter().map(|n| n.id).collect();
        let hits = store
            .impact_of_many(&walk_ids, opts.depth, Direction::In)
            .map_err(|e| e.to_string())?;
        merge_file_hits(&file.path, hits, &mut merged, &mut merged_order);
    }

    let mut impacted = Vec::with_capacity(merged_order.len());
    let mut origins: HashMap<String, HashSet<String>> = HashMap::new();
    for id in merged_order {
        if let Some((hit, from)) = merged.remove(&id) {
            origins.insert(hit.id.clone(), from);
            impacted.push(hit);
        }
    }

    let index = ModuleIndex::load(out_dir);
    let (modules, test_modules) = group_by_module(&impacted, &changed, &origins, &index);
    let areas = changed_areas(
        &nodes,
        &edges,
        &changed,
        &seed_nodes_by_file,
        &index,
        &modules,
    );
    let unresolved = unresolved_for_seeds(&unresolved_calls, &seeds);
    let left_behind = callers_left_behind(
        &nodes,
        &edges,
        &declared_seeds,
        &changed,
        root,
        &mut file_cache,
    );
    let tests = if opts.tests {
        let all_walk_seeds: Vec<NodeV1> = seed_nodes_by_file.values().flatten().cloned().collect();
        Some(tests_reached(store, &nodes, &all_walk_seeds, &changed)?)
    } else {
        None
    };

    Ok(BlastReport {
        basis,
        depth: opts.depth,
        changed,
        unindexed,
        deleted,
        seeds,
        impacted,
        modules,
        test_modules,
        areas,
        unresolved,
        left_behind,
        tests,
        reviewers: None,
    })
}

fn build_removed_squashed(changed: &[ChangedFile]) -> Vec<Squashed> {
    changed
        .iter()
        .flat_map(|f| {
            f.hunks.iter().map(|h| {
                let rem: Vec<String> = h
                    .lines
                    .iter()
                    .filter(|l| l.sign == "-")
                    .map(|l| l.text.clone())
                    .collect();
                squash_lines(&rem)
            })
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn collect_file_seeds(
    nodes: &[NodeV1],
    file: &ChangedFile,
    file_node: &NodeV1,
    seed_all_on_empty_ranges: bool,
    removed: &[Squashed],
    root: &Path,
    file_cache: &mut HashMap<String, Option<Vec<String>>>,
    seeds: &mut Vec<Seed>,
    declared_seeds: &mut Vec<NodeV1>,
) -> Vec<NodeV1> {
    let symbol_seeds = if !file.ranges.is_empty() {
        seeds_for_file(nodes, &file.path, &file.ranges)
    } else if seed_all_on_empty_ranges {
        nodes
            .iter()
            .filter(|n| n.path == file.path && n.kind != "file" && n.kind != "resource")
            .cloned()
            .collect()
    } else {
        Vec::new()
    };

    for node in &symbol_seeds {
        let decl = declaration_changed(node, file, removed, root, file_cache);
        if decl {
            declared_seeds.push(node.clone());
        }
        seeds.push(Seed {
            id: node.id.clone(),
            name: node.name.clone(),
            kind: node.kind.clone(),
            path: node.path.clone(),
            span: node.span.clone(),
            whole_file: false,
            declaration_changed: is_true(&decl),
        });
    }
    if symbol_seeds.is_empty() || seed_all_on_empty_ranges {
        seeds.push(Seed {
            id: file_node.id.clone(),
            name: file_node.name.clone(),
            kind: file_node.kind.clone(),
            path: file_node.path.clone(),
            span: file_node.span.clone(),
            whole_file: true,
            declaration_changed: false,
        });
    }

    if symbol_seeds.is_empty() {
        vec![file_node.clone()]
    } else if seed_all_on_empty_ranges {
        let mut combined = vec![file_node.clone()];
        combined.extend(symbol_seeds);
        combined
    } else {
        symbol_seeds
    }
}

fn merge_file_hits(
    file_path: &str,
    hits: Vec<EdgeHit>,
    merged: &mut HashMap<String, (Impacted, HashSet<String>)>,
    merged_order: &mut Vec<String>,
) {
    for h in hits {
        let Some(hit) = to_impacted(&h) else {
            continue;
        };
        if let Some((prev, from)) = merged.get_mut(&hit.id) {
            from.insert(file_path.to_string());
            if hit.depth < prev.depth || (hit.depth == prev.depth && prev.inferred && !hit.inferred)
            {
                *prev = hit;
            }
        } else {
            let id = hit.id.clone();
            let mut from = HashSet::new();
            from.insert(file_path.to_string());
            merged.insert(id.clone(), (hit, from));
            merged_order.push(id);
        }
    }
}
