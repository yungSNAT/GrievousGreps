#![forbid(unsafe_code)]
//! Native Rust indexing engine for GrievousGreps, ported stage by stage from `src/graph`.
//! Each stage matches the TypeScript output byte for byte before it is wired in.

pub mod deploy;
pub mod json;
pub mod safe_write;
pub mod source_files;
pub mod wiring;
