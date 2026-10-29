// Cline history module
// Verification sources:
// - Official repository: https://github.com/cline/cline
// - Extension storage layout: https://github.com/cline/cline/blob/main/apps/vscode/src/core/storage/disk.ts
// - Session artifacts: https://github.com/cline/cline/blob/main/sdk/packages/core/src/session/models/session-manifest.ts
// - CLI and desktop paths: https://github.com/cline/cline/blob/main/sdk/packages/shared/src/storage/paths.ts
// - Extension ID: saoudrizwan.claude-dev

use super::shared::{
    build_session, extract_files_from_value, extract_text_from_content, make_batch,
    make_provenance, open_sqlite_snapshot, parse_timestamp_val, read_json_file,
};
use crate::adapter_spec::{AdapterDef, HistorySourceDef};
use crate::boundary::ReadBoundary;
use crate::credentials::is_credential_file;
use crate::engine::SourceContext;
use crate::model::{ContentBlock, ImportBatch, Message};
use chrono::DateTime;
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;
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

    // 1. Scan for session directories: sessions/<session-id>/
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() || is_credential_file(path) {
            continue;
        }

        let file_name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };

        if file_name.ends_with(".json")
            && !file_name.ends_with(".messages.json")
            && !file_name.ends_with(".compaction.json")
            && file_name != "task_metadata.json"
            && file_name != "history_item.json"
            && file_name != "ui_messages.json"
            && file_name != "api_conversation_history.json"
        {
            if let Some(parent) = path.parent() {
                let stem = file_name.trim_end_matches(".json");
                let messages_path = parent.join(format!("{stem}.messages.json"));
                if messages_path.exists() && !is_credential_file(&messages_path) {
                    if let Some(batch) = parse_cli_session(
                        adapter,
                        source,
                        context,
                        boundary,
                        root,
                        path,
                        &messages_path,
                    ) {
                        if seen_ids.insert(batch.sessions[0].session.id.clone()) {
                            batches.push(batch);
                        }
                    }
                }
            }
        }
    }

    // 2. Scan for VS Code extension tasks: tasks/<taskId>/
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let ui_path = path.join("ui_messages.json");
        let api_path = path.join("api_conversation_history.json");
        let meta_path = path.join("task_metadata.json");

        if ui_path.exists() || api_path.exists() {
            if let Some(batch) = parse_task_dir(
                adapter,
                source,
                context,
                boundary,
                root,
                path,
                &ui_path,
                &api_path,
                &meta_path,
            ) {
                if seen_ids.insert(batch.sessions[0].session.id.clone()) {
                    batches.push(batch);
                }
            }
        }
    }

    // 3. Scan for SQLite sessions.db if present
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() || is_credential_file(path) {
            continue;
        }

        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };

        if name == "sessions.db" {
            if let Ok(db_batches) =
                parse_sqlite_sessions(adapter, source, context, boundary, root, path)
            {
                for b in db_batches {
                    // A Failed batch (R2-RC-4) has no session to de-duplicate on.
                    let fresh = b.sessions.first().map(|s| seen_ids.insert(s.session.id.clone())).unwrap_or(true);
                    if fresh {
                        batches.push(b);
                    }
                }
            }
        }
    }

    batches.sort_by(|a, b| {
        let key = |x: &ImportBatch| x.sessions.first().map(|s| s.session.id.clone()).unwrap_or_else(|| x.source.key());
        key(a).cmp(&key(b))
    });
    Ok(batches)
}

fn parse_cli_session(
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    context: &SourceContext,
    boundary: &ReadBoundary,
    root: &Path,
    manifest_path: &Path,
    messages_path: &Path,
) -> Option<ImportBatch> {
    let (manifest_val, mut offset, mut digest) = read_json_file(boundary, manifest_path)?;
    let raw_id = manifest_val
        .get("session_id")
        .and_then(|v| v.as_str())
        .or_else(|| manifest_val.get("sessionId").and_then(|v| v.as_str()))
        .unwrap_or_else(|| {
            manifest_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
        });

    let project_root = manifest_val
        .get("cwd")
        .or_else(|| manifest_val.get("workspace_root"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut title = manifest_val
        .get("prompt")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let started_at = manifest_val.get("started_at").and_then(parse_timestamp_val);
    let mut ended_at = manifest_val.get("ended_at").and_then(parse_timestamp_val);
    let model = manifest_val
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut messages = Vec::new();
    let mut tokens_in: u64 = 0;
    let mut tokens_out: u64 = 0;
    let mut record_count = 1;

    if let Some((msg_val, msg_offset, msg_digest)) = read_json_file(boundary, messages_path) {
        fold_checkpoint(&mut offset, &mut digest, msg_offset, msg_digest);
        if let Some(msg_arr) = msg_val.get("messages").and_then(|v| v.as_array()) {
            record_count += msg_arr.len() as u64;
            for m in msg_arr {
                let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("user");
                let ts = m.get("ts").and_then(parse_timestamp_val);
                if ts.is_some() {
                    ended_at = ts;
                }

                let content = m.get("content").unwrap_or(&Value::Null);
                let text = extract_text_from_content(content);

                let mut blocks = Vec::new();
                if !text.is_empty() {
                    if title.is_none() && role == "user" {
                        title = Some(text.clone());
                    }
                    blocks.push(ContentBlock::Text { text });
                }

                if let Some(arr) = content.as_array() {
                    for b in arr {
                        let kind = b.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if kind == "tool_use" || kind == "tool-call" {
                            let name = b
                                .get("name")
                                .or_else(|| b.get("toolName"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown")
                                .to_string();
                            let input_val = b.get("input").or_else(|| b.get("args")).cloned().unwrap_or(Value::Null);
                            let files = extract_files_from_value(&input_val);
                            let call_id = b
                                .get("id")
                                .or_else(|| b.get("tool_use_id"))
                                .or_else(|| b.get("call_id"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("call_1")
                                .to_string();

                            blocks.push(ContentBlock::ToolCall {
                                call_id: call_id.clone(),
                                native_id: Some(call_id),
                                name,
                                input: input_val,
                                files,
                            });
                        } else if kind == "tool_result" {
                            let call_id = b
                                .get("tool_use_id")
                                .or_else(|| b.get("call_id"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let output = b
                                .get("content")
                                .or_else(|| b.get("output"))
                                .cloned()
                                .unwrap_or(Value::Null);
                            let is_error = b.get("is_error").and_then(Value::as_bool);
                            blocks.push(ContentBlock::ToolResult {
                                call_id,
                                output,
                                is_error,
                            });
                        }
                    }
                }

                if !blocks.is_empty() {
                    let native_msg_id = m.get("id").and_then(|v| v.as_str()).map(str::to_string);
                    messages.push(Message {
                        id: String::new(),
                        session_id: String::new(),
                        native_id: native_msg_id,
                        seq: 0,
                        role: role.to_string(),
                        at: ts.or(started_at),
                        blocks,
                    });
                }

                if let Some(metrics) = m.get("metrics") {
                    if let Some(ti) = metrics.get("inputTokens").and_then(|v| v.as_u64()) {
                        tokens_in += ti;
                    }
                    if let Some(to) = metrics.get("outputTokens").and_then(|v| v.as_u64()) {
                        tokens_out += to;
                    }
                }
            }
        }
    }

    let rel_path = manifest_path
        .strip_prefix(root)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");

    let provenance = make_provenance(
        context,
        adapter,
        source,
        &rel_path,
        offset,
        record_count,
        &digest,
    );

    let session = build_session(
        &adapter.id,
        provenance,
        Some(raw_id.to_string()),
        project_root,
        title,
        started_at,
        ended_at,
        model,
        "completed".to_string(),
        (tokens_in > 0).then_some(tokens_in),
        (tokens_out > 0).then_some(tokens_out),
        messages,
    );

    Some(make_batch(session))
}

/// Adds one more file that feeds a session to its checkpoint: a change to any of them (a reply
/// rewritten in place, with the message count unchanged) is a new checkpoint, not a replay.
fn fold_checkpoint(offset: &mut u64, digest: &mut String, file_offset: u64, file_digest: String) {
    *offset += file_offset;
    *digest = if digest.is_empty() {
        file_digest
    } else {
        crate::boundary::digest(format!("{digest}{file_digest}").as_bytes())
    };
}

fn parse_task_dir(
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    context: &SourceContext,
    boundary: &ReadBoundary,
    root: &Path,
    task_dir: &Path,
    ui_path: &Path,
    api_path: &Path,
    meta_path: &Path,
) -> Option<ImportBatch> {
    let mut raw_id = task_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("task")
        .to_string();
    let mut title = None;
    let mut project_root = None;
    let mut started_at = None;
    let mut ended_at = None;
    let mut tokens_in = None;
    let mut tokens_out = None;
    let mut primary_offset = 0;
    let mut primary_digest = String::new();
    let mut primary_file = None;

    if meta_path.exists() && !is_credential_file(meta_path) {
        if let Some((meta_val, offset, digest)) = read_json_file(boundary, meta_path) {
            fold_checkpoint(&mut primary_offset, &mut primary_digest, offset, digest);
            primary_file = Some(meta_path);
            if let Some(tid) = meta_val.get("taskId").and_then(|v| v.as_str()) {
                raw_id = tid.to_string();
            }
            if let Some(t) = meta_val.get("task").and_then(|v| v.as_str()) {
                title = Some(t.to_string());
            }
            if let Some(w) = meta_val.get("workspace").and_then(|v| v.as_str()) {
                project_root = Some(w.to_string());
            }
            if let Some(ts) = meta_val.get("timestamp").and_then(parse_timestamp_val) {
                started_at = Some(ts);
            }
            if let Some(ti) = meta_val.get("tokensIn").and_then(|v| v.as_u64()) {
                tokens_in = Some(ti);
            }
            if let Some(to) = meta_val.get("tokensOut").and_then(|v| v.as_u64()) {
                tokens_out = Some(to);
            }
        }
    }

    let mut messages = Vec::new();

    // Prefer api_conversation_history.json
    if api_path.exists() && !is_credential_file(api_path) {
        if let Some((api_val, offset, digest)) = read_json_file(boundary, api_path) {
            fold_checkpoint(&mut primary_offset, &mut primary_digest, offset, digest);
            if primary_file.is_none() {
                primary_file = Some(api_path);
            }
            if let Some(arr) = api_val.as_array() {
                for item in arr {
                    let role = item.get("role").and_then(|v| v.as_str()).unwrap_or("user");
                    let content = item.get("content").unwrap_or(&Value::Null);
                    let text = extract_text_from_content(content);

                    let mut blocks = Vec::new();
                    if !text.is_empty() {
                        blocks.push(ContentBlock::Text { text });
                    }

                    if let Some(arr) = content.as_array() {
                        for b in arr {
                            let kind = b.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            if kind == "tool_use" || kind == "tool-call" {
                                let name = b
                                    .get("name")
                                    .or_else(|| b.get("toolName"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("unknown")
                                    .to_string();
                                let input_val = b
                                    .get("input")
                                    .or_else(|| b.get("args"))
                                    .cloned()
                                    .unwrap_or(Value::Null);
                                let files = extract_files_from_value(&input_val);
                                let call_id = b
                                    .get("id")
                                    .or_else(|| b.get("tool_use_id"))
                                    .or_else(|| b.get("call_id"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("call_1")
                                    .to_string();

                                blocks.push(ContentBlock::ToolCall {
                                    call_id: call_id.clone(),
                                    native_id: Some(call_id),
                                    name,
                                    input: input_val,
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
                            at: started_at,
                            blocks,
                        });
                    }
                }
            }
        }
    }

    if ui_path.exists() && !is_credential_file(ui_path) {
        if let Some((ui_val, offset, digest)) = read_json_file(boundary, ui_path) {
            fold_checkpoint(&mut primary_offset, &mut primary_digest, offset, digest);
            if primary_file.is_none() {
                primary_file = Some(ui_path);
            }
            if let Some(arr) = ui_val.as_array() {
                let mut ui_msgs = Vec::new();
                for (idx, item) in arr.iter().enumerate() {
                    let ts = item.get("ts").and_then(parse_timestamp_val);
                    if started_at.is_none() && ts.is_some() {
                        started_at = ts;
                    }
                    if ts.is_some() {
                        ended_at = ts;
                    }

                    let msg_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    let say = item.get("say").and_then(|v| v.as_str()).unwrap_or("");
                    let _ask = item.get("ask").and_then(|v| v.as_str()).unwrap_or("");

                    let text = item
                        .get("text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();

                    if !text.is_empty()
                        && (say == "text"
                            || (msg_type == "say"
                                && say != "tool"
                                && !say.starts_with("api_req_")))
                    {
                        let role = if idx == 0 || msg_type == "ask" {
                            "user"
                        } else {
                            "assistant"
                        };
                        ui_msgs.push(Message {
                            id: String::new(),
                            session_id: String::new(),
                            native_id: None,
                            seq: 0,
                            role: role.to_string(),
                            at: ts,
                            blocks: vec![ContentBlock::Text { text }],
                        });
                    }
                }

                if messages.is_empty() {
                    messages = ui_msgs;
                } else {
                    let ts_list: Vec<Option<i64>> = arr
                        .iter()
                        .filter_map(|m| m.get("ts").and_then(parse_timestamp_val).map(Some))
                        .collect();
                    for (i, msg) in messages.iter_mut().enumerate() {
                        if msg.at.is_none() || msg.at == started_at {
                            if let Some(&Some(ts)) = ts_list.get(i) {
                                msg.at = Some(ts);
                            }
                        }
                    }
                }
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

    let source_file = primary_file.unwrap_or(task_dir);
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
        ended_at,
        None,
        "completed".to_string(),
        tokens_in,
        tokens_out,
        messages,
    );

    Some(make_batch(session))
}

fn parse_sqlite_sessions(
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    context: &SourceContext,
    boundary: &ReadBoundary,
    root: &Path,
    db_path: &Path,
) -> Result<Vec<ImportBatch>, Box<dyn std::error::Error>> {
    let safe_db = match open_sqlite_snapshot(boundary, db_path) {
        Ok(db) => db,
        // R2-RC-4: a database that cannot be snapshotted safely is a Failed batch with a
        // diagnostic, never a silent skip.
        Err(e) => {
            let rel = db_path.strip_prefix(root).unwrap_or(db_path).to_string_lossy().replace('\\', "/");
            return Ok(vec![super::shared::failed_file_batch(adapter, source, context, &rel, &e)]);
        }
    };

    let table_exists: bool = safe_db
        .conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='sessions'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);

    if !table_exists {
        return Ok(Vec::new());
    }

    let mut stmt = safe_db
        .conn
        .prepare("SELECT session_id, cwd, prompt, started_at, ended_at, model FROM sessions")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
        ))
    })?;

    let rel_path = db_path
        .strip_prefix(root)?
        .to_string_lossy()
        .replace('\\', "/");

    let mut batches = Vec::new();
    for row in rows.flatten() {
        let (raw_id, cwd, prompt, started_str, ended_str, model) = row;
        let started_at = started_str
            .and_then(|s| DateTime::parse_from_rfc3339(&s).ok().map(|d| d.timestamp_millis()));
        let ended_at = ended_str
            .and_then(|s| DateTime::parse_from_rfc3339(&s).ok().map(|d| d.timestamp_millis()));

        let provenance = make_provenance(
            context,
            adapter,
            source,
            &rel_path,
            safe_db.offset,
            1,
            &safe_db.digest,
        );

        let session = build_session(
            &adapter.id,
            provenance,
            Some(raw_id),
            cwd,
            prompt,
            started_at,
            ended_at,
            model,
            "completed".to_string(),
            None,
            None,
            Vec::new(),
        );

        batches.push(make_batch(session));
    }

    Ok(batches)
}
