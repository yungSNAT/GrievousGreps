//! Renderers for `BlastReport`: Mermaid, Markdown, and plain text (`src/blast/render.ts`).

mod details;
mod mermaid;

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::blast::owners::{MAX_REVIEWERS, now_ms, since_label};
use crate::blast::{BlastReport, ImpactedModule, LeftBehind, TestReach, TestSignal};
use crate::brand::{brand_name, cmd};
use crate::graph::INFERRED_MARK;

use details::{detail_sections, owner_section};
pub use mermaid::mermaid_diagram;
use mermaid::{caveat_lines, headline, left_behind_line, tag_line, test_headline};

const MAX_TABLE_ROWS: usize = 6;
pub(super) const NO_EDGE_NOTE: &str =
    "a test that runs the code through a CLI or a spawned process has no edge, so it is not listed";

pub(super) fn plural(n: usize, one: &str, many: Option<&str>) -> String {
    if n == 1 {
        format!("{n} {one}")
    } else if let Some(m) = many {
        format!("{n} {m}")
    } else {
        format!("{n} {one}s")
    }
}

pub(super) fn depth_label(depth: usize) -> String {
    if depth == usize::MAX {
        "full closure".to_string()
    } else {
        format!("depth {depth}")
    }
}

pub(super) fn inferred_mark(inferred: bool) -> &'static str {
    if inferred { INFERRED_MARK } else { "" }
}

pub(super) fn inferred_count(r: &BlastReport) -> String {
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

pub(super) fn test_glyph(t: TestSignal) -> &'static str {
    match t {
        TestSignal::Changed => "✓",
        TestSignal::Stale => "⚠",
        TestSignal::None => "✗",
        TestSignal::Na => "–",
    }
}

pub(super) fn caller_at(c: &LeftBehind) -> String {
    match c.line {
        Some(l) => format!("{}:{l}", c.path),
        None => format!("{}:{}", c.path, c.span),
    }
}

pub(super) fn test_reach_label(t: &TestReach) -> String {
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
        // Never None here: symbols > 0 means at least one module to draw.
        out.extend(mermaid_diagram(r).into_iter().flat_map(|diagram| {
            [
                String::new(),
                "```mermaid".to_string(),
                diagram,
                "```".to_string(),
            ]
        }));
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
