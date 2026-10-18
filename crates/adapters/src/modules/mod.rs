pub mod aider;
pub mod amp;
#[path = "antigravity-cli.rs"]
pub mod antigravity_cli;
#[path = "kimi-code-cli.rs"]
pub mod kimi_code_cli;

pub mod crush;
pub mod goose;
#[path = "hermes-agent-cli.rs"]
pub mod hermes_agent_cli;
pub mod opencode;

use crate::adapter_spec::{AdapterDef, HistorySourceDef};
use crate::boundary::ReadBoundary;
use crate::engine::SourceContext;
use crate::model::{
    normalized_message_id, normalized_session_id, NormalizedSession, SourceProvenance,
};
use crate::readers::jsonl::ReaderError;
use crate::readers::sqlite::open_sqlite_snapshot;
use rusqlite::Connection;
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

pub fn read_source_module(
    module_name: &str,
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    provenance: &mut SourceProvenance,
    context: &SourceContext,
    boundary: &ReadBoundary,
    file: &Path,
) -> Result<Vec<NormalizedSession>, ReaderError> {
    let snapshot = open_sqlite_snapshot(boundary, file)?;
    provenance.file_identity = if context.store.canonical_root.starts_with("fixture://") {
        format!("synthetic:{}", provenance.source_path)
    } else {
        snapshot.file_identity.clone()
    };
    provenance.checkpoint.digest = snapshot.checksum.clone();

    let mut sessions = match module_name {
        "opencode" => opencode::read_from_snapshot(adapter, source, provenance, &snapshot.conn)?,
        "crush" => crush::read_from_snapshot(adapter, source, provenance, &snapshot.conn)?,
        "hermes-agent-cli" | "hermes_agent_cli" => {
            hermes_agent_cli::read_from_snapshot(adapter, source, provenance, &snapshot.conn)?
        }
        "goose" => goose::read_from_snapshot(adapter, source, provenance, &snapshot.conn)?,
        other => return Err(ReaderError::Parse(format!("Unknown history module: {}", other))),
    };

    let total_records: u64 = sessions.iter().map(|s| s.messages.len() as u64).sum();
    provenance.checkpoint.records = total_records;
    provenance.checkpoint.offset = total_records;

    // Ensure all sessions have the updated provenance and correct session id
    for s in &mut sessions {
        s.session.provenance = provenance.clone();
        s.session.id = normalized_session_id(
            &provenance.store.id,
            s.session.native_id.as_deref(),
            &provenance.source_path,
        );
        s.session.installation_id = context.installation_id.clone();
        for m in &mut s.messages {
            m.session_id = s.session.id.clone();
            m.id = normalized_message_id(
                &s.session.id,
                m.native_id.as_deref(),
                &provenance.key(),
                provenance.generation,
                m.seq,
            );
        }
        for obs in &mut s.session.usage.observations {
            obs.event_id = armillary_model::stable_id("usage-summary", &[&s.session.id]);
        }
    }

    sessions.sort_by(|a, b| a.session.id.cmp(&b.session.id));
    Ok(sessions)
}

/// Completion needs native evidence (CONTRACT.md): a native status that says the session is over.
/// A quiet file or a last-updated time is not evidence, so callers pass `ended_at` only when the
/// store has a real end marker.
pub fn completion_from_native(
    status: &str,
    ended_at: Option<i64>,
    detail: &str,
) -> Option<armillary_model::Evidence> {
    let done = ["done", "closed", "completed"].contains(&status);
    if !done && ended_at.is_none() {
        return None;
    }
    Some(armillary_model::Evidence {
        kind: "native_status".into(),
        detail: detail.into(),
        native_event_id: None,
        at: ended_at,
    })
}

pub fn dispatch(
    module_name: &str,
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    fixture_dir: &Path,
) -> Result<Vec<NormalizedSession>, Box<dyn std::error::Error>> {
    dispatch_module(module_name, adapter, source, fixture_dir)
}

pub fn table_exists(conn: &Connection, table: &str) -> bool {
    let mut stmt = match conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1")
    {
        Ok(s) => s,
        Err(_) => return false,
    };
    stmt.exists([table]).unwrap_or(false)
}

pub fn table_columns(conn: &Connection, table: &str) -> HashSet<String> {
    let mut cols = HashSet::new();
    if let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info({})", table)) {
        if let Ok(mut rows) = stmt.query([]) {
            while let Ok(Some(row)) = rows.next() {
                if let Ok(name) = row.get::<_, String>(1) {
                    cols.insert(name.to_lowercase());
                }
            }
        }
    }
    cols
}

pub fn extract_files_from_value(val: &Value, files: &mut Vec<String>) {
    match val {
        Value::Object(map) => {
            for (key, v) in map {
                let lower_key = key.to_lowercase();
                if (lower_key == "path"
                    || lower_key == "file"
                    || lower_key == "filepath"
                    || lower_key == "file_path"
                    || lower_key == "filename"
                    || lower_key == "file_name"
                    || lower_key == "target_file"
                    || lower_key == "source_file"
                    || lower_key == "cwd"
                    || lower_key == "dir"
                    || lower_key == "directory")
                    && v.is_string()
                {
                    if let Some(s) = v.as_str() {
                        if !s.is_empty() && !files.contains(&s.to_string()) {
                            files.push(s.to_string());
                        }
                    }
                } else {
                    extract_files_from_value(v, files);
                }
            }
        }
        Value::Array(arr) => {
            for item in arr {
                extract_files_from_value(item, files);
            }
        }
        _ => {}
    }
}

/// Returns true if the module name is a recognized adapter module.
/// In G9, all 13 history modules are unified into one documented dispatch (`dispatch_module_batches`).
pub fn is_root_module(name: &str) -> bool {
    matches!(
        name,
        "opencode"
            | "crush"
            | "hermes-agent-cli"
            | "hermes_agent_cli"
            | "goose"
            | "aider"
            | "amp"
            | "kimi-code-cli"
            | "kimi_code_cli"
            | "antigravity-cli"
            | "antigravity_cli"
            | "cline"
            | "roo-code"
            | "kilo-code"
            | "continue"
            | "cursor-cli"
    )
}

use crate::model::{ImportBatch, ReadStatus};

pub fn process_module(
    module: &str,
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    context: &SourceContext,
    boundary: &ReadBoundary,
    root: &Path,
) -> Result<ImportBatch, Box<dyn std::error::Error>> {
    match module {
        "kimi-code-cli" | "kimi_code_cli" => kimi_code_cli::process(adapter, source, context, boundary, root),
        "antigravity-cli" | "antigravity_cli" => antigravity_cli::process(adapter, source, context, boundary, root),
        _ => Err(format!("Unknown adapter module '{}'", module).into()),
    }
}

pub mod shared;

#[path = "cline.rs"]
pub mod cline;

#[path = "roo-code.rs"]
pub mod roo_code;

#[path = "kilo-code.rs"]
pub mod kilo_code;

#[path = "continue.rs"]
pub mod continue_dev;

#[path = "cursor-cli.rs"]
pub mod cursor_cli;

/// Dispatches SQLite-based history modules (opencode, crush, hermes-agent-cli, goose).
///
/// Discovers database files within the approved read boundary, opens read-only
/// temporary snapshots, extracts sessions via the module's parser, and produces
/// completed ImportBatches with strict provenance and stable IDs conforming to CONTRACT.md.
pub fn dispatch_sqlite_module_batches(
    module_name: &str,
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    context: &SourceContext,
    boundary: &ReadBoundary,
    root: &Path,
) -> Result<Vec<ImportBatch>, Box<dyn std::error::Error>> {
    // Fixture stores use the relative fixture layout. A real store (any other store identity)
    // is matched by the database file names from the adapter's real per-OS paths.
    let is_fixture = context.store.canonical_root.starts_with("fixture://");
    let patterns = if is_fixture && !source.fixture_paths.is_empty() {
        source.fixture_paths.clone()
    } else if is_fixture && source.paths.get("default").is_some() {
        source.paths.get("default").cloned().unwrap_or_default()
    } else {
        let mut pats = vec![];
        for paths in source.paths.values() {
            for p in paths {
                if let Some(file_name) = Path::new(p).file_name().and_then(|s| s.to_str()) {
                    if !pats.contains(&file_name.to_string()) {
                        pats.push(file_name.to_string());
                        pats.push(format!("**/{file_name}"));
                    }
                }
            }
        }
        if pats.is_empty() {
            match module_name {
                "opencode" => {
                    pats.push("opencode.db".into());
                    pats.push("**/opencode.db".into());
                    pats.push("drafts.sqlite".into());
                    pats.push("**/drafts.sqlite".into());
                }
                "crush" => {
                    pats.push(".crush/crush.db".into());
                    pats.push("crush.db".into());
                    pats.push("**/crush.db".into());
                }
                "hermes-agent-cli" | "hermes_agent_cli" => {
                    pats.push("state.db".into());
                    pats.push("**/state.db".into());
                    pats.push("hermes.db".into());
                    pats.push("**/hermes.db".into());
                }
                "goose" => {
                    pats.push("sessions/sessions.sqlite".into());
                    pats.push("sessions.sqlite".into());
                    pats.push("**/sessions.sqlite".into());
                    pats.push("sessions/sessions.db".into());
                    pats.push("sessions.db".into());
                    pats.push("**/sessions.db".into());
                }
                _ => {}
            }
        }
        pats
    };

    let files = crate::engine::select_files(root, &patterns)?;
    let mut batches = Vec::new();

    for file in files {
        let relative = file
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");

        let mut provenance = SourceProvenance {
            store: context.store.clone(),
            source_id: source.id.clone().unwrap_or_else(|| source.format.clone()),
            adapter_id: adapter.id.clone(),
            adapter_version: adapter.adapter_version.clone(),
            source_path: relative.clone(),
            file_identity: if context.store.canonical_root.starts_with("fixture://") {
                format!("synthetic:{relative}")
            } else {
                "unread".into()
            },
            generation: context.generation,
            checkpoint: crate::model::Checkpoint {
                revision: context.revision,
                offset: 0,
                records: 0,
                digest: String::new(),
            },
        };

        match read_source_module(
            module_name,
            adapter,
            source,
            &mut provenance,
            context,
            boundary,
            &file,
        ) {
            Ok(sessions) => {
                batches.push(ImportBatch {
                    source: provenance,
                    mode: crate::model::ImportMode::Snapshot,
                    sessions,
                    read_status: ReadStatus::Complete,
                    diagnostics: vec![],
                    live_updates: vec![],
                });
            }
            Err(e) => {
                let code = match &e {
                    ReaderError::CredentialBlocked(_) => "credential_blocked",
                    ReaderError::Boundary(_) => "boundary",
                    ReaderError::Io(_) => "io",
                    ReaderError::Limit(_) => "limit",
                    ReaderError::Changed(_) => "changed",
                    ReaderError::Parse(_) => "parse",
                };
                let diag = armillary_model::ImportDiagnostic {
                    source_key: provenance.key(),
                    code: code.into(),
                    message: e.to_string(),
                    retryable: matches!(e, ReaderError::Io(_) | ReaderError::Changed(_)),
                };
                batches.push(ImportBatch {
                    source: provenance,
                    mode: crate::model::ImportMode::Snapshot,
                    sessions: vec![],
                    read_status: ReadStatus::Failed,
                    diagnostics: vec![diag],
                    live_updates: vec![],
                });
            }
        }
    }

    Ok(batches)
}

/// Unified module dispatch for all history modules in crates/adapters.
///
/// Every module (R1 SQLite modules, R2 multi-format modules, R3 JSON/VS Code modules)
/// routes through this function. It accepts:
/// - `module_name`: The module identifier declared in the builtin adapter TOML
/// - `adapter`: The adapter specification
/// - `source`: The specific history source declaring `module = "..."`
/// - `context`: SourceContext containing store identity, approved roots, generation, and revision
/// - `boundary`: ReadBoundary enforcing containment and blocking credential symlinks
/// - `root`: Canonical root path to inspect for sessions
///
/// Returns `Ok(Vec<ImportBatch>)` where each batch contains normalized sessions conforming
/// to CONTRACT.md (stable IDs, monotonic sequence numbers, explicit usage semantics, and
/// native completion evidence).
pub fn dispatch_module_batches(
    module_name: &str,
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    context: &SourceContext,
    boundary: &ReadBoundary,
    root: &Path,
) -> Result<Vec<ImportBatch>, Box<dyn std::error::Error>> {
    // Refusals belong to this source only (fixture_batches shares one boundary across sources).
    let _ = boundary.take_read_refusals();
    let mut batches = dispatch_module_batches_unchecked(module_name, adapter, source, context, boundary, root)?;
    report_size_refusals(adapter, source, context, boundary, root, &mut batches);
    Ok(batches)
}

/// P2-1 (r2 fix round 1): many modules skip a file they cannot read. A file refused for size is
/// reported as a Failed batch with a "limit" diagnostic and its root-relative path, unless the
/// module already reported it (or its database, for a -wal or -shm file). RR1-3 (r2 fix round 2):
/// the same for a file that cannot be opened ("io") or is a link out of the folder ("boundary").
fn report_size_refusals(
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    context: &SourceContext,
    boundary: &ReadBoundary,
    root: &Path,
    batches: &mut Vec<ImportBatch>,
) {
    let mut reported: Vec<String> = batches
        .iter()
        .filter(|b| b.read_status != ReadStatus::Complete)
        .map(|b| b.source.source_path.clone())
        .collect();
    for (path, error) in boundary.take_read_refusals() {
        let relative = path
            .strip_prefix(root)
            .ok()
            .map(Path::to_path_buf)
            .or_else(|| path.canonicalize().ok().and_then(|c| c.strip_prefix(root).ok().map(Path::to_path_buf)))
            .unwrap_or_else(|| path.clone())
            .to_string_lossy()
            .replace('\\', "/");
        let covered = reported.iter().any(|r| {
            relative == *r || ["-wal", "-shm", "-journal"].iter().any(|s| relative == format!("{r}{s}"))
        });
        if covered {
            continue;
        }
        batches.push(shared::failed_file_batch(adapter, source, context, &relative, &error));
        reported.push(relative);
    }
}

fn dispatch_module_batches_unchecked(
    module_name: &str,
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    context: &SourceContext,
    boundary: &ReadBoundary,
    root: &Path,
) -> Result<Vec<ImportBatch>, Box<dyn std::error::Error>> {
    match module_name {
        // R1 SQLite relational modules (unified in G9)
        "opencode"
        | "crush"
        | "hermes-agent-cli"
        | "hermes_agent_cli"
        | "goose" => dispatch_sqlite_module_batches(module_name, adapter, source, context, boundary, root),

        // Aider and Amp read many independent files: one batch per file (RV-ADP), so one bad or
        // deleted file never changes another file's checkpoint and a failed read is reported.
        "aider" => aider::parse_batches(adapter, source, context, boundary, root),
        "amp" => amp::parse_batches(adapter, source, context, boundary, root),

        // R2 modules
        "kimi-code-cli"
        | "kimi_code_cli"
        | "antigravity-cli"
        | "antigravity_cli" => {
            Ok(vec![process_module(module_name, adapter, source, context, boundary, root)?])
        }

        // R3 modules
        "cline" => cline::parse_batches(adapter, source, context, boundary, root),
        "roo-code" => roo_code::parse_batches(adapter, source, context, boundary, root),
        "kilo-code" => kilo_code::parse_batches(adapter, source, context, boundary, root),
        "continue" => continue_dev::parse_batches(adapter, source, context, boundary, root),
        "cursor-cli" => cursor_cli::parse_batches(adapter, source, context, boundary, root),

        _ => Err(format!("unknown history module: {}", module_name).into()),
    }
}

pub fn dispatch_module(
    module_name: &str,
    adapter: &AdapterDef,
    source: &HistorySourceDef,
    root: &Path,
) -> Result<Vec<NormalizedSession>, Box<dyn std::error::Error>> {
    let namespace = adapter.store_namespace.as_deref().unwrap_or(&adapter.id);
    let context = SourceContext {
        store: crate::model::StoreIdentity::new(namespace, &format!("fixture://{namespace}"), "synthetic"),
        approved_roots: vec![root.to_path_buf()],
        installation_id: None,
        generation: 1,
        revision: 1,
    };
    let boundary = ReadBoundary::new(&context.approved_roots)?;
    let batches = dispatch_module_batches(module_name, adapter, source, &context, &boundary, root)?;
    let mut sessions = vec![];
    for b in batches {
        if b.read_status != ReadStatus::Complete {
            return Err(format!("module read failed: {:?}", b.diagnostics).into());
        }
        sessions.extend(b.sessions);
    }
    sessions.sort_by(|a, b| a.session.id.cmp(&b.session.id));
    Ok(sessions)
}
