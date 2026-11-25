//! Collapsible Markdown details & owner sections for `blast::render`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::blast::owners::{Owner, mention, since_label};
use crate::blast::{BlastReport, Impacted, TestSignal, read_lines_safe};
use crate::graph::{Quote, is_deploy_file, reference_line_any, span_range};

use super::{NO_EDGE_NOTE, inferred_mark, plural, test_glyph, test_reach_label};

const MAX_SYMBOLS_LISTED: usize = 60;
const MAX_OWNER_ROWS: usize = 8;
const MAX_TESTS_LISTED: usize = 20;

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

pub(super) fn owner_section(r: &BlastReport, now: f64) -> Vec<String> {
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
    let name_refs: Vec<&str> = names.iter().map(String::as_str).collect();
    if let Some(q) = reference_line_any(r, &sym.path, &sym.span, &name_refs, cache) {
        return Some(q);
    }
    if stems.is_empty() || is_deploy_file(&sym.path) {
        return None;
    }
    let lines = read_lines_safe(r, &sym.path, cache)?;
    let (start, end) = span_range(&sym.span)?;
    if start == 0 {
        return None;
    }
    for (idx, line) in lines
        .iter()
        .enumerate()
        .take(end.min(lines.len()))
        .skip(start - 1)
    {
        if line_mentions_module(line, stems) {
            return Some(Quote {
                n: idx + 1,
                text: line.clone(),
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

pub(super) fn detail_sections(r: &BlastReport, symbols: usize, root: Option<&Path>) -> Vec<String> {
    let mut out = Vec::new();
    let mut names: Vec<String> = r
        .seeds
        .iter()
        .filter(|s| !s.whole_file)
        .map(|s| s.name.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    names.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    let mut stems: Vec<String> = r
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
    stems.sort();
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
