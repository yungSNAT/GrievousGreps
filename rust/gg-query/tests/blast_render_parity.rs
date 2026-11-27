//! Parity of `blast::render` with `src/blast/render.ts` on hand-built reports.
//!
//! Each case's report is serialised to `tests/fixtures/render/<case>.report.json`;
//! `parity/render-parity.ts --record` renders that JSON with the TypeScript
//! `markdownReport`, `textReport` and `mermaidDiagram` into `<case>.md`, `<case>.txt`
//! and `<case>.mmd` (no `.mmd` when TypeScript draws no diagram). Owners' `last`
//! lies in the future, so both sides label it 'today' whatever the clock says.

use std::fs;
use std::path::{Path, PathBuf};

use gg_query::blast::diff::{ChangeStatus, ChangedFile};
use gg_query::blast::owners::{Owner, Reviewer};
use gg_query::blast::render::{markdown_report, mermaid_diagram, text_report};
use gg_query::blast::types::{
    BlastReport, ChangedArea, Impacted, ImpactedModule, LabelSource, LeftBehind, LeftBehindSeed,
    Seed, TestReach, TestSignal, UnresolvedName,
};

const FUTURE: f64 = 4.0e13;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/render")
}

fn strs(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

fn sym(name: &str, path: &str, span: &str, depth: usize, inferred: bool) -> Impacted {
    Impacted {
        id: format!("{path}#{name}"),
        name: name.to_string(),
        kind: "function".to_string(),
        path: path.to_string(),
        span: span.to_string(),
        relation: "calls".to_string(),
        depth,
        inferred,
    }
}

fn module(
    label: &str,
    files: &[&str],
    symbols: Vec<Impacted>,
    from: &[&str],
    owners: Option<Vec<Owner>>,
) -> ImpactedModule {
    ImpactedModule {
        label: label.to_string(),
        label_source: LabelSource::Symbol,
        key: label.to_lowercase(),
        files: strs(files),
        symbols,
        from: strs(from),
        owners,
    }
}

fn owner(name: &str, handle: Option<&str>, commits: usize) -> Owner {
    Owner {
        name: name.to_string(),
        handle: handle.map(str::to_string),
        commits,
        score: commits as f64 / 2.0,
        last: FUTURE,
    }
}

fn reviewer(name: &str, handle: Option<&str>, commits: usize, areas: &[&str]) -> Reviewer {
    Reviewer {
        name: name.to_string(),
        handle: handle.map(str::to_string),
        commits,
        score: commits as f64,
        last: FUTURE,
        areas: strs(areas),
    }
}

struct AreaSpec<'a> {
    label: &'a str,
    files: &'a [&'a str],
    tests: TestSignal,
    test_files: &'a [&'a str],
    changed_test_files: &'a [&'a str],
    reached: usize,
    behavioural: usize,
    unreached: &'a [&'a str],
    owners: Option<Vec<Owner>>,
}

fn area(spec: AreaSpec<'_>) -> ChangedArea {
    ChangedArea {
        label: spec.label.to_string(),
        label_source: LabelSource::Concept,
        key: spec.label.to_lowercase(),
        files: strs(spec.files),
        seeds: 1,
        tests: spec.tests,
        test_files: strs(spec.test_files),
        changed_test_files: strs(spec.changed_test_files),
        reached: spec.reached,
        behavioural: spec.behavioural,
        unreached: strs(spec.unreached),
        seed_names: Vec::new(),
        owners: spec.owners,
    }
}

fn changed(path: &str) -> ChangedFile {
    ChangedFile {
        path: path.to_string(),
        status: ChangeStatus::Modified,
        old_path: None,
        ranges: Vec::new(),
        hunks: Vec::new(),
    }
}

fn seed(name: &str, path: &str, whole_file: bool) -> Seed {
    Seed {
        id: format!("{path}#{name}"),
        name: name.to_string(),
        kind: "function".to_string(),
        path: path.to_string(),
        span: "L1-L3".to_string(),
        whole_file,
        declaration_changed: false,
    }
}

fn behind(seed_name: &str, name: &str, line: Option<usize>, inferred: bool) -> LeftBehind {
    LeftBehind {
        seed: LeftBehindSeed {
            id: format!("src/math.ts#{seed_name}"),
            name: seed_name.to_string(),
        },
        id: format!("src/use.ts#{name}"),
        name: name.to_string(),
        kind: "function".to_string(),
        path: "src/use.ts".to_string(),
        span: "L4-L9".to_string(),
        line,
        inferred,
    }
}

fn reach(path: &str, depth: usize, changed: bool, inferred: bool, symbols: &[&str]) -> TestReach {
    TestReach {
        path: path.to_string(),
        depth,
        changed,
        inferred,
        symbols: strs(symbols),
    }
}

fn empty_report(basis: &str, depth: usize) -> BlastReport {
    BlastReport {
        basis: basis.to_string(),
        depth,
        changed: Vec::new(),
        unindexed: Vec::new(),
        deleted: Vec::new(),
        seeds: Vec::new(),
        impacted: Vec::new(),
        modules: Vec::new(),
        test_modules: Vec::new(),
        areas: Vec::new(),
        unresolved: Vec::new(),
        left_behind: Vec::new(),
        tests: None,
        reviewers: None,
    }
}

fn full_areas() -> Vec<ChangedArea> {
    let ada = owner("Ada Lovelace", Some("ada"), 1);
    let bob = owner("Bob Builder", None, 4);
    let cyd = owner("Cyd Charisse", Some("cyd"), 2);
    vec![
        area(AreaSpec {
            label: "Math",
            files: &["src/math.ts", "src/x.ts"],
            tests: TestSignal::Changed,
            test_files: &["test/math.test.ts"],
            changed_test_files: &["test/math.test.ts", "test/sum.test.ts"],
            reached: 1,
            behavioural: 2,
            unreached: &["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9", "u10"],
            owners: Some(vec![ada.clone(), bob.clone()]),
        }),
        area(AreaSpec {
            label: "Orders",
            files: &["src/order.ts"],
            tests: TestSignal::Stale,
            test_files: &["test/order.test.ts", "test/cart.test.ts"],
            changed_test_files: &[],
            reached: 1,
            behavioural: 1,
            unreached: &["late"],
            owners: None,
        }),
        area(AreaSpec {
            label: "Lib",
            files: &["lib/a.b.ts"],
            tests: TestSignal::Stale,
            test_files: &["test/lib.test.ts"],
            changed_test_files: &[],
            reached: 0,
            behavioural: 0,
            unreached: &[],
            owners: Some(Vec::new()),
        }),
        area(AreaSpec {
            label: "Billing",
            files: &["src/bill.ts"],
            tests: TestSignal::None,
            test_files: &[],
            changed_test_files: &[],
            reached: 0,
            behavioural: 3,
            unreached: &[],
            owners: Some(vec![cyd.clone()]),
        }),
        area(AreaSpec {
            label: "Docs",
            files: &["src/types.ts"],
            tests: TestSignal::Na,
            test_files: &[],
            changed_test_files: &[],
            reached: 0,
            behavioural: 0,
            unreached: &[],
            owners: None,
        }),
    ]
}

fn full_modules() -> Vec<ImpactedModule> {
    let ada = owner("Ada Lovelace", Some("ada"), 1);
    let bob = owner("Bob Builder", None, 4);
    let cyd = owner("Cyd Charisse", Some("cyd"), 2);
    vec![
        module(
            "Checkout <ui>",
            &["src/user.ts", "src/view.ts"],
            vec![
                sym("useTotal", "src/user.ts", "L1-L4", 1, false),
                sym("View", "src/view.ts", "L1-L3", 1, true),
                sym("Deploy", "deploy/Dockerfile", "L1-L2", 2, false),
                sym("Header", "src/view.ts", "L0-L1", 2, false),
                sym("Gone", "src/missing.ts", "L1-L2", 2, false),
                sym("Plain", "src/plain.ts", "L1-L2", 2, false),
            ],
            &["src/math.ts", "src/x.ts", "src/y.ts", "src/z.ts"],
            Some(vec![ada.clone(), cyd.clone()]),
        ),
        module(
            "API \"v2\"",
            &["src/api.ts"],
            vec![sym("route", "src/api.ts", "L3-L9", 1, false)],
            &["src/order.ts", "src/y.ts"],
            None,
        ),
        module(
            "Empty",
            &["src/empty.ts"],
            Vec::new(),
            &[],
            Some(Vec::new()),
        ),
        module(
            "Reports",
            &["src/report.ts"],
            vec![
                sym("monthly", "src/report.ts", "L2-L5", 2, true),
                sym("weekly", "src/report.ts", "L6-L9", 2, false),
            ],
            &["src/math.ts"],
            Some(vec![bob.clone()]),
        ),
        module(
            "Search",
            &["src/search.ts"],
            vec![sym("find", "src/search.ts", "L1", 1, false)],
            &["lib/a.b.ts"],
            None,
        ),
        module(
            "Tax",
            &["src/tax.ts"],
            vec![sym("gst", "src/tax.ts", "L1-L2", 2, false)],
            &["src/math.ts"],
            None,
        ),
        module(
            "Zed",
            &["src/zed.ts"],
            vec![sym("zed", "src/zed.ts", "L1-L2", 2, false)],
            &[],
            None,
        ),
        module(
            "Yak",
            &["src/yak.ts"],
            vec![sym("yak", "src/yak.ts", "L1-L2", 2, false)],
            &[],
            None,
        ),
        module(
            "Xen",
            &["src/xen.ts"],
            vec![sym("xen", "src/xen.ts", "L1-L2", 2, false)],
            &[],
            None,
        ),
        module(
            "Wren",
            &["src/wren.ts"],
            vec![sym("wren", "src/wren.ts", "L1-L2", 2, false)],
            &[],
            None,
        ),
    ]
}

/// Every collapsible section, each list past its cap, quoting from `root/`.
fn full_case() -> BlastReport {
    let mut r = empty_report("main...HEAD", 2);
    r.changed = vec![
        changed("src/math.ts"),
        changed("src/order.ts"),
        changed("lib/a.b.ts"),
    ];
    r.seeds = vec![
        seed("computeTotal", "src/math.ts", false),
        seed("compute", "src/math.ts", false),
        seed("order", "src/order.ts", true),
    ];
    r.unindexed = strs(&["notes/plan.xyz", "notes/other.xyz"]);
    r.deleted = strs(&[
        "old/a.ts", "old/b.ts", "old/c.ts", "old/d.ts", "old/e.ts", "old/f.ts",
    ]);
    r.unresolved = (1..=6)
        .map(|i| UnresolvedName {
            name: format!("name{i}"),
            calls: i,
        })
        .collect();
    r.left_behind = vec![
        behind("compute", "useA", Some(5), false),
        behind("compute", "useB", None, true),
        behind("compute", "useC", Some(7), false),
        behind("computeTotal", "useD", Some(8), false),
        behind("computeTotal", "useE", None, false),
        behind("computeTotal", "useF", Some(9), false),
    ];
    r.areas = full_areas();
    r.modules = full_modules();
    r.impacted = r.modules.iter().flat_map(|m| m.symbols.clone()).collect();
    r.test_modules = (0..3)
        .map(|m| {
            let files: Vec<String> = (0..9)
                .map(|i| format!("test/t{}.test.ts", m * 8 + i))
                .collect();
            let refs: Vec<&str> = files.iter().map(String::as_str).collect();
            module(
                &format!("Tests {m}"),
                &refs,
                vec![sym("it", &files[0], "L1-L2", 1, false)],
                &[],
                None,
            )
        })
        .collect();
    let mut tests = vec![
        reach("test/math.test.ts", 1, true, false, &["a"]),
        reach("test/a.test.ts", 2, false, true, &["a", "b", "c", "d", "e"]),
        reach("test/b.test.ts", 3, false, false, &["a", "b", "c"]),
        reach("test/c.test.ts", 1, false, false, &[]),
    ];
    for i in 0..19 {
        tests.push(reach(
            &format!("test/n{i}.test.ts"),
            2,
            false,
            false,
            &["x"],
        ));
    }
    r.tests = Some(tests);
    r.reviewers = Some(vec![
        reviewer(
            "Ada Lovelace",
            Some("ada"),
            3,
            &["Math", "Checkout <ui>", "Reports"],
        ),
        reviewer("Bob Builder", None, 1, &["Reports"]),
        reviewer(
            "Cyd Charisse",
            Some("cyd"),
            2,
            &["Billing", "Checkout <ui>"],
        ),
        reviewer("Dee Dee", Some("dee"), 1, &["Math"]),
    ]);
    r
}

/// No dependents, one unresolved call, empty test and reviewer lists, full closure.
fn unresolved_case() -> BlastReport {
    let mut r = empty_report("working tree", usize::MAX);
    r.changed = vec![changed("src/math.ts")];
    r.unresolved = vec![UnresolvedName {
        name: "compute".to_string(),
        calls: 1,
    }];
    r.tests = Some(Vec::new());
    r.reviewers = Some(Vec::new());
    r.test_modules = vec![module(
        "Tests",
        &["test/one.test.ts"],
        vec![sym("it", "test/one.test.ts", "L1-L2", 1, false)],
        &[],
        None,
    )];
    r
}

/// No dependents and nothing unresolved; one area whose tests changed.
fn quiet_case() -> BlastReport {
    let mut r = empty_report("HEAD~1", 1);
    r.changed = vec![changed("Makefile")];
    r.areas = vec![area(AreaSpec {
        label: "Build",
        files: &["Makefile"],
        tests: TestSignal::Changed,
        test_files: &[],
        changed_test_files: &["test/build.test.ts"],
        reached: 0,
        behavioural: 0,
        unreached: &[],
        owners: None,
    })];
    r
}

/// Few areas, a long module, one left-behind caller, reviewers but no owners.
fn small_case() -> BlastReport {
    let mut r = empty_report("main...HEAD", 3);
    r.changed = vec![changed("src/math.ts"), changed("src/tax.ts")];
    r.seeds = vec![seed("compute", "src/math.ts", false)];
    r.areas = ["Math", "Tax"]
        .iter()
        .map(|l| {
            area(AreaSpec {
                label: l,
                files: &["src/math.ts"],
                tests: TestSignal::Changed,
                test_files: &[],
                changed_test_files: &["test/m.test.ts"],
                reached: 1,
                behavioural: 1,
                unreached: &[],
                owners: (*l == "Math").then(|| vec![owner("Ada Lovelace", Some("ada"), 2)]),
            })
        })
        .chain(["Ledger", "Rates"].iter().map(|l| {
            area(AreaSpec {
                label: l,
                files: &["src/tax.ts"],
                tests: TestSignal::Stale,
                test_files: &["test/t.test.ts"],
                changed_test_files: &[],
                reached: 1,
                behavioural: 1,
                unreached: &[],
                owners: None,
            })
        }))
        .collect();
    r.modules = vec![
        module(
            "Long",
            &["src/long.ts"],
            (1..=27)
                .map(|i| sym(&format!("f{i}"), "src/long.ts", &format!("L{i}"), 1, false))
                .collect(),
            &["src/math.ts", "src/tax.ts"],
            None,
        ),
        module(
            "Short",
            &["src/short.ts"],
            vec![sym("g", "src/short.ts", "L1", 2, false)],
            &["src/tax.ts"],
            None,
        ),
    ];
    r.impacted = r.modules.iter().flat_map(|m| m.symbols.clone()).collect();
    r.left_behind = vec![behind("compute", "useA", Some(5), false)];
    r.unresolved = vec![
        UnresolvedName {
            name: "a".to_string(),
            calls: 2,
        },
        UnresolvedName {
            name: "b".to_string(),
            calls: 1,
        },
    ];
    r.tests = Some(vec![reach("test/m.test.ts", 1, true, false, &[])]);
    r.test_modules = vec![
        module("T1", &["test/a.test.ts"], Vec::new(), &[], None),
        module("T2", &["test/b.test.ts"], Vec::new(), &[], None),
    ];
    r.reviewers = Some(vec![reviewer("Ada Lovelace", Some("ada"), 1, &["Math"])]);
    r
}

fn cases() -> Vec<(&'static str, BlastReport)> {
    vec![
        ("full", full_case()),
        ("unresolved", unresolved_case()),
        ("quiet", quiet_case()),
        ("small", small_case()),
    ]
}

fn read(path: &Path) -> String {
    fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
        .replace("\r\n", "\n")
}

#[test]
fn reports_serialise_to_the_recorded_json() {
    for (name, report) in cases() {
        let json = format!(
            "{}\n",
            serde_json::to_string_pretty(&report).expect("serialise report")
        );
        assert_eq!(
            json,
            read(&fixtures().join(format!("{name}.report.json"))),
            "{name}: report JSON changed; rerun parity/render-parity.ts --record"
        );
    }
}

#[test]
fn markdown_matches_typescript() {
    let root = fixtures().join("root");
    for (name, report) in cases() {
        let golden = read(&fixtures().join(format!("{name}.md")));
        assert_eq!(markdown_report(&report, Some(&root)), golden, "{name}.md");
    }
}

#[test]
fn text_matches_typescript() {
    for (name, report) in cases() {
        let golden = read(&fixtures().join(format!("{name}.txt")));
        assert_eq!(text_report(&report), golden, "{name}.txt");
    }
}

#[test]
fn mermaid_matches_typescript() {
    for (name, report) in cases() {
        let path = fixtures().join(format!("{name}.mmd"));
        let golden = path.exists().then(|| read(&path));
        assert_eq!(mermaid_diagram(&report), golden, "{name}.mmd");
    }
}

#[test]
fn markdown_without_root_quotes_no_evidence() {
    let md = markdown_report(&full_case(), None);
    assert!(md.contains("- `src/user.ts:L1-L4` — useTotal (calls, depth 1)"));
    assert!(!md.contains("  ```"), "a quote without a root:\n{md}");
}

/// The TypeScript renderer counts the symbol it stops at, so it reports one fewer
/// when the cap falls inside an area; Rust counts the symbols it left out.
#[test]
fn markdown_counts_every_symbol_past_the_cap() {
    let mut r = empty_report("main...HEAD", 1);
    r.modules = vec![
        module(
            "Big",
            &["src/big.ts"],
            (1..=63)
                .map(|i| sym(&format!("b{i}"), "src/big.ts", &format!("L{i}"), 1, false))
                .collect(),
            &[],
            None,
        ),
        module(
            "Next",
            &["src/next.ts"],
            vec![sym("n", "src/next.ts", "L1", 1, false)],
            &[],
            None,
        ),
    ];
    let md = markdown_report(&r, None);
    assert!(md.contains("b60 (calls"), "60th symbol missing:\n{md}");
    assert!(!md.contains("b61 (calls"), "61st symbol listed:\n{md}");
    assert!(!md.contains("**Next**"), "area after the cap listed:\n{md}");
    assert!(md.contains("…4 further symbols not listed."), "{md}");
}
