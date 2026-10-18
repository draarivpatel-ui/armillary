use crate::{boundary::ReadBoundary, readers::jsonl::ReaderError};
use serde_json::Value;
use std::path::Path;
pub fn read_json(boundary: &ReadBoundary, path: &Path) -> Result<Value, ReaderError> {
    let bytes = boundary.read(path)?;
    serde_json::from_slice(&bytes.bytes).map_err(|e| ReaderError::Parse(e.to_string()))
}
