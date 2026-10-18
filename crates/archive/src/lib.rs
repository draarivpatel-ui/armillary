//! orrery-archive: the normalized local session archive for Orrery (SPEC section 4).
//!
//! SQLite (rusqlite, bundled) + FTS5, incremental idempotent import keyed by
//! (agent_id, native session id), filtered queries with paging, ranked search
//! with snippets, and compaction. All times are Unix milliseconds.

pub mod archive;
pub mod error;
pub mod model;
pub mod schema;

pub use archive::{
    Archive, ArchiveStats, HitKind, ImportOutcome, Page, SearchFilter, SearchResult, SessionActivity, SessionFilter,
    FIRST_TEXT_MAX_CHARS, HIT_END, HIT_START,
};
pub use error::{ArchiveError, Result};
pub use model::*;
