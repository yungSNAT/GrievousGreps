//! Module grouping, changed-area coarsening, unresolved calls, and test reachability for `blast`.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::graph::{Direction, EdgeHit, EdgeV1, NodeV1, UnresolvedCall, js_locale_cmp};
use crate::store::GraphStore;

use super::diff::{ChangeStatus, ChangedFile};
use super::{
    ChangedArea, Impacted, ImpactedModule, LabelSource, ModuleIndex, Seed, TestReach, TestSignal,
    UnresolvedName, dir_label, hub_label, is_blast_test_path, parent_dir, shared_concept,
};

const MAX_AREAS: usize = 5;

fn is_test_only(mod_item: &ImpactedModule) -> bool {
    !mod_item.files.is_empty() && mod_item.files.iter().all(|f| is_blast_test_path(f))
}

pub(super) fn group_by_module(
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

fn coarsen(groups: &mut BTreeMap<String, Vec<String>>, max: usize) {
    while groups.len() > max {
        let mut keys: Vec<String> = groups.keys().cloned().collect();
        keys.sort_by(|a, b| {
            dir_depth(b)
                .cmp(&dir_depth(a))
                .then_with(|| groups[a].len().cmp(&groups[b].len()))
                .then_with(|| a.cmp(b))
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

pub(super) fn changed_areas(
    nodes: &[NodeV1],
    edges: &[EdgeV1],
    changed: &[ChangedFile],
    seed_nodes: &BTreeMap<String, Vec<NodeV1>>,
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

    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut seen_paths = HashSet::new();
    for file in changed {
        let path = &file.path;
        if is_blast_test_path(path) || !seed_nodes.contains_key(path) || !seen_paths.insert(path) {
            continue;
        }
        groups
            .entry(dir_label(path))
            .or_default()
            .push(path.clone());
    }
    coarsen(&mut groups, MAX_AREAS);

    let mut out = Vec::with_capacity(groups.len());
    for (dir, mut paths) in groups {
        paths.sort();
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
    seed_nodes: &BTreeMap<String, Vec<NodeV1>>,
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

pub(super) fn unresolved_for_seeds(
    calls: &[UnresolvedCall],
    seeds: &[Seed],
) -> Vec<UnresolvedName> {
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

pub(super) fn tests_reached(
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

pub(super) fn to_impacted(h: &EdgeHit) -> Option<Impacted> {
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
