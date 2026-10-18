// Roo Code history module
// Verification sources:
// - Official repository: https://github.com/RooCodeInc/Roo-Code
// - Storage utilities: https://raw.githubusercontent.com/RooCodeInc/Roo-Code/main/src/utils/storage.ts
// - Task persistence: https://raw.githubusercontent.com/RooCodeInc/Roo-Code/main/src/core/task-persistence/TaskHistoryStore.ts
// - Extension ID: RooVeterinaryInc.roo-cline

use super::shared::{
    build_session, extract_files_from_value, extract_text_from_content, make_batch,
    make_provenance, parse_timestamp_val, read_json_file,
};
use crate::adapter_spec::{AdapterDef, HistorySourceDef};
use crate::boundary::ReadBoundary;
use crate::credentials::is_credential_file;
use crate::engine::SourceContext;
use crate::model::{ContentBlock, ImportBatch, Message};
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

    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
            if name.ends_with(".lock") {
                continue;
            }
        }

        let history_item_path = path.join("history_item.json");
        let ui_path = path.join("ui_messages.json");
        let api_path = path.join("api_conversation_history.json");

        if history_item_path.exists() || ui_path.exists() || api_path.exists() {
            if let Some(batch) = parse_roo_task_dir(
                adapter,
                source,
                context,
                boundary,
                root,
                path,
                &history_item_path,
                &ui_path,
                &api_path,
            ) {
                if seen_ids.insert(batch.sessions[0].session.id.clone()) {
                    batches.push(batch);
                }
            }
        }
    }

    batches.sort_by(|a, b| a.sessions[0].session.id.cmp(&b.sessions[0].session.id));
    Ok(batches)
}

fn parse_roo_task_dir(
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    context: &SourceContext,
    boundary: &ReadBoundary,
    root: &Path,
    task_dir: &Path,
    history_item_path: &Path,
    ui_path: &Path,
    api_path: &Path,
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

    if history_item_path.exists() && !is_credential_file(history_item_path) {
        if let Some((item, offset, digest)) = read_json_file(boundary, history_item_path) {
            primary_offset = offset;
            primary_digest = digest;
            primary_file = Some(history_item_path);

            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                raw_id = id.to_string();
            }
            if let Some(t) = item.get("task").and_then(|v| v.as_str()) {
                title = Some(t.to_string());
            }
            if let Some(w) = item.get("workspace").and_then(|v| v.as_str()) {
                project_root = Some(w.to_string());
            }
            if let Some(ts) = item.get("ts").and_then(parse_timestamp_val) {
                started_at = Some(ts);
            }
            if let Some(ti) = item.get("tokensIn").and_then(|v| v.as_u64()) {
                tokens_in = Some(ti);
            }
            if let Some(to) = item.get("tokensOut").and_then(|v| v.as_u64()) {
                tokens_out = Some(to);
            }
        }
    }

    let mut messages = Vec::new();

    if api_path.exists() && !is_credential_file(api_path) {
        if let Some((api_val, offset, digest)) = read_json_file(boundary, api_path) {
            if primary_file.is_none() {
                primary_offset = offset;
                primary_digest = digest;
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
            if primary_file.is_none() {
                primary_offset = offset;
                primary_digest = digest;
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
