use orrery_adapters::adapter_spec::{AdapterDef, HistorySourceDef};
use orrery_adapters::engine::AdapterEngine;
use orrery_adapters::model::{ContentBlock, UsageSemantics};
use rusqlite::Connection;
use std::fs;
use tempfile::tempdir;

fn make_adapter(id: &str, module: &str) -> AdapterDef {
    AdapterDef {
        id: id.to_string(),
        name: format!("{} Test", id),
        vendor: "Test Vendor".to_string(),
        family: "test".to_string(),
        kind: "extension".to_string(),
        coverage: Some("history".to_string()),
        homepage: None,
        docs_url: None,
        detection: Default::default(),
        adapter_version: "1.0.0".to_string(),
        store_namespace: Some(id.to_string()),
        history_sources: vec![HistorySourceDef {
            id: Some(format!("{}-hist", id)),
            format: if id == "cursor-cli" {
                "sqlite".to_string()
            } else {
                "json".to_string()
            },
            source_unit: None,
            paths: Default::default(),
            fixture_paths: vec![
                "sessions/*/*.json".to_string(),
                "sessions/*.json".to_string(),
                "tasks/*/*.json".to_string(),
                "chats/*/*/*".to_string(),
                "projects/*/agent-transcripts/*.jsonl".to_string(),
            ],
            query: None,
            mapping: None,
            module: Some(module.to_string()),
        }],
    }
}

#[test]
fn test_cline_synthetic_store() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // 1. Synthetic CLI/Desktop session format
    let sess_dir = root.join("sessions").join("1728740000000_cline1");
    fs::create_dir_all(&sess_dir).unwrap();

    let manifest = r#"{
        "session_id": "1728740000000_cline1",
        "cwd": "/workspace/synth-cline",
        "started_at": "2026-10-12T14:30:00.000Z",
        "ended_at": "2026-10-12T14:32:00.000Z",
        "model": "claude-3-7-sonnet-20250219",
        "prompt": "Create synthetic helper",
        "status": "completed"
    }"#;
    fs::write(sess_dir.join("1728740000000_cline1.json"), manifest).unwrap();

    let messages = r#"{
        "sessionId": "1728740000000_cline1",
        "messages": [
            {
                "id": "msg_001",
                "role": "user",
                "content": "Create synthetic helper function.",
                "ts": 1791815400000
            },
            {
                "id": "msg_002",
                "role": "assistant",
                "content": [
                    {
                        "type": "text",
                        "text": "I will create a helper module."
                    },
                    {
                        "type": "tool_use",
                        "id": "call_1",
                        "name": "write_to_file",
                        "input": {
                            "path": "src/helper.ts",
                            "content": "export function help() {}"
                        }
                    }
                ],
                "ts": 1791815460000,
                "metrics": {
                    "inputTokens": 1200,
                    "outputTokens": 340
                }
            }
        ]
    }"#;
    fs::write(sess_dir.join("1728740000000_cline1.messages.json"), messages).unwrap();

    // 2. Synthetic VS Code extension task format
    let task_dir = root.join("tasks").join("cline-task-002");
    fs::create_dir_all(&task_dir).unwrap();

    let task_meta = r#"{
        "taskId": "cline-task-002",
        "task": "Refactor router",
        "workspace": "/workspace/router-app",
        "timestamp": 1791816000000,
        "status": "completed"
    }"#;
    fs::write(task_dir.join("task_metadata.json"), task_meta).unwrap();

    let ui_msgs = r#"[
        {
            "ts": 1791816000000,
            "type": "say",
            "say": "text",
            "text": "Refactor router to use modern routes."
        },
        {
            "ts": 1791816030000,
            "type": "say",
            "say": "text",
            "text": "Routes have been updated."
        }
    ]"#;
    fs::write(task_dir.join("ui_messages.json"), ui_msgs).unwrap();

    let api_conv = r#"[
        {
            "role": "user",
            "content": "Refactor router to use modern routes."
        },
        {
            "role": "assistant",
            "content": "Routes have been updated."
        }
    ]"#;
    fs::write(task_dir.join("api_conversation_history.json"), api_conv).unwrap();

    let adapter = make_adapter("cline", "cline");
    let sessions = AdapterEngine::process_fixture_dir(&adapter, root).unwrap();

    assert_eq!(sessions.len(), 2, "Should find both session and task formats");

    let s1 = sessions.iter().find(|s| s.session.title.as_deref() == Some("Create synthetic helper")).unwrap();
    assert_eq!(s1.session.project_root.as_deref(), Some("/workspace/synth-cline"));
    assert_eq!(s1.session.turns, 1);
    assert_eq!(s1.session.usage.input_tokens, Some(1200));
    assert_eq!(s1.session.usage.output_tokens, Some(340));
    assert_eq!(s1.session.usage.semantics, UsageSemantics::Cumulative);
    assert_eq!(s1.session.id.len(), 64);
    assert_eq!(s1.messages.len(), 2);

    let tool_call = s1.messages[1].blocks.iter().find_map(|b| {
        if let ContentBlock::ToolCall { name, files, .. } = b {
            Some((name, files))
        } else {
            None
        }
    }).expect("tool call in assistant message blocks");
    assert_eq!(tool_call.0, "write_to_file");
    assert_eq!(tool_call.1, &vec!["src/helper.ts".to_string()]);

    let s2 = sessions.iter().find(|s| s.session.title.as_deref() == Some("Refactor router")).unwrap();
    assert_eq!(s2.session.project_root.as_deref(), Some("/workspace/router-app"));
    assert_eq!(s2.messages.len(), 2);
    assert_eq!(s2.messages[0].role, "user");
    assert_eq!(s2.messages[1].role, "assistant");
}

#[test]
fn test_roo_code_synthetic_store() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    let task_dir = root.join("tasks").join("roo-task-9001");
    fs::create_dir_all(&task_dir).unwrap();

    let history_item = r#"{
        "id": "roo-task-9001",
        "ts": 1791818000000,
        "task": "Add synthetic linting rule",
        "tokensIn": 3200,
        "tokensOut": 450,
        "cacheWrites": 0,
        "cacheReads": 1200,
        "totalCost": 0.015,
        "workspace": "/workspace/synth-lint",
        "status": "completed"
    }"#;
    fs::write(task_dir.join("history_item.json"), history_item).unwrap();

    let ui_messages = r#"[
        {
            "ts": 1791818000000,
            "type": "say",
            "say": "text",
            "text": "Add synthetic linting rule"
        },
        {
            "ts": 1791818020000,
            "type": "say",
            "say": "text",
            "text": "I will examine the linting configuration."
        }
    ]"#;
    fs::write(task_dir.join("ui_messages.json"), ui_messages).unwrap();

    let api_conv = r#"[
        {
            "role": "user",
            "content": "Add synthetic linting rule"
        },
        {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": "I will examine the linting configuration."
                },
                {
                    "type": "tool_use",
                    "id": "tool_read",
                    "name": "read_file",
                    "input": { "path": ".eslintrc.json" }
                }
            ]
        }
    ]"#;
    fs::write(task_dir.join("api_conversation_history.json"), api_conv).unwrap();

    // Lock file should be ignored
    fs::write(task_dir.join("history_item.json.lock"), "lock").unwrap();

    let adapter = make_adapter("roo-code", "roo-code");
    let sessions = AdapterEngine::process_fixture_dir(&adapter, root).unwrap();

    assert_eq!(sessions.len(), 1);
    let s = &sessions[0];
    assert_eq!(s.session.title.as_deref(), Some("Add synthetic linting rule"));
    assert_eq!(s.session.project_root.as_deref(), Some("/workspace/synth-lint"));
    assert_eq!(s.session.started_at, Some(1791818000000));
    assert_eq!(s.session.usage.input_tokens, Some(3200));
    assert_eq!(s.session.usage.output_tokens, Some(450));
    assert_eq!(s.session.id.len(), 64);
    assert_eq!(s.messages.len(), 2);

    let tool_call = s.messages[1].blocks.iter().find_map(|b| {
        if let ContentBlock::ToolCall { name, files, .. } = b {
            Some((name, files))
        } else {
            None
        }
    }).expect("tool call in assistant message blocks");
    assert_eq!(tool_call.0, "read_file");
    assert_eq!(tool_call.1, &vec![".eslintrc.json".to_string()]);
}

#[test]
fn test_kilo_code_synthetic_store() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    let task_dir = root.join("tasks").join("kilo-task-3001");
    fs::create_dir_all(&task_dir).unwrap();

    let meta = r#"{
        "taskId": "kilo-task-3001",
        "task": "Synthetic test setup",
        "workspace": "/workspace/synth-kilo",
        "timestamp": 1791817000000,
        "status": "completed"
    }"#;
    fs::write(task_dir.join("task_metadata.json"), meta).unwrap();

    let ui_msgs = r#"[
        {
            "ts": 1791817000000,
            "type": "say",
            "say": "text",
            "text": "Setup unit tests with mock runners."
        },
        {
            "ts": 1791817025000,
            "type": "say",
            "say": "text",
            "text": "Unit tests configured with synthetic runners."
        }
    ]"#;
    fs::write(task_dir.join("ui_messages.json"), ui_msgs).unwrap();

    let api_conv = r#"[
        {
            "role": "user",
            "content": "Setup unit tests with mock runners."
        },
        {
            "role": "assistant",
            "content": "Unit tests configured with synthetic runners."
        }
    ]"#;
    fs::write(task_dir.join("api_conversation_history.json"), api_conv).unwrap();

    let adapter = make_adapter("kilo-code", "kilo-code");
    let sessions = AdapterEngine::process_fixture_dir(&adapter, root).unwrap();

    assert_eq!(sessions.len(), 1);
    let s = &sessions[0];
    assert_eq!(s.session.title.as_deref(), Some("Synthetic test setup"));
    assert_eq!(s.session.project_root.as_deref(), Some("/workspace/synth-kilo"));
    assert_eq!(s.session.started_at, Some(1791817000000));
    assert_eq!(s.session.id.len(), 64);
    assert_eq!(s.messages.len(), 2);
    assert_eq!(s.messages[0].role, "user");
    assert_eq!(s.messages[1].role, "assistant");
}

#[test]
fn test_continue_synthetic_store() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    let sess_dir = root.join("sessions");
    fs::create_dir_all(&sess_dir).unwrap();

    let session_json = r#"{
        "sessionId": "6c7a8b9c-0123-4567-89ab-cdef01234567",
        "title": "Synthetic documentation update",
        "workspaceDirectory": "/workspace/synth-continue",
        "chatModelTitle": "claude-3-7-sonnet",
        "dateCreated": "2026-10-12T15:00:00.000Z",
        "usage": {
            "promptTokens": 850,
            "completionTokens": 190
        },
        "history": [
            {
                "message": {
                    "role": "user",
                    "content": "Update the readme with synthetic examples."
                },
                "contextItems": []
            },
            {
                "message": {
                    "role": "assistant",
                    "content": "I have updated the readme file with examples."
                },
                "toolCallStates": [
                    {
                        "toolCall": {
                            "id": "tc_1",
                            "function": {
                                "name": "editFile",
                                "arguments": "{\"path\":\"README.md\"}"
                            }
                        }
                    }
                ],
                "contextItems": []
            }
        ]
    }"#;
    fs::write(sess_dir.join("6c7a8b9c-0123-4567-89ab-cdef01234567.json"), session_json).unwrap();

    // Binary file in globalStorage should be ignored without panic
    let storage_dir = root.join("globalStorage");
    fs::create_dir_all(&storage_dir).unwrap();
    fs::write(storage_dir.join("continue.sessions.bin"), b"\x00\x01\x02\xffbinary").unwrap();

    let adapter = make_adapter("continue", "continue");
    let sessions = AdapterEngine::process_fixture_dir(&adapter, root).unwrap();

    assert_eq!(sessions.len(), 1);
    let s = &sessions[0];
    assert_eq!(s.session.title.as_deref(), Some("Synthetic documentation update"));
    assert_eq!(s.session.project_root.as_deref(), Some("/workspace/synth-continue"));
    assert_eq!(s.session.model.as_deref(), Some("claude-3-7-sonnet"));
    assert_eq!(s.session.usage.input_tokens, Some(850));
    assert_eq!(s.session.usage.output_tokens, Some(190));
    assert_eq!(s.session.id.len(), 64);
    assert_eq!(s.messages.len(), 2);

    let tool_call = s.messages[1].blocks.iter().find_map(|b| {
        if let ContentBlock::ToolCall { name, files, .. } = b {
            Some((name, files))
        } else {
            None
        }
    }).expect("tool call in assistant message blocks");
    assert_eq!(tool_call.0, "editFile");
    assert_eq!(tool_call.1, &vec!["README.md".to_string()]);
}

#[test]
fn test_cursor_cli_synthetic_store() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // 1. Chat with SQLite store.db
    let chat1_dir = root.join("chats").join("4e8a2b1c").join("d3f4a5b6-7c8d-4e9f-a0b1-c2d3e4f5a6b7");
    fs::create_dir_all(&chat1_dir).unwrap();

    let meta_json = r#"{
        "agentId": "d3f4a5b6-7c8d-4e9f-a0b1-c2d3e4f5a6b7",
        "cwd": "/Users/developer/code/frontend-app",
        "name": "Add dark mode toggle",
        "createdAt": 1791814000000,
        "mode": "agent",
        "lastUsedModel": "claude-3-7-sonnet"
    }"#;
    fs::write(chat1_dir.join("meta.json"), meta_json).unwrap();

    // Build real SQLite store.db
    let db_path = chat1_dir.join("store.db");
    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);",
        ).unwrap();

        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('0', ?1)",
            [meta_json],
        ).unwrap();

        let blob_data = r#"[
            {"role": "user", "content": "Add dark mode toggle to the navbar."},
            {"role": "assistant", "content": [
                {"type": "text", "text": "I will add the theme switcher to Navbar.tsx."},
                {"type": "tool-call", "toolName": "Write", "args": {"path": "src/Navbar.tsx"}}
            ]}
        ]"#;
        conn.execute(
            "INSERT INTO blobs (id, data) VALUES ('blob_head', ?1)",
            [blob_data.as_bytes()],
        ).unwrap();
    }

    // 2. Chat with agent-transcripts JSONL
    let chat2_dir = root.join("chats").join("9f8e7d6c").join("a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d");
    fs::create_dir_all(&chat2_dir).unwrap();

    let meta2 = r#"{
        "agentId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
        "cwd": "/Users/developer/code/backend-service",
        "name": "Optimize database queries",
        "createdAt": 1791815000000,
        "mode": "agent",
        "lastUsedModel": "gpt-4o"
    }"#;
    fs::write(chat2_dir.join("meta.json"), meta2).unwrap();

    let transcripts_dir = root.join("projects").join("9f8e7d6c").join("agent-transcripts");
    fs::create_dir_all(&transcripts_dir).unwrap();
    let transcript_lines = "{\"role\":\"user\",\"content\":\"Optimize slow queries.\"}\n{\"role\":\"assistant\",\"content\":\"Indexed the foreign keys.\"}\n";
    fs::write(transcripts_dir.join("a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d.jsonl"), transcript_lines).unwrap();

    let adapter = make_adapter("cursor-cli", "cursor-cli");
    let sessions = AdapterEngine::process_fixture_dir(&adapter, root).unwrap();

    assert_eq!(sessions.len(), 2);

    let s1 = sessions.iter().find(|s| s.session.title.as_deref() == Some("Add dark mode toggle")).unwrap();
    assert_eq!(s1.session.project_root.as_deref(), Some("/Users/developer/code/frontend-app"));
    assert_eq!(s1.session.model.as_deref(), Some("claude-3-7-sonnet"));
    assert_eq!(s1.session.id.len(), 64);
    assert_eq!(s1.messages.len(), 2);

    let tool_call = s1.messages[1].blocks.iter().find_map(|b| {
        if let ContentBlock::ToolCall { name, files, .. } = b {
            Some((name, files))
        } else {
            None
        }
    }).expect("tool call in assistant message blocks");
    assert_eq!(tool_call.0, "Write");
    assert_eq!(tool_call.1, &vec!["src/Navbar.tsx".to_string()]);

    let s2 = sessions.iter().find(|s| s.session.title.as_deref() == Some("Optimize database queries")).unwrap();
    assert_eq!(s2.session.project_root.as_deref(), Some("/Users/developer/code/backend-service"));
    assert_eq!(s2.messages.len(), 2);
}

#[test]
fn test_modules_malformed_and_truncated_never_panic() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    let cline_corrupt = root.join("sessions").join("corrupt_cline");
    fs::create_dir_all(&cline_corrupt).unwrap();
    fs::write(cline_corrupt.join("corrupt_cline.json"), "{ truncated json").unwrap();
    fs::write(cline_corrupt.join("corrupt_cline.messages.json"), b"\x80\x81not-utf8").unwrap();

    let roo_corrupt = root.join("tasks").join("corrupt_roo");
    fs::create_dir_all(&roo_corrupt).unwrap();
    fs::write(roo_corrupt.join("history_item.json"), "{ invalid").unwrap();
    fs::write(roo_corrupt.join("ui_messages.json"), "[").unwrap();

    let continue_corrupt = root.join("sessions").join("bad_continue.json");
    fs::write(&continue_corrupt, "null").unwrap();

    let cursor_corrupt_dir = root.join("chats").join("bad").join("bad_uuid");
    fs::create_dir_all(&cursor_corrupt_dir).unwrap();
    fs::write(cursor_corrupt_dir.join("store.db"), b"not a sqlite database file at all").unwrap();
    fs::write(cursor_corrupt_dir.join("meta.json"), "{\"agentId\":").unwrap();

    for mod_name in &["cline", "roo-code", "kilo-code", "continue", "cursor-cli"] {
        let adapter = make_adapter(mod_name, mod_name);
        let res = AdapterEngine::process_fixture_dir(&adapter, root);
        assert!(res.is_ok(), "Module {} should not panic or fail on corrupt inputs", mod_name);
    }
}

#[test]
fn test_modules_skip_credentials() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    let task_dir = root.join("tasks").join("cred-test");
    fs::create_dir_all(&task_dir).unwrap();

    fs::write(task_dir.join("auth.json"), "{\"token\": \"secret\"}").unwrap();
    fs::write(task_dir.join(".credentials.json"), "{\"key\": \"secret\"}").unwrap();
    fs::write(task_dir.join("id_rsa"), "private key").unwrap();
    fs::write(task_dir.join(".env"), "SECRET=val").unwrap();

    for mod_name in &["cline", "roo-code", "kilo-code", "continue", "cursor-cli"] {
        let adapter = make_adapter(mod_name, mod_name);
        let res = AdapterEngine::process_fixture_dir(&adapter, root).unwrap();
        assert_eq!(res.len(), 0);
    }
}

#[test]
fn test_cursor_cli_malformed_transcript_line_fails_the_file() {
    let dir = tempdir().unwrap();
    let transcripts_dir = dir.path().join("projects").join("p1").join("agent-transcripts");
    fs::create_dir_all(&transcripts_dir).unwrap();
    let lines = "{\"role\":\"user\",\"content\":\"First\"}\n{\"role\":\"assistant\",\"content\n{\"role\":\"user\",\"content\":\"Third\"}\n";
    fs::write(transcripts_dir.join("t1.jsonl"), lines).unwrap();

    let adapter = make_adapter("cursor-cli", "cursor-cli");
    let batches = AdapterEngine::fixture_batches(&adapter, dir.path()).unwrap();
    assert_eq!(batches.len(), 1);
    // Never a Complete snapshot that quietly lacks the broken record.
    assert_eq!(batches[0].read_status, orrery_adapters::model::ReadStatus::Failed);
    assert!(batches[0].sessions.is_empty());
    assert_eq!(batches[0].diagnostics[0].code, "parse");
}

#[test]
fn test_cline_reply_rewritten_in_place_changes_the_checkpoint() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let sess_dir = root.join("sessions").join("s1");
    fs::create_dir_all(&sess_dir).unwrap();
    fs::write(sess_dir.join("s1.json"), r#"{"session_id":"s1","prompt":"Hi"}"#).unwrap();
    let task_dir = root.join("tasks").join("t1");
    fs::create_dir_all(&task_dir).unwrap();
    fs::write(task_dir.join("task_metadata.json"), r#"{"taskId":"t1"}"#).unwrap();
    let write_replies = |reply: &str| {
        let cli = format!(r#"{{"messages":[{{"role":"user","content":"Hi"}},{{"role":"assistant","content":"{reply}"}}]}}"#);
        fs::write(sess_dir.join("s1.messages.json"), cli).unwrap();
        let ui = format!(r#"[{{"ts":1791816000000,"type":"say","say":"text","text":"{reply}"}}]"#);
        fs::write(task_dir.join("ui_messages.json"), ui).unwrap();
    };
    let adapter = make_adapter("cline", "cline");
    let checkpoints = || {
        let mut out: Vec<_> = AdapterEngine::fixture_batches(&adapter, root)
            .unwrap()
            .into_iter()
            .map(|b| (b.source.source_path.clone(), b.source.checkpoint.digest.clone()))
            .collect();
        out.sort();
        out
    };
    write_replies("Partial repl");
    let before = checkpoints();
    write_replies("Partial reply, now finished");
    let after = checkpoints();
    assert_eq!(before.len(), 2, "{before:?}");
    for (b, a) in before.iter().zip(&after) {
        assert_eq!(b.0, a.0);
        assert_ne!(b.1, a.1, "{} kept its checkpoint after the reply changed", b.0);
    }
}

/// sol-loop S7: the checkpoint digest of a Cursor chat or a Kimi session covers the file that
/// holds its messages, not only the metadata file that names the source. Otherwise a reply changed
/// there reads as a replay of the accepted checkpoint, which the archive refuses for the run.
fn digests(adapter: &AdapterDef, root: &std::path::Path) -> Vec<(String, String)> {
    let mut out: Vec<_> = AdapterEngine::fixture_batches(adapter, root)
        .unwrap()
        .into_iter()
        .map(|b| (b.source.source_path.clone(), b.source.checkpoint.digest.clone()))
        .collect();
    out.sort();
    out
}

#[test]
fn test_cursor_and_kimi_message_files_feed_the_checkpoint() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let chat = root.join("chats").join("h1").join("c1");
    fs::create_dir_all(&chat).unwrap();
    fs::write(chat.join("meta.json"), r#"{"agentId":"c1","name":"Chat"}"#).unwrap();
    let transcripts = root.join("projects").join("p1").join("agent-transcripts");
    fs::create_dir_all(&transcripts).unwrap();
    let cursor = make_adapter("cursor-cli", "cursor-cli");
    let write_cursor = |reply: &str| {
        let lines = format!("{{\"role\":\"user\",\"content\":\"Hi\"}}\n{{\"role\":\"assistant\",\"content\":\"{reply}\"}}\n");
        fs::write(transcripts.join("c1.jsonl"), lines).unwrap();
    };
    write_cursor("A long first reply");
    let before = digests(&cursor, root);
    write_cursor("Short");
    let after = digests(&cursor, root);
    assert_eq!(before.len(), 1, "{before:?}");
    assert_eq!(before[0].0, after[0].0);
    assert_ne!(before[0].1, after[0].1, "Cursor kept its checkpoint after the reply changed");

    let dir = tempdir().unwrap();
    let root = dir.path();
    let session = root.join("sessions").join("wd_x").join("ses_1");
    fs::create_dir_all(session.join("agents/main")).unwrap();
    fs::write(session.join("state.json"), r#"{"id":"ses_1","title":"T"}"#).unwrap();
    let kimi = make_adapter("kimi-code-cli", "kimi-code-cli");
    let write_kimi = |reply: &str| {
        let wire = format!(
            "{{\"type\":\"context.append_message\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"Hi\"}}]}}}}\n\
             {{\"type\":\"context.append_message\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{reply}\"}}]}}}}\n"
        );
        fs::write(session.join("agents/main/wire.jsonl"), wire).unwrap();
    };
    write_kimi("A long first reply");
    let before = digests(&kimi, root);
    write_kimi("Short");
    let after = digests(&kimi, root);
    assert_eq!(before.len(), 1, "{before:?}");
    assert_eq!(before[0].0, after[0].0);
    assert_ne!(before[0].1, after[0].1, "Kimi kept its checkpoint after the reply changed");
}

#[test]
fn test_roo_and_kilo_replies_rewritten_in_place_change_the_checkpoint() {
    for (id, meta_name) in [("roo-code", "history_item.json"), ("kilo-code", "task_metadata.json")] {
        let dir = tempdir().unwrap();
        let task = dir.path().join("tasks").join("t1");
        fs::create_dir_all(&task).unwrap();
        fs::write(task.join(meta_name), r#"{"id":"t1","taskId":"t1","task":"Hi"}"#).unwrap();
        let write_reply = |reply: &str| {
            let api = format!(r#"[{{"role":"user","content":"Hi"}},{{"role":"assistant","content":"{reply}"}}]"#);
            fs::write(task.join("api_conversation_history.json"), api).unwrap();
            let ui = format!(r#"[{{"ts":1791816000000,"type":"say","say":"text","text":"{reply}"}}]"#);
            fs::write(task.join("ui_messages.json"), ui).unwrap();
        };
        let adapter = make_adapter(id, id);
        write_reply("A long first reply");
        let before = digests(&adapter, dir.path());
        write_reply("Short");
        let after = digests(&adapter, dir.path());
        assert_eq!(before.len(), 1, "{id}: {before:?}");
        assert_eq!(before[0].0, after[0].0);
        assert_ne!(before[0].1, after[0].1, "{id} kept its checkpoint after the reply changed");
    }
}

/// sol-loop S11: Cursor and Continue store a creation time and no end marker, so a session's end
/// time and completion stay unknown instead of the start time standing in as "completed".
#[test]
fn test_cursor_and_continue_sessions_have_no_invented_end() {
    let dir = tempdir().unwrap();
    let chat = dir.path().join("chats").join("h1").join("c1");
    fs::create_dir_all(&chat).unwrap();
    fs::write(chat.join("meta.json"), r#"{"agentId":"c1","name":"Chat","createdAt":1791814000000}"#).unwrap();
    let transcripts = dir.path().join("projects").join("p1").join("agent-transcripts");
    fs::create_dir_all(&transcripts).unwrap();
    fs::write(transcripts.join("c1.jsonl"), "{\"role\":\"user\",\"content\":\"Hi\"}\n").unwrap();
    fs::write(transcripts.join("lone.jsonl"), "{\"role\":\"user\",\"content\":\"Hi\"}\n").unwrap();
    let cursor = AdapterEngine::fixture_batches(&make_adapter("cursor-cli", "cursor-cli"), dir.path()).unwrap();

    let dir = tempdir().unwrap();
    fs::create_dir_all(dir.path().join("sessions")).unwrap();
    fs::write(
        dir.path().join("sessions").join("s1.json"),
        r#"{"sessionId":"s1","title":"T","dateCreated":"2026-10-12T08:00:00Z","history":[{"message":{"role":"user","content":"Hi"}}]}"#,
    )
    .unwrap();
    let continued = AdapterEngine::fixture_batches(&make_adapter("continue", "continue"), dir.path()).unwrap();

    let sessions: Vec<_> = cursor.iter().chain(&continued).flat_map(|b| &b.sessions).collect();
    assert_eq!(sessions.len(), 3, "{sessions:?}");
    for s in sessions {
        let s = &s.session;
        assert_eq!((s.agent_id.as_str(), s.ended_at, s.completion.is_none(), s.status.as_str()), (s.agent_id.as_str(), None, true, "unknown"));
    }
}
