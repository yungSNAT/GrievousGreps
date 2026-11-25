//! Concept markdown loader and scorer for `ask`.
//!
//! Mirrors concept frontmatter loading and scoring in `src/ask/ask.ts`, refusing
//! YAML anchors and aliases cleanly.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::Path;

use crate::ask::AskHit;
use crate::ask::lexical::HitEntry;
use crate::ask::scoring::{matched_idf_share, score_bag};
use crate::graph::path_under_prefix;
use crate::tokenize::{counts, tokenize};

#[derive(Debug, Clone)]
pub struct ConceptDoc {
    pub slug: String,
    pub name: String,
    pub sources: Vec<String>,
    pub related: Vec<String>,
    pub snippet: String,
    pub name_bag: HashMap<String, usize>,
    pub body_bag: HashMap<String, usize>,
}

fn first_prose(body: &str) -> String {
    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty()
            || line.starts_with('#')
            || line.starts_with("<!--")
            || line.starts_with('-')
        {
            continue;
        }
        return line.to_string();
    }
    String::new()
}

fn strip_quotes(val: &str) -> String {
    let t = val.trim();
    if (t.starts_with('"') && t.ends_with('"') && t.len() >= 2)
        || (t.starts_with('\'') && t.ends_with('\'') && t.len() >= 2)
    {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

/// Minimal, anchor-refusing YAML frontmatter reader for concept markdown files.
fn parse_concept_markdown(text: &str, default_slug: &str) -> ConceptDoc {
    let mut slug = default_slug.to_string();
    let mut name = String::new();
    let mut sources = Vec::new();
    let mut related = Vec::new();
    let mut body = text;

    let norm = text.replace("\r\n", "\n");
    if let Some(rest) = norm.strip_prefix("---\n")
        && let Some(end_idx) = rest.find("\n---")
    {
        let fm = &rest[..end_idx];
        let after = &rest[end_idx + 4..];
        body = after.strip_prefix('\n').unwrap_or(after);

        let has_anchor_or_alias = fm.lines().any(|l| {
            let trimmed = l.trim();
            !trimmed.starts_with('#') && (trimmed.contains(" &") || trimmed.contains(" *"))
        });
        if !has_anchor_or_alias {
            let mut section = "";
            for line in fm.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                if !line.starts_with(' ') && !line.starts_with('\t') {
                    section = "";
                    if let Some((k, v)) = trimmed.split_once(':') {
                        let key = k.trim();
                        let val = strip_quotes(v);
                        match key {
                            "slug" if !val.is_empty() => slug = val,
                            "name" => name = val,
                            "sources" => section = "sources",
                            "links" => section = "links",
                            _ => {}
                        }
                    }
                } else if section == "sources" {
                    let item = trimmed.strip_prefix('-').map_or(trimmed, str::trim);
                    if let Some((_, v)) = item.split_once("path:") {
                        let p = strip_quotes(v);
                        if !p.is_empty() {
                            sources.push(p);
                        }
                    }
                } else if section == "links" {
                    let item = trimmed.strip_prefix('-').map_or(trimmed, str::trim);
                    if let Some((_, v)) = item.split_once("to:") {
                        let to = strip_quotes(v);
                        if !to.is_empty() {
                            related.push(to);
                        }
                    }
                }
            }
        }
    }

    let snippet = first_prose(body);
    let combined = format!("{name} {snippet} {}", sources.join(" "));
    ConceptDoc {
        slug,
        name_bag: counts(&tokenize(&name)),
        body_bag: counts(&tokenize(&combined)),
        name,
        sources,
        related,
        snippet,
    }
}

fn collect_concept_filenames(out_dir: &Path) -> io::Result<Option<Vec<String>>> {
    if !out_dir.is_dir() || fs::symlink_metadata(out_dir)?.file_type().is_symlink() {
        return Ok(None);
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(out_dir)? {
        let entry = entry?;
        let fname = entry.file_name().to_string_lossy().to_string();
        if !fname.ends_with(".md") || fname == "INDEX.md" {
            continue;
        }
        let ft = entry.file_type()?;
        if ft.is_symlink() || !ft.is_file() {
            continue;
        }
        entries.push(fname);
    }
    entries.sort();
    Ok(Some(entries))
}

pub fn load_concepts(out_dir: &Path, in_prefix: Option<&str>) -> io::Result<Vec<ConceptDoc>> {
    let Some(entries) = collect_concept_filenames(out_dir)? else {
        return Ok(Vec::new());
    };
    let Ok((anchor, canon_out)) = crate::safe_io::anchor_root(out_dir) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for fname in entries {
        let Some(text) = crate::safe_io::read_contained_anchored_to_string(
            &canon_out,
            &anchor,
            &fname,
            Some(1024 * 1024),
        ) else {
            continue;
        };
        let doc = parse_concept_markdown(&text, fname.strip_suffix(".md").unwrap_or(&fname));
        let matches_prefix =
            in_prefix.is_none_or(|prefix| doc.sources.iter().any(|p| path_under_prefix(p, prefix)));
        if matches_prefix {
            out.push(doc);
        }
    }
    Ok(out)
}

pub(crate) fn score_concepts(
    q_terms: &[String],
    concepts: &[ConceptDoc],
    idf: &HashMap<String, f64>,
    dflt_idf: f64,
) -> Vec<HitEntry> {
    let mut hits = Vec::new();
    let mut max_c = 0.0_f64;
    for c in concepts {
        let total =
            score_bag(q_terms, &c.name_bag, idf) * 3.0 + score_bag(q_terms, &c.body_bag, idf);
        if total > 0.0 {
            max_c = max_c.max(total);
            let cov = matched_idf_share(q_terms, &[&c.name_bag, &c.body_bag], idf, dflt_idf);
            let strong = matched_idf_share(q_terms, &[&c.name_bag], idf, dflt_idf);
            let group_key = format!("concept:{}:{}", c.slug, hits.len());
            let title = if c.name.is_empty() {
                c.slug.clone()
            } else {
                c.name.clone()
            };
            let pointer = if c.sources.is_empty() {
                c.slug.clone()
            } else {
                c.sources.join(", ")
            };
            hits.push(HitEntry {
                hit: AskHit {
                    kind: "concept".to_string(),
                    title,
                    pointer,
                    snippet: c.snippet.clone(),
                    relation: None,
                    related: Some(c.related.clone()),
                    score: total,
                    code: None,
                    scope: None,
                    score_first: false,
                },
                group_key,
                coverage: cov,
                coverage_strong: strong,
            });
        }
    }
    for entry in &mut hits {
        entry.hit.score = if max_c > 0.0 {
            entry.hit.score / max_c
        } else {
            0.0
        };
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::load_concepts;
    use std::fs;
    use tempfile::tempdir;

    #[cfg(unix)]
    #[test]
    fn load_concepts_rejects_symlinked_markdown_and_keeps_regular() {
        use std::os::unix::fs::symlink;

        let tmp = tempdir().expect("tmp");
        let out_dir = tmp.path().join(".trail");
        let outside = tmp.path().join("outside.md");
        fs::create_dir_all(&out_dir).expect("mkdir");
        fs::write(&outside, "# Secret\n\nsrc/a.ts\n").expect("write out");
        fs::write(out_dir.join("real.md"), "# Real Concept\n\nBody text.\n").expect("write real");
        symlink(&outside, out_dir.join("escape.md")).expect("symlink");

        let docs = load_concepts(&out_dir, None).expect("load");
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].slug, "real");
    }

    #[test]
    fn load_concepts_reads_regular_markdown_and_skips_oversized() {
        let tmp = tempdir().expect("tmp");
        let out_dir = tmp.path().join(".trail");
        fs::create_dir_all(&out_dir).expect("mkdir");
        fs::write(out_dir.join("keep.md"), "# Kept\n\nConcise summary.\n").expect("write keep");
        fs::write(out_dir.join("huge.md"), vec![b'a'; 1024 * 1024 + 8]).expect("write huge");

        let docs = load_concepts(&out_dir, None).expect("load");
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].slug, "keep");
    }
}
