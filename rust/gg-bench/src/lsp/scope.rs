//! A server's document symbols, flattened, and the definitions and callers they name.

use serde_json::Value;

use crate::score::Entry;

/// One document symbol, flattened: 1-based lines, its range's start and end as (line, character)
/// from 0, and the index of the symbol around it.
#[derive(Clone, Debug)]
pub struct Scope {
    pub name: String,
    pub kind: u64,
    pub start: (u64, u64),
    pub end: (u64, u64),
    pub selection: Value,
    pub parent: Option<usize>,
}

pub(crate) fn position(value: &Value) -> (u64, u64) {
    (
        value["line"].as_u64().unwrap_or_default(),
        value["character"].as_u64().unwrap_or_default(),
    )
}

/// Flattens hierarchical document symbols, parents first. Flat `SymbolInformation` has no ranges
/// for nesting, so it is refused.
pub fn flatten(symbols: &Value) -> Result<Vec<Scope>, String> {
    fn walk(symbols: &[Value], parent: Option<usize>, out: &mut Vec<Scope>) -> Result<(), String> {
        for symbol in symbols {
            if symbol.get("location").is_some() {
                return Err(
                    "the server sent flat symbols; the column needs hierarchical ones".to_owned(),
                );
            }
            out.push(Scope {
                name: symbol["name"].as_str().unwrap_or_default().to_owned(),
                kind: symbol["kind"].as_u64().unwrap_or_default(),
                start: position(&symbol["range"]["start"]),
                end: position(&symbol["range"]["end"]),
                selection: symbol["selectionRange"]["start"].clone(),
                parent,
            });
            let at = out.len() - 1;
            walk(
                symbol["children"].as_array().map_or(&[], Vec::as_slice),
                Some(at),
                out,
            )?;
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(
        symbols.as_array().map_or(&[], Vec::as_slice),
        None,
        &mut out,
    )?;
    Ok(out)
}

/// LSP symbol kinds: File, Module, Namespace and Package only scope a name; the others listed in
/// `LOCAL` are values inside a definition, not callers.
const SCOPE_ONLY: [u64; 4] = [1, 2, 3, 4];
pub(crate) const LOCAL: [u64; 12] = [7, 8, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];

/// gopls names a method by its receiver, as `(*Logger).WithFields`; this is the method's own name.
fn go_method(name: &str) -> Option<&str> {
    name.strip_prefix('(')?
        .split_once(").")
        .map(|(_, method)| method)
}

/// The receiver type of a method gopls names as `(*Logger).WithFields`: `Logger`.
pub(crate) fn go_receiver(name: &str) -> Option<String> {
    let (receiver, _) = name.strip_prefix('(')?.split_once(").")?;
    let receiver = receiver.trim_start_matches('*');
    Some(receiver.split('[').next().unwrap_or(receiver).to_owned())
}

/// csharp-ls names a method with its parameters, as `Write(LogEventLevel level)`; this is the
/// name without them, which would otherwise read as an anonymous scope.
pub(super) fn csharp_name(name: &str) -> String {
    match name.split_once('(') {
        Some((head, _)) if name.ends_with(')') && !head.is_empty() => head.trim_end().to_owned(),
        _ => name.to_owned(),
    }
}

/// tsserver names a test callback like `it('x') callback`, and other anonymous scopes `<function>`.
fn anonymous(name: &str) -> bool {
    name.ends_with(" callback")
        || name.starts_with('<')
        || (name.contains('(') && go_method(name).is_none())
}

/// `impl<T> Trait for Foo<T>` and `impl Foo<T>` become `Foo`, as the graph tools name them.
pub fn clean_scope(name: &str) -> String {
    if let Some(method) = go_method(name) {
        return method.to_owned();
    }
    let name = if let Some(rest) = name
        .strip_prefix("impl")
        .filter(|rest| rest.starts_with(['<', ' ']))
    {
        match rest.rsplit_once(" for ") {
            Some((_, owner)) => owner.to_owned(),
            None if rest.starts_with('<') => {
                rest.split_once('>').map_or(rest, |(_, r)| r).to_owned()
            }
            None => rest.to_owned(),
        }
    } else {
        name.to_owned()
    };
    let name = name.split('<').next().unwrap_or_default().trim();
    name.rsplit("::").next().unwrap_or_default().to_owned()
}

/// The names of the definition around a position, outermost first, as Serena's column maps a
/// reference: scope-only symbols and anonymous callbacks drop out, and an innermost value inside
/// a definition gives way to the definition. Empty at module level. A lone module-level value
/// stays: typescript-language-server reports a function held in a `const` as a value.
pub fn caller_chain(scopes: &[Scope], at: (u64, u64)) -> Vec<usize> {
    let mut chain = enclosing(scopes, at);
    while chain.len() > 1 && LOCAL.contains(&scopes[chain[chain.len() - 1]].kind) {
        chain.pop();
    }
    chain
}

/// The symbols around a position, outermost first, without scope-only symbols and anonymous
/// callbacks.
pub(crate) fn enclosing(scopes: &[Scope], at: (u64, u64)) -> Vec<usize> {
    let depth = |mut index: usize| {
        let mut depth = 0;
        while let Some(parent) = scopes[index].parent {
            depth += 1;
            index = parent;
        }
        depth
    };
    let innermost = (0..scopes.len())
        .filter(|&i| scopes[i].start <= at && at <= scopes[i].end)
        .max_by_key(|&i| depth(i));
    let mut chain = Vec::new();
    let mut next = innermost;
    while let Some(index) = next {
        let scope = &scopes[index];
        if !SCOPE_ONLY.contains(&scope.kind) && !anonymous(&scope.name) {
            chain.push(index);
        }
        next = scope.parent;
    }
    chain.reverse();
    chain
}

/// The cleaned names of the symbols around one, innermost first, starting with a Go method's
/// receiver.
fn owners(scopes: &[Scope], scope: &Scope) -> Vec<String> {
    let mut names: Vec<String> = go_receiver(&scope.name).into_iter().collect();
    let mut next = scope.parent;
    while let Some(index) = next {
        names.push(clean_scope(&scopes[index].name));
        next = scopes[index].parent;
    }
    names
}

/// A symbol's first and last line, from 1.
pub(crate) fn lines(scope: &Scope) -> (i64, i64) {
    (scope.start.0 as i64 + 1, scope.end.0 as i64 + 1)
}

/// The truth target's definitions among a file's symbols, with the span each is scored at. Under
/// `span` rules a definition must hold a target line, or be the only one within a few lines of it
/// (a decorator moves the start), as the other rivals' adapters choose.
pub fn targets<'a>(
    scopes: &'a [Scope],
    symbol: &str,
    entry: &Entry,
    span_rules: bool,
) -> Vec<(&'a Scope, String)> {
    let mut parts: Vec<&str> = symbol.split('.').collect();
    let leaf = parts.pop().unwrap_or_default();
    let cands: Vec<&Scope> = scopes
        .iter()
        .filter(|s| {
            let owners = owners(scopes, s);
            clean_scope(&s.name) == leaf && parts.iter().all(|p| owners.iter().any(|o| o == p))
        })
        .collect();
    let span = |s: &Scope| format!("L{}-L{}", lines(s).0, lines(s).1);
    if !span_rules || entry.target_lines.is_empty() {
        return cands.into_iter().map(|s| (s, span(s))).collect();
    }
    let holds = |s: &&Scope| {
        entry
            .target_lines
            .iter()
            .any(|&l| lines(s).0 <= l && l <= lines(s).1)
    };
    let exact: Vec<_> = cands.iter().copied().filter(holds).collect();
    if !exact.is_empty() {
        return exact.into_iter().map(|s| (s, span(s))).collect();
    }
    match cands.as_slice() {
        [only]
            if entry
                .target_lines
                .iter()
                .any(|&l| (-10..=5).contains(&(lines(only).0 - l))) =>
        {
            let low = entry
                .target_lines
                .iter()
                .copied()
                .min()
                .unwrap_or_default()
                .min(lines(only).0);
            let high = entry
                .target_lines
                .iter()
                .copied()
                .max()
                .unwrap_or_default()
                .max(lines(only).1);
            vec![(*only, format!("L{low}-L{high}"))]
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn scope(name: &str, kind: u64, lines: (u64, u64), parent: Option<usize>) -> Scope {
        Scope {
            name: name.to_owned(),
            kind,
            start: (lines.0, 0),
            end: (lines.1, 80),
            selection: json!({ "line": lines.0, "character": 4 }),
            parent,
        }
    }

    #[test]
    fn a_caller_is_the_innermost_definition_that_is_not_a_value() {
        // module > class Foo > method bar > variable x; and a test callback at the top.
        let scopes = vec![
            scope("mod.py", 2, (0, 100), None),
            scope("Foo", 5, (1, 20), Some(0)),
            scope("bar", 6, (2, 10), Some(1)),
            scope("x", 13, (3, 3), Some(2)),
            scope("describe('a') callback", 12, (30, 40), None),
        ];
        assert_eq!(caller_chain(&scopes, (3, 10)), vec![1, 2]);
        assert_eq!(caller_chain(&scopes, (15, 0)), vec![1]);
        assert!(caller_chain(&scopes, (35, 0)).is_empty());
        assert!(caller_chain(&scopes, (60, 0)).is_empty());
    }

    #[test]
    fn a_module_level_constant_holding_a_function_is_the_caller() {
        // typescript-language-server reports `const main = async () => { ... }` as a constant, not a
        // function, so a lone module-level value may be a function whose calls it makes.
        let scopes = vec![scope("main", 14, (5, 20), None)];
        assert_eq!(caller_chain(&scopes, (6, 4)), vec![0]);
    }

    #[test]
    fn rust_impl_blocks_are_named_by_their_type() {
        assert_eq!(clean_scope("impl<T> Service<T> for Router<S>"), "Router");
        assert_eq!(clean_scope("impl<S> Router<S>"), "Router");
        assert_eq!(clean_scope("impl Builder"), "Builder");
        assert_eq!(clean_scope("render"), "render");
    }

    #[test]
    fn go_methods_are_named_and_not_anonymous() {
        assert_eq!(clean_scope("(*Logger).WithFields"), "WithFields");
        assert_eq!(clean_scope("(Level).String"), "String");
        assert_eq!(clean_scope("implementation"), "implementation");
        assert_eq!(csharp_name("Write(LogEventLevel level)"), "Write");
        assert_eq!(
            clean_scope(&csharp_name("ForContext<TSource>()")),
            "ForContext"
        );
        assert_eq!(csharp_name("LoggerTests"), "LoggerTests");
        assert_eq!(clean_scope("impl<T> Iterator for Iter<T>"), "Iter");
        assert!(!anonymous("(*Logger).WithFields"));
        assert!(anonymous("describe('x') callback"));
        assert!(anonymous("map(x)"));
    }

    #[test]
    fn a_span_target_must_hold_a_target_line_or_be_the_only_one_near_it() {
        let scopes = vec![
            scope("Foo", 5, (0, 30), None),
            scope("run", 6, (4, 9), Some(0)),
            scope("run", 12, (40, 45), None),
        ];
        let entry = |lines: Vec<i64>| Entry {
            target: "a.py".into(),
            target_lines: lines,
            required: vec![],
            optional: vec![],
        };
        let names = |found: Vec<(&Scope, String)>| {
            found
                .into_iter()
                .map(|(s, span)| format!("{}@{span}", s.start.0))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names(targets(&scopes, "run", &entry(vec![42]), true)),
            ["40@L41-L46"]
        );
        assert_eq!(
            names(targets(&scopes, "Foo.run", &entry(vec![3]), true)),
            ["4@L3-L10"]
        );
        assert!(targets(&scopes, "run", &entry(vec![20]), true).is_empty());
        assert_eq!(targets(&scopes, "run", &entry(vec![]), false).len(), 2);
        assert!(targets(&scopes, "Bar.run", &entry(vec![]), false).is_empty());
        let go = vec![scope("(*Logger).WithField", 6, (10, 12), None)];
        assert_eq!(
            names(targets(&go, "Logger.WithField", &entry(vec![11]), true)),
            ["10@L11-L13"]
        );
        assert!(targets(&go, "Entry.WithField", &entry(vec![11]), true).is_empty());
    }

    #[test]
    fn go_receivers_give_the_owner() {
        assert_eq!(
            go_receiver("(*Logger).WithFields").as_deref(),
            Some("Logger")
        );
        assert_eq!(go_receiver("(List[T]).Len").as_deref(), Some("List"));
        assert_eq!(go_receiver("WithFields"), None);
    }
}
