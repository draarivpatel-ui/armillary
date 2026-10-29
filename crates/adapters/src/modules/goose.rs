// Goose history module
// Sources:
// - https://goose-docs.ai/
// - https://github.com/block/goose
// - https://github.com/aaif-goose/goose
// - https://github.com/aaif-goose/goose/blob/main/crates/goose/src/session/session_manager.rs
// - https://github.com/aaif-goose/goose/blob/main/crates/goose/src/config/paths.rs

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
    if !table_exists(conn, "sessions") {
        return Ok(Vec::new());
    }

    let sess_cols = table_columns(conn, "sessions");
    if !sess_cols.contains("id") {
        return Ok(Vec::new());
    }

    let cwd_col = if sess_cols.contains("working_dir") {
        "working_dir"
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
    let in_tok_col = if sess_cols.contains("accumulated_input_tokens") {
        "accumulated_input_tokens"
    } else if sess_cols.contains("input_tokens") {
        "input_tokens"
    } else {
        "NULL"
    };
    let out_tok_col = if sess_cols.contains("accumulated_output_tokens") {
        "accumulated_output_tokens"
    } else if sess_cols.contains("output_tokens") {
        "output_tokens"
    } else {
        "NULL"
    };
    let model_col = if sess_cols.contains("model_config_json") {
        "model_config_json"
    } else {
        "NULL"
    };
    let name_col = if sess_cols.contains("name") {
        "name"
    } else {
        "NULL"
    };
    let user_name_col = if sess_cols.contains("user_set_name") {
        "user_set_name"
    } else {
        "NULL"
    };
    let desc_col = if sess_cols.contains("description") {
        "description"
    } else {
        "NULL"
    };
    let arch_col = if sess_cols.contains("archived_at") {
        "archived_at"
    } else {
        "NULL"
    };
    let type_col = if sess_cols.contains("session_type") {
        "session_type"
    } else {
        "NULL"
    };
    let parent_col = if sess_cols.contains("parent_session_id") {
        "parent_session_id"
    } else {
        "NULL"
    };
    let status_col = if sess_cols.contains("status") {
        "status"
    } else {
        "NULL"
    };

    let sql = format!(
        "SELECT id, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {} FROM sessions",
        cwd_col,
        created_col,
        updated_col,
        in_tok_col,
        out_tok_col,
        model_col,
        name_col,
        user_name_col,
        desc_col,
        arch_col,
        type_col,
        parent_col,
        status_col
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Ok(Vec::new()),
    };

    let session_rows = stmt
        .query_map([], |row| {
            let raw_id: String = row.get(0)?;
            let working_dir: Option<String> = row.get(1).ok();
            let created_raw: Option<String> = row.get(2).ok();
            let updated_raw: Option<String> = row.get(3).ok();
            let tokens_in: Option<i64> = row.get(4).ok();
            let tokens_out: Option<i64> = row.get(5).ok();
            let model_cfg: Option<String> = row.get(6).ok();
            let name: Option<String> = row.get(7).ok();
            let user_set_name: Option<String> = row.get(8).ok();
            let description: Option<String> = row.get(9).ok();
            let archived_at: Option<String> = row.get(10).ok();
            let session_type: Option<String> = row.get(11).ok();
            let parent_session_id: Option<String> = row.get(12).ok();
            let native_status: Option<String> = row.get(13).ok();

            Ok((
                raw_id,
                working_dir,
                created_raw,
                updated_raw,
                tokens_in.map(|v| v.max(0) as u64),
                tokens_out.map(|v| v.max(0) as u64),
                model_cfg,
                name,
                user_set_name,
                description,
                archived_at,
                session_type,
                parent_session_id,
                native_status,
            ))
        })
        .map_err(|e| ReaderError::Parse(e.to_string()))?;

    let has_messages = table_exists(conn, "messages");
    let mut sessions = Vec::new();

    for sess_res in session_rows {
        let (
            raw_id,
            working_dir,
            created_raw,
            updated_raw,
            tokens_in,
            tokens_out,
            model_cfg,
            name,
            user_set_name,
            description,
            _archived_at,
            session_type,
            parent_session_id,
            native_status,
        ) = match sess_res {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Skip non-user sessions. A session archived in Goose keeps its messages and is still
        // history, so it is imported like any other.
        if let Some(stype) = &session_type {
            if !stype.trim().is_empty() && stype != "user" {
                continue;
            }
        }

        let session_id = normalized_session_id(
            &provenance.store.id,
            Some(&raw_id),
            &provenance.source_path,
        );
        let started_at = created_raw.as_deref().and_then(|s| {
            let normalized = s.trim().replace(' ', "T");
            parse_timestamp(&Value::String(normalized), None)
        });
        let ended_at = updated_raw.as_deref().and_then(|s| {
            let normalized = s.trim().replace(' ', "T");
            parse_timestamp(&Value::String(normalized), None)
        });

        let title = user_set_name
            .filter(|s| !s.trim().is_empty())
            .or_else(|| name.filter(|s| !s.trim().is_empty()))
            .or_else(|| description.filter(|s| !s.trim().is_empty()));

        let model = model_cfg.and_then(|raw| {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                if let Some(m) = val.get("model").and_then(|v| v.as_str()) {
                    return Some(m.to_string());
                }
            }
            Some(raw)
        });

        let mut messages = Vec::new();

        if has_messages {
            let msg_cols = table_columns(conn, "messages");
            let has_role = msg_cols.contains("role");
            let has_content = msg_cols.contains("content_json") || msg_cols.contains("content");
            let content_col_name = if msg_cols.contains("content_json") {
                "content_json"
            } else {
                "content"
            };
            let has_tc = msg_cols.contains("tool_calls_json") || msg_cols.contains("tool_calls");
            let tc_col_name = if msg_cols.contains("tool_calls_json") {
                "tool_calls_json"
            } else {
                "tool_calls"
            };
            let time_col = if msg_cols.contains("created_at") {
                "created_at"
            } else {
                "NULL"
            };

            let order_col = if msg_cols.contains("id") {
                "id"
            } else if msg_cols.contains("created_at") {
                "created_at"
            } else {
                "message_id"
            };

            let msg_sql = format!(
                "SELECT message_id, {}, {}, {}, {} FROM messages WHERE session_id = ?1 ORDER BY {} ASC",
                if has_role { "role" } else { "NULL" },
                if has_content {
                    content_col_name
                } else {
                    "NULL"
                },
                if has_tc { tc_col_name } else { "NULL" },
                time_col,
                order_col
            );

            if let Ok(mut msg_stmt) = conn.prepare(&msg_sql) {
                if let Ok(m_rows) = msg_stmt.query_map([&raw_id], |m_row| {
                    let mid: String = m_row.get(0)?;
                    let role: Option<String> = m_row.get(1).ok();
                    let content_raw: Option<String> = m_row.get(2).ok();
                    let tc_raw: Option<String> = m_row.get(3).ok();
                    let created_str: Option<String> = m_row.get(4).ok();
                    Ok((mid, role, content_raw, tc_raw, created_str))
                }) {
                    for m_res in m_rows.flatten() {
                        let (mid, role_opt, content_raw, tc_raw, created_str) = m_res;
                        let role = role_opt.unwrap_or_else(|| "user".to_string());
                        let at = created_str.as_deref().and_then(|s| {
                            let normalized = s.trim().replace(' ', "T");
                            parse_timestamp(&Value::String(normalized), None)
                        });

                        let mut blocks = Vec::new();

                        if let Some(c_raw) = content_raw {
                            if let Ok(parsed) = serde_json::from_str::<Value>(&c_raw) {
                                match parsed {
                                    Value::Array(items) => {
                                        for item in items {
                                            if let Some(t) =
                                                item.get("text").and_then(|v| v.as_str())
                                            {
                                                blocks.push(ContentBlock::Text {
                                                    text: t.to_string(),
                                                });
                                            } else if let Some(t) =
                                                item.get("content").and_then(|v| v.as_str())
                                            {
                                                blocks.push(ContentBlock::Text {
                                                    text: t.to_string(),
                                                });
                                            }
                                        }
                                    }
                                    Value::String(s) => {
                                        blocks.push(ContentBlock::Text { text: s });
                                    }
                                    Value::Object(obj) => {
                                        if let Some(t) = obj.get("text").and_then(|v| v.as_str()) {
                                            blocks.push(ContentBlock::Text {
                                                text: t.to_string(),
                                            });
                                        }
                                    }
                                    _ => {}
                                }
                            } else {
                                blocks.push(ContentBlock::Text { text: c_raw });
                            }
                        }

                        if let Some(tc_str) = tc_raw {
                            if let Ok(parsed_tc) = serde_json::from_str::<Value>(&tc_str) {
                                let list = match parsed_tc {
                                    Value::Array(arr) => arr,
                                    Value::Object(_) => vec![parsed_tc],
                                    _ => Vec::new(),
                                };

                                for tc in list {
                                    let name = tc
                                        .get("name")
                                        .and_then(|v| v.as_str())
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
                                            &[&format!("{}_{}", mid, blocks.len())],
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
                        let m_id = normalized_message_id(
                            &session_id,
                            Some(&mid),
                            &provenance.key(),
                            provenance.generation,
                            seq,
                        );

                        messages.push(Message {
                            id: m_id,
                            session_id: session_id.clone(),
                            native_id: Some(mid),
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

        let normalized_parent = parent_session_id.as_deref().map(|p| {
            normalized_session_id(&provenance.store.id, Some(p), &provenance.source_path)
        });

        sessions.push(NormalizedSession {
            session: Session {
                id: session_id,
                agent_id: adapter.id.clone(),
                installation_id: None,
                native_id: Some(raw_id),
                provenance: provenance.clone(),
                project_root: working_dir,
                title,
                started_at,
                ended_at: None,
                model,
                status: status.clone(),
                completion: super::completion_from_native(&status, None, "native session status"),
                turns,
                usage,
                parent_id: normalized_parent,
                native_parent_id: parent_session_id,
            },
            messages,
        });
    }

    Ok(sessions)
}
