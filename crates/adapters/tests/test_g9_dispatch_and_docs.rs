use orrery_adapters::adapter_spec::{AdapterDef, HistorySourceDef};
use orrery_adapters::boundary::ReadBoundary;
use orrery_adapters::builtin_adapters;
use orrery_adapters::engine::SourceContext;
use orrery_adapters::model::{ReadStatus, StoreIdentity};
use orrery_adapters::modules::dispatch_module_batches;
use rusqlite::Connection;
use tempfile::tempdir;

fn is_valid_url(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://"))
        && !url.contains(' ')
        && !url.contains('\n')
        && !url.contains('\r')
        && url.contains('.')
        && !url.contains('\u{2014}') // em dash
        && !url.contains('\u{2013}') // en dash
}

#[test]
fn test_g9_unified_module_dispatch_recognizes_all_modules() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let context = SourceContext {
        store: StoreIdentity::new("test", "fixture://test", "synthetic"),
        approved_roots: vec![root.to_path_buf()],
        installation_id: None,
        generation: 1,
        revision: 1,
    };
    let boundary = ReadBoundary::new(&context.approved_roots).unwrap();

    let all_known_modules = [
        // R1 modules (previously per-file only, now unified)
        "opencode",
        "crush",
        "hermes-agent-cli",
        "goose",
        // R2 modules
        "aider",
        "amp",
        "kimi-code-cli",
        "antigravity-cli",
        // R3 modules
        "cline",
        "roo-code",
        "kilo-code",
        "continue",
        "cursor-cli",
    ];

    for module_name in all_known_modules {
        let adapter = AdapterDef {
            id: module_name.to_string(),
            name: format!("{module_name} Test"),
            vendor: "Vendor".to_string(),
            family: "test".to_string(),
            kind: "cli".to_string(),
            coverage: Some("history".to_string()),
            homepage: None,
            docs_url: None,
            detection: Default::default(),
            adapter_version: "1.0.0".to_string(),
            store_namespace: Some(module_name.to_string()),
            history_sources: vec![],
        };
        let source = HistorySourceDef {
            id: Some(format!("{module_name}-source")),
            format: "sqlite".to_string(),
            source_unit: None,
            paths: Default::default(),
            fixture_paths: vec![],
            query: None,
            mapping: None,
            module: Some(module_name.to_string()),
        };

        let res = dispatch_module_batches(module_name, &adapter, &source, &context, &boundary, root);
        if let Err(err) = &res {
            let msg = err.to_string();
            assert!(
                !msg.contains("unknown history module"),
                "module {module_name} must be recognized by unified dispatch_module_batches, but got: {msg}"
            );
        }
    }

    // Ensure unknown module is still rejected
    let dummy_adapter = AdapterDef {
        id: "unknown".to_string(),
        name: "Unknown".to_string(),
        vendor: "V".to_string(),
        family: "other".to_string(),
        kind: "cli".to_string(),
        coverage: None,
        homepage: None,
        docs_url: None,
        detection: Default::default(),
        adapter_version: "1.0.0".to_string(),
        store_namespace: None,
        history_sources: vec![],
    };
    let dummy_source = HistorySourceDef {
        id: None,
        format: "json".to_string(),
        source_unit: None,
        paths: Default::default(),
        fixture_paths: vec![],
        query: None,
        mapping: None,
        module: Some("nonexistent_module".to_string()),
    };
    let unknown_res = dispatch_module_batches(
        "nonexistent_module",
        &dummy_adapter,
        &dummy_source,
        &context,
        &boundary,
        root,
    );
    assert!(
        unknown_res.is_err(),
        "nonexistent module must return an error"
    );
}

#[test]
fn test_g9_unified_dispatch_r1_synthetic_opencode() {
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
                summary TEXT
            );
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                time_created INTEGER,
                data TEXT
            );
            CREATE TABLE part (
                id TEXT PRIMARY KEY,
                message_id TEXT,
                session_id TEXT,
                time_created INTEGER,
                data TEXT
            );
            INSERT INTO session VALUES (
                'ses_001',
                'proj_001',
                NULL,
                'Unified dispatch test',
                '/tmp/test',
                1791814000000,
                1791814120000,
                'Unified dispatch verification'
            );
            INSERT INTO message VALUES ('msg_001', 'ses_001', 1791814005000, '{"role": "user"}');
            INSERT INTO part VALUES ('prt_001', 'msg_001', 'ses_001', 1791814005000, '{"type": "text", "text": "hello from G9"}');
            "#,
        )
        .unwrap();
    }

    let adapter = AdapterDef {
        id: "opencode".to_string(),
        name: "OpenCode".to_string(),
        vendor: "Anomaly".to_string(),
        family: "open-source CLIs".to_string(),
        kind: "cli".to_string(),
        homepage: None,
        docs_url: None,
        coverage: Some("history".to_string()),
        detection: Default::default(),
        adapter_version: "1.0.0".to_string(),
        store_namespace: Some("opencode".to_string()),
        history_sources: vec![],
    };
    let source = HistorySourceDef {
        id: Some("opencode-sqlite".to_string()),
        format: "sqlite".to_string(),
        source_unit: Some("shared_database".to_string()),
        paths: Default::default(),
        fixture_paths: vec!["opencode.db".to_string()],
        query: None,
        mapping: None,
        module: Some("opencode".to_string()),
    };

    let context = SourceContext {
        store: StoreIdentity::new("opencode", "fixture://opencode", "synthetic"),
        approved_roots: vec![dir.path().to_path_buf()],
        installation_id: None,
        generation: 1,
        revision: 1,
    };
    let boundary = ReadBoundary::new(&context.approved_roots).unwrap();

    let batches = dispatch_module_batches(
        "opencode",
        &adapter,
        &source,
        &context,
        &boundary,
        dir.path(),
    )
    .expect("dispatch_module_batches must succeed for opencode");

    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].read_status, ReadStatus::Complete);
    assert_eq!(batches[0].sessions.len(), 1);
    assert_eq!(
        batches[0].sessions[0].session.title.as_deref(),
        Some("Unified dispatch test")
    );
}

#[test]
fn test_g9_a6_builtins_have_docs_urls() {
    let builtins = builtin_adapters();
    let a6_entries: Vec<_> = builtins
        .iter()
        .filter(|adapter| {
            orrery_adapters::BUILTINS
                .iter()
                .any(|b| b.id == adapter.id && b.package == "A6")
        })
        .collect();

    assert!(
        a6_entries.len() >= 50,
        "must have at least 50 A6 entries, found {}",
        a6_entries.len()
    );

    let mut missing_docs = vec![];
    for adapter in &a6_entries {
        match &adapter.docs_url {
            Some(url) => {
                assert!(
                    is_valid_url(url),
                    "docs_url for {} must be valid: {}",
                    adapter.id,
                    url
                );
            }
            None => {
                missing_docs.push(adapter.id.clone());
            }
        }
    }

    let unconfirmed_allowed = ["chatgpt-desktop"];
    for missing in &missing_docs {
        assert!(
            unconfirmed_allowed.contains(&missing.as_str()),
            "A6 builtin '{missing}' is missing docs_url but was not unconfirmed"
        );
    }
    let confirmed_count = a6_entries.len() - missing_docs.len();
    assert!(
        confirmed_count >= 50,
        "must have at least 50 confirmed docs_url entries, found {confirmed_count}"
    );
}
