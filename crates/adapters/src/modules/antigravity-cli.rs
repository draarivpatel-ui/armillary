// Antigravity CLI history module.
//
// Verification sources:
// - https://antigravity.google/docs/cli/overview
// - https://antigravity.google/docs/cli/reference/
// - https://github.com/google-antigravity/antigravity-cli

use crate::adapter_spec::{AdapterDef, HistorySourceDef};
use crate::boundary::ReadBoundary;
use crate::credentials::is_credential_file;
use crate::engine::SourceContext;
use crate::model::{
    normalized_message_id, normalized_session_id, normalized_usage_id, stable_id, Checkpoint,
    ContentBlock, Evidence, ImportBatch, ImportMode, Message, NormalizedSession, ReadStatus,
    Session, SourceProvenance, Usage, UsageObservation, UsageSemantics,
};
use crate::readers::sqlite::read_sqlite;
use chrono::DateTime;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use walkdir::WalkDir;

pub fn process(
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    context: &SourceContext,
    boundary: &ReadBoundary,
    root: &Path,
) -> Result<ImportBatch, Box<dyn std::error::Error>> {
    let mut sessions = Vec::new();
    let mut primary_provenance: Option<SourceProvenance> = None;

    // 1. Locate history.jsonl
    let mut history_entries: HashMap<String, (Option<String>, Option<String>, Option<i64>)> = HashMap::new();

    let history_path = root.join("history.jsonl");
    if let Ok(history_bytes) = boundary.read(&history_path) {
        let relative = history_path
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");

        let file_identity = if context.store.canonical_root.starts_with("fixture://") {
            format!("synthetic:{relative}")
        } else {
            history_bytes.file_identity.clone()
        };

        let prov = SourceProvenance {
            store: context.store.clone(),
            source_id: source.id.clone().unwrap_or_else(|| "antigravity-conversations".into()),
            adapter_id: adapter.id.clone(),
            adapter_version: adapter.adapter_version.clone(),
            source_path: relative,
            file_identity,
            generation: context.generation,
            checkpoint: Checkpoint {
                revision: context.revision,
                offset: history_bytes.bytes.len() as u64,
                records: 0,
                digest: crate::boundary::digest(&history_bytes.bytes),
            },
        };
        primary_provenance = Some(prov);

        if let Ok(content) = std::str::from_utf8(&history_bytes.bytes) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                    if let Some(conv_id) = v.get("conversationId").and_then(Value::as_str) {
                        let workspace = v.get("workspace").and_then(Value::as_str).map(str::to_owned);
                        let title = v.get("display").and_then(Value::as_str).map(str::to_owned);
                        let at = v.get("timestamp").and_then(Value::as_str).and_then(|s| {
                            DateTime::parse_from_rfc3339(s).ok().map(|dt| dt.timestamp_millis())
                        });
                        history_entries.insert(conv_id.to_string(), (workspace, title, at));
                    }
                }
            }
        }
    }

    // 2. Discover transcript files in brain/<uuid>/.system_generated/logs/transcript.jsonl
    for entry in WalkDir::new(root).follow_links(false).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if entry.file_type().is_dir() || is_credential_file(path) {
            continue;
        }

        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");

        if file_name == "transcript.jsonl" || file_name == "transcript_full.jsonl" {
            // Find uuid in brain/<uuid>/
            let parent_logs = path.parent();
            let system_gen = parent_logs.and_then(|p| p.parent());
            let uuid_dir = system_gen.and_then(|p| p.parent());
            let uuid = uuid_dir.and_then(|p| p.file_name()).and_then(|s| s.to_str());

            if let Some(uuid_str) = uuid {
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

                let prov = SourceProvenance {
                    store: context.store.clone(),
                    source_id: source.id.clone().unwrap_or_else(|| "antigravity-conversations".into()),
                    adapter_id: adapter.id.clone(),
                    adapter_version: adapter.adapter_version.clone(),
                    source_path: relative,
                    file_identity,
                    generation: context.generation,
                    checkpoint: Checkpoint {
                        revision: context.revision,
                        offset: source_bytes.bytes.len() as u64,
                        records: 0,
                        digest: crate::boundary::digest(&source_bytes.bytes),
                    },
                };

                let (workspace, title, history_time) = history_entries
                    .get(uuid_str)
                    .cloned()
                    .unwrap_or((None, None, None));

                // Check SQLite database if available: conversations/<uuid>.db
                let db_path = root.join("conversations").join(format!("{}.db", uuid_str));
                let mut db_model: Option<String> = None;
                let mut db_tokens_in: Option<u64> = None;
                let mut db_tokens_out: Option<u64> = None;

                if db_path.exists() {
                    // Read trajectory_meta for model
                    if let Ok(rows) = read_sqlite(boundary, &db_path, "SELECT model FROM trajectory_meta LIMIT 1") {
                        if let Some(first) = rows.first() {
                            db_model = first.get("model").and_then(Value::as_str).map(str::to_owned);
                        }
                    }
                    // Read gen_metadata for tokens
                    if let Ok(rows) = read_sqlite(boundary, &db_path, "SELECT prompt_tokens, output_tokens FROM gen_metadata LIMIT 1") {
                        if let Some(first) = rows.first() {
                            db_tokens_in = first.get("prompt_tokens").and_then(Value::as_u64);
                            db_tokens_out = first.get("output_tokens").and_then(Value::as_u64);
                        }
                    }
                }

                if let Ok(transcript_content) = std::str::from_utf8(&source_bytes.bytes) {
                    if let Some(sess) = parse_antigravity_session(
                        adapter,
                        &prov,
                        uuid_str,
                        workspace,
                        title,
                        history_time,
                        transcript_content,
                        db_model,
                        db_tokens_in,
                        db_tokens_out,
                    ) {
                        sessions.push(sess);
                    }
                }

                if primary_provenance.is_none() {
                    primary_provenance = Some(prov);
                }
            }
        }
    }

    sessions.sort_by(|a, b| a.session.id.cmp(&b.session.id));

    let batch_provenance = primary_provenance.unwrap_or_else(|| SourceProvenance {
        store: context.store.clone(),
        source_id: source.id.clone().unwrap_or_else(|| "antigravity-conversations".into()),
        adapter_id: adapter.id.clone(),
        adapter_version: adapter.adapter_version.clone(),
        source_path: "history.jsonl".into(),
        file_identity: format!("synthetic:history.jsonl"),
        generation: context.generation,
        checkpoint: Checkpoint {
            revision: context.revision,
            offset: 0,
            records: 0,
            digest: String::new(),
        },
    });

    // The archive accepts one source per batch: every session carries the batch provenance. The
    // session id is built from the native conversation id, so it does not change.
    for s in &mut sessions {
        s.session.provenance = batch_provenance.clone();
        for m in &mut s.messages {
            m.id = normalized_message_id(
                &s.session.id,
                m.native_id.as_deref(),
                &batch_provenance.key(),
                batch_provenance.generation,
                m.seq,
            );
        }
    }

    Ok(ImportBatch {
        source: batch_provenance,
        mode: ImportMode::Snapshot,
        read_status: ReadStatus::Complete,
        sessions,
        diagnostics: vec![],
        live_updates: vec![],
    })
}

fn parse_antigravity_session(
    adapter: &AdapterDef,
    provenance: &SourceProvenance,
    uuid: &str,
    project_root: Option<String>,
    title: Option<String>,
    history_time: Option<i64>,
    transcript: &str,
    db_model: Option<String>,
    db_tokens_in: Option<u64>,
    db_tokens_out: Option<u64>,
) -> Option<NormalizedSession> {
    let session_id = normalized_session_id(
        &provenance.store.id,
        Some(uuid),
        &provenance.source_path,
    );

    let mut messages: Vec<Message> = Vec::new();
    let mut started_at: Option<i64> = history_time;
    let mut ended_at: Option<i64> = None;

    for line in transcript.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let step: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let step_type = step.get("type").and_then(Value::as_str).unwrap_or("");
        let at = step.get("created_at").and_then(Value::as_str).and_then(|s| {
            DateTime::parse_from_rfc3339(s).ok().map(|dt| dt.timestamp_millis())
        });

        if started_at.is_none() && at.is_some() {
            started_at = at;
        }
        if at.is_some() {
            ended_at = at;
        }

        match step_type {
            "USER_INPUT" => {
                let raw_content = step.get("content").and_then(Value::as_str).unwrap_or("");
                // Strip XML wrapper e.g. <USER_REQUEST>...</USER_REQUEST>
                let cleaned = raw_content
                    .replace("<USER_REQUEST>", "")
                    .replace("</USER_REQUEST>", "")
                    .trim()
                    .to_string();

                if !cleaned.is_empty() {
                    let seq = (messages.len() + 1) as u32;
                    let msg_id = normalized_message_id(
                        &session_id,
                        None,
                        &provenance.key(),
                        provenance.generation,
                        seq,
                    );
                    messages.push(Message {
                        id: msg_id,
                        session_id: session_id.clone(),
                        native_id: None,
                        seq,
                        role: "user".into(),
                        at,
                        blocks: vec![ContentBlock::Text { text: cleaned }],
                    });
                }
            }
            "PLANNER_RESPONSE" => {
                let mut blocks = Vec::new();

                // 1. Text content (with thinking fallback)
                let text_opt = step
                    .get("content")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .or_else(|| step.get("thinking").and_then(Value::as_str))
                    .map(|s| s.trim());

                if let Some(text) = text_opt {
                    if !text.is_empty() {
                        blocks.push(ContentBlock::Text {
                            text: text.to_string(),
                        });
                    }
                }

                // 2. Tool calls
                if let Some(tools) = step.get("tool_calls").and_then(Value::as_array) {
                    for (t_idx, tool_val) in tools.iter().enumerate() {
                        let name = tool_val.get("name").and_then(Value::as_str).unwrap_or("tool").to_string();
                        let args = tool_val.get("args").cloned().unwrap_or(Value::Null);

                        let mut files = Vec::new();
                        if let Some(p) = args
                            .get("AbsolutePath")
                            .or_else(|| args.get("TargetFile"))
                            .or_else(|| args.get("path"))
                            .or_else(|| args.get("file"))
                            .and_then(Value::as_str)
                        {
                            files.push(p.to_string());
                        }

                        let call_id = stable_id("tool", &[&format!("{}:block:{}", provenance.key(), t_idx)]);
                        blocks.push(ContentBlock::ToolCall {
                            call_id,
                            native_id: None,
                            name,
                            input: args,
                            files,
                        });
                    }
                }

                if !blocks.is_empty() {
                    let seq = (messages.len() + 1) as u32;
                    let msg_id = normalized_message_id(
                        &session_id,
                        None,
                        &provenance.key(),
                        provenance.generation,
                        seq,
                    );
                    messages.push(Message {
                        id: msg_id,
                        session_id: session_id.clone(),
                        native_id: None,
                        seq,
                        role: "assistant".into(),
                        at,
                        blocks,
                    });
                }
            }
            _ => {}
        }
    }

    if messages.is_empty() {
        return None;
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

    let observations = if db_tokens_in.is_some() || db_tokens_out.is_some() {
        vec![UsageObservation {
            event_id: normalized_usage_id(
                &session_id,
                None,
                &provenance.key(),
                provenance.generation,
                1,
            ),
            semantics: UsageSemantics::Cumulative,
            input_tokens: db_tokens_in,
            output_tokens: db_tokens_out,
            at: ended_at,
        }]
    } else {
        vec![]
    };
    let usage = Usage::from_observations(observations).unwrap_or_default();

    let completion = ended_at.map(|at| Evidence {
        kind: "native_completion".into(),
        detail: "transcript completion".into(),
        native_event_id: None,
        at: Some(at),
    });

    Some(NormalizedSession {
        session: Session {
            id: session_id,
            agent_id: adapter.id.clone(),
            installation_id: None,
            native_id: Some(uuid.to_string()),
            provenance: provenance.clone(),
            project_root,
            title,
            started_at,
            ended_at,
            model: db_model,
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
