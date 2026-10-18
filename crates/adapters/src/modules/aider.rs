// Aider history module.
//
// The real format of .aider.chat.history.md (verified against the project's source, main branch,
// read 2026-10-12):
// - https://github.com/Aider-AI/aider/blob/main/aider/utils.py `split_chat_history_markdown`:
//   a line starting "> " is TOOL output, a line starting "#### " is the USER's input, a line starting
//   "# " is skipped, every other line belongs to the ASSISTANT's reply.
// - https://github.com/Aider-AI/aider/blob/main/aider/io.py: `user_input` writes "#### " + each input
//   line, `tool_output` / `tool_error` / `tool_warning` write "> " + text, `ai_output` writes the
//   reply as plain text, `__init__` writes "# aider chat started at YYYY-MM-DD HH:MM:SS".
// - https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py: `get_announcements`
//   ("Aider v...", "Main model: <name> with <fmt> edit format" or "Model: ..."), and
//   `calculate_and_show_tokens_and_cost` + `show_usage_report`: one "Tokens: <n> sent[, ...],
//   <n> received." tool line per message, with the per-message counters reset after each report.
//   Counts are rounded by format_tokens (8.1k, 12k), so token totals are approximate.
// - https://github.com/Aider-AI/aider/blob/main/aider/commands.py `cmd_run`: the output of /run is
//   shown in the terminal and is NOT written to the history file.
// - https://github.com/Aider-AI/aider/blob/main/aider/coders/editblock_prompts.py: a SEARCH/REPLACE
//   block is "the FULL file path alone on a line", the opening fence, "<<<<<<< SEARCH", the old text,
//   "=======", the new text, ">>>>>>> REPLACE", the closing fence.
// Also: https://aider.chat/docs/config/options.html, https://aider.chat/docs/install.html

use super::shared::{failed_file_batch, make_provenance};
use crate::adapter_spec::{AdapterDef, HistorySourceDef};
use crate::boundary::ReadBoundary;
use crate::credentials::is_credential_file;
use crate::engine::SourceContext;
use crate::model::{
    normalized_message_id, normalized_session_id, normalized_usage_id, stable_id, ContentBlock,
    ImportBatch, ImportMode, Message, NormalizedSession, ReadStatus, Session, SourceProvenance,
    Usage, UsageObservation, UsageSemantics,
};
use crate::readers::jsonl::ReaderError;
use chrono::NaiveDateTime;
use serde_json::json;
use std::path::Path;
use walkdir::WalkDir;

const HEADER: &str = "# aider chat started at ";

/// One batch per history file (RV-ADP). Each repository keeps its own .aider.chat.history.md, so
/// each file is its own source with its own provenance and checkpoint. A file that cannot be read
/// or is not UTF-8 is a Failed batch with a diagnostic instead of a silent skip inside a Complete
/// batch, and one repository's file can never change another's checkpoint.
pub fn parse_batches(
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    context: &SourceContext,
    boundary: &ReadBoundary,
    root: &Path,
) -> Result<Vec<ImportBatch>, Box<dyn std::error::Error>> {
    let mut batches = Vec::new();
    let mut files: Vec<(String, std::path::PathBuf)> = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                let relative = err
                    .path()
                    .and_then(|p| p.strip_prefix(root).ok())
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .filter(|p| !p.is_empty())
                    .unwrap_or_else(|| ".aider.chat.history.md".into());
                let io = ReaderError::Io(std::io::Error::other(err.to_string()));
                batches.push(failed_file_batch(adapter, source, context, &relative, &io));
                continue;
            }
        };
        let path = entry.path();
        if entry.file_type().is_dir() || is_credential_file(path) {
            continue;
        }
        let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if file_name.ends_with(".aider.chat.history.md") {
            let relative = path.strip_prefix(root)?.to_string_lossy().replace('\\', "/");
            files.push((relative, path.to_path_buf()));
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));

    for (relative, path) in files {
        let bytes = match boundary.read(&path) {
            Ok(b) => b,
            Err(e) => {
                batches.push(failed_file_batch(adapter, source, context, &relative, &e));
                continue;
            }
        };
        let content = match std::str::from_utf8(&bytes.bytes) {
            Ok(c) => c,
            Err(e) => {
                let e = ReaderError::Parse(format!("history is not valid UTF-8: {e}"));
                batches.push(failed_file_batch(adapter, source, context, &relative, &e));
                continue;
            }
        };
        let mut provenance = make_provenance(
            context,
            adapter,
            source,
            &relative,
            bytes.bytes.len() as u64,
            0,
            &crate::boundary::digest(&bytes.bytes),
        );
        if !context.store.canonical_root.starts_with("fixture://") {
            // A real store keeps the file's own identity (device and inode) so rotation is detected.
            provenance.file_identity = bytes.file_identity.clone();
        }
        let sessions = parse_history(adapter, &provenance, content);
        provenance.checkpoint.records = sessions.iter().map(|s| s.messages.len() as u64).sum();
        let sessions = sessions
            .into_iter()
            .map(|mut s| {
                s.session.provenance = provenance.clone();
                s
            })
            .collect();
        batches.push(ImportBatch {
            source: provenance,
            mode: ImportMode::Snapshot,
            read_status: ReadStatus::Complete,
            sessions,
            diagnostics: vec![],
            live_updates: vec![],
        });
    }
    Ok(batches)
}

fn parse_history(
    adapter: &AdapterDef,
    provenance: &SourceProvenance,
    content: &str,
) -> Vec<NormalizedSession> {
    let mut sessions = Vec::new();
    let mut header: Option<&str> = None;
    let mut body: Vec<&str> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut finish = |header: Option<&str>, body: &mut Vec<&str>, sessions: &mut Vec<NormalizedSession>| {
        if let Some(h) = header {
            if let Some(s) = build_session(adapter, provenance, h, body, &mut seen) {
                sessions.push(s);
            }
        }
        body.clear();
    };
    for line in content.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(rest) = line.trim_end().strip_prefix(HEADER) {
            finish(header, &mut body, &mut sessions);
            header = Some(rest);
        } else if header.is_some() {
            body.push(line);
        }
    }
    finish(header, &mut body, &mut sessions);
    sessions
}

fn parse_timestamp(date_str: &str) -> Option<i64> {
    // Aider writes local wall-clock time without a zone; it is read as UTC (unknown offset).
    NaiveDateTime::parse_from_str(date_str.trim(), "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|dt| dt.and_utc().timestamp_millis())
}

/// "8.1k" -> 8100, "640" -> 640, "12k" -> 12000 (aider's format_tokens rounds above 1000).
fn parse_token_count(s: &str) -> Option<u64> {
    let s = s.trim().to_ascii_lowercase();
    if let Some(num) = s.strip_suffix('k') {
        let n: f64 = num.parse().ok()?;
        Some((n * 1000.0).round() as u64)
    } else {
        s.parse().ok()
    }
}

/// "Tokens: 8.1k sent, 1.2k cache write, 640 received." -> (Some(8100), Some(640)).
fn parse_tokens_line(line: &str) -> Option<(Option<u64>, Option<u64>)> {
    let rest = line.trim().strip_prefix("Tokens:")?;
    // A priced model appends " Cost: $x message, $y session." to the same line.
    let rest = rest.split(" Cost:").next().unwrap_or(rest);
    let (mut sent, mut received) = (None, None);
    for part in rest.split(',') {
        let part = part.trim().trim_end_matches('.');
        if let Some(n) = part.strip_suffix(" sent") {
            sent = parse_token_count(n);
        } else if let Some(n) = part.strip_suffix(" received") {
            received = parse_token_count(n);
        }
    }
    (sent.is_some() || received.is_some()).then_some((sent, received))
}

/// "Main model: gpt-5.1 with diff edit format, ..." or "Model: ..." -> "gpt-5.1".
fn parse_model_announcement(line: &str) -> Option<String> {
    let rest = line
        .trim()
        .strip_prefix("Main model: ")
        .or_else(|| line.trim().strip_prefix("Model: "))?;
    let name = rest.split(" with ").next()?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    None,
    User,
    Tool,
    Assistant,
}

struct Event {
    mode: Mode,
    lines: Vec<String>,
}

/// Splits a session's lines into user, tool and assistant events the way aider's own
/// `split_chat_history_markdown` does, with two refinements: lines inside an assistant code fence
/// stay assistant text (code comments start with "# " and diffs may start with "> "), and a "# "
/// line inside an assistant reply is kept.
fn split_events(lines: &[&str]) -> Vec<Event> {
    let mut events: Vec<Event> = Vec::new();
    let mut mode = Mode::None;
    let mut buf: Vec<String> = Vec::new();
    let mut in_fence = false;
    let flush = |mode: Mode, buf: &mut Vec<String>, events: &mut Vec<Event>| {
        if mode != Mode::None && buf.iter().any(|l| !l.trim().is_empty()) {
            events.push(Event { mode, lines: std::mem::take(buf) });
        }
        buf.clear();
    };
    for raw in lines {
        let line = *raw;
        if mode == Mode::Assistant && in_fence {
            buf.push(line.trim_end().to_string());
            if line.trim_start().starts_with("```") {
                in_fence = false;
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("> ").or_else(|| (line.trim_end() == ">").then_some("")) {
            if mode != Mode::Tool {
                flush(mode, &mut buf, &mut events);
                mode = Mode::Tool;
            }
            buf.push(rest.trim_end().to_string());
            continue;
        }
        if let Some(rest) = line.strip_prefix("#### ").or_else(|| (line.trim_end() == "####").then_some("")) {
            if mode != Mode::User {
                flush(mode, &mut buf, &mut events);
                mode = Mode::User;
            }
            buf.push(rest.trim_end().to_string());
            continue;
        }
        if line.trim().is_empty() {
            match mode {
                Mode::User | Mode::Tool => {
                    flush(mode, &mut buf, &mut events);
                    mode = Mode::None;
                }
                Mode::Assistant => buf.push(String::new()),
                Mode::None => {}
            }
            continue;
        }
        if mode == Mode::Tool && line.starts_with("Cost: $") {
            // With cache write and cache hit tokens the report spans two lines and io.tool_output
            // blockquotes only the first, so the cost line follows the "> Tokens:" line bare.
            buf.push(line.trim_end().to_string());
            continue;
        }
        if line.starts_with("# ") && mode != Mode::Assistant {
            continue;
        }
        if mode != Mode::Assistant {
            flush(mode, &mut buf, &mut events);
            mode = Mode::Assistant;
        }
        if line.trim_start().starts_with("```") {
            in_fence = true;
        }
        buf.push(line.trim_end().to_string());
    }
    flush(mode, &mut buf, &mut events);
    events
}

fn build_session(
    adapter: &AdapterDef,
    provenance: &SourceProvenance,
    date_part: &str,
    lines: &[&str],
    seen: &mut Vec<String>,
) -> Option<NormalizedSession> {
    let date_part = date_part.trim();
    let started_at = parse_timestamp(date_part);
    // A session is identified by its file and start time: two repositories can start a session in
    // the same second, and one file can restart within a second.
    let mut native_id = format!("{}#{}", provenance.source_path, date_part);
    let mut n = 1;
    while seen.contains(&native_id) {
        n += 1;
        native_id = format!("{}#{}#{}", provenance.source_path, date_part, n);
    }
    seen.push(native_id.clone());
    let session_id = normalized_session_id(&provenance.store.id, Some(&native_id), &provenance.source_path);

    let mut messages: Vec<Message> = Vec::new();
    let mut observations: Vec<UsageObservation> = Vec::new();
    let mut model: Option<String> = None;

    for event in split_events(lines) {
        let seq = (messages.len() + 1) as u32;
        let msg_id = normalized_message_id(&session_id, None, &provenance.key(), provenance.generation, seq);
        let at = if seq == 1 { started_at } else { None };
        let text = event.lines.join("\n").trim().to_string();
        let (role, blocks) = match event.mode {
            Mode::User => {
                let mut blocks = vec![ContentBlock::Text { text: text.clone() }];
                if let Some(cmd) = text.strip_prefix("/run ").filter(|c| !text.contains('\n') && !c.trim().is_empty()) {
                    // The command itself is in the history; its output is not (aider's /run prints
                    // it to the terminal only), so the call carries no result.
                    blocks.push(ContentBlock::ToolCall {
                        call_id: stable_id("tool", &[&format!("{}:block:{}", provenance.key(), seq)]),
                        native_id: None,
                        name: "run_command".into(),
                        input: json!({ "command": cmd.trim() }),
                        files: vec![],
                    });
                }
                if let Some(m) = text.strip_prefix("/model ").map(str::trim).filter(|m| !m.is_empty() && !m.contains('\n')) {
                    model = Some(m.to_string());
                }
                ("user", blocks)
            }
            Mode::Tool => {
                for l in &event.lines {
                    if let Some(m) = parse_model_announcement(l) {
                        model = Some(m);
                    }
                    if let Some((sent, received)) = parse_tokens_line(l) {
                        observations.push(UsageObservation {
                            event_id: normalized_usage_id(&session_id, None, &provenance.key(), provenance.generation, seq),
                            semantics: UsageSemantics::Delta,
                            input_tokens: sent,
                            output_tokens: received,
                            at: None,
                        });
                    }
                }
                ("system", vec![ContentBlock::Text { text }])
            }
            Mode::Assistant => ("assistant", parse_assistant_blocks(&text, &provenance.key(), seq)),
            Mode::None => continue,
        };
        messages.push(Message {
            id: msg_id,
            session_id: session_id.clone(),
            native_id: None,
            seq,
            role: role.into(),
            at,
            blocks,
        });
    }

    if messages.is_empty() {
        return None;
    }
    let turns = messages
        .iter()
        .filter(|m| {
            m.role == "user"
                && m.blocks.iter().any(|b| matches!(b, ContentBlock::Text { .. } | ContentBlock::Code { .. }))
        })
        .count() as u32;
    // Usage events within one message never repeat an id; messages cannot share a seq.
    observations.dedup_by(|a, b| a.event_id == b.event_id);
    let usage = Usage::from_observations(observations).unwrap_or_default();

    Some(NormalizedSession {
        session: Session {
            id: session_id,
            agent_id: adapter.id.clone(),
            installation_id: None,
            native_id: Some(native_id),
            provenance: provenance.clone(),
            project_root: None,
            title: None,
            started_at,
            ended_at: None,
            model,
            // Aider's history carries no end marker, so completion stays unknown (CONTRACT.md).
            status: "unknown".into(),
            completion: None,
            turns,
            usage,
            parent_id: None,
            native_parent_id: None,
        },
        messages,
    })
}

// ---- SEARCH/REPLACE blocks (aider/coders/editblock_coder.py: HEAD, DIVIDER, UPDATED, find_filename)

fn is_head(line: &str) -> bool {
    let t = line.trim();
    let n = t.chars().take_while(|c| *c == '<').count();
    (5..=9).contains(&n) && matches!(&t[n..], " SEARCH" | " SEARCH>")
}
fn is_divider(line: &str) -> bool {
    let t = line.trim();
    (5..=9).contains(&t.len()) && t.chars().all(|c| c == '=')
}
fn is_updated(line: &str) -> bool {
    let t = line.trim();
    let n = t.chars().take_while(|c| *c == '>').count();
    (5..=9).contains(&n) && &t[n..] == " REPLACE"
}

/// A file name from one line before a block, like aider's `strip_filename`.
fn filename_from(line: &str) -> Option<String> {
    let t = line.trim();
    if t.starts_with("```") {
        let c = t.trim_start_matches('`');
        return (c.contains('.') || c.contains('/')).then(|| c.to_string());
    }
    let c = t.trim_end_matches(':').trim_matches(|c| c == '`' || c == '*' || c == '#').trim();
    // Aider checks the name against the files in the chat; the history has no such list, so a
    // name must look like a path (a dot or a slash inside, not a sentence ending).
    let looks_like_path = (c.contains('.') || c.contains('/')) && !c.ends_with('.');
    (looks_like_path && c != "..." && !c.contains(char::is_whitespace)).then(|| c.to_string())
}

fn parse_assistant_blocks(text: &str, source_key: &str, seq: u32) -> Vec<ContentBlock> {
    let lines: Vec<&str> = text.lines().collect();
    let mut blocks = Vec::new();
    let mut prose: Vec<&str> = Vec::new();
    let mut current_file: Option<String> = None;
    let mut block_idx = 0;
    let mut i = 0;
    let flush_prose = |prose: &mut Vec<&str>, blocks: &mut Vec<ContentBlock>| {
        let t = prose.join("\n").trim().to_string();
        if !t.is_empty() {
            blocks.push(ContentBlock::Text { text: t });
        }
        prose.clear();
    };
    while i < lines.len() {
        if is_head(lines[i]) {
            let divider = (i + 1..lines.len()).find(|&j| is_divider(lines[j]));
            let updated = divider.and_then(|d| (d + 1..lines.len()).find(|&j| is_updated(lines[j])));
            if let Some(end) = updated {
                // Look back over at most three lines: fences, then the file name.
                let mut file = None;
                let mut keep = prose.len();
                let mut k = prose.len();
                let mut steps = 0;
                while steps < 3 && k > 0 {
                    let l = prose[k - 1];
                    k -= 1;
                    steps += 1;
                    if let Some(f) = filename_from(l) {
                        file = Some(f);
                        keep = k;
                        break;
                    }
                    if !l.trim_start().starts_with("```") {
                        break;
                    }
                    keep = k; // an opening fence belongs to the block, not the reply text
                }
                prose.truncate(keep);
                flush_prose(&mut prose, &mut blocks);
                let path = file.or_else(|| current_file.clone());
                current_file = path.clone();
                let diff = lines[i..=end].join("\n");
                let call_id = stable_id("tool", &[&format!("{source_key}:block:{seq}:{block_idx}")]);
                blocks.push(ContentBlock::ToolCall {
                    call_id,
                    native_id: None,
                    name: "edit_file".into(),
                    input: json!({ "path": path.clone().unwrap_or_default(), "diff": diff }),
                    files: path.into_iter().collect(),
                });
                block_idx += 1;
                i = end + 1;
                if lines.get(i).is_some_and(|l| l.trim() == "```") {
                    i += 1; // the block's closing fence
                }
                continue;
            }
        }
        prose.push(lines[i]);
        i += 1;
    }
    flush_prose(&mut prose, &mut blocks);
    blocks
}
