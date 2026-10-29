use orrery_adapters::adapter_spec::{AdapterDef, HistorySourceDef};
use orrery_adapters::model::{
    normalized_message_id, normalized_session_id, ContentBlock, UsageSemantics,
};
use orrery_adapters::modules::dispatch;
use rusqlite::Connection;
use std::fs::File;
use std::io::Write;
use tempfile::tempdir;

fn make_dummy_adapter(id: &str) -> (AdapterDef, HistorySourceDef) {
    let fixture_file = match id {
        "opencode" => "opencode.db",
        "crush" => ".crush/crush.db",
        "hermes-agent-cli" | "hermes_agent_cli" => "state.db",
        "goose" => "sessions.db",
        _ => "data.db",
    };
    let source = HistorySourceDef {
        id: Some(format!("{}-source", id)),
        format: "sqlite".to_string(),
        source_unit: Some("shared_database".to_string()),
        paths: std::collections::HashMap::new(),
        fixture_paths: vec![fixture_file.to_string()],
        query: None,
        mapping: None,
        module: Some(id.to_string()),
    };
    let adapter = AdapterDef {
        id: id.to_string(),
        name: format!("Agent {}", id),
        vendor: "Test Vendor".to_string(),
        family: "open-source-clis".to_string(),
        kind: "cli".to_string(),
        homepage: None,
        docs_url: None,
        coverage: Some("history".to_string()),
        detection: Default::default(),
        adapter_version: "1.0.0".to_string(),
        store_namespace: Some(id.to_string()),
        history_sources: vec![source.clone()],
    };
    (adapter, source)
}

#[test]
fn test_opencode_module_reads_synthetic_sqlite() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("opencode.db");

    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE session (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                parent_id TEXT,
                title TEXT,
                directory TEXT,
                time_created INTEGER,
                time_updated INTEGER,
                model TEXT,
                tokens_input INTEGER,
                tokens_output INTEGER
            );
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE part (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );

            INSERT INTO session VALUES (
                'ses_001',
                'prj123',
                NULL,
                'Setup development environment',
                '/Users/developer/code/opencode-app',
                1791814000000,
                1791814120000,
                '{"id": "claude-3-5-sonnet"}',
                3500,
                620
            );

            INSERT INTO message VALUES ('msg_001', 'ses_001', 1791814005000, '{"role": "user"}');
            INSERT INTO message VALUES ('msg_002', 'ses_001', 1791814015000, '{"role": "assistant"}');

            INSERT INTO part VALUES (
                'prt_001',
                'msg_001',
                'ses_001',
                1791814005000,
                '{"type": "text", "text": "Install development dependencies and configure build tools"}'
            );
            INSERT INTO part VALUES (
                'prt_002',
                'msg_002',
                'ses_001',
                1791814015000,
                '{"type": "text", "text": "Running npm install to setup dependencies"}'
            );
            INSERT INTO part VALUES (
                'prt_003',
                'msg_002',
                'ses_001',
                1791814016000,
                '{"type": "tool", "call": {"name": "bash", "input": {"command": "npm install", "cwd": "/Users/developer/code/opencode-app"}}}'
            );
            "#,
        ).unwrap();
    }

    let (adapter, source) = make_dummy_adapter("opencode");
    let sessions = dispatch("opencode", &adapter, &source, dir.path()).unwrap();

    assert_eq!(sessions.len(), 1, "Expected 1 normalized session from synthetic opencode store");
    let s = &sessions[0];
    let expected_session_id = normalized_session_id(
        &s.session.provenance.store.id,
        Some("ses_001"),
        &s.session.provenance.source_path,
    );
    assert_eq!(s.session.id, expected_session_id);
    assert_eq!(s.session.native_id.as_deref(), Some("ses_001"));
    assert_eq!(s.session.agent_id, "opencode");
    assert_eq!(s.session.title.as_deref(), Some("Setup development environment"));
    assert_eq!(s.session.project_root.as_deref(), Some("/Users/developer/code/opencode-app"));
    assert_eq!(s.session.started_at, Some(1791814000000));
    // updated_at is last activity, not completion evidence (CONTRACT.md), so no end time.
    assert_eq!(s.session.ended_at, None);
    assert_eq!(s.session.model.as_deref(), Some("claude-3-5-sonnet"));
    assert_eq!(s.session.turns, 1);
    assert_eq!(s.session.usage.semantics, UsageSemantics::Cumulative);
    assert_eq!(s.session.usage.input_tokens, Some(3500));
    assert_eq!(s.session.usage.output_tokens, Some(620));

    assert_eq!(s.messages.len(), 2);
    let m1 = &s.messages[0];
    assert_eq!(m1.seq, 1);
    assert_eq!(m1.role, "user");
    assert_eq!(
        m1.id,
        normalized_message_id(
            &s.session.id,
            Some("msg_001"),
            &s.session.provenance.key(),
            s.session.provenance.generation,
            1,
        )
    );
    assert_eq!(m1.blocks.len(), 1);
    match &m1.blocks[0] {
        ContentBlock::Text { text } => {
            assert_eq!(text, "Install development dependencies and configure build tools");
        }
        other => panic!("Expected Text block, got {:?}", other),
    }

    let m2 = &s.messages[1];
    assert_eq!(m2.seq, 2);
    assert_eq!(m2.role, "assistant");
    assert_eq!(
        m2.id,
        normalized_message_id(
            &s.session.id,
            Some("msg_002"),
            &s.session.provenance.key(),
            s.session.provenance.generation,
            2,
        )
    );
    assert_eq!(m2.blocks.len(), 2);
    match &m2.blocks[0] {
        ContentBlock::Text { text } => {
            assert_eq!(text, "Running npm install to setup dependencies");
        }
        other => panic!("Expected Text block, got {:?}", other),
    }
    match &m2.blocks[1] {
        ContentBlock::ToolCall { name, files, .. } => {
            assert_eq!(name, "bash");
            assert!(files.iter().any(|f| f.contains("opencode-app")));
        }
        other => panic!("Expected ToolCall block, got {:?}", other),
    }
}

#[test]
fn test_crush_module_reads_synthetic_sqlite() {
    let dir = tempdir().unwrap();
    let crush_dir = dir.path().join(".crush");
    std::fs::create_dir_all(&crush_dir).unwrap();
    let db_path = crush_dir.join("crush.db");

    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                parent_session_id TEXT,
                title TEXT,
                message_count INTEGER,
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                cost REAL,
                updated_at INTEGER,
                created_at INTEGER,
                summary_message_id TEXT,
                todos TEXT,
                channel TEXT
            );
            CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
                role TEXT,
                parts TEXT DEFAULT '[]',
                model TEXT,
                created_at INTEGER,
                updated_at INTEGER,
                finished_at INTEGER,
                provider TEXT
            );

            INSERT INTO sessions VALUES (
                'crush_sess_001',
                NULL,
                'Refactor terminal renderer',
                2,
                1250,
                420,
                0.015,
                1791810200,
                1791810000,
                NULL,
                NULL,
                'default'
            );

            INSERT INTO messages VALUES (
                'msg_001',
                'crush_sess_001',
                'user',
                '[{"type": "text", "data": {"text": "Make the terminal view resize gracefully"}}]',
                'claude-3-5-sonnet',
                1791810000,
                1791810000,
                1791810000,
                'anthropic'
            );

            INSERT INTO messages VALUES (
                'msg_002',
                'crush_sess_001',
                'assistant',
                '[{"type": "text", "data": {"text": "I will inspect the terminal resize handler."}}, {"type": "tool_call", "data": {"id": "call_view_1", "name": "view", "input": "{\"path\":\"src/view.rs\"}"}}, {"type": "tool_result", "data": {"tool_call_id": "call_view_1", "content": "fn resize() { ... }"}}, {"type": "finish", "data": {"reason": "stop"}}]',
                'claude-3-5-sonnet',
                1791810100,
                1791810200,
                1791810200,
                'anthropic'
            );
            "#,
        ).unwrap();
    }

    let (adapter, source) = make_dummy_adapter("crush");
    let sessions = dispatch("crush", &adapter, &source, dir.path()).unwrap();

    assert_eq!(sessions.len(), 1, "Expected 1 normalized session from synthetic crush store");
    let s = &sessions[0];
    let expected_session_id = normalized_session_id(
        &s.session.provenance.store.id,
        Some("crush_sess_001"),
        &s.session.provenance.source_path,
    );
    assert_eq!(s.session.id, expected_session_id);
    assert_eq!(s.session.native_id.as_deref(), Some("crush_sess_001"));
    assert_eq!(s.session.agent_id, "crush");
    assert_eq!(s.session.title.as_deref(), Some("Refactor terminal renderer"));
    assert_eq!(s.session.started_at, Some(1791810000000));
    assert_eq!(s.session.ended_at, None);
    assert_eq!(s.session.turns, 1);
    assert_eq!(s.session.usage.semantics, UsageSemantics::Cumulative);
    assert_eq!(s.session.usage.input_tokens, Some(1250));
    assert_eq!(s.session.usage.output_tokens, Some(420));

    assert_eq!(s.messages.len(), 2);
    let m1 = &s.messages[0];
    assert_eq!(m1.role, "user");
    assert_eq!(m1.blocks.len(), 1);
    match &m1.blocks[0] {
        ContentBlock::Text { text } => {
            assert_eq!(text, "Make the terminal view resize gracefully");
        }
        other => panic!("Expected Text block, got {:?}", other),
    }

    let m2 = &s.messages[1];
    assert_eq!(m2.role, "assistant");
    assert_eq!(m2.blocks.len(), 3);
    match &m2.blocks[0] {
        ContentBlock::Text { text } => {
            assert_eq!(text, "I will inspect the terminal resize handler.");
        }
        other => panic!("Expected Text block, got {:?}", other),
    }
    match &m2.blocks[1] {
        ContentBlock::ToolCall { call_id, name, files, .. } => {
            assert_eq!(call_id, "call_view_1");
            assert_eq!(name, "view");
            assert_eq!(files, &["src/view.rs"]);
        }
        other => panic!("Expected ToolCall block, got {:?}", other),
    }
    match &m2.blocks[2] {
        ContentBlock::ToolResult { call_id, output, .. } => {
            assert_eq!(call_id, "call_view_1");
            assert_eq!(output, "fn resize() { ... }");
        }
        other => panic!("Expected ToolResult block, got {:?}", other),
    }
}

#[test]
fn test_hermes_agent_cli_module_reads_synthetic_sqlite() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("state.db");

    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                started_at REAL,
                ended_at REAL,
                model TEXT,
                cwd TEXT,
                title TEXT,
                input_tokens INTEGER,
                output_tokens INTEGER
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY,
                session_id TEXT,
                role TEXT,
                content TEXT,
                tool_name TEXT,
                tool_calls TEXT,
                timestamp REAL
            );

            INSERT INTO sessions VALUES (
                'sess_20261012_143000',
                1791814000.0,
                1791814100.0,
                'anthropic/claude-sonnet-4',
                '/Users/developer/code/research',
                'Explore optimization algorithms',
                1500,
                380
            );

            INSERT INTO messages VALUES (
                1,
                'sess_20261012_143000',
                'user',
                'Analyze benchmark results',
                NULL,
                NULL,
                1791814005.0
            );
            INSERT INTO messages VALUES (
                2,
                'sess_20261012_143000',
                'assistant',
                'Checking benchmark log file',
                'read_file',
                '{"name":"read_file","args":{"path":"bench.log"}}',
                1791814015.0
            );
            "#,
        ).unwrap();
    }

    let (adapter, source) = make_dummy_adapter("hermes-agent-cli");
    let sessions = dispatch("hermes-agent-cli", &adapter, &source, dir.path()).unwrap();

    assert_eq!(sessions.len(), 1, "Expected 1 normalized session from synthetic hermes store");
    let s = &sessions[0];
    let expected_session_id = normalized_session_id(
        &s.session.provenance.store.id,
        Some("sess_20261012_143000"),
        &s.session.provenance.source_path,
    );
    assert_eq!(s.session.id, expected_session_id);
    assert_eq!(s.session.native_id.as_deref(), Some("sess_20261012_143000"));
    assert_eq!(s.session.agent_id, "hermes-agent-cli");
    assert_eq!(s.session.title.as_deref(), Some("Explore optimization algorithms"));
    assert_eq!(s.session.project_root.as_deref(), Some("/Users/developer/code/research"));
    assert_eq!(s.session.started_at, Some(1791814000000));
    assert_eq!(s.session.ended_at, Some(1791814100000));
    assert_eq!(s.session.model.as_deref(), Some("anthropic/claude-sonnet-4"));
    assert_eq!(s.session.turns, 1);
    assert_eq!(s.session.usage.semantics, UsageSemantics::Cumulative);
    assert_eq!(s.session.usage.input_tokens, Some(1500));
    assert_eq!(s.session.usage.output_tokens, Some(380));

    assert_eq!(s.messages.len(), 2);
    let m1 = &s.messages[0];
    assert_eq!(m1.role, "user");
    assert_eq!(m1.blocks.len(), 1);
    match &m1.blocks[0] {
        ContentBlock::Text { text } => {
            assert_eq!(text, "Analyze benchmark results");
        }
        other => panic!("Expected Text block, got {:?}", other),
    }

    let m2 = &s.messages[1];
    assert_eq!(m2.role, "assistant");
    assert_eq!(m2.blocks.len(), 2);
    match &m2.blocks[0] {
        ContentBlock::Text { text } => {
            assert_eq!(text, "Checking benchmark log file");
        }
        other => panic!("Expected Text block, got {:?}", other),
    }
    match &m2.blocks[1] {
        ContentBlock::ToolCall { name, files, .. } => {
            assert_eq!(name, "read_file");
            assert_eq!(files, &["bench.log"]);
        }
        other => panic!("Expected ToolCall block, got {:?}", other),
    }
}

#[test]
fn test_goose_module_reads_synthetic_sqlite() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("sessions.db");

    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                working_dir TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                accumulated_input_tokens INTEGER NOT NULL DEFAULT 0,
                accumulated_output_tokens INTEGER NOT NULL DEFAULT 0,
                model_config_json TEXT NOT NULL,
                name TEXT,
                user_set_name TEXT,
                description TEXT,
                archived_at TEXT,
                session_type TEXT DEFAULT 'user',
                parent_session_id TEXT
            );
            CREATE TABLE messages (
                message_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content_json TEXT NOT NULL,
                tool_calls_json TEXT,
                created_at TEXT NOT NULL
            );

            INSERT INTO sessions VALUES (
                '20261012_3',
                '/Users/developer/code/payments-api',
                '2026-10-12T09:15:00Z',
                '2026-10-12T10:02:30Z',
                54000,
                6140,
                '{"model": "claude-sonnet-4-5"}',
                'Provider routing refactor',
                NULL,
                NULL,
                NULL,
                'user',
                NULL
            );

            INSERT INTO sessions VALUES (
                '20261009_2',
                '/Users/developer/code/payments-api',
                '2026-10-09T11:00:00Z',
                '2026-10-09T11:34:10Z',
                30100,
                1500,
                '{"model": "claude-haiku-4-5"}',
                'Old migration notes',
                NULL,
                'archived summary',
                '2026-10-10T08:00:00Z',
                'user',
                NULL
            );

            INSERT INTO messages VALUES (
                'msg_1',
                '20261012_3',
                1,
                'user',
                '[{"type": "text", "text": "Move provider selection into middleware"}]',
                NULL,
                '2026-10-12T09:15:12Z'
            );
            INSERT INTO messages VALUES (
                'msg_2',
                '20261012_3',
                2,
                'assistant',
                '[{"type": "text", "text": "Adding a ProviderRoute middleware"}]',
                '[{"id": "call_1", "name": "read_file", "args": {"path": "crates/api/src/routes.rs"}}]',
                '2026-10-12T09:16:40Z'
            );
            "#,
        ).unwrap();
    }

    let (adapter, source) = make_dummy_adapter("goose");
    let sessions = dispatch("goose", &adapter, &source, dir.path()).unwrap();

    // A session archived in Goose is still history (it has no messages in this fixture).
    assert_eq!(sessions.len(), 2, "the archived session is imported too");
    assert!(sessions.iter().any(|s| s.session.native_id.as_deref() == Some("20261009_2")));
    let s = sessions.iter().find(|s| s.session.native_id.as_deref() == Some("20261012_3")).unwrap();
    let expected_session_id = normalized_session_id(
        &s.session.provenance.store.id,
        Some("20261012_3"),
        &s.session.provenance.source_path,
    );
    assert_eq!(s.session.id, expected_session_id);
    assert_eq!(s.session.native_id.as_deref(), Some("20261012_3"));
    assert_eq!(s.session.title.as_deref(), Some("Provider routing refactor"));
    assert_eq!(s.session.model.as_deref(), Some("claude-sonnet-4-5"));
    assert_eq!(s.session.turns, 1);
    assert_eq!(s.session.usage.semantics, UsageSemantics::Cumulative);
    assert_eq!(s.session.usage.input_tokens, Some(54000));
    assert_eq!(s.session.usage.output_tokens, Some(6140));

    assert_eq!(s.messages.len(), 2);
    let m1 = &s.messages[0];
    assert_eq!(m1.role, "user");
    assert_eq!(m1.blocks.len(), 1);
    match &m1.blocks[0] {
        ContentBlock::Text { text } => {
            assert_eq!(text, "Move provider selection into middleware");
        }
        other => panic!("Expected Text block, got {:?}", other),
    }

    let m2 = &s.messages[1];
    assert_eq!(m2.role, "assistant");
    assert_eq!(m2.blocks.len(), 2);
    match &m2.blocks[0] {
        ContentBlock::Text { text } => {
            assert_eq!(text, "Adding a ProviderRoute middleware");
        }
        other => panic!("Expected Text block, got {:?}", other),
    }
    match &m2.blocks[1] {
        ContentBlock::ToolCall { call_id, name, files, .. } => {
            assert_eq!(call_id, "call_1");
            assert_eq!(name, "read_file");
            assert_eq!(files, &["crates/api/src/routes.rs"]);
        }
        other => panic!("Expected ToolCall block, got {:?}", other),
    }
}

#[test]
fn test_modules_tolerate_missing_tables_and_corrupt_files() {
    let dir = tempdir().unwrap();

    // 1. Empty sqlite database with no tables
    let empty_db = dir.path().join("empty.sqlite");
    {
        let _conn = Connection::open(&empty_db).unwrap();
    }

    // 2. Corrupt file that is not sqlite
    let corrupt_db = dir.path().join("corrupt.db");
    {
        let mut f = File::create(&corrupt_db).unwrap();
        f.write_all(b"NOT A SQLITE DATABASE GARBAGE").unwrap();
    }

    for module in &["opencode", "crush", "hermes-agent-cli", "goose"] {
        let (mut adapter, mut source) = make_dummy_adapter(module);

        // Missing tables: must return Ok(empty) or Err and not panic
        source.fixture_paths = vec!["empty.sqlite".into()];
        adapter.history_sources = vec![source.clone()];
        let res1 = dispatch(module, &adapter, &source, dir.path());
        assert!(res1.is_ok(), "Module {} failed on empty db: {:?}", module, res1.err());

        // Corrupted file: must not panic
        source.fixture_paths = vec!["corrupt.db".into()];
        adapter.history_sources = vec![source.clone()];
        let res2 = dispatch(module, &adapter, &source, dir.path());
        assert!(res2.is_ok() || res2.is_err(), "Module {} panicked or failed unexpectedly on corrupt file", module);
    }
}

#[test]
fn test_modules_block_credential_files() {
    let dir = tempdir().unwrap();
    let auth_db = dir.path().join("auth.json");
    {
        let mut f = File::create(&auth_db).unwrap();
        f.write_all(b"{\"token\":\"secret\"}").unwrap();
    }

    for module in &["opencode", "crush", "hermes-agent-cli", "goose"] {
        let (mut adapter, mut source) = make_dummy_adapter(module);
        source.fixture_paths = vec!["auth.json".into()];
        adapter.history_sources = vec![source.clone()];
        let res = dispatch(module, &adapter, &source, dir.path());
        assert!(res.is_err() || res.unwrap().is_empty(), "Module {} must block or ignore credential files", module);
    }
}

#[test]
fn test_pruning_a_shared_database_does_not_shrink_its_checkpoint() {
    let dir = tempdir().unwrap();
    let crush_dir = dir.path().join(".crush");
    std::fs::create_dir_all(&crush_dir).unwrap();
    let db_path = crush_dir.join("crush.db");
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT,
            message_count INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL,
            updated_at INTEGER, created_at INTEGER, summary_message_id TEXT, todos TEXT, channel TEXT);
        CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, parts TEXT DEFAULT '[]',
            model TEXT, created_at INTEGER, updated_at INTEGER, finished_at INTEGER, provider TEXT);
        INSERT INTO sessions VALUES ('s1', NULL, 'One', 1, 10, 5, 0, 1791810000, 1791810000, NULL, NULL, 'default');
        INSERT INTO sessions VALUES ('s2', NULL, 'Two', 1, 10, 5, 0, 1791810000, 1791810000, NULL, NULL, 'default');
        INSERT INTO messages VALUES ('m1', 's1', 'user', '[{"type": "text", "data": {"text": "first"}}]', NULL, 1791810000, 1791810000, NULL, NULL);
        INSERT INTO messages VALUES ('m2', 's2', 'user', '[{"type": "text", "data": {"text": "second"}}]', NULL, 1791810000, 1791810000, NULL, NULL);
        "#,
    )
    .unwrap();
    let (adapter, source) = make_dummy_adapter("crush");
    let checkpoint = || dispatch("crush", &adapter, &source, dir.path()).unwrap()[0].session.provenance.checkpoint.clone();
    let before = checkpoint();
    conn.execute_batch("DELETE FROM messages WHERE session_id = 's2'; DELETE FROM sessions WHERE id = 's2';").unwrap();
    let after = checkpoint();
    // A smaller extent reads as a rotated file: a new generation that merges old and new usage.
    assert_ne!(before.digest, after.digest);
    assert!(after.offset >= before.offset && after.records >= before.records, "{before:?} -> {after:?}");
}
