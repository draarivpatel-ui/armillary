#[path = "../src/importer.rs"]
pub mod importer;
#[path = "../src/live.rs"]
pub mod live;
#[path = "../src/archive_api.rs"]
pub mod archive_api;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tempfile::tempdir;

use orrery_adapters::env::{MockEnvironment, SystemFileSystem, TargetOs};
use orrery_archive::{Archive, SessionFilter};

use importer::{discover_targets, spawn_watcher, Importer};
use live::{FakeProcessScanner, LiveDetector, LiveDetectorConfig, ProcessInfo};

fn repo_fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn setup_temp_home() -> (tempfile::TempDir, PathBuf, MockEnvironment) {
    let tmp = tempdir().unwrap();
    let home = tmp.path().canonicalize().unwrap();
    let home_str = home.to_str().unwrap();

    // 1. Claude Code: ~/.claude/projects/my-web-app/session-001.jsonl
    let claude_projects = home.join(".claude/projects/my-web-app");
    fs::create_dir_all(&claude_projects).unwrap();
    fs::copy(
        repo_fixtures().join("claude-code/projects/my-web-app/session-001.jsonl"),
        claude_projects.join("session-001.jsonl"),
    )
    .unwrap();

    // 2. Codex CLI: ~/.codex/sessions/2026/10/12/rollout-2026-10-12T14-00-00-abc123.jsonl
    let codex_sessions = home.join(".codex/sessions/2026/10/12");
    fs::create_dir_all(&codex_sessions).unwrap();
    fs::copy(
        repo_fixtures().join("codex-cli/sessions/2026/10/12/rollout-2026-10-12T14-00-00-abc123.jsonl"),
        codex_sessions.join("rollout-2026-10-12T14-00-00-abc123.jsonl"),
    )
    .unwrap();

    let env = MockEnvironment::new(TargetOs::current(), home_str);
    (tmp, home, env)
}

#[test]
fn test_live_and_archive_session_ids_agree_in_temp_home() {
    let (_tmp, home, env) = setup_temp_home();
    let fs_sys = SystemFileSystem;
    let targets = discover_targets(&env, &fs_sys);

    let archive = Arc::new(Archive::in_memory().unwrap());
    let importer = Importer::new(archive.clone());
    importer
        .run_with_env(&targets, None, &env, &|_| {})
        .expect("import must succeed");

    let claude_archive_sessions = archive
        .sessions_query(&SessionFilter {
            agent: Some("claude-code".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(claude_archive_sessions.items.len(), 1);
    let claude_archive_session = &claude_archive_sessions.items[0];

    let codex_archive_sessions = archive
        .sessions_query(&SessionFilter {
            agent: Some("codex-cli".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(codex_archive_sessions.items.len(), 1);
    let codex_archive_session = &codex_archive_sessions.items[0];

    // Configure live detector to inspect the temp home data folders
    let mut history_roots = HashMap::new();
    history_roots.insert("claude-code".to_string(), home.join(".claude/projects"));
    history_roots.insert("codex-cli".to_string(), home.join(".codex/sessions"));

    let config = LiveDetectorConfig {
        history_roots,
        active_window_secs: 7200,
        idle_threshold_secs: 120,
        min_emit_interval: Duration::from_millis(250),
    };

    let fake_scanner = Box::new(FakeProcessScanner::new(vec![
        ProcessInfo {
            pid: 1001,
            binary: "claude".to_string(),
            cwd: Some(PathBuf::from("/Users/developer/code/my-web-app")),
            started_at: None,
        },
        ProcessInfo {
            pid: 1002,
            binary: "codex".to_string(),
            cwd: Some(PathBuf::from("/home/developer/projects/core-api")),
            started_at: None,
        },
    ]));

    let mut detector = LiveDetector::new(config, fake_scanner);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let live_list = detector.scan(now_ms);
    assert_eq!(live_list.len(), 2, "detector should observe both sessions");

    let live_claude = live_list
        .iter()
        .find(|l| {
            l.process
                .as_ref()
                .map(|p| p.pid == 1001)
                .unwrap_or(false)
        })
        .expect("live claude session must be found");

    let live_codex = live_list
        .iter()
        .find(|l| {
            l.process
                .as_ref()
                .map(|p| p.pid == 1002)
                .unwrap_or(false)
        })
        .expect("live codex session must be found");

    // Acceptance criterion 1:
    // A live session and its imported archive session MUST have the same id
    // for claude-code and codex-cli in a temp HOME.
    assert_eq!(
        live_claude.session_id, claude_archive_session.id,
        "Claude live session ID must match imported archive session ID"
    );
    assert_eq!(
        live_codex.session_id, codex_archive_session.id,
        "Codex live session ID must match imported archive session ID"
    );
}

#[test]
fn test_watcher_ignores_app_data_folder_and_temp_snapshot_folder() {
    let (_tmp, home, env) = setup_temp_home();
    let fs_sys = SystemFileSystem;
    let mut targets = discover_targets(&env, &fs_sys);

    let app_data_dir = home.join("Library/Application Support/com.armillary.app");
    fs::create_dir_all(&app_data_dir).unwrap();
    let temp_snap_dir = std::env::temp_dir().join("armillary-sqlite-test123");
    fs::create_dir_all(&temp_snap_dir).unwrap();

    // Include app data folder and temp snapshot folder in the target's watched data_dirs
    // to test that the watcher explicitly ignores them and refuses to trigger on them.
    targets[0].data_dirs.push(app_data_dir.clone());
    targets[0].data_dirs.push(temp_snap_dir.clone());

    let archive = Arc::new(Archive::in_memory().unwrap());
    Importer::new(archive.clone())
        .run_with_env(&targets, None, &env, &|_| {})
        .unwrap();

    let (progress_tx, progress_rx) = crossbeam_channel::unbounded();
    let watcher = spawn_watcher(archive.clone(), targets.clone(), progress_tx).unwrap();

    // Give watcher time to register
    std::thread::sleep(Duration::from_millis(400));

    // Drain any initial events
    let _ = progress_rx.try_iter().collect::<Vec<_>>();

    // 1. Touch/write files in app data folder (e.g. archive DB write during import)
    fs::write(app_data_dir.join("armillary-archive.sqlite3-wal"), b"wal content").unwrap();

    // 2. Touch/write files in temp snapshot folder (e.g. snapshot.db during SQLite adapter import)
    fs::write(temp_snap_dir.join("snapshot.db"), b"fake snapshot").unwrap();

    // Wait a brief debounce period to see if any re-import is triggered
    std::thread::sleep(Duration::from_millis(500));
    let progress_events: Vec<_> = progress_rx.try_iter().collect();

    // Acceptance criterion 2:
    // The file watcher must explicitly ignore the app's own data folder and temp snapshot folder
    // so an import can never re-trigger itself!
    assert!(
        progress_events.is_empty(),
        "watcher must explicitly ignore app data and temp snapshot files, got: {:?}",
        progress_events
    );

    drop(watcher);
    let _ = fs::remove_dir_all(&temp_snap_dir);
}
