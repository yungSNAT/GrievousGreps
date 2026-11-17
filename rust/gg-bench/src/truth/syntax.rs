//! What one line of source says: which files a symbol may be picked from, whether a reference
//! is a call and whether a value holds a function.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    Python,
    TypeScript,
    Rust,
    Go,
    CSharp,
}

impl Language {
    pub fn parse(name: &str) -> Result<Self, String> {
        Ok(match name {
            "Python" => Self::Python,
            "TypeScript" => Self::TypeScript,
            "Rust" => Self::Rust,
            "Go" => Self::Go,
            "C#" => Self::CSharp,
            _ => return Err(format!("lsp-truth does not read {name} repositories")),
        })
    }

    pub(super) fn source(self, file: &str) -> bool {
        match self {
            Self::Python => file.ends_with(".py"),
            Self::TypeScript => {
                [".ts", ".tsx", ".mts", ".cts"]
                    .iter()
                    .any(|e| file.ends_with(e))
                    && ![".d.ts", ".d.mts", ".d.cts"]
                        .iter()
                        .any(|e| file.ends_with(e))
            }
            Self::Rust => file.ends_with(".rs"),
            Self::Go => file.ends_with(".go"),
            Self::CSharp => file.ends_with(".cs"),
        }
    }
}

/// Folders whose files are never picked from: tests, examples, benchmarks, documentation and
/// vendored or built code. Their calls still count as truth rows.
const NOT_PICKED: [&str; 19] = [
    "test",
    "tests",
    "testing",
    "__tests__",
    "testdata",
    "fixtures",
    "example",
    "examples",
    "bench",
    "benches",
    "benchmark",
    "benchmarks",
    "doc",
    "docs",
    "vendor",
    "node_modules",
    "target",
    "dist",
    "build",
];

/// Whether a file's definitions may be picked: a source file of the language, outside test,
/// example and generated folders, and not itself a test file.
pub fn pickable(language: Language, path: &str) -> bool {
    let mut parts: Vec<&str> = path.split('/').collect();
    let file = parts.pop().unwrap_or_default();
    let folder_ok = parts.iter().all(|d| {
        let lower = d.to_lowercase();
        !d.starts_with('.') && !NOT_PICKED.contains(&lower.as_str()) && !d.ends_with("Tests")
    });
    let test_file = file.starts_with("test_")
        || file.contains(".test.")
        || file.contains(".spec.")
        || file.ends_with("_test.py")
        || file.ends_with("_test.go")
        || file.ends_with("Tests.cs")
        || file.ends_with("Test.cs");
    folder_ok && !test_file && language.source(file)
}

/// The text after a balanced bracket that `text` starts with, or none when it does not close.
fn after_brackets(text: &str, open: char, close: char) -> Option<&str> {
    let mut depth = 0;
    for (at, c) in text.char_indices() {
        if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return Some(&text[at + c.len_utf8()..]);
            }
        }
    }
    None
}

/// Whether the reference between byte offsets `start` and `end` of `line` is called.
///
/// shortcut: one line is read, so a call whose `(` starts the next line counts as a reference,
/// not a call; tsc-truth.mjs, which reads the syntax tree, is the upgrade for TypeScript.
pub fn is_call(language: Language, line: &str, start: usize, end: usize) -> bool {
    let mut after = line[end..].trim_start();
    let generic = match language {
        Language::Rust => after.strip_prefix("::").filter(|r| r.starts_with('<')),
        Language::Go if after.starts_with('[') => Some(after),
        Language::TypeScript | Language::CSharp if after.starts_with('<') => Some(after),
        _ => None,
    };
    if let Some(rest) = generic {
        let (open, close) = if language == Language::Go {
            ('[', ']')
        } else {
            ('<', '>')
        };
        match after_brackets(rest, open, close) {
            Some(rest) => after = rest.trim_start(),
            None => return false,
        }
    }
    if after.starts_with('(') || (language == Language::TypeScript && after.starts_with('`')) {
        return true;
    }
    let before = &line[..start];
    let decorator = before
        .trim_end_matches(|c: char| c.is_alphanumeric() || c == '_' || c == '.')
        .ends_with('@');
    let tag = before.trim_end_matches(|c: char| c.is_alphanumeric() || c == '_' || c == '.');
    let jsx = language == Language::TypeScript && tag.ends_with('<') && !tag.ends_with("</");
    (decorator && matches!(language, Language::Python | Language::TypeScript)) || jsx
}

/// The byte offset of a UTF-16 column, as LSP counts characters.
pub(super) fn byte_at(line: &str, column: u64) -> usize {
    let mut units = 0;
    for (at, c) in line.char_indices() {
        if units >= column {
            return at;
        }
        units += c.len_utf16() as u64;
    }
    line.len()
}

/// Whether a value's first line gives it a function, as `let has = (` or `f = lambda x:`. Such a
/// value names the calls inside it, as tsc-truth.mjs names an arrow function by its variable.
///
/// shortcut: one line is read, so a holder whose function starts on the next line is missed.
pub fn function_holder(line: &str) -> bool {
    let Some((_, value)) = line.split_once('=') else {
        return false;
    };
    if value.starts_with(['=', '>']) {
        return false;
    }
    let value = value.trim();
    let bare_parameter = value.split_once("=>").is_some_and(|(p, _)| {
        !p.trim().is_empty() && p.trim().chars().all(|c| c.is_alphanumeric() || c == '_')
    });
    let keyword = ["async", "function", "lambda", "func"].iter().any(|word| {
        value
            .strip_prefix(word)
            .is_some_and(|rest| !rest.starts_with(|c: char| c.is_alphanumeric() || c == '_'))
    });
    keyword
        || value.starts_with('|')
        || value.starts_with("move |")
        || (value.starts_with('(') && (value.contains("=>") || value == "("))
        || bare_parameter
}

pub(super) fn identifier(name: &str) -> bool {
    name.len() >= 3
        && name.chars().all(|c| c.is_alphanumeric() || c == '_')
        && !(name.starts_with("__") && name.ends_with("__"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(language: Language, line: &str, name: &str) -> bool {
        let start = line.find(name).unwrap();
        is_call(language, line, start, start + name.len())
    }

    #[test]
    fn calls_are_told_from_other_references() {
        assert!(call(Language::Python, "    x = lib.run(1)", "run"));
        assert!(call(
            Language::Python,
            "@attr.resolve_types",
            "resolve_types"
        ));
        assert!(!call(Language::Python, "from lib import run", "run"));
        assert!(!call(Language::Python, "    pool.map(run, xs)", "run"));
        assert!(call(
            Language::Rust,
            "let (tx, rx) = mpsc::channel::<()>(1);",
            "channel"
        ));
        assert!(!call(
            Language::Rust,
            "use tokio::sync::mpsc::channel;",
            "channel"
        ));
        assert!(call(Language::Go, "v := Max[int] (a, b)", "Max"));
        assert!(call(Language::CSharp, "var x = Parse<int>(text);", "Parse"));
        assert!(call(
            Language::TypeScript,
            "return <Presence present>",
            "Presence"
        ));
        assert!(!call(Language::TypeScript, "</Presence>", "Presence"));
        assert!(call(
            Language::TypeScript,
            "<UI.Button size={2} />",
            "Button"
        ));
        assert!(!call(Language::TypeScript, "</UI.Button>", "Button"));
        assert!(call(Language::TypeScript, "const q = sql`select`", "sql"));
        assert!(!call(Language::Go, "f := Max", "Max"));
    }

    #[test]
    fn values_holding_functions_name_their_calls() {
        assert!(function_holder("export let has = ("));
        assert!(function_holder("const f = (a, b) => a + b"));
        assert!(function_holder("const g = async (x) => {"));
        assert!(function_holder("const h = x => x"));
        assert!(function_holder("handler = lambda event: run(event)"));
        assert!(function_holder("let add = |a, b| a + b;"));
        assert!(function_holder("\tf := func(x int) int {"));
        assert!(!function_holder("x = lib.run()"));
        assert!(!function_holder("const total = (a + b) * 2"));
        assert!(!function_holder("if a == b {"));
        assert!(!function_holder("items.map(x => x)"));
        assert!(!function_holder("const data = asyncFetch(url)"));
        assert!(!function_holder("f = functools.partial(run, 1)"));
    }

    #[test]
    fn columns_count_utf16_units() {
        assert_eq!(byte_at("é𝄞x", 3), "é𝄞".len());
        assert_eq!(byte_at("ab", 9), 2);
    }

    #[test]
    fn tests_examples_and_generated_files_are_not_picked() {
        assert!(pickable(Language::Python, "src/marshmallow/fields.py"));
        assert!(!pickable(Language::Python, "tests/test_fields.py"));
        assert!(!pickable(Language::Python, "src/pkg/test_x.py"));
        assert!(!pickable(Language::Go, "hooks/syslog/syslog_test.go"));
        assert!(pickable(Language::Go, "entry.go"));
        assert!(!pickable(
            Language::CSharp,
            "test/Serilog.Tests/LoggerTests.cs"
        ));
        assert!(!pickable(Language::TypeScript, "src/types.d.ts"));
        assert!(!pickable(Language::TypeScript, "src/types.d.mts"));
        assert!(!pickable(Language::Rust, "benches/bench.rs"));
        assert!(!pickable(Language::Rust, ".github/x.rs"));
    }
}
