//! Blast-radius diff analysis matching `src/blast/blast.ts` & `src/blast/modules.ts`.

mod areas;
mod declaration;
pub mod diff;
mod left_behind;
pub mod owners;
pub mod render;
pub mod types;

pub use types::*;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use crate::ask::concepts::load_concepts;
use crate::graph::{Direction, EdgeHit, NodeV1, is_deploy_file, span_range};
use crate::safe_io::read_contained_to_string;
use crate::store::GraphStore;

use areas::{changed_areas, group_by_module, tests_reached, to_impacted, unresolved_for_seeds};
use declaration::{Squashed, build_removed_squashed, declaration_changed};
use diff::{ChangeStatus, ChangedFile, LineRange};
use left_behind::callers_left_behind;

const MAX_LABEL: usize = 30;

fn is_true(v: &bool) -> bool {
    *v
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
        // `\.(test|spec)\.[cm]?[jt]sx?$`
        let script = ext.strip_prefix(['c', 'm']).unwrap_or(ext);
        if matches!(script, "js" | "jsx" | "ts" | "tsx")
            && (stem.ends_with(".test") || stem.ends_with(".spec"))
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
    let trimmed = dir.strip_suffix('/').unwrap_or(dir);
    match trimmed.rfind('/') {
        None => String::new(),
        Some(idx) => format!("{}/", &trimmed[..idx]),
    }
}

/// JavaScript's whitespace (`\s`, `trim`): Unicode `White_Space` without U+0085, plus U+FEFF.
fn js_space(c: char) -> bool {
    c == '\u{feff}' || (c != '\u{85}' && c.is_whitespace())
}

fn js_space_unit(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(js_space)
}

/// `label.replace(/^concepts?:\s*/i, "").trim()`.
fn strip_concept_prefix(label: &str) -> &str {
    let head = |pat: &str| {
        label
            .get(..pat.len())
            .filter(|h| h.eq_ignore_ascii_case(pat))
            .map(|_| &label[pat.len()..])
    };
    let rest = head("concepts:")
        .or_else(|| head("concept:"))
        .unwrap_or(label);
    rest.trim_matches(js_space)
}

/// The UTF-16 index of the first `CLAUSE_BREAK` match in `modules.ts`:
/// `/\s(?:\(|—|-\s)|:\s|\s(?:via|and|for|with|using|in|across|over|from|of|by|to)\s/i`.
fn clause_break(units: &[u16]) -> Option<usize> {
    const WORDS: [&str; 12] = [
        "via", "and", "for", "with", "using", "in", "across", "over", "from", "of", "by", "to",
    ];
    let space_at = |i: usize| units.get(i).copied().is_some_and(js_space_unit);
    let word_at = |i: usize, w: &str| {
        units.get(i..i + w.len()).is_some_and(|got| {
            got.iter()
                .zip(w.bytes())
                .all(|(&g, b)| u8::try_from(g).is_ok_and(|g| g.eq_ignore_ascii_case(&b)))
        }) && space_at(i + w.len())
    };
    (0..units.len()).find(|&i| {
        let next = units.get(i + 1).copied();
        (space_at(i)
            && (next == Some(u16::from(b'('))
                || next == Some(0x2014)
                || (next == Some(u16::from(b'-')) && space_at(i + 2))
                || WORDS.iter().any(|w| word_at(i + 1, w))))
            || (units[i] == u16::from(b':') && space_at(i + 1))
    })
}

/// `shortLabel` in `modules.ts`, counted in UTF-16 units as JavaScript does.
pub fn short_label(label: &str) -> String {
    let bare = strip_concept_prefix(label);
    let units: Vec<u16> = bare.encode_utf16().collect();
    if units.len() <= MAX_LABEL {
        return bare.to_string();
    }
    let text = |end: usize| String::from_utf16_lossy(&units[..end]);
    if let Some(at) = clause_break(&units).filter(|at| (8..=MAX_LABEL).contains(at)) {
        return text(at).trim_end_matches(js_space).to_string();
    }
    let cut = units[..=MAX_LABEL]
        .iter()
        .rposition(|&u| u == u16::from(b' '))
        .filter(|&sp| sp > MAX_LABEL / 2)
        .unwrap_or(MAX_LABEL);
    format!("{}…", text(cut).trim_end_matches(js_space))
}

/// The first non-empty name, shortened, or `fallback` (`hubLabel` in `src/blast/blast.ts`).
pub fn hub_label(names: &[String], fallback: &str) -> String {
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

pub(crate) fn read_lines_safe(
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
        read_contained_to_string(root, path, None)
            .map(|raw| raw.split('\n').map(String::from).collect())
    };
    cache.insert(path.to_string(), loaded.clone());
    loaded
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

struct SeedContext<'a> {
    nodes: &'a [NodeV1],
    removed: &'a [Squashed],
    root: &'a Path,
    seed_all_on_empty_ranges: bool,
}

struct SeedAccum<'a> {
    cache: &'a mut HashMap<String, Option<Vec<String>>>,
    seeds: &'a mut Vec<Seed>,
    declared: &'a mut Vec<NodeV1>,
}

fn collect_file_seeds(
    ctx: &SeedContext<'_>,
    file: &ChangedFile,
    file_node: &NodeV1,
    acc: &mut SeedAccum<'_>,
) -> Vec<NodeV1> {
    let symbol_seeds = if !file.ranges.is_empty() {
        seeds_for_file(ctx.nodes, &file.path, &file.ranges)
    } else if ctx.seed_all_on_empty_ranges {
        ctx.nodes
            .iter()
            .filter(|n| n.path == file.path && n.kind != "file" && n.kind != "resource")
            .cloned()
            .collect()
    } else {
        Vec::new()
    };

    for node in &symbol_seeds {
        let decl = declaration_changed(node, file, ctx.removed, ctx.root, acc.cache);
        if decl {
            acc.declared.push(node.clone());
        }
        acc.seeds.push(Seed {
            id: node.id.clone(),
            name: node.name.clone(),
            kind: node.kind.clone(),
            path: node.path.clone(),
            span: node.span.clone(),
            whole_file: false,
            declaration_changed: is_true(&decl),
        });
    }
    if symbol_seeds.is_empty() || ctx.seed_all_on_empty_ranges {
        acc.seeds.push(Seed {
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
    } else if ctx.seed_all_on_empty_ranges {
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
    let seed_ctx = SeedContext {
        nodes: &nodes,
        removed: &removed,
        root,
        seed_all_on_empty_ranges: opts.seed_all_on_empty_ranges,
    };

    let mut seeds = Vec::new();
    let mut unindexed = Vec::new();
    let mut deleted = Vec::new();
    let mut seed_nodes_by_file: BTreeMap<String, Vec<NodeV1>> = BTreeMap::new();
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
        let mut acc = SeedAccum {
            cache: &mut file_cache,
            seeds: &mut seeds,
            declared: &mut declared_seeds,
        };
        let walk_seeds = collect_file_seeds(&seed_ctx, file, file_node, &mut acc);
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
