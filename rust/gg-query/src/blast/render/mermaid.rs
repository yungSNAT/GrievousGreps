//! Mermaid diagram and headline/caveat formatters for `blast::render`.

use crate::blast::{BlastReport, ImpactedModule, TestSignal};
use crate::brand::cmd;
use crate::graph::INFERRED_MARK;

use super::{caller_at, depth_label, inferred_count, inferred_mark, plural};

const MAX_MODULE_BOXES: usize = 5;
const MAX_LEFT_BEHIND_NAMED: usize = 5;

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

pub(super) fn headline(r: &BlastReport, symbols: usize) -> String {
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

pub(super) fn test_headline(r: &BlastReport) -> Option<String> {
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

pub(super) fn left_behind_line(r: &BlastReport) -> Option<String> {
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

pub(super) fn tag_line(r: &BlastReport) -> Option<String> {
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

pub(super) fn caveat_lines(r: &BlastReport) -> Vec<String> {
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
    let _ = INFERRED_MARK;
    out
}
