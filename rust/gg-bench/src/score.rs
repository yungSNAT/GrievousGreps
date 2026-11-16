//! Scoring rules for the caller benchmark. No I/O, so the tests run offline.
//!
//! The truth was written in 3 rounds, each with its own row format, and repos.json
//! names the rules each repository was preregistered under:
//!   span   a hit's span contains one of the row's call lines
//!   chain  a hit's qualified name fits the row's chain of enclosing names
//!   names  any part of a hit's qualified name is one of the row's names
//!
//! Answers are `callers --json` output, read as JSON values, so a field the scorer does not use
//! never stops a tool's answer from being scored.

use std::collections::HashMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Rules {
    Span,
    Chain,
    Names,
}

/// A row's chain: the enclosing names, or a marker such as `<file>` (a module-level call) or
/// `<import>` (a reference outside any definition).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Chain {
    Names(Vec<String>),
    Text(String),
}

impl Chain {
    fn is(&self, marker: &str) -> bool {
        matches!(self, Chain::Text(text) if text == marker)
    }

    /// One of the names, or part of the text.
    fn includes(&self, part: &str) -> bool {
        match self {
            Chain::Names(names) => names.iter().any(|name| name == part),
            Chain::Text(text) => text.contains(part),
        }
    }
}

impl fmt::Display for Chain {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Chain::Names(names) => f.write_str(&names.join(",")),
            Chain::Text(text) => f.write_str(text),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct Row {
    pub file: String,
    pub chain: Chain,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<Vec<i64>>,
}

/// One symbol's truth: where it is defined and the calls to it.
#[derive(Clone, Debug, Deserialize)]
pub struct Entry {
    pub target: String,
    #[serde(default)]
    pub target_lines: Vec<i64>,
    pub required: Vec<Row>,
    #[serde(default)]
    pub optional: Vec<Row>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Undercount {
    None,
    Stated,
    Silent,
}

impl fmt::Display for Undercount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Undercount::None => "none",
            Undercount::Stated => "stated",
            Undercount::Silent => "silent",
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolScore {
    pub found: usize,
    pub required: usize,
    pub reported: usize,
    pub missed: Vec<Row>,
    pub false_positives: Vec<Value>,
    pub undercount: Undercount,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub symbols: usize,
    pub found: usize,
    pub required: usize,
    pub recall: f64,
    pub macro_recall: f64,
    pub good: usize,
    pub reported: usize,
    pub precision: Option<f64>,
    pub silent: usize,
    pub stated: usize,
    pub perfect: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Pool {
    pub repositories: usize,
    pub found: usize,
    pub required: usize,
    pub recall: f64,
    pub precision: Option<f64>,
    pub silent: usize,
    pub stated: usize,
}

/// A pinned repository, as repos.json lists it.
#[derive(Clone, Debug, Deserialize)]
pub struct Repo {
    pub name: String,
    pub repository: String,
    pub sha: String,
    pub language: String,
    pub rules: Rules,
}

/// A value as JavaScript's `String()` writes it, with null and a missing value as ''.
fn as_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| as_text(Some(item)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
        Some(other) => other.to_string(),
    }
}

/// The first and last number in a span such as `L4-L6`.
fn line_range(span: Option<&Value>) -> Option<(f64, f64)> {
    let text = as_text(span);
    let mut numbers = text
        .split(|c: char| !c.is_ascii_digit())
        .filter(|run| !run.is_empty());
    let first: f64 = numbers.next()?.parse().ok()?;
    let last = numbers
        .next_back()
        .map_or(Some(first), |run| run.parse().ok())?;
    Some((first, last))
}

pub fn span_contains(span: Option<&Value>, lines: &[i64]) -> bool {
    line_range(span).is_some_and(|(from, to)| {
        lines
            .iter()
            .any(|&line| from <= line as f64 && line as f64 <= to)
    })
}

fn normalise(path: &str) -> String {
    path.replace('\\', "/")
}

/// A string field the scorer needs, or why the answer cannot be scored.
fn text_field<'a>(value: &'a Value, key: &str, what: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{what} without a string `{key}`: {value}"))
}

/// The name path after the `#` of a hit's id, without `~2`-style overload marks.
fn qualified_name(id: &str) -> Option<String> {
    let (_, name) = id.split_once('#')?;
    let mut out = String::with_capacity(name.len());
    let mut chars = name.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '~' && chars.peek().is_some_and(char::is_ascii_digit) {
            while chars.next_if(char::is_ascii_digit).is_some() {}
        } else {
            out.push(c);
        }
    }
    Some(out)
}

/// Splits on `.` and `::`, keeping empty parts.
fn split_name(qualified: &str) -> Vec<&str> {
    let bytes = qualified.as_bytes();
    let (mut parts, mut start, mut at) = (Vec::new(), 0, 0);
    while at < bytes.len() {
        let width = match bytes[at] {
            b'.' => 1,
            b':' if bytes.get(at + 1) == Some(&b':') => 2,
            _ => 0,
        };
        if width == 0 {
            at += 1;
        } else {
            parts.push(&qualified[start..at]);
            at += width;
            start = at;
        }
    }
    parts.push(&qualified[start..]);
    parts
}

fn chain_matches(id: &str, row: &Row) -> bool {
    if row.chain.is("<file>") {
        return true;
    }
    let qualified = qualified_name(id);
    if row.chain.is("<import>") {
        return qualified.is_none();
    }
    qualified.is_some_and(|name| {
        split_name(&name)
            .into_iter()
            .filter(|part| !part.is_empty())
            .all(|part| row.chain.includes(part))
    })
}

fn names_match(id: &str, name: Option<&str>, row: &Row) -> bool {
    if row.chain.is("<file>") {
        return true;
    }
    let qualified = qualified_name(id).unwrap_or_default();
    let parts = split_name(&qualified);
    parts
        .iter()
        .copied()
        .chain([qualified.as_str()])
        .chain(name)
        .any(|part| row.chain.includes(part))
}

/// A hit must be in the row's file, then pass the repository's matcher.
pub fn satisfies(hit: &Value, row: &Row, rules: Rules) -> Result<bool, String> {
    if normalise(text_field(hit, "path", "a hit")?) != row.file {
        return Ok(false);
    }
    Ok(match rules {
        Rules::Span => {
            row.chain.is("<file>")
                || span_contains(hit.get("span"), row.lines.as_deref().unwrap_or_default())
        }
        Rules::Chain => chain_matches(text_field(hit, "id", "a hit")?, row),
        Rules::Names => names_match(
            text_field(hit, "id", "a hit")?,
            hit.get("name").and_then(Value::as_str),
            row,
        ),
    })
}

fn is_target(symbol: Option<&Value>, truth: &Entry, rules: Rules) -> Result<bool, String> {
    let symbol = symbol.ok_or("a match without a `symbol`")?;
    if normalise(text_field(symbol, "path", "a match's symbol")?) != truth.target {
        return Ok(false);
    }
    Ok(rules != Rules::Span || span_contains(symbol.get("span"), &truth.target_lines))
}

/// `callers --json` states a short answer on the target's own match: `unresolved` for calls to
/// the name that resolved to no one definition, or a no-callers `note` that says the name is
/// shared. Notes on other definitions of the name, and quoted code, do not count.
fn states_undercount(found: &Value) -> bool {
    found.get("unresolved").is_some() || as_text(found.get("note")).contains("may undercount")
}

/// A list field, with a missing or null one as empty.
fn list<'a>(value: &'a Value, key: &str) -> Result<&'a [Value], String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(other) => Err(format!("`{key}` is not a list: {other}")),
    }
}

/// The target's hits, one per id: the first place an id appears, with its last hit.
fn target_hits<'a>(targets: &[&'a Value]) -> Result<Vec<&'a Value>, String> {
    let (mut hits, mut at) = (Vec::new(), HashMap::new());
    for found in targets {
        for hit in list(found, "hits")? {
            let id = text_field(hit, "id", "a hit")?;
            match at.get(id) {
                Some(&index) => hits[index] = hit,
                None => {
                    at.insert(id, hits.len());
                    hits.push(hit);
                }
            }
        }
    }
    Ok(hits)
}

/// `Iterator::any` for a test that can fail.
fn any_of<T>(
    items: impl IntoIterator<Item = T>,
    mut test: impl FnMut(T) -> Result<bool, String>,
) -> Result<bool, String> {
    for item in items {
        if test(item)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The required rows no reported hit satisfies.
fn missed_rows(reported: &[&Value], truth: &Entry, rules: Rules) -> Result<Vec<Row>, String> {
    let mut missed = Vec::new();
    for row in &truth.required {
        if !any_of(reported, |hit| satisfies(hit, row, rules))? {
            missed.push(row.clone());
        }
    }
    Ok(missed)
}

/// The reported hits no row accepts. Under span rules a file-level hit (an id without `#`) never
/// counts against precision.
fn false_positives(reported: &[&Value], truth: &Entry, rules: Rules) -> Result<Vec<Value>, String> {
    let mut stray = Vec::new();
    for &hit in reported {
        let counted = rules != Rules::Span || text_field(hit, "id", "a hit")?.contains('#');
        let rows = truth.required.iter().chain(&truth.optional);
        if counted && !any_of(rows, |row| satisfies(hit, row, rules))? {
            stray.push(hit.clone());
        }
    }
    Ok(stray)
}

/// Only hits under the target definition count. Hits under another definition of the same name
/// neither help nor hurt. Optional rows are true references that are not calls: they neither
/// help recall nor hurt precision.
pub fn score_symbol(truth: &Entry, result: &Value, rules: Rules) -> Result<SymbolScore, String> {
    let mut targets = Vec::new();
    for found in list(result, "matches")? {
        if is_target(found.get("symbol"), truth, rules)? {
            targets.push(found);
        }
    }
    let reported = target_hits(&targets)?;
    let missed = missed_rows(&reported, truth, rules)?;
    let undercount = match (
        missed.is_empty(),
        targets.iter().any(|found| states_undercount(found)),
    ) {
        (true, _) => Undercount::None,
        (false, true) => Undercount::Stated,
        (false, false) => Undercount::Silent,
    };
    Ok(SymbolScore {
        found: truth.required.len() - missed.len(),
        required: truth.required.len(),
        reported: reported.len(),
        false_positives: false_positives(&reported, truth, rules)?,
        missed,
        undercount,
    })
}

fn ratio(part: usize, whole: usize) -> f64 {
    part as f64 / whole as f64
}

pub fn summarise(scores: &[SymbolScore]) -> Summary {
    let sum = |pick: fn(&SymbolScore) -> usize| scores.iter().map(pick).sum::<usize>();
    let (found, required, reported) = (sum(|s| s.found), sum(|s| s.required), sum(|s| s.reported));
    let good = reported - sum(|s| s.false_positives.len());
    let count = |undercount| scores.iter().filter(|s| s.undercount == undercount).count();
    Summary {
        symbols: scores.len(),
        found,
        required,
        recall: ratio(found, required),
        macro_recall: scores
            .iter()
            .fold(0.0, |total, s| total + ratio(s.found, s.required))
            / scores.len() as f64,
        good,
        reported,
        precision: (reported != 0).then(|| ratio(good, reported)),
        silent: count(Undercount::Silent),
        stated: count(Undercount::Stated),
        perfect: scores
            .iter()
            .filter(|s| s.missed.is_empty() && s.false_positives.is_empty())
            .count(),
    }
}

/// Pools every repository, so a repository with many calls weighs more.
pub fn pool(summaries: &[Summary]) -> Pool {
    let sum = |pick: fn(&Summary) -> usize| summaries.iter().map(pick).sum::<usize>();
    let (found, required, good, reported) = (
        sum(|s| s.found),
        sum(|s| s.required),
        sum(|s| s.good),
        sum(|s| s.reported),
    );
    Pool {
        repositories: summaries.len(),
        found,
        required,
        recall: ratio(found, required),
        precision: (reported != 0).then(|| ratio(good, reported)),
        silent: sum(|s| s.silent),
        stated: sum(|s| s.stated),
    }
}

/// 2 decimals as JavaScript's `toFixed(2)` writes them, which the README's figures came from. It
/// rounds a value exactly halfway between 2 hundredths away from zero, where Rust's formatter
/// rounds it to even. Only an odd number of eighths can be exactly halfway: a third decimal of 5
/// is a fraction over 200, which a binary fraction reaches only when 25 divides it out.
pub fn two(value: Option<f64>) -> String {
    let Some(value) = value else {
        return "n/a".to_owned();
    };
    let eighths = value * 8.0;
    let halfway = eighths.is_finite() && eighths.fract() == 0.0 && eighths.abs() % 2.0 == 1.0;
    let nudged = if halfway {
        value + value.signum() * 0.001
    } else {
        value
    };
    format!("{nudged:.2}")
}

/// The line and table the README carries.
pub fn overall_line(upstream: Option<&[Summary]>, patched: &[Summary]) -> String {
    let p = pool(patched);
    let counted = format!(
        "{} repositories and {} of {} calls",
        p.repositories, p.found, p.required
    );
    let Some(upstream) = upstream else {
        return format!(
            "**Overall:** recall {} ({counted}), precision {}, silent undercounts {}.",
            two(Some(p.recall)),
            two(p.precision),
            p.silent
        );
    };
    let u = pool(upstream);
    format!(
        "**Overall, upstream to patched:** recall {} to {} ({counted} on the patched build), precision {} to {}, silent undercounts {} to {}.",
        two(Some(u.recall)),
        two(Some(p.recall)),
        two(u.precision),
        two(p.precision),
        u.silent,
        p.silent,
    )
}

pub type Summaries = HashMap<String, Summary>;

pub fn recall_table(repos: &[Repo], upstream: Option<&Summaries>, patched: &Summaries) -> String {
    let mut columns = vec!["Repository", "Language", "Calls in truth"];
    if upstream.is_some() {
        columns.push("Upstream");
    }
    columns.push("Patched");
    let mut lines = vec![
        format!("| {} |", columns.join(" | ")),
        format!("|{}|", vec![" --- "; columns.len()].join("|")),
    ];
    for repo in repos {
        let mine = &patched[&repo.name];
        let mut cells = vec![
            format!(
                "{} @ {}",
                repo.repository,
                repo.sha.get(..7).unwrap_or(&repo.sha)
            ),
            repo.language.clone(),
            mine.required.to_string(),
        ];
        if let Some(upstream) = upstream {
            cells.push(two(Some(upstream[&repo.name].recall)));
        }
        cells.push(two(Some(mine.recall)));
        lines.push(format!("| {} |", cells.join(" | ")));
    }
    lines.join("\n")
}

pub fn detail_table(repos: &[Repo], label: &str, summaries: &Summaries) -> String {
    let mut lines = vec![
        format!("{label}:"),
        "| Repository | Recall | Macro recall | Precision | Silent | Stated | Perfect |".to_owned(),
        "| --- | --- | --- | --- | --- | --- | --- |".to_owned(),
    ];
    for repo in repos {
        let s = &summaries[&repo.name];
        lines.push(format!(
            "| {} | {}/{} = {} | {} | {}/{} = {} | {} | {} | {}/{} |",
            repo.name,
            s.found,
            s.required,
            two(Some(s.recall)),
            two(Some(s.macro_recall)),
            s.good,
            s.reported,
            two(s.precision),
            s.silent,
            s.stated,
            s.perfect,
            s.symbols,
        ));
    }
    lines.join("\n")
}
