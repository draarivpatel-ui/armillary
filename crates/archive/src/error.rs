use std::fmt;

/// Errors returned by every archive operation.
#[derive(Debug)]
pub enum ArchiveError {
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
    /// A caller passed something the archive refuses to store (empty id, negative time, ...).
    Invalid(String),
}

impl fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ArchiveError::Sqlite(e) => write!(f, "sqlite error: {e}"),
            ArchiveError::Json(e) => write!(f, "json error: {e}"),
            ArchiveError::Invalid(m) => write!(f, "invalid input: {m}"),
        }
    }
}

impl std::error::Error for ArchiveError {}

impl From<rusqlite::Error> for ArchiveError {
    fn from(e: rusqlite::Error) -> Self {
        ArchiveError::Sqlite(e)
    }
}

impl From<serde_json::Error> for ArchiveError {
    fn from(e: serde_json::Error) -> Self {
        ArchiveError::Json(e)
    }
}

pub type Result<T> = std::result::Result<T, ArchiveError>;
