//! Which files a graph build parses, by name: `supportedExtensions` in
//! `src/graph/source-files.ts` and the extension tables it joins.
//!
//! The classifiers here read only the path string; they never touch the file system.

/// `EXTENSIONS` in `src/graph/extract.ts` (the depth tier), in its order.
const DEPTH: &[&str] = &[
    ".tsx", ".jsx", ".mts", ".cts", ".ts", ".mjs", ".cjs", ".js", ".pyi", ".py", ".go", ".java",
    ".kt", ".kts", ".swift", ".php", ".r",
];

/// `GENERIC_LANGS` in `src/graph/generic.ts` (the breadth tier), flattened in its order.
const GENERIC: &[&str] = &[
    ".rs", ".java", ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".rb", ".cs", ".scala",
    ".sc", ".ex", ".exs", ".sol", ".ml", ".mli", ".zig", ".dart", ".clj", ".cljs", ".cljc", ".bb",
    ".nix", ".lua", ".gleam", ".ps1", ".psm1", ".jl", ".glsl", ".sh", ".bash", ".pl", ".pm", ".m",
    ".mm", ".gd", ".res", ".resi", ".groovy", ".gradle", ".elm", ".hs", ".f90", ".f95", ".f03",
    ".f08",
];

/// `CONTAINER_LANGS` in `src/graph/container.ts`, flattened in its order.
const CONTAINER: &[&str] = &[".vue", ".svelte", ".astro"];

fn all() -> impl Iterator<Item = &'static str> {
    DEPTH.iter().chain(GENERIC).chain(CONTAINER).copied()
}

/// `supportedExtensions()`: every extension a parser claims, de-duplicated and sorted.
/// Every entry is ASCII, so byte order is JavaScript's code-unit order.
#[must_use]
pub fn supported_extensions() -> Vec<&'static str> {
    let mut v: Vec<_> = all().collect();
    v.sort_unstable();
    v.dedup();
    v
}

/// Whether `languageOf`, `genericLangOf` or `containerLangOf` claims `path`: each
/// lower-cases the whole path and tests its extensions as suffixes.
#[must_use]
pub fn parser_claims(path: &str) -> bool {
    let lower = path.to_lowercase();
    all().any(|e| lower.ends_with(e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn java_is_listed_once() {
        assert_eq!(
            supported_extensions()
                .iter()
                .filter(|e| **e == ".java")
                .count(),
            1
        );
    }

    #[test]
    fn claims_by_lower_cased_suffix() {
        assert!(parser_claims("src/App.TSX"));
        assert!(parser_claims("analysis.R"));
        assert!(parser_claims("x.test.ts"));
        assert!(!parser_claims("README.md"));
        assert!(!parser_claims("ts"));
        // U+212A KELVIN SIGN lower-cases to ASCII `k` in JavaScript and in Rust alike.
        assert!(parser_claims("build.\u{212A}t"));
    }
}
