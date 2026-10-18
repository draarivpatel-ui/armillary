//! Opaque native IDs must not collide with generated source-position fallbacks.
use orrery_adapters::{AdapterDef, AdapterEngine};
#[test]
fn native_message_id_is_separate_from_source_position_identity() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("s.jsonl");
    let a = AdapterDef::from_toml(
        r#"id="test"
name="Test"
vendor="Synthetic"
family="other"
kind="cli"
[[history_sources]]
format="jsonl"
fixture_paths=["s.jsonl"]
[history_sources.mapping.session]
id="/id"
[history_sources.mapping.records.messages]
native_id_pointer="/uuid"
role_pointer="/role"
text_pointer="/text"
"#,
    )
    .unwrap();
    std::fs::write(&p, "{\"id\":\"s\",\"role\":\"user\",\"text\":\"hello\"}\n").unwrap();
    let first = AdapterEngine::process_fixture_dir(&a, d.path())
        .unwrap()
        .remove(0);
    let native = format!("{}:record:1", first.session.provenance.key());
    std::fs::write(
        &p,
        serde_json::json!({"id":"s","uuid":native,"role":"user","text":"hello"}).to_string() + "\n",
    )
    .unwrap();
    let second = AdapterEngine::process_fixture_dir(&a, d.path())
        .unwrap()
        .remove(0);
    assert_eq!(first.session.id, second.session.id);
    assert!(first.messages[0].native_id.is_none());
    assert!(second.messages[0].native_id.is_some());
    assert_ne!(first.messages[0].id, second.messages[0].id);
}
