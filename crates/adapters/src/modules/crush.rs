// Crush history module
// Sources:
// - https://github.com/charmbracelet/crush
// - https://charm.land/crush
// - https://github.com/charmbracelet/crush/blob/main/internal/db/connect.go
// - https://github.com/charmbracelet/crush/blob/main/internal/db/models.go
// - https://github.com/charmbracelet/crush/blob/main/internal/message/message.go

use crate::adapter_spec::{AdapterDef, HistorySourceDef};
use crate::model::{
    normalized_message_id, normalized_session_id, ContentBlock, Message, NormalizedSession,
    Session, SourceProvenance, Usage, UsageObservation, UsageSemantics,
};
use crate::modules::{extract_files_from_value, table_columns, table_exists};
use crate::readers::jsonl::ReaderError;
use rusqlite::Connection;
use serde_json::Value;
use std::path::Path;

pub fn read_from_snapshot(
    adapter: &AdapterDef,
    _source: &HistorySourceDef,
    provenance: &SourceProvenance,
    conn: &Connection,
) -> Result<Vec<NormalizedSession>, ReaderError> {
    if !table_exists(conn, "sessions") {
        return Ok(Vec::new());
    }

    let sess_cols = table_columns(conn, "sessions");
    if !sess_cols.contains("id") {
        return Ok(Vec::new());
    }

    let title_col = if sess_cols.contains("title") {
        "title"
    } else {
        "NULL"
    };
    let parent_col = if sess_cols.contains("parent_session_id") {
        "parent_session_id"
    } else {
        "NULL"
    };
    let prompt_tokens_col = if sess_cols.contains("prompt_tokens") {
        "prompt_tokens"
    } else {
        "NULL"
    };
    let comp_tokens_col = if sess_cols.contains("completion_tokens") {
        "completion_tokens"
    } else {
        "NULL"
    };
    let created_col = if sess_cols.contains("created_at") {
        "created_at"
    } else {
        "NULL"
    };
    let updated_col = if sess_cols.contains("updated_at") {
        "updated_at"
    } else {
        "NULL"
    };
    let cwd_col = if sess_cols.contains("cwd") {
        "cwd"
    } else if sess_cols.contains("project_dir") {
        "project_dir"
    } else if sess_cols.contains("working_dir") {
        "working_dir"
    } else {
        "NULL"
    };
    let status_col = if sess_cols.contains("status") {
        "status"
    } else {
        "NULL"
    };

    let sql = format!(
        "SELECT id, {}, {}, {}, {}, {}, {}, {}, {} FROM sessions",
        title_col,
        parent_col,
        prompt_tokens_col,
        comp_tokens_col,
        created_col,
        updated_col,
        cwd_col,
        status_col
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Ok(Vec::new()),
    };

    let session_rows = stmt
        .query_map([], |row| {
            let raw_id: String = row.get(0)?;
            let title: Option<String> = row.get(1).ok();
            let parent_id: Option<String> = row.get(2).ok();
            let prompt_tokens: Option<i64> = row.get(3).ok();
            let comp_tokens: Option<i64> = row.get(4).ok();
            let created_at: Option<i64> = row.get(5).ok();
            let updated_at: Option<i64> = row.get(6).ok();
            let row_cwd: Option<String> = row.get(7).ok();
            let native_status: Option<String> = row.get(8).ok();

            Ok((
                raw_id,
                title,
                parent_id,
                prompt_tokens.map(|v| v.max(0) as u64),
                comp_tokens.map(|v| v.max(0) as u64),
                created_at,
                updated_at,
                row_cwd,
                native_status,
            ))
        })
        .map_err(|e| ReaderError::Parse(e.to_string()))?;

    let default_project_root = {
        let p = Path::new(&provenance.source_path);
        if p.starts_with(".crush") {
            p.parent().and_then(|parent| parent.parent()).map(|r| r.to_string_lossy().to_string())
        } else {
            p.parent().map(|r| r.to_string_lossy().to_string())
        }
    };

    let has_messages = table_exists(conn, "messages");
    let mut sessions = Vec::new();

    for sess_res in session_rows {
        let (
            raw_id,
            title,
            parent_id,
            tokens_in,
            tokens_out,
            created_at,
            updated_at,
            row_cwd,
            native_status,
        ) = match sess_res {
            Ok(v) => v,
            Err(_) => continue,
        };

        let session_id = normalized_session_id(
            &provenance.store.id,
            Some(&raw_id),
            &provenance.source_path,
        );
        let started_at = created_at.map(to_unix_ms);
        let ended_at = updated_at.map(to_unix_ms);
        let project_root = row_cwd.or_else(|| default_project_root.clone());

        let mut messages = Vec::new();
        let mut session_model = None;

        if has_messages {
            let msg_cols = table_columns(conn, "messages");
            let has_role = msg_cols.contains("role");
            let has_parts = msg_cols.contains("parts");
            let has_model = msg_cols.contains("model");
            let m_created_col = if msg_cols.contains("created_at") {
                "created_at"
            } else {
                "NULL"
            };

            let msg_sql = format!(
                "SELECT id, {}, {}, {}, {} FROM messages WHERE session_id = ?1 ORDER BY {} ASC, id ASC",
                if has_role { "role" } else { "NULL" },
                if has_parts { "parts" } else { "NULL" },
                if has_model { "model" } else { "NULL" },
                m_created_col,
                msg_cols.contains("created_at").then(|| "created_at").unwrap_or("id")
            );

            if let Ok(mut msg_stmt) = conn.prepare(&msg_sql) {
                if let Ok(m_rows) = msg_stmt.query_map([&raw_id], |m_row| {
                    let msg_id: String = m_row.get(0)?;
                    let role: Option<String> = m_row.get(1).ok();
                    let parts_str: Option<String> = m_row.get(2).ok();
                    let model: Option<String> = m_row.get(3).ok();
                    let msg_created: Option<i64> = m_row.get(4).ok();
                    Ok((msg_id, role, parts_str, model, msg_created))
                }) {
                    for m_res in m_rows.flatten() {
                        let (msg_id, role_opt, parts_str, model_opt, msg_created) = m_res;

                        if session_model.is_none() && model_opt.is_some() {
                            session_model = model_opt.clone();
                        }

                        let role = role_opt.unwrap_or_else(|| "user".to_string());
                        let mut blocks = Vec::new();

                        if let Some(parts_json) = parts_str {
                            if let Ok(Value::Array(parts)) =
                                serde_json::from_str::<Value>(&parts_json)
                            {
                                for part in parts {
                                    let part_type = part
                                        .get("type")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    let data = part.get("data").unwrap_or(&part);

                                    match part_type {
                                        "text" => {
                                            let text = data
                                                .get("text")
                                                .and_then(|v| v.as_str())
                                                .or_else(|| data.as_str())
                                                .unwrap_or("")
                                                .to_string();
                                            blocks.push(ContentBlock::Text { text });
                                        }
                                        "tool_call" => {
                                            let tool_name = data
                                                .get("name")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("unknown")
                                                .to_string();

                                            let input_val =
                                                data.get("input").cloned().unwrap_or(Value::Null);
                                            let parsed_input = if let Value::String(s) = &input_val
                                            {
                                                serde_json::from_str::<Value>(s)
                                                    .unwrap_or(input_val.clone())
                                            } else {
                                                input_val.clone()
                                            };

                                            let mut files = Vec::new();
                                            extract_files_from_value(&parsed_input, &mut files);

                                            let native_id = data
                                                .get("id")
                                                .or_else(|| data.get("tool_call_id"))
                                                .and_then(|v| v.as_str())
                                                .map(|s| s.to_string());

                                            let call_id = native_id.clone().unwrap_or_else(|| {
                                                armillary_model::stable_id(
                                                    "tool",
                                                    &[&format!("{}_{}", msg_id, blocks.len())],
                                                )
                                            });

                                            blocks.push(ContentBlock::ToolCall {
                                                call_id,
                                                native_id,
                                                name: tool_name,
                                                input: input_val,
                                                files,
                                            });
                                        }
                                        "tool_result" => {
                                            let call_id = data
                                                .get("tool_call_id")
                                                .or_else(|| data.get("id"))
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("")
                                                .to_string();

                                            let output = data
                                                .get("content")
                                                .or_else(|| data.get("text"))
                                                .cloned()
                                                .unwrap_or_else(|| data.clone());

                                            let is_error = data
                                                .get("is_error")
                                                .or_else(|| data.get("error"))
                                                .and_then(|v| v.as_bool());

                                            blocks.push(ContentBlock::ToolResult {
                                                call_id,
                                                output,
                                                is_error,
                                            });
                                        }
                                        "code" => {
                                            let code = data
                                                .get("code")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("")
                                                .to_string();
                                            let language = data
                                                .get("language")
                                                .and_then(|v| v.as_str())
                                                .map(|s| s.to_string());
                                            blocks.push(ContentBlock::Code { code, language });
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }

                        if blocks.is_empty() {
                            blocks.push(ContentBlock::Text {
                                text: String::new(),
                            });
                        }

                        let seq = (messages.len() + 1) as u32;
                        let at = msg_created.map(to_unix_ms);
                        let m_id = normalized_message_id(
                            &session_id,
                            Some(&msg_id),
                            &provenance.key(),
                            provenance.generation,
                            seq,
                        );

                        messages.push(Message {
                            id: m_id,
                            session_id: session_id.clone(),
                            native_id: Some(msg_id),
                            seq,
                            role,
                            at,
                            blocks,
                        });
                    }
                }
            }
        }

        let turns = messages
            .iter()
            .filter(|m| {
                m.role == "user"
                    && m.blocks.iter().any(|b| {
                        matches!(b, ContentBlock::Text { .. } | ContentBlock::Code { .. })
                    })
            })
            .count() as u32;

        let mut observations = Vec::new();
        if tokens_in.is_some() || tokens_out.is_some() {
            observations.push(UsageObservation {
                event_id: armillary_model::stable_id("usage-summary", &[&session_id]),
                semantics: UsageSemantics::Cumulative,
                input_tokens: tokens_in,
                output_tokens: tokens_out,
                at: ended_at.or(started_at),
            });
        }
        let usage = Usage::from_observations(observations).unwrap_or_default();

        let status = native_status.unwrap_or_else(|| "unknown".to_string());

        let normalized_parent = parent_id.as_deref().map(|p| {
            normalized_session_id(&provenance.store.id, Some(p), &provenance.source_path)
        });

        sessions.push(NormalizedSession {
            session: Session {
                id: session_id,
                agent_id: adapter.id.clone(),
                installation_id: None,
                native_id: Some(raw_id),
                provenance: provenance.clone(),
                project_root,
                title,
                started_at,
                ended_at: None,
                model: session_model,
                status: status.clone(),
                completion: super::completion_from_native(&status, None, "native session status"),
                turns,
                usage,
                parent_id: normalized_parent,
                native_parent_id: parent_id,
            },
            messages,
        });
    }

    Ok(sessions)
}

fn to_unix_ms(ts: i64) -> i64 {
    if ts > 0 && ts < 100_000_000_000 {
        ts * 1000
    } else {
        ts
    }
}
