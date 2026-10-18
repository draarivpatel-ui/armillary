//! CF regression scenarios from review r1. All data below is synthetic.
use orrery_adapters::mapping::parse_timestamp;
use orrery_adapters::{get_builtin_adapter, AdapterDef, AdapterEngine};
mod common_readers;
use common_readers::{read_json, read_jsonl, read_sqlite};
use serde_json::{json, Value};
use std::{fs, path::Path};
use tempfile::tempdir;

fn adapter(format: &str, paths: &str, mapping: &str) -> AdapterDef {
    AdapterDef::from_toml(&format!(
        r#"
id = "test"
name = "Test"
vendor = "Synthetic"
family = "other"
kind = "cli"
[[history_sources]]
id = "history"
format = "{format}"
[history_sources.paths]
default = [{paths}]
{mapping}
"#
    ))
    .unwrap()
}
fn fixture(id: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures")
        .join(id)
}
#[test]
#[cfg(unix)]
fn credential_symlink_to_parent_auth_is_refused() {
    let d = tempdir().unwrap();
    fs::create_dir(d.path().join("history")).unwrap();
    fs::write(d.path().join("auth.json"), b"{\"canary\":\"FORBIDDEN\"}").unwrap();
    let p = d.path().join("history/session.json");
    std::os::unix::fs::symlink("../auth.json", &p).unwrap();
    assert!(
        read_json(&p).is_err(),
        "a safe-looking name must not open auth.json"
    );
}
#[test]
fn mapped_json_session_id_and_records_are_retained() {
    let d = tempdir().unwrap();
    fs::write(
        d.path().join("session.json"),
        r#"{"session":{"id":"s"},"messages":[{"role":"user","text":"hello"}]}"#,
    )
    .unwrap();
    let a = adapter(
        "json",
        "\"session.json\"",
        r#"
[history_sources.mapping.session]
id = "/session/id"
[history_sources.mapping.records]
array_pointer = "/messages"
[history_sources.mapping.records.messages]
role_pointer = "/role"
text_pointer = "/text"
"#,
    );
    let s = AdapterEngine::process_fixture_dir(&a, d.path()).unwrap();
    let v = serde_json::to_value(&s[0]).unwrap();
    assert_eq!(v["session"]["native_id"], "s");
    assert_eq!(s[0].messages.len(), 1);
}
#[test]
fn two_jsonl_sources_do_not_reread_each_others_files() {
    let d = tempdir().unwrap();
    fs::create_dir(d.path().join("a")).unwrap();
    fs::create_dir(d.path().join("b")).unwrap();
    for id in ["a", "b"] {
        fs::write(
            d.path().join(id).join("s.jsonl"),
            format!("{{\"id\":\"{id}\",\"role\":\"user\",\"text\":\"hello\"}}\n"),
        )
        .unwrap();
    }
    let mut a = adapter(
        "jsonl",
        "\"a/*.jsonl\"",
        r#"
[history_sources.mapping.session]
id = "/id"
[history_sources.mapping.records.messages]
role_pointer = "/role"
text_pointer = "/text"
"#,
    );
    let mut second = a.history_sources[0].clone();
    second.id = Some("second".into());
    second
        .paths
        .insert("default".into(), vec!["b/*.jsonl".into()]);
    a.history_sources.push(second);
    assert_eq!(
        AdapterEngine::process_fixture_dir(&a, d.path())
            .unwrap()
            .len(),
        2
    );
}
#[test]
fn json_fixture_oracle_is_never_imported() {
    let d = tempdir().unwrap();
    fs::write(d.path().join("session.json"), "{\"id\":\"s\"}").unwrap();
    fs::write(d.path().join("expected.json"), "{\"id\":\"oracle\"}").unwrap();
    let a = adapter("json", "\"*.json\"", "");
    assert_eq!(
        AdapterEngine::process_fixture_dir(&a, d.path())
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn read_error_cannot_return_a_successful_jsonl_prefix() {
    let d = tempdir().unwrap();
    let p = d.path().join("session.jsonl");
    fs::write(&p, b"{\"id\":\"s\"}\n\xff\n").unwrap();
    assert!(read_jsonl(&p).is_err());
}
#[test]
fn wal_commits_are_visible_without_mutating_source_files() {
    let d = tempdir().unwrap();
    let p = d.path().join("history.sqlite");
    let c = rusqlite::Connection::open(&p).unwrap();
    c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE events(id TEXT); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO events VALUES ('wal-only');").unwrap();
    let before: Vec<_> = [
        p.clone(),
        p.with_file_name("history.sqlite-wal"),
        p.with_file_name("history.sqlite-shm"),
    ]
    .iter()
    .map(|p| fs::read(p).unwrap())
    .collect();
    let rows = read_sqlite(&p, "SELECT id FROM events").unwrap();
    assert_eq!(rows, vec![json!({"id":"wal-only"})]);
    let after: Vec<_> = [
        p.clone(),
        p.with_file_name("history.sqlite-wal"),
        p.with_file_name("history.sqlite-shm"),
    ]
    .iter()
    .map(|p| fs::read(p).unwrap())
    .collect();
    assert_eq!(before, after);
}
#[test]
fn sqlite_question_and_hash_filename_is_encoded() {
    let d = tempdir().unwrap();
    let p = d.path().join("history?#.db");
    let c = rusqlite::Connection::open(&p).unwrap();
    c.execute_batch("CREATE TABLE events(id TEXT); INSERT INTO events VALUES ('correct');")
        .unwrap();
    assert_eq!(
        read_sqlite(&p, "SELECT id FROM events").unwrap(),
        vec![json!({"id":"correct"})]
    );
}
#[test]
fn tool_call_and_result_follow_message_chronology() {
    let a = get_builtin_adapter("claude-code").unwrap();
    let s = AdapterEngine::process_fixture_dir(&a, &fixture("claude-code")).unwrap();
    let v = serde_json::to_value(&s[0]).unwrap();
    let msgs = v["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 4, "tool-only result record is an ordered event");
    assert_eq!(msgs[1]["blocks"][1]["call_id"], "toolu_01");
    assert_eq!(msgs[2]["blocks"][0]["call_id"], "toolu_01");
    assert!(msgs
        .windows(2)
        .all(|m| m[0]["seq"].as_u64() < m[1]["seq"].as_u64()));
}
#[test]
fn latest_cumulative_usage_wins() {
    let d = tempdir().unwrap();
    fs::write(d.path().join("rollout-s.jsonl"), concat!(
        "{\"type\":\"session_meta\",\"payload\":{\"id\":\"s\"}}\n",
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":100}}}}\n",
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":150}}}}\n"
    )).unwrap();
    let a = get_builtin_adapter("codex-cli").unwrap();
    fs::create_dir_all(d.path().join("sessions")).unwrap();
    fs::rename(
        d.path().join("rollout-s.jsonl"),
        d.path().join("sessions/rollout-s.jsonl"),
    )
    .unwrap();
    let s = AdapterEngine::process_fixture_dir(&a, d.path()).unwrap();
    let v = serde_json::to_value(&s[0].session).unwrap();
    assert_eq!(
        v["tokens_in"]
            .as_u64()
            .or(v["usage"]["input_tokens"].as_u64()),
        Some(150)
    );
}
#[test]
fn one_prompt_does_not_prove_completion() {
    let d = tempdir().unwrap();
    fs::write(
        d.path().join("s.jsonl"),
        "{\"id\":\"s\",\"role\":\"user\",\"text\":\"hi\",\"timestamp\":1700000000}\n",
    )
    .unwrap();
    let a = adapter(
        "jsonl",
        "\"*.jsonl\"",
        r#"
[history_sources.mapping.session]
id = "/id"
[history_sources.mapping.records.messages]
role_pointer = "/role"
text_pointer = "/text"
"#,
    );
    let s = AdapterEngine::process_fixture_dir(&a, d.path()).unwrap();
    assert_ne!(s[0].session.status, "done");
    assert_eq!(s[0].session.ended_at, None);
}
#[test]
fn minimum_timestamp_never_overflows() {
    assert!(std::panic::catch_unwind(|| parse_timestamp(
        &Value::from(i64::MIN),
        Some("unix_seconds")
    ))
    .unwrap()
    .is_none());
}
#[test]
fn unsupported_mapping_keys_are_rejected() {
    let raw = r#"id="t"
name="T"
vendor="T"
family="other"
kind="cli"
[[history_sources]]
format="json"
[history_sources.mapping.session]
join="silently ignored before CF"
"#;
    assert!(AdapterDef::from_toml(raw).is_err());
}
#[test]
fn passive_detection_does_not_call_hanging_version_shim() {
    use orrery_adapters::env::{FileSystem, MockEnvironment, TargetOs};
    struct Shim;
    impl FileSystem for Shim {
        fn exists(&self, _: &Path) -> bool {
            false
        }
        fn is_file(&self, _: &Path) -> bool {
            false
        }
        fn is_dir(&self, _: &Path) -> bool {
            false
        }
        fn read_dir(&self, _: &Path) -> std::io::Result<Vec<std::path::PathBuf>> {
            Ok(vec![])
        }
        fn which(&self, _: &str) -> Option<std::path::PathBuf> {
            Some("/synthetic/hanging-shim".into())
        }
        fn version_of(&self, _: &Path, _: &[String]) -> Option<String> {
            panic!("would execute a hanging --version shim")
        }
    }
    let a = get_builtin_adapter("claude-code").unwrap();
    let result = orrery_adapters::detect_agent(
        &a,
        &MockEnvironment::new(TargetOs::Linux, "/synthetic"),
        &Shim,
    );
    assert!(result.installed);
    assert_eq!(result.version, None);
}
