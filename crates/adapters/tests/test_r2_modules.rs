use orrery_adapters::builtins::get_builtin_adapter;
use orrery_adapters::engine::AdapterEngine;
use orrery_adapters::model::{
    normalized_session_id, ContentBlock, Message, NormalizedSession,
};
use rusqlite::Connection;
use std::fs::{self, File};
use std::io::Write;
use tempfile::tempdir;

fn message_text(msg: &Message) -> String {
    msg.blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn collect_tool_calls(sess: &NormalizedSession) -> Vec<(String, Vec<String>)> {
    sess.messages
        .iter()
        .flat_map(|m| &m.blocks)
        .filter_map(|b| match b {
            ContentBlock::ToolCall { name, files, .. } => Some((name.clone(), files.clone())),
            _ => None,
        })
        .collect()
}

#[test]
fn test_r2_aider_synthetic_store() {
    let adapter = get_builtin_adapter("aider").expect("aider builtin must exist");
    let dir = tempdir().unwrap();
    let repo_dir = dir.path().join("my-repo");
    fs::create_dir_all(&repo_dir).unwrap();

    // Real aider history format: "#### " is the user, "> " is tool output, the rest is the reply,
    // and a SEARCH/REPLACE block names its file on the line before the fence.
    let history_content = r#"# aider chat started at 2026-10-12 10:00:00

> Aider v0.86.2
> Main model: gpt-5.1 with diff edit format

#### Add error handling to load_config

I will wrap the file read in a Result and return a custom error.

src/main.rs
```rust
<<<<<<< SEARCH
fn load_config() -> Config {
=======
fn load_config() -> Result<Config, ConfigError> {
>>>>>>> REPLACE
```

> Applied edit to src/main.rs

#### /run cargo test

> Added 1 line of output to the chat.

# aider chat started at 2026-10-12 11:30:00

#### /model claude-3-7-sonnet

#### Document the public functions in lib.rs

Here are the doc comments for lib.rs.

> Tokens: 5.2k sent, 410 received.
"#;

    let chat_file = repo_dir.join(".aider.chat.history.md");
    File::create(&chat_file)
        .unwrap()
        .write_all(history_content.as_bytes())
        .unwrap();

    let sessions = AdapterEngine::process_fixture_dir(&adapter, dir.path()).unwrap();
    assert_eq!(sessions.len(), 2, "Aider should extract two sessions from markdown");

    // Session 1
    let sess1 = sessions
        .iter()
        .find(|s| s.session.started_at == Some(1791799200000))
        .expect("Session 1 should exist");
    assert_eq!(sess1.session.agent_id, "aider");
    assert_eq!(sess1.session.status, "unknown", "aider history has no end marker");
    assert_eq!(
        sess1.session.id,
        normalized_session_id(
            &sess1.session.provenance.store.id,
            sess1.session.native_id.as_deref(),
            &sess1.session.provenance.source_path
        )
    );
    assert_eq!(sess1.session.model.as_deref(), Some("gpt-5.1"));
    let roles: Vec<&str> = sess1.messages.iter().map(|m| m.role.as_str()).collect();
    assert_eq!(roles, ["system", "user", "assistant", "system", "user", "system"]);
    assert!(message_text(&sess1.messages[1]).contains("Add error handling to load_config"));
    assert!(message_text(&sess1.messages[2]).contains("Result"));

    let tools = collect_tool_calls(sess1);
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0].0, "edit_file");
    assert_eq!(tools[0].1, vec!["src/main.rs"]);
    assert_eq!(tools[1].0, "run_command");

    // Session 2
    let sess2 = sessions
        .iter()
        .find(|s| s.session.started_at == Some(1791804600000))
        .expect("Session 2 should exist");
    assert_eq!(sess2.session.model.as_deref(), Some("claude-3-7-sonnet"));
    assert_eq!(sess2.session.usage.input_tokens, Some(5200));
    assert_eq!(sess2.session.usage.output_tokens, Some(410));
}

#[test]
fn test_r2_amp_synthetic_store() {
    let adapter = get_builtin_adapter("amp").expect("amp builtin must exist");
    let dir = tempdir().unwrap();
    let threads_dir = dir.path().join("threads");
    fs::create_dir_all(&threads_dir).unwrap();

    let thread_json = r#"{
  "id": "T-11223344-5566-7788-99aa-bbccddeeff00",
  "created": 1791800000000,
  "title": "Fix memory leak in buffer pool",
  "messages": [
    {
      "role": "user",
      "messageId": 0,
      "content": "Investigate the memory leak in buffer_pool.rs"
    },
    {
      "role": "assistant",
      "messageId": 1,
      "model": "claude-sonnet-4-5",
      "content": [
        {
          "type": "text",
          "text": "The ring buffer was not freeing dropped chunks. Fixed in buffer_pool.rs."
        }
      ],
      "usage": {
        "inputTokens": 4500,
        "outputTokens": 320
      }
    }
  ],
  "usageLedger": {
    "events": [
      {
        "model": "claude-sonnet-4-5",
        "timestamp": "2026-10-12T10:14:00.000Z",
        "toMessageId": 1,
        "tokens": {
          "input": 4500,
          "output": 320
        }
      }
    ]
  }
}"#;

    let thread_file = threads_dir.join("T-11223344-5566-7788-99aa-bbccddeeff00.json");
    File::create(&thread_file)
        .unwrap()
        .write_all(thread_json.as_bytes())
        .unwrap();

    // Add a secrets.json file to verify it is NEVER read
    let secrets_file = dir.path().join("secrets.json");
    File::create(&secrets_file)
        .unwrap()
        .write_all(b"{\"api_key\": \"super-secret-token\"}")
        .unwrap();

    let sessions = AdapterEngine::process_fixture_dir(&adapter, dir.path()).unwrap();
    assert_eq!(sessions.len(), 1);

    let sess = &sessions[0];
    assert_eq!(
        sess.session.id,
        normalized_session_id(
            &sess.session.provenance.store.id,
            Some("T-11223344-5566-7788-99aa-bbccddeeff00"),
            &sess.session.provenance.source_path
        )
    );
    assert_eq!(sess.session.title.as_deref(), Some("Fix memory leak in buffer pool"));
    assert_eq!(sess.session.started_at, Some(1791800000000));
    assert_eq!(sess.session.model.as_deref(), Some("claude-sonnet-4-5"));
    assert_eq!(sess.session.usage.input_tokens, Some(4500));
    assert_eq!(sess.session.usage.output_tokens, Some(320));
    assert_eq!(sess.messages.len(), 2);
    assert_eq!(sess.messages[0].role, "user");
    assert_eq!(
        message_text(&sess.messages[0]),
        "Investigate the memory leak in buffer_pool.rs"
    );
    assert_eq!(sess.messages[1].role, "assistant");
}

#[test]
fn test_r2_kimi_synthetic_store() {
    let adapter = get_builtin_adapter("kimi-code-cli").expect("kimi-code-cli builtin must exist");
    let dir = tempdir().unwrap();
    let sess_dir = dir
        .path()
        .join("sessions/wd_test_12345/ses_abcdef12-3456-7890-abcd-ef1234567890");
    let agents_dir = sess_dir.join("agents/main");
    fs::create_dir_all(&agents_dir).unwrap();

    let state_json = r#"{
  "id": "ses_abcdef12-3456-7890-abcd-ef1234567890",
  "workDir": "/home/user/project",
  "title": "Add caching layer",
  "createdAt": "2026-10-12T08:00:00.000Z",
  "updatedAt": "2026-10-12T08:30:00.000Z",
  "agentStates": {
    "main": {
      "model": "kimi-k2"
    }
  }
}"#;
    File::create(sess_dir.join("state.json"))
        .unwrap()
        .write_all(state_json.as_bytes())
        .unwrap();

    let wire_jsonl = r#"{"type":"metadata","protocol_version":"1.5"}
{"type":"turn.begin","turn_index":0}
{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"Implement Redis cache"}]}}
{"type":"tool.begin","call_id":"c1","name":"ReadFile","args":{"file":"cache.py"}}
{"type":"tool.end","call_id":"c1","isError":false,"content":"def get(): pass"}
{"type":"context.append_message","message":{"role":"assistant","content":[{"type":"text","text":"Redis cache implemented"}],"usage":{"input_tokens":1200,"output_tokens":150}}}
{"type":"turn.end","turn_index":0}
"#;
    File::create(agents_dir.join("wire.jsonl"))
        .unwrap()
        .write_all(wire_jsonl.as_bytes())
        .unwrap();

    // Add credentials folder that must NEVER be read
    let creds_dir = dir.path().join("credentials");
    fs::create_dir_all(&creds_dir).unwrap();
    File::create(creds_dir.join("oauth.json"))
        .unwrap()
        .write_all(b"{\"token\":\"secret\"}")
        .unwrap();

    let sessions = AdapterEngine::process_fixture_dir(&adapter, dir.path()).unwrap();
    assert_eq!(sessions.len(), 1);

    let sess = &sessions[0];
    assert_eq!(
        sess.session.id,
        normalized_session_id(
            &sess.session.provenance.store.id,
            Some("ses_abcdef12-3456-7890-abcd-ef1234567890"),
            &sess.session.provenance.source_path
        )
    );
    assert_eq!(sess.session.project_root.as_deref(), Some("/home/user/project"));
    assert_eq!(sess.session.title.as_deref(), Some("Add caching layer"));
    assert_eq!(sess.session.started_at, Some(1791792000000));
    assert_eq!(sess.session.ended_at, Some(1791793800000));
    assert_eq!(sess.session.model.as_deref(), Some("kimi-k2"));
    assert_eq!(sess.session.usage.input_tokens, Some(1200));
    assert_eq!(sess.session.usage.output_tokens, Some(150));
    assert_eq!(sess.messages.len(), 2);

    let tools = collect_tool_calls(sess);
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].0, "ReadFile");
}

#[test]
fn test_r2_antigravity_synthetic_store() {
    let adapter = get_builtin_adapter("antigravity-cli").expect("antigravity-cli builtin must exist");
    let dir = tempdir().unwrap();
    let uuid = "99887766-5544-3322-1100-aabbccddeeff";

    // 1. history.jsonl
    let history_jsonl = format!(
        r#"{{"conversationId":"{}","workspace":"/Users/test/workspace","display":"Refactor parser","timestamp":"2026-10-12T12:00:00Z"}}
"#,
        uuid
    );
    File::create(dir.path().join("history.jsonl"))
        .unwrap()
        .write_all(history_jsonl.as_bytes())
        .unwrap();

    // 2. brain transcript.jsonl
    let log_dir = dir
        .path()
        .join(format!("brain/{}/.system_generated/logs", uuid));
    fs::create_dir_all(&log_dir).unwrap();

    let transcript = r#"{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-10-12T12:00:00Z","content":"Refactor the parser module"}
{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-10-12T12:00:08Z","thinking":"I will inspect parser.rs first.","tool_calls":[{"name":"view_file","args":{"AbsolutePath":"/Users/test/workspace/parser.rs"}}]}
"#;
    File::create(log_dir.join("transcript.jsonl"))
        .unwrap()
        .write_all(transcript.as_bytes())
        .unwrap();

    // 3. SQLite conversations/<uuid>.db
    let conv_dir = dir.path().join("conversations");
    fs::create_dir_all(&conv_dir).unwrap();
    let db_path = conv_dir.join(format!("{}.db", uuid));

    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE trajectory_meta (cascade_id TEXT PRIMARY KEY, model TEXT);
             INSERT INTO trajectory_meta (cascade_id, model) VALUES ('test-id', 'gemini-3.8-flash');
             CREATE TABLE gen_metadata (prompt_tokens INTEGER, output_tokens INTEGER);
             INSERT INTO gen_metadata (prompt_tokens, output_tokens) VALUES (1500, 350);",
        )
        .unwrap();
    }

    let sessions = AdapterEngine::process_fixture_dir(&adapter, dir.path()).unwrap();
    assert_eq!(sessions.len(), 1);

    let sess = &sessions[0];
    assert_eq!(
        sess.session.id,
        normalized_session_id(
            &sess.session.provenance.store.id,
            Some(uuid),
            &sess.session.provenance.source_path
        )
    );
    assert_eq!(sess.session.project_root.as_deref(), Some("/Users/test/workspace"));
    assert_eq!(sess.session.title.as_deref(), Some("Refactor parser"));
    assert_eq!(sess.session.started_at, Some(1791806400000));
    assert_eq!(sess.session.ended_at, Some(1791806408000));
    assert_eq!(sess.session.model.as_deref(), Some("gemini-3.8-flash"));
    assert_eq!(sess.session.usage.input_tokens, Some(1500));
    assert_eq!(sess.session.usage.output_tokens, Some(350));
    assert_eq!(sess.messages.len(), 2);

    let tools = collect_tool_calls(sess);
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].0, "view_file");
}

#[test]
fn test_r2_modules_malformed_input_never_panics() {
    let dir = tempdir().unwrap();

    // Write corrupted and truncated files
    let bad_md = dir.path().join(".aider.chat.history.md");
    File::create(&bad_md)
        .unwrap()
        .write_all(b"# aider chat started at invalid-date\n> unclosed\n\xFF\xFE\x00")
        .unwrap();

    let bad_json = dir.path().join("T-corrupt.json");
    File::create(&bad_json)
        .unwrap()
        .write_all(b"{\"id\": 123, \"messages\": null, \"usageLedger\": true")
        .unwrap();

    for adapter_id in &["aider", "amp", "kimi-code-cli", "antigravity-cli"] {
        let adapter = get_builtin_adapter(adapter_id).unwrap();
        let result = AdapterEngine::fixture_batches(&adapter, dir.path());
        assert!(result.is_ok(), "Module {} must never panic on malformed input", adapter_id);
        // Aider and Amp report a bad file as a Failed batch with a diagnostic (RV-ADP), never as a
        // Complete batch that quietly lacks the file.
        if *adapter_id == "aider" || *adapter_id == "amp" {
            let batches = result.unwrap();
            assert_eq!(batches.len(), 1, "{adapter_id}: the one malformed file is reported");
            assert_eq!(batches[0].read_status, orrery_adapters::model::ReadStatus::Failed);
            assert_eq!(batches[0].diagnostics.len(), 1);
        }
    }
}

#[test]
fn test_r2_antigravity_sqlite_readonly_and_schema_drift() {
    let adapter = get_builtin_adapter("antigravity-cli").unwrap();
    let dir = tempdir().unwrap();
    let uuid = "12345678-abcd-ef01-2345-6789abcdef01";

    let conv_dir = dir.path().join("conversations");
    fs::create_dir_all(&conv_dir).unwrap();
    let db_path = conv_dir.join(format!("{}.db", uuid));

    // Create table with extra unknown columns and missing trajectory_meta table (schema drift)
    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE unknown_future_table (id INTEGER, blob_data BLOB);
             INSERT INTO unknown_future_table VALUES (1, X'01020304');
             CREATE TABLE gen_metadata (prompt_tokens INTEGER, output_tokens INTEGER, extra_secret_column TEXT);
             INSERT INTO gen_metadata VALUES (9900, 880, 'should_never_leak');",
        )
        .unwrap();
    }

    // Write minimal transcript
    let log_dir = dir.path().join(format!("brain/{}/.system_generated/logs", uuid));
    fs::create_dir_all(&log_dir).unwrap();
    let transcript = r#"{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-10-12T15:00:00Z","content":"<USER_REQUEST>Optimize query</USER_REQUEST>"}
{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-10-12T15:00:10Z","content":"Added index on user_id"}
"#;
    File::create(log_dir.join("transcript.jsonl"))
        .unwrap()
        .write_all(transcript.as_bytes())
        .unwrap();

    let sessions = AdapterEngine::process_fixture_dir(&adapter, dir.path()).unwrap();
    assert_eq!(sessions.len(), 1);
    let s = &sessions[0];
    assert_eq!(s.session.usage.input_tokens, Some(9900));
    assert_eq!(s.session.usage.output_tokens, Some(880));
    assert_eq!(message_text(&s.messages[0]), "Optimize query");
    assert_eq!(message_text(&s.messages[1]), "Added index on user_id");

    // Verify SQLite open-mode is strictly read-only and immutable
    let uri = format!("file:{}?mode=ro&immutable=1", db_path.to_string_lossy());
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI;
    let ro_conn = Connection::open_with_flags(&uri, flags).unwrap();
    let write_res = ro_conn.execute("INSERT INTO gen_metadata VALUES (1, 1, 'fail')", []);
    assert!(write_res.is_err(), "Write operations must fail on read-only immutable SQLite connection");
}

#[test]
fn test_r2_amp_schema_drift_and_secret_rejection() {
    let adapter = get_builtin_adapter("amp").unwrap();
    let dir = tempdir().unwrap();
    let threads_dir = dir.path().join("threads");
    fs::create_dir_all(&threads_dir).unwrap();

    // Thread without usageLedger, with snake_case token usage
    let thread_json = r#"{
  "id": "T-drift-99887766",
  "created": 1791801000000,
  "messages": [
    {
      "role": "user",
      "content": "Analyze drift"
    },
    {
      "role": "assistant",
      "model": "gpt-5-turbo",
      "content": "No issues found",
      "usage": {
        "input_tokens": 1234,
        "output_tokens": 56
      }
    }
  ]
}"#;
    File::create(threads_dir.join("T-drift.json"))
        .unwrap()
        .write_all(thread_json.as_bytes())
        .unwrap();

    // Secret files that must be ignored
    File::create(threads_dir.join("secrets.json"))
        .unwrap()
        .write_all(b"{\"auth_token\": \"sk-ant-secret\"}")
        .unwrap();
    File::create(dir.path().join("auth.json"))
        .unwrap()
        .write_all(b"{\"bearer\": \"token\"}")
        .unwrap();

    let sessions = AdapterEngine::process_fixture_dir(&adapter, dir.path()).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session.model.as_deref(), Some("gpt-5-turbo"));
    assert_eq!(sessions[0].session.usage.input_tokens, Some(1234));
    assert_eq!(sessions[0].session.usage.output_tokens, Some(56));
    assert_eq!(sessions[0].messages.len(), 2);
    assert_eq!(message_text(&sessions[0].messages[0]), "Analyze drift");
    assert_eq!(message_text(&sessions[0].messages[1]), "No issues found");
}

#[test]
fn test_r2_kimi_schema_drift_unknown_records() {
    let adapter = get_builtin_adapter("kimi-code-cli").unwrap();
    let dir = tempdir().unwrap();
    let sess_dir = dir.path().join("sessions/wd_drift_1/ses_drift_9999");
    let agents_dir = sess_dir.join("agents/main");
    fs::create_dir_all(&agents_dir).unwrap();

    let state_json = r#"{
  "id": "ses_drift_9999",
  "workDir": "/var/app",
  "title": "Drift test"
}"#;
    File::create(sess_dir.join("state.json"))
        .unwrap()
        .write_all(state_json.as_bytes())
        .unwrap();

    // Wire containing many unknown event types from newer versions
    let wire_jsonl = r#"{"type":"unknown.future.event","version":"99.0","data":[1,2,3]}
{"type":"context.append_message","message":{"role":"user","content":"Run health check"}}
{"type":"plan.created","plan_id":"p1","steps":["check disk","check ram"]}
{"type":"subagent.spawn","agent":"diagnostics"}
{"type":"context.append_message","message":{"role":"assistant","content":[{"type":"text","text":"All systems healthy"}]}}
{"type":"subagent.terminate","agent":"diagnostics"}
"#;
    File::create(agents_dir.join("wire.jsonl"))
        .unwrap()
        .write_all(wire_jsonl.as_bytes())
        .unwrap();

    let sessions = AdapterEngine::process_fixture_dir(&adapter, dir.path()).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].messages.len(), 2);
    assert_eq!(message_text(&sessions[0].messages[0]), "Run health check");
    assert_eq!(message_text(&sessions[0].messages[1]), "All systems healthy");
}
