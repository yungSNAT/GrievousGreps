//! Command branding (`trail` vs `graft`) matching `src/brand.ts`.

use std::env;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Brand {
    Trail,
    Graft,
}

const BRAND_ENV: &str = "TRAIL_INVOKED_AS";

/// Resolve the active brand from `TRAIL_INVOKED_AS`, falling back to `argv[0]`
/// stem, and defaulting to `Trail` when invoked directly as `gg-query`.
pub fn brand() -> Brand {
    if let Some(raw) = env::var_os(BRAND_ENV) {
        let s = raw.to_string_lossy();
        if s.eq_ignore_ascii_case("graft") {
            return Brand::Graft;
        }
        if s.eq_ignore_ascii_case("trail") {
            return Brand::Trail;
        }
    }
    // nosemgrep: rust.lang.security.args-os.args-os -- checks argv[0] stem for CLI display branding only
    if let Some(arg0) = env::args_os().next()
        && let Some(stem) = Path::new(&arg0).file_stem().and_then(|s| s.to_str())
    {
        if stem.eq_ignore_ascii_case("graft") {
            return Brand::Graft;
        }
        if stem.eq_ignore_ascii_case("trail") {
            return Brand::Trail;
        }
    }
    Brand::Trail
}

pub fn brand_name() -> &'static str {
    match brand() {
        Brand::Trail => "trail",
        Brand::Graft => "graft",
    }
}

pub fn tag() -> &'static str {
    match brand() {
        Brand::Trail => "[trail]",
        Brand::Graft => "[graft]",
    }
}

/// Format a CLI command name from its legacy `graft ...` spelling.
pub fn cmd(graft_spelling: &str) -> String {
    if brand() == Brand::Graft {
        return graft_spelling.to_string();
    }
    for (from, to) in [
        ("graft check", "trail build --check"),
        ("graft stats", "trail status"),
        ("graft", "trail"),
    ] {
        if graft_spelling == from {
            return (*to).to_string();
        }
        if let Some(rest) = graft_spelling.strip_prefix(from)
            && rest.starts_with(' ')
        {
            return format!("{to}{rest}");
        }
    }
    graft_spelling.to_string()
}
