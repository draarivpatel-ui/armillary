// Continue history module
// Verification sources:
// - Official repository: https://github.com/continuedev/continue
// - Session types and models: https://github.com/continuedev/continue/blob/main/core/index.d.ts
// - Storage paths and config: https://github.com/continuedev/continue/blob/main/core/util/paths.ts
// - Extension ID: continue.continue

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
        if !path.is_file() || is_credential_file(path) {
            continue;
        }

        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        if !ext.eq_ignore_ascii_case("json") {
            continue;
        }

        if let Some(batch) =
            parse_continue_session_file(adapter, source, context, boundary, root, path)
        {
            if seen_ids.insert(batch.sessions[0].session.id.clone()) {
                batches.push(batch);
            }
        }
    }

    batches.sort_by(|a, b| a.sessions[0].session.id.cmp(&b.sessions[0].session.id));
    Ok(batches)
}

fn parse_continue_session_file(
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    context: &SourceContext,
    boundary: &ReadBoundary,
    root: &Path,
    file_path: &Path,
) -> Option<ImportBatch> {
    let (val, offset, digest) = read_json_file(boundary, file_path)?;

    let raw_id = val
        .get("sessionId")
        .and_then(|v| v.as_str())
        .or_else(|| val.get("id").and_then(|v| v.as_str()))
        .unwrap_or_else(|| {
            file_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("session")
        });

    let history_arr = val.get("history").and_then(|v| v.as_array())?;

    let title = val.get("title").and_then(|v| v.as_str()).map(|s| s.to_string());
    let project_root = val
        .get("workspaceDirectory")
        .or_else(|| val.get("workspace"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let model = val
        .get("chatModelTitle")
        .or_else(|| val.get("model"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let started_at = val
        .get("dateCreated")
        .or_else(|| val.get("createdAt"))
        .and_then(parse_timestamp_val);

    let mut tokens_in = None;
    let mut tokens_out = None;

    if let Some(usage) = val.get("usage") {
        if let Some(in_tok) = usage
            .get("promptTokens")
            .or_else(|| usage.get("inputTokens"))
            .and_then(|v| v.as_u64())
        {
            tokens_in = Some(in_tok);
        }
        if let Some(out_tok) = usage
            .get("completionTokens")
            .or_else(|| usage.get("outputTokens"))
            .and_then(|v| v.as_u64())
        {
            tokens_out = Some(out_tok);
        }
    }

    let mut messages = Vec::new();

    for item in history_arr {
        let mut blocks = Vec::new();
        let role = item
            .get("message")
            .and_then(|m| m.get("role"))
            .and_then(|v| v.as_str())
            .unwrap_or("user");

        if let Some(msg_obj) = item.get("message") {
            let content = msg_obj.get("content").unwrap_or(&Value::Null);
            let text = extract_text_from_content(content);
            if !text.is_empty() {
                blocks.push(ContentBlock::Text { text });
            }
        }

        if let Some(tc_states) = item.get("toolCallStates").and_then(|v| v.as_array()) {
            for state in tc_states {
                if let Some(tc) = state.get("toolCall") {
                    let name = tc
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .or_else(|| tc.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();

                    let args_val = tc
                        .get("function")
                        .and_then(|f| f.get("arguments"))
                        .or_else(|| tc.get("arguments"))
                        .or_else(|| tc.get("input"));

                    let input = match args_val {
                        Some(Value::String(s)) => {
                            serde_json::from_str::<Value>(s).unwrap_or(Value::String(s.clone()))
                        }
                        Some(v) => v.clone(),
                        None => Value::Null,
                    };

                    let files = extract_files_from_value(&input);

                    let call_id = tc
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("tc_1")
                        .to_string();

                    blocks.push(ContentBlock::ToolCall {
                        call_id: call_id.clone(),
                        native_id: Some(call_id.clone()),
                        name,
                        input,
                        files,
                    });

                    if let Some(out) = state.get("output").and_then(|v| v.as_str()) {
                        blocks.push(ContentBlock::ToolResult {
                            call_id,
                            output: Value::String(out.to_string()),
                            is_error: None,
                        });
                    }
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

    let rel_path = file_path
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
        messages.len() as u64,
        &digest,
    );

    let session = build_session(
        &adapter.id,
        provenance,
        Some(raw_id.to_string()),
        project_root,
        title,
        started_at,
        started_at,
        model,
        "completed".to_string(),
        tokens_in,
        tokens_out,
        messages,
    );

    Some(make_batch(session))
}
