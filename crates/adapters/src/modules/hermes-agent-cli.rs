// Hermes Agent CLI history module
// Sources:
// - https://hermes-agent.nousresearch.com
// - https://hermes-agent.nousresearch.com/docs/user-guide/cli
// - https://github.com/NousResearch/hermes-agent
// - https://github.com/NousResearch/hermes-agent/blob/main/hermes_state_sessions.py
// - https://github.com/NousResearch/hermes-agent/blob/main/hermes_state_dbfile.py

use crate::adapter_spec::{AdapterDef, HistorySourceDef};
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
    if !table_exists(conn, "sessions") {
        return Ok(Vec::new());
    }

    let sess_cols = table_columns(conn, "sessions");
    if !sess_cols.contains("id") {
        return Ok(Vec::new());
    }

    let start_col = if sess_cols.contains("started_at") {
        "started_at"
    } else {
        "NULL"
    };
    let end_col = if sess_cols.contains("ended_at") {
        "ended_at"
    } else {
        "NULL"
    };
    let model_col = if sess_cols.contains("model") {
        "model"
    } else {
        "NULL"
    };
    let cwd_col = if sess_cols.contains("cwd") {
        "cwd"
    } else {
        "NULL"
    };
    let title_col = if sess_cols.contains("title") {
        "title"
    } else {
        "NULL"
    };
    let in_tok_col = if sess_cols.contains("input_tokens") {
        "input_tokens"
    } else {
        "NULL"
    };
    let out_tok_col = if sess_cols.contains("output_tokens") {
        "output_tokens"
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
        start_col, end_col, model_col, cwd_col, title_col, in_tok_col, out_tok_col, status_col
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Ok(Vec::new()),
    };

    let session_rows = stmt
        .query_map([], |row| {
            let raw_id: String = row.get(0)?;
            let started_at: Option<f64> = row.get(1).ok();
            let ended_at: Option<f64> = row.get(2).ok();
            let model: Option<String> = row.get(3).ok();
            let cwd: Option<String> = row.get(4).ok();
            let title: Option<String> = row.get(5).ok();
            let input_tokens: Option<i64> = row.get(6).ok();
            let output_tokens: Option<i64> = row.get(7).ok();
            let native_status: Option<String> = row.get(8).ok();

            Ok((
                raw_id,
                started_at,
                ended_at,
                model,
                cwd,
                title,
                input_tokens.map(|v| v.max(0) as u64),
                output_tokens.map(|v| v.max(0) as u64),
                native_status,
            ))
        })
        .map_err(|e| ReaderError::Parse(e.to_string()))?;

    let has_messages = table_exists(conn, "messages");
    let mut sessions = Vec::new();

    for sess_res in session_rows {
        let (
            raw_id,
            started_f64,
            ended_f64,
            model,
            cwd,
            title,
            tokens_in,
            tokens_out,
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
        let started_at = started_f64.and_then(real_to_ms);
        let ended_at = ended_f64.and_then(real_to_ms);

        let mut messages = Vec::new();

        if has_messages {
            let msg_cols = table_columns(conn, "messages");
            let has_role = msg_cols.contains("role");
            let has_content = msg_cols.contains("content");
            let has_tool_name = msg_cols.contains("tool_name");
            let has_tool_calls = msg_cols.contains("tool_calls");
            let has_ts = msg_cols.contains("timestamp");

            let msg_sql = format!(
                "SELECT id, {}, {}, {}, {}, {} FROM messages WHERE session_id = ?1 ORDER BY {} ASC, id ASC",
                if has_role { "role" } else { "NULL" },
                if has_content { "content" } else { "NULL" },
                if has_tool_name { "tool_name" } else { "NULL" },
                if has_tool_calls { "tool_calls" } else { "NULL" },
                if has_ts { "timestamp" } else { "NULL" },
                if has_ts { "timestamp" } else { "id" }
            );

            if let Ok(mut msg_stmt) = conn.prepare(&msg_sql) {
                if let Ok(m_rows) = msg_stmt.query_map([&raw_id], |m_row| {
                    let id: i64 = m_row.get(0)?;
                    let role: Option<String> = m_row.get(1).ok();
                    let content: Option<String> = m_row.get(2).ok();
                    let tool_name: Option<String> = m_row.get(3).ok();
                    let tool_calls_raw: Option<String> = m_row.get(4).ok();
                    let ts: Option<f64> = m_row.get(5).ok();
                    Ok((id, role, content, tool_name, tool_calls_raw, ts))
                }) {
                    for m_res in m_rows.flatten() {
                        let (id, role_opt, content_opt, tool_name_opt, tool_calls_raw, ts_f64) =
                            m_res;
                        let role = role_opt.unwrap_or_else(|| "user".to_string());
                        let at = ts_f64.and_then(real_to_ms);
                        let mut blocks = Vec::new();

                        if let Some(content) = content_opt {
                            if !content.is_empty() {
                                blocks.push(ContentBlock::Text { text: content });
                            }
                        }

                        if let Some(raw_tc) = tool_calls_raw {
                            if let Ok(parsed) = serde_json::from_str::<Value>(&raw_tc) {
                                let tc_list = match parsed {
                                    Value::Array(arr) => arr,
                                    Value::Object(_) => vec![parsed],
                                    _ => Vec::new(),
                                };

                                for tc in tc_list {
                                    let name = tc
                                        .get("name")
                                        .and_then(|v| v.as_str())
                                        .or(tool_name_opt.as_deref())
                                        .unwrap_or("unknown")
                                        .to_string();

                                    let input_val = tc
                                        .get("args")
                                        .or_else(|| tc.get("input"))
                                        .cloned()
                                        .unwrap_or(Value::Null);

                                    let mut files = Vec::new();
                                    extract_files_from_value(&input_val, &mut files);

                                    let native_id = tc
                                        .get("id")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string());
                                    let call_id = native_id.clone().unwrap_or_else(|| {
                                        armillary_model::stable_id(
                                            "tool",
                                            &[&format!("{}_{}", id, blocks.len())],
                                        )
                                    });

                                    blocks.push(ContentBlock::ToolCall {
                                        call_id,
                                        native_id,
                                        name,
                                        input: input_val,
                                        files,
                                    });
                                }
                            }
                        }

                        if blocks.is_empty() {
                            blocks.push(ContentBlock::Text {
                                text: String::new(),
                            });
                        }

                        let seq = (messages.len() + 1) as u32;
                        let native_msg_id = id.to_string();
                        let m_id = normalized_message_id(
                            &session_id,
                            Some(&native_msg_id),
                            &provenance.key(),
                            provenance.generation,
                            seq,
                        );

                        messages.push(Message {
                            id: m_id,
                            session_id: session_id.clone(),
                            native_id: Some(native_msg_id),
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

        sessions.push(NormalizedSession {
            session: Session {
                id: session_id,
                agent_id: adapter.id.clone(),
                installation_id: None,
                native_id: Some(raw_id),
                provenance: provenance.clone(),
                project_root: cwd,
                title,
                started_at,
                ended_at,
                model,
                status: status.clone(),
                completion: super::completion_from_native(&status, ended_at, "sessions.ended_at"),
                turns,
                usage,
                parent_id: None,
                native_parent_id: None,
            },
            messages,
        });
    }

    Ok(sessions)
}

fn real_to_ms(seconds: f64) -> Option<i64> {
    if seconds <= 0.0 {
        None
    } else if seconds < 100_000_000_000.0 {
        Some((seconds * 1000.0).round() as i64)
    } else {
        Some(seconds.round() as i64)
    }
}
