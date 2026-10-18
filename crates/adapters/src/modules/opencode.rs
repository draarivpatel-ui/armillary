// OpenCode history module
// Sources:
// - https://opencode.ai
// - https://github.com/anomalyco/opencode
// - https://github.com/anomalyco/opencode/blob/main/packages/desktop/src/main/storage/database.ts
// - https://github.com/anomalyco/opencode/releases

use crate::adapter_spec::{AdapterDef, HistorySourceDef};
use crate::mapping::parse_timestamp;
use crate::model::{
    normalized_message_id, normalized_session_id, ContentBlock, Message, NormalizedSession,
    Session, SourceProvenance, Usage, UsageObservation, UsageSemantics,
};
use crate::modules::{extract_files_from_value, table_columns, table_exists};
use crate::readers::jsonl::ReaderError;
use rusqlite::Connection;
use serde_json::Value;

pub fn read_from_snapshot(
    adapter: &AdapterDef,
    _source: &HistorySourceDef,
    provenance: &SourceProvenance,
    conn: &Connection,
) -> Result<Vec<NormalizedSession>, ReaderError> {
    let session_table = if table_exists(conn, "session") {
        "session"
    } else if table_exists(conn, "sessions") {
        "sessions"
    } else if table_exists(conn, "session_v2") {
        "session_v2"
    } else {
        return Ok(Vec::new());
    };

    let session_cols = table_columns(conn, session_table);
    if !session_cols.contains("id") {
        return Ok(Vec::new());
    }

    let title_col = if session_cols.contains("title") {
        "title"
    } else if session_cols.contains("slug") {
        "slug"
    } else {
        "NULL"
    };

    let dir_col = if session_cols.contains("directory") {
        "directory"
    } else if session_cols.contains("worktree") {
        "worktree"
    } else if session_cols.contains("cwd") {
        "cwd"
    } else {
        "NULL"
    };

    let created_col = if session_cols.contains("time_created") {
        "time_created"
    } else if session_cols.contains("created_at") {
        "created_at"
    } else {
        "NULL"
    };

    let updated_col = if session_cols.contains("time_updated") {
        "time_updated"
    } else if session_cols.contains("updated_at") {
        "updated_at"
    } else {
        "NULL"
    };

    let model_col = if session_cols.contains("model") {
        "model"
    } else {
        "NULL"
    };

    let tokens_in_col = if session_cols.contains("tokens_input") {
        "tokens_input"
    } else if session_cols.contains("tokens_in") {
        "tokens_in"
    } else if session_cols.contains("prompt_tokens") {
        "prompt_tokens"
    } else {
        "NULL"
    };

    let tokens_out_col = if session_cols.contains("tokens_output") {
        "tokens_output"
    } else if session_cols.contains("tokens_out") {
        "tokens_out"
    } else if session_cols.contains("completion_tokens") {
        "completion_tokens"
    } else {
        "NULL"
    };

    let parent_col = if session_cols.contains("parent_id") {
        "parent_id"
    } else {
        "NULL"
    };

    let status_col = if session_cols.contains("status") {
        "status"
    } else {
        "NULL"
    };

    let sql = format!(
        "SELECT id, {}, {}, {}, {}, {}, {}, {}, {}, {} FROM {}",
        title_col,
        dir_col,
        created_col,
        updated_col,
        model_col,
        tokens_in_col,
        tokens_out_col,
        parent_col,
        status_col,
        session_table
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Ok(Vec::new()),
    };

    let rows = stmt
        .query_map([], |row| {
            let raw_id: String = row.get(0)?;
            let title: Option<String> = row.get(1).ok();
            let directory: Option<String> = row.get(2).ok();
            let created_raw: Option<Value> = row.get_ref(3).ok().map(val_ref_to_json);
            let updated_raw: Option<Value> = row.get_ref(4).ok().map(val_ref_to_json);
            let model_raw: Option<String> = row.get(5).ok();
            let tokens_in: Option<u64> = row
                .get::<_, Option<i64>>(6)
                .ok()
                .flatten()
                .map(|v| v.max(0) as u64);
            let tokens_out: Option<u64> = row
                .get::<_, Option<i64>>(7)
                .ok()
                .flatten()
                .map(|v| v.max(0) as u64);
            let parent_id: Option<String> = row.get(8).ok();
            let native_status: Option<String> = row.get(9).ok();

            Ok((
                raw_id,
                title,
                directory,
                created_raw,
                updated_raw,
                model_raw,
                tokens_in,
                tokens_out,
                parent_id,
                native_status,
            ))
        })
        .map_err(|e| ReaderError::Parse(e.to_string()))?;

    let message_table = if table_exists(conn, "message") {
        Some("message")
    } else if table_exists(conn, "messages") {
        Some("messages")
    } else if table_exists(conn, "session_message") {
        Some("session_message")
    } else {
        None
    };

    let part_table = if table_exists(conn, "part") {
        Some("part")
    } else if table_exists(conn, "parts") {
        Some("parts")
    } else {
        None
    };

    let mut sessions = Vec::new();

    for row_res in rows {
        let (
            raw_id,
            title,
            directory,
            created_raw,
            updated_raw,
            model_raw,
            tokens_in,
            tokens_out,
            parent_id,
            native_status,
        ) = match row_res {
            Ok(data) => data,
            Err(_) => continue,
        };

        let session_id = normalized_session_id(
            &provenance.store.id,
            Some(&raw_id),
            &provenance.source_path,
        );
        let started_at = created_raw
            .and_then(|v| parse_timestamp(&v, None))
            .map(normalize_ms);
        let ended_at = updated_raw
            .and_then(|v| parse_timestamp(&v, None))
            .map(normalize_ms);

        let model = model_raw.and_then(|m| {
            if let Ok(parsed) = serde_json::from_str::<Value>(&m) {
                if let Some(id) = parsed.get("id").and_then(|v| v.as_str()) {
                    return Some(id.to_string());
                }
            }
            Some(m)
        });

        let mut messages = Vec::new();

        if let Some(msg_tbl) = message_table {
            let msg_cols = table_columns(conn, msg_tbl);
            let has_data = msg_cols.contains("data");
            let has_role = msg_cols.contains("role");
            let has_content = msg_cols.contains("content") || msg_cols.contains("text");
            let time_col = if msg_cols.contains("time_created") {
                "time_created"
            } else if msg_cols.contains("created_at") {
                "created_at"
            } else {
                "NULL"
            };

            let msg_sql = format!(
                "SELECT id, {}, {}, {}, {} FROM {} WHERE session_id = ?1 ORDER BY {} ASC, id ASC",
                if has_role { "role" } else { "NULL" },
                if has_content {
                    if msg_cols.contains("content") {
                        "content"
                    } else {
                        "text"
                    }
                } else {
                    "NULL"
                },
                if has_data { "data" } else { "NULL" },
                if time_col != "NULL" { time_col } else { "NULL" },
                msg_tbl,
                if time_col != "NULL" { time_col } else { "id" }
            );

            if let Ok(mut msg_stmt) = conn.prepare(&msg_sql) {
                let msg_rows = msg_stmt.query_map([&raw_id], |m_row| {
                    let msg_id: String = m_row.get(0)?;
                    let direct_role: Option<String> = m_row.get(1).ok();
                    let direct_content: Option<String> = m_row.get(2).ok();
                    let data_str: Option<String> = m_row.get(3).ok();
                    let msg_ts: Option<i64> = m_row.get(4).ok();
                    Ok((msg_id, direct_role, direct_content, data_str, msg_ts))
                });

                if let Ok(m_iter) = msg_rows {
                    for m_res in m_iter {
                        let (msg_id, direct_role, direct_content, data_str, msg_ts) = match m_res {
                            Ok(vals) => vals,
                            Err(_) => continue,
                        };

                        let parsed_data = data_str
                            .as_deref()
                            .and_then(|d| serde_json::from_str::<Value>(d).ok());
                        let role = direct_role
                            .or_else(|| {
                                parsed_data
                                    .as_ref()
                                    .and_then(|p| p.get("role"))
                                    .and_then(|r| r.as_str())
                                    .map(|s| s.to_string())
                            })
                            .unwrap_or_else(|| "user".to_string());

                        let at = msg_ts.map(normalize_ms).or(started_at);
                        let mut blocks = Vec::new();

                        // Query parts if part table exists
                        if let Some(prt_tbl) = part_table {
                            let part_cols = table_columns(conn, prt_tbl);
                            let p_data_col =
                                if part_cols.contains("data") { "data" } else { "NULL" };
                            let p_time_col = if part_cols.contains("time_created") {
                                "time_created"
                            } else if part_cols.contains("created_at") {
                                "created_at"
                            } else {
                                "NULL"
                            };

                            let part_sql = format!(
                                "SELECT id, {} FROM {} WHERE message_id = ?1 ORDER BY {} ASC, id ASC",
                                p_data_col,
                                prt_tbl,
                                if p_time_col != "NULL" { p_time_col } else { "id" }
                            );

                            if let Ok(mut p_stmt) = conn.prepare(&part_sql) {
                                if let Ok(p_rows) = p_stmt.query_map([&msg_id], |p_row| {
                                    let p_data: Option<String> = p_row.get(1).ok();
                                    Ok(p_data)
                                }) {
                                    for p_res in p_rows.flatten().flatten() {
                                        if let Ok(p_val) = serde_json::from_str::<Value>(&p_res) {
                                            let p_type = p_val
                                                .get("type")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("");
                                            if p_type == "text" {
                                                if let Some(t) =
                                                    p_val.get("text").and_then(|v| v.as_str())
                                                {
                                                    blocks.push(ContentBlock::Text {
                                                        text: t.to_string(),
                                                    });
                                                }
                                            } else if p_type == "tool" || p_type == "tool_call" {
                                                let call_obj =
                                                    p_val.get("call").unwrap_or(&p_val);
                                                let tool_name = call_obj
                                                    .get("name")
                                                    .and_then(|v| v.as_str())
                                                    .unwrap_or("unknown")
                                                    .to_string();

                                                let input_val = call_obj
                                                    .get("input")
                                                    .cloned()
                                                    .unwrap_or(Value::Null);

                                                let mut files = Vec::new();
                                                extract_files_from_value(&input_val, &mut files);

                                                let native_id = call_obj
                                                    .get("id")
                                                    .and_then(|v| v.as_str())
                                                    .map(|s| s.to_string());
                                                let call_id = native_id.clone().unwrap_or_else(
                                                    || {
                                                        armillary_model::stable_id(
                                                            "tool",
                                                            &[&format!(
                                                                "{}_{}",
                                                                msg_id,
                                                                blocks.len()
                                                            )],
                                                        )
                                                    },
                                                );

                                                blocks.push(ContentBlock::ToolCall {
                                                    call_id,
                                                    native_id,
                                                    name: tool_name,
                                                    input: input_val,
                                                    files,
                                                });
                                            } else if p_type == "tool_result" {
                                                let call_id = p_val
                                                    .get("tool_call_id")
                                                    .or_else(|| p_val.get("id"))
                                                    .and_then(|v| v.as_str())
                                                    .unwrap_or("")
                                                    .to_string();
                                                let output = p_val
                                                    .get("content")
                                                    .or_else(|| p_val.get("output"))
                                                    .cloned()
                                                    .unwrap_or_else(|| p_val.clone());
                                                let is_error = p_val
                                                    .get("is_error")
                                                    .and_then(|v| v.as_bool());
                                                blocks.push(ContentBlock::ToolResult {
                                                    call_id,
                                                    output,
                                                    is_error,
                                                });
                                            } else if p_type == "code" {
                                                let code = p_val
                                                    .get("code")
                                                    .and_then(|v| v.as_str())
                                                    .unwrap_or("")
                                                    .to_string();
                                                let language = p_val
                                                    .get("language")
                                                    .and_then(|v| v.as_str())
                                                    .map(|s| s.to_string());
                                                blocks.push(ContentBlock::Code {
                                                    code,
                                                    language,
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        if blocks.is_empty() {
                            if let Some(c) = direct_content {
                                blocks.push(ContentBlock::Text { text: c });
                            } else {
                                blocks.push(ContentBlock::Text {
                                    text: String::new(),
                                });
                            }
                        }

                        let msg_seq = (messages.len() + 1) as u32;
                        let m_id = normalized_message_id(
                            &session_id,
                            Some(&msg_id),
                            &provenance.key(),
                            provenance.generation,
                            msg_seq,
                        );

                        messages.push(Message {
                            id: m_id,
                            session_id: session_id.clone(),
                            native_id: Some(msg_id),
                            seq: msg_seq,
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
                project_root: directory,
                title,
                started_at,
                ended_at: None,
                model,
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

fn normalize_ms(ts: i64) -> i64 {
    if ts > 0 && ts < 100_000_000_000 {
        ts * 1000
    } else {
        ts
    }
}

fn val_ref_to_json(vref: rusqlite::types::ValueRef) -> Value {
    match vref {
        rusqlite::types::ValueRef::Null => Value::Null,
        rusqlite::types::ValueRef::Integer(i) => Value::Number(i.into()),
        rusqlite::types::ValueRef::Real(r) => {
            serde_json::Number::from_f64(r).map(Value::Number).unwrap_or(Value::Null)
        }
        rusqlite::types::ValueRef::Text(t) => {
            Value::String(String::from_utf8_lossy(t).to_string())
        }
        rusqlite::types::ValueRef::Blob(b) => {
            Value::String(format!("<blob len={}>", b.len()))
        }
    }
}
