use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdapterDef {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub family: String,
    pub kind: String,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub docs_url: Option<String>,
    #[serde(default)]
    pub coverage: Option<String>,
    #[serde(default)]
    pub detection: DetectionDef,
    #[serde(default = "default_version")]
    pub adapter_version: String,
    pub store_namespace: Option<String>,
    #[serde(default)]
    pub history_sources: Vec<HistorySourceDef>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DetectionDef {
    #[serde(default)]
    pub binaries: Vec<String>,
    #[serde(default)]
    pub app_bundles: Vec<String>,
    /// Entries of `binaries` whose name is a common word or collides with an unrelated
    /// program. A PATH hit on one of these only counts with corroborating evidence.
    #[serde(default)]
    pub generic_binaries: Vec<String>,
    /// Entries of `app_bundles`, `data_folders` or `config_files` (written exactly as listed
    /// there) that other products create too. They stay readable as data, but are never
    /// evidence that this agent is installed.
    #[serde(default)]
    pub shared_evidence: Vec<String>,
    pub version_args: Option<Vec<String>>,
    #[serde(default)]
    pub paths: HashMap<String, PlatformPathsDef>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlatformPathsDef {
    #[serde(default)]
    pub data_folders: Vec<String>,
    #[serde(default)]
    pub config_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistorySourceDef {
    pub id: Option<String>,
    #[serde(default)]
    pub format: String, // "jsonl" | "json" | "sqlite" | "markdown"
    pub source_unit: Option<String>,
    #[serde(default)]
    pub paths: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub fixture_paths: Vec<String>,
    pub query: Option<String>,
    pub mapping: Option<FieldMappingDef>,
    #[serde(default)]
    pub module: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldMappingDef {
    pub session: Option<SessionMappingDef>,
    pub records: Option<RecordsMappingDef>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionMappingDef {
    pub id: Option<String>,
    pub meta_filter_pointer: Option<String>,
    pub meta_filter_value: Option<String>,
    pub project_root: Option<String>,
    pub title: Option<String>,
    pub timestamp: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub model: Option<String>,
    pub status: Option<String>,
    pub timestamp_format: Option<String>,
    pub parent_id: Option<String>,
    pub completion_filter_pointer: Option<String>,
    pub completion_filter_value: Option<String>,
    pub tokens_in: Option<String>,
    pub tokens_out: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordsMappingDef {
    pub type_pointer: Option<String>,
    pub array_pointer: Option<String>,
    pub messages: Option<MessagesMappingDef>,
    pub tool_calls: Option<ToolCallsMappingDef>,
    pub usage: Option<UsageMappingDef>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessagesMappingDef {
    pub match_type: Option<String>,
    pub role_pointer: Option<String>,
    pub native_id_pointer: Option<String>,
    pub item_type_pointer: Option<String>,
    pub role_map: Option<HashMap<String, String>>,
    pub text_pointer: Option<String>,
    pub fallback_text_pointer: Option<String>,
    pub text_transform: Option<String>,
    pub timestamp_pointer: Option<String>,
    pub timestamp_format: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCallsMappingDef {
    pub match_type: Option<String>,
    pub content_array_pointer: Option<String>,
    pub filter_type: Option<String>,
    pub item_type_pointer: Option<String>,
    pub tool_types: Option<Vec<String>>,
    pub name_pointer: Option<String>,
    pub input_pointer: Option<String>,
    pub result_pointer: Option<String>,
    pub files_pointer: Option<String>,
    /// Several places a tool call may name its files (for example `file_path`, `notebook_path` and
    /// `path`). Each pointer may resolve to a string or an array of strings; hits are appended after
    /// `files_pointer` in order, without duplicates.
    pub files_pointers: Option<Vec<String>>,
    pub call_id_pointer: Option<String>,
    pub result_call_id_pointer: Option<String>,
    pub result_filter_type: Option<String>,
    pub result_types: Option<Vec<String>>,
    pub result_output_pointer: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UsageMappingDef {
    pub match_type: Option<String>,
    pub semantics: Option<String>,
    pub event_id_pointer: Option<String>,
    pub usage_filter_pointer: Option<String>,
    pub usage_filter_value: Option<String>,
    pub tokens_in_pointer: Option<String>,
    pub tokens_out_pointer: Option<String>,
}

fn default_version() -> String {
    "0.1.0-unverified".into()
}
#[derive(Debug, thiserror::Error)]
pub enum AdapterError {
    #[error("Invalid adapter TOML: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("Unsupported adapter mapping: {0}")]
    Unsupported(String),
}
impl AdapterDef {
    pub fn from_toml(content: &str) -> Result<Self, AdapterError> {
        let def: Self = toml::from_str(content)?;
        def.validate()?;
        Ok(def)
    }
    pub fn validate(&self) -> Result<(), AdapterError> {
        let bad = |s: String| AdapterError::Unsupported(s);
        if self.id.is_empty() || self.adapter_version.is_empty() {
            return Err(bad("empty adapter id or version".into()));
        }
        if let Some(c) = &self.coverage {
            if !["detect", "history", "live", "config"].contains(&c.as_str()) {
                return Err(bad(format!("coverage={c}")));
            }
        }
        for source in &self.history_sources {
            if source.module.is_none()
                && !["jsonl", "json", "sqlite", "markdown"].contains(&source.format.as_str())
            {
                return Err(bad(format!("format={}", source.format)));
            }
            if let Some(unit) = &source.source_unit {
                if !["file_per_session", "shared_database"].contains(&unit.as_str()) {
                    return Err(bad(format!(
                        "source_unit={unit}; grouping needs a dedicated adapter"
                    )));
                }
            }
            if source.source_unit.as_deref() == Some("shared_database") && source.format != "sqlite"
            {
                return Err(bad("shared_database requires sqlite".into()));
            }
            if source.format == "sqlite" && source.query.is_none() && source.module.is_none() {
                return Err(bad("sqlite source requires query".into()));
            }
            if source.format != "sqlite" && source.query.is_some() {
                return Err(bad("query is supported only for sqlite".into()));
            }
            if let Some(mapping) = &source.mapping {
                // Every pointer is an RFC 6901 JSON pointer, never a guessed field name.
                let value = serde_json::to_value(mapping).expect("mapping serializes");
                fn pointers(value: &serde_json::Value) -> Result<(), String> {
                    if let Some(obj) = value.as_object() {
                        for (key, v) in obj {
                            if let Some(pointer) = v.as_str() {
                                let is_pointer = key.ends_with("_pointer")
                                    || [
                                        "id",
                                        "project_root",
                                        "title",
                                        "timestamp",
                                        "started_at",
                                        "ended_at",
                                        "model",
                                        "status",
                                        "parent_id",
                                        "tokens_in",
                                        "tokens_out",
                                    ]
                                    .contains(&key.as_str());
                                if is_pointer && !pointer.is_empty() && !pointer.starts_with('/') {
                                    return Err(format!("{key} must be a JSON pointer: {pointer}"));
                                }
                            }
                            if key.ends_with("_pointers") {
                                for pointer in v.as_array().into_iter().flatten().filter_map(|p| p.as_str()) {
                                    if pointer.is_empty() || !pointer.starts_with('/') {
                                        return Err(format!("{key} must hold JSON pointers: {pointer}"));
                                    }
                                }
                            }
                            if v.is_object() && key != "role_map" {
                                pointers(v)?;
                            }
                        }
                    }
                    Ok(())
                }
                pointers(&value).map_err(bad)?;
                if let Some(s) = &mapping.session {
                    if s.meta_filter_pointer.is_some() != s.meta_filter_value.is_some() {
                        return Err(bad("meta filter needs pointer and value".into()));
                    }
                    if s.completion_filter_pointer.is_some() != s.completion_filter_value.is_some()
                    {
                        return Err(bad("completion filter needs pointer and value".into()));
                    }
                    if s.timestamp.is_some() && s.started_at.is_some() {
                        return Err(bad(
                            "timestamp and started_at are aliases; configure one".into()
                        ));
                    }
                    validate_timestamp(s.timestamp_format.as_deref())?;
                }
                if let Some(r) = &mapping.records {
                    if ["jsonl", "sqlite"].contains(&source.format.as_str())
                        && r.array_pointer.is_some()
                    {
                        return Err(bad(
                            "array_pointer is supported only for json and markdown".into()
                        ));
                    }
                    if r.type_pointer.is_none()
                        && (r.messages.as_ref().is_some_and(|m| m.match_type.is_some())
                            || r.tool_calls
                                .as_ref()
                                .is_some_and(|t| t.match_type.is_some())
                            || r.usage.as_ref().is_some_and(|u| u.match_type.is_some()))
                    {
                        return Err(bad("match_type requires records.type_pointer".into()));
                    }
                    if let Some(m) = &r.messages {
                        if m.role_map.is_some() && m.item_type_pointer.is_none() {
                            return Err(bad("role_map requires item_type_pointer".into()));
                        }
                        if let Some(tc) = &r.tool_calls {
                            if m.text_transform.as_deref() == Some("json")
                                && m.text_pointer == tc.content_array_pointer
                                && m.text_pointer.is_some()
                            {
                                return Err(bad("json text serialization cannot share its pointer with ordered tool blocks".into()));
                            }
                        }
                        if let Some(t) = &m.text_transform {
                            if !["string", "content_array", "string_or_content", "json"]
                                .contains(&t.as_str())
                            {
                                return Err(bad(format!("text_transform={t}")));
                            }
                        }
                        validate_timestamp(m.timestamp_format.as_deref())?;
                    }
                    if let Some(u) = &r.usage {
                        if u.usage_filter_pointer.is_some() != u.usage_filter_value.is_some() {
                            return Err(bad("usage filter needs pointer and value".into()));
                        }
                        if let Some(s) = &u.semantics {
                            if !["unknown", "cumulative", "delta"].contains(&s.as_str()) {
                                return Err(bad(format!("usage semantics={s}")));
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }
}
fn validate_timestamp(format: Option<&str>) -> Result<(), AdapterError> {
    if let Some(f) = format {
        if !["auto", "iso8601", "unix_seconds", "unix_milliseconds"].contains(&f) {
            return Err(AdapterError::Unsupported(format!("timestamp_format={f}")));
        }
    }
    Ok(())
}
