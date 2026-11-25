//! Renderers for `BlastReport`: Mermaid, Markdown, and plain text (`src/blast/render.ts`).

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::blast::owners::{MAX_REVIEWERS, Owner, mention, now_ms, since_label};
use crate::blast::{BlastReport, Impacted, ImpactedModule, LeftBehind, TestReach, TestSignal};
use crate::brand::{brand_name, cmd};
use crate::graph::{INFERRED_MARK, Quote, is_deploy_file, reference_line};

const MAX_MODULE_BOXES: usize = 5;
const MAX_TABLE_ROWS: usize = 6;
const MAX_SYMBOLS_LISTED: usize = 60;
const MAX_OWNER_ROWS: usize = 8;
const MAX_LEFT_BEHIND_NAMED: usize = 5;
const MAX_TESTS_LISTED: usize = 20;
const NO_EDGE_NOTE: &str =
    "a test that runs the code through a CLI or a spawned process has no edge, so it is not listed";

fn plural(n: usize, one: &str, many: Option<&str>) -> String {
    if n == 1 {
        format!("{n} {one}")
    } else if let Some(m) = many {
        format!("{n} {m}")
    } else {
        format!("{n} {one}s")
    }
}

fn depth_label(depth: usize) -> String {
    if depth == usize::MAX {
        "full closure".to_string()
    } else {
        format!("depth {depth}")
    }
}

fn inferred_mark(inferred: bool) -> &'static str {
    if inferred { INFERRED_MARK } else { "" }
}

fn inferred_count(r: &BlastReport) -> String {
    let n: usize = r
        .modules
        .iter()
        .map(|m| m.symbols.iter().filter(|s| s.inferred).count())
        .sum();
    if n > 0 {
        format!(" ({n}{INFERRED_MARK})")
    } else {
        String::new()
    }
}

fn test_glyph(t: TestSignal) -> &'static str {
    match t {
        TestSignal::Changed => "✓",
        TestSignal::Stale => "⚠",
        TestSignal::None => "✗",
        TestSignal::Na => "–",
    }
}

fn caller_at(c: &LeftBehind) -> String {
    match c.line {
        Some(l) => format!("{}:{l}", c.path),
        None => format!("{}:{}", c.path, c.span),
    }
}

fn test_reach_label(t: &TestReach) -> String {
    if t.changed {
        return "changed in this diff".to_string();
    }
    let shown: Vec<&str> = t.symbols.iter().take(3).map(String::as_str).collect();
    let names = if t.symbols.len() > 3 {
        format!("{} +{}", shown.join(", "), t.symbols.len() - 3)
    } else {
        shown.join(", ")
    };
    let tail = if names.is_empty() {
        String::new()
    } else {
        format!(" · {names}")
    };
    format!("depth {}{}{tail}", t.depth, inferred_mark(t.inferred))
}

fn escape_mermaid(text: &str) -> String {
    text.replace('"', "#quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn mermaid_label(lines: &[String]) -> String {
    let escaped: Vec<String> = lines.iter().map(|s| escape_mermaid(s)).collect();
    format!("\"{}\"", escaped.join("<br/>"))
}

pub fn mermaid_diagram(r: &BlastReport) -> Option<String> {
    let shown: Vec<&ImpactedModule> = r.modules.iter().take(MAX_MODULE_BOXES).collect();
    if shown.is_empty() {
        return None;
    }
    let hidden: Vec<&ImpactedModule> = r.modules.iter().skip(MAX_MODULE_BOXES).collect();

    let mut lines = vec!["flowchart TB".to_string()];
    for (i, m) in shown.iter().enumerate() {
        lines.push(format!(
            "  A{i}(({}))",
            mermaid_label(&[m.label.clone(), plural(m.symbols.len(), "symbol", None)])
        ));
    }
    if !hidden.is_empty() {
        let sym_count: usize = hidden.iter().map(|m| m.symbols.len()).sum();
        lines.push(format!(
            "  AX(({}))",
            mermaid_label(&[
                plural(hidden.len(), "smaller area", None),
                plural(sym_count, "symbol", None),
            ])
        ));
    }
    lines.push(
        "  classDef reached fill:#D9EDF3,stroke:#3AA7C9,stroke-width:1.5px,color:#0E313C;"
            .to_string(),
    );
    let nodes_list: Vec<String> = (0..shown.len()).map(|i| format!("A{i}")).collect();
    lines.push(format!("  class {} reached;", nodes_list.join(",")));
    if !hidden.is_empty() {
        lines.push(
            "  classDef tail fill:#EEF2F3,stroke:#9AA4A9,stroke-width:1px,color:#3A4247;"
                .to_string(),
        );
        lines.push("  class AX tail;".to_string());
    }
    Some(lines.join("\n"))
}

fn headline(r: &BlastReport, symbols: usize) -> String {
    let areas = plural(r.areas.len(), "area", None);
    if symbols == 0 {
        let unresolved: usize = r.unresolved.iter().map(|u| u.calls).sum();
        let lead = if unresolved > 0 {
            let verb = if unresolved == 1 { "names" } else { "name" };
            format!(
                "No resolved dependents; {} {verb} a changed symbol.",
                plural(unresolved, "unresolved call", None)
            )
        } else {
            "No resolved dependents.".to_string()
        };
        return format!(
            "**{lead}** {areas} changed; no indexed dependents at {}.",
            depth_label(r.depth)
        );
    }
    format!(
        "**{areas} changed → {} can be affected.** {}{}, {}.",
        plural(r.modules.len(), "area", None),
        plural(symbols, "dependent symbol", None),
        inferred_count(r),
        depth_label(r.depth)
    )
}

fn test_headline(r: &BlastReport) -> Option<String> {
    if r.areas.is_empty() {
        return None;
    }
    let none: Vec<&str> = r
        .areas
        .iter()
        .filter(|a| a.tests == TestSignal::None)
        .map(|a| a.label.as_str())
        .collect();
    let stale: Vec<&str> = r
        .areas
        .iter()
        .filter(|a| a.tests == TestSignal::Stale)
        .map(|a| a.label.as_str())
        .collect();
    let changed_count = r
        .areas
        .iter()
        .filter(|a| a.tests == TestSignal::Changed)
        .count();

    let mut parts = Vec::new();
    if !none.is_empty() {
        parts.push(format!("**no test reaches {}**", none.join(", ")));
    }
    if !stale.is_empty() {
        let verb = if stale.len() == 1 { "has" } else { "have" };
        parts.push(format!(
            "{} {verb} tests the diff did not touch",
            stale.join(", ")
        ));
    }
    if changed_count > 0 {
        let pron = if changed_count == 1 { "its" } else { "their" };
        parts.push(format!(
            "{} updated {pron} tests",
            plural(changed_count, "area", None)
        ));
    }
    (!parts.is_empty()).then(|| format!("Tests: {}.", parts.join("; ")))
}

fn left_behind_line(r: &BlastReport) -> Option<String> {
    let behind = &r.left_behind;
    if behind.is_empty() {
        return None;
    }
    let named: Vec<String> = behind
        .iter()
        .take(MAX_LEFT_BEHIND_NAMED)
        .map(|c| {
            format!(
                "`{}` (`{}`){}",
                c.name,
                caller_at(c),
                inferred_mark(c.inferred)
            )
        })
        .collect();
    let more = if behind.len() > MAX_LEFT_BEHIND_NAMED {
        format!(
            ", +{} more, all in `--format json`",
            behind.len() - MAX_LEFT_BEHIND_NAMED
        )
    } else {
        String::new()
    };
    let pron = if behind.len() == 1 {
        "its call"
    } else {
        "their calls"
    };
    Some(format!(
        "⚠️ **{} left behind** by a changed declaration: {}{more}. The diff did not edit {pron}.",
        plural(behind.len(), "caller", None),
        named.join(", ")
    ))
}

fn tag_line(r: &BlastReport) -> Option<String> {
    let people = r.reviewers.as_deref()?;
    if people.is_empty() {
        return None;
    }
    let total = r.areas.len() + r.modules.len();
    let bits: Vec<String> = people
        .iter()
        .map(|p| {
            let who = match &p.handle {
                Some(h) => format!("@{h}"),
                None => format!("**{}**", p.name),
            };
            let why = if p.areas.len() >= 3 {
                format!("{} of {total} areas", p.areas.len())
            } else {
                p.areas.join(", ")
            };
            format!("{who} — {why}")
        })
        .collect();
    Some(format!("Tag: {}", bits.join(" · ")))
}

fn impact_table(r: &BlastReport) -> Vec<String> {
    let shown = r.modules.iter().take(MAX_TABLE_ROWS);
    let hidden: Vec<&ImpactedModule> = r.modules.iter().skip(MAX_TABLE_ROWS).collect();
    let mut area_of: HashMap<&str, &str> = HashMap::new();
    for a in &r.areas {
        for f in &a.files {
            area_of.insert(f.as_str(), a.label.as_str());
        }
    }

    let mut rows = vec![
        "| Can be affected | Symbols | Nearest hop | Reached from |".to_string(),
        "| --- | --: | --- | --- |".to_string(),
    ];
    for mod_item in shown {
        let hop = match mod_item.symbols.first() {
            Some(s) => format!(
                "`{}:{}` {} — {}, depth {}{}",
                s.path,
                s.span,
                s.name,
                s.relation,
                s.depth,
                inferred_mark(s.inferred)
            ),
            None => "—".to_string(),
        };
        let mut names = Vec::new();
        let mut seen = HashSet::new();
        for f in &mod_item.from {
            let label = area_of.get(f.as_str()).copied().unwrap_or(f.as_str());
            if seen.insert(label) {
                names.push(label);
            }
        }
        let from = if names.is_empty() {
            "—".to_string()
        } else if names.len() <= 2 {
            names.join(", ")
        } else {
            format!("{}, {} +{}", names[0], names[1], names.len() - 2)
        };
        rows.push(format!(
            "| {} | {} | {hop} | {from} |",
            mod_item.label,
            mod_item.symbols.len()
        ));
    }
    if !hidden.is_empty() {
        let symbols: usize = hidden.iter().map(|m| m.symbols.len()).sum();
        let labels: Vec<&str> = hidden.iter().take(3).map(|m| m.label.as_str()).collect();
        let ellipsis = if hidden.len() > 3 { ", …" } else { "" };
        rows.push(format!(
            "| _{}_ | {symbols} | {}{ellipsis} | see below |",
            plural(hidden.len(), "smaller area", None),
            labels.join(", ")
        ));
    }
    rows
}

fn owner_cell(owners: Option<&[Owner]>, now: f64) -> String {
    let Some(list) = owners.filter(|l| !l.is_empty()) else {
        return "_only you — nobody else has touched these files_".to_string();
    };
    list.iter()
        .map(|o| {
            format!(
                "{} — {}, last {}",
                mention(o),
                plural(o.commits, "commit", None),
                since_label(o.last, now)
            )
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

fn owner_section(r: &BlastReport, now: f64) -> Vec<String> {
    if r.reviewers.is_none() {
        return Vec::new();
    }
    let mut rows: Vec<(&str, &str, Option<&[Owner]>)> = Vec::new();
    for a in &r.areas {
        rows.push((&a.label, "changed", a.owners.as_deref()));
    }
    for m in &r.modules {
        rows.push((&m.label, "affected", m.owners.as_deref()));
    }
    let named: Vec<_> = rows
        .iter()
        .copied()
        .filter(|(_, _, o)| o.is_some_and(|l| !l.is_empty()))
        .collect();
    if named.is_empty() {
        return Vec::new();
    }
    let mut people = HashSet::new();
    for (_, _, o) in &rows {
        for owner in o.unwrap_or(&[]) {
            people.insert(owner.handle.as_deref().unwrap_or(owner.name.as_str()));
        }
    }
    let mut ordered = named;
    for row in &rows {
        if !row.2.is_some_and(|l| !l.is_empty()) {
            ordered.push(*row);
        }
    }
    let mut out = vec![
        "<details>".to_string(),
        format!(
            "<summary><strong>Who knows this code</strong> — {} across {}</summary>",
            plural(people.len(), "person", Some("people")),
            plural(rows.len(), "area", None)
        ),
        String::new(),
        "| Area | Who knows it |".to_string(),
        "| --- | --- |".to_string(),
    ];
    for &(label, side, owners) in ordered.iter().take(MAX_OWNER_ROWS) {
        out.push(format!(
            "| **{label}** · {side} | {} |",
            owner_cell(owners, now)
        ));
    }
    if ordered.len() > MAX_OWNER_ROWS {
        out.push(format!(
            "| _…{}_ | |",
            plural(ordered.len() - MAX_OWNER_ROWS, "further area", None)
        ));
    }
    out.push(String::new());
    out.push(
        "_Ownership is git history over each area's own files, weighted towards recent work \
         (120-day half-life). Merge commits and bots are dropped, and you are dropped from your own PR. \
         A name with no `@` has no GitHub handle in its commit email — tag them by hand, or add a \
         `.mailmap` entry. A suggestion from history, not a CODEOWNERS rule._"
            .to_string(),
    );
    out.push(String::new());
    out.push("</details>".to_string());
    out
}

fn find_evidence_line(
    root: Option<&Path>,
    sym: &Impacted,
    names: &[String],
    stems: &[String],
    cache: &mut HashMap<String, Option<Vec<String>>>,
) -> Option<Quote> {
    let r = root?;
    for name in names {
        if let Some(q) = reference_line(r, &sym.path, &sym.span, name, cache) {
            return Some(q);
        }
    }
    if stems.is_empty() || is_deploy_file(&sym.path) {
        return None;
    }
    let abs = crate::graph::safe_resolve_inside(r, &sym.path)?;
    let raw = std::fs::read_to_string(abs).ok()?;
    let (start, end) = crate::graph::span_range(&sym.span)?;
    for (idx, line) in raw
        .lines()
        .enumerate()
        .take(end)
        .skip(start.saturating_sub(1))
    {
        if line_mentions_module(line, stems) {
            return Some(Quote {
                n: idx + 1,
                text: line.to_string(),
            });
        }
    }
    None
}

fn line_mentions_module(line: &str, stems: &[String]) -> bool {
    for quote in ['"', '\'', '`'] {
        let mut rest = line;
        while let Some(open) = rest.find(quote) {
            let after_open = &rest[open + 1..];
            let Some(close) = after_open.find(quote) else {
                break;
            };
            let spec = &after_open[..close];
            for stem in stems {
                if let Some(pos) = spec.find(stem.as_str()) {
                    let before_ok = pos == 0
                        || !spec.as_bytes()[pos - 1].is_ascii_alphanumeric()
                            && spec.as_bytes()[pos - 1] != b'_';
                    let after = &spec[pos + stem.len()..];
                    let after_ok = after.is_empty()
                        || after.strip_prefix('.').is_some_and(|e| {
                            !e.is_empty() && e.bytes().all(|b| b.is_ascii_lowercase())
                        });
                    if before_ok && after_ok {
                        return true;
                    }
                }
            }
            rest = &after_open[close + 1..];
        }
    }
    false
}

fn detail_all_symbols(
    r: &BlastReport,
    symbols: usize,
    root: Option<&Path>,
    names: &[String],
    stems: &[String],
    cache: &mut HashMap<String, Option<Vec<String>>>,
    out: &mut Vec<String>,
) {
    if symbols == 0 {
        return;
    }
    out.push("<details>".to_string());
    out.push(format!(
        "<summary><strong>All {}</strong>, grouped by area</summary>",
        plural(symbols, "dependent symbol", None)
    ));
    out.push(String::new());
    let mut listed = 0_usize;
    for mod_item in &r.modules {
        out.push(format!(
            "**{}** — {} in {}",
            mod_item.label,
            plural(mod_item.symbols.len(), "symbol", None),
            plural(mod_item.files.len(), "file", None)
        ));
        out.push(String::new());
        for s in &mod_item.symbols {
            if listed >= MAX_SYMBOLS_LISTED {
                break;
            }
            listed += 1;
            out.push(format!(
                "- `{}:{}` — {} ({}, depth {}){}",
                s.path,
                s.span,
                s.name,
                s.relation,
                s.depth,
                inferred_mark(s.inferred)
            ));
            if let Some(q) = find_evidence_line(root, s, names, stems, cache) {
                out.push(format!("  ```{}: {}```", q.n, q.text.trim()));
            }
        }
        out.push(String::new());
        if listed >= MAX_SYMBOLS_LISTED {
            out.push(format!(
                "…{} not listed.",
                plural(symbols - listed, "further symbol", None)
            ));
            out.push(String::new());
            break;
        }
    }
    out.push("</details>".to_string());
}

fn detail_test_signal(r: &BlastReport, out: &mut Vec<String>) {
    if r.areas.is_empty() {
        return;
    }
    let count_sig = |sig: TestSignal| r.areas.iter().filter(|a| a.tests == sig).count();
    let states = [
        (count_sig(TestSignal::Changed), "✓"),
        (count_sig(TestSignal::Stale), "⚠"),
        (count_sig(TestSignal::None), "✗"),
        (count_sig(TestSignal::Na), "–"),
    ]
    .into_iter()
    .filter(|(c, _)| *c > 0)
    .map(|(c, g)| format!("{c} {g}"))
    .collect::<Vec<_>>()
    .join(" · ");
    out.push("<details>".to_string());
    out.push(format!(
        "<summary><strong>Test signal</strong> per changed area — {states}</summary>"
    ));
    out.push(String::new());
    out.push(
        "_Reached = a node under a test path has a resolved edge into the changed symbol. \
         It undercounts anything called indirectly — through a CLI, a spawned process or a dynamic import — \
         so read a low ratio as “look here”, never as a coverage gate._"
            .to_string(),
    );
    out.push(String::new());
    for a in &r.areas {
        let mut bits = Vec::new();
        if a.behavioural > 0 {
            bits.push(format!("{} of {} reached", a.reached, a.behavioural));
        }
        if !a.changed_test_files.is_empty() {
            let list: Vec<String> = a
                .changed_test_files
                .iter()
                .map(|f| format!("`{f}`"))
                .collect();
            bits.push(format!(
                "{} changed here: {}",
                plural(a.changed_test_files.len(), "test file", None),
                list.join(", ")
            ));
        } else if !a.test_files.is_empty() {
            let verb = if a.test_files.len() == 1 {
                "reaches"
            } else {
                "reach"
            };
            bits.push(format!(
                "{} {verb} it, none changed here",
                plural(a.test_files.len(), "test file", None)
            ));
        } else if a.behavioural > 0 {
            bits.push("no test file reaches it".to_string());
        } else {
            bits.push("no function, method or class changed here".to_string());
        }
        out.push(format!(
            "- {} **{}** — {}",
            test_glyph(a.tests),
            a.label,
            bits.join(" · ")
        ));
        if !a.unreached.is_empty() {
            let shown: Vec<String> = a
                .unreached
                .iter()
                .take(8)
                .map(|n| format!("`{n}`"))
                .collect();
            let tail = if a.unreached.len() > 8 {
                format!(", …{} more", a.unreached.len() - 8)
            } else {
                String::new()
            };
            out.push(format!("  - not reached: {}{tail}", shown.join(", ")));
        }
    }
    out.push(String::new());
    out.push("</details>".to_string());
}

fn detail_sections(r: &BlastReport, symbols: usize, root: Option<&Path>) -> Vec<String> {
    let mut out = Vec::new();
    let mut names: Vec<String> = r
        .seeds
        .iter()
        .filter(|s| !s.whole_file)
        .map(|s| s.name.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    names.sort_by_key(|a| std::cmp::Reverse(a.len()));
    let stems: Vec<String> = r
        .changed
        .iter()
        .filter_map(|f| {
            let base = f.path.rsplit('/').next().unwrap_or(&f.path);
            let stem = match base.rfind('.') {
                Some(idx) => &base[..idx],
                None => base,
            };
            (!stem.is_empty()).then(|| stem.to_string())
        })
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let mut cache = HashMap::new();

    detail_all_symbols(r, symbols, root, &names, &stems, &mut cache, &mut out);
    detail_test_signal(r, &mut out);

    if let Some(ref tests) = r.tests {
        out.push("<details>".to_string());
        let summary_count = if tests.is_empty() {
            "none found".to_string()
        } else {
            plural(tests.len(), "test file", None)
        };
        out.push(format!(
            "<summary><strong>Tests reaching this change</strong> — {summary_count}, full closure</summary>"
        ));
        out.push(String::new());
        for t in tests.iter().take(MAX_TESTS_LISTED) {
            out.push(format!("- `{}` — {}", t.path, test_reach_label(t)));
        }
        if tests.len() > MAX_TESTS_LISTED {
            out.push(format!(
                "- …{} more, all in `--format json`",
                tests.len() - MAX_TESTS_LISTED
            ));
        }
        out.push(String::new());
        out.push(format!("_Note: {NO_EDGE_NOTE}._"));
        out.push(String::new());
        out.push("</details>".to_string());
    }

    if !r.test_modules.is_empty() {
        let symbol_count: usize = r.test_modules.iter().map(|m| m.symbols.len()).sum();
        let mut sorted_files: Vec<String> = r
            .test_modules
            .iter()
            .flat_map(|m| m.files.iter().cloned())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        sorted_files.sort();
        let verb = if sorted_files.len() == 1 {
            "references"
        } else {
            "reference"
        };
        out.push("<details>".to_string());
        out.push(format!(
            "<summary>{} also {verb} this code</summary>",
            plural(sorted_files.len(), "test suite", None)
        ));
        out.push(String::new());
        out.push(format!(
            "{}, kept out of the diagram and the table so they cannot crowd out the areas a reviewer has to look at.",
            plural(symbol_count, "symbol", None)
        ));
        out.push(String::new());
        for f in sorted_files.iter().take(20) {
            out.push(format!("- `{f}`"));
        }
        if sorted_files.len() > 20 {
            out.push(format!("- …{} more", sorted_files.len() - 20));
        }
        out.push(String::new());
        out.push("</details>".to_string());
    }

    out
}

fn caveat_lines(r: &BlastReport) -> Vec<String> {
    let mut out = Vec::new();
    if !r.deleted.is_empty() {
        let sample: Vec<&str> = r.deleted.iter().take(5).map(String::as_str).collect();
        out.push(format!(
            "⚠️ {} ({}) — their dependents cannot be computed from a graph built at this commit, since the files are gone from it.",
            plural(r.deleted.len(), "deleted file", None),
            sample.join(", ")
        ));
    }
    if !r.unindexed.is_empty() {
        let sample: Vec<&str> = r.unindexed.iter().take(5).map(String::as_str).collect();
        out.push(format!(
            "⚠️ {} not in the graph ({}) — no parser claims the extension, or the index predates the file.",
            plural(r.unindexed.len(), "changed file", None),
            sample.join(", ")
        ));
    }
    if !r.unresolved.is_empty() {
        let calls: usize = r.unresolved.iter().map(|u| u.calls).sum();
        let names: Vec<String> = r
            .unresolved
            .iter()
            .take(5)
            .map(|u| format!("{} ({})", u.name, u.calls))
            .collect();
        out.push(format!(
            "⚠️ {} naming a changed symbol ({}) did not resolve to one definition — their callers are not counted above, so this may undercount. `{} <name>` lists them.",
            plural(calls, "call", None),
            names.join(", "),
            cmd("graft callers")
        ));
    }
    out
}

pub fn markdown_report(r: &BlastReport, root: Option<&Path>) -> String {
    let mut out = Vec::new();
    let symbols: usize = r.modules.iter().map(|m| m.symbols.len()).sum();
    out.push(format!("### 🌱 {} blast radius", brand_name()));
    out.push(String::new());
    out.push(headline(r, symbols));
    if let Some(tl) = test_headline(r) {
        out.push(tl);
    }
    if let Some(lb) = left_behind_line(r) {
        out.push(lb);
    }
    if let Some(tg) = tag_line(r) {
        out.push(tg);
    }
    if symbols > 0 {
        if let Some(diagram) = mermaid_diagram(r) {
            out.push(String::new());
            out.push("```mermaid".to_string());
            out.push(diagram);
            out.push("```".to_string());
        }
        out.push(String::new());
        out.extend(impact_table(r));
    }
    let now = now_ms();
    let owners = owner_section(r, now);
    if !owners.is_empty() {
        out.push(String::new());
        out.extend(owners);
    }
    out.push(String::new());
    out.extend(detail_sections(r, symbols, root));
    let caveats = caveat_lines(r);
    if !caveats.is_empty() {
        out.push(String::new());
        out.extend(caveats);
    }
    out.push(String::new());
    out.push(format!(
        "<sub>`{}` · {} · {} · {}</sub>",
        cmd("graft blast"),
        r.basis,
        depth_label(r.depth),
        plural(r.changed.len(), "changed file", None)
    ));
    format!("{}\n", out.join("\n"))
}

pub fn text_report(r: &BlastReport) -> String {
    let symbols: usize = r.modules.iter().map(|m| m.symbols.len()).sum();
    let mut lines = vec![
        format!("blast radius — {} ({})", r.basis, depth_label(r.depth)),
        format!(
            "  changed: {} in {}, {}",
            plural(r.changed.len(), "file", None),
            plural(r.areas.len(), "area", None),
            plural(r.seeds.len(), "seed symbol", None)
        ),
        format!(
            "  impacted: {}{} in {}",
            plural(symbols, "symbol", None),
            inferred_count(r),
            plural(r.modules.len(), "area", None)
        ),
        String::new(),
    ];

    for a in &r.areas {
        lines.push(format!(
            "{} {} — {}, {}/{} reached by a test",
            test_glyph(a.tests),
            a.label,
            plural(a.files.len(), "changed file", None),
            a.reached,
            a.behavioural
        ));
    }
    if !r.areas.is_empty() {
        lines.push(String::new());
    }

    if !r.left_behind.is_empty() {
        let pron = if r.left_behind.len() == 1 {
            "it calls"
        } else {
            "each calls"
        };
        lines.push(format!(
            "⚠ {} left behind: {pron} a symbol whose declaration changed, and the diff did not edit the call",
            plural(r.left_behind.len(), "caller", None)
        ));
        for c in &r.left_behind {
            lines.push(format!(
                "  {} ← {} ({}){}",
                c.seed.name,
                c.name,
                caller_at(c),
                inferred_mark(c.inferred)
            ));
        }
        lines.push(String::new());
    }

    for mod_item in &r.modules {
        lines.push(format!(
            "{} — {} in {}",
            mod_item.label,
            plural(mod_item.symbols.len(), "symbol", None),
            plural(mod_item.files.len(), "file", None)
        ));
        for s in mod_item.symbols.iter().take(25) {
            lines.push(format!(
                "  {} ← {} ({}:{}) [depth {}]{}",
                s.relation,
                s.name,
                s.path,
                s.span,
                s.depth,
                inferred_mark(s.inferred)
            ));
        }
        if mod_item.symbols.len() > 25 {
            lines.push(format!(
                "  …{}",
                plural(mod_item.symbols.len() - 25, "more symbol", None)
            ));
        }
        lines.push(String::new());
    }

    if symbols == 0 {
        lines.push("no indexed dependents outside the changed files themselves".to_string());
        lines.push(String::new());
    }
    text_report_footer(r, &mut lines);
    format!("{}\n", lines.join("\n").trim_end_matches('\n'))
}

fn text_report_footer(r: &BlastReport, lines: &mut Vec<String>) {
    if !r.test_modules.is_empty() {
        let files: HashSet<&str> = r
            .test_modules
            .iter()
            .flat_map(|m| m.files.iter().map(String::as_str))
            .collect();
        let verb = if files.len() == 1 {
            "references"
        } else {
            "reference"
        };
        lines.push(format!(
            "{} also {verb} this code (not listed)",
            plural(files.len(), "test suite", None)
        ));
        lines.push(String::new());
    }

    if let Some(ref tests) = r.tests {
        let header_tail = if tests.is_empty() {
            format!("none found ({NO_EDGE_NOTE})")
        } else {
            plural(tests.len(), "file", None)
        };
        lines.push(format!(
            "tests reaching this change (full closure): {header_tail}"
        ));
        for t in tests {
            lines.push(format!("  {} — {}", t.path, test_reach_label(t)));
        }
        lines.push(String::new());
    }

    if let Some(ref reviewers) = r.reviewers
        && !reviewers.is_empty()
    {
        let now = now_ms();
        lines.push("who to tag".to_string());
        for p in reviewers.iter().take(MAX_REVIEWERS) {
            let why = if p.areas.len() >= 3 {
                format!("{} areas", p.areas.len())
            } else {
                p.areas.join(", ")
            };
            let handle_or_name = match &p.handle {
                Some(h) => format!("@{h}"),
                None => p.name.clone(),
            };
            lines.push(format!(
                "  {handle_or_name} — {why} · {}, last {}",
                plural(p.commits, "commit", None),
                since_label(p.last, now)
            ));
        }
        lines.push(String::new());
    }

    for c in caveat_lines(r) {
        lines.push(c.replace("⚠️ ", "⚠ "));
        lines.push(String::new());
    }
}
