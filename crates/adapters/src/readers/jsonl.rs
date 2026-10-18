use crate::boundary::{ReadBoundary, MAX_SOURCE_RECORDS};
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Read},
    path::Path,
};
use thiserror::Error;
#[derive(Debug, Error)]
pub enum ReaderError {
    #[error("Credential file access blocked: {0}")]
    CredentialBlocked(String),
    #[error("Source boundary rejected: {0}")]
    Boundary(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Parse error: {0}")]
    Parse(String),
    #[error("Resource limit: {0}")]
    Limit(String),
    #[error("Retry source read: {0}")]
    Changed(String),
}
pub fn read_jsonl(boundary: &ReadBoundary, path: &Path) -> Result<Vec<Value>, ReaderError> {
    let bytes = boundary.read(path)?;
    parse_jsonl(&bytes.bytes[..])
}
/// A failed line read or malformed record invalidates the whole snapshot.
pub fn parse_jsonl(reader: impl Read) -> Result<Vec<Value>, ReaderError> {
    let mut records = vec![];
    for (line_number, line) in BufReader::new(reader).lines().enumerate() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if records.len() >= MAX_SOURCE_RECORDS {
            return Err(ReaderError::Limit("too many JSONL records".into()));
        }
        records.push(
            serde_json::from_str(trimmed)
                .map_err(|e| ReaderError::Parse(format!("line {}: {e}", line_number + 1)))?,
        );
    }
    Ok(records)
}
