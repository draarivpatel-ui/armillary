//! RV-ADP: Claude Code tool calls must list the files they touch.
//!
//! Evidence for the real input keys: Claude Agent SDK docs, "Tool Input Types"
//! (https://code.claude.com/docs/en/agent-sdk/typescript): Read, Edit and Write take `file_path`,
//! NotebookEdit takes `notebook_path`, Glob and Grep take an optional `path` search root.

use orrery_adapters::adapter_spec::AdapterDef;
use orrery_adapters::engine::AdapterEngine;
use orrery_adapters::get_builtin_adapter;
use orrery_adapters::model::ContentBlock;
use serde_json::json;
use std::collections::BTreeMap;
use tempfile::tempdir;

fn assistant_line(uuid: &str, blocks: serde_json::Value) -> String {
    json!({
        "type": "assistant", "uuid": uuid, "sessionId": "adp-sess-1",
        "timestamp": "2026-10-12T14:10:05.000Z", "cwd": "/Users/developer/code/app",
        "message": {"role": "assistant", "model": "claude-sonnet-5-5", "content": blocks,
                    "usage": {"input_tokens": 10, "output_tokens": 5}}
    })
    .to_string()
}

fn tool_use(id: &str, name: &str, input: serde_json::Value) -> serde_json::Value {
    json!({"type": "tool_use", "id": id, "name": name, "input": input})
}

/// Imports the lines through the real builtin claude-code adapter; returns tool name -> files.
fn files_by_tool(adapter: &AdapterDef, lines: &[String]) -> BTreeMap<String, Vec<String>> {
    let dir = tempdir().unwrap();
    let proj = dir.path().join("projects/app");
    std::fs::create_dir_all(&proj).unwrap();
    std::fs::write(proj.join("s.jsonl"), lines.join("\n") + "\n").unwrap();
    let sessions = AdapterEngine::process_fixture_dir(adapter, dir.path()).unwrap();
    assert_eq!(sessions.len(), 1);
    let mut out = BTreeMap::new();
    for m in &sessions[0].messages {
        for b in &m.blocks {
            if let ContentBlock::ToolCall { name, files, .. } = b {
                out.insert(name.clone(), files.clone());
            }
        }
    }
    out
}

#[test]
fn claude_code_tool_calls_list_the_files_they_touch() {
    let adapter = get_builtin_adapter("claude-code").expect("builtin claude-code");
    let line = assistant_line(
        "a1",
        json!([
            tool_use("t1", "Read", json!({"file_path": "/Users/developer/code/app/src/main.rs", "limit": 50})),
            tool_use("t2", "Edit", json!({"file_path": "/Users/developer/code/app/src/lib.rs", "old_string": "a", "new_string": "b"})),
            tool_use("t3", "Write", json!({"file_path": "/Users/developer/code/app/NOTES.md", "content": "x"})),
            tool_use("t4", "NotebookEdit", json!({"notebook_path": "/Users/developer/code/app/lab.ipynb", "new_source": "1", "cell_id": "c1"})),
            tool_use("t5", "Glob", json!({"pattern": "**/*.rs", "path": "/Users/developer/code/app/src"})),
            tool_use("t6", "Grep", json!({"pattern": "TODO", "path": "/Users/developer/code/app"})),
            tool_use("t7", "Bash", json!({"command": "cargo test"})),
        ]),
    );
    let got = files_by_tool(&adapter, &[line]);
    let one = |p: &str| vec![p.to_string()];
    assert_eq!(got["Read"], one("/Users/developer/code/app/src/main.rs"));
    assert_eq!(got["Edit"], one("/Users/developer/code/app/src/lib.rs"));
    assert_eq!(got["Write"], one("/Users/developer/code/app/NOTES.md"));
    assert_eq!(got["NotebookEdit"], one("/Users/developer/code/app/lab.ipynb"));
    assert_eq!(got["Glob"], one("/Users/developer/code/app/src"));
    assert_eq!(got["Grep"], one("/Users/developer/code/app"));
    assert_eq!(got["Bash"], Vec::<String>::new(), "a shell command has no mapped file");
}

#[test]
fn claude_code_optional_path_absent_means_no_files() {
    let adapter = get_builtin_adapter("claude-code").expect("builtin claude-code");
    let line = assistant_line("a1", json!([tool_use("t8", "Glob", json!({"pattern": "*.toml"}))]));
    let got = files_by_tool(&adapter, &[line]);
    assert_eq!(got["Glob"], Vec::<String>::new());
}

#[test]
fn claude_code_mapping_change_bumps_the_adapter_version() {
    let adapter = get_builtin_adapter("claude-code").expect("builtin claude-code");
    assert_eq!(adapter.adapter_version, "1.1.0");
}

#[test]
fn mapping_accepts_several_file_pointers_in_order_without_duplicates() {
    let toml = r#"
id = "adp-multi"
name = "Multi"
vendor = "t"
family = "t"
kind = "cli"
adapter_version = "1.0.0"
[[history_sources]]
id = "s"
format = "jsonl"
source_unit = "file_per_session"
fixture_paths = ["*.jsonl"]
[history_sources.mapping.session]
id = "/sessionId"
[history_sources.mapping.records]
type_pointer = "/type"
[history_sources.mapping.records.messages]
role_pointer = "/message/role"
text_pointer = "/message/content"
text_transform = "content_array"
[history_sources.mapping.records.tool_calls]
call_id_pointer = "/id"
content_array_pointer = "/message/content"
filter_type = "tool_use"
name_pointer = "/name"
input_pointer = "/input"
files_pointers = ["/input/a", "/input/b", "/input/c"]
"#;
    let adapter = AdapterDef::from_toml(toml).expect("files_pointers must be a supported mapping field");
    let dir = tempdir().unwrap();
    let line = json!({"type": "assistant", "sessionId": "s1", "message": {"role": "assistant", "content": [
        tool_use("t1", "x", json!({"a": "one", "b": "one", "c": ["two", "three"]}))
    ]}});
    std::fs::write(dir.path().join("s.jsonl"), line.to_string() + "\n").unwrap();
    let sessions = AdapterEngine::process_fixture_dir(&adapter, dir.path()).unwrap();
    let files: Vec<_> = sessions[0].messages.iter().flat_map(|m| m.blocks.iter()).filter_map(|b| match b {
        ContentBlock::ToolCall { files, .. } => Some(files.clone()),
        _ => None,
    }).collect();
    assert_eq!(files, vec![vec!["one".to_string(), "two".into(), "three".into()]]);
}

#[test]
fn file_pointers_must_be_json_pointers() {
    let toml = r#"
id = "adp-bad"
name = "Bad"
vendor = "t"
family = "t"
kind = "cli"
adapter_version = "1.0.0"
[[history_sources]]
id = "s"
format = "jsonl"
fixture_paths = ["*.jsonl"]
[history_sources.mapping.records.tool_calls]
files_pointers = ["input.path"]
"#;
    assert!(AdapterDef::from_toml(toml).is_err(), "a pointer without a leading slash must be refused");
}

#[test]
fn claude_code_thinking_and_image_blocks_do_not_fail_the_transcript() {
    let adapter = get_builtin_adapter("claude-code").expect("builtin claude-code");
    let thinking = assistant_line(
        "a1",
        json!([
            {"type": "thinking", "thinking": "plan the change", "signature": "c2lnbmF0dXJl"},
            {"type": "redacted_thinking", "data": "ZW5jcnlwdGVk"},
            {"type": "text", "text": "Done."},
        ]),
    );
    let image = json!({
        "type": "user", "uuid": "u1", "sessionId": "adp-sess-1",
        "timestamp": "2026-10-12T14:10:00.000Z", "cwd": "/Users/developer/code/app",
        "message": {"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgoCANARY"}},
            {"type": "text", "text": "What is wrong here?"},
        ]}
    })
    .to_string();
    let dir = tempdir().unwrap();
    let proj = dir.path().join("projects/app");
    std::fs::create_dir_all(&proj).unwrap();
    std::fs::write(proj.join("s.jsonl"), format!("{image}\n{thinking}\n")).unwrap();
    let sessions = AdapterEngine::process_fixture_dir(&adapter, dir.path()).unwrap();
    assert_eq!(sessions.len(), 1);
    let blocks: Vec<&ContentBlock> = sessions[0].messages.iter().flat_map(|m| &m.blocks).collect();
    assert!(matches!(
        blocks[0],
        ContentBlock::Attachment { mime_type: Some(m), .. } if m == "image/png"
    ), "{blocks:?}");
    assert_eq!(blocks.len(), 3, "{blocks:?}");
    let all = format!("{blocks:?}");
    assert!(!all.contains("CANARY") && !all.contains("plan the change"), "{all}");
}
