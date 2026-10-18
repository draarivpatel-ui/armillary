use crate::adapter_spec::*;
use crate::boundary::{digest, ReadBoundary, MAX_SOURCE_RECORDS};
use crate::mapping::{parse_timestamp, resolve_pointer};
use crate::model::*;
use crate::readers::{
    jsonl::{parse_jsonl, ReaderError},
    markdown::parse_markdown,
    sqlite::read_sqlite_bounded,
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

pub struct AdapterEngine;
/// Integration owns generation/revision counters. The same store is shared by
/// all surfaces; installation identity describes the importer, not the session id.
pub struct SourceContext {
    pub store: StoreIdentity,
    pub approved_roots: Vec<PathBuf>,
    pub installation_id: Option<String>,
    pub generation: u64,
    pub revision: u64,
}
impl AdapterEngine {
    pub fn process_fixture_dir(
        adapter: &AdapterDef,
        fixture_dir: &Path,
    ) -> Result<Vec<NormalizedSession>, Box<dyn std::error::Error>> {
        let batches = Self::fixture_batches(adapter, fixture_dir)?;
        let mut sessions = vec![];
        for batch in batches {
            if batch.read_status != ReadStatus::Complete {
                return Err(format!("source read failed: {:?}", batch.diagnostics).into());
            }
            sessions.extend(batch.sessions);
        }
        sessions.sort_by(|a, b| a.session.id.cmp(&b.session.id));
        Ok(sessions)
    }
    pub fn fixture_batches(
        adapter: &AdapterDef,
        root: &Path,
    ) -> Result<Vec<ImportBatch>, Box<dyn std::error::Error>> {
        adapter.validate()?;
        let root = root.canonicalize()?;
        let namespace = adapter.store_namespace.as_deref().unwrap_or(&adapter.id);
        // Synthetic identity is portable across worktrees, never the user's HOME.
        let context = SourceContext {
            store: StoreIdentity::new(namespace, &format!("fixture://{namespace}"), "synthetic"),
            approved_roots: vec![root.clone()],
            installation_id: None,
            generation: 1,
            revision: 1,
        };
        let boundary = ReadBoundary::new(&context.approved_roots)?;
        let mut batches = vec![];
        for source in &adapter.history_sources {
            if let Some(module_name) = &source.module {
                let mod_batches = crate::modules::dispatch_module_batches(
                    module_name,
                    adapter,
                    source,
                    &context,
                    &boundary,
                    &root,
                )?;
                batches.extend(mod_batches);
                continue;
            }
            let patterns = if !source.fixture_paths.is_empty() {
                source.fixture_paths.clone()
            } else {
                source.paths.get("default").cloned().unwrap_or_default()
            };
            if patterns.is_empty() {
                return Err(format!(
                    "source {:?} has no explicit fixture_paths or relative default paths",
                    source.id
                )
                .into());
            }
            let files = select_files(&root, &patterns)?;
            for file in files {
                let relative = file
                    .strip_prefix(&root)?
                    .to_string_lossy()
                    .replace('\\', "/");
                batches.push(Self::read_source(
                    adapter, source, &context, &boundary, &file, &relative,
                ));
            }
        }
        Ok(batches)
    }
    /// Discover only files matched by this source's expanded platform paths.
    pub fn source_batches(
        adapter: &AdapterDef,
        source: &HistorySourceDef,
        context: &SourceContext,
        env: &dyn crate::env::Environment,
    ) -> Result<Vec<ImportBatch>, Box<dyn std::error::Error>> {
        adapter.validate()?;
        if let Some(module_name) = &source.module {
            let boundary = ReadBoundary::new(&context.approved_roots)?;
            let root = Path::new(&context.store.canonical_root).canonicalize()?;
            return crate::modules::dispatch_module_batches(
                module_name,
                adapter,
                source,
                context,
                &boundary,
                &root,
            );
        }
        let mut files = BTreeSet::new();
        for approved in &context.approved_roots {
            let root = approved.canonicalize()?;
            for entry in WalkDir::new(&root).follow_links(false) {
                let entry = entry?;
                if entry.file_type().is_dir()
                    || crate::credentials::is_credential_file(entry.path())
                {
                    continue;
                }
                if matches_source(source, context, env, entry.path())? {
                    files.insert(entry.path().to_path_buf());
                }
            }
        }
        Self::read_manifest(
            adapter,
            source,
            context,
            env,
            &files.into_iter().collect::<Vec<_>>(),
        )
    }
    /// Production callers pass the already-discovered manifest for ONE source.
    /// No global extension scan is ever used. All manifest reads use the supplied boundary.
    pub fn read_manifest(
        adapter: &AdapterDef,
        source: &HistorySourceDef,
        context: &SourceContext,
        env: &dyn crate::env::Environment,
        files: &[PathBuf],
    ) -> Result<Vec<ImportBatch>, Box<dyn std::error::Error>> {
        adapter.validate()?;
        if !context.store.valid() {
            return Err("invalid store identity".into());
        }
        let boundary = ReadBoundary::new(&context.approved_roots)?;
        let root = Path::new(&context.store.canonical_root).canonicalize()?;
        if let Some(module_name) = &source.module {
            return crate::modules::dispatch_module_batches(
                module_name,
                adapter,
                source,
                context,
                &boundary,
                &root,
            );
        }
        let mut batches = vec![];
        for file in files.iter().collect::<BTreeSet<_>>() {
            // The lexical manifest path must belong to the store; the boundary
            // independently checks the resolved target before opening it.
            let relative = file
                .strip_prefix(&root)?
                .to_str()
                .ok_or("non-UTF-8 source path")?
                .replace('\\', "/");
            if !matches_source(source, context, env, file)? {
                return Err(format!("manifest path not declared by source: {relative}").into());
            }
            batches.push(Self::read_source(
                adapter, source, context, &boundary, file, &relative,
            ));
        }
        Ok(batches)
    }
    fn read_source(
        adapter: &AdapterDef,
        source: &HistorySourceDef,
        context: &SourceContext,
        boundary: &ReadBoundary,
        file: &Path,
        relative: &str,
    ) -> ImportBatch {
        let mut provenance = SourceProvenance {
            store: context.store.clone(),
            source_id: source.id.clone().unwrap_or_else(|| source.format.clone()),
            adapter_id: adapter.id.clone(),
            adapter_version: adapter.adapter_version.clone(),
            source_path: relative.into(),
            file_identity: "unread".into(),
            generation: context.generation,
            checkpoint: Checkpoint {
                revision: context.revision,
                offset: 0,
                records: 0,
                digest: String::new(),
            },
        };
        let result = (|| -> Result<Vec<NormalizedSession>, ReaderError> {
            adapter
                .validate()
                .map_err(|e| ReaderError::Parse(e.to_string()))?;
            if let Some(module) = &source.module {
                return Err(ReaderError::Parse(format!(
                    "history module {module} must be dispatched via dispatch_module_batches"
                )));
            }
            let raw = if source.format == "sqlite" {
                let (rows, identity, extent, checksum) = read_sqlite_bounded(
                    boundary,
                    file,
                    source
                        .query
                        .as_deref()
                        .ok_or_else(|| ReaderError::Parse("missing sqlite query".into()))?,
                )?;
                provenance.file_identity = identity;
                provenance.checkpoint.offset = extent;
                provenance.checkpoint.digest = checksum;
                Raw::Rows(rows)
            } else {
                let bytes = boundary.read(file)?;
                provenance.file_identity = bytes.file_identity;
                provenance.checkpoint.offset = bytes.bytes.len() as u64;
                provenance.checkpoint.digest = digest(&bytes.bytes);
                match source.format.as_str() {
                    "jsonl" => Raw::Rows(parse_jsonl(&bytes.bytes[..])?),
                    "json" => Raw::Document(
                        serde_json::from_slice(&bytes.bytes)
                            .map_err(|e| ReaderError::Parse(e.to_string()))?,
                    ),
                    "markdown" => Raw::Document(parse_markdown(&bytes.bytes)?),
                    other => {
                        return Err(ReaderError::Parse(format!(
                            "unsupported source format {other}"
                        )))
                    }
                }
            };
            if context.store.canonical_root.starts_with("fixture://") {
                // Synthetic identities stay portable across copied checkouts.
                // Production contexts retain the actual device/inode above.
                provenance.file_identity = format!("synthetic:{}", provenance.source_path);
            }
            provenance.checkpoint.records = match &raw {
                Raw::Rows(r) => r.len() as u64,
                Raw::Document(v) => resolve_pointer(
                    v,
                    source
                        .mapping
                        .as_ref()
                        .and_then(|m| m.records.as_ref())
                        .and_then(|r| r.array_pointer.as_deref())
                        .unwrap_or("/messages"),
                )
                .and_then(Value::as_array)
                .map_or(1, |a| a.len()) as u64,
            };
            normalize(
                adapter,
                source,
                &provenance,
                context.installation_id.clone(),
                raw,
            )
        })();
        match result {
            Ok(sessions) => ImportBatch {
                source: provenance,
                mode: ImportMode::Snapshot,
                read_status: ReadStatus::Complete,
                sessions,
                diagnostics: vec![],
                live_updates: vec![],
            },
            Err(e) => {
                let code = match &e {
                    ReaderError::CredentialBlocked(_) => "credential_blocked",
                    ReaderError::Boundary(_) => "boundary",
                    ReaderError::Io(_) => "io",
                    ReaderError::Limit(_) => "limit",
                    ReaderError::Changed(_) => "changed",
                    ReaderError::Parse(_) => "parse",
                };
                let d = ImportDiagnostic {
                    source_key: provenance.key(),
                    code: code.into(),
                    message: e.to_string(),
                    retryable: matches!(e, ReaderError::Io(_) | ReaderError::Changed(_)),
                };
                ImportBatch {
                    source: provenance,
                    mode: ImportMode::Snapshot,
                    read_status: ReadStatus::Failed,
                    sessions: vec![],
                    diagnostics: vec![d],
                    live_updates: vec![],
                }
            }
        }
    }
}
pub(crate) fn select_files(
    root: &Path,
    patterns: &[String],
) -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
    let mut compiled = vec![];
    for p in patterns {
        if Path::new(p).is_absolute() || p.split('/').any(|c| c == "..") {
            return Err(format!("fixture path must be relative: {p}").into());
        }
        compiled.push(glob::Pattern::new(p)?);
    }
    let mut out = BTreeSet::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry?; // Permission and directory-read failures are never suppressed.
        if entry.file_type().is_dir() {
            continue;
        }
        let p = entry.path();
        if p.file_name().is_some_and(|n| n == "expected.json")
            || crate::credentials::is_credential_file(p)
        {
            continue;
        }
        let relative = p.strip_prefix(root)?;
        let options = glob::MatchOptions {
            case_sensitive: true,
            require_literal_separator: true,
            require_literal_leading_dot: true,
        };
        if compiled
            .iter()
            .any(|g| g.matches_path_with(relative, options))
        {
            out.insert(p.to_path_buf());
        }
    }
    Ok(out.into_iter().collect())
}
/// Canonicalise the literal directory prefix of a glob pattern (everything before the first
/// wildcard component) and keep the wildcard remainder unchanged. A pattern without wildcards is
/// canonicalised whole. When the prefix cannot be canonicalised the pattern is returned as given.
fn canonical_pattern(full: &Path) -> PathBuf {
    let Some(text) = full.to_str() else {
        return full.to_path_buf();
    };
    let Some(wildcard) = text.find(['*', '?', '[']) else {
        return full.canonicalize().unwrap_or_else(|_| full.to_path_buf());
    };
    let Some(slash) = text[..wildcard].rfind('/') else {
        return full.to_path_buf();
    };
    let (prefix, rest) = (&text[..slash], &text[slash + 1..]);
    let prefix_path = if prefix.is_empty() { Path::new("/") } else { Path::new(prefix) };
    match prefix_path.canonicalize() {
        Ok(canonical) => canonical.join(rest),
        Err(_) => full.to_path_buf(),
    }
}
fn matches_source(
    source: &HistorySourceDef,
    context: &SourceContext,
    env: &dyn crate::env::Environment,
    file: &Path,
) -> Result<bool, Box<dyn std::error::Error>> {
    let Some(patterns) = source
        .paths
        .get(env.os().as_str())
        .or_else(|| source.paths.get("default"))
    else {
        return Err("source has no paths for this platform".into());
    };
    for pattern in patterns {
        let expanded = crate::path_expansion::expand_path(pattern, env.os(), env)?;
        let full = if expanded.is_absolute() {
            expanded
        } else {
            Path::new(&context.store.canonical_root).join(expanded)
        };
        // The walk yields canonical paths, so the pattern's literal prefix must be canonical too
        // (a HOME reached through a symlink, such as /tmp on macOS, would never match otherwise).
        let full = canonical_pattern(&full);
        let pattern = glob::Pattern::new(full.to_str().ok_or("non-UTF-8 path pattern")?)?;
        if pattern.matches_path_with(
            file,
            glob::MatchOptions {
                case_sensitive: true,
                require_literal_separator: true,
                require_literal_leading_dot: true,
            },
        ) {
            return Ok(true);
        }
    }
    Ok(false)
}

enum Raw {
    Rows(Vec<Value>),
    Document(Value),
}
fn default_mapping(format: &str) -> FieldMappingDef {
    let sqlite = format == "sqlite";
    FieldMappingDef {
        session: Some(SessionMappingDef {
            id: Some("/id".into()),
            project_root: Some("/cwd".into()),
            title: Some("/title".into()),
            started_at: Some(if sqlite { "/created_at" } else { "/started_at" }.into()),
            model: Some("/model".into()),
            ..Default::default()
        }),
        records: Some(RecordsMappingDef {
            array_pointer: (!sqlite).then(|| "/messages".into()),
            messages: Some(MessagesMappingDef {
                native_id_pointer: Some("/id".into()),
                role_pointer: Some("/role".into()),
                text_pointer: Some("/text".into()),
                fallback_text_pointer: Some("/content".into()),
                timestamp_pointer: Some("/at".into()),
                ..Default::default()
            }),
            ..Default::default()
        }),
    }
}
fn normalize(
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    provenance: &SourceProvenance,
    installation_id: Option<String>,
    raw: Raw,
) -> Result<Vec<NormalizedSession>, ReaderError> {
    let mapping = source
        .mapping
        .clone()
        .unwrap_or_else(|| default_mapping(&source.format));
    match raw {
        Raw::Document(doc) => {
            let pointer = mapping
                .records
                .as_ref()
                .and_then(|r| r.array_pointer.as_deref())
                .unwrap_or("/messages");
            let records = match resolve_pointer(&doc, pointer) {
                Some(Value::Array(a)) => a.clone(),
                Some(_) => return Err(ReaderError::Parse(format!("{pointer} must be an array"))),
                None => vec![],
            };
            Ok(vec![normalize_one(
                adapter,
                &mapping,
                provenance,
                installation_id,
                &[doc],
                &records,
            )?])
        }
        Raw::Rows(rows) if source.format == "sqlite" => {
            // All rows of a native session are grouped without guessing a join.
            let id_pointer = mapping
                .session
                .as_ref()
                .and_then(|s| s.id.as_deref())
                .unwrap_or("/id");
            let mut groups: BTreeMap<String, Vec<Value>> = BTreeMap::new();
            for row in rows {
                let id = string(resolve_pointer(&row, id_pointer)).ok_or_else(|| {
                    ReaderError::Parse(format!("SQLite row missing mapped session id {id_pointer}"))
                })?;
                groups.entry(id).or_default().push(row);
            }
            groups
                .values()
                .map(|r| {
                    normalize_one(adapter, &mapping, provenance, installation_id.clone(), r, r)
                })
                .collect()
        }
        Raw::Rows(rows) => {
            if rows.is_empty() {
                return Ok(vec![]);
            }
            Ok(vec![normalize_one(
                adapter,
                &mapping,
                provenance,
                installation_id,
                &rows,
                &rows,
            )?])
        }
    }
}
fn string(value: Option<&Value>) -> Option<String> {
    value.and_then(|v| {
        v.as_str()
            .map(str::to_owned)
            .or_else(|| v.as_i64().map(|n| n.to_string()))
    })
}
fn pointer<'a>(v: &'a Value, p: Option<&String>) -> Option<&'a Value> {
    resolve_pointer(v, p?)
}
fn filter(v: &Value, p: Option<&String>, expected: Option<&String>) -> bool {
    match (p, expected) {
        (Some(p), Some(e)) => resolve_pointer(v, p).and_then(Value::as_str) == Some(e.as_str()),
        _ => true,
    }
}
fn record_matches(v: &Value, r: Option<&RecordsMappingDef>, expected: Option<&String>) -> bool {
    expected.is_none_or(|e| {
        r.and_then(|r| pointer(v, r.type_pointer.as_ref()))
            .and_then(Value::as_str)
            == Some(e.as_str())
    })
}
fn time(v: Option<&Value>, format: Option<&str>) -> Result<Option<i64>, ReaderError> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(v) => parse_timestamp(v, format).map(Some).ok_or_else(|| {
            ReaderError::Parse("mapped timestamp is invalid or outside JSON-safe range".into())
        }),
    }
}
fn normalize_one(
    adapter: &AdapterDef,
    mapping: &FieldMappingDef,
    provenance: &SourceProvenance,
    installation_id: Option<String>,
    meta: &[Value],
    records: &[Value],
) -> Result<NormalizedSession, ReaderError> {
    let s = mapping.session.as_ref();
    let metadata: Vec<_> = meta
        .iter()
        .filter(|v| {
            s.is_none_or(|s| {
                filter(
                    v,
                    s.meta_filter_pointer.as_ref(),
                    s.meta_filter_value.as_ref(),
                )
            })
        })
        .collect();
    let get = |p: Option<&String>| metadata.iter().find_map(|v| pointer(v, p));
    let native_id = string(get(s.and_then(|s| s.id.as_ref())));
    // A file declaring multiple native sessions needs an explicit grouping module.
    for v in &metadata {
        if let Some(other) = string(pointer(v, s.and_then(|s| s.id.as_ref()))) {
            if Some(other) != native_id {
                return Err(ReaderError::Parse(
                    "multiple native sessions in file_per_session source".into(),
                ));
            }
        }
    }
    let session_id = normalized_session_id(
        &provenance.store.id,
        native_id.as_deref(),
        &provenance.source_path,
    );
    let format = s.and_then(|s| s.timestamp_format.as_deref());
    let mut started_at = time(
        get(s
            .and_then(|s| s.started_at.as_ref())
            .or_else(|| s.and_then(|s| s.timestamp.as_ref()))),
        format,
    )?;
    let mut ended_at = time(get(s.and_then(|s| s.ended_at.as_ref())), format)?;
    let mut status =
        string(get(s.and_then(|s| s.status.as_ref()))).unwrap_or_else(|| "unknown".into());
    let mut completion =
        if ended_at.is_some() || ["done", "closed", "completed"].contains(&status.as_str()) {
            Some(Evidence {
                kind: "native_completion".into(),
                detail: "mapped native completion field".into(),
                native_event_id: None,
                at: ended_at,
            })
        } else {
            None
        };
    let native_parent_id = string(get(s.and_then(|s| s.parent_id.as_ref())));
    let mut messages = vec![];
    let mut observations = vec![];
    if let Some(s) = s {
        let input = get(s.tokens_in.as_ref()).and_then(Value::as_u64);
        let output = get(s.tokens_out.as_ref()).and_then(Value::as_u64);
        if input.is_some() || output.is_some() {
            observations.push(UsageObservation {
                event_id: stable_id("usage-summary", &[&session_id]),
                semantics: UsageSemantics::Cumulative,
                input_tokens: input,
                output_tokens: output,
                at: ended_at,
            });
        }
    }
    let r = mapping.records.as_ref();
    for (index, record) in records.iter().enumerate() {
        if index >= MAX_SOURCE_RECORDS {
            return Err(ReaderError::Limit("too many records".into()));
        }
        let m = r.and_then(|r| r.messages.as_ref());
        let tc = r.and_then(|r| r.tool_calls.as_ref());
        let native_event = string(m.and_then(|m| pointer(record, m.native_id_pointer.as_ref())));
        let key = native_event
            .clone()
            .unwrap_or_else(|| format!("{}:record:{}", provenance.key(), index + 1));
        let at = time(
            m.and_then(|m| pointer(record, m.timestamp_pointer.as_ref()))
                .or_else(|| record.get("timestamp"))
                .or_else(|| record.pointer("/payload/timestamp")),
            m.and_then(|m| m.timestamp_format.as_deref()),
        )?;
        if started_at.is_none() {
            started_at = at;
        }
        if s.is_some_and(|s| {
            s.completion_filter_pointer.is_some()
                && filter(
                    record,
                    s.completion_filter_pointer.as_ref(),
                    s.completion_filter_value.as_ref(),
                )
        }) {
            completion = Some(Evidence {
                kind: "native_completion".into(),
                detail: "mapped completion event".into(),
                native_event_id: native_event.clone(),
                at,
            });
            ended_at = at;
            status = "done".into();
        }
        let tool_mapping = tc.filter(|tc| record_matches(record, r, tc.match_type.as_ref()));
        let message_mapping = m.filter(|m| record_matches(record, r, m.match_type.as_ref()));
        let role = message_mapping.and_then(|m| {
            string(pointer(record, m.role_pointer.as_ref())).or_else(|| {
                let t = pointer(record, m.item_type_pointer.as_ref())?.as_str()?;
                m.role_map.as_ref()?.get(t).cloned()
            })
        });
        let mut blocks = vec![];
        if let Some(m) = message_mapping.filter(|_| role.is_some()) {
            let primary = pointer(record, m.text_pointer.as_ref());
            let text = primary
                .filter(|v| !v.is_null() && v.as_str() != Some(""))
                .or_else(|| pointer(record, m.fallback_text_pointer.as_ref()));
            if let Some(text) = text {
                blocks.extend(content_blocks(
                    text,
                    m.text_transform.as_deref(),
                    tool_mapping,
                    &key,
                )?);
            }
        }
        if let Some(tc) = tool_mapping {
            if tc.content_array_pointer != message_mapping.and_then(|m| m.text_pointer.clone())
                || role.is_none()
            {
                if let Some(Value::Array(a)) = pointer(record, tc.content_array_pointer.as_ref()) {
                    for (i, item) in a.iter().enumerate() {
                        if let Some(b) = tool_block(item, tc, &format!("{key}:block:{i}"), true)? {
                            push_tool(&mut blocks, b, item, tc);
                        }
                    }
                }
            }
            if tc.item_type_pointer.is_some() {
                if let Some(b) = tool_block(record, tc, &key, false)? {
                    push_tool(&mut blocks, b, record, tc);
                }
            }
        }
        if !blocks.is_empty() {
            messages.push(Message {
                id: normalized_message_id(
                    &session_id,
                    native_event.as_deref(),
                    &provenance.key(),
                    provenance.generation,
                    (index + 1) as u32,
                ),
                session_id: session_id.clone(),
                native_id: native_event.clone(),
                seq: (index + 1) as u32,
                role: role.unwrap_or_else(|| {
                    if matches!(blocks[0], ContentBlock::ToolResult { .. }) {
                        "tool".into()
                    } else {
                        "assistant".into()
                    }
                }),
                at,
                blocks,
            });
        }
        if let Some(u) = r.and_then(|r| r.usage.as_ref()).filter(|u| {
            record_matches(record, r, u.match_type.as_ref())
                && filter(
                    record,
                    u.usage_filter_pointer.as_ref(),
                    u.usage_filter_value.as_ref(),
                )
        }) {
            let input = pointer(record, u.tokens_in_pointer.as_ref()).and_then(Value::as_u64);
            let output = pointer(record, u.tokens_out_pointer.as_ref()).and_then(Value::as_u64);
            if input.is_some() || output.is_some() {
                let event_key = string(pointer(record, u.event_id_pointer.as_ref()))
                    .or_else(|| native_event.clone());
                observations.push(UsageObservation {
                    event_id: normalized_usage_id(
                        &session_id,
                        event_key.as_deref(),
                        &provenance.key(),
                        provenance.generation,
                        (index + 1) as u32,
                    ),
                    semantics: match u.semantics.as_deref() {
                        Some("cumulative") => UsageSemantics::Cumulative,
                        Some("delta") => UsageSemantics::Delta,
                        _ => UsageSemantics::Unknown,
                    },
                    input_tokens: input,
                    output_tokens: output,
                    at,
                });
            }
        }
    }
    let usage = Usage::from_observations(observations).map_err(ReaderError::Parse)?;
    let turns = messages
        .iter()
        .filter(|m| {
            m.role == "user"
                && m.blocks
                    .iter()
                    .any(|b| matches!(b, ContentBlock::Text { .. } | ContentBlock::Code { .. }))
        })
        .count() as u32;
    Ok(NormalizedSession {
        session: Session {
            id: session_id,
            agent_id: adapter.id.clone(),
            installation_id,
            native_id,
            provenance: provenance.clone(),
            project_root: string(get(s.and_then(|s| s.project_root.as_ref()))),
            title: string(get(s.and_then(|s| s.title.as_ref()))),
            started_at,
            ended_at,
            model: string(get(s.and_then(|s| s.model.as_ref()))),
            status,
            completion,
            turns,
            usage,
            parent_id: native_parent_id
                .as_ref()
                .map(|p| stable_session_id(&provenance.store.id, p)),
            native_parent_id,
        },
        messages,
    })
}
fn content_blocks(
    v: &Value,
    transform: Option<&str>,
    tc: Option<&ToolCallsMappingDef>,
    key: &str,
) -> Result<Vec<ContentBlock>, ReaderError> {
    if transform == Some("json") {
        return Ok(vec![ContentBlock::Text {
            text: v.to_string(),
        }]);
    }
    match v {
        Value::String(text) => Ok((!text.is_empty())
            .then(|| ContentBlock::Text { text: text.clone() })
            .into_iter()
            .collect()),
        Value::Array(a) if transform != Some("string") => {
            let mut blocks = vec![];
            for (i, v) in a.iter().enumerate() {
                if let Some(text) = v.as_str() {
                    blocks.push(ContentBlock::Text { text: text.into() });
                    continue;
                }
                let kind = v.get("type").and_then(Value::as_str).unwrap_or("text");
                match kind {
                    "text" | "input_text" | "output_text" => {
                        if let Some(text) = v.get("text").and_then(Value::as_str) {
                            blocks.push(ContentBlock::Text { text: text.into() });
                        } else {
                            return Err(ReaderError::Parse("text block is missing text".into()));
                        }
                    }
                    "tool_use" | "tool_result" => {
                        let tc = tc.ok_or_else(|| {
                            ReaderError::Parse(
                                "tool content requires a declared tool mapping".into(),
                            )
                        })?;
                        if let Some(b) = tool_block(v, tc, &format!("{key}:block:{i}"), true)? {
                            push_tool(&mut blocks, b, v, tc);
                        }
                    }
                    "code" | "edit" | "checklist" | "error" | "attachment" => {
                        blocks.push(
                            serde_json::from_value(v.clone()).map_err(|e| {
                                ReaderError::Parse(format!("structured block: {e}"))
                            })?,
                        );
                    }
                    other => {
                        return Err(ReaderError::Parse(format!(
                            "unsupported content block {other}; use a dedicated decoder"
                        )))
                    }
                }
            }
            Ok(blocks)
        }
        Value::Null => Ok(vec![]),
        _ => Err(ReaderError::Parse(
            "mapped text shape does not match text_transform".into(),
        )),
    }
}
fn tool_block(
    v: &Value,
    tc: &ToolCallsMappingDef,
    key: &str,
    array_item: bool,
) -> Result<Option<ContentBlock>, ReaderError> {
    let kind = if array_item {
        v.get("type").and_then(Value::as_str)
    } else {
        pointer(v, tc.item_type_pointer.as_ref()).and_then(Value::as_str)
    };
    let result = if array_item {
        kind == Some(tc.result_filter_type.as_deref().unwrap_or("tool_result"))
    } else {
        kind.is_some_and(|k| {
            tc.result_types
                .as_ref()
                .is_some_and(|a| a.iter().any(|t| t == k))
        })
    };
    let call = if array_item {
        tc.filter_type
            .as_ref()
            .is_none_or(|t| kind == Some(t.as_str()))
            && !result
    } else {
        kind.is_some_and(|k| {
            tc.tool_types
                .as_ref()
                .is_some_and(|a| a.iter().any(|t| t == k))
        })
    };
    if result {
        let call_id = string(
            pointer(v, tc.result_call_id_pointer.as_ref())
                .or_else(|| v.get("tool_use_id"))
                .or_else(|| v.get("call_id")),
        )
        .ok_or_else(|| ReaderError::Parse("tool result missing call id".into()))?;
        let output = pointer(v, tc.result_output_pointer.as_ref())
            .or_else(|| v.get("content"))
            .or_else(|| v.get("output"))
            .cloned()
            .unwrap_or(Value::Null);
        return Ok(Some(ContentBlock::ToolResult {
            call_id,
            output,
            is_error: v.get("is_error").and_then(Value::as_bool),
        }));
    }
    if !call {
        return Ok(None);
    }
    let native_id = string(
        pointer(v, tc.call_id_pointer.as_ref())
            .or_else(|| v.get("id"))
            .or_else(|| v.get("call_id")),
    );
    let call_id = native_id
        .clone()
        .unwrap_or_else(|| stable_id("tool", &[key]));
    let name = string(pointer(v, tc.name_pointer.as_ref()).or_else(|| v.get("name")))
        .or_else(|| kind.map(str::to_owned))
        .ok_or_else(|| ReaderError::Parse("tool call missing mapped name".into()))?;
    let input = pointer(v, tc.input_pointer.as_ref())
        .or_else(|| v.get("input"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut files: Vec<String> = Vec::new();
    for p in tc.files_pointer.iter().chain(tc.files_pointers.iter().flatten()) {
        let found: Vec<String> = match resolve_pointer(v, p) {
            Some(Value::String(s)) => vec![s.clone()],
            Some(Value::Array(a)) => a
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect(),
            _ => vec![],
        };
        for f in found {
            if !files.contains(&f) {
                files.push(f);
            }
        }
    }
    let call_block = ContentBlock::ToolCall {
        call_id: call_id.clone(),
        native_id,
        name,
        input,
        files,
    };
    // Inline results are expanded by the caller into the same ordered event.
    Ok(Some(call_block))
}

fn push_tool(
    blocks: &mut Vec<ContentBlock>,
    block: ContentBlock,
    value: &Value,
    mapping: &ToolCallsMappingDef,
) {
    let inline = if let ContentBlock::ToolCall { call_id, .. } = &block {
        pointer(value, mapping.result_pointer.as_ref())
            .filter(|v| !v.is_null())
            .map(|v| ContentBlock::ToolResult {
                call_id: call_id.clone(),
                output: v.clone(),
                is_error: value.get("is_error").and_then(Value::as_bool),
            })
    } else {
        None
    };
    blocks.push(block);
    if let Some(result) = inline {
        blocks.push(result);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::{MockEnvironment, TargetOs};

    fn source(pattern: &str) -> HistorySourceDef {
        HistorySourceDef {
            id: None,
            format: "jsonl".into(),
            source_unit: None,
            paths: [("default".to_string(), vec![pattern.to_string()])].into_iter().collect(),
            fixture_paths: vec![],
            query: None,
            mapping: None,
            module: None,
        }
    }

    fn context(root: &Path) -> SourceContext {
        SourceContext {
            store: StoreIdentity::new("test", &root.to_string_lossy(), "default"),
            approved_roots: vec![root.to_path_buf()],
            installation_id: None,
            generation: 1,
            revision: 1,
        }
    }

    /// `<tmp>/real/home/.agent/projects/p/s.jsonl`, reached through `<tmp>/link -> <tmp>/real`.
    fn symlinked_home() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let real_home = base.join("real/home");
        let dir = real_home.join(".agent/projects/p");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("s.jsonl");
        std::fs::write(&file, "{}\n").unwrap();
        std::os::unix::fs::symlink(base.join("real"), base.join("link")).unwrap();
        (tmp, real_home, base.join("link/home"), file)
    }

    #[test]
    fn a_pattern_under_a_symlinked_home_matches_the_canonical_file() {
        let (_tmp, real_home, linked_home, file) = symlinked_home();
        let env = MockEnvironment::new(TargetOs::Macos, linked_home.to_str().unwrap());
        let ctx = context(&real_home.join(".agent"));
        for pattern in ["~/.agent/projects/**/*.jsonl", "~/.agent/projects/p/s.jsonl", "~/.agent/*/p/s.jsonl"] {
            assert!(
                matches_source(&source(pattern), &ctx, &env, &file).unwrap(),
                "{pattern} must match {} through a symlinked HOME",
                file.display()
            );
        }
        // A file outside the pattern still does not match.
        let other = real_home.join(".agent/other/s.jsonl");
        assert!(!matches_source(&source("~/.agent/projects/**/*.jsonl"), &ctx, &env, &other).unwrap());
    }

    #[test]
    fn a_pattern_whose_prefix_does_not_exist_is_left_as_given() {
        let missing = Path::new("/definitely/not/here/*.jsonl");
        assert_eq!(canonical_pattern(missing), missing);
    }
}
