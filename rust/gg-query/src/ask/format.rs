//! Markdown formatter for `ask` results matching `src/ask/ask.ts::formatAsk`.

use std::collections::HashMap;

use crate::ask::budget::format_budget_footer;
use crate::ask::{AskMode, AskResult};
use crate::brand::{cmd, tag};
use crate::graph::{group_digits, js_locale_cmp, scope_label, to_tokens};

fn saved_tokens(r: &AskResult, body: &str) -> usize {
    let Some(ref s) = r.saved else {
        return 0;
    };
    if s.baseline_chars == 0 {
        return 0;
    }
    let base = to_tokens(s.baseline_chars);
    let pack = to_tokens(body.encode_utf16().count());
    base.saturating_sub(pack)
}

fn ask_savings_line(r: &AskResult, body: &str) -> String {
    let saved = saved_tokens(r, body);
    let Some(ref s) = r.saved else {
        return String::new();
    };
    if saved == 0 {
        return String::new();
    }
    let base = to_tokens(s.baseline_chars);
    let pct = ((saved as f64 / base as f64) * 100.0).round() as usize;
    format!(
        "{} tokens saved ≈ {} ({pct}%) at most, against reading the {} file(s) whole",
        tag(),
        group_digits(saved),
        s.files
    )
}

fn escalation_nudge(r: &AskResult) -> String {
    if r.mode == AskMode::Structural || r.hits.len() > 3 {
        return String::new();
    }
    let n = r.hits.len();
    let count_phrase = if n == 0 {
        "no hits".to_string()
    } else if n == 1 {
        "only 1 hit".to_string()
    } else {
        format!("only {n} hits")
    };
    format!(
        "\n\n{} {count_phrase} — don't re-ask with new wording; switch tool: \
         `{} \"<literal>\"` for every occurrence · \
         `{} <file>` for a file's full API · \
         `{} <symbol>` for who-uses.",
        tag(),
        cmd("graft grep"),
        cmd("graft skeleton"),
        cmd("graft callers")
    )
}

fn scope_footer_lines(r: &AskResult) -> Vec<String> {
    let Some(ref scopes) = r.scopes else {
        return Vec::new();
    };
    let mut per_scope: HashMap<&str, usize> = HashMap::new();
    for h in &r.hits {
        if let Some(ref sc) = h.scope {
            *per_scope.entry(sc.as_str()).or_insert(0) += 1;
        }
    }
    let mut counts: Vec<(&str, usize)> = per_scope.into_iter().collect();
    counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| js_locale_cmp(a.0, b.0)));

    let mut out = Vec::new();
    if !counts.is_empty() {
        let parts: Vec<String> = counts
            .into_iter()
            .map(|(s, c)| format!("{} ({c})", scope_label(s)))
            .collect();
        out.push(format!("matched in: {}", parts.join(" · ")));
    }
    for m in &scopes.also_matched {
        let lbl = scope_label(&m.scope);
        out.push(format!("also matched: {lbl} — narrow with --in {lbl}"));
    }
    out
}

/// Render an `AskResult` as the exact markdown context pack produced by `trail ask` / `graft ask`.
pub fn format_ask(r: &AskResult) -> String {
    let base = format_ask_with_found(r, r);
    match &r.budget {
        Some(b) => format!("{base}{}\n", format_budget_footer(b)),
        None => base,
    }
}

/// Render an `AskResult` body before appending any budget footer, taking the
/// escalation-nudge count from `found` (`src/ask/ask.ts::formatAskWithSaved`).
pub fn format_ask_with_found(r: &AskResult, found: &AskResult) -> String {
    let head = format!(
        "{} — \"{}\"  ({})",
        cmd("graft ask"),
        r.query,
        r.mode.as_str()
    );
    let note_block = match &r.note {
        Some(note) => note
            .lines()
            .map(|l| {
                if l.starts_with("structural index:") {
                    format!("⚠ {l}")
                } else {
                    l.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        None => String::new(),
    };

    if r.hits.is_empty() {
        let msg = if note_block.is_empty() {
            "no matches."
        } else {
            &note_block
        };
        return format!("{head}\n\n{msg}{}\n", escalation_nudge(found));
    }

    let mut lines: Vec<String> = if note_block.is_empty() {
        vec![head, String::new()]
    } else {
        vec![head, String::new(), note_block, String::new()]
    };

    if r.mode == AskMode::Structural {
        for h in &r.hits {
            let tail = if h.snippet.is_empty() {
                String::new()
            } else {
                format!(" — {}", h.snippet)
            };
            let rel = h.relation.as_deref().unwrap_or("");
            lines.push(format!("- {}  {}  ({rel}){tail}", h.title, h.pointer));
            if let Some(ref code) = h.code {
                lines.push(String::new());
                lines.push("```".to_string());
                lines.push(code.clone());
                lines.push("```".to_string());
                lines.push(String::new());
            }
        }
    } else {
        for (i, h) in r.hits.iter().enumerate() {
            let label = match (&r.scopes, &h.scope) {
                (Some(_), Some(sc)) if !sc.is_empty() => format!("[{sc}/] "),
                _ => String::new(),
            };
            lines.push(format!("{}. {label}{}  [{}]", i + 1, h.title, h.kind));
            lines.push(format!("   {}", h.pointer));
            if !h.snippet.is_empty() {
                lines.push(format!("   {}", h.snippet));
            }
            if let Some(ref rel) = h.related
                && !rel.is_empty()
            {
                lines.push(format!("   related: {}", rel.join(", ")));
            }
            if let Some(ref code) = h.code {
                lines.push(String::new());
                lines.push("```".to_string());
                lines.push(code.clone());
                lines.push("```".to_string());
            }
            lines.push(String::new());
        }
        lines.extend(scope_footer_lines(r));
    }

    let body = lines.join("\n").trim_end().to_string();
    let savings = ask_savings_line(r, &body);
    let prefix = if savings.is_empty() {
        body
    } else {
        format!("{savings}\n\n{body}")
    };
    format!("{prefix}{}\n", escalation_nudge(found))
}
