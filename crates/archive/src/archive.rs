//! Transactional CF v1 archive. Rejected reads change diagnostics only.
use crate::{
    error::{ArchiveError, Result},
    model::*,
    schema,
};
pub use armillary_model::stable_session_id;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashMap},
    path::Path,
    sync::Mutex,
};

/// Private-use sentinels that wrap a hit inside an FTS snippet. Source text can legitimately
/// contain any markup (including `<mark>`), so highlighting never uses markup.
pub const HIT_START: char = '\u{E000}';
pub const HIT_END: char = '\u{E001}';

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HitKind {
    Message,
    Tool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchResult {
    pub session_id: String,
    pub message_id: String,
    pub seq: u32,
    pub block_index: u32,
    pub kind: HitKind,
    pub snippet: String,
    pub score: f64,
    pub at: Option<i64>,
}
#[derive(Debug, Clone, Default)]
pub struct SessionFilter {
    pub agent: Option<String>,
    pub project: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub status: Option<String>,
    pub model: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}
#[derive(Debug, Clone, Default)]
pub struct SearchFilter {
    pub agent: Option<String>,
    pub project: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}
/// Smallest and largest message time of one session (Unix ms). These are activity times, not an
/// end: `None` means no message of the session has a known time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SessionActivity {
    pub first_at: Option<i64>,
    pub last_at: Option<i64>,
}
/// Longest first-prompt text `first_user_texts` returns (in characters).
pub const FIRST_TEXT_MAX_CHARS: usize = 4096;
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: u64,
    pub limit: u32,
    pub offset: u32,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchiveStats {
    pub agents: u64,
    pub installs: u64,
    pub sessions: u64,
    pub messages: u64,
    pub tool_calls: u64,
    pub search_rows: u64,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportOutcome {
    pub applied: bool,
    pub sessions: u64,
    pub reason: Option<String>,
}
pub struct Archive {
    conn: Mutex<Connection>,
}
impl Archive {
    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }
    pub fn open(path: &Path) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let mut options = std::fs::OpenOptions::new();
            options
                .read(true)
                .write(true)
                .create(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW);
            let file = options
                .open(path)
                .map_err(|e| ArchiveError::Invalid(format!("archive file: {e}")))?;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|e| ArchiveError::Invalid(e.to_string()))?;
        }
        Self::init(Connection::open(path)?)
    }
    /// Delete archive and reset (R2-REV-3): close the database file, delete it with its -wal,
    /// -shm and -journal files, and open a new empty archive at the same path. Runs under the
    /// connection lock, so every holder of this handle sees either the old or the new archive and
    /// none of the old content survives on disk.
    pub fn reset_to_empty(&self, path: &Path) -> Result<()> {
        let mut guard = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let placeholder = Connection::open_in_memory()?;
        let old = std::mem::replace(&mut *guard, placeholder);
        // Checkpoint first so closing cannot leave a -wal behind; a failure here is not fatal
        // because the files are deleted next anyway.
        let _ = old.pragma_update(None, "wal_checkpoint", "TRUNCATE");
        old.close().map_err(|(_, e)| ArchiveError::Sqlite(e))?;
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let mut name = path.as_os_str().to_os_string();
            name.push(suffix);
            match std::fs::remove_file(std::path::PathBuf::from(name)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(ArchiveError::Invalid(format!("could not remove the archive file: {e}"))),
            }
        }
        let fresh = Self::open(path)?;
        *guard = fresh.conn.into_inner().unwrap_or_else(|e| e.into_inner());
        Ok(())
    }
    fn init(mut conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        let version: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > schema::LATEST_VERSION {
            return Err(ArchiveError::Invalid(
                "archive schema is newer than this build".into(),
            ));
        }
        if version < schema::LATEST_VERSION {
            let tx = conn.transaction()?;
            for v in version + 1..=schema::LATEST_VERSION {
                schema::migrate(&tx, v)?;
                // The v1 tables are moved aside by migration 2 and copied over once, right after it.
                if v == 2 {
                    migrate_legacy(&tx)?;
                }
            }
            schema::set_version(&tx, schema::LATEST_VERSION)?;
            tx.commit()?;
        }
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
    pub fn schema_version(&self) -> Result<u32> {
        Ok(self
            .conn
            .lock()
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }
    pub fn register_agent(&self, agent: &Agent) -> Result<()> {
        if agent.id.is_empty() {
            return invalid("agent id is empty");
        }
        self.conn.lock().unwrap().execute("INSERT INTO agents(id,name,vendor,family,kind) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,vendor=excluded.vendor,family=excluded.family,kind=excluded.kind",params![agent.id,agent.name,agent.vendor,agent.family,agent.kind])?;
        Ok(())
    }
    pub fn register_install(&self, install: &Install) -> Result<()> {
        if install.id.is_empty() || install.profile_id.is_empty() {
            return invalid("installation id or profile is empty");
        }
        self.conn.lock().unwrap().execute("INSERT INTO installs(id,agent_id,payload) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",params![install.id,install.agent_id,serde_json::to_string(install)?])?;
        Ok(())
    }
    pub fn agents(&self) -> Result<Vec<Agent>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id,name,vendor,family,kind FROM agents ORDER BY id")?;
        let out = stmt
            .query_map([], |r| {
                Ok(Agent {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    vendor: r.get(2)?,
                    family: r.get(3)?,
                    kind: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(out)
    }
    pub fn import_batch(&self, batch: &ImportBatch) -> Result<ImportOutcome> {
        let result = self.apply_batch(batch);
        if let Err(e) = &result {
            self.record_diagnostic(&ImportDiagnostic {
                source_key: batch.source.key(),
                code: "rejected".into(),
                message: e.to_string(),
                retryable: false,
            })?;
        }
        result
    }
    fn apply_batch(&self, batch: &ImportBatch) -> Result<ImportOutcome> {
        let key = batch.source.key();
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        for d in &batch.diagnostics {
            if d.source_key != key {
                return invalid("diagnostic source does not match batch");
            }
            diagnostic(&tx, d)?;
        }
        if batch.read_status != ReadStatus::Complete {
            diagnostic(
                &tx,
                &ImportDiagnostic {
                    source_key: key,
                    code: "incomplete".into(),
                    message: "read did not produce a complete batch; accepted data preserved"
                        .into(),
                    retryable: true,
                },
            )?;
            tx.commit()?;
            return Ok(ImportOutcome {
                applied: false,
                sessions: 0,
                reason: Some("incomplete".into()),
            });
        }
        validate_batch(batch)?;
        let prior: Option<(String, bool)> = tx
            .query_row(
                "SELECT provenance,tombstoned FROM sources WHERE source_key=?1",
                params![key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let mut new_generation = false;
        if let Some((payload, tombstoned)) = &prior {
            let old: SourceProvenance = serde_json::from_str(payload)?;
            let p = &batch.source;
            let stale = p.generation < old.generation
                || (p.generation == old.generation
                    && p.checkpoint.revision < old.checkpoint.revision);
            let same_revision =
                p.generation == old.generation && p.checkpoint.revision == old.checkpoint.revision;
            if stale || (*tombstoned && p.generation <= old.generation) {
                diagnostic(&tx,&ImportDiagnostic{source_key:key,code:"stale".into(),message:"older generation/revision or deleted source replay; accepted data preserved".into(),retryable:false})?;
                tx.commit()?;
                return Ok(ImportOutcome {
                    applied: false,
                    sessions: 0,
                    reason: Some("stale".into()),
                });
            }
            if same_revision {
                if p.checkpoint != old.checkpoint || p.file_identity != old.file_identity {
                    return invalid("conflicting batch at the same generation/revision");
                }
                // Idempotent replay cannot smuggle content or a live mutation
                // under a checkpoint accepted from a different payload.
                verify_replay(&tx, batch)?;
                tx.commit()?;
                return Ok(ImportOutcome {
                    applied: false,
                    sessions: 0,
                    reason: Some("replay".into()),
                });
            }
            new_generation = p.generation > old.generation;
            if !new_generation
                && (p.file_identity != old.file_identity
                    || p.checkpoint.offset < old.checkpoint.offset
                    || p.checkpoint.records < old.checkpoint.records)
            {
                return invalid("rotation or truncation requires a new observed generation");
            }
            if let ImportMode::Append { from } = &batch.mode {
                if new_generation || from != &old.checkpoint {
                    return invalid("append checkpoint does not match accepted source");
                }
            }
        } else if matches!(batch.mode, ImportMode::Append { .. }) {
            return invalid("append requires an accepted base snapshot");
        }
        // Refuse rebased or conflicting event sequences before any write. A
        // message at an already-accepted (session, seq) with a different id
        // cannot be stored; rows a same-generation snapshot replaces are exempt.
        // Append batches keep their own typed "must advance" rejection below.
        if !matches!(batch.mode, ImportMode::Append { .. }) {
            let replaces_own = matches!(batch.mode, ImportMode::Snapshot) && !new_generation;
            for normalized in &batch.sessions {
                for message in &normalized.messages {
                    let existing: Option<(String, String, i64)> = tx
                        .query_row(
                            "SELECT id,source_key,source_generation FROM messages WHERE session_id=?1 AND seq=?2",
                            params![normalized.session.id, message.seq],
                            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                        )
                        .optional()?;
                    let Some((id, owner, generation)) = existing else {
                        continue;
                    };
                    if id == message.id
                        || (replaces_own && owner == key && generation == batch.source.generation as i64)
                    {
                        continue;
                    }
                    diagnostic(
                        &tx,
                        &ImportDiagnostic {
                            source_key: key,
                            code: "conflicting_sequence".into(),
                            message: format!(
                                "session {} already has a different accepted message at seq {}; a rebased or conflicting event sequence was refused and accepted data preserved",
                                normalized.session.id, message.seq
                            ),
                            retryable: false,
                        },
                    )?;
                    tx.commit()?;
                    return Ok(ImportOutcome {
                        applied: false,
                        sessions: 0,
                        reason: Some("conflicting_sequence".into()),
                    });
                }
            }
        }
        tx.execute("INSERT INTO sources(source_key,store_id,source_path,provenance,tombstoned) VALUES(?1,?2,?3,?4,0) ON CONFLICT(source_key) DO UPDATE SET provenance=excluded.provenance,tombstoned=0",params![key,batch.source.store.id,batch.source.source_path,serde_json::to_string(&batch.source)?])?;
        for normalized in &batch.sessions {
            let mut session = normalized.session.clone();
            let previous: Option<String> = tx
                .query_row(
                    "SELECT payload FROM sessions WHERE id=?1",
                    params![session.id],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(previous) = previous {
                let previous: Session = serde_json::from_str(&previous)?;
                if matches!(batch.mode, ImportMode::Append { .. }) || new_generation {
                    let mut obs = previous.usage.observations;
                    obs.extend(session.usage.observations);
                    session.usage = Usage::from_observations(obs).map_err(ArchiveError::Invalid)?;
                    session.started_at = previous.started_at.or(session.started_at);
                    if session.completion.is_none() {
                        session.completion = previous.completion;
                        session.ended_at = previous.ended_at;
                        if session.completion.is_some() {
                            session.status = previous.status;
                        }
                    }
                    session.project_root = session.project_root.or(previous.project_root);
                    session.title = session.title.or(previous.title);
                    session.model = session.model.or(previous.model);
                    session.installation_id = session.installation_id.or(previous.installation_id);
                    session.parent_id = session.parent_id.or(previous.parent_id);
                    session.native_parent_id =
                        session.native_parent_id.or(previous.native_parent_id);
                }
            }
            write_session(&tx, &session)?;
            tx.execute(
                "INSERT OR IGNORE INTO source_sessions(source_key,session_id) VALUES(?1,?2)",
                params![key, session.id],
            )?;
            if matches!(batch.mode, ImportMode::Snapshot) && !new_generation {
                // Source absence is not deletion. Only content for sessions
                // explicitly present in this complete snapshot is replaced.
                tx.execute(
                    "DELETE FROM messages WHERE source_key=?1 AND session_id=?2 AND source_generation=?3",
                    params![key, session.id, batch.source.generation as i64],
                )?;
            }
            for message in &normalized.messages {
                let prior: Option<String> = tx
                    .query_row(
                        "SELECT payload FROM messages WHERE id=?1",
                        params![message.id],
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(prior) = prior {
                    let old: Message = serde_json::from_str(&prior)?;
                    if old != *message {
                        return invalid("append or rotation changes an accepted native event; request a complete snapshot");
                    }
                    continue;
                }
                if matches!(batch.mode, ImportMode::Append { .. }) {
                    let maximum: Option<u32> = tx.query_row(
                        "SELECT max(seq) FROM messages WHERE session_id=?1",
                        params![session.id],
                        |r| r.get(0),
                    )?;
                    if maximum.is_some_and(|n| message.seq <= n) {
                        return invalid("append event sequence must advance");
                    }
                }
                tx.execute("INSERT INTO messages(id,session_id,source_key,source_generation,seq,at,payload) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![message.id,session.id,key,batch.source.generation as i64,message.seq,message.at,serde_json::to_string(message)?])?;
            }
            let messages = load_messages(&tx, &session.id)?;
            session.turns = messages
                .iter()
                .filter(|m| {
                    m.role == "user"
                        && m.blocks.iter().any(|b| {
                            matches!(b, ContentBlock::Text { .. } | ContentBlock::Code { .. })
                        })
                })
                .count() as u32;
            write_session(&tx, &session)?;
            index_session(&tx, &session, &messages)?;
        }
        for mutation in &batch.live_updates {
            apply_live(&tx, mutation)?;
        }
        tx.commit()?;
        Ok(ImportOutcome {
            applied: true,
            sessions: batch.sessions.len() as u64,
            reason: None,
        })
    }
    pub fn source_checkpoint(&self, key: &str) -> Result<Option<SourceProvenance>> {
        let conn = self.conn.lock().unwrap();
        let p: Option<String> = conn
            .query_row(
                "SELECT provenance FROM sources WHERE source_key=?1 AND tombstoned=0",
                params![key],
                |r| r.get(0),
            )
            .optional()?;
        p.map(|p| serde_json::from_str(&p).map_err(Into::into))
            .transpose()
    }
    pub fn confirm_source_deleted(&self, deletion: &ConfirmedSourceDeletion) -> Result<()> {
        if deletion.evidence.kind != "confirmed_source_deletion"
            || deletion.evidence.detail.is_empty()
        {
            return invalid("source deletion requires explicit confirmed_source_deletion evidence");
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let key = deletion.source.key();
        let old: Option<String> = tx
            .query_row(
                "SELECT provenance FROM sources WHERE source_key=?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?;
        let Some(old) = old else {
            return invalid("cannot confirm deletion of an unknown source");
        };
        let old: SourceProvenance = serde_json::from_str(&old)?;
        if old != deletion.source {
            return invalid("deletion does not match the latest accepted checkpoint");
        }
        let ids = {
            let mut s = tx.prepare("SELECT session_id FROM source_sessions WHERE source_key=?1")?;
            let v = s
                .query_map(params![key], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            v
        };
        tx.execute("DELETE FROM messages WHERE source_key=?1", params![key])?;
        tx.execute(
            "DELETE FROM source_sessions WHERE source_key=?1",
            params![key],
        )?;
        for id in ids {
            clear_index(&tx, &id)?;
            let remains: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM source_sessions WHERE session_id=?1)",
                params![id],
                |r| r.get(0),
            )?;
            if !remains {
                tx.execute("DELETE FROM sessions WHERE id=?1", params![id])?;
            } else {
                let payload: String = tx.query_row(
                    "SELECT payload FROM sessions WHERE id=?1",
                    params![id],
                    |r| r.get(0),
                )?;
                let session: Session = serde_json::from_str(&payload)?;
                index_session(&tx, &session, &load_messages(&tx, &id)?)?;
            }
        }
        tx.execute(
            "UPDATE sources SET tombstoned=1 WHERE source_key=?1",
            params![key],
        )?;
        diagnostic(
            &tx,
            &ImportDiagnostic {
                source_key: key,
                code: "deleted".into(),
                message: deletion.evidence.detail.clone(),
                retryable: false,
            },
        )?;
        tx.commit()?;
        Ok(())
    }
    fn record_diagnostic(&self, d: &ImportDiagnostic) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO import_diagnostics(source_key,payload) VALUES(?1,?2)",
            params![d.source_key, serde_json::to_string(d)?],
        )?;
        Ok(())
    }
    pub fn diagnostics(&self, key: &str) -> Result<Vec<ImportDiagnostic>> {
        let conn = self.conn.lock().unwrap();
        let mut s =
            conn.prepare("SELECT payload FROM import_diagnostics WHERE source_key=?1 ORDER BY id")?;
        decode_rows(&mut s, params![key])
    }
    /// Newest diagnostics first across all sources; `limit` is clamped to 1..=500.
    pub fn recent_diagnostics(&self, limit: u32) -> Result<Vec<ImportDiagnostic>> {
        let conn = self.conn.lock().unwrap();
        let mut s =
            conn.prepare("SELECT payload FROM import_diagnostics ORDER BY id DESC LIMIT ?1")?;
        decode_rows(&mut s, params![limit.clamp(1, 500)])
    }
    /// Drop every diagnostic of one source. The importer calls this before it imports a fresh read
    /// of that source, so the rows describe its latest read only (R-3, r2 fix round 2).
    pub fn clear_diagnostics(&self, key: &str) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM import_diagnostics WHERE source_key=?1", params![key])?;
        Ok(())
    }
    /// Drop the diagnostics with `code` whose source is not in `keep` (a full import run's sources:
    /// a skip notice for a file that is gone). Returns how many rows went.
    pub fn retain_diagnostics_with_code(
        &self,
        code: &str,
        keep: &std::collections::HashSet<String>,
    ) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let rows: Vec<(i64, String, String)> = {
            let mut s = conn.prepare("SELECT id,source_key,payload FROM import_diagnostics")?;
            let v = s
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            v
        };
        let mut dropped = 0usize;
        for (id, key, payload) in rows {
            let d: ImportDiagnostic = serde_json::from_str(&payload)?;
            if d.code == code && !keep.contains(&key) {
                conn.execute("DELETE FROM import_diagnostics WHERE id=?1", params![id])?;
                dropped += 1;
            }
        }
        Ok(dropped)
    }
    /// Like `recent_diagnostics`, plus every older row with `code`, newest first: the Field Guide's
    /// skip notices never fall out of its list behind newer diagnostics.
    pub fn recent_diagnostics_keeping(&self, limit: u32, code: &str) -> Result<Vec<ImportDiagnostic>> {
        let limit = limit.clamp(1, 500) as usize;
        let conn = self.conn.lock().unwrap();
        let mut s = conn.prepare("SELECT payload FROM import_diagnostics ORDER BY id DESC")?;
        let all: Vec<ImportDiagnostic> = decode_rows(&mut s, [])?;
        Ok(all
            .into_iter()
            .enumerate()
            .filter(|(i, d)| *i < limit || d.code == code)
            .map(|(_, d)| d)
            .collect())
    }
    pub fn get_session(&self, id: &str) -> Result<Option<Session>> {
        let conn = self.conn.lock().unwrap();
        let p: Option<String> = conn
            .query_row(
                "SELECT payload FROM sessions WHERE id=?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        p.map(|p| serde_json::from_str(&p).map_err(Into::into))
            .transpose()
    }
    pub fn session_messages(&self, id: &str) -> Result<Vec<Message>> {
        load_messages(&self.conn.lock().unwrap(), id)
    }
    /// One stored message by its id (the id search hits carry).
    pub fn get_message(&self, id: &str) -> Result<Option<Message>> {
        let conn = self.conn.lock().unwrap();
        let p: Option<String> = conn
            .query_row("SELECT payload FROM messages WHERE id=?1", params![id], |r| r.get(0))
            .optional()?;
        p.map(|p| serde_json::from_str(&p).map_err(Into::into)).transpose()
    }
    /// Smallest and largest message time per session, for every id passed (an id with no known
    /// message time gets `SessionActivity::default()`). Unknown times are ignored, never zero.
    pub fn session_activity<S: AsRef<str>>(&self, ids: &[S]) -> Result<HashMap<String, SessionActivity>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT MIN(at), MAX(at) FROM messages WHERE session_id=?1")?;
        let mut out = HashMap::with_capacity(ids.len());
        for id in ids {
            let id = id.as_ref();
            let (first_at, last_at) =
                stmt.query_row(params![id], |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?)))?;
            out.insert(id.to_string(), SessionActivity { first_at, last_at });
        }
        Ok(out)
    }
    /// For each session id, the text of the first user message that has a non-blank text block
    /// (messages scanned in seq order, at most `FIRST_TEXT_SCAN` user messages), cut to
    /// `FIRST_TEXT_MAX_CHARS` characters. Sessions without such a message have no entry.
    pub fn first_user_texts<S: AsRef<str>>(&self, ids: &[S]) -> Result<HashMap<String, String>> {
        const FIRST_TEXT_SCAN: u32 = 100;
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT payload FROM messages WHERE session_id=?1 AND json_extract(payload,'$.role')='user' ORDER BY seq LIMIT ?2",
        )?;
        let mut out = HashMap::new();
        for id in ids {
            let id = id.as_ref();
            let mut rows = stmt.query(params![id, FIRST_TEXT_SCAN])?;
            'rows: while let Some(row) = rows.next()? {
                let message: Message = serde_json::from_str(&row.get::<_, String>(0)?)?;
                for block in &message.blocks {
                    if let ContentBlock::Text { text } = block {
                        if !text.trim().is_empty() {
                            out.insert(id.to_string(), text.chars().take(FIRST_TEXT_MAX_CHARS).collect());
                            break 'rows;
                        }
                    }
                }
            }
        }
        Ok(out)
    }
    pub fn messages_page(&self, id: &str, limit: u32, offset: u32) -> Result<Page<Message>> {
        let limit = limit.clamp(1, 200);
        let conn = self.conn.lock().unwrap();
        let total: u64 = conn.query_row(
            "SELECT count(*) FROM messages WHERE session_id=?1",
            params![id],
            |r| r.get::<_, i64>(0),
        )? as u64;
        let mut s = conn.prepare(
            "SELECT payload FROM messages WHERE session_id=?1 ORDER BY seq LIMIT ?2 OFFSET ?3",
        )?;
        Ok(Page {
            items: decode_rows(&mut s, params![id, limit, offset])?,
            total,
            limit,
            offset,
        })
    }
    pub fn sessions_query(&self, f: &SessionFilter) -> Result<Page<Session>> {
        let limit = f.limit.unwrap_or(50).clamp(1, 200);
        let offset = f.offset.unwrap_or(0);
        let conn = self.conn.lock().unwrap();
        const WHERE:&str="WHERE (?1 IS NULL OR agent_id=?1) AND (?2 IS NULL OR project_root=?2) AND (?3 IS NULL OR started_at>=?3) AND (?4 IS NULL OR started_at<=?4) AND (?5 IS NULL OR status=?5) AND (?6 IS NULL OR model=?6)";
        let total: u64 = conn.query_row(
            &format!("SELECT count(*) FROM sessions {WHERE}"),
            params![f.agent, f.project, f.from, f.to, f.status, f.model],
            |r| r.get::<_, i64>(0),
        )? as u64;
        let mut s = conn.prepare(&format!(
            "SELECT payload FROM sessions {WHERE} ORDER BY started_at DESC,id LIMIT ?7 OFFSET ?8"
        ))?;
        Ok(Page {
            items: decode_rows(
                &mut s,
                params![f.agent, f.project, f.from, f.to, f.status, f.model, limit, offset],
            )?,
            total,
            limit,
            offset,
        })
    }
    pub fn search(&self, query: &str, f: &SearchFilter) -> Result<Vec<SearchResult>> {
        let terms = query
            .split_whitespace()
            .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" ");
        if terms.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn.lock().unwrap();
        let sql = format!("SELECT session_id,message_id,seq,block_index,kind,snippet(search_index,0,'{HIT_START}','{HIT_END}',' ... ',12),bm25(search_index),at FROM search_index WHERE search_index MATCH ?1 AND (?2 IS NULL OR agent_id=?2) AND (?3 IS NULL OR project_root=?3) AND (?4 IS NULL OR at>=?4) AND (?5 IS NULL OR at<=?5) ORDER BY bm25(search_index),session_id,seq,block_index LIMIT ?6 OFFSET ?7");
        let mut s = conn.prepare(&sql)?;
        let v = s
            .query_map(
                params![
                    terms,
                    f.agent,
                    f.project,
                    f.from,
                    f.to,
                    // 201 so a caller paging with limit 200 can ask for one extra row to learn has_more.
                    f.limit.unwrap_or(20).clamp(1, 201),
                    f.offset.unwrap_or(0)
                ],
                |r| {
                    Ok(SearchResult {
                        session_id: r.get(0)?,
                        message_id: r.get(1)?,
                        seq: r.get(2)?,
                        block_index: r.get(3)?,
                        kind: if r.get::<_, String>(4)? == "tool" {
                            HitKind::Tool
                        } else {
                            HitKind::Message
                        },
                        snippet: r.get(5)?,
                        score: -r.get::<_, f64>(6)?,
                        at: r.get(7)?,
                    })
                },
            )?
            .collect::<rusqlite::Result<_>>()?;
        Ok(v)
    }
    pub fn live_list(&self) -> Result<Vec<Live>> {
        let conn = self.conn.lock().unwrap();
        let mut s = conn.prepare("SELECT payload FROM live ORDER BY observed_at DESC")?;
        decode_rows(&mut s, [])
    }
    pub fn live_update(&self, mutation: &LiveMutation) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        apply_live(&tx, mutation)?;
        tx.commit()?;
        Ok(())
    }
    pub fn stats(&self) -> Result<ArchiveStats> {
        let conn = self.conn.lock().unwrap();
        let count = |table: &str| -> Result<u64> {
            Ok(
                conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| {
                    r.get::<_, i64>(0)
                })? as u64,
            )
        };
        let tools:u64=conn.query_row("SELECT count(*) FROM messages,json_each(messages.payload,'$.blocks') WHERE json_extract(json_each.value,'$.type')='tool_call'",[],|r|r.get::<_,i64>(0))? as u64;
        Ok(ArchiveStats {
            agents: count("agents")?,
            installs: count("installs")?,
            sessions: count("sessions")?,
            messages: count("messages")?,
            tool_calls: tools,
            search_rows: count("search_index")?,
        })
    }
    pub fn compact(&self) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let sessions = {
            let mut s = tx.prepare("SELECT payload FROM sessions")?;
            decode_rows::<Session, _>(&mut s, [])?
        };
        for s in sessions {
            index_session(&tx, &s, &load_messages(&tx, &s.id)?)?;
        }
        tx.commit()?;
        conn.execute_batch("VACUUM; PRAGMA optimize;")?;
        Ok(())
    }
}
fn invalid<T>(m: &str) -> Result<T> {
    Err(ArchiveError::Invalid(m.into()))
}
fn decode_rows<T: DeserializeOwned, P: rusqlite::Params>(
    s: &mut rusqlite::Statement<'_>,
    p: P,
) -> Result<Vec<T>> {
    s.query_map(p, |r| r.get::<_, String>(0))?
        .map(|r| Ok(serde_json::from_str(&r?)?))
        .collect()
}
fn load_messages(conn: &Connection, id: &str) -> Result<Vec<Message>> {
    let mut s = conn.prepare("SELECT payload FROM messages WHERE session_id=?1 ORDER BY seq")?;
    decode_rows(&mut s, params![id])
}
fn write_session(tx: &Transaction<'_>, s: &Session) -> Result<()> {
    tx.execute("INSERT INTO sessions(id,agent_id,native_id,store_id,project_root,title,started_at,ended_at,status,model,payload) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(id) DO UPDATE SET agent_id=excluded.agent_id,project_root=excluded.project_root,title=excluded.title,started_at=excluded.started_at,ended_at=excluded.ended_at,status=excluded.status,model=excluded.model,payload=excluded.payload",params![s.id,s.agent_id,s.native_id,s.provenance.store.id,s.project_root,s.title,s.started_at,s.ended_at,s.status,s.model,serde_json::to_string(s)?])?;
    Ok(())
}
fn clear_index(tx: &Transaction<'_>, id: &str) -> Result<()> {
    tx.execute("DELETE FROM search_index WHERE rowid IN (SELECT rowid FROM search_rows WHERE session_id=?1)",params![id])?;
    tx.execute("DELETE FROM search_rows WHERE session_id=?1", params![id])?;
    Ok(())
}
fn index_session(tx: &Transaction<'_>, s: &Session, messages: &[Message]) -> Result<()> {
    clear_index(tx, &s.id)?;
    for m in messages {
        for (index, b) in m.blocks.iter().enumerate() {
            let kind = if matches!(
                b,
                ContentBlock::ToolCall { .. } | ContentBlock::ToolResult { .. }
            ) {
                "tool"
            } else {
                "message"
            };
            tx.execute("INSERT INTO search_index(text,session_id,message_id,seq,block_index,kind,at,agent_id,project_root) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![b.search_text(),s.id,m.id,m.seq,index as u32,kind,m.at,s.agent_id,s.project_root])?;
            tx.execute(
                "INSERT INTO search_rows(rowid,session_id,message_id) VALUES(?1,?2,?3)",
                params![tx.last_insert_rowid(), s.id, m.id],
            )?;
        }
    }
    Ok(())
}
fn diagnostic(tx: &Transaction<'_>, d: &ImportDiagnostic) -> Result<()> {
    tx.execute(
        "INSERT INTO import_diagnostics(source_key,payload) VALUES(?1,?2)",
        params![d.source_key, serde_json::to_string(d)?],
    )?;
    Ok(())
}
fn validate_batch(b: &ImportBatch) -> Result<()> {
    let p = &b.source;
    if !p.store.valid()
        || p.source_id.is_empty()
        || p.adapter_id.is_empty()
        || p.adapter_version.is_empty()
        || p.file_identity.is_empty()
    {
        return invalid("invalid source provenance");
    }
    if p.source_path.is_empty()
        || Path::new(&p.source_path).is_absolute()
        || p.source_path.split('/').any(|c| c == ".." || c.is_empty())
    {
        return invalid("source path must be store-relative");
    }
    if p.generation == 0
        || p.generation > MAX_SAFE_INTEGER
        || p.checkpoint.revision == 0
        || p.checkpoint.revision > MAX_SAFE_INTEGER
        || p.checkpoint.offset > MAX_SAFE_INTEGER
        || p.checkpoint.records > MAX_SAFE_INTEGER
        || p.checkpoint.digest.len() != 64
        || !p.checkpoint.digest.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return invalid("invalid checkpoint");
    }
    let mut sessions = BTreeSet::new();
    for n in &b.sessions {
        let s = &n.session;
        if s.provenance != *p
            || s.id != normalized_session_id(&p.store.id, s.native_id.as_deref(), &p.source_path)
            || s.native_id.as_deref().is_some_and(str::is_empty)
            || s.agent_id.is_empty()
            || !sessions.insert(&s.id)
        {
            return invalid("invalid or duplicate normalized session identity/provenance");
        }
        if s.started_at
            .is_some_and(|t| t.unsigned_abs() > MAX_SAFE_INTEGER)
            || s.ended_at
                .is_some_and(|t| t.unsigned_abs() > MAX_SAFE_INTEGER)
            || matches!((s.started_at,s.ended_at),(Some(a),Some(z)) if z<a)
        {
            return invalid("invalid session timestamp");
        }
        if (s.ended_at.is_some() || ["done", "closed", "completed"].contains(&s.status.as_str()))
            && s.completion.is_none()
        {
            return invalid("completion requires native evidence");
        }
        if Usage::from_observations(s.usage.observations.clone()).map_err(ArchiveError::Invalid)?
            != s.usage
        {
            return invalid("usage totals do not match explicit observations");
        }
        let mut seq = 0;
        let mut ids = BTreeSet::new();
        for m in &n.messages {
            if m.session_id != s.id
                || m.id.is_empty()
                || m.seq <= seq
                || !ids.insert(&m.id)
                || m.blocks.is_empty()
            {
                return invalid("invalid ordered message");
            }
            if m.id
                != normalized_message_id(
                    &s.id,
                    m.native_id.as_deref(),
                    &p.key(),
                    p.generation,
                    m.seq,
                )
            {
                return invalid("message id does not match shared identity algorithm");
            }
            if m.at.is_some_and(|t| t.unsigned_abs() > MAX_SAFE_INTEGER) {
                return invalid("message timestamp outside JSON-safe range");
            }
            for block in &m.blocks {
                if matches!(block,ContentBlock::ToolCall{call_id,..}|ContentBlock::ToolResult{call_id,..} if call_id.is_empty())
                {
                    return invalid("tool block requires call id");
                }
            }
            seq = m.seq;
        }
    }
    for m in &b.live_updates {
        if !sessions.contains(&m.session_id) {
            return invalid("batch live action must refer to an imported session");
        }
    }
    Ok(())
}
fn verify_replay(tx: &Transaction<'_>, b: &ImportBatch) -> Result<()> {
    for n in &b.sessions {
        let current: Option<String> = tx
            .query_row(
                "SELECT payload FROM sessions WHERE id=?1",
                params![n.session.id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(current) = current else {
            return invalid("checkpoint replay contains an unknown session");
        };
        let current: Session = serde_json::from_str(&current)?;
        if current != n.session {
            return invalid("checkpoint replay changes session metadata");
        }
        for m in &n.messages {
            let old: Option<String> = tx
                .query_row(
                    "SELECT payload FROM messages WHERE id=?1",
                    params![m.id],
                    |r| r.get(0),
                )
                .optional()?;
            if old
                .as_ref()
                .map(|p| serde_json::from_str::<Message>(p))
                .transpose()?
                .as_ref()
                != Some(m)
            {
                return invalid("checkpoint replay changes accepted message");
            }
        }
    }
    // Identical update/remove actions are harmless; replay does not apply them.
    Ok(())
}
fn apply_live(tx: &Transaction<'_>, m: &LiveMutation) -> Result<()> {
    match &m.action {
        LiveAction::Preserve => {}
        LiveAction::Remove { evidence } => {
            if evidence.kind.is_empty() || evidence.detail.is_empty() {
                return invalid("live removal needs evidence");
            }
            let old: Option<i64> = tx
                .query_row(
                    "SELECT observed_at FROM live WHERE session_id=?1",
                    params![m.session_id],
                    |r| r.get(0),
                )
                .optional()?;
            if old.is_some_and(|old| evidence.at.is_none_or(|at| at < old)) {
                return invalid(
                    "live removal must have evidence at least as new as the stored observation",
                );
            }
            tx.execute(
                "DELETE FROM live WHERE session_id=?1",
                params![m.session_id],
            )?;
        }
        LiveAction::Update { value: l } => {
            if l.session_id != m.session_id
                || l.observed_at.unsigned_abs() > MAX_SAFE_INTEGER
                || l.since.is_some_and(|t| t > l.observed_at)
                || l.expires_at.is_some_and(|t| t < l.observed_at)
                || (l.state != LiveState::Unknown
                    && (l.evidence.is_empty() || l.confidence == Confidence::Unknown))
            {
                return invalid("live state requires observation time, valid bounds and evidence");
            }
            let old: Option<i64> = tx
                .query_row(
                    "SELECT observed_at FROM live WHERE session_id=?1",
                    params![m.session_id],
                    |r| r.get(0),
                )
                .optional()?;
            if old.is_some_and(|old| old > l.observed_at) {
                return invalid("stale live observation");
            }
            tx.execute("INSERT INTO live(session_id,observed_at,payload) VALUES(?1,?2,?3) ON CONFLICT(session_id) DO UPDATE SET observed_at=excluded.observed_at,payload=excluded.payload",params![m.session_id,l.observed_at,serde_json::to_string(l)?])?;
        }
    }
    Ok(())
}
/// Migrate v1 content without inventing profile identity or reliable lifecycle.
/// The unresolved legacy store is separate until integration explicitly reimports.
fn migrate_legacy(tx: &Transaction<'_>) -> Result<()> {
    let originals = {
        let mut stmt=tx.prepare("SELECT id,agent_id,native_id,project_root,title,started_at,ended_at,model,status,turns,tokens_in,tokens_out,parent_id FROM legacy_sessions ORDER BY id")?;
        let v = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, i64>(10)?,
                    r.get::<_, i64>(11)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        v
    };
    let mut migrated_ids = std::collections::BTreeMap::new();
    for (
        old_id,
        agent_id,
        native_id,
        project,
        title,
        started,
        ended,
        model,
        status,
        tokens_in,
        tokens_out,
    ) in originals
    {
        let store = StoreIdentity::new(
            &format!("legacy:{agent_id}"),
            "legacy://unresolved",
            "legacy-unresolved",
        );
        let id = stable_session_id(&store.id, &native_id);
        migrated_ids.insert(old_id.clone(), id.clone());
        let mut provenance = SourceProvenance {
            store,
            source_id: "legacy-v1".into(),
            adapter_id: "legacy-v1".into(),
            adapter_version: "1".into(),
            source_path: format!("sessions/{old_id}"),
            file_identity: format!("legacy:{old_id}"),
            generation: 1,
            checkpoint: Checkpoint {
                revision: 1,
                offset: 0,
                records: 0,
                digest: stable_id("legacy-checkpoint", &[&old_id]),
            },
        };
        let key = provenance.key();
        let rows = {
            let mut s = tx.prepare(
                "SELECT seq,role,text,at FROM legacy_messages WHERE session_id=?1 ORDER BY seq",
            )?;
            let v = s
                .query_map(params![old_id], |r| {
                    Ok((
                        r.get::<_, u32>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            v
        };
        let mut messages = vec![];
        for (seq, role, text, at) in rows {
            let seq = seq
                .checked_add(1)
                .ok_or_else(|| ArchiveError::Invalid("legacy seq overflow".into()))?;
            messages.push(Message {
                id: normalized_message_id(&id, None, &key, 1, seq),
                session_id: id.clone(),
                native_id: None,
                seq,
                role,
                at: (at != 0).then_some(at),
                blocks: vec![ContentBlock::Text { text }],
            });
        }
        let tools = {
            let mut s=tx.prepare("SELECT seq,name,input_summary,result_summary,files FROM legacy_tool_calls WHERE session_id=?1 ORDER BY seq")?;
            let v = s
                .query_map(params![old_id], |r| {
                    Ok((
                        r.get::<_, u32>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            v
        };
        for (seq, name, input, result, files) in tools {
            let seq = seq
                .checked_add(1)
                .ok_or_else(|| ArchiveError::Invalid("legacy seq overflow".into()))?;
            let call_id = stable_id("tool", &[&id, &format!("legacy:{seq}")]);
            let mut blocks = vec![ContentBlock::ToolCall {
                call_id: call_id.clone(),
                native_id: None,
                name,
                input: serde_json::Value::String(input),
                files: serde_json::from_str(&files)?,
            }];
            if !result.is_empty() {
                blocks.push(ContentBlock::ToolResult {
                    call_id,
                    output: serde_json::Value::String(result),
                    is_error: None,
                });
            }
            if let Some(m) = messages.iter_mut().find(|m| m.seq == seq) {
                m.blocks.extend(blocks);
            } else {
                messages.push(Message {
                    id: normalized_message_id(&id, None, &key, 1, seq),
                    session_id: id.clone(),
                    native_id: None,
                    seq,
                    role: "assistant".into(),
                    at: None,
                    blocks,
                });
            }
        }
        messages.sort_by_key(|m| m.seq);
        provenance.checkpoint.offset = messages.len() as u64;
        provenance.checkpoint.records = messages.len() as u64;
        tx.execute(
            "INSERT INTO sources(source_key,store_id,source_path,provenance) VALUES(?1,?2,?3,?4)",
            params![
                key,
                provenance.store.id,
                provenance.source_path,
                serde_json::to_string(&provenance)?
            ],
        )?;
        let usage = Usage::from_observations(vec![UsageObservation {
            event_id: stable_id("usage-summary", &[&id]),
            semantics: UsageSemantics::Unknown,
            input_tokens: Some(
                u64::try_from(tokens_in)
                    .map_err(|_| ArchiveError::Invalid("negative legacy usage".into()))?,
            ),
            output_tokens: Some(
                u64::try_from(tokens_out)
                    .map_err(|_| ArchiveError::Invalid("negative legacy usage".into()))?,
            ),
            at: None,
        }])
        .map_err(ArchiveError::Invalid)?;
        let session = Session {
            id: id.clone(),
            agent_id,
            installation_id: None,
            native_id: Some(native_id),
            provenance,
            project_root: (!project.is_empty()).then_some(project),
            title: (!title.is_empty()).then_some(title),
            started_at: (started != 0).then_some(started),
            ended_at: None,
            model,
            status: "unknown".into(),
            completion: None,
            turns: messages.iter().filter(|m| m.role == "user").count() as u32,
            usage,
            parent_id: None,
            native_parent_id: None,
        };
        write_session(tx, &session)?;
        tx.execute(
            "INSERT INTO source_sessions(source_key,session_id) VALUES(?1,?2)",
            params![key, id],
        )?;
        for m in &messages {
            tx.execute("INSERT INTO messages(id,session_id,source_key,source_generation,seq,at,payload) VALUES(?1,?2,?3,1,?4,?5,?6)",params![m.id,id,key,m.seq,m.at,serde_json::to_string(m)?])?;
        }
        index_session(tx, &session, &messages)?;
        diagnostic(tx,&ImportDiagnostic{source_key:key,code:"legacy_identity_unresolved".into(),message:format!("v1 session {old_id} migrated without guessing a profile; prior lifecycle={status}, prior ended_at={ended:?}, prior parent link requires source reimport"),retryable:false})?;
    }
    let live_rows = {
        let mut s = tx.prepare("SELECT session_id,since FROM legacy_live")?;
        let v = s
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        v
    };
    for (old, since) in live_rows {
        if let Some(id) = migrated_ids.get(&old) {
            let l = Live {
                session_id: id.clone(),
                state: LiveState::Unknown,
                since: None,
                observed_at: since,
                evidence: vec![Evidence {
                    kind: "legacy_unverified".into(),
                    detail: "v1 live state has no observation evidence".into(),
                    native_event_id: None,
                    at: Some(since),
                }],
                confidence: Confidence::Unknown,
                process: None,
                expires_at: None,
            };
            tx.execute(
                "INSERT INTO live(session_id,observed_at,payload) VALUES(?1,?2,?3)",
                params![id, since, serde_json::to_string(&l)?],
            )?;
        }
    }
    let installs = {
        let mut s = tx.prepare("SELECT agent_id,version,paths FROM legacy_installs")?;
        let v = s
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        v
    };
    for (agent_id, version, paths) in installs {
        let install = Install {
            id: stable_id(
                "installation",
                &[&agent_id, "legacy-unresolved", "legacy-unresolved"],
            ),
            agent_id,
            version,
            executable_path: None,
            profile_id: "legacy-unresolved".into(),
            store_ids: vec![],
            paths: serde_json::from_str(&paths)?,
        };
        tx.execute(
            "INSERT INTO installs(id,agent_id,payload) VALUES(?1,?2,?3)",
            params![
                install.id,
                install.agent_id,
                serde_json::to_string(&install)?
            ],
        )?;
    }
    tx.execute_batch("DROP TABLE legacy_live; DROP TABLE legacy_messages; DROP TABLE legacy_tool_calls; DROP TABLE legacy_sessions; DROP TABLE legacy_installs; DROP TABLE legacy_search_rows; DROP TABLE legacy_search_index;")?;
    Ok(())
}
