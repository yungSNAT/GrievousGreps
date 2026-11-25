//! `wiring.json` bytes, as `writeGraph` in `src/graph/write.ts` produces them.
//!
//! Nodes lose `body_text` and are sorted by `id`; edges are sorted by `source`, then
//! `relation`, then `target`. Both sorts are stable and compare with
//! `String.prototype.localeCompare`, which is ICU collation. ICU4X's root collation
//! matches it on hosts whose default locale is English or C/POSIX; TypeScript on a host
//! whose locale tailors collation (Swedish, for one) sorts differently, and this does not.

use std::cmp::Ordering;
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};

use crate::json::{self, Json, utf16};

static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    Collator::try_new(CollatorPreferences::default(), CollatorOptions::default())
        .expect("compiled root collation data")
});

/// `a.localeCompare(b)` in an English or C/POSIX default locale.
pub fn locale_compare(a: &[u16], b: &[u16]) -> Ordering {
    COLLATOR.compare_utf16(a, b)
}

/// Parse a graph and return its `wiring.json` text.
pub fn wiring_from_text(text: &str) -> Result<String, String> {
    wiring(json::parse(text)?)
}

/// The `wiring.json` text for `graph`, trailing newline included.
pub fn wiring(mut graph: Json) -> Result<String, String> {
    let Json::Obj(members) = &mut graph else {
        return Err("graph is not an object".into());
    };
    let mut nodes = take_array(members, "nodes")?;
    let mut edges = take_array(members, "edges")?;

    let mut keyed = Vec::with_capacity(nodes.len());
    for node in nodes.drain(..) {
        let id = string_field(&node, "id", "node")?;
        keyed.push((vec![id], strip_body_text(node)));
    }
    sort_keyed(&mut keyed);
    nodes.extend(keyed.into_iter().map(|(_, n)| n));

    let mut keyed = Vec::with_capacity(edges.len());
    for edge in edges.drain(..) {
        let keys = ["source", "relation", "target"]
            .into_iter()
            .map(|k| string_field(&edge, k, "edge"))
            .collect::<Result<Vec<_>, _>>()?;
        keyed.push((keys, edge));
    }
    sort_keyed(&mut keyed);
    edges.extend(keyed.into_iter().map(|(_, e)| e));

    put_array(members, "nodes", nodes);
    put_array(members, "edges", edges);
    let mut out = json::stringify(&graph);
    out.push('\n');
    Ok(out)
}

fn sort_keyed(items: &mut [(Vec<Vec<u16>>, Json)]) {
    items.sort_by(|(a, _), (b, _)| {
        a.iter()
            .zip(b)
            .map(|(x, y)| locale_compare(x, y))
            .find(|o| o.is_ne())
            .unwrap_or(Ordering::Equal)
    });
}

fn take_array(members: &mut [(Vec<u16>, Json)], key: &str) -> Result<Vec<Json>, String> {
    let key16 = utf16(key);
    match members.iter_mut().find(|(k, _)| *k == key16) {
        Some((_, Json::Arr(items))) => Ok(std::mem::take(items)),
        _ => Err(format!("graph has no `{key}` array")),
    }
}

fn put_array(members: &mut [(Vec<u16>, Json)], key: &str, items: Vec<Json>) {
    let key16 = utf16(key);
    if let Some((_, slot)) = members.iter_mut().find(|(k, _)| *k == key16) {
        *slot = Json::Arr(items);
    }
}

fn string_field(item: &Json, key: &str, what: &str) -> Result<Vec<u16>, String> {
    match item.get(key) {
        Some(Json::Str(s)) => Ok(s.clone()),
        _ => Err(format!("every {what} needs a string `{key}`")),
    }
}

fn strip_body_text(node: Json) -> Json {
    match node {
        Json::Obj(members) => {
            let key = utf16("body_text");
            Json::Obj(members.into_iter().filter(|(k, _)| *k != key).collect())
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(ids: &[&str]) -> Vec<String> {
        let mut v: Vec<Vec<u16>> = ids.iter().map(|s| utf16(s)).collect();
        v.sort_by(|a, b| locale_compare(a, b));
        v.iter().map(|s| String::from_utf16_lossy(s)).collect()
    }

    #[test]
    fn ids_sort_by_collation_not_code_units() {
        // Node 26 (ICU 78.3) in en-AU, en-US and C sorts these in this order.
        let want = [
            "src/a_b.ts",
            "src/a-b.ts",
            "src/a.ts",
            "src/A.ts",
            "src/Ä.ts",
            "src/a.ts#x",
            "src/a.ts#X",
            "src/a/b.ts",
            "src/a1.ts",
            "src/a10.ts",
            "src/a2.ts",
            "src/b.ts",
        ];
        let mut shuffled = want;
        shuffled.reverse();
        assert_eq!(sorted(&shuffled), want);
    }

    #[test]
    fn strips_body_text_and_keeps_other_keys_in_place() {
        let g = r#"{"meta":{"version":1},"nodes":[{"id":"b","body_text":"x","z":1},{"id":"a"}],"edges":[]}"#;
        let out = wiring_from_text(g).unwrap();
        assert_eq!(
            out,
            "{\n  \"meta\": {\n    \"version\": 1\n  },\n  \"nodes\": [\n    {\n      \"id\": \"a\"\n    },\n    {\n      \"id\": \"b\",\n      \"z\": 1\n    }\n  ],\n  \"edges\": []\n}\n"
        );
    }

    #[test]
    fn equal_keys_keep_input_order() {
        let g = r#"{"nodes":[],"edges":[{"source":"s","relation":"calls","target":"t","n":1},{"source":"s","relation":"calls","target":"t","n":2},{"source":"s","relation":"calls","target":"a"}]}"#;
        let out = wiring_from_text(g).unwrap();
        let a = out.find("\"a\"").unwrap();
        let one = out.find("\"n\": 1").unwrap();
        let two = out.find("\"n\": 2").unwrap();
        assert!(a < one && one < two, "{out}");
    }

    #[test]
    fn rejects_graphs_outside_the_writer_contract() {
        for g in [
            "[]",
            r#"{"nodes":[]}"#,
            r#"{"nodes":[{"id":1}],"edges":[]}"#,
            r#"{"nodes":[],"edges":[{"source":"a","relation":"calls"}]}"#,
        ] {
            assert!(wiring_from_text(g).is_err(), "{g}");
        }
    }
}
