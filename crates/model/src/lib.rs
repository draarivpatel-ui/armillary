//! Frozen CF v1 model. See CONTRACT.md for identity and import rules.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const CONTRACT_VERSION: &str = "armillary.cf.v1";
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// SHA-256 of namespace, kind and UTF-8 inputs, each prefixed with a u64 BE length.
/// The complete digest is retained. No delimiters, filenames or adapter versions are implicit.
pub fn stable_id(kind: &str, inputs: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in std::iter::once(CONTRACT_VERSION)
        .chain(std::iter::once(kind))
        .chain(inputs.iter().copied())
    {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    format!("{:x}", hash.finalize())
}
pub fn stable_session_id(store_id: &str, native_id: &str) -> String {
    stable_id("session", &[store_id, native_id])
}
/// File-local fallback is a separate kind, so it cannot collide with a native id.
pub fn normalized_session_id(store_id: &str, native_id: Option<&str>, source_path: &str) -> String {
    match native_id {
        Some(native) => stable_session_id(store_id, native),
        None => stable_id("session-path", &[store_id, source_path]),
    }
}
pub fn stable_message_id(session_id: &str, native_id: &str) -> String {
    stable_id("message", &[session_id, native_id])
}

/// Explicit fallback domain retains unknown native identity and the observed incarnation.
pub fn normalized_message_id(
    session_id: &str,
    native_id: Option<&str>,
    source_key: &str,
    generation: u64,
    record: u32,
) -> String {
    match native_id {
        Some(native) => stable_message_id(session_id, native),
        None => stable_id(
            "message-path",
            &[
                session_id,
                source_key,
                &generation.to_string(),
                &record.to_string(),
            ],
        ),
    }
}
pub fn normalized_usage_id(
    session_id: &str,
    native_id: Option<&str>,
    source_key: &str,
    generation: u64,
    record: u32,
) -> String {
    match native_id {
        Some(native) => stable_id("usage", &[session_id, native]),
        None => stable_id(
            "usage-path",
            &[
                session_id,
                source_key,
                &generation.to_string(),
                &record.to_string(),
            ],
        ),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub family: String,
    pub kind: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Install {
    pub id: String,
    pub agent_id: String,
    pub version: Option<String>,
    pub executable_path: Option<String>,
    pub profile_id: String,
    pub store_ids: Vec<String>,
    pub paths: BTreeMap<String, String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StoreIdentity {
    pub id: String,
    pub namespace: String,
    pub canonical_root: String,
    pub profile_id: String,
}
impl StoreIdentity {
    pub fn new(namespace: &str, canonical_root: &str, profile_id: &str) -> Self {
        Self {
            id: stable_id("store", &[namespace, canonical_root, profile_id]),
            namespace: namespace.into(),
            canonical_root: canonical_root.into(),
            profile_id: profile_id.into(),
        }
    }
    pub fn valid(&self) -> bool {
        !self.namespace.is_empty()
            && !self.canonical_root.is_empty()
            && !self.profile_id.is_empty()
            && self.id
                == stable_id(
                    "store",
                    &[&self.namespace, &self.canonical_root, &self.profile_id],
                )
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub revision: u64,
    pub offset: u64,
    pub records: u64,
    pub digest: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceProvenance {
    pub store: StoreIdentity,
    pub source_id: String,
    pub adapter_id: String,
    pub adapter_version: String,
    /// Path relative to the canonical store root, with '/' separators.
    pub source_path: String,
    pub file_identity: String,
    /// Monotonic incarnation assigned by the importer after observed rotation.
    pub generation: u64,
    pub checkpoint: Checkpoint,
}
impl SourceProvenance {
    /// Source identity is independent of the UI surface and adapter version.
    pub fn key(&self) -> String {
        stable_id("source", &[&self.store.id, &self.source_path])
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UsageSemantics {
    Unknown,
    Cumulative,
    Delta,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UsageObservation {
    pub event_id: String,
    pub semantics: UsageSemantics,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub at: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Usage {
    pub semantics: UsageSemantics,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub observations: Vec<UsageObservation>,
}
impl Default for Usage {
    fn default() -> Self {
        Self {
            semantics: UsageSemantics::Unknown,
            input_tokens: None,
            output_tokens: None,
            observations: vec![],
        }
    }
}
impl Usage {
    pub fn from_observations(observations: Vec<UsageObservation>) -> Result<Self, String> {
        let mut unique = Vec::<UsageObservation>::new();
        let mut seen = std::collections::BTreeMap::<String, usize>::new();
        for o in observations {
            if o.event_id.is_empty()
                || o.input_tokens.is_some_and(|v| v > MAX_SAFE_INTEGER)
                || o.output_tokens.is_some_and(|v| v > MAX_SAFE_INTEGER)
                || o.at.is_some_and(|t| t.unsigned_abs() > MAX_SAFE_INTEGER)
            {
                return Err("invalid usage observation".into());
            }
            if let Some(index) = seen.get(&o.event_id) {
                if unique[*index] != o {
                    return Err(format!("conflicting usage event {}", o.event_id));
                }
            } else {
                seen.insert(o.event_id.clone(), unique.len());
                unique.push(o);
            }
        }
        let semantics = unique
            .first()
            .map(|o| o.semantics)
            .unwrap_or(UsageSemantics::Unknown);
        let mixed = unique.iter().any(|o| o.semantics != semantics);
        let sum = |input: bool| -> Result<Option<u64>, String> {
            if mixed || semantics == UsageSemantics::Unknown {
                return Ok(None);
            }
            let values = unique.iter().filter_map(|o| {
                if input {
                    o.input_tokens
                } else {
                    o.output_tokens
                }
            });
            let mut total = None;
            for v in values {
                if v > MAX_SAFE_INTEGER {
                    return Err("usage exceeds JSON safe integer range".into());
                }
                total = Some(match semantics {
                    UsageSemantics::Cumulative => v,
                    UsageSemantics::Delta => total
                        .unwrap_or(0_u64)
                        .checked_add(v)
                        .filter(|v| *v <= MAX_SAFE_INTEGER)
                        .ok_or("usage overflow")?,
                    UsageSemantics::Unknown => unreachable!(),
                });
            }
            Ok(total)
        };
        Ok(Self {
            semantics: if mixed {
                UsageSemantics::Unknown
            } else {
                semantics
            },
            input_tokens: sum(true)?,
            output_tokens: sum(false)?,
            observations: unique,
        })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub kind: String,
    pub detail: String,
    pub native_event_id: Option<String>,
    pub at: Option<i64>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Unknown,
    Low,
    Medium,
    High,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LiveState {
    Unknown,
    Working,
    Waiting,
    Idle,
    Done,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub started_at: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Live {
    pub session_id: String,
    pub state: LiveState,
    pub since: Option<i64>,
    pub observed_at: i64,
    pub evidence: Vec<Evidence>,
    pub confidence: Confidence,
    pub process: Option<ProcessIdentity>,
    pub expires_at: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum LiveAction {
    Preserve,
    Update { value: Live },
    Remove { evidence: Evidence },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LiveMutation {
    pub session_id: String,
    pub action: LiveAction,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChecklistItem {
    pub text: String,
    pub checked: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Code {
        code: String,
        language: Option<String>,
    },
    ToolCall {
        call_id: String,
        native_id: Option<String>,
        name: String,
        input: Value,
        files: Vec<String>,
    },
    ToolResult {
        call_id: String,
        output: Value,
        is_error: Option<bool>,
    },
    Edit {
        path: String,
        before: Option<String>,
        after: Option<String>,
        diff: Option<String>,
    },
    Checklist {
        items: Vec<ChecklistItem>,
    },
    Error {
        message: String,
        code: Option<String>,
    },
    Attachment {
        reference: String,
        mime_type: Option<String>,
        label: Option<String>,
    },
}
impl ContentBlock {
    pub fn search_text(&self) -> String {
        match self {
            Self::Text { text } => text.clone(),
            Self::Code { code, .. } => code.clone(),
            Self::ToolCall {
                name, input, files, ..
            } => format!("{} {} {}", name, input, files.join(" ")),
            Self::ToolResult { output, .. } => output
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| output.to_string()),
            Self::Edit {
                path,
                before,
                after,
                diff,
            } => format!(
                "{} {} {} {}",
                path,
                before.as_deref().unwrap_or(""),
                after.as_deref().unwrap_or(""),
                diff.as_deref().unwrap_or("")
            ),
            Self::Checklist { items } => items
                .iter()
                .map(|i| i.text.clone())
                .collect::<Vec<_>>()
                .join("\n"),
            Self::Error { message, code } => {
                format!("{} {}", message, code.as_deref().unwrap_or(""))
            }
            Self::Attachment {
                reference, label, ..
            } => format!("{} {}", reference, label.as_deref().unwrap_or("")),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub id: String,
    pub session_id: String,
    pub native_id: Option<String>,
    pub seq: u32,
    pub role: String,
    pub at: Option<i64>,
    pub blocks: Vec<ContentBlock>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Session {
    pub id: String,
    pub agent_id: String,
    pub installation_id: Option<String>,
    pub native_id: Option<String>,
    pub provenance: SourceProvenance,
    pub project_root: Option<String>,
    pub title: Option<String>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub model: Option<String>,
    pub status: String,
    pub completion: Option<Evidence>,
    pub turns: u32,
    pub usage: Usage,
    pub parent_id: Option<String>,
    pub native_parent_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NormalizedSession {
    pub session: Session,
    pub messages: Vec<Message>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReadStatus {
    Complete,
    Incomplete,
    Failed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum ImportMode {
    Snapshot,
    Append { from: Checkpoint },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ImportDiagnostic {
    pub source_key: String,
    pub code: String,
    pub message: String,
    pub retryable: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ImportBatch {
    pub source: SourceProvenance,
    pub mode: ImportMode,
    pub read_status: ReadStatus,
    pub sessions: Vec<NormalizedSession>,
    pub diagnostics: Vec<ImportDiagnostic>,
    pub live_updates: Vec<LiveMutation>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConfirmedSourceDeletion {
    pub source: SourceProvenance,
    pub evidence: Evidence,
}
/// Schema generation entry point. This is a type catalogue, not an API response.
#[derive(JsonSchema)]
pub struct Contract {
    pub agent: Agent,
    pub install: Install,
    pub batch: ImportBatch,
    pub deletion: ConfirmedSourceDeletion,
}

pub fn schema_json() -> Value {
    serde_json::to_value(schemars::schema_for!(Contract)).expect("schema serializes")
}
