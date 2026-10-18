//! RV-ADP: Amp read failures and Aider's real history format.
//!
//! Aider evidence (https://github.com/Aider-AI/aider, main, read 2026-10-12):
//! - aider/utils.py `split_chat_history_markdown`: lines starting "> " are tool output, lines starting
//!   "#### " are the user's input, every other line is the assistant's reply.
//! - aider/io.py `user_input` writes "#### " + input; `tool_output` writes "> " + text.
//! - aider/coders/base_coder.py `calculate_and_show_tokens_and_cost` / `show_usage_report`: one
//!   "Tokens: <n> sent, <n> received." tool line per message, counters reset after each report.
//!   `get_announcements`: "Main model: <name> with <format> edit format" (or "Model: ...").
//! - aider/coders/editblock_prompts.py: a SEARCH/REPLACE block is the file path alone on a line, then
//!   the opening fence, then "<<<<<<< SEARCH".

use orrery_adapters::adapter_spec::AdapterDef;
use orrery_adapters::engine::AdapterEngine;
use orrery_adapters::get_builtin_adapter;
use orrery_adapters::model::{ContentBlock, ImportBatch, ReadStatus, UsageSemantics};
use std::fs;
use std::path::Path;
use tempfile::tempdir;

fn batches(id: &str, root: &Path) -> Vec<ImportBatch> {
    let adapter: AdapterDef = get_builtin_adapter(id).unwrap();
    AdapterEngine::fixture_batches(&adapter, root).unwrap()
}

fn text_of(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------------------------------------------------------------- Amp

fn amp_thread(id: &str, text: &str) -> String {
    format!(
        r#"{{"id":"{id}","created":1791800000000,"messages":[{{"role":"user","messageId":0,"content":"{text}"}},{{"role":"assistant","messageId":1,"content":[{{"type":"text","text":"ok"}}]}}]}}"#
    )
}

#[test]
fn amp_each_thread_is_its_own_batch_with_its_own_provenance() {
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join("threads")).unwrap();
    fs::write(d.path().join("threads/T-aaa.json"), amp_thread("T-aaa", "first")).unwrap();
    fs::write(d.path().join("threads/T-bbb.json"), amp_thread("T-bbb", "second")).unwrap();
    let b = batches("amp", d.path());
    assert_eq!(b.len(), 2, "one batch per thread file");
    assert_eq!(b[0].source.source_path, "threads/T-aaa.json");
    assert_eq!(b[1].source.source_path, "threads/T-bbb.json");
    for batch in &b {
        assert_eq!(batch.read_status, ReadStatus::Complete);
        assert_eq!(batch.sessions.len(), 1);
        assert_eq!(batch.sessions[0].session.provenance, batch.source);
    }
}

#[test]
fn amp_deleting_a_thread_does_not_change_the_other_threads_batch() {
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join("threads")).unwrap();
    fs::write(d.path().join("threads/T-aaa.json"), amp_thread("T-aaa", "first")).unwrap();
    fs::write(d.path().join("threads/T-bbb.json"), amp_thread("T-bbb", "second")).unwrap();
    let before = batches("amp", d.path());
    fs::remove_file(d.path().join("threads/T-aaa.json")).unwrap();
    let after = batches("amp", d.path());
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].source, before[1].source, "an untouched thread keeps its checkpoint");
}

#[cfg(unix)]
#[test]
fn amp_unreadable_thread_is_a_failed_batch_with_a_diagnostic_never_complete() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join("threads")).unwrap();
    fs::write(d.path().join("threads/T-ok.json"), amp_thread("T-ok", "fine")).unwrap();
    let locked = d.path().join("threads/T-locked.json");
    fs::write(&locked, amp_thread("T-locked", "secret")).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let b = batches("amp", d.path());
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(b.len(), 2, "the unreadable thread is reported, not skipped");
    let failed: Vec<_> = b.iter().filter(|x| x.read_status != ReadStatus::Complete).collect();
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].source.source_path, "threads/T-locked.json");
    assert!(failed[0].sessions.is_empty());
    assert_eq!(failed[0].diagnostics.len(), 1);
    assert_eq!(failed[0].diagnostics[0].source_key, failed[0].source.key());
    let ok = b.iter().find(|x| x.read_status == ReadStatus::Complete).unwrap();
    assert_eq!(ok.sessions[0].session.native_id.as_deref(), Some("T-ok"));
}

#[test]
fn amp_malformed_thread_is_a_failed_batch_with_a_parse_diagnostic() {
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join("threads")).unwrap();
    fs::write(d.path().join("threads/T-ok.json"), amp_thread("T-ok", "fine")).unwrap();
    fs::write(d.path().join("threads/T-broken.json"), "{\"id\": \"T-broken\", \"messages\": [").unwrap();
    fs::write(d.path().join("threads/T-noid.json"), "{\"messages\": []}").unwrap();
    let b = batches("amp", d.path());
    assert_eq!(b.len(), 3);
    for name in ["threads/T-broken.json", "threads/T-noid.json"] {
        let f = b.iter().find(|x| x.source.source_path == name).unwrap();
        assert_eq!(f.read_status, ReadStatus::Failed, "{name}");
        assert_eq!(f.diagnostics[0].code, "parse", "{name}");
        assert!(f.sessions.is_empty());
    }
}

// ---------------------------------------------------------------- Aider

const REAL_HISTORY: &str = "\n# aider chat started at 2026-10-12 15:04:22\n\n\
> Aider v0.86.2  \n\
> Main model: gpt-5.1 with diff edit format  \n\
> Git repo: .git with 12 files  \n\n\
#### Add a latin-1 fallback for CSV files in src/loader.py.  \n\n\
I'll try utf-8 first and fall back to latin-1.\n\n\
src/loader.py\n\
```python\n\
<<<<<<< SEARCH\n\
    text = path.read_text(encoding=\"utf-8\")\n\
=======\n\
    try:\n\
        # fall back when the file is not utf-8\n\
        text = path.read_text(encoding=\"utf-8\")\n\
    except UnicodeDecodeError:\n\
        text = path.read_text(encoding=\"latin-1\")\n\
>>>>>>> REPLACE\n\
```\n\n\
> Applied edit to src/loader.py  \n\
> Tokens: 8.1k sent, 640 received.  \n\n\
#### /run pytest -q  \n\n\
> Added 3 lines of output to the chat.  \n\n\
#### Thanks, that works.  \n\
#### Please also add a test.  \n\n\
Done, see tests/test_loader.py.\n\n\
> Tokens: 9.4k sent, 410 received.  \n";

fn write_history(root: &Path, rel: &str, body: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, body).unwrap();
}

#[test]
fn aider_user_input_is_the_hash_lines_and_greater_than_lines_are_tool_output() {
    let d = tempdir().unwrap();
    write_history(d.path(), "repo/.aider.chat.history.md", REAL_HISTORY);
    let b = batches("aider", d.path());
    assert_eq!(b.len(), 1);
    assert_eq!(b[0].read_status, ReadStatus::Complete);
    let s = &b[0].sessions[0];
    let user: Vec<String> = s.messages.iter().filter(|m| m.role == "user").map(|m| text_of(&m.blocks)).collect();
    assert_eq!(
        user,
        vec![
            "Add a latin-1 fallback for CSV files in src/loader.py.".to_string(),
            "/run pytest -q".to_string(),
            "Thanks, that works.\nPlease also add a test.".to_string(),
        ]
    );
    assert_eq!(s.session.turns, 3);
    let assistant: Vec<String> = s.messages.iter().filter(|m| m.role == "assistant").map(|m| text_of(&m.blocks)).collect();
    assert!(assistant.iter().any(|t| t.contains("fall back to latin-1")), "{assistant:?}");
    assert!(assistant.iter().any(|t| t.contains("Done, see tests/test_loader.py")));
    for t in &assistant {
        assert!(!t.contains("Aider v0.86.2") && !t.contains("Tokens:"), "tool output leaked into a reply: {t}");
    }
    for m in s.messages.iter().filter(|m| m.role == "user") {
        assert!(!text_of(&m.blocks).contains("Applied edit"), "tool output leaked into a prompt");
    }
    // tool lines are kept as system notes, one message per consecutive run
    let system: Vec<String> = s.messages.iter().filter(|m| m.role == "system").map(|m| text_of(&m.blocks)).collect();
    assert!(system.iter().any(|t| t.contains("Aider v0.86.2") && t.contains("Git repo: .git with 12 files")), "{system:?}");
    assert!(system.iter().any(|t| t.contains("Added 3 lines of output")));
}

#[test]
fn aider_search_replace_block_names_its_file_from_the_line_before_the_fence() {
    let d = tempdir().unwrap();
    write_history(d.path(), "repo/.aider.chat.history.md", REAL_HISTORY);
    let s = &batches("aider", d.path())[0].sessions[0];
    let calls: Vec<_> = s
        .messages
        .iter()
        .flat_map(|m| m.blocks.iter())
        .filter_map(|b| match b {
            ContentBlock::ToolCall { name, files, input, .. } => Some((name.clone(), files.clone(), input.clone())),
            _ => None,
        })
        .collect();
    let edit = calls.iter().find(|c| c.0 == "edit_file").expect("an edit_file call");
    assert_eq!(edit.1, vec!["src/loader.py".to_string()]);
    assert_eq!(edit.2["path"], "src/loader.py");
    let diff = edit.2["diff"].as_str().unwrap();
    assert!(diff.starts_with("<<<<<<< SEARCH") && diff.trim_end().ends_with(">>>>>>> REPLACE"));
    assert!(diff.contains("# fall back when the file is not utf-8"), "a code comment line must survive");
    // the filename line and the fences are not repeated in the reply text
    let reply = s.messages.iter().find(|m| m.role == "assistant").unwrap();
    assert!(!text_of(&reply.blocks).contains("```") && !text_of(&reply.blocks).contains("src/loader.py\n"));
}

#[test]
fn aider_token_lines_are_per_message_deltas_and_the_model_comes_from_the_banner() {
    let d = tempdir().unwrap();
    write_history(d.path(), "repo/.aider.chat.history.md", REAL_HISTORY);
    let s = &batches("aider", d.path())[0].sessions[0];
    assert_eq!(s.session.model.as_deref(), Some("gpt-5.1"));
    assert_eq!(s.session.usage.semantics, UsageSemantics::Delta);
    assert_eq!(s.session.usage.observations.len(), 2);
    assert_eq!(s.session.usage.input_tokens, Some(8_100 + 9_400));
    assert_eq!(s.session.usage.output_tokens, Some(640 + 410));
}

#[test]
fn aider_slash_model_command_sets_the_model() {
    let d = tempdir().unwrap();
    write_history(
        d.path(),
        ".aider.chat.history.md",
        "\n# aider chat started at 2026-10-12 09:00:00\n\n#### /model gpt-4.1  \n\n#### hello  \n\nhi there\n",
    );
    let s = &batches("aider", d.path())[0].sessions[0];
    assert_eq!(s.session.model.as_deref(), Some("gpt-4.1"));
}

#[test]
fn aider_histories_in_several_repos_are_separate_complete_batches_with_distinct_sessions() {
    let d = tempdir().unwrap();
    // Two repos whose sessions started in the same second: ids must still differ.
    write_history(d.path(), "alpha/.aider.chat.history.md", REAL_HISTORY);
    write_history(d.path(), "beta/.aider.chat.history.md", REAL_HISTORY);
    let b = batches("aider", d.path());
    assert_eq!(b.len(), 2);
    assert_eq!(b[0].source.source_path, "alpha/.aider.chat.history.md");
    assert_eq!(b[1].source.source_path, "beta/.aider.chat.history.md");
    for batch in &b {
        assert_eq!(batch.read_status, ReadStatus::Complete);
        assert_eq!(batch.sessions[0].session.provenance, batch.source, "session provenance equals its batch");
    }
    assert_ne!(b[0].sessions[0].session.id, b[1].sessions[0].session.id);
}

#[test]
fn aider_unreadable_history_is_a_failed_batch_not_a_silent_skip() {
    let d = tempdir().unwrap();
    write_history(d.path(), "good/.aider.chat.history.md", REAL_HISTORY);
    let bad = d.path().join("bad/.aider.chat.history.md");
    fs::create_dir_all(bad.parent().unwrap()).unwrap();
    fs::write(&bad, [0xff_u8, 0xfe, 0x00, 0x23, 0x20]).unwrap();
    let b = batches("aider", d.path());
    assert_eq!(b.len(), 2);
    let failed = b.iter().find(|x| x.source.source_path == "bad/.aider.chat.history.md").unwrap();
    assert_eq!(failed.read_status, ReadStatus::Failed);
    assert_eq!(failed.diagnostics[0].code, "parse");
    let good = b.iter().find(|x| x.source.source_path == "good/.aider.chat.history.md").unwrap();
    assert_eq!(good.read_status, ReadStatus::Complete);
}

#[test]
fn aider_token_line_with_a_cost_report_still_yields_sent_and_received() {
    // base_coder.calculate_and_show_tokens_and_cost: for a priced model the report is
    // "Tokens: ... received. Cost: $x message, $y session." (separator " "), or with "\n" when both
    // cache write and cache hit tokens are present, in which case only the first line is blockquoted
    // (io.tool_output), so a bare "Cost:" line follows the "> Tokens:" line.
    let d = tempdir().unwrap();
    write_history(
        d.path(),
        ".aider.chat.history.md",
        "\n# aider chat started at 2026-10-12 09:00:00\n\n#### hello  \n\nhi there\n\n\
> Tokens: 8.1k sent, 640 received. Cost: $0.02 message, $0.10 session.  \n\n\
#### again  \n\nsure\n\n\
> Tokens: 12k sent, 2.0k cache write, 3.0k cache hit, 410 received.\n\
Cost: $0.03 message, $0.13 session.  \n",
    );
    let s = &batches("aider", d.path())[0].sessions[0];
    assert_eq!(s.session.usage.input_tokens, Some(8_100 + 12_000));
    assert_eq!(s.session.usage.output_tokens, Some(640 + 410));
    let replies: Vec<String> = s.messages.iter().filter(|m| m.role == "assistant").map(|m| text_of(&m.blocks)).collect();
    assert_eq!(replies, vec!["hi there".to_string(), "sure".to_string()], "a Cost line is not a reply");
}
