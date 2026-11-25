//! Data types and DTOs for blast-radius analysis.

use serde::{Serialize, Serializer};

use super::diff::ChangedFile;
use super::owners::{Owner, Reviewer};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LabelSource {
    Concept,
    Symbol,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TestSignal {
    Changed,
    Stale,
    None,
    Na,
}

fn serialize_blast_depth<S: Serializer>(depth: &usize, serializer: S) -> Result<S::Ok, S::Error> {
    if *depth == usize::MAX {
        serializer.serialize_none()
    } else {
        serializer.serialize_u64(*depth as u64)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Seed {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub path: String,
    pub span: String,
    #[serde(rename = "wholeFile")]
    pub whole_file: bool,
    #[serde(
        rename = "declarationChanged",
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub declaration_changed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LeftBehindSeed {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LeftBehind {
    pub seed: LeftBehindSeed,
    pub id: String,
    pub name: String,
    pub kind: String,
    pub path: String,
    pub span: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub inferred: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct TestReach {
    pub path: String,
    pub depth: usize,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub changed: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub inferred: bool,
    pub symbols: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Impacted {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub path: String,
    pub span: String,
    pub relation: String,
    pub depth: usize,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub inferred: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImpactedModule {
    pub label: String,
    #[serde(rename = "labelSource")]
    pub label_source: LabelSource,
    pub key: String,
    pub files: Vec<String>,
    pub symbols: Vec<Impacted>,
    pub from: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owners: Option<Vec<Owner>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChangedArea {
    pub label: String,
    #[serde(rename = "labelSource")]
    pub label_source: LabelSource,
    pub key: String,
    pub files: Vec<String>,
    pub seeds: usize,
    pub tests: TestSignal,
    #[serde(rename = "testFiles")]
    pub test_files: Vec<String>,
    #[serde(rename = "changedTestFiles")]
    pub changed_test_files: Vec<String>,
    pub reached: usize,
    pub behavioural: usize,
    pub unreached: Vec<String>,
    #[serde(rename = "seedNames")]
    pub seed_names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owners: Option<Vec<Owner>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UnresolvedName {
    pub name: String,
    pub calls: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlastReport {
    pub basis: String,
    #[serde(serialize_with = "serialize_blast_depth")]
    pub depth: usize,
    pub changed: Vec<ChangedFile>,
    pub unindexed: Vec<String>,
    pub deleted: Vec<String>,
    pub seeds: Vec<Seed>,
    pub impacted: Vec<Impacted>,
    pub modules: Vec<ImpactedModule>,
    #[serde(rename = "testModules")]
    pub test_modules: Vec<ImpactedModule>,
    pub areas: Vec<ChangedArea>,
    pub unresolved: Vec<UnresolvedName>,
    #[serde(rename = "leftBehind")]
    pub left_behind: Vec<LeftBehind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tests: Option<Vec<TestReach>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewers: Option<Vec<Reviewer>>,
}

pub struct BlastOptions {
    pub depth: usize,
    pub tests: bool,
    pub seed_all_on_empty_ranges: bool,
}
