// Cursor CLI history module
// Verification sources:
// - Official documentation: https://cursor.com/docs/cli/overview
// - CLI reference: https://cursor.com/docs/cli/reference/parameters
// - Storage analysis: https://vshulcz.github.io/deja-vu/registry/cursor.html
// - Format specification: https://github.com/xhluca/session-migrate/blob/main/docs/cursor-format.md
// - Storage paths: https://vibe-replay.com/blog/cursor-local-storage/

use super::shared::{
    build_session, extract_files_from_value, extract_text_from_content, fold_digest, make_batch,
    make_provenance, open_sqlite_snapshot, parse_timestamp_val, read_json_file,
    read_jsonl_file,
};
use crate::adapter_spec::{AdapterDef, HistorySourceDef};
use crate::boundary::ReadBoundary;
use crate::credentials::is_credential_file;
use crate::engine::SourceContext;
use crate::model::{ContentBlock, ImportBatch, Message};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub fn parse_batches(
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    context: &SourceContext,
    boundary: &ReadBoundary,
    root: &Path,
) -> Result<Vec<ImportBatch>, Box<dyn std::error::Error>> {
    let mut batches = Vec::new();
    let mut seen_ids = HashSet::new();

    let mut chat_dirs: HashMap<PathBuf, (Option<PathBuf>, Option<PathBuf>)> = HashMap::new();
    let mut transcript_files: HashMap<String, PathBuf> = HashMap::new();

    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() || is_credential_file(path) {
            continue;
        }

        let file_name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };

        if file_name == "meta.json" {
            if let Some(parent) = path.parent() {
                let entry = chat_dirs.entry(parent.to_path_buf()).or_insert((None, None));
                entry.0 = Some(path.to_path_buf());
            }
        } else if file_name == "store.db" {
            if let Some(parent) = path.parent() {
                let entry = chat_dirs.entry(parent.to_path_buf()).or_insert((None, None));
                entry.1 = Some(path.to_path_buf());
            }
        } else if file_name.ends_with(".jsonl") {
            let stem = file_name.trim_end_matches(".jsonl").to_string();
            transcript_files.insert(stem, path.to_path_buf());
        }
    }

    let mut consumed_transcripts = HashSet::new();

    for (dir, (meta_path, db_path)) in chat_dirs {
        if let Some((batch, used_transcript)) = parse_chat_dir(
            adapter,
            source,
            context,
            boundary,
            root,
            &dir,
            meta_path.as_deref(),
            db_path.as_deref(),
            &transcript_files,
        ) {
            if let Some(t) = used_transcript {
                consumed_transcripts.insert(t);
            }
            // A Failed batch has no session to de-duplicate on.
            let fresh = batch.sessions.first().map(|s| seen_ids.insert(s.session.id.clone())).unwrap_or(true);
            if fresh {
                batches.push(batch);
            }
        }
    }

    // Also check for standalone transcripts in *.jsonl
    for (stem, path) in &transcript_files {
        if consumed_transcripts.contains(stem) {
            continue;
        }
        if let Some(batch) =
            parse_standalone_transcript(adapter, source, context, boundary, root, path, stem)
        {
            let fresh = batch.sessions.first().map(|s| seen_ids.insert(s.session.id.clone())).unwrap_or(true);
            if fresh {
                batches.push(batch);
            }
        }
    }

    batches.sort_by(|a, b| {
        let key = |x: &ImportBatch| x.sessions.first().map(|s| s.session.id.clone()).unwrap_or_else(|| x.source.key());
        key(a).cmp(&key(b))
    });
    Ok(batches)
}

fn parse_chat_dir(
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    context: &SourceContext,
    boundary: &ReadBoundary,
    root: &Path,
    chat_dir: &Path,
    meta_path: Option<&Path>,
    db_path: Option<&Path>,
    transcript_files: &HashMap<String, PathBuf>,
) -> Option<(ImportBatch, Option<String>)> {
    let mut raw_id = chat_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("chat")
        .to_string();
    let mut project_root = None;
    let mut title = None;
    let mut started_at = None;
    let mut model = None;
    let mut primary_offset = 0;
    let mut primary_digest = String::new();
    let mut primary_file = None;

    if let Some(mp) = meta_path {
        if let Some((meta_val, offset, digest)) = read_json_file(boundary, mp) {
            primary_offset = offset;
            primary_digest = digest;
            primary_file = Some(mp);

            if let Some(id) = meta_val.get("agentId").and_then(|v| v.as_str()) {
                raw_id = id.to_string();
            }
            if let Some(cwd) = meta_val.get("cwd").and_then(|v| v.as_str()) {
                project_root = Some(cwd.to_string());
            }
            if let Some(name) = meta_val.get("name").and_then(|v| v.as_str()) {
                title = Some(name.to_string());
            }
            if let Some(ts) = meta_val.get("createdAt").and_then(parse_timestamp_val) {
                started_at = Some(ts);
            }
            if let Some(m) = meta_val.get("lastUsedModel").and_then(|v| v.as_str()) {
                model = Some(m.to_string());
            }
        }
    }

    let mut messages = Vec::new();

    if let Some(dp) = db_path {
        let opened = open_sqlite_snapshot(boundary, dp);
        if let Err(e) = &opened {
            // R2-RC-4: an unreadable or changing store (or its WAL) fails this chat loudly
            // instead of importing the main file alone and reporting success.
            let rel = dp.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
            return Some((super::shared::failed_file_batch(adapter, source, context, &rel, e), None));
        }
        if let Ok(safe_db) = opened {
            if primary_file.is_none() {
                primary_offset = safe_db.offset;
                primary_digest = safe_db.digest.clone();
                primary_file = Some(dp);
            } else {
                // The messages live here, not in meta.json: a reply changed in place is a new revision.
                fold_digest(&mut primary_digest, &safe_db.digest);
            }

            // Check meta table
            let meta_exists: bool = safe_db
                .conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='meta'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);

            if meta_exists {
                if let Ok(mut stmt) = safe_db.conn.prepare("SELECT key, value FROM meta") {
                    if let Ok(rows) = stmt.query_map([], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                    }) {
                        for row in rows.flatten() {
                            let (key, value) = row;
                            if key == "0" || key == "meta" || key == "metadata" {
                                if let Ok(meta_val) = serde_json::from_str::<Value>(&value) {
                                    if let Some(id) = meta_val.get("agentId").and_then(|v| v.as_str()) {
                                        if raw_id == "chat" {
                                            raw_id = id.to_string();
                                        }
                                    }
                                    if title.is_none() {
                                        title = meta_val.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
                                    }
                                    if project_root.is_none() {
                                        project_root = meta_val.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string());
                                    }
                                    if started_at.is_none() {
                                        started_at = meta_val.get("createdAt").and_then(parse_timestamp_val);
                                    }
                                    if model.is_none() {
                                        model = meta_val.get("lastUsedModel").and_then(|v| v.as_str()).map(|s| s.to_string());
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            // Check blobs table
            let blobs_exists: bool = safe_db
                .conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='blobs'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);

            if blobs_exists {
                if let Ok(mut stmt) = safe_db.conn.prepare("SELECT data FROM blobs") {
                    if let Ok(rows) = stmt.query_map([], |r| r.get::<_, Vec<u8>>(0)) {
                        for row in rows.flatten() {
                            if let Ok(val) = serde_json::from_slice::<Value>(&row) {
                                parse_cursor_blob_value(&val, &mut messages, started_at);
                            } else if let Ok(s) = std::str::from_utf8(&row) {
                                if let Ok(val) = serde_json::from_str::<Value>(s) {
                                    parse_cursor_blob_value(&val, &mut messages, started_at);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let mut used_transcript = None;
    if messages.is_empty() {
        if let Some(t_path) = transcript_files.get(&raw_id) {
            let read = read_jsonl_file(boundary, t_path);
            if let Err(e) = &read {
                let rel = t_path.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
                return Some((super::shared::failed_file_batch(adapter, source, context, &rel, e), Some(raw_id)));
            }
            if let Ok(Some((rows, offset, digest))) = read {
                if primary_file.is_none() {
                    primary_offset = offset;
                    primary_digest = digest;
                    primary_file = Some(t_path);
                } else {
                    fold_digest(&mut primary_digest, &digest);
                }
                for rec in &rows {
                    parse_cursor_message_item(rec, &mut messages, started_at);
                }
                used_transcript = Some(raw_id.clone());
            }
        }
    }

    if messages.is_empty() {
        return None;
    }

    if title.is_none() {
        title = messages.first().and_then(|m| {
            m.blocks.iter().find_map(|b| {
                if let ContentBlock::Text { text } = b {
                    Some(text.clone())
                } else {
                    None
                }
            })
        });
    }

    let source_file = primary_file.unwrap_or(chat_dir);
    let rel_path = source_file
        .strip_prefix(root)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");

    let provenance = make_provenance(
        context,
        adapter,
        source,
        &rel_path,
        primary_offset,
        messages.len() as u64,
        &primary_digest,
    );

    let session = build_session(
        &adapter.id,
        provenance,
        Some(raw_id),
        project_root,
        title,
        started_at,
        started_at,
        model,
        "completed".to_string(),
        None,
        None,
        messages,
    );

    Some((make_batch(session), used_transcript))
}

fn parse_cursor_blob_value(
    val: &Value,
    messages: &mut Vec<Message>,
    at: Option<i64>,
) {
    if let Some(arr) = val.as_array() {
        for item in arr {
            parse_cursor_message_item(item, messages, at);
        }
    } else if val.is_object() {
        parse_cursor_message_item(val, messages, at);
    }
}

fn parse_cursor_message_item(
    item: &Value,
    messages: &mut Vec<Message>,
    at: Option<i64>,
) {
    let role = item.get("role").and_then(|v| v.as_str()).unwrap_or("user");
    let content = item.get("content").unwrap_or(&Value::Null);

    let mut blocks = Vec::new();
    let text = extract_text_from_content(content);
    if !text.is_empty() {
        blocks.push(ContentBlock::Text { text });
    }

    if let Some(parts) = content.as_array() {
        for part in parts {
            let part_type = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if part_type == "tool-call" || part_type == "tool_use" {
                let name = part
                    .get("toolName")
                    .or_else(|| part.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();

                let input = part
                    .get("args")
                    .or_else(|| part.get("input"))
                    .cloned()
                    .unwrap_or(Value::Null);

                let files = extract_files_from_value(&input);
                let call_id = part
                    .get("id")
                    .or_else(|| part.get("call_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("call_1")
                    .to_string();

                blocks.push(ContentBlock::ToolCall {
                    call_id: call_id.clone(),
                    native_id: Some(call_id),
                    name,
                    input,
                    files,
                });
            }
        }
    }

    if !blocks.is_empty() {
        messages.push(Message {
            id: String::new(),
            session_id: String::new(),
            native_id: None,
            seq: 0,
            role: role.to_string(),
            at,
            blocks,
        });
    }
}

fn parse_standalone_transcript(
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    context: &SourceContext,
    boundary: &ReadBoundary,
    root: &Path,
    path: &Path,
    raw_id: &str,
) -> Option<ImportBatch> {
    let rel_path = path
        .strip_prefix(root)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    let (rows, offset, digest) = match read_jsonl_file(boundary, path) {
        Ok(read) => read?,
        Err(e) => return Some(super::shared::failed_file_batch(adapter, source, context, &rel_path, &e)),
    };
    if rows.is_empty() {
        return None;
    }

    let mut messages = Vec::new();
    for rec in &rows {
        parse_cursor_message_item(rec, &mut messages, None);
    }

    if messages.is_empty() {
        return None;
    }

    let title = messages.first().and_then(|m| {
        m.blocks.iter().find_map(|b| {
            if let ContentBlock::Text { text } = b {
                Some(text.clone())
            } else {
                None
            }
        })
    });

    let provenance = make_provenance(
        context,
        adapter,
        source,
        &rel_path,
        offset,
        rows.len() as u64,
        &digest,
    );

    let session = build_session(
        &adapter.id,
        provenance,
        Some(raw_id.to_string()),
        None,
        title,
        None,
        None,
        None,
        "completed".to_string(),
        None,
        None,
        messages,
    );

    Some(make_batch(session))
}
