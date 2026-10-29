#[path = "../src/importer.rs"]
mod importer;
#[path = "../src/archive_api.rs"]
mod archive_api;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tempfile::tempdir;

use armillary_model::stable_id;
use orrery_adapters::env::{MockEnvironment, MockFileSystem, SystemFileSystem, TargetOs};
use orrery_adapters::path_expansion::expand_path;
use orrery_archive::{Archive, SessionFilter};

use importer::{discover_targets, Importer};

fn repo_fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

/// Helper to stage real-layout HOME folders mimicking multiple agents:
/// - claude-code: ~/.claude/projects/my-web-app/session-001.jsonl
/// - codex-cli: ~/.codex/sessions/2026/10/12/rollout-2026-10-12T14-00-00-abc123.jsonl
/// - antigravity-cli: ~/.gemini/antigravity-cli/history.jsonl
/// - amp: ~/.local/share/amp/threads/T-0f3a9c2e-88d5-4c7f-9d21-7be3a1e5c4f9.json
/// - crush: ~/.local/share/crush/crush.db
fn setup_fake_home() -> (tempfile::TempDir, PathBuf, MockEnvironment) {
    let tmp = tempdir().unwrap();
    // Canonicalize home so glob matching matches canonicalized WalkDir paths
    let home = tmp.path().canonicalize().unwrap();
    let home_str = home.to_str().unwrap();

    // 1. Claude Code
    let claude_projects = home.join(".claude/projects/my-web-app");
    fs::create_dir_all(&claude_projects).unwrap();
    fs::copy(
        repo_fixtures().join("claude-code/projects/my-web-app/session-001.jsonl"),
        claude_projects.join("session-001.jsonl"),
    )
    .unwrap();

    // 2. Codex CLI
    let codex_sessions = home.join(".codex/sessions/2026/10/12");
    fs::create_dir_all(&codex_sessions).unwrap();
    fs::copy(
        repo_fixtures().join("codex-cli/sessions/2026/10/12/rollout-2026-10-12T14-00-00-abc123.jsonl"),
        codex_sessions.join("rollout-2026-10-12T14-00-00-abc123.jsonl"),
    )
    .unwrap();

    // 3. Antigravity CLI
    let antigravity_dir = home.join(".gemini/antigravity-cli");
    fs::create_dir_all(&antigravity_dir).unwrap();
    fs::copy(
        repo_fixtures().join("antigravity-cli/history.jsonl"),
        antigravity_dir.join("history.jsonl"),
    )
    .unwrap();
    let brain_dir = antigravity_dir.join("brain");
    importer::testutil::copy_dir_recursive(&repo_fixtures().join("antigravity-cli/brain"), &brain_dir);

    // 4. Amp
    let amp_threads = home.join(".local/share/amp/threads");
    fs::create_dir_all(&amp_threads).unwrap();
    fs::copy(
        repo_fixtures().join("amp/threads/T-0f3a9c2e-88d5-4c7f-9d21-7be3a1e5c4f9.json"),
        amp_threads.join("T-0f3a9c2e-88d5-4c7f-9d21-7be3a1e5c4f9.json"),
    )
    .unwrap();

    // 5. Crush
    let crush_dir = home.join(".local/share/crush");
    fs::create_dir_all(&crush_dir).unwrap();
    fs::copy(
        repo_fixtures().join("crush/.crush/crush.db"),
        crush_dir.join("crush.db"),
    )
    .unwrap();

    let env = MockEnvironment::new(TargetOs::current(), home_str);
    (tmp, home, env)
}

#[test]
fn test_all_22_history_adapters_are_wired() {
    let adapters = importer::builtin_adapters();
    let history_adapters: Vec<String> = adapters
        .iter()
        .filter(|a| !a.history_sources.is_empty())
        .map(|a| a.id.clone())
        .collect();

    // SPEC section 4/5: All 22 adapters with history must be wired
    assert_eq!(
        history_adapters.len(),
        22,
        "All 22 adapters with history must be wired in builtin_adapters, got {:?}",
        history_adapters
    );

    let expected_22 = [
        "aider", "amp", "antigravity-cli", "claude-code", "cline", "codex-cli",
        "continue", "crush", "cursor-cli", "factory-droid", "gemini-cli",
        "github-copilot-cli", "goose", "hermes-agent-cli", "iflow-cli",
        "kilo-code", "kimi-code-cli", "open-interpreter", "opencode",
        "qoder-cli", "qwen-code", "roo-code",
    ];

    for expected in &expected_22 {
        assert!(
            history_adapters.contains(&expected.to_string()),
            "Missing history adapter: {}",
            expected
        );
    }
}

#[test]
fn test_production_importer_real_store_identities_and_counts() {
    let (_tmp, _home, env) = setup_fake_home();
    let fs = SystemFileSystem;
    let targets = discover_targets(&env, &fs);

    assert!(
        targets.len() >= 5,
        "discover_targets should find at least the 5 staged agents in fake home, found: {:?}",
        targets.iter().map(|t| &t.adapter.id).collect::<Vec<_>>()
    );

    let archive = Arc::new(Archive::in_memory().unwrap());
    let importer = Importer::new(archive.clone());

    let summary = importer.run(&targets, None, &|_| {}).expect("importer run should succeed");
    assert!(summary.adapters >= 5, "at least 5 adapters should be imported");
    assert!(summary.sessions >= 5, "at least 5 sessions should be imported");
    assert!(summary.messages > 0, "messages should be imported");

    let page = archive.sessions_query(&SessionFilter::default()).unwrap();
    assert!(page.total >= 5, "archive should contain at least 5 sessions");

    for session in &page.items {
        let store = &session.provenance.store;

        // CRITICAL CONTRACT ASSERTION: Never use synthetic store identities in production
        assert!(
            !store.canonical_root.starts_with("fixture://"),
            "store canonical_root must be a real path, not fixture://: {}",
            store.canonical_root
        );
        assert_eq!(
            store.profile_id, "default",
            "store profile_id must be 'default' in production, not 'synthetic'"
        );
        assert!(
            !session.provenance.file_identity.starts_with("synthetic"),
            "file_identity must be a real device:inode identity, not synthetic: {}",
            session.provenance.file_identity
        );

        let expected_store_id = stable_id("store", &[&store.namespace, &store.canonical_root, &store.profile_id]);
        assert_eq!(store.id, expected_store_id, "store id must follow CONTRACT.md formula");
    }
}

#[test]
fn test_production_importer_idempotent_reimport() {
    let (_tmp, _home, env) = setup_fake_home();
    let fs = SystemFileSystem;
    let targets = discover_targets(&env, &fs);

    let archive = Arc::new(Archive::in_memory().unwrap());
    let importer = Importer::new(archive.clone());

    // First import
    let sum1 = importer.run(&targets, None, &|_| {}).unwrap();
    let total_sessions_1 = archive.sessions_query(&SessionFilter::default()).unwrap().total;
    assert_eq!(sum1.sessions, total_sessions_1 as u32);

    // Second import (idempotent replay)
    let sum2 = importer.run(&targets, None, &|_| {}).unwrap();
    let total_sessions_2 = archive.sessions_query(&SessionFilter::default()).unwrap().total;

    assert_eq!(total_sessions_1, total_sessions_2, "idempotent import must not duplicate sessions");
    assert_eq!(sum2.sessions, sum1.sessions, "replay returns the count of verified sessions");
}

#[test]
fn test_production_importer_incremental_reimport_after_append() {
    let (_tmp, home, env) = setup_fake_home();
    let fs = SystemFileSystem;
    let targets = discover_targets(&env, &fs);

    let archive = Arc::new(Archive::in_memory().unwrap());
    let importer = Importer::new(archive.clone());

    // First import
    importer.run(&targets, Some("claude-code"), &|_| {}).unwrap();

    let page1 = archive.sessions_query(&SessionFilter {
        agent: Some("claude-code".into()),
        ..Default::default()
    }).unwrap();
    assert_eq!(page1.items.len(), 1);
    let original_session = &page1.items[0];
    let original_messages = archive.session_messages(&original_session.id).unwrap().len();

    let checkpoint1 = archive.source_checkpoint(&original_session.provenance.key()).unwrap().unwrap();
    assert_eq!(checkpoint1.checkpoint.revision, 1);

    // Append new valid user turn to claude-code session-001.jsonl
    let session_file = home.join(".claude/projects/my-web-app/session-001.jsonl");
    let append_line = r#"{"type":"user","uuid":"u999","sessionId":"claude-sess-alpha-001","timestamp":"2026-10-12T14:15:00.000Z","cwd":"/Users/developer/code/my-web-app","message":{"role":"user","content":[{"type":"text","text":"incremental turn appended"}]}}"#;
    use std::io::Write;
    let mut f = fs::OpenOptions::new().append(true).open(&session_file).unwrap();
    f.write_all(append_line.as_bytes()).unwrap();
    f.write_all(b"\n").unwrap();
    f.flush().unwrap();

    // Re-run importer
    importer.run(&targets, Some("claude-code"), &|_| {}).unwrap();

    let page2 = archive.sessions_query(&SessionFilter {
        agent: Some("claude-code".into()),
        ..Default::default()
    }).unwrap();
    assert_eq!(page2.items.len(), 1, "session count must remain 1 (incremental upsert)");
    let updated_session = &page2.items[0];
    let new_messages = archive.session_messages(&updated_session.id).unwrap().len();
    assert_eq!(new_messages, original_messages + 1, "message count must increment by 1");

    let checkpoint2 = archive.source_checkpoint(&original_session.provenance.key()).unwrap().unwrap();
    assert_eq!(checkpoint2.checkpoint.revision, 2, "revision must advance on incremental append");
}

#[test]
fn test_production_importer_incomplete_read_keeps_old_data() {
    let (_tmp, home, env) = setup_fake_home();
    let fs = SystemFileSystem;
    let targets = discover_targets(&env, &fs);

    let archive = Arc::new(Archive::in_memory().unwrap());
    let importer = Importer::new(archive.clone());

    // First import
    importer.run(&targets, Some("claude-code"), &|_| {}).unwrap();
    let page1 = archive.sessions_query(&SessionFilter {
        agent: Some("claude-code".into()),
        ..Default::default()
    }).unwrap();
    let original_session = &page1.items[0];
    let original_messages = archive.session_messages(&original_session.id).unwrap().len();

    // Append corrupted line to session file
    let session_file = home.join(".claude/projects/my-web-app/session-001.jsonl");
    use std::io::Write;
    let mut f = fs::OpenOptions::new().append(true).open(&session_file).unwrap();
    f.write_all(b"{\"type\":\"user\",corrupted_invalid_json\n").unwrap();
    f.flush().unwrap();

    // Re-run importer
    let _ = importer.run(&targets, Some("claude-code"), &|_| {});

    // Old data must be preserved in archive
    let page2 = archive.sessions_query(&SessionFilter {
        agent: Some("claude-code".into()),
        ..Default::default()
    }).unwrap();
    assert_eq!(page2.items.len(), 1);
    let after_messages = archive.session_messages(&original_session.id).unwrap().len();
    assert_eq!(after_messages, original_messages, "messages preserved on read failure");

    // Diagnostics recorded
    let diags = archive.diagnostics(&original_session.provenance.key()).unwrap();
    assert!(!diags.is_empty(), "diagnostic recorded for incomplete/failed read");
}

const ALL_22_HISTORY_ADAPTERS: &[(&str, u32, usize)] = &[
    ("aider", 2, 13),
    ("amp", 1, 2),
    ("antigravity-cli", 1, 2),
    ("claude-code", 1, 4),
    ("cline", 1, 2),
    ("codex-cli", 1, 3),
    ("continue", 1, 2),
    ("crush", 1, 2),
    ("cursor-cli", 1, 2),
    ("factory-droid", 1, 3),
    ("gemini-cli", 1, 3),
    ("github-copilot-cli", 1, 3),
    ("goose", 3, 6),
    ("hermes-agent-cli", 1, 2),
    ("iflow-cli", 2, 9),
    ("kilo-code", 1, 2),
    ("kimi-code-cli", 1, 5),
    ("open-interpreter", 1, 3),
    ("opencode", 1, 2),
    ("qoder-cli", 2, 6),
    ("qwen-code", 1, 2),
    ("roo-code", 1, 2),
];

fn stage_adapter_real_layout(home: &Path, adapter_id: &str, os: TargetOs) {
    let fix = repo_fixtures().join(adapter_id);
    assert!(fix.is_dir(), "fixture directory must exist for {}", adapter_id);
    match adapter_id {
        "claude-code" => {
            let dir = home.join(".claude/projects/my-web-app");
            fs::create_dir_all(&dir).unwrap();
            fs::copy(
                fix.join("projects/my-web-app/session-001.jsonl"),
                dir.join("session-001.jsonl"),
            )
            .unwrap();
        }
        "codex-cli" => {
            let dir = home.join(".codex/sessions/2026/10/12");
            fs::create_dir_all(&dir).unwrap();
            fs::copy(
                fix.join("sessions/2026/10/12/rollout-2026-10-12T14-00-00-abc123.jsonl"),
                dir.join("rollout-2026-10-12T14-00-00-abc123.jsonl"),
            )
            .unwrap();
        }
        "antigravity-cli" => {
            let dir = home.join(".gemini/antigravity-cli");
            fs::create_dir_all(&dir).unwrap();
            fs::copy(fix.join("history.jsonl"), dir.join("history.jsonl")).unwrap();
            let brain = fix.join("brain");
            if brain.is_dir() {
                importer::testutil::copy_dir_recursive(&brain, &dir.join("brain"));
            }
        }
        "amp" => {
            let dir = home.join(".local/share/amp/threads");
            fs::create_dir_all(&dir).unwrap();
            fs::copy(
                fix.join("threads/T-0f3a9c2e-88d5-4c7f-9d21-7be3a1e5c4f9.json"),
                dir.join("T-0f3a9c2e-88d5-4c7f-9d21-7be3a1e5c4f9.json"),
            )
            .unwrap();
        }
        "crush" => {
            let dir = home.join(".local/share/crush");
            fs::create_dir_all(&dir).unwrap();
            fs::copy(fix.join(".crush/crush.db"), dir.join("crush.db")).unwrap();
        }
        "aider" => {
            // aider writes its history into each project folder, so there is no fixed global
            // store to find; the adapter looks in ~/.aider (a configured history location).
            let dir = home.join(".aider");
            fs::create_dir_all(&dir).unwrap();
            importer::testutil::copy_dir_recursive(&fix.join("etl-sandbox"), &dir);
        }
        "kimi-code-cli" => {
            let dir = home.join(".kimi-code/sessions");
            fs::create_dir_all(&dir).unwrap();
            importer::testutil::copy_dir_recursive(&fix.join("sessions"), &dir);
        }
        "qoder-cli" => {
            let dir = home.join(".qoder/projects");
            fs::create_dir_all(&dir).unwrap();
            importer::testutil::copy_dir_recursive(&fix.join("projects"), &dir);
        }
        "hermes-agent-cli" => {
            let dir = home.join(".hermes");
            fs::create_dir_all(&dir).unwrap();
            fs::copy(fix.join("state.db"), dir.join("state.db")).unwrap();
            if fix.join("config.yaml").exists() {
                fs::copy(fix.join("config.yaml"), dir.join("config.yaml")).unwrap();
            }
        }
        "cline" => {
            let dir = home.join(".cline/data/sessions");
            fs::create_dir_all(&dir).unwrap();
            importer::testutil::copy_dir_recursive(&fix.join("sessions"), &dir);
        }
        "roo-code" => {
            let rel = match os {
                TargetOs::Macos => "Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
                TargetOs::Linux => ".config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
                TargetOs::Windows => "AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
            };
            let dir = home.join(rel);
            fs::create_dir_all(&dir).unwrap();
            importer::testutil::copy_dir_recursive(&fix.join("tasks"), &dir);
        }
        "kilo-code" => {
            let rel = match os {
                TargetOs::Macos => "Library/Application Support/Code/User/globalStorage/kilocode.kilo-code/tasks",
                TargetOs::Linux => ".config/Code/User/globalStorage/kilocode.kilo-code/tasks",
                TargetOs::Windows => "AppData/Roaming/Code/User/globalStorage/kilocode.kilo-code/tasks",
            };
            let dir = home.join(rel);
            fs::create_dir_all(&dir).unwrap();
            importer::testutil::copy_dir_recursive(&fix.join("tasks"), &dir);
        }
        "continue" => {
            let dir = home.join(".continue/sessions");
            fs::create_dir_all(&dir).unwrap();
            importer::testutil::copy_dir_recursive(&fix.join("sessions"), &dir);
        }
        "opencode" => {
            let dir = home.join(".local/share/opencode");
            fs::create_dir_all(&dir).unwrap();
            fs::copy(fix.join("opencode.db"), dir.join("opencode.db")).unwrap();
        }
        "goose" => {
            let dir = home.join(".local/share/goose/sessions");
            fs::create_dir_all(&dir).unwrap();
            fs::copy(fix.join("sessions/sessions.sqlite"), dir.join("sessions.sqlite")).unwrap();
        }
        "gemini-cli" => {
            let dir = home.join(".gemini/tmp");
            fs::create_dir_all(&dir).unwrap();
            importer::testutil::copy_dir_recursive(&fix.join("tmp"), &dir);
        }
        "github-copilot-cli" => {
            let dir = home.join(".copilot/session-state");
            fs::create_dir_all(&dir).unwrap();
            importer::testutil::copy_dir_recursive(&fix.join("session-state"), &dir);
        }
        "qwen-code" => {
            let dir = home.join(".qwen/tmp");
            fs::create_dir_all(&dir).unwrap();
            importer::testutil::copy_dir_recursive(&fix.join("tmp"), &dir);
        }
        "cursor-cli" => {
            let dir = home.join(".cursor/chats");
            fs::create_dir_all(&dir).unwrap();
            importer::testutil::copy_dir_recursive(&fix.join("chats"), &dir);
            if fix.join("cli-config.json").exists() {
                fs::copy(fix.join("cli-config.json"), home.join(".cursor/cli-config.json")).unwrap();
            }
        }
        "factory-droid" => {
            let dir = home.join(".factory/sessions");
            fs::create_dir_all(&dir).unwrap();
            importer::testutil::copy_dir_recursive(&fix.join("sessions"), &dir);
        }
        "iflow-cli" => {
            let dir = home.join(".iflow/projects");
            fs::create_dir_all(&dir).unwrap();
            importer::testutil::copy_dir_recursive(&fix.join(".iflow/projects"), &dir);
        }
        "open-interpreter" => {
            let dir = home.join(".openinterpreter/sessions");
            fs::create_dir_all(&dir).unwrap();
            importer::testutil::copy_dir_recursive(&fix.join(".openinterpreter/sessions"), &dir);
        }
        other => panic!("unknown history adapter: {}", other),
    }
}

#[test]
fn test_real_layout_all_22_history_adapters_together() {
    let tmp = tempdir().unwrap();
    let home = tmp.path().canonicalize().unwrap();
    let home_str = home.to_str().unwrap();

    let os = TargetOs::current();
    for (adapter_id, _, _) in ALL_22_HISTORY_ADAPTERS {
        stage_adapter_real_layout(&home, adapter_id, os);
    }

    let env = MockEnvironment::new(os, home_str);
    let fs = SystemFileSystem;
    let targets = discover_targets(&env, &fs);

    let discovered_ids: Vec<String> = targets.iter().map(|t| t.adapter.id.clone()).collect();
    for (adapter_id, _, _) in ALL_22_HISTORY_ADAPTERS {
        assert!(
            discovered_ids.contains(&adapter_id.to_string()),
            "discover_targets must find adapter {} staged at real layout, discovered: {:?}",
            adapter_id,
            discovered_ids
        );
    }
    assert_eq!(
        targets.len(),
        22,
        "all 22 adapters must be discovered in full fake home"
    );

    let archive = Arc::new(Archive::in_memory().unwrap());
    let importer = Importer::new(archive.clone());

    let summary = importer
        .run_with_env(&targets, None, &env, &|_| {})
        .expect("importer run should succeed for all 22 adapters");

    assert_eq!(summary.adapters, 22, "all 22 adapters must report import completion");
    assert_eq!(summary.sessions, 27, "total sessions must equal 27 (sum of all fixtures)");
    assert_eq!(summary.messages, 80, "total messages must equal 80 (sum of all fixtures)");

    let page = archive.sessions_query(&SessionFilter::default()).unwrap();
    assert_eq!(page.total, 27, "archive must contain all 27 sessions");

    for session in &page.items {
        let store = &session.provenance.store;

        assert!(
            !store.canonical_root.starts_with("fixture://"),
            "store canonical_root must be a real path, got: {}",
            store.canonical_root
        );
        assert_eq!(
            store.profile_id, "default",
            "store profile_id must be 'default' in production"
        );
        assert!(
            !session.provenance.file_identity.starts_with("synthetic"),
            "file_identity must be a real file identity: {}",
            session.provenance.file_identity
        );

        let expected_store_id =
            stable_id("store", &[&store.namespace, &store.canonical_root, &store.profile_id]);
        assert_eq!(
            store.id, expected_store_id,
            "store id must conform to CONTRACT.md for adapter {}",
            session.agent_id
        );
    }

    // Idempotent re-import check over all 22 adapters
    let sum2 = importer
        .run_with_env(&targets, None, &env, &|_| {})
        .expect("second import run should succeed");
    let page2 = archive.sessions_query(&SessionFilter::default()).unwrap();
    assert_eq!(
        page2.total, 27,
        "idempotent import must not duplicate sessions"
    );
    assert_eq!(
        sum2.sessions, summary.sessions,
        "replay returns the exact count of verified sessions"
    );
}

#[test]
fn test_real_layout_every_adapter_individually() {
    let os = TargetOs::current();
    for (adapter_id, expected_sessions, expected_messages) in ALL_22_HISTORY_ADAPTERS {
        let tmp = tempdir().unwrap();
        let home = tmp.path().canonicalize().unwrap();
        let home_str = home.to_str().unwrap();

        stage_adapter_real_layout(&home, adapter_id, os);

        let env = MockEnvironment::new(os, home_str);
        let fs = SystemFileSystem;
        let targets = discover_targets(&env, &fs);

        let target = targets
            .iter()
            .find(|t| t.adapter.id == *adapter_id)
            .unwrap_or_else(|| {
                panic!(
                    "discover_targets failed to find adapter '{}' at its real layout under {}",
                    adapter_id,
                    home.display()
                )
            });

        let archive = Arc::new(Archive::in_memory().unwrap());
        let importer = Importer::new(archive.clone());

        let summary = importer
            .run_with_env(&[target.clone()], None, &env, &|_| {})
            .unwrap_or_else(|e| {
                panic!("importer failed for adapter '{}': {}", adapter_id, e)
            });

        assert_eq!(
            summary.sessions, *expected_sessions,
            "adapter '{}' session count mismatch",
            adapter_id
        );
        assert_eq!(
            summary.messages as usize, *expected_messages,
            "adapter '{}' message count mismatch",
            adapter_id
        );

        let page = archive
            .sessions_query(&SessionFilter {
                agent: Some(adapter_id.to_string()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            page.total, *expected_sessions as u64,
            "archive query count mismatch for '{}'",
            adapter_id
        );

        for session in &page.items {
            let store = &session.provenance.store;
            assert!(
                !store.canonical_root.starts_with("fixture://"),
                "store canonical_root must be a real path: {}",
                store.canonical_root
            );
            assert_eq!(store.profile_id, "default");
            assert!(!session.provenance.file_identity.starts_with("synthetic"));
            let expected_store_id =
                stable_id("store", &[&store.namespace, &store.canonical_root, &store.profile_id]);
            assert_eq!(store.id, expected_store_id);
        }

        // Idempotent re-import
        let sum2 = importer
            .run_with_env(&[target.clone()], None, &env, &|_| {})
            .unwrap();
        let page2 = archive
            .sessions_query(&SessionFilter {
                agent: Some(adapter_id.to_string()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page2.total, page.total);
        assert_eq!(sum2.sessions, summary.sessions);
    }
}

#[test]
fn test_real_layout_simulated_linux() {
    let tmp = tempdir().unwrap();
    let home = tmp.path().canonicalize().unwrap();
    let home_str = home.to_str().unwrap();

    let os = TargetOs::Linux;
    for (adapter_id, _, _) in ALL_22_HISTORY_ADAPTERS {
        stage_adapter_real_layout(&home, adapter_id, os);
    }

    let env = MockEnvironment::new(os, home_str);
    let fs = SystemFileSystem;
    let targets = discover_targets(&env, &fs);

    let discovered_ids: Vec<String> = targets.iter().map(|t| t.adapter.id.clone()).collect();
    for (adapter_id, _, _) in ALL_22_HISTORY_ADAPTERS {
        assert!(
            discovered_ids.contains(&adapter_id.to_string()),
            "Linux simulation: discover_targets must find adapter {}, found: {:?}",
            adapter_id,
            discovered_ids
        );
    }

    let archive = Arc::new(Archive::in_memory().unwrap());
    let importer = Importer::new(archive.clone());
    let summary = importer
        .run_with_env(&targets, None, &env, &|_| {})
        .expect("Linux simulation import should succeed");

    assert_eq!(summary.adapters, 22);
    assert_eq!(summary.sessions, 27);
    assert_eq!(summary.messages, 80);
}

#[test]
fn test_real_layout_simulated_windows_discovery() {
    let env = MockEnvironment::new(TargetOs::Windows, "C:\\Users\\testuser");
    let mut fs = MockFileSystem::new();

    // Stage all 22 history adapters in the mock Windows environment
    for (adapter_id, _, _) in ALL_22_HISTORY_ADAPTERS {
        let adapter = importer::builtin_adapters()
            .into_iter()
            .find(|a| a.id == *adapter_id)
            .unwrap_or_else(|| panic!("builtin adapter {} must exist", adapter_id));

        // 1. Detection data folders and config files
        if let Some(paths) = adapter.detection.paths.get("windows") {
            for folder in &paths.data_folders {
                if let Ok(exp) = expand_path(folder, TargetOs::Windows, &env) {
                    fs.add_dir(exp);
                }
            }
            for file in &paths.config_files {
                if let Ok(exp) = expand_path(file, TargetOs::Windows, &env) {
                    fs.add_file(exp, b"{}");
                }
            }
        }

        // 2. History source paths base directories
        for hs in &adapter.history_sources {
            if let Some(paths) = hs.paths.get("windows").or_else(|| hs.paths.get("default")) {
                for pattern in paths {
                    let prefix = pattern.split(['*', '?', '[']).next().unwrap_or(pattern);
                    let base_dir_str = if prefix.ends_with('/') || prefix.ends_with('\\') {
                        prefix.trim_end_matches(['/', '\\'])
                    } else {
                        std::path::Path::new(prefix)
                            .parent()
                            .and_then(|p| p.to_str())
                            .unwrap_or(prefix)
                    };
                    if !base_dir_str.is_empty() {
                        if let Ok(exp) = expand_path(base_dir_str, TargetOs::Windows, &env) {
                            fs.add_dir(exp);
                        }
                    }
                }
            }
        }
    }

    let targets = discover_targets(&env, &fs);
    let discovered_ids: Vec<String> = targets.iter().map(|t| t.adapter.id.clone()).collect();
    for (adapter_id, _, _) in ALL_22_HISTORY_ADAPTERS {
        assert!(
            discovered_ids.contains(&adapter_id.to_string()),
            "Windows simulation: discover_targets must find adapter {}, found: {:?}",
            adapter_id,
            discovered_ids
        );
    }
    assert_eq!(
        targets.len(),
        22,
        "all 22 history adapters must be discovered in simulated Windows environment"
    );
}


