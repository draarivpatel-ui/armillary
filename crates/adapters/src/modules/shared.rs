use crate::adapter_spec::{AdapterDef, HistorySourceDef};
use crate::boundary::{digest, ReadBoundary};
use crate::credentials::is_credential_file;
use crate::engine::SourceContext;
use crate::model::{
    normalized_message_id, normalized_session_id, stable_id, Checkpoint, ContentBlock,
    Evidence, ImportBatch, ImportMode, Message, NormalizedSession, ReadStatus, Session,
    SourceProvenance, Usage, UsageObservation, UsageSemantics,
};
use chrono::DateTime;
use rusqlite::Connection;
use serde_json::Value;
use std::path::Path;
use tempfile::TempDir;

/// Extracts referenced file paths from a tool call argument/input JSON value.
pub fn extract_files_from_value(val: &Value) -> Vec<String> {
    let mut files = Vec::new();

    if let Some(obj) = val.as_object() {
        for key in ["path", "file", "filePath", "filepath", "target", "filename", "file_path", "uri"] {
            if let Some(v) = obj.get(key) {
                if let Some(s) = v.as_str() {
                    if !s.is_empty() && !files.contains(&s.to_string()) {
                        files.push(s.to_string());
                    }
                } else if let Some(arr) = v.as_array() {
                    for item in arr {
                        if let Some(s) = item.as_str() {
                            if !s.is_empty() && !files.contains(&s.to_string()) {
                                files.push(s.to_string());
                            }
                        }
                    }
                }
            }
        }
    } else if let Some(s) = val.as_str() {
        if let Ok(nested) = serde_json::from_str::<Value>(s) {
            return extract_files_from_value(&nested);
        }
    }

    files
}

/// Extracts text content from a string or content blocks array.
pub fn extract_text_from_content(content: &Value) -> String {
    if let Some(s) = content.as_str() {
        return s.trim().to_string();
    }

    if let Some(arr) = content.as_array() {
        let mut parts = Vec::new();
        for item in arr {
            if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                if !text.trim().is_empty() {
                    parts.push(text.trim());
                }
            } else if item.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(text) = item.get("content").and_then(|v| v.as_str()) {
                    if !text.trim().is_empty() {
                        parts.push(text.trim());
                    }
                }
            }
        }
        return parts.join("\n");
    }

    String::new()
}

/// Parses ISO 8601 or numeric Unix millisecond timestamp.
pub fn parse_timestamp_val(val: &Value) -> Option<i64> {
    if let Some(n) = val.as_i64() {
        return Some(n);
    }
    if let Some(f) = val.as_f64() {
        return Some(f as i64);
    }
    if let Some(s) = val.as_str() {
        if let Ok(n) = s.parse::<i64>() {
            return Some(n);
        }
        if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
            return Some(dt.timestamp_millis());
        }
    }
    None
}

/// Reads a JSON file safely using the filesystem boundary.
pub fn read_json_file(boundary: &ReadBoundary, path: &Path) -> Option<(Value, u64, String)> {
    if is_credential_file(path) {
        return None;
    }
    let source_bytes = boundary.read(path).ok()?;
    let offset = source_bytes.bytes.len() as u64;
    let checksum = digest(&source_bytes.bytes);
    let val: Value = serde_json::from_slice(&source_bytes.bytes).ok()?;
    Some((val, offset, checksum))
}

/// Reads a JSONL file through the filesystem boundary with the strict reader: a malformed
/// record fails the whole file, so a snapshot never silently drops a record it accepted before.
/// A credential file is skipped (`Ok(None)`).
pub fn read_jsonl_file(
    boundary: &ReadBoundary,
    path: &Path,
) -> Result<Option<(Vec<Value>, u64, String)>, crate::readers::jsonl::ReaderError> {
    if is_credential_file(path) {
        return Ok(None);
    }
    let source_bytes = boundary.read(path)?;
    let offset = source_bytes.bytes.len() as u64;
    let checksum = digest(&source_bytes.bytes);
    let rows = crate::readers::jsonl::parse_jsonl(&source_bytes.bytes[..])?;
    Ok(Some((rows, offset, checksum)))
}

/// A read-only SQLite snapshot in a private temporary folder. Fields drop in order: the
/// connection closes before the folder is removed.
pub struct SafeSqlite {
    pub conn: Connection,
    /// Byte length of the main database file.
    pub offset: u64,
    /// Checksum over the database, its WAL and its SHM as captured.
    pub digest: String,
    _temp: TempDir,
}

/// The module adapters' SQLite snapshot (R2-RC-4). A thin wrapper over the checked reader in
/// `readers::sqlite`: the database, its -wal and its -shm are read through the boundary three times
/// until they are stable, every read error (limit, change, link, credential) is returned instead of
/// importing the main file alone, and the checksum covers all three files.
pub fn open_sqlite_snapshot(
    boundary: &ReadBoundary,
    db_path: &Path,
) -> Result<SafeSqlite, crate::readers::jsonl::ReaderError> {
    if is_credential_file(db_path) {
        return Err(crate::readers::jsonl::ReaderError::CredentialBlocked(
            db_path.display().to_string(),
        ));
    }
    let snapshot = crate::readers::sqlite::open_sqlite_snapshot(boundary, db_path)?;
    let offset = snapshot.main_len;
    let digest = snapshot.checksum.clone();
    let (conn, temp) = snapshot.into_parts();
    Ok(SafeSqlite { conn, offset, digest, _temp: temp })
}

/// Builds SourceProvenance conforming to CONTRACT.md.
pub fn make_provenance(
    context: &SourceContext,
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    relative_path: &str,
    offset: u64,
    records: u64,
    checksum: &str,
) -> SourceProvenance {
    let clean_path = relative_path.replace('\\', "/");
    let file_identity = if context.store.canonical_root.starts_with("fixture://") {
        format!("synthetic:{}", clean_path)
    } else {
        format!("unix:{}", clean_path)
    };

    SourceProvenance {
        store: context.store.clone(),
        source_id: source.id.clone().unwrap_or_else(|| source.format.clone()),
        adapter_id: adapter.id.clone(),
        adapter_version: adapter.adapter_version.clone(),
        source_path: clean_path,
        file_identity,
        generation: context.generation,
        checkpoint: Checkpoint {
            revision: context.revision,
            offset,
            records,
            digest: checksum.to_string(),
        },
    }
}

/// Builds NormalizedSession and normalizes all session and message IDs according to CONTRACT.md.
pub fn build_session(
    adapter_id: &str,
    provenance: SourceProvenance,
    native_id: Option<String>,
    project_root: Option<String>,
    title: Option<String>,
    started_at: Option<i64>,
    ended_at: Option<i64>,
    model: Option<String>,
    status: String,
    tokens_in: Option<u64>,
    tokens_out: Option<u64>,
    messages: Vec<Message>,
) -> NormalizedSession {
    let session_id = normalized_session_id(
        &provenance.store.id,
        native_id.as_deref(),
        &provenance.source_path,
    );

    let fixed_messages: Vec<Message> = messages
        .into_iter()
        .enumerate()
        .map(|(idx, mut m)| {
            let seq = (idx + 1) as u32;
            m.session_id = session_id.clone();
            m.seq = seq;
            m.id = normalized_message_id(
                &session_id,
                m.native_id.as_deref(),
                &provenance.key(),
                provenance.generation,
                seq,
            );
            m
        })
        .collect();

    let turns = fixed_messages
        .iter()
        .filter(|m| {
            m.role == "user"
                && m.blocks
                    .iter()
                    .any(|b| matches!(b, ContentBlock::Text { .. } | ContentBlock::Code { .. }))
        })
        .count() as u32;

    let mut observations = vec![];
    if tokens_in.is_some() || tokens_out.is_some() {
        observations.push(UsageObservation {
            event_id: stable_id("usage-summary", &[&session_id]),
            semantics: UsageSemantics::Cumulative,
            input_tokens: tokens_in,
            output_tokens: tokens_out,
            at: ended_at.or(started_at),
        });
    }
    let usage = Usage::from_observations(observations).unwrap_or_default();

    let completion = if ended_at.is_some() || ["done", "closed", "completed"].contains(&status.as_str()) {
        Some(Evidence {
            kind: "native_completion".into(),
            detail: "native completed status".into(),
            native_event_id: None,
            at: ended_at.or(started_at),
        })
    } else {
        None
    };

    NormalizedSession {
        session: Session {
            id: session_id,
            agent_id: adapter_id.to_string(),
            installation_id: None,
            native_id,
            provenance,
            project_root,
            title,
            started_at,
            ended_at,
            model,
            status,
            completion,
            turns,
            usage,
            parent_id: None,
            native_parent_id: None,
        },
        messages: fixed_messages,
    }
}

/// Diagnostic code for a reader failure (the same codes the engine uses for whole-file reads).
pub fn reader_error_code(e: &crate::readers::jsonl::ReaderError) -> &'static str {
    use crate::readers::jsonl::ReaderError;
    match e {
        ReaderError::CredentialBlocked(_) => "credential_blocked",
        ReaderError::Boundary(_) => "boundary",
        ReaderError::Io(_) => "io",
        ReaderError::Limit(_) => "limit",
        ReaderError::Changed(_) => "changed",
        ReaderError::Parse(_) => "parse",
    }
}

/// A Failed batch for one source file that could not be read or understood. CONTRACT.md: a failed
/// or incomplete read is never reported as a complete snapshot; it carries a diagnostic and never
/// changes the archive.
pub fn failed_file_batch(
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    context: &SourceContext,
    relative_path: &str,
    error: &crate::readers::jsonl::ReaderError,
) -> ImportBatch {
    use crate::readers::jsonl::ReaderError;
    let provenance = make_provenance(context, adapter, source, relative_path, 0, 0, &"0".repeat(64));
    let diagnostic = armillary_model::ImportDiagnostic {
        source_key: provenance.key(),
        code: reader_error_code(error).into(),
        message: error.to_string(),
        retryable: matches!(error, ReaderError::Io(_) | ReaderError::Changed(_)),
    };
    ImportBatch {
        source: provenance,
        mode: ImportMode::Snapshot,
        read_status: ReadStatus::Failed,
        sessions: vec![],
        diagnostics: vec![diagnostic],
        live_updates: vec![],
    }
}

/// Wraps a NormalizedSession in a snapshot ImportBatch.
pub fn make_batch(session: NormalizedSession) -> ImportBatch {
    ImportBatch {
        source: session.session.provenance.clone(),
        mode: ImportMode::Snapshot,
        read_status: ReadStatus::Complete,
        sessions: vec![session],
        diagnostics: vec![],
        live_updates: vec![],
    }
}
