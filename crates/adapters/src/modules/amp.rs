// Amp history module.
//
// Verification sources:
// - https://ampcode.com/manual/security
// - https://ampcode.com/manual/settings
// - https://ampcode.com/manual/cli
// - https://github.com/holgern/toktrail/blob/main/toktrail/adapters/amp.py

use super::shared::{failed_file_batch, make_provenance};
use crate::adapter_spec::{AdapterDef, HistorySourceDef};
use crate::boundary::ReadBoundary;
use crate::credentials::is_credential_file;
use crate::engine::SourceContext;
use crate::model::{
    normalized_message_id, normalized_session_id, normalized_usage_id, stable_id, ContentBlock,
    Evidence, ImportBatch, ImportMode, Message, NormalizedSession, ReadStatus, Session,
    SourceProvenance, Usage, UsageObservation, UsageSemantics,
};
use crate::readers::jsonl::ReaderError;
use chrono::DateTime;
use serde_json::Value;
use std::path::Path;
use walkdir::WalkDir;

/// One batch per thread file (RV-ADP). Every thread is its own source with its own provenance and
/// checkpoint, so deleting or rewriting one thread never changes another thread's checkpoint (a
/// folder-wide checkpoint shrinks when a file disappears, which the archive refuses without a new
/// generation). A thread that cannot be read or parsed is a Failed batch with a diagnostic, never a
/// silently skipped file inside a Complete one.
pub fn parse_batches(
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    context: &SourceContext,
    boundary: &ReadBoundary,
    root: &Path,
) -> Result<Vec<ImportBatch>, Box<dyn std::error::Error>> {
    let mut batches = Vec::new();
    let mut threads: Vec<(String, std::path::PathBuf)> = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                // An unreadable directory hides threads: report it instead of importing a partial view.
                let relative = err
                    .path()
                    .and_then(|p| p.strip_prefix(root).ok())
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .filter(|p| !p.is_empty())
                    .unwrap_or_else(|| "threads".into());
                let io = ReaderError::Io(std::io::Error::other(err.to_string()));
                batches.push(failed_file_batch(adapter, source, context, &relative, &io));
                continue;
            }
        };
        let path = entry.path();
        if entry.file_type().is_dir() || is_credential_file(path) {
            continue;
        }
        let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        // Never open secret or auth files
        if file_name == "secrets.json" || file_name == "auth.json" || file_name.ends_with(".key") {
            continue;
        }
        if file_name.starts_with("T-") && file_name.ends_with(".json") {
            let relative = path.strip_prefix(root)?.to_string_lossy().replace('\\', "/");
            threads.push((relative, path.to_path_buf()));
        }
    }
    threads.sort_by(|a, b| a.0.cmp(&b.0));

    for (relative, path) in threads {
        let bytes = match boundary.read(&path) {
            Ok(b) => b,
            Err(e) => {
                batches.push(failed_file_batch(adapter, source, context, &relative, &e));
                continue;
            }
        };
        let doc = match serde_json::from_slice::<Value>(&bytes.bytes) {
            Ok(d) => d,
            Err(e) => {
                let e = ReaderError::Parse(format!("thread is not valid JSON: {e}"));
                batches.push(failed_file_batch(adapter, source, context, &relative, &e));
                continue;
            }
        };
        if doc.get("id").and_then(Value::as_str).is_none_or(str::is_empty) {
            let e = ReaderError::Parse("thread has no string id".into());
            batches.push(failed_file_batch(adapter, source, context, &relative, &e));
            continue;
        }
        let records = doc
            .get("messages")
            .and_then(Value::as_array)
            .map_or(0, |m| m.len() as u64);
        let provenance = make_provenance(
            context,
            adapter,
            source,
            &relative,
            bytes.bytes.len() as u64,
            records,
            &crate::boundary::digest(&bytes.bytes),
        );
        let Some(session) = parse_amp_thread(adapter, &provenance, &doc) else {
            let e = ReaderError::Parse("thread could not be normalized".into());
            batches.push(failed_file_batch(adapter, source, context, &relative, &e));
            continue;
        };
        batches.push(ImportBatch {
            source: provenance,
            mode: ImportMode::Snapshot,
            read_status: ReadStatus::Complete,
            sessions: vec![session],
            diagnostics: vec![],
            live_updates: vec![],
        });
    }
    Ok(batches)
}

fn parse_amp_thread(
    adapter: &AdapterDef,
    provenance: &SourceProvenance,
    doc: &Value,
) -> Option<NormalizedSession> {
    let raw_id = doc.get("id")?.as_str()?;
    let session_id = normalized_session_id(
        &provenance.store.id,
        Some(raw_id),
        &provenance.source_path,
    );

    let title = doc.get("title").and_then(Value::as_str).map(str::to_owned);
    let started_at = doc.get("created").and_then(Value::as_i64);

    let mut model: Option<String> = None;
    let mut ended_at: Option<i64> = None;
    let mut observations = Vec::new();

    // 1. Check thread-level usageLedger
    if let Some(ledger) = doc.get("usageLedger") {
        if let Some(events) = ledger.get("events").and_then(Value::as_array) {
            for (idx, ev) in events.iter().enumerate() {
                if let Some(m) = ev.get("model").and_then(Value::as_str) {
                    model = Some(m.to_string());
                }
                if let Some(ts_str) = ev.get("timestamp").and_then(Value::as_str) {
                    if let Ok(dt) = DateTime::parse_from_rfc3339(ts_str) {
                        ended_at = Some(dt.timestamp_millis());
                    }
                }
                if let Some(toks) = ev.get("tokens") {
                    let inp = toks.get("input").and_then(Value::as_u64);
                    let out = toks.get("output").and_then(Value::as_u64);
                    if inp.is_some() || out.is_some() {
                        observations.push(UsageObservation {
                            event_id: normalized_usage_id(
                                &session_id,
                                None,
                                &provenance.key(),
                                provenance.generation,
                                (idx + 1) as u32,
                            ),
                            semantics: UsageSemantics::Cumulative,
                            input_tokens: inp,
                            output_tokens: out,
                            at: ended_at,
                        });
                    }
                }
            }
        }
    }

    // 2. Parse messages array
    let mut messages = Vec::new();
    if let Some(raw_msgs) = doc.get("messages").and_then(Value::as_array) {
        for (idx, m) in raw_msgs.iter().enumerate() {
            let role = m
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user")
                .to_string();

            if let Some(m_model) = m.get("model").and_then(Value::as_str) {
                if model.is_none() {
                    model = Some(m_model.to_string());
                }
            }

            // Message-level usage fallback
            if observations.is_empty() {
                if let Some(u) = m.get("usage") {
                    let inp = u
                        .get("input_tokens")
                        .or_else(|| u.get("inputTokens"))
                        .and_then(Value::as_u64);
                    let out = u
                        .get("output_tokens")
                        .or_else(|| u.get("outputTokens"))
                        .and_then(Value::as_u64);
                    if inp.is_some() || out.is_some() {
                        observations.push(UsageObservation {
                            event_id: normalized_usage_id(
                                &session_id,
                                None,
                                &provenance.key(),
                                provenance.generation,
                                (idx + 1) as u32,
                            ),
                            semantics: UsageSemantics::Cumulative,
                            input_tokens: inp,
                            output_tokens: out,
                            at: None,
                        });
                    }
                }
            }

            let native_id = m
                .get("messageId")
                .and_then(|v| v.as_i64().map(|n| n.to_string()).or_else(|| v.as_str().map(str::to_owned)));

            let seq = (idx + 1) as u32;
            let msg_id = normalized_message_id(
                &session_id,
                native_id.as_deref(),
                &provenance.key(),
                provenance.generation,
                seq,
            );

            let mut blocks = Vec::new();
            if let Some(content) = m.get("content") {
                match content {
                    Value::String(s) => {
                        if !s.is_empty() {
                            blocks.push(ContentBlock::Text { text: s.clone() });
                        }
                    }
                    Value::Array(arr) => {
                        for (b_idx, item) in arr.iter().enumerate() {
                            let block_type = item.get("type").and_then(Value::as_str).unwrap_or("");
                            match block_type {
                                "text" => {
                                    if let Some(txt) = item.get("text").and_then(Value::as_str) {
                                        blocks.push(ContentBlock::Text { text: txt.to_string() });
                                    }
                                }
                                "tool_use" => {
                                    let name = item.get("name").and_then(Value::as_str).unwrap_or("tool").to_string();
                                    let input = item.get("input").cloned().unwrap_or(Value::Null);
                                    let call_id = item
                                        .get("id")
                                        .and_then(Value::as_str)
                                        .map(str::to_owned)
                                        .unwrap_or_else(|| {
                                            stable_id("tool", &[&format!("{}:block:{}", provenance.key(), b_idx)])
                                        });
                                    blocks.push(ContentBlock::ToolCall {
                                        call_id,
                                        native_id: None,
                                        name,
                                        input,
                                        files: vec![],
                                    });
                                }
                                _ => {}
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
                    native_id,
                    seq,
                    role,
                    at: if seq == 1 { started_at } else { None },
                    blocks,
                });
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
        detail: "thread usage ledger timestamp".into(),
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
            project_root: None,
            title,
            started_at,
            ended_at,
            model,
            // Completion needs native evidence (CONTRACT.md); a thread with no usage ledger has none,
            // and the archive refuses a "done" session without it.
            status: if completion.is_some() { "done".into() } else { "unknown".into() },
            completion,
            turns,
            usage,
            parent_id: None,
            native_parent_id: None,
        },
        messages,
    })
}
