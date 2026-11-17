//! Derives one symbol's rows from its references, and picks the symbols for a new repository.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde_json::Value;

use super::syntax::{Language, byte_at, function_holder, identifier, is_call, pickable};
use crate::lsp::{
    Session, clean_scope, enclosing, go_receiver, path_to_uri, position, relative, uri_to_path,
};
use crate::score::{Entry, Rules};

/// A shuffle that every platform repeats for a seed: Fisher-Yates driven by SplitMix64.
pub fn shuffle<T>(items: &mut [T], seed: u64) {
    let mut state = seed;
    let mut next = || {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    };
    for i in (1..items.len()).rev() {
        let j = (next() % (i as u64 + 1)) as usize;
        items.swap(i, j);
    }
}

/// Rows for one group of references: a file and the named definition around them.
struct Group {
    file: String,
    names: Option<Vec<String>>,
    lines: BTreeSet<i64>,
}

fn rows(groups: BTreeMap<String, Group>, rules: Rules) -> Vec<Value> {
    let mut rows: Vec<(String, i64, Value)> = groups
        .into_values()
        .map(|g| {
            let lines: Vec<i64> = g.lines.iter().copied().collect();
            let chain = match g.names {
                None => Value::from("<file>"),
                Some(names) if rules == Rules::Span => Value::from(names.join("::")),
                Some(names) => Value::from(vec![names.last().cloned().unwrap_or_default()]),
            };
            let first = lines.first().copied().unwrap_or_default();
            let row = serde_json::json!({ "file": g.file, "chain": chain, "lines": lines });
            (g.file, first, row)
        })
        .collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    rows.into_iter().map(|(_, _, row)| row).collect()
}

/// One symbol's derived rows, and how many calls they hold.
pub struct Derived {
    pub required: Vec<Value>,
    pub optional: Vec<Value>,
    pub calls: usize,
}

pub(super) struct Deriver<'a> {
    pub(super) session: Session<'a>,
    pub(super) language: Language,
    pub(super) rules: Rules,
    pub(super) texts: HashMap<String, Vec<String>>,
}

impl Deriver<'_> {
    fn line(&mut self, path: &str, line: u64) -> Result<String, String> {
        if !self.texts.contains_key(path) {
            let text = fs::read_to_string(self.session.root.join(path))
                .map_err(|e| format!("cannot read {path}: {e}"))?;
            self.texts
                .insert(path.to_owned(), text.lines().map(str::to_owned).collect());
        }
        Ok(self.texts[path]
            .get(line as usize)
            .cloned()
            .unwrap_or_default())
    }

    /// The references to the definition named at `at` in `target`, opening the file for the
    /// request when it is not open already.
    fn references(&mut self, target: &str, at: &Value) -> Result<Vec<(String, Value)>, String> {
        let opened = self.session.open.insert(target.to_owned());
        if opened {
            self.session.server.open(self.session.root, target)?;
        }
        let uri = path_to_uri(&self.session.root.join(target));
        let found = self.session.references(&uri, at);
        if opened {
            self.session.server.close(self.session.root, target)?;
            self.session.open.remove(target);
        }
        found
    }

    /// The named definitions around a position, outermost first: as the column maps a reference,
    /// except that a value at any depth counts when, and only when, its line assigns a function.
    fn named_chain(&mut self, path: &str, at: (u64, u64)) -> Result<Vec<usize>, String> {
        let around: Vec<(usize, u64, u64)> = {
            let scopes = self.session.scopes(path)?;
            enclosing(scopes, at)
                .into_iter()
                .map(|i| (i, scopes[i].kind, scopes[i].start.0))
                .collect()
        };
        let mut chain = Vec::new();
        for (index, kind, line) in around {
            if !crate::lsp::LOCAL.contains(&kind) || function_holder(&self.line(path, line)?) {
                chain.push(index);
            }
        }
        Ok(chain)
    }

    /// One reference: whether it is a call, its group key, file, enclosing names and line. None
    /// for a reference outside the checkout or a module-level reference that is not a call.
    fn classify(
        &mut self,
        uri: &str,
        range: &Value,
    ) -> Result<Option<(bool, String, Group)>, String> {
        let Some(path) = uri_to_path(uri).and_then(|p| relative(&self.session.root_text, &p))
        else {
            self.session.outside += 1;
            return Ok(None);
        };
        if path.split('/').any(|part| part == "node_modules") {
            return Ok(None);
        }
        let (start, end) = (position(&range["start"]), position(&range["end"]));
        let text = self.line(&path, start.0)?;
        let call = start.0 == end.0
            && is_call(
                self.language,
                &text,
                byte_at(&text, start.1),
                byte_at(&text, end.1),
            );
        let chain = self.named_chain(&path, start)?;
        let scopes = &self.session.symbols[&path];
        if !call && chain.is_empty() {
            return Ok(None);
        }
        let key = match chain.last() {
            Some(&inner) => format!("{path}#{:?}", scopes[inner].start),
            None => format!("{path}#file"),
        };
        let names = (!chain.is_empty()).then(|| {
            chain
                .iter()
                .map(|&i| clean_scope(&scopes[i].name))
                .collect()
        });
        let lines = BTreeSet::from([start.0 as i64 + 1]);
        Ok(Some((
            call,
            key,
            Group {
                file: path,
                names,
                lines,
            },
        )))
    }

    /// Classifies every reference to the definition named at `at` in `target`.
    pub(super) fn derive(&mut self, target: &str, at: &Value) -> Result<Derived, String> {
        let (mut calls, mut others) = (BTreeMap::new(), BTreeMap::new());
        for (uri, range) in self.references(target, at)? {
            let Some((call, key, group)) = self.classify(&uri, &range)? else {
                continue;
            };
            let into: &mut BTreeMap<String, Group> = if call { &mut calls } else { &mut others };
            match into.get_mut(&key) {
                Some(existing) => existing.lines.extend(group.lines),
                None => {
                    into.insert(key, group);
                }
            }
        }
        for key in calls.keys() {
            others.remove(key);
        }
        let count = calls.values().map(|g| g.lines.len()).sum();
        Ok(Derived {
            required: rows(calls, self.rules),
            optional: rows(others, self.rules),
            calls: count,
        })
    }
}

/// Every file under `dir`, relative and with `/` separators, skipping `.git` and `node_modules`.
fn files(dir: &Path, prefix: &str, out: &mut Vec<String>) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .and_then(Iterator::collect)
        .map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = format!("{prefix}{name}");
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() && name != ".git" && name != "node_modules" {
            files(&entry.path(), &format!("{path}/"), out)?;
        } else if kind.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

/// Opens the target files and, for TypeScript, every source file outside `dist` and `coverage`, as
/// tsc-truth.mjs reads them all: the TypeScript server searches only the projects of open files,
/// and a tsconfig's `files` or `include` can leave the tests out of the targets' project.
pub(super) fn open_files(
    session: &mut Session,
    language: Language,
    existing: &[(String, Entry)],
) -> Result<(), String> {
    let mut paths: Vec<String> = existing.iter().map(|(_, e)| e.target.clone()).collect();
    if language == Language::TypeScript {
        let mut all = Vec::new();
        files(session.root, "", &mut all)?;
        let built = |path: &str| path.split('/').any(|p| p == "dist" || p == "coverage");
        paths.extend(
            all.into_iter()
                .filter(|path| language.source(path) && !built(path)),
        );
    }
    for path in paths {
        if session.open.insert(path.clone()) {
            session.server.open(session.root, &path)?;
        }
    }
    Ok(())
}

/// The minimum and maximum calls a picked symbol may have.
pub const PICK_CALLS: (usize, usize) = (3, 300);

pub(super) struct Picked {
    pub(super) symbol: String,
    pub(super) target: String,
    pub(super) line: i64,
    pub(super) derived: Derived,
}

/// Functions and methods (LSP kinds 12 and 6) in pickable files, in a seeded order, kept while
/// their calls fall within `PICK_CALLS` until `count` are chosen. A name already chosen is
/// qualified with its owner, and skipped if that is taken too.
pub(super) fn pick(
    deriver: &mut Deriver,
    count: usize,
    seed: u64,
) -> Result<(Vec<Picked>, usize), String> {
    let mut all = Vec::new();
    files(deriver.session.root, "", &mut all)?;
    let mut candidates: Vec<(String, String, Value, Option<String>)> = Vec::new();
    for path in all.into_iter().filter(|p| pickable(deriver.language, p)) {
        let scopes = deriver.session.scopes(&path)?.to_vec();
        for scope in &scopes {
            let name = clean_scope(&scope.name);
            if [6, 12].contains(&scope.kind) && identifier(&name) {
                let owner = go_receiver(&scope.name)
                    .or_else(|| scope.parent.map(|p| clean_scope(&scopes[p].name)));
                candidates.push((path.clone(), name, scope.selection.clone(), owner));
            }
        }
    }
    shuffle(&mut candidates, seed);
    let (mut chosen, mut keys, mut tried) = (Vec::new(), HashSet::new(), 0);
    for (path, name, selection, owner) in candidates {
        if chosen.len() == count {
            break;
        }
        let key = if keys.contains(&name) {
            match owner {
                Some(owner) if identifier(&owner) => format!("{owner}.{name}"),
                _ => continue,
            }
        } else {
            name
        };
        if keys.contains(&key) {
            continue;
        }
        tried += 1;
        let derived = deriver.derive(&path, &selection)?;
        if (PICK_CALLS.0..=PICK_CALLS.1).contains(&derived.calls) {
            keys.insert(key.clone());
            let line = position(&selection).0 as i64 + 1;
            chosen.push(Picked {
                symbol: key,
                target: path,
                line,
                derived,
            });
        }
    }
    Ok((chosen, tried))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shuffle_repeats_for_a_seed() {
        let mut a: Vec<u32> = (0..20).collect();
        let mut b = a.clone();
        shuffle(&mut a, 2026);
        shuffle(&mut b, 2026);
        assert_eq!(a, b);
        assert_ne!(a, (0..20).collect::<Vec<_>>());
        let mut c: Vec<u32> = (0..20).collect();
        shuffle(&mut c, 2027);
        assert_ne!(a, c);
    }

    #[test]
    fn rows_follow_the_rules_and_sort_by_file_and_line() {
        let mut groups = BTreeMap::new();
        groups.insert(
            "b#1".to_owned(),
            Group {
                file: "b.py".into(),
                names: Some(vec!["A".into(), "f".into()]),
                lines: [9, 3].into(),
            },
        );
        groups.insert(
            "a#file".to_owned(),
            Group {
                file: "a.py".into(),
                names: None,
                lines: [5].into(),
            },
        );
        let span = rows(groups, Rules::Span);
        assert_eq!(
            span,
            vec![
                serde_json::json!({ "file": "a.py", "chain": "<file>", "lines": [5] }),
                serde_json::json!({ "file": "b.py", "chain": "A::f", "lines": [3, 9] }),
            ]
        );
    }
}
