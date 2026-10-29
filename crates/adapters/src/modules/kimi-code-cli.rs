// Kimi Code CLI history module.
//
// Verification sources:
// - https://moonshotai.github.io/kimi-code/en/configuration/data-locations.html
// - https://moonshotai.github.io/kimi-code/en/guides/sessions.html
// - https://github.com/MoonshotAI/kimi-code

use crate::adapter_spec::{AdapterDef, HistorySourceDef};
use crate::boundary::ReadBoundary;
use crate::credentials::is_credential_file;
use crate::engine::SourceContext;
use crate::model::{
    normalized_message_id, normalized_session_id, normalized_usage_id, Checkpoint, ContentBlock,
    Evidence, ImportBatch, ImportMode, Message, NormalizedSession, ReadStatus, Session,
    SourceProvenance, Usage, UsageObservation, UsageSemantics,
};
use chrono::DateTime;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use walkdir::WalkDir;

/// One batch per `state.json`: each session carries its own file's provenance, and the archive
/// accepts a batch only when every session in it shares the batch's provenance.
pub fn process(
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    context: &SourceContext,
    boundary: &ReadBoundary,
    root: &Path,
) -> Result<Vec<ImportBatch>, Box<dyn std::error::Error>> {
    let mut batches = Vec::new();

    for entry in WalkDir::new(root).follow_links(false).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if entry.file_type().is_dir() || is_credential_file(path) {
            continue;
        }

        // Exclude credentials and tokens
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if file_name == "server.token" || file_name == "oauth.json" || file_name.ends_with(".token") {
            continue;
        }

        for comp in path.components() {
            if comp.as_os_str() == "credentials" {
                continue;
            }
        }

        if file_name == "state.json" {
            let relative = path
                .strip_prefix(root)?
                .to_string_lossy()
                .replace('\\', "/");

            let source_bytes = match boundary.read(path) {
                Ok(b) => b,
                Err(_) => continue,
            };

            let file_identity = if context.store.canonical_root.starts_with("fixture://") {
                format!("synthetic:{relative}")
            } else {
                source_bytes.file_identity.clone()
            };

            let provenance = SourceProvenance {
                store: context.store.clone(),
                source_id: source.id.clone().unwrap_or_else(|| "kimi-sessions".into()),
                adapter_id: adapter.id.clone(),
                adapter_version: adapter.adapter_version.clone(),
                source_path: relative.clone(),
                file_identity,
                generation: context.generation,
                checkpoint: Checkpoint {
                    revision: context.revision,
                    offset: source_bytes.bytes.len() as u64,
                    records: 0,
                    digest: crate::boundary::digest(&source_bytes.bytes),
                },
            };

            if let Ok(state_doc) = serde_json::from_slice::<Value>(&source_bytes.bytes) {
                // Check if paired wire.jsonl exists in agents/main/
                let wire_path = path
                    .parent()
                    .map(|p| p.join("agents/main/wire.jsonl"));

                let wire_content = if let Some(wp) = wire_path {
                    boundary.read(&wp).ok().and_then(|b| {
                        String::from_utf8(b.bytes).ok()
                    })
                } else {
                    None
                };

                if let Some(sess) = parse_kimi_session(adapter, &provenance, &state_doc, wire_content.as_deref()) {
                    batches.push(ImportBatch {
                        source: provenance,
                        mode: ImportMode::Snapshot,
                        read_status: ReadStatus::Complete,
                        sessions: vec![sess],
                        diagnostics: vec![],
                        live_updates: vec![],
                    });
                }
            }
        }
    }

    if !batches.is_empty() {
        batches.sort_by(|a, b| a.source.source_path.cmp(&b.source.source_path));
        return Ok(batches);
    }

    let batch_provenance = SourceProvenance {
        store: context.store.clone(),
        source_id: source.id.clone().unwrap_or_else(|| "kimi-sessions".into()),
        adapter_id: adapter.id.clone(),
        adapter_version: adapter.adapter_version.clone(),
        source_path: "sessions".into(),
        file_identity: format!("synthetic:sessions"),
        generation: context.generation,
        checkpoint: Checkpoint {
            revision: context.revision,
            offset: 0,
            records: 0,
            // A valid empty digest: with no readable state.json (none yet, or one over the size
            // limit) the batch is an empty snapshot, not an invalid checkpoint that the archive
            // rejects and that would hide the skip notice after it (R-6, r2 fix round 2).
            digest: "0".repeat(64),
        },
    };

    Ok(vec![ImportBatch {
        source: batch_provenance,
        mode: ImportMode::Snapshot,
        read_status: ReadStatus::Complete,
        sessions: vec![],
        diagnostics: vec![],
        live_updates: vec![],
    }])
}

fn parse_kimi_session(
    adapter: &AdapterDef,
    provenance: &SourceProvenance,
    state: &Value,
    wire_content: Option<&str>,
) -> Option<NormalizedSession> {
    let raw_id = state.get("id")?.as_str()?;
    let session_id = normalized_session_id(
        &provenance.store.id,
        Some(raw_id),
        &provenance.source_path,
    );

    let project_root = state.get("workDir").and_then(Value::as_str).map(str::to_owned);
    let title = state.get("title").and_then(Value::as_str).map(str::to_owned);

    let started_at = state.get("createdAt").and_then(Value::as_str).and_then(|s| {
        DateTime::parse_from_rfc3339(s).ok().map(|dt| dt.timestamp_millis())
    });
    let ended_at = state.get("updatedAt").and_then(Value::as_str).and_then(|s| {
        DateTime::parse_from_rfc3339(s).ok().map(|dt| dt.timestamp_millis())
    });

    let mut model = state
        .pointer("/agentStates/main/model")
        .and_then(Value::as_str)
        .map(str::to_owned);

    let mut messages: Vec<Message> = Vec::new();
    let mut observations: Vec<UsageObservation> = Vec::new();

    // Map tool_calls by call_id so tool.begin and tool.end can be paired
    let mut tool_calls_map: HashMap<String, (String, Value, Vec<String>)> = HashMap::new();

    if let Some(content) = wire_content {
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let event: Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => continue, // tolerate corrupt or unknown line
            };

            let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
            match event_type {
                "tool.begin" => {
                    let call_id = event.get("call_id").and_then(Value::as_str).unwrap_or("").to_string();
                    let name = event.get("name").and_then(Value::as_str).unwrap_or("tool").to_string();
                    let args = event.get("args").cloned().unwrap_or(Value::Null);

                    let mut files = Vec::new();
                    if let Some(p) = args.get("file").or_else(|| args.get("path")).and_then(Value::as_str) {
                        files.push(p.to_string());
                    }

                    tool_calls_map.insert(call_id, (name, args, files));
                }
                "context.append_message" => {
                    if let Some(msg_val) = event.get("message") {
                        let role = msg_val
                            .get("role")
                            .and_then(Value::as_str)
                            .unwrap_or("user")
                            .to_string();

                        if let Some(m_model) = msg_val.get("model").and_then(Value::as_str) {
                            if model.is_none() {
                                model = Some(m_model.to_string());
                            }
                        }

                        if let Some(u) = msg_val.get("usage") {
                            let inp = u.get("input_tokens").and_then(Value::as_u64);
                            let out = u.get("output_tokens").and_then(Value::as_u64);
                            if inp.is_some() || out.is_some() {
                                observations.push(UsageObservation {
                                    event_id: normalized_usage_id(
                                        &session_id,
                                        None,
                                        &provenance.key(),
                                        provenance.generation,
                                        (observations.len() + 1) as u32,
                                    ),
                                    semantics: UsageSemantics::Cumulative,
                                    input_tokens: inp,
                                    output_tokens: out,
                                    at: ended_at,
                                });
                            }
                        }

                        let seq = (messages.len() + 1) as u32;
                        let msg_id = normalized_message_id(
                            &session_id,
                            None,
                            &provenance.key(),
                            provenance.generation,
                            seq,
                        );

                        let mut blocks = Vec::new();

                        // Attach pending tool calls to assistant message if any
                        if role == "assistant" && !tool_calls_map.is_empty() {
                            for (call_id, (name, args, files)) in tool_calls_map.drain() {
                                blocks.push(ContentBlock::ToolCall {
                                    call_id,
                                    native_id: None,
                                    name,
                                    input: args,
                                    files,
                                });
                            }
                        }

                        if let Some(content_val) = msg_val.get("content") {
                            match content_val {
                                Value::String(s) => {
                                    if !s.is_empty() {
                                        blocks.push(ContentBlock::Text { text: s.clone() });
                                    }
                                }
                                Value::Array(arr) => {
                                    for item in arr {
                                        if let Some(txt) = item.get("text").and_then(Value::as_str) {
                                            blocks.push(ContentBlock::Text { text: txt.to_string() });
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }

                        if !blocks.is_empty() {
                            messages.push(Message {
                                id: msg_id,
                                session_id: session_id.clone(),
                                native_id: None,
                                seq,
                                role,
                                at: if seq == 1 { started_at } else { None },
                                blocks,
                            });
                        }
                    }
                }
                _ => {
                    // Tolerate plan.*, subagent.*, turn.begin, turn.end, etc.
                }
            }
        }
    }

    let turns = messages
        .iter()
        .filter(|m| {
            m.role == "user"
                && m.blocks
                    .iter()
                    .any(|b| matches!(b, ContentBlock::Text { .. } | ContentBlock::Code { .. }))
        })
        .count() as u32;

    let usage = Usage::from_observations(observations).unwrap_or_default();

    let completion = ended_at.map(|at| Evidence {
        kind: "native_completion".into(),
        detail: "session state updatedAt".into(),
        native_event_id: None,
        at: Some(at),
    });

    Some(NormalizedSession {
        session: Session {
            id: session_id,
            agent_id: adapter.id.clone(),
            installation_id: None,
            native_id: Some(raw_id.to_string()),
            provenance: provenance.clone(),
            project_root,
            title,
            started_at,
            ended_at,
            model,
            status: "done".into(),
            completion,
            turns,
            usage,
            parent_id: None,
            native_parent_id: None,
        },
        messages,
    })
}
