//! RV-ADP: Gemini CLI tool calls keep their arguments in `args` and their output in `result`.
//!
//! Evidence: google-gemini/gemini-cli, packages/core/src/services/chatRecordingTypes.ts (main, read
//! 2026-10-12): `interface ToolCallRecord { id; name; args: Record<string, unknown>; result?:
//! PartListUnion | null; status: Status; timestamp; ... }`, carried on `type: 'gemini'` messages as
//! `toolCalls?: ToolCallRecord[]`. File tool parameters (packages/core/src/tools/read-file.ts,
//! write-file.ts, edit.ts): `file_path: string`.

use orrery_adapters::engine::AdapterEngine;
use orrery_adapters::get_builtin_adapter;
use orrery_adapters::model::ContentBlock;
use serde_json::json;
use tempfile::tempdir;

#[test]
fn gemini_tool_calls_read_args_result_and_file_path() {
    let adapter = get_builtin_adapter("gemini-cli").unwrap();
    let dir = tempdir().unwrap();
    let chats = dir.path().join("tmp/abc/chats");
    std::fs::create_dir_all(&chats).unwrap();
    let header = json!({"sessionId": "g1", "projectHash": "abc", "startTime": "2026-10-12T14:10:00.000Z",
                        "lastUpdated": "2026-10-12T14:10:15.000Z", "kind": "main"});
    let response = json!([{"functionResponse": {"id": "call-1", "name": "read_file",
                                                "response": {"output": "[package]\nname = \"demo\"\n"}}}]);
    let message = json!({
        "id": "m1", "timestamp": "2026-10-12T14:10:05.000Z", "type": "gemini", "model": "gemini-2.5-pro",
        "content": "Reading Cargo.toml.",
        "toolCalls": [{"id": "call-1", "name": "read_file", "args": {"file_path": "/work/demo/Cargo.toml"},
                       "result": response.clone(), "status": "success", "timestamp": "2026-10-12T14:10:06.000Z"},
                      {"id": "call-2", "name": "run_shell_command", "args": {"command": "cargo test"},
                       "status": "success", "timestamp": "2026-10-12T14:10:07.000Z"}]
    });
    std::fs::write(
        chats.join("session-2026-10-12T14-10-aaaa.jsonl"),
        format!("{header}\n{message}\n"),
    )
    .unwrap();
    let sessions = AdapterEngine::process_fixture_dir(&adapter, dir.path()).unwrap();
    let blocks: Vec<&ContentBlock> = sessions[0].messages.iter().flat_map(|m| m.blocks.iter()).collect();
    let calls: Vec<_> = blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::ToolCall { call_id, name, input, files, .. } => Some((call_id.clone(), name.clone(), input.clone(), files.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].1, "read_file");
    assert_eq!(calls[0].2, json!({"file_path": "/work/demo/Cargo.toml"}), "arguments come from args");
    assert_eq!(calls[0].3, vec!["/work/demo/Cargo.toml".to_string()]);
    assert_eq!(calls[1].2, json!({"command": "cargo test"}));
    assert!(calls[1].3.is_empty());
    let results: Vec<_> = blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::ToolResult { call_id, output, .. } => Some((call_id.clone(), output.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(results.len(), 1, "only the call that has a result gets a result block");
    assert_eq!(results[0].0, calls[0].0, "the result answers its call");
    assert_eq!(results[0].1, response, "output comes from result");
}

#[test]
fn gemini_mapping_change_bumps_the_adapter_version() {
    assert_eq!(get_builtin_adapter("gemini-cli").unwrap().adapter_version, "0.2.0-unverified");
}
