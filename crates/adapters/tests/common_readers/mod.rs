#![allow(dead_code)]
//! Explicit synthetic root approval for reader unit tests only.
use orrery_adapters::{
    boundary::ReadBoundary,
    readers::{self, jsonl::ReaderError},
};
use serde_json::Value;
use std::path::Path;
fn boundary(p: &Path) -> Result<ReadBoundary, ReaderError> {
    ReadBoundary::new(&[p.parent().unwrap_or(Path::new(".")).to_path_buf()])
}
pub fn read_json(p: &Path) -> Result<Value, ReaderError> {
    readers::json::read_json(&boundary(p)?, p)
}
pub fn read_jsonl(p: &Path) -> Result<Vec<Value>, ReaderError> {
    readers::jsonl::read_jsonl(&boundary(p)?, p)
}
pub fn read_markdown(p: &Path) -> Result<Value, ReaderError> {
    readers::markdown::read_markdown(&boundary(p)?, p)
}
pub fn read_sqlite(p: &Path, q: &str) -> Result<Vec<Value>, ReaderError> {
    readers::sqlite::read_sqlite(&boundary(p)?, p, q)
}
