use serde_json::Value;
pub fn resolve_pointer<'a>(val: &'a Value, pointer: &str) -> Option<&'a Value> {
    if pointer.is_empty() {
        Some(val)
    } else {
        val.pointer(pointer)
    }
}
pub fn parse_timestamp(val: &Value, format: Option<&str>) -> Option<i64> {
    let format = format.unwrap_or("auto");
    if format == "iso8601" || format == "auto" {
        if let Some(s) = val.as_str() {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                return Some(dt.timestamp_millis());
            }
            if format == "iso8601" {
                return None;
            }
        } else if format == "iso8601" {
            return None;
        }
    }
    let n = val.as_i64().or_else(|| val.as_str()?.parse().ok())?;
    let millis = match format {
        "unix_seconds" => n.checked_mul(1000)?,
        "unix_milliseconds" => n,
        "auto" if n.unsigned_abs() < 100_000_000_000 => n.checked_mul(1000)?,
        "auto" => n,
        _ => return None,
    };
    // The Rust/TypeScript contract uses JSON-safe integer milliseconds.
    (millis.unsigned_abs() <= armillary_model::MAX_SAFE_INTEGER).then_some(millis)
}
pub fn extract_text(val: &Value, transform: Option<&str>) -> String {
    if transform == Some("json") {
        return val.to_string();
    }
    match val {
        Value::String(s) => s.clone(),
        Value::Array(items) if transform != Some("string") => items
            .iter()
            .filter_map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .or_else(|| v.get("text")?.as_str().map(str::to_owned))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}
