//! SQLite schema and migrations. The version is stored in PRAGMA user_version;
//! migrations run in order on every open, so opening an old archive upgrades it.

use rusqlite::Transaction;

/// Current schema version. Bump and append a migration when the shape changes.
pub const LATEST_VERSION: u32 = 3;

pub fn current_version(tx: &Transaction<'_>) -> rusqlite::Result<u32> {
    tx.query_row("PRAGMA user_version", [], |r| r.get(0))
}

pub fn set_version(tx: &Transaction<'_>, v: u32) -> rusqlite::Result<()> {
    tx.execute_batch(&format!("PRAGMA user_version = {v}"))
}

/// Apply migration `v` (1-based).
pub fn migrate(tx: &Transaction<'_>, v: u32) -> rusqlite::Result<()> {
    match v {
        1 => tx.execute_batch(SCHEMA_V1),
        2 => tx.execute_batch(SCHEMA_V2),
        3 => tx.execute_batch(SCHEMA_V3),
        _ => panic!("no migration for version {v}"),
    }
}

const SCHEMA_V1: &str = r#"
CREATE TABLE agents (
    id      TEXT PRIMARY KEY,
    name    TEXT NOT NULL,
    vendor  TEXT NOT NULL,
    family  TEXT NOT NULL,
    kind    TEXT NOT NULL
);

CREATE TABLE installs (
    agent_id TEXT PRIMARY KEY,
    version  TEXT,
    paths    TEXT NOT NULL            -- JSON map of logical name -> path
);

CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    agent_id     TEXT NOT NULL REFERENCES agents(id),
    native_id    TEXT NOT NULL,
    project_root TEXT NOT NULL,
    title        TEXT NOT NULL,
    started_at   INTEGER NOT NULL,    -- Unix ms
    ended_at     INTEGER,             -- Unix ms
    model        TEXT,
    status       TEXT NOT NULL,
    turns        INTEGER NOT NULL,
    tokens_in    INTEGER NOT NULL,
    tokens_out   INTEGER NOT NULL,
    parent_id    TEXT,
    UNIQUE (agent_id, native_id)
);

CREATE TABLE messages (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seq        INTEGER NOT NULL,
    role       TEXT NOT NULL,
    text       TEXT NOT NULL,
    at         INTEGER NOT NULL,      -- Unix ms
    PRIMARY KEY (session_id, seq)
);

CREATE TABLE tool_calls (
    session_id     TEXT NOT NULL REFERENCES sessions(id),
    seq            INTEGER NOT NULL,
    name           TEXT NOT NULL,
    input_summary  TEXT NOT NULL,
    result_summary TEXT NOT NULL,
    files          TEXT NOT NULL,     -- JSON array of paths
    PRIMARY KEY (session_id, seq)
);

CREATE TABLE live (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    state      TEXT NOT NULL CHECK (state IN ('working', 'waiting', 'idle', 'done')),
    since      INTEGER NOT NULL       -- Unix ms
);

-- One FTS row per message (kind 'message') and per tool call (kind 'tool',
-- text = name + summaries + file paths). UNINDEXED columns carry the hit
-- position and let search filter without a join.
CREATE VIRTUAL TABLE search_index USING fts5(
    text,
    session_id UNINDEXED,
    seq UNINDEXED,
    kind UNINDEXED,
    at UNINDEXED,
    agent_id UNINDEXED,
    project_root UNINDEXED
);

-- Maps a session to its search_index rowids so re-import can delete them.
CREATE TABLE search_rows (
    rowid      INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL
);

CREATE INDEX idx_sessions_agent_started ON sessions (agent_id, started_at DESC);
CREATE INDEX idx_sessions_project ON sessions (project_root);
CREATE INDEX idx_sessions_started ON sessions (started_at DESC);
CREATE INDEX idx_messages_at ON messages (at);
CREATE INDEX idx_search_rows_session ON search_rows (session_id);
"#;

const SCHEMA_V2: &str = r#"
ALTER TABLE installs RENAME TO legacy_installs;
ALTER TABLE sessions RENAME TO legacy_sessions;
ALTER TABLE messages RENAME TO legacy_messages;
ALTER TABLE tool_calls RENAME TO legacy_tool_calls;
ALTER TABLE live RENAME TO legacy_live;
ALTER TABLE search_index RENAME TO legacy_search_index;
ALTER TABLE search_rows RENAME TO legacy_search_rows;

CREATE TABLE installs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), payload TEXT NOT NULL);
CREATE TABLE sources (
    source_key TEXT PRIMARY KEY, store_id TEXT NOT NULL, source_path TEXT NOT NULL,
    provenance TEXT NOT NULL, tombstoned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sessions (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), native_id TEXT,
    store_id TEXT NOT NULL, project_root TEXT, title TEXT, started_at INTEGER, ended_at INTEGER,
    status TEXT NOT NULL, model TEXT, payload TEXT NOT NULL, UNIQUE(store_id, native_id)
);
CREATE TABLE source_sessions (
    source_key TEXT NOT NULL REFERENCES sources(source_key),
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    PRIMARY KEY(source_key, session_id)
);
CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_key TEXT NOT NULL REFERENCES sources(source_key), source_generation INTEGER NOT NULL, seq INTEGER NOT NULL,
    at INTEGER, payload TEXT NOT NULL, UNIQUE(session_id, seq)
);
CREATE TABLE live (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    observed_at INTEGER NOT NULL, payload TEXT NOT NULL
);
CREATE VIRTUAL TABLE search_index USING fts5(
    text, session_id UNINDEXED, message_id UNINDEXED, seq UNINDEXED,
    block_index UNINDEXED, kind UNINDEXED, at UNINDEXED, agent_id UNINDEXED, project_root UNINDEXED
);
CREATE TABLE search_rows (rowid INTEGER PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL);
CREATE TABLE import_diagnostics (
    id INTEGER PRIMARY KEY, source_key TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX idx_cf_sessions_agent_started ON sessions(agent_id, started_at DESC);
CREATE INDEX idx_cf_sessions_project ON sessions(project_root);
CREATE INDEX idx_cf_messages_source ON messages(source_key);
CREATE INDEX idx_cf_search_session ON search_rows(session_id);
CREATE INDEX idx_cf_diagnostics_source ON import_diagnostics(source_key);
"#;

/// The SQLite stores read by a history module (OpenCode, Crush, Goose, Hermes) once used the total
/// message count as checkpoint offset and records; they now use the database's byte length and one
/// record. Next to an old count, one record looked like a truncation and started a new generation,
/// which merged two copies of the same usage summary. The old checkpoints are rebased here: records
/// become 1, the offset (a message count, never more than the file's byte length) stays, and the
/// generation is kept, so the next read is a new revision of the same file.
///
/// Cline, Roo Code and Kilo Code rewrite their JSON files whole, and earlier builds stored file
/// lengths as the offset: the message file's for a task folder without metadata (7da3bce), or the
/// sum of every file read for a CLI session or a metadata-backed task (c75fece). The offset is now
/// the manifest's or metadata file's length, or 0, so a stored one can be larger than any new read
/// and look like a truncation, which starts a new generation even for unchanged input. Every
/// stored offset of these JSON sources is rebased to 0, so any later read is a new revision of the
/// same generation. Their `sessions.db` keeps its byte-length offset.
const SCHEMA_V3: &str = r#"
UPDATE sources SET provenance = json_set(provenance, '$.checkpoint.records', 1)
WHERE json_extract(provenance, '$.adapter_id') IN ('opencode', 'crush', 'goose', 'hermes-agent-cli')
  AND json_extract(provenance, '$.checkpoint.records') > 1;
UPDATE sessions SET payload = json_set(payload, '$.provenance.checkpoint.records', 1)
WHERE json_extract(payload, '$.provenance.adapter_id') IN ('opencode', 'crush', 'goose', 'hermes-agent-cli')
  AND json_extract(payload, '$.provenance.checkpoint.records') > 1;
UPDATE sources SET provenance = json_set(provenance, '$.checkpoint.offset', 0)
WHERE json_extract(provenance, '$.adapter_id') IN ('cline', 'roo-code', 'kilo-code')
  AND json_extract(provenance, '$.source_path') LIKE '%.json';
UPDATE sessions SET payload = json_set(payload, '$.provenance.checkpoint.offset', 0)
WHERE json_extract(payload, '$.provenance.adapter_id') IN ('cline', 'roo-code', 'kilo-code')
  AND json_extract(payload, '$.provenance.source_path') LIKE '%.json';
"#;
