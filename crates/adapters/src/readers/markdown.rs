use crate::{boundary::ReadBoundary, readers::jsonl::ReaderError};
use serde_json::{json, Value};
use std::path::Path;
pub fn read_markdown(boundary: &ReadBoundary, path: &Path) -> Result<Value, ReaderError> {
    parse_markdown(&boundary.read(path)?.bytes)
}
pub fn parse_markdown(bytes: &[u8]) -> Result<Value, ReaderError> {
    let text = std::str::from_utf8(bytes).map_err(|e| ReaderError::Parse(e.to_string()))?;
    let mut title = String::new();
    let mut role = String::new();
    let mut body = vec![];
    let mut messages = vec![];
    let flush = |messages: &mut Vec<Value>, role: &str, body: &mut Vec<&str>| {
        if !role.is_empty() && !body.is_empty() {
            messages.push(json!({"role":role, "text":body.join("\n").trim()}));
        }
        body.clear();
    };
    let mut fenced = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            fenced = !fenced;
        }
        if !fenced && trimmed.starts_with("# ") && title.is_empty() {
            title = trimmed[2..].trim().into();
            continue;
        }
        if !fenced && trimmed.starts_with("## ") {
            flush(&mut messages, &role, &mut body);
            let section = trimmed[3..].trim().to_lowercase();
            role = match section.as_str() {
                "user" | "human" | "prompt" => "user".into(),
                "assistant" | "model" | "response" => "assistant".into(),
                "system" => "system".into(),
                _ => section,
            };
        } else {
            body.push(line);
        }
    }
    flush(&mut messages, &role, &mut body);
    Ok(json!({"title":title, "messages":messages}))
}
