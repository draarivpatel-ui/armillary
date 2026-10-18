//! Background importer: runs installed adapters against their data folders,
//! writing into the archive through the contract's import batches.
//! Debounced notify watcher re-imports on data folder changes.
//! Emits `import:progress` payloads.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::Sender;
use serde::{Deserialize, Serialize};

use armillary_model::{Agent, ImportBatch, ImportDiagnostic, ReadStatus};
use orrery_adapters::detection::detect_agent;
use orrery_adapters::engine::AdapterEngine;
use orrery_adapters::env::{Environment, FileSystem};
use orrery_adapters::AdapterDef;
use orrery_archive::Archive;

/// Built-in adapter definitions shipped with the app.
pub const BUILTIN_ADAPTER_TOMLS: &[(&str, &str)] = &[
    (
        "claude-code",
        include_str!("../../../crates/adapters/src/builtins/claude-code.toml"),
    ),
    (
        "codex-cli",
        include_str!("../../../crates/adapters/src/builtins/codex-cli.toml"),
    ),
];

/// One adapter plus the machine data folders it should read.
#[derive(Debug, Clone)]
pub struct ImportTarget {
    pub adapter: AdapterDef,
    pub data_dirs: Vec<PathBuf>,
}

/// A progress event on the `import:progress` stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    /// "started" | "adapter" | "finished"
    pub phase: String,
    /// Adapter id for phase "adapter"; empty for run-level phases.
    pub agent_id: String,
    pub sessions_imported: u32,
    pub adapters_done: u32,
    pub adapters_total: u32,
}

/// An event on the `import:progress` stream. Same camelCase JSON shape as the first run's
/// `firstrun::ImportPayload` (a unit test in main.rs keeps the two identical).
///
/// Per agent: "started", zero or more "progress", then "finished" (or "error" when the agent's
/// run fails). A run also brackets itself with one event whose `agent_id` is empty and phase
/// "started", and one with an empty `agent_id` and phase "finished" (run totals), so a listener
/// knows when a background import ends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPayload {
    /// Adapter id; empty for the run-level "started" and "finished" events.
    pub agent_id: String,
    /// "started" | "progress" | "finished" | "error"
    pub phase: String,
    /// Sessions accepted into the archive so far (run total on the run-level "finished").
    pub sessions_imported: u32,
    /// Sessions discovered so far (grows while sources are listed).
    pub sessions_known: u32,
    /// First source read error for the agent, or the failure reason for phase "error".
    pub error: Option<String>,
    /// Sorted distinct project folder basenames of the agent's sessions (agent "finished" only).
    pub projects: Vec<String>,
}

/// A per-batch observation for one agent, reported by `Importer::run_observed`.
/// `sessions_known` grows as sources are listed; `sessions_imported` grows as batches are accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchProgress {
    pub agent_id: String,
    pub sessions_known: u32,
    pub sessions_imported: u32,
    pub error: Option<String>,
}

/// Totals for one import run.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub adapters: u32,
    pub sessions: u32,
    pub messages: u32,
}

/// Parse the built-in adapter definitions shipped with the app.
pub fn builtin_adapters() -> Vec<AdapterDef> {
    orrery_adapters::builtin_adapters()
}

/// Find every built-in adapter that is installed on this machine, with its
/// existing data folders. Reads only what adapter specs declare, never writes.
pub fn discover_targets(env: &dyn Environment, fs: &dyn FileSystem) -> Vec<ImportTarget> {
    let canonical = CanonicalHomeEnvironment { base: env };
    let env: &dyn Environment = &canonical;
    let mut targets = Vec::new();
    let os = env.os();
    let os_key = os.as_str();

    for adapter in builtin_adapters() {
        if adapter.history_sources.is_empty() {
            continue;
        }
        let detection = detect_agent(&adapter, env, fs);
        let mut data_dirs = detection.data_paths;

        // Also check if any history source base directory exists
        for source in &adapter.history_sources {
            let patterns = source.paths.get(os_key).or_else(|| source.paths.get("default"));
            if let Some(patterns) = patterns {
                for pattern in patterns {
                    let prefix = pattern.split(['*', '?', '[']).next().unwrap_or(pattern);
                    let base_dir_str = if prefix.ends_with('/') || prefix.ends_with('\\') {
                        prefix.trim_end_matches(['/', '\\'])
                    } else {
                        std::path::Path::new(prefix)
                            .parent()
                            .and_then(|p| p.to_str())
                            .unwrap_or(prefix)
                    };
                    if !base_dir_str.is_empty() {
                        if let Ok(expanded) = orrery_adapters::path_expansion::expand_path(base_dir_str, os, env) {
                            if fs.exists(&expanded) && fs.is_dir(&expanded) {
                                if !data_dirs.contains(&expanded) {
                                    data_dirs.push(expanded);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Deduplicate and filter out nested subdirectories
        data_dirs.sort();
        data_dirs.dedup();
        let mut deduplicated: Vec<PathBuf> = Vec::new();
        for dir in data_dirs {
            let is_nested = deduplicated.iter().any(|parent| dir.starts_with(parent));
            if !is_nested {
                deduplicated.push(dir);
            }
        }

        if detection.installed || !deduplicated.is_empty() {
            targets.push(ImportTarget {
                adapter,
                data_dirs: deduplicated,
            });
        }
    }
    targets
}

/// Helper environment wrapper that overrides home_dir and HOME for scoped runs (e.g. tests).
struct ScopedEnvironment<'a> {
    base: &'a dyn Environment,
    home: PathBuf,
}

impl<'a> Environment for ScopedEnvironment<'a> {
    fn home_dir(&self) -> Option<PathBuf> {
        Some(self.home.clone())
    }
    fn var(&self, key: &str) -> Option<String> {
        if key == "HOME" || key == "USERPROFILE" {
            Some(self.home.to_string_lossy().to_string())
        } else {
            self.base.var(key)
        }
    }
    fn os(&self) -> orrery_adapters::env::TargetOs {
        self.base.os()
    }
}

/// An environment whose HOME (and USERPROFILE and `home_dir`) is the canonical form of the base
/// environment's, when that path exists and can be canonicalised. A HOME reached through a symlink
/// (on macOS `/tmp` is a link to `/private/tmp`) otherwise expands history patterns to a path
/// that no canonical file path ever matches. Every other variable is passed through unchanged.
struct CanonicalHomeEnvironment<'a> {
    base: &'a dyn Environment,
}

/// The canonical form of `path`, or `path` itself when it cannot be canonicalised (it does not
/// exist, or this is Windows where a canonical path carries the `\\?\` prefix).
fn canonical_or_same(path: PathBuf) -> PathBuf {
    if cfg!(windows) {
        return path;
    }
    path.canonicalize().unwrap_or(path)
}

impl<'a> Environment for CanonicalHomeEnvironment<'a> {
    fn home_dir(&self) -> Option<PathBuf> {
        self.base.home_dir().map(canonical_or_same)
    }
    fn var(&self, key: &str) -> Option<String> {
        let value = self.base.var(key)?;
        if key == "HOME" || key == "USERPROFILE" {
            Some(canonical_or_same(PathBuf::from(&value)).to_string_lossy().to_string())
        } else {
            Some(value)
        }
    }
    fn os(&self) -> orrery_adapters::env::TargetOs {
        self.base.os()
    }
}

/// Infer the effective home directory from target data directories if they live in a test sandbox.
fn infer_home_dir(targets: &[ImportTarget], base_env: &dyn Environment) -> Option<PathBuf> {
    for target in targets {
        for dir in &target.data_dirs {
            if let Some(sys_home) = base_env.home_dir() {
                if let (Ok(can_dir), Ok(can_home)) = (dir.canonicalize(), sys_home.canonicalize()) {
                    if can_dir.starts_with(&can_home) {
                        return Some(can_home);
                    }
                }
            }
            // Check against known path patterns
            for hs in &target.adapter.history_sources {
                if let Some(patterns) = hs.paths.get(base_env.os().as_str()).or_else(|| hs.paths.get("default")) {
                    for pat in patterns {
                        if pat.starts_with("~/") {
                            let rel = &pat[2..];
                            let first_part = rel.split(['/', '\\', '*']).next().unwrap_or(rel);
                            let needle = format!("/{}", first_part);
                            let dir_str = dir.to_string_lossy();
                            if let Some(idx) = dir_str.find(&needle) {
                                let inferred = PathBuf::from(&dir_str[..idx]);
                                if inferred.exists() {
                                    return Some(inferred.canonicalize().unwrap_or(inferred));
                                }
                            }
                        }
                    }
                }
            }
            for (_os_name, paths) in &target.adapter.detection.paths {
                for folder in &paths.data_folders {
                    if folder.starts_with("~/") {
                        let rel = &folder[2..];
                        let first_part = rel.split(['/', '\\']).next().unwrap_or(rel);
                        let needle = format!("/{}", first_part);
                        let dir_str = dir.to_string_lossy();
                        if let Some(idx) = dir_str.find(&needle) {
                            let inferred = PathBuf::from(&dir_str[..idx]);
                            if inferred.exists() {
                                return Some(inferred.canonicalize().unwrap_or(inferred));
                            }
                        }
                    }
                }
            }
        }
    }
    base_env.home_dir()
}

/// Compute the canonical store identity for an adapter and a data directory.
/// This is the shared store identity helper required by G11 so that live sessions
/// and imported archive sessions agree on store identity.
pub fn store_identity(adapter: &AdapterDef, data_dir: &Path) -> armillary_model::StoreIdentity {
    let canonical_root = data_dir.canonicalize().unwrap_or_else(|_| data_dir.to_path_buf());
    let canonical_root_str = canonical_root.to_string_lossy().to_string();
    let namespace = adapter.store_namespace.as_deref().unwrap_or(&adapter.id);
    armillary_model::StoreIdentity::new(
        namespace,
        &canonical_root_str,
        "default",
    )
}

fn infer_home_from_file_path(file: &Path) -> Option<PathBuf> {
    let s = file.to_string_lossy();
    let markers = [
        "/.claude/",
        "/.codex/",
        "/.gemini/",
        "/.local/share/",
        "/Library/Application Support/",
    ];
    for m in &markers {
        if let Some(pos) = s.find(m) {
            let home_candidate = PathBuf::from(&s[..pos]);
            if home_candidate.exists() {
                return Some(home_candidate);
            }
        }
    }
    None
}

/// Resolve the canonical store identity for a given session file belonging to an agent.
/// Looks up the discovered canonical data folder for the agent (matching against `file_path`),
/// falling back to custom roots or the containing directory, and calls `store_identity`.
pub fn resolve_store_for_file(
    agent_id: &str,
    file_path: &Path,
    custom_roots: Option<&HashMap<String, PathBuf>>,
) -> armillary_model::StoreIdentity {
    let adapter = builtin_adapters()
        .into_iter()
        .find(|a| a.id == agent_id)
        .unwrap_or_else(|| {
            orrery_adapters::AdapterDef {
                id: agent_id.to_string(),
                name: agent_id.to_string(),
                vendor: "Unknown".into(),
                family: "Other".into(),
                kind: "cli".into(),
                adapter_version: "1.0.0".into(),
                store_namespace: None,
                homepage: None,
                docs_url: None,
                coverage: None,
                detection: Default::default(),
                history_sources: vec![],
            }
        });

    let canonical_file = file_path.canonicalize().unwrap_or_else(|_| file_path.to_path_buf());

    // 1. Check custom roots (e.g. from test config or explicit history roots)
    if let Some(roots) = custom_roots {
        if let Some(custom_root) = roots.get(agent_id) {
            let can_custom = custom_root.canonicalize().unwrap_or_else(|_| custom_root.clone());
            if canonical_file.starts_with(&can_custom) {
                if agent_id == "claude-code"
                    && can_custom.join("projects").exists()
                    && canonical_file.starts_with(&can_custom.join("projects"))
                {
                    return store_identity(&adapter, &can_custom.join("projects"));
                }
                if agent_id == "codex-cli"
                    && can_custom.join("sessions").exists()
                    && canonical_file.starts_with(&can_custom.join("sessions"))
                {
                    return store_identity(&adapter, &can_custom.join("sessions"));
                }
                return store_identity(&adapter, &can_custom);
            }
        }
    }

    // 2. Discover targets using system environment and inferring home if file is in a temp/scoped home
    let sys_env = orrery_adapters::env::SystemEnvironment;
    let fs = orrery_adapters::env::SystemFileSystem;

    let env_to_use: Box<dyn Environment> = if let Some(inferred_home) = infer_home_from_file_path(&canonical_file) {
        Box::new(ScopedEnvironment { base: &sys_env, home: inferred_home })
    } else {
        Box::new(sys_env)
    };

    let targets = discover_targets(env_to_use.as_ref(), &fs);
    if let Some(target) = targets.iter().find(|t| t.adapter.id == agent_id) {
        for dir in &target.data_dirs {
            let can_dir = dir.canonicalize().unwrap_or_else(|_| dir.clone());
            if canonical_file.starts_with(&can_dir) {
                return store_identity(&adapter, &can_dir);
            }
        }
    }

    // 3. Known relative folder heuristics for reference adapters (claude-code: projects, codex-cli: sessions)
    let mut curr = canonical_file.parent();
    while let Some(parent) = curr {
        let name = parent.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if (agent_id == "claude-code" && name == "projects")
            || (agent_id == "codex-cli" && name == "sessions")
            || (agent_id == "antigravity-cli" && (name == "antigravity-cli" || name == ".gemini"))
        {
            return store_identity(&adapter, parent);
        }
        curr = parent.parent();
    }

    // 4. Fallback to file's immediate parent directory
    let fallback_dir = canonical_file.parent().unwrap_or(&canonical_file);
    store_identity(&adapter, fallback_dir)
}

/// Whether an observed batch deserves a "progress" event. `last` is the (known, imported) pair
/// of the last emitted progress event, (0, 0) after "started". Deterministic: no clocks. Large
/// histories produce about 40 events per agent instead of one per file. (A copy of the first
/// run's throttle: integration tests include this file without `firstrun.rs`.)
fn progress_due(has_error: bool, known: u32, imported: u32, last: (u32, u32)) -> bool {
    if has_error || known != last.0 {
        return true;
    }
    if imported >= known && imported > last.1 {
        return true;
    }
    imported >= last.1.saturating_add((known / 40).max(1)) && imported > last.1
}

/// True when `c` can be part of a file or folder name (so a home path cannot end or start next to it).
fn is_name_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-')
}

/// Replace every home folder prefix in `text` with "~". A home matches only at a path-component
/// boundary: not in the middle of a longer name (`/Users/annabel` is not `/Users/ann`) and not
/// as the tail of a longer path (`/mnt/Users/ann`). The longest home wins, so a canonical form
/// that contains the raw one is replaced whole. Empty homes and the filesystem root are ignored.
pub fn redact_home(text: &str, homes: &[String]) -> String {
    let mut roots: Vec<&str> = homes
        .iter()
        .map(|h| h.trim_end_matches(['/', '\\']))
        .filter(|h| !h.is_empty())
        .collect();
    roots.sort_by_key(|r| std::cmp::Reverse(r.len()));
    roots.dedup();
    if roots.is_empty() || text.is_empty() {
        return text.to_string();
    }
    let before_ok = |i: usize| match text[..i].chars().next_back() {
        None => true,
        Some(c) => !(is_name_char(c) || matches!(c, '/' | '\\' | '.' | '~' | '+')),
    };
    let after_ok = |j: usize| {
        let mut rest = text[j..].chars();
        match rest.next() {
            None | Some('/') | Some('\\') => true,
            Some('.') => !rest.next().is_some_and(is_name_char),
            Some(c) => !is_name_char(c),
        }
    };
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let rest = &text[i..];
        if let Some(root) = roots.iter().find(|r| rest.starts_with(**r) && before_ok(i) && after_ok(i + r.len())) {
            out.push('~');
            i += root.len();
            continue;
        }
        let c = rest.chars().next().unwrap();
        out.push(c);
        i += c.len_utf8();
    }
    out
}

/// The home folder of `env` as the OS reports it (HOME / USERPROFILE / home_dir) and its canonical
/// form, for `redact_home`.
fn home_prefixes(env: &dyn Environment) -> Vec<String> {
    let mut paths: Vec<PathBuf> = Vec::new();
    paths.extend(env.home_dir());
    paths.extend(["HOME", "USERPROFILE"].iter().filter_map(|k| env.var(k)).map(PathBuf::from));
    let mut out: Vec<String> = Vec::new();
    for p in paths {
        if let Ok(canonical) = p.canonicalize() {
            out.push(canonical.to_string_lossy().to_string());
        }
        out.push(p.to_string_lossy().to_string());
    }
    out.sort();
    out.dedup();
    out
}

/// Last folder name of a project root (either separator, trailing separators ignored).
/// The plain-words notice for a source refused by a read limit: by record count when the reader
/// said so (`ReaderError::Limit("too many ...")`), otherwise by size.
fn skipped_message(reader_message: &str, path: &str) -> String {
    if reader_message.contains("too many") {
        let cap = orrery_adapters::boundary::MAX_SOURCE_RECORDS.to_string();
        let mut grouped = String::new();
        for (i, c) in cap.chars().enumerate() {
            if i > 0 && (cap.len() - i) % 3 == 0 {
                grouped.push(',');
            }
            grouped.push(c);
        }
        format!("Skipped, too large (over {grouped} records): {path}")
    } else {
        format!("Skipped, too large (over 64 MiB): {path}")
    }
}

fn project_basename(root: &str) -> String {
    let trimmed = root.trim_end_matches(['/', '\\']);
    match trimmed.rsplit(['/', '\\']).next() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => root.to_string(),
    }
}

/// Imports adapter output into the archive through contract import batches.
pub struct Importer {
    archive: Arc<Archive>,
    /// The cancel epoch this run started in; a later `cancel_running_imports` ends it.
    epoch: u64,
    /// Tests only: the cancel epoch is process-wide, so a test that cancels (watcher_stop_race)
    /// waits until no other test's importer is alive instead of cancelling it.
    #[cfg(test)]
    _cancel_guard: Option<std::sync::RwLockReadGuard<'static, ()>>,
}

#[cfg(test)]
pub(crate) static CANCEL_TEST_LOCK: std::sync::RwLock<()> = std::sync::RwLock::new(());

#[cfg(test)]
thread_local! {
    static HOLDING_CANCEL_WRITE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
pub(crate) struct CancelWriteGuard(#[allow(dead_code)] std::sync::RwLockWriteGuard<'static, ()>);

#[cfg(test)]
impl Drop for CancelWriteGuard {
    fn drop(&mut self) {
        HOLDING_CANCEL_WRITE.with(|h| h.set(false));
    }
}

#[cfg(test)]
pub(crate) fn cancel_test_write_guard() -> CancelWriteGuard {
    let g = CANCEL_TEST_LOCK.write().unwrap_or_else(|e| e.into_inner());
    HOLDING_CANCEL_WRITE.with(|h| h.set(true));
    CancelWriteGuard(g)
}

#[cfg(test)]
pub(crate) fn cancel_test_guard() -> Option<std::sync::RwLockReadGuard<'static, ()>> {
    if HOLDING_CANCEL_WRITE.with(|h| h.get()) {
        None
    } else {
        Some(CANCEL_TEST_LOCK.read().unwrap_or_else(|e| e.into_inner()))
    }
}

/// The error a stopped run returns.
pub(crate) const IMPORT_CANCELLED: &str = "import cancelled";

static IMPORT_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// End every import that is running now (consent withdrawn, or the archive is being deleted): each
/// stops before its next file read and before writing its next batch, and goes on to no other
/// source or agent. Imports started afterwards run normally.
pub fn cancel_running_imports() {
    IMPORT_EPOCH.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

/// The cancel epoch now. A thread that will build its importer later reads this first, so a stop
/// in between still cancels that importer (`Importer::with_epoch`).
pub(crate) fn current_epoch() -> u64 {
    IMPORT_EPOCH.load(std::sync::atomic::Ordering::SeqCst)
}

impl Importer {
    pub fn new(archive: Arc<Archive>) -> Self {
        #[cfg(test)]
        let _cancel_guard = cancel_test_guard();
        Self {
            archive,
            epoch: IMPORT_EPOCH.load(std::sync::atomic::Ordering::SeqCst),
            #[cfg(test)]
            _cancel_guard,
        }
    }

    /// An importer that belongs to an earlier cancel epoch. The watcher takes the epoch when the
    /// first file event arrives, so a stop during its debounce wait still cancels the run.
    pub(crate) fn with_epoch(archive: Arc<Archive>, epoch: u64) -> Self {
        Self {
            archive,
            epoch,
            #[cfg(test)]
            _cancel_guard: cancel_test_guard(),
        }
    }

    fn cancelled(&self) -> bool {
        IMPORT_EPOCH.load(std::sync::atomic::Ordering::SeqCst) != self.epoch
    }

    /// Run `f` (an adapter's reads) with this importer's stop installed for every file read.
    fn reading<R>(&self, f: impl FnOnce() -> R) -> R {
        let epoch = self.epoch;
        let stop: std::rc::Rc<dyn Fn() -> bool> =
            std::rc::Rc::new(move || IMPORT_EPOCH.load(std::sync::atomic::Ordering::SeqCst) != epoch);
        orrery_adapters::boundary::with_read_stop(stop, f)
    }

    /// True once a stop (`cancel_running_imports`) has ended this importer's runs.
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled()
    }

    /// Run (a subset of) the targets and write their batches into the archive.
    /// `agent_filter` limits the run to one adapter id when set.
    pub fn run(
        &self,
        targets: &[ImportTarget],
        agent_filter: Option<&str>,
        emit: &dyn Fn(ImportProgress),
    ) -> Result<ImportSummary, String> {
        let base_env = orrery_adapters::env::SystemEnvironment;
        if let Some(home) = infer_home_dir(targets, &base_env) {
            let scoped = ScopedEnvironment { base: &base_env, home };
            self.run_with_env(targets, agent_filter, &scoped, emit)
        } else {
            self.run_with_env(targets, agent_filter, &base_env, emit)
        }
    }

    /// Run targets using an explicit Environment instance.
    pub fn run_with_env(
        &self,
        targets: &[ImportTarget],
        agent_filter: Option<&str>,
        env: &dyn Environment,
        emit: &dyn Fn(ImportProgress),
    ) -> Result<ImportSummary, String> {
        self.run_observed(targets, agent_filter, env, emit, &|_| {})
    }

    /// Run like `run_with_env`, reporting `ImportPayload` events (see its docs for the sequence).
    ///
    /// Each agent runs on its own through `run_observed`. An agent whose run fails gets an
    /// "error" event and the run carries on; the result is still `Ok` with the totals of the
    /// agents that succeeded. `Err` is returned when the run cannot start at all (the archive is
    /// unusable), before any event is emitted, and when a stop ends the run (`IMPORT_CANCELLED`),
    /// after the run-level "finished" event.
    pub fn run_reporting(
        &self,
        targets: &[ImportTarget],
        agent_filter: Option<&str>,
        env: &dyn Environment,
        emit: &dyn Fn(ImportPayload),
    ) -> Result<ImportSummary, String> {
        // Fail early, and quietly, when the archive cannot be read at all.
        self.archive.agents().map_err(|e| e.to_string())?;

        // Events can reach the screen and logs; the archive's stored diagnostics keep the full text.
        let homes = home_prefixes(env);
        let event = |agent_id: &str, phase: &str, imported: u32, known: u32, error: Option<String>, projects: Vec<String>| {
            let error = error.map(|e| redact_home(&e, &homes));
            emit(ImportPayload {
                agent_id: agent_id.to_string(),
                phase: phase.to_string(),
                sessions_imported: imported,
                sessions_known: known,
                error,
                projects,
            });
        };

        let ids: Vec<&str> = targets
            .iter()
            .map(|t| t.adapter.id.as_str())
            .filter(|id| agent_filter.is_none_or(|f| f == *id))
            .collect();

        event("", "started", 0, 0, None, Vec::new());
        let mut summary = ImportSummary::default();
        let mut total_known = 0u32;
        let mut seen: Vec<String> = Vec::new();
        let mut every_agent_ran = true;
        for id in ids {
            // A stop ends the whole run: no further agent is read (R-1).
            if self.cancelled() {
                event("", "finished", summary.sessions, total_known, None, Vec::new());
                return Err(IMPORT_CANCELLED.to_string());
            }
            event(id, "started", 0, 0, None, Vec::new());

            let last = std::cell::Cell::new((0u32, 0u32)); // (imported, known) as last observed
            let last_emitted = std::cell::Cell::new((0u32, 0u32)); // (known, imported) as last emitted
            let first_error: std::cell::RefCell<Option<String>> = std::cell::RefCell::new(None);
            let observer = |b: BatchProgress| {
                if first_error.borrow().is_none() {
                    *first_error.borrow_mut() = b.error.clone();
                }
                last.set((b.sessions_imported, b.sessions_known));
                if !progress_due(b.error.is_some(), b.sessions_known, b.sessions_imported, last_emitted.get()) {
                    return;
                }
                last_emitted.set((b.sessions_known, b.sessions_imported));
                event(id, "progress", b.sessions_imported, b.sessions_known, b.error, Vec::new());
            };

            match self.run_observed_seen(targets, Some(id), env, &|_| {}, &observer, &mut seen) {
                Ok(agent) => {
                    let known = last.get().1.max(agent.sessions);
                    let projects = self.agent_projects(id)?;
                    summary.adapters += agent.adapters;
                    summary.sessions += agent.sessions;
                    summary.messages += agent.messages;
                    total_known += known;
                    event(id, "finished", agent.sessions, known, first_error.borrow().clone(), projects);
                }
                Err(e) => {
                    let (imported, known) = last.get();
                    total_known += known;
                    if self.cancelled() {
                        event(id, "error", imported, known, Some("Import stopped".to_string()), Vec::new());
                        event("", "finished", summary.sessions, total_known, None, Vec::new());
                        return Err(IMPORT_CANCELLED.to_string());
                    }
                    every_agent_ran = false;
                    event(id, "error", imported, known, Some(e), Vec::new());
                }
            }
        }
        // A full run read every source there is: a skip notice for a file it did not see (removed,
        // or its agent folder gone) is stale (R-3 / RR1-1).
        if agent_filter.is_none() && every_agent_ran && !self.cancelled() {
            let seen: std::collections::HashSet<String> = seen.into_iter().collect();
            let _ = self.archive.retain_diagnostics_with_code("limit", &seen);
        }
        event("", "finished", summary.sessions, total_known, None, Vec::new());
        Ok(summary)
    }

    /// Sorted distinct project folder basenames of one agent's archived sessions.
    fn agent_projects(&self, agent_id: &str) -> Result<Vec<String>, String> {
        let mut projects: Vec<String> = Vec::new();
        let mut offset = 0u32;
        loop {
            let page = self
                .archive
                .sessions_query(&orrery_archive::SessionFilter {
                    agent: Some(agent_id.to_string()),
                    limit: Some(200),
                    offset: Some(offset),
                    ..Default::default()
                })
                .map_err(|e| e.to_string())?;
            let got = page.items.len() as u32;
            projects.extend(
                page.items
                    .iter()
                    .filter_map(|s| s.project_root.as_deref())
                    .map(project_basename),
            );
            offset += got;
            if got == 0 || u64::from(offset) >= page.total {
                break;
            }
        }
        projects.sort();
        projects.dedup();
        Ok(projects)
    }

    /// Like `run_reporting`, with the environment chosen the way `run` chooses it (the real
    /// process environment, scoped to a home inferred from the target folders).
    pub fn run_reporting_inferred(
        &self,
        targets: &[ImportTarget],
        agent_filter: Option<&str>,
        emit: &dyn Fn(ImportPayload),
    ) -> Result<ImportSummary, String> {
        let base_env = orrery_adapters::env::SystemEnvironment;
        if let Some(home) = infer_home_dir(targets, &base_env) {
            let scoped = ScopedEnvironment { base: &base_env, home };
            self.run_reporting(targets, agent_filter, &scoped, emit)
        } else {
            self.run_reporting(targets, agent_filter, &base_env, emit)
        }
    }

    /// Like `run_with_env`, and also reports a `BatchProgress` for each listed source (sessions
    /// known grows), each imported batch (sessions imported grows) and each source read error.
    /// The `ImportProgress` stream and the returned summary are identical to `run_with_env`.
    pub fn run_observed(
        &self,
        targets: &[ImportTarget],
        agent_filter: Option<&str>,
        env: &dyn Environment,
        emit: &dyn Fn(ImportProgress),
        observe: &dyn Fn(BatchProgress),
    ) -> Result<ImportSummary, String> {
        self.run_observed_seen(targets, agent_filter, env, emit, observe, &mut Vec::new())
    }

    /// `run_observed`, also listing the source key of every batch it imported (`seen`).
    fn run_observed_seen(
        &self,
        targets: &[ImportTarget],
        agent_filter: Option<&str>,
        env: &dyn Environment,
        emit: &dyn Fn(ImportProgress),
        observe: &dyn Fn(BatchProgress),
        seen: &mut Vec<String>,
    ) -> Result<ImportSummary, String> {
        let canonical = CanonicalHomeEnvironment { base: env };
        let env: &dyn Environment = &canonical;
        let targets_to_run: Vec<&ImportTarget> = if let Some(agent_id) = agent_filter {
            targets.iter().filter(|t| t.adapter.id == agent_id).collect()
        } else {
            targets.iter().collect()
        };

        let adapters_total = targets_to_run.len() as u32;

        emit(ImportProgress {
            phase: "started".into(),
            agent_id: String::new(),
            sessions_imported: 0,
            adapters_done: 0,
            adapters_total,
        });

        let mut total_sessions = 0u32;
        let mut total_messages = 0u32;
        let mut adapters_done = 0u32;

        for target in &targets_to_run {
            if self.cancelled() {
                return Err(IMPORT_CANCELLED.to_string());
            }
            // Register adapter catalogue metadata in archive
            let agent = Agent {
                id: target.adapter.id.clone(),
                name: target.adapter.name.clone(),
                vendor: target.adapter.vendor.clone(),
                family: target.adapter.family.clone(),
                kind: target.adapter.kind.clone(),
            };
            let _ = self.archive.register_agent(&agent);

            let mut agent_known = 0u32;
            let mut agent_imported = 0u32;
            let progress_for = |known: u32, imported: u32, error: Option<String>| BatchProgress {
                agent_id: target.adapter.id.clone(),
                sessions_known: known,
                sessions_imported: imported,
                error,
            };

            for data_dir in &target.data_dirs {
                if self.cancelled() {
                    return Err(IMPORT_CANCELLED.to_string());
                }
                if !data_dir.exists() {
                    continue;
                }

                let store = store_identity(&target.adapter, data_dir);
                let canonical_root = PathBuf::from(&store.canonical_root);

                let context = orrery_adapters::engine::SourceContext {
                    store: store.clone(),
                    approved_roots: vec![canonical_root.clone()],
                    installation_id: None,
                    generation: 1,
                    revision: 1,
                };

                for source in &target.adapter.history_sources {
                    if self.cancelled() {
                        return Err(IMPORT_CANCELLED.to_string());
                    }
                    // Every file read checks the stop, so a stop mid-source ends the reading too.
                    let read = self.reading(|| AdapterEngine::source_batches(&target.adapter, source, &context, env));
                    if self.cancelled() {
                        return Err(IMPORT_CANCELLED.to_string());
                    }
                    let batches = match read {
                        Ok(b) => b,
                        Err(e) => {
                            let source_id = source.id.clone().unwrap_or_else(|| source.format.clone());
                            // The batch is keyed by (store, source_path), so give the unreadable
                            // source a placeholder path of its own and key the diagnostic with the
                            // same value; otherwise the archive rejects the pair as a mismatch.
                            let provenance = armillary_model::SourceProvenance {
                                store: store.clone(),
                                source_id: source_id.clone(),
                                adapter_id: target.adapter.id.clone(),
                                adapter_version: target.adapter.adapter_version.clone(),
                                source_path: format!("source:{source_id}"),
                                file_identity: "read_error".into(),
                                generation: 1,
                                checkpoint: armillary_model::Checkpoint {
                                    revision: 1,
                                    offset: 0,
                                    records: 0,
                                    digest: "0000000000000000000000000000000000000000000000000000000000000000".into(),
                                },
                            };
                            let source_key = provenance.key();
                            seen.push(source_key.clone());
                            // The rows for a source describe its latest read only (R-3).
                            let _ = self.archive.clear_diagnostics(&source_key);
                            let _ = self.archive.import_batch(&ImportBatch {
                                source: provenance,
                                mode: armillary_model::ImportMode::Snapshot,
                                read_status: ReadStatus::Failed,
                                sessions: vec![],
                                diagnostics: vec![ImportDiagnostic {
                                    source_key,
                                    code: "read_error".into(),
                                    message: e.to_string(),
                                    retryable: false,
                                }],
                                live_updates: vec![],
                            });
                            observe(progress_for(agent_known, agent_imported, Some(e.to_string())));
                            continue;
                        }
                    };
                    agent_known += batches.iter().map(|b| b.sessions.len() as u32).sum::<u32>();
                    observe(progress_for(agent_known, agent_imported, None));

                    for mut batch in batches {
                        if self.cancelled() {
                            return Err(IMPORT_CANCELLED.to_string());
                        }
                        let key = batch.source.key();
                        let prior = self.archive.source_checkpoint(&key).map_err(|e| e.to_string())?;

                        if let Some(old) = prior {
                            let file_unchanged = batch.source.checkpoint.offset == old.checkpoint.offset
                                && batch.source.checkpoint.records == old.checkpoint.records
                                && batch.source.checkpoint.digest == old.checkpoint.digest
                                && batch.source.file_identity == old.file_identity;

                            if file_unchanged {
                                // Idempotent replay: retain the accepted generation and revision
                                batch.source.generation = old.generation;
                                batch.source.checkpoint.revision = old.checkpoint.revision;
                            } else {
                                let rotated_or_truncated = batch.source.checkpoint.offset < old.checkpoint.offset
                                    || batch.source.checkpoint.records < old.checkpoint.records
                                    || batch.source.file_identity != old.file_identity;

                                if rotated_or_truncated {
                                    batch.source.generation = old.generation + 1;
                                    batch.source.checkpoint.revision = 1;
                                } else {
                                    // Incremental advance orders attempts within this generation
                                    batch.source.generation = old.generation;
                                    batch.source.checkpoint.revision = old.checkpoint.revision + 1;
                                }
                            }

                            // Align session provenance and message IDs with the batch generation
                            for s in &mut batch.sessions {
                                s.session.provenance = batch.source.clone();
                                for m in &mut s.messages {
                                    m.id = armillary_model::normalized_message_id(
                                        &s.session.id,
                                        m.native_id.as_deref(),
                                        &batch.source.key(),
                                        batch.source.generation,
                                        m.seq,
                                    );
                                }
                            }
                        }

                        let batch_sessions = batch.sessions.len() as u32;
                        let batch_messages: u32 = batch.sessions.iter().map(|s| s.messages.len() as u32).sum();

                        // R2-RC-3: each source file is read whole and refused above 64 MiB or
                        // 250,000 records; say so in plain words with the file it was (R-2: which
                        // limit). The archive keeps the same text, so the Field Guide can show it
                        // after the run (P2-2).
                        if batch.read_status == ReadStatus::Failed {
                            let path = batch.source.source_path.clone();
                            if let Some(d) = batch.diagnostics.first_mut().filter(|d| d.code == "limit") {
                                d.message = skipped_message(&d.message, &path);
                            }
                        }

                        // The rows for a source describe its latest read only (R-3): a fixed file
                        // loses its skip notice, and a still-too-large one keeps a single notice.
                        seen.push(key.clone());
                        self.archive.clear_diagnostics(&key).map_err(|e| e.to_string())?;
                        let outcome = self.archive.import_batch(&batch).map_err(|e| e.to_string())?;

                        if outcome.applied || outcome.reason.as_deref() == Some("replay") {
                            total_sessions += batch_sessions;
                            total_messages += batch_messages;
                            agent_imported += batch_sessions;
                        }
                        // A source the adapter could not read still yields a Failed batch with a
                        // diagnostic; surface it so a corrupt file never looks like a clean import.
                        let read_error = if batch.read_status == ReadStatus::Failed {
                            batch.diagnostics.first().map(|d| d.message.clone())
                        } else {
                            None
                        };
                        observe(progress_for(agent_known, agent_imported, read_error));
                    }
                }
            }

            adapters_done += 1;
            emit(ImportProgress {
                phase: "adapter".into(),
                agent_id: target.adapter.id.clone(),
                sessions_imported: total_sessions,
                adapters_done,
                adapters_total,
            });
        }

        emit(ImportProgress {
            phase: "finished".into(),
            agent_id: String::new(),
            sessions_imported: total_sessions,
            adapters_done,
            adapters_total,
        });

        Ok(ImportSummary {
            adapters: adapters_done,
            sessions: total_sessions,
            messages: total_messages,
        })
    }
}

/// Keeps notify watchers alive for the imported data folders and re-imports
/// an adapter when something under its folders changes. Stops on drop.
pub struct ImportWatcher {
    _watcher: notify::RecommendedWatcher,
    _stop_tx: crossbeam_channel::Sender<()>,
}

/// Returns the default list of directories and path prefixes ignored by the file watcher.
pub fn default_watcher_ignore_list() -> Vec<PathBuf> {
    let mut ignores = Vec::new();

    // 1. Temporary snapshot folders in system temp directory
    let temp_dir = std::env::temp_dir();
    ignores.push(temp_dir.join("armillary-sqlite"));
    ignores.push(temp_dir.join("orrery-sqlite-snapshot"));

    // 2. App's own data folders across platforms
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        let home_path = PathBuf::from(home);
        // macOS
        ignores.push(home_path.join("Library/Application Support/com.armillary.app"));
        ignores.push(home_path.join("Library/Application Support/Armillary"));
        ignores.push(home_path.join("Library/Application Support/orrery"));
        ignores.push(home_path.join("Library/Application Support/orrery-app"));
        // Linux
        ignores.push(home_path.join(".local/share/com.armillary.app"));
        ignores.push(home_path.join(".local/share/armillary"));
        ignores.push(home_path.join(".local/share/orrery"));
        // Windows
        if let Ok(appdata) = std::env::var("APPDATA") {
            let appdata_path = PathBuf::from(appdata);
            ignores.push(appdata_path.join("com.armillary.app"));
            ignores.push(appdata_path.join("Armillary"));
            ignores.push(appdata_path.join("orrery"));
        }
    }

    ignores
}

/// Checks whether a given path should be ignored by the file watcher so an import
/// can never re-trigger itself.
pub fn is_watcher_ignored(path: &Path, ignore_list: &[PathBuf]) -> bool {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let path_str = canonical.to_string_lossy();
    let raw_str = path.to_string_lossy();

    // Check explicit ignore list prefixes
    for ignored in ignore_list {
        let can_ignored = ignored.canonicalize().unwrap_or_else(|_| ignored.clone());
        if canonical.starts_with(&can_ignored) || path.starts_with(ignored) {
            return true;
        }
    }

    // Check for app data folder and database markers
    if path_str.contains("/com.armillary.app/")
        || path_str.contains("\\com.armillary.app\\")
        || raw_str.contains("/com.armillary.app/")
        || raw_str.contains("\\com.armillary.app\\")
        || path_str.ends_with("/com.armillary.app")
        || path_str.ends_with("\\com.armillary.app")
        || raw_str.ends_with("/com.armillary.app")
        || raw_str.ends_with("\\com.armillary.app")
    {
        return true;
    }

    // Check for archive SQLite files and companions
    if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
        if file_name.starts_with("armillary-archive.sqlite3")
            || file_name.starts_with("orrery-archive.sqlite3")
            || file_name.starts_with("snapshot.db")
        {
            return true;
        }
    }

    // Check for temporary SQLite snapshot directories
    if path_str.contains("orrery-sqlite-snapshot-")
        || path_str.contains("armillary-sqlite-")
        || raw_str.contains("orrery-sqlite-snapshot-")
        || raw_str.contains("armillary-sqlite-")
    {
        return true;
    }

    false
}

/// Start watching every data dir in `targets`. Progress events are sent to
/// `progress_tx`; the Tauri layer forwards them to the `import:progress` event.
pub fn spawn_watcher(
    archive: Arc<Archive>,
    targets: Vec<ImportTarget>,
    progress_tx: Sender<ImportPayload>,
) -> Result<ImportWatcher, String> {
    spawn_watcher_with_ignores(archive, targets, progress_tx, Vec::new())
}

/// Start watching with explicit extra ignore paths (such as test sandboxes or custom data dirs).
pub fn spawn_watcher_with_ignores(
    archive: Arc<Archive>,
    targets: Vec<ImportTarget>,
    progress_tx: Sender<ImportPayload>,
    extra_ignores: Vec<PathBuf>,
) -> Result<ImportWatcher, String> {
    use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};

    let mut ignore_list = default_watcher_ignore_list();
    ignore_list.extend(extra_ignores);

    let (notify_tx, notify_rx) = crossbeam_channel::unbounded();
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                let _ = notify_tx.send(event);
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("failed to initialize notify watcher: {e}"))?;

    for target in &targets {
        for dir in &target.data_dirs {
            if dir.exists() {
                let watch_dir = dir.canonicalize().unwrap_or_else(|_| dir.clone());
                if is_watcher_ignored(&watch_dir, &ignore_list) {
                    continue;
                }
                let _ = watcher.watch(&watch_dir, RecursiveMode::Recursive);
            }
        }
    }

    let (stop_tx, stop_rx) = crossbeam_channel::bounded(1);
    let watcher_archive = archive.clone();
    let watcher_targets = targets;
    let watcher_progress_tx = progress_tx;
    let thread_ignore_list = ignore_list;

    std::thread::spawn(move || {
        let debounce_duration = Duration::from_millis(150);
        loop {
            crossbeam_channel::select! {
                recv(stop_rx) -> _ => {
                    break;
                }
                recv(notify_rx) -> event => {
                    let event = match event {
                        Ok(e) => e,
                        Err(_) => break,
                    };

                    // Ignore events that exclusively affect app data or temp snapshots
                    if !event.paths.is_empty() && event.paths.iter().all(|p| is_watcher_ignored(p, &thread_ignore_list)) {
                        continue;
                    }

                    // The run this event asks for belongs to the epoch it arrived in (PRIV-1): a
                    // stop during the debounce below cancels it.
                    let epoch_at_event = IMPORT_EPOCH.load(std::sync::atomic::Ordering::SeqCst);

                    // Debounce: drain events until silence, ignoring self-triggered events
                    loop {
                        crossbeam_channel::select! {
                            recv(notify_rx) -> more => {
                                if more.is_err() { break; }
                            }
                            default(debounce_duration) => {
                                break;
                            }
                        }
                    }
                    // Stopped while waiting for silence (consent withdrawn, archive deleted): the
                    // watcher was dropped, so its stop channel is closed. No import.
                    if !matches!(stop_rx.try_recv(), Err(crossbeam_channel::TryRecvError::Empty)) {
                        break;
                    }
                    // Re-import
                    let importer = Importer::with_epoch(watcher_archive.clone(), epoch_at_event);
                    if importer.cancelled() {
                        continue;
                    }
                    let _ = importer.run_reporting_inferred(&watcher_targets, None, &|p| {
                        let _ = watcher_progress_tx.send(p);
                    });
                }
            }
        }
    });

    Ok(ImportWatcher {
        _watcher: watcher,
        _stop_tx: stop_tx,
    })
}

#[cfg(test)]
pub(crate) mod testutil {
    use super::*;
    use std::path::{Path, PathBuf};

    pub(crate) fn repo_fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
    }

    pub(crate) fn copy_dir_recursive(src: &Path, dst: &Path) {
        std::fs::create_dir_all(dst).unwrap();
        for entry in std::fs::read_dir(src).unwrap() {
            let entry = entry.unwrap();
            let from = entry.path();
            let to = dst.join(entry.file_name());
            if from.is_dir() {
                copy_dir_recursive(&from, &to);
            } else {
                std::fs::copy(&from, &to).unwrap();
            }
        }
    }

    /// Copy the synthetic fixture packs into the temp folder using their real layouts,
    /// so no test ever touches a real agent data directory.
    pub(crate) fn staged_targets(tmp: &Path) -> Vec<ImportTarget> {
        let home = tmp.to_path_buf();
        let mut targets = Vec::new();

        // 1. Claude Code: <home>/.claude/projects/my-web-app/session-001.jsonl
        let claude_dir = home.join(".claude");
        let claude_projects = claude_dir.join("projects");
        copy_dir_recursive(&repo_fixtures().join("claude-code/projects"), &claude_projects);
        let claude_adapter = builtin_adapters()
            .into_iter()
            .find(|a| a.id == "claude-code")
            .expect("built-in adapter claude-code");
        targets.push(ImportTarget {
            adapter: claude_adapter,
            data_dirs: vec![claude_dir],
        });

        // 2. Codex CLI: <home>/.codex/sessions/2026/10/12/rollout-*.jsonl
        let codex_dir = home.join(".codex");
        let codex_sessions = codex_dir.join("sessions");
        copy_dir_recursive(&repo_fixtures().join("codex-cli/sessions"), &codex_sessions);
        let codex_adapter = builtin_adapters()
            .into_iter()
            .find(|a| a.id == "codex-cli")
            .expect("built-in adapter codex-cli");
        targets.push(ImportTarget {
            adapter: codex_adapter,
            data_dirs: vec![codex_dir],
        });

        targets
    }

    pub(crate) fn append_record(path: &Path, line: &str) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        f.write_all(line.as_bytes()).unwrap();
        f.write_all(b"\n").unwrap();
        f.flush().unwrap();
    }

    pub(crate) fn appended_user_record(text: &str) -> String {
        format!(
            r#"{{"type":"user","uuid":"u99","sessionId":"claude-sess-alpha-001","timestamp":"2026-10-12T14:11:00.000Z","cwd":"/Users/developer/code/my-web-app","message":{{"role":"user","content":[{{"type":"text","text":"{text}"}}]}}}}"#
        )
    }

    /// Stage a history adapter fixture into its real paths under a temporary home.
    pub(crate) fn stage_history_adapter_to_home(home: &Path, adapter_id: &str) -> Vec<PathBuf> {
        let fix = repo_fixtures().join(adapter_id);
        if !fix.is_dir() {
            return Vec::new();
        }
        match adapter_id {
            "claude-code" => {
                let dir = home.join(".claude/projects");
                copy_dir_recursive(&fix.join("projects"), &dir);
                vec![dir]
            }
            "codex-cli" => {
                let dir = home.join(".codex/sessions");
                copy_dir_recursive(&fix.join("sessions"), &dir);
                vec![dir]
            }
            "antigravity-cli" => {
                let dir = home.join(".gemini/antigravity-cli");
                std::fs::create_dir_all(&dir).unwrap();
                let _ = std::fs::copy(fix.join("history.jsonl"), dir.join("history.jsonl"));
                let brain = fix.join("brain");
                if brain.is_dir() {
                    copy_dir_recursive(&brain, &dir.join("brain"));
                }
                vec![dir]
            }
            "amp" => {
                let dir = home.join(".local/share/amp/threads");
                copy_dir_recursive(&fix.join("threads"), &dir);
                vec![dir]
            }
            "crush" => {
                let dir = home.join(".local/share/crush");
                std::fs::create_dir_all(&dir).unwrap();
                let _ = std::fs::copy(fix.join(".crush/crush.db"), dir.join("crush.db"));
                vec![dir]
            }
            "cline" => {
                let dir = home.join(".cline/data/sessions");
                if fix.join("sessions").is_dir() {
                    copy_dir_recursive(&fix.join("sessions"), &dir);
                }
                vec![home.join(".cline/data")]
            }
            "continue" => {
                let dir = home.join(".continue/sessions");
                if fix.join("sessions").is_dir() {
                    copy_dir_recursive(&fix.join("sessions"), &dir);
                }
                vec![dir]
            }
            "cursor-cli" => {
                let dir = home.join(".cursor/chats");
                if fix.join("chats").is_dir() {
                    copy_dir_recursive(&fix.join("chats"), &dir);
                }
                vec![dir]
            }
            "factory-droid" => {
                let dir = home.join(".factory/sessions");
                if fix.join("sessions").is_dir() {
                    copy_dir_recursive(&fix.join("sessions"), &dir);
                }
                vec![dir]
            }
            "gemini-cli" => {
                let dir = home.join(".gemini/tmp");
                if fix.join("tmp").is_dir() {
                    copy_dir_recursive(&fix.join("tmp"), &dir);
                }
                vec![dir]
            }
            "github-copilot-cli" => {
                let dir = home.join(".copilot/session-state");
                if fix.join("session-state").is_dir() {
                    copy_dir_recursive(&fix.join("session-state"), &dir);
                }
                vec![dir]
            }
            "goose" => {
                let dir = home.join(".local/share/goose/sessions");
                std::fs::create_dir_all(&dir).unwrap();
                let _ = std::fs::copy(fix.join("sessions/sessions.sqlite"), dir.join("sessions.db"));
                vec![dir]
            }
            "hermes-agent-cli" => {
                let dir = home.join(".hermes");
                std::fs::create_dir_all(&dir).unwrap();
                let _ = std::fs::copy(fix.join("state.db"), dir.join("state.db"));
                vec![dir]
            }
            "iflow-cli" => {
                let dir = home.join(".iflow/projects");
                if fix.join(".iflow/projects").is_dir() {
                    copy_dir_recursive(&fix.join(".iflow/projects"), &dir);
                }
                vec![dir]
            }
            "kilo-code" => {
                let dir = home.join("Library/Application Support/Code/User/globalStorage/kilocode.kilo-code/tasks");
                if fix.join("tasks").is_dir() {
                    copy_dir_recursive(&fix.join("tasks"), &dir);
                }
                vec![home.join("Library/Application Support/Code/User/globalStorage/kilocode.kilo-code")]
            }
            "kimi-code-cli" => {
                let dir = home.join(".kimi-code/sessions");
                if fix.join("sessions").is_dir() {
                    copy_dir_recursive(&fix.join("sessions"), &dir);
                }
                vec![dir]
            }
            "open-interpreter" => {
                let dir = home.join(".openinterpreter/sessions");
                if fix.join(".openinterpreter/sessions").is_dir() {
                    copy_dir_recursive(&fix.join(".openinterpreter/sessions"), &dir);
                }
                vec![dir]
            }
            "opencode" => {
                let dir = home.join(".local/share/opencode");
                std::fs::create_dir_all(&dir).unwrap();
                let _ = std::fs::copy(fix.join("opencode.db"), dir.join("opencode.db"));
                vec![dir]
            }
            "qoder-cli" => {
                let dir = home.join(".qoder/projects");
                if fix.join("projects").is_dir() {
                    copy_dir_recursive(&fix.join("projects"), &dir);
                }
                vec![dir]
            }
            "qwen-code" => {
                let dir = home.join(".qwen/tmp");
                if fix.join("tmp").is_dir() {
                    copy_dir_recursive(&fix.join("tmp"), &dir);
                }
                vec![dir]
            }
            "roo-code" => {
                let dir = home.join("Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks");
                if fix.join("tasks").is_dir() {
                    copy_dir_recursive(&fix.join("tasks"), &dir);
                }
                vec![home.join("Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline")]
            }
            "aider" => {
                let dir = home.join("etl-sandbox");
                if fix.join("etl-sandbox").is_dir() {
                    copy_dir_recursive(&fix.join("etl-sandbox"), &dir);
                }
                vec![dir]
            }
            _ => {
                let dir = home.join(adapter_id);
                copy_dir_recursive(&fix, &dir);
                vec![dir]
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;

    /// R2-RC-3: a source file over the 64 MiB read limit is reported in plain words (the Field
    /// Guide shows this text), not as a raw reader error.
    #[test]
    fn an_oversized_source_is_reported_as_skipped_too_large() {
        let home = crate::archive_api::testkit::tmp();
        let targets: Vec<ImportTarget> = testutil::staged_targets(home.path())
            .into_iter()
            .filter(|t| t.adapter.id == "claude-code")
            .collect();
        let dir = home.path().join(".claude/projects/my-web-app");
        std::fs::create_dir_all(&dir).unwrap();
        let line = format!("{{\"type\":\"user\",\"pad\":\"{}\"}}\n", "x".repeat(1024 * 1024));
        let mut big = String::with_capacity(66 * line.len());
        for _ in 0..66 {
            big.push_str(&line);
        }
        std::fs::write(dir.join("big.jsonl"), big).unwrap();
        let errors = std::sync::Mutex::new(Vec::new());
        Importer::new(Arc::new(Archive::in_memory().unwrap()))
            .run_reporting_inferred(&targets, None, &|p: ImportPayload| {
                if let Some(e) = p.error {
                    errors.lock().unwrap().push(e);
                }
            })
            .unwrap();
        let errors = errors.into_inner().unwrap();
        assert!(
            errors.iter().any(|e| e.starts_with("Skipped, too large") && e.contains("64 MiB") && e.contains("big.jsonl")),
            "{errors:?}"
        );
    }
    /// P2-2 / V-REG-8 (r2 fix round 1): the skip is also kept in the archive's diagnostics with the
    /// same plain text and file name, so the Field Guide can show it later (the launch import and
    /// the first-run import run while the Field Guide is not open). Covers a module adapter too.
    #[test]
    fn an_oversized_source_is_stored_as_a_plain_limit_diagnostic() {
        let home = crate::archive_api::testkit::tmp();
        let continue_adapter = builtin_adapters().into_iter().find(|a| a.id == "continue").unwrap();
        let data_dirs = testutil::stage_history_adapter_to_home(home.path(), "continue");
        let big = data_dirs[0].join("big-session.json");
        std::fs::File::create(&big)
            .unwrap()
            .set_len(orrery_adapters::boundary::MAX_SOURCE_BYTES + 1024)
            .unwrap();
        let targets = vec![ImportTarget { adapter: continue_adapter, data_dirs }];
        let archive = Arc::new(Archive::in_memory().unwrap());
        let errors = std::sync::Mutex::new(Vec::new());
        Importer::new(archive.clone())
            .run_reporting_inferred(&targets, None, &|p: ImportPayload| {
                if let Some(e) = p.error {
                    errors.lock().unwrap().push(e);
                }
            })
            .unwrap();
        let errors = errors.into_inner().unwrap();
        assert!(
            errors.iter().any(|e| e.starts_with("Skipped, too large (over 64 MiB): ") && e.ends_with("big-session.json")),
            "progress: {errors:?}"
        );
        let stored = archive.recent_diagnostics(100).unwrap();
        let limit: Vec<_> = stored.iter().filter(|d| d.code == "limit").collect();
        assert_eq!(limit.len(), 1, "{stored:?}");
        assert!(
            limit[0].message.starts_with("Skipped, too large (over 64 MiB): ") && limit[0].message.ends_with("big-session.json"),
            "{stored:?}"
        );
        assert!(archive.stats().unwrap().sessions > 0, "the normal session still imports");
    }

    use orrery_adapters::env::{MockEnvironment, MockFileSystem, TargetOs};
    use orrery_archive::{SearchFilter, SessionFilter};
    use std::time::{Duration, Instant};

    #[test]
    fn builtin_adapters_parse() {
        let adapters = builtin_adapters();
        let history_adapters: Vec<String> = adapters
            .iter()
            .filter(|a| !a.history_sources.is_empty())
            .map(|a| a.id.clone())
            .collect();
        assert_eq!(history_adapters.len(), 22);
        assert!(history_adapters.contains(&"claude-code".to_string()));
        assert!(history_adapters.contains(&"codex-cli".to_string()));
    }

    #[test]
    fn discover_targets_finds_only_installed_adapters() {
        let env = MockEnvironment::new(TargetOs::Macos, "/fakehome");
        let mut fs = MockFileSystem::new();
        fs.add_dir("/fakehome/.claude/projects");
        fs.add_binary("claude", PathBuf::from("/usr/local/bin/claude"));
        // codex is not installed on this mock machine.

        let targets = discover_targets(&env, &fs);
        assert_eq!(targets.len(), 1, "only claude-code is installed");
        assert_eq!(targets[0].adapter.id, "claude-code");
        assert!(targets[0]
            .data_dirs
            .contains(&PathBuf::from("/fakehome/.claude/projects")));
    }

    #[test]
    fn importer_run_upserts_and_emits_progress() {
        let tmp = tempfile::tempdir().unwrap();
        let targets = staged_targets(tmp.path());
        let archive = Arc::new(Archive::in_memory().unwrap());
        let importer = Importer::new(archive.clone());

        let events = Arc::new(std::sync::Mutex::new(Vec::<ImportProgress>::new()));
        let summary = {
            let events = events.clone();
            importer
                .run(&targets, None, &|p| events.lock().unwrap().push(p))
                .unwrap()
        };
        assert_eq!(summary.adapters, 2);
        assert_eq!(summary.sessions, 2);
        assert!(summary.messages > 0);

        let events = events.lock().unwrap();
        assert_eq!(events.first().unwrap().phase, "started");
        assert_eq!(events.last().unwrap().phase, "finished");
        assert_eq!(events.last().unwrap().sessions_imported, 2);
        let adapter_events: Vec<&ImportProgress> =
            events.iter().filter(|p| p.phase == "adapter").collect();
        assert_eq!(adapter_events.len(), 2);

        let page = archive.sessions_query(&SessionFilter::default()).unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.items[0].agent_id, "claude-code");
        let agents = archive.agents().unwrap();
        assert_eq!(agents.len(), 2, "adapters register themselves in the archive");
    }

    #[test]
    fn agent_filter_runs_one_adapter() {
        let tmp = tempfile::tempdir().unwrap();
        let targets = staged_targets(tmp.path());
        let archive = Arc::new(Archive::in_memory().unwrap());
        let importer = Importer::new(archive.clone());

        let summary = importer.run(&targets, Some("codex-cli"), &|_| {}).unwrap();
        assert_eq!(summary.adapters, 1);
        assert_eq!(summary.sessions, 1);
        let page = archive.sessions_query(&SessionFilter::default()).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].agent_id, "codex-cli");
    }

    #[test]
    fn watcher_reimports_changed_fixture() {
        let tmp = tempfile::tempdir().unwrap();
        let targets = staged_targets(tmp.path());
        let archive = Arc::new(Archive::in_memory().unwrap());
        Importer::new(archive.clone())
            .run(&targets, None, &|_| {})
            .unwrap();
        assert!(archive
            .search("flarewatch", &SearchFilter::default())
            .unwrap()
            .is_empty());

        let (tx, rx) = crossbeam_channel::unbounded();
        let watcher = spawn_watcher(archive.clone(), targets.clone(), tx).unwrap();

        // Give the watcher a moment to register, then change one fixture file.
        std::thread::sleep(Duration::from_millis(500));
        let session_file = targets[0]
            .data_dirs
            .first()
            .unwrap()
            .join("projects/my-web-app/session-001.jsonl");
        let _guard = cancel_test_guard();
        append_record(&session_file, &appended_user_record("marker flarewatch note"));

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let hits = archive
                .search("flarewatch", &SearchFilter::default())
                .unwrap();
            if !hits.is_empty() {
                break;
            }
            if Instant::now() >= deadline {
                panic!("watcher did not re-import the changed fixture within 10s");
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        drop(_guard);
        drop(watcher);

        // Re-import stayed incremental: still two sessions in the archive.
        let page = archive.sessions_query(&SessionFilter::default()).unwrap();
        assert_eq!(page.total, 2);

        // And the watcher reported progress on its stream.
        let progress: Vec<ImportPayload> = rx.try_iter().collect();
        assert!(
            progress.iter().any(|p| p.agent_id.is_empty() && p.phase == "finished"),
            "watcher emitted a run-level finished import:progress event"
        );
        assert!(
            progress.iter().any(|p| p.agent_id == "claude-code" && p.phase == "finished"),
            "watcher emitted the changed agent's finished event"
        );
    }

    // ---- run_reporting: the import:progress payload stream ----

    fn scoped_env(home: &Path) -> MockEnvironment {
        MockEnvironment::new(TargetOs::current(), home.to_str().unwrap())
    }

    fn collect_reporting(
        importer: &Importer,
        targets: &[ImportTarget],
        filter: Option<&str>,
        env: &dyn Environment,
    ) -> (Result<ImportSummary, String>, Vec<ImportPayload>) {
        let events = std::sync::Mutex::new(Vec::<ImportPayload>::new());
        let result = importer.run_reporting(targets, filter, env, &|p| events.lock().unwrap().push(p));
        (result, events.into_inner().unwrap())
    }

    #[test]
    fn import_payload_has_the_firstrun_json_shape() {
        let p = ImportPayload {
            agent_id: "claude-code".into(),
            phase: "progress".into(),
            sessions_imported: 1,
            sessions_known: 2,
            error: None,
            projects: vec!["my-web-app".into()],
        };
        assert_eq!(
            serde_json::to_value(&p).unwrap(),
            serde_json::json!({
                "agentId": "claude-code",
                "phase": "progress",
                "sessionsImported": 1,
                "sessionsKnown": 2,
                "error": null,
                "projects": ["my-web-app"]
            })
        );
        let back: ImportPayload = serde_json::from_value(serde_json::to_value(&p).unwrap()).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn progress_throttle_matches_the_first_run() {
        // Errors and a changed known count are always due.
        assert!(progress_due(true, 5, 0, (5, 0)));
        assert!(progress_due(false, 5, 0, (0, 0)));
        // Same known count, nothing new imported: not due.
        assert!(!progress_due(false, 5, 0, (5, 0)));
        // Everything imported is due once.
        assert!(progress_due(false, 5, 5, (5, 0)));
        assert!(!progress_due(false, 5, 5, (5, 5)));
        // Large histories report about every 1/40th.
        assert!(!progress_due(false, 400, 9, (400, 0)));
        assert!(progress_due(false, 400, 10, (400, 0)));
    }

    #[test]
    fn run_reporting_streams_run_and_agent_events() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().canonicalize().unwrap();
        let targets = staged_targets(&home);
        let env = scoped_env(&home);
        let archive = Arc::new(Archive::in_memory().unwrap());
        let importer = Importer::new(archive.clone());

        let (result, events) = collect_reporting(&importer, &targets, None, &env);
        let summary = result.expect("reporting run");
        assert_eq!((summary.adapters, summary.sessions), (2, 2));

        // Run-level brackets: empty agent id, started first, finished last with run totals.
        let first = events.first().unwrap();
        assert_eq!((first.agent_id.as_str(), first.phase.as_str()), ("", "started"));
        assert_eq!((first.sessions_imported, first.sessions_known), (0, 0));
        assert!(first.error.is_none() && first.projects.is_empty());
        let last = events.last().unwrap();
        assert_eq!((last.agent_id.as_str(), last.phase.as_str()), ("", "finished"));
        assert_eq!((last.sessions_imported, last.sessions_known), (2, 2));
        assert_eq!(events.iter().filter(|e| e.agent_id.is_empty()).count(), 2, "only two run-level events");

        // Per agent: started, progress*, finished; counts monotonic, known >= imported.
        for id in ["claude-code", "codex-cli"] {
            let seq: Vec<&ImportPayload> = events.iter().filter(|e| e.agent_id == id).collect();
            assert!(seq.len() >= 3, "{id}: started, progress, finished");
            assert_eq!(seq.first().unwrap().phase, "started");
            assert_eq!(
                (seq[0].sessions_imported, seq[0].sessions_known, seq[0].error.clone(), seq[0].projects.clone()),
                (0, 0, None, Vec::new())
            );
            let fin = seq.last().unwrap();
            assert_eq!(fin.phase, "finished");
            assert_eq!((fin.sessions_imported, fin.sessions_known), (1, 1));
            assert!(fin.error.is_none());
            assert!(seq[1..seq.len() - 1].iter().all(|e| e.phase == "progress"), "{id}: only progress between");
            assert!(seq[1..seq.len() - 1].len() >= 1, "{id}: at least one progress event");
            let mut prev = (0, 0);
            for e in &seq {
                assert!(e.sessions_known >= e.sessions_imported, "{id}: {e:?}");
                assert!(e.sessions_imported >= prev.0 && e.sessions_known >= prev.1, "{id} monotonic: {e:?}");
                prev = (e.sessions_imported, e.sessions_known);
            }
        }

        // Agents run one after the other: every claude-code event precedes every codex-cli event.
        let last_claude = events.iter().rposition(|e| e.agent_id == "claude-code").unwrap();
        let first_codex = events.iter().position(|e| e.agent_id == "codex-cli").unwrap();
        assert!(last_claude < first_codex);

        // "finished" lists sorted distinct project basenames taken from the archive.
        let finished = |id: &str| events.iter().find(|e| e.agent_id == id && e.phase == "finished").unwrap();
        let claude_projects = &finished("claude-code").projects;
        assert!(claude_projects.contains(&"my-web-app".to_string()), "{claude_projects:?}");
        for id in ["claude-code", "codex-cli"] {
            let projects = &finished(id).projects;
            let mut sorted = projects.clone();
            sorted.sort();
            sorted.dedup();
            assert_eq!(projects, &sorted, "{id}: sorted and distinct");
            assert!(projects.iter().all(|p| !p.contains('/') && !p.is_empty()), "{id}: basenames only");
        }
    }

    #[test]
    fn run_reporting_honours_the_agent_filter() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().canonicalize().unwrap();
        let targets = staged_targets(&home);
        let env = scoped_env(&home);
        let importer = Importer::new(Arc::new(Archive::in_memory().unwrap()));

        let (result, events) = collect_reporting(&importer, &targets, Some("codex-cli"), &env);
        assert_eq!(result.unwrap().sessions, 1);
        assert!(events.iter().all(|e| e.agent_id.is_empty() || e.agent_id == "codex-cli"));
        assert!(events.iter().any(|e| e.agent_id == "codex-cli" && e.phase == "finished"));
        let last = events.last().unwrap();
        assert_eq!((last.agent_id.as_str(), last.phase.as_str(), last.sessions_imported), ("", "finished", 1));
    }

    #[test]
    fn run_reporting_with_no_targets_still_brackets_the_run() {
        let importer = Importer::new(Arc::new(Archive::in_memory().unwrap()));
        let env = scoped_env(Path::new("/nonexistent-home"));
        let (result, events) = collect_reporting(&importer, &[], None, &env);
        assert_eq!(result.unwrap().sessions, 0);
        let shape: Vec<(&str, &str)> = events.iter().map(|e| (e.agent_id.as_str(), e.phase.as_str())).collect();
        assert_eq!(shape, vec![("", "started"), ("", "finished")]);
    }

    // ---- read errors keep their own diagnostic ----

    /// Makes a folder unreadable and restores it on drop so the temp dir can be removed.
    #[cfg(unix)]
    struct Locked(PathBuf);
    #[cfg(unix)]
    impl Locked {
        fn new(path: PathBuf) -> Self {
            use std::os::unix::fs::PermissionsExt;
            std::fs::create_dir_all(&path).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
            Locked(path)
        }
    }
    #[cfg(unix)]
    impl Drop for Locked {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
        }
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_source_keeps_its_read_error_diagnostic() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().canonicalize().unwrap();
        let targets: Vec<ImportTarget> = staged_targets(&home)
            .into_iter()
            .filter(|t| t.adapter.id == "claude-code")
            .collect();
        // A folder the walk cannot list makes AdapterEngine::source_batches return Err.
        let _locked = Locked::new(home.join(".claude/locked"));
        let env = scoped_env(&home);
        let archive = Arc::new(Archive::in_memory().unwrap());
        let importer = Importer::new(archive.clone());

        importer
            .run_with_env(&targets, None, &env, &|_| {})
            .expect("a read error is not a failed run");

        let all = archive.recent_diagnostics(100).unwrap();
        assert!(
            all.iter().all(|d| d.code != "rejected"),
            "the archive must not reject the read-error batch: {all:?}"
        );
        let read_error = all
            .iter()
            .find(|d| d.code == "read_error")
            .unwrap_or_else(|| panic!("a read_error diagnostic is stored: {all:?}"));
        assert!(read_error.message.contains("Permission denied"), "{}", read_error.message);
        assert!(!read_error.retryable);

        // Looked up by its own key (what import_diagnostics(key) does), the real error comes back.
        let by_key = archive.diagnostics(&read_error.source_key).unwrap();
        assert!(
            by_key.iter().any(|d| d.code == "read_error" && d.message == read_error.message),
            "{by_key:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_source_is_reported_on_the_event_stream() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().canonicalize().unwrap();
        let targets: Vec<ImportTarget> = staged_targets(&home)
            .into_iter()
            .filter(|t| t.adapter.id == "claude-code")
            .collect();
        let _locked = Locked::new(home.join(".claude/locked"));
        let importer = Importer::new(Arc::new(Archive::in_memory().unwrap()));

        let (result, events) = collect_reporting(&importer, &targets, None, &scoped_env(&home));
        result.expect("a read error is not a failed run");
        // The agent finishes with its first read error, and the run still ends.
        let fin = events.iter().find(|e| e.agent_id == "claude-code" && e.phase == "finished").unwrap();
        assert!(fin.error.as_deref().is_some_and(|e| e.contains("Permission denied")), "{fin:?}");
        let last = events.last().unwrap();
        assert_eq!((last.agent_id.as_str(), last.phase.as_str()), ("", "finished"));
    }
    // ---- home folder redaction in import:progress error text ----

    fn homes(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn redact_home_replaces_the_home_prefix_with_a_tilde() {
        let h = homes(&["/Users/ann"]);
        assert_eq!(
            redact_home("cannot read /Users/ann/.claude/projects: Permission denied (os error 13)", &h),
            "cannot read ~/.claude/projects: Permission denied (os error 13)"
        );
        assert_eq!(redact_home("home is /Users/ann", &h), "home is ~");
        assert_eq!(redact_home("quoted '/Users/ann/x' and \"/Users/ann/y\"", &h), "quoted '~/x' and \"~/y\"");
        assert_eq!(redact_home("/Users/ann/a: no such file", &h), "~/a: no such file");
    }

    #[test]
    fn redact_home_replaces_every_occurrence() {
        let h = homes(&["/Users/ann"]);
        assert_eq!(
            redact_home("/Users/ann/a then /Users/ann/b and /Users/ann", &h),
            "~/a then ~/b and ~"
        );
    }

    #[test]
    fn redact_home_respects_path_component_boundaries() {
        let h = homes(&["/Users/ann"]);
        assert_eq!(redact_home("/Users/annabel/x", &h), "/Users/annabel/x", "a longer name is another folder");
        assert_eq!(redact_home("/Users/ann.bak/x", &h), "/Users/ann.bak/x");
        assert_eq!(redact_home("/mnt/Users/ann/x", &h), "/mnt/Users/ann/x", "only a leading home prefix");
        assert_eq!(redact_home("x/Users/ann/y", &h), "x/Users/ann/y");
        assert_eq!(redact_home("see /Users/ann.", &h), "see ~.", "a sentence-ending dot is not part of the name");
    }

    #[test]
    fn redact_home_handles_both_the_raw_and_the_canonical_form() {
        let h = homes(&["/var/folders/xx/T/home", "/private/var/folders/xx/T/home"]);
        assert_eq!(
            redact_home("a /var/folders/xx/T/home/p and /private/var/folders/xx/T/home/q", &h),
            "a ~/p and ~/q"
        );
        // Order does not matter and a trailing slash on the home is tolerated.
        let rev = homes(&["/private/var/folders/xx/T/home/", "/var/folders/xx/T/home"]);
        assert_eq!(redact_home("/private/var/folders/xx/T/home/q", &rev), "~/q");
    }

    #[test]
    fn redact_home_never_acts_on_empty_or_root_homes() {
        assert_eq!(redact_home("/etc/passwd /x", &homes(&["", "/", "//"])), "/etc/passwd /x");
        assert_eq!(redact_home("anything", &[]), "anything");
        assert_eq!(redact_home("", &homes(&["/Users/ann"])), "");
    }

    #[cfg(unix)]
    #[test]
    fn progress_events_never_carry_the_home_folder_but_diagnostics_keep_it() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().canonicalize().unwrap();
        let home_text = home.to_string_lossy().to_string();
        let targets: Vec<ImportTarget> = staged_targets(&home)
            .into_iter()
            .filter(|t| t.adapter.id == "claude-code")
            .collect();
        let _locked = Locked::new(home.join(".claude/locked"));
        let archive = Arc::new(Archive::in_memory().unwrap());
        let importer = Importer::new(archive.clone());

        let (result, events) = collect_reporting(&importer, &targets, None, &scoped_env(&home));
        result.expect("a read error is not a failed run");

        let errors: Vec<&str> = events.iter().filter_map(|e| e.error.as_deref()).collect();
        assert!(!errors.is_empty(), "the read error is reported: {events:?}");
        for e in &errors {
            assert!(!e.contains(&home_text), "the home folder leaked into an event: {e}");
        }
        assert!(
            errors.iter().any(|e| e.contains("~/") && e.contains("Permission denied")),
            "the home prefix is shown as ~ and the cause is kept: {errors:?}"
        );

        let stored = archive.recent_diagnostics(100).unwrap();
        let read_error = stored.iter().find(|d| d.code == "read_error").expect("stored diagnostic");
        assert!(
            read_error.message.contains(&home_text),
            "the archive keeps the full text: {}",
            read_error.message
        );
    }
}

/// PRIV-1 / V-REG-9 (r2 fix round 1): a watcher thread that is waiting out its debounce when
/// consent is withdrawn (or the archive is deleted) must not run one more import afterwards.
/// Timing based: a writer appends to a session every 40 ms, so the watcher stays in its debounce
/// loop until the stop.
#[cfg(test)]
mod watcher_stop_race {
    use super::testutil::*;
    use super::*;

    fn first_claude_session(home: &Path) -> PathBuf {
        fn find(dir: &Path) -> Option<PathBuf> {
            for e in std::fs::read_dir(dir).ok()? {
                let p = e.ok()?.path();
                if p.is_dir() {
                    if let Some(f) = find(&p) {
                        return Some(f);
                    }
                } else if p.extension().map(|x| x == "jsonl").unwrap_or(false) {
                    return Some(p);
                }
            }
            None
        }
        find(&home.join(".claude/projects")).unwrap()
    }

    fn keep_writing(session: PathBuf) -> (Arc<std::sync::atomic::AtomicBool>, std::thread::JoinHandle<()>) {
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = stop.clone();
        let handle = std::thread::spawn(move || {
            while !flag.load(std::sync::atomic::Ordering::SeqCst) {
                append_record(&session, &appended_user_record("still writing"));
                std::thread::sleep(Duration::from_millis(40));
            }
        });
        (stop, handle)
    }

    #[test]
    fn a_watcher_in_its_debounce_window_does_not_import_after_stop() {
        let home = crate::archive_api::testkit::tmp();
        let targets = staged_targets(home.path());
        let archive = Arc::new(Archive::in_memory().unwrap());
        let session = first_claude_session(home.path());
        let (tx, _rx) = crossbeam_channel::unbounded();
        let watcher = spawn_watcher(archive.clone(), targets, tx).unwrap();
        std::thread::sleep(Duration::from_millis(500)); // let FSEvents settle
        let (stop_writer, writer) = keep_writing(session);
        std::thread::sleep(Duration::from_millis(800)); // the watcher is now inside its debounce loop
        assert_eq!(archive.stats().unwrap().sessions, 0, "control: nothing imported while events keep coming");
        // Consent withdrawn: what launch::stop_background_services does.
        {
            // Wait for other tests' importers to finish, so only this test's watcher is cancelled.
            let _only_us = CANCEL_TEST_LOCK.write().unwrap_or_else(|e| e.into_inner());
            cancel_running_imports();
            drop(watcher);
        }
        stop_writer.store(true, std::sync::atomic::Ordering::SeqCst);
        writer.join().unwrap();
        std::thread::sleep(Duration::from_millis(2500));
        assert_eq!(archive.stats().unwrap().sessions, 0, "an import still ran after consent was withdrawn");
    }

    #[test]
    fn delete_archive_is_not_refilled_by_a_watcher_in_its_debounce_window() {
        let home = crate::archive_api::testkit::tmp();
        let data = crate::archive_api::testkit::tmp();
        let targets = staged_targets(home.path());
        let archive = Arc::new(Archive::open(&data.path().join("armillary-archive.sqlite3")).unwrap());
        let session = first_claude_session(home.path());
        Importer::new(archive.clone()).run_reporting_inferred(&targets, None, &|_| {}).unwrap();
        assert!(archive.stats().unwrap().sessions > 0, "control: the archive has data");
        let (tx, _rx) = crossbeam_channel::unbounded();
        let watcher = spawn_watcher(archive.clone(), targets, tx).unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let (stop_writer, writer) = keep_writing(session);
        std::thread::sleep(Duration::from_millis(800));
        // Delete archive and reset: stop the services, then delete.
        {
            // Wait for other tests' importers to finish, so only this test's watcher is cancelled.
            let _only_us = CANCEL_TEST_LOCK.write().unwrap_or_else(|e| e.into_inner());
            cancel_running_imports();
            drop(watcher);
        }
        crate::archive_api::delete_data_in(data.path(), data.path(), &archive).unwrap();
        stop_writer.store(true, std::sync::atomic::Ordering::SeqCst);
        writer.join().unwrap();
        std::thread::sleep(Duration::from_millis(2500));
        assert_eq!(archive.stats().unwrap().sessions, 0, "the deleted archive was filled again");
    }
}

/// R-1 / R2P-2 (r2 fix round 2): a stop (Not now, Delete archive) ends reading too. A run whose
/// epoch has been cancelled reads no further agent or source, writes nothing, ends the whole run
/// (not just the agent it is on) and still closes the run for the Field Guide.
#[cfg(test)]
mod cancel_stops_reading {
    use super::testutil::*;
    use super::*;

    /// An importer whose epoch is already cancelled, as if the stop came right after it was built.
    fn stopped_importer(archive: Arc<Archive>) -> Importer {
        let epoch = {
            // Wait for other tests' importers to finish, so only this test's importer is cancelled.
            let _only_us = CANCEL_TEST_LOCK.write().unwrap_or_else(|e| e.into_inner());
            let epoch = current_epoch();
            cancel_running_imports();
            epoch
        };
        Importer::with_epoch(archive, epoch)
    }

    /// One test, one stop: each stop bumps the process-wide epoch, and a watcher test that is in
    /// its debounce wait at that moment would lose its re-import, so the checks share one stop.
    #[test]
    fn a_stopped_importer_reads_nothing_and_ends_the_whole_run() {
        let home = crate::archive_api::testkit::tmp();
        let targets = staged_targets(home.path());
        assert!(targets.len() >= 2, "control: two agents staged");
        let root = home.path().canonicalize().unwrap();
        std::fs::write(root.join("a.jsonl"), "{}\n").unwrap();
        let boundary = orrery_adapters::boundary::ReadBoundary::new(&[root.clone()]).unwrap();
        let archive = Arc::new(Archive::in_memory().unwrap());
        {
            let live = Importer::new(archive.clone());
            assert!(live.reading(|| boundary.read(&root.join("a.jsonl"))).is_ok(), "control");
        }
        let stopped = stopped_importer(archive.clone());

        // The read stop the run installs is this importer's own: cancelled, a read is refused.
        assert!(stopped.reading(|| boundary.read(&root.join("a.jsonl"))).is_err());

        // run_reporting: no agent read, the whole run ends, the run is still closed.
        let events = std::sync::Mutex::new(Vec::<ImportPayload>::new());
        let result = stopped.run_reporting_inferred(&targets, None, &|p| events.lock().unwrap().push(p));
        let events = events.into_inner().unwrap();
        assert!(result.is_err(), "a stopped run is not reported as a finished import");
        assert!(
            events.iter().all(|e| e.sessions_known == 0 && e.sessions_imported == 0),
            "sources were read after the stop: {events:?}"
        );
        let agents_started = events.iter().filter(|e| e.phase == "started" && !e.agent_id.is_empty()).count();
        assert!(agents_started <= 1, "the run went on to another agent: {events:?}");
        assert!(
            events.last().is_some_and(|e| e.agent_id.is_empty() && e.phase == "finished"),
            "the run-level finished event still closes the run: {events:?}"
        );

        // run_observed (the first-run scan's path): no source listed.
        let seen = std::sync::Mutex::new(Vec::<BatchProgress>::new());
        let env = orrery_adapters::env::MockEnvironment::new(
            orrery_adapters::env::TargetOs::Macos,
            home.path().to_str().unwrap(),
        );
        let observed = stopped.run_observed(&targets, None, &env, &|_| {}, &|b| seen.lock().unwrap().push(b));
        assert!(observed.is_err());
        let seen = seen.into_inner().unwrap();
        assert!(seen.iter().all(|b| b.sessions_known == 0), "a source was listed after the stop: {seen:?}");

        assert_eq!(archive.stats().unwrap().sessions, 0);
        assert!(archive.recent_diagnostics(100).unwrap().is_empty(), "nothing is written after a stop");
    }
}

/// r2 fix round 2: skip notices. R-6: a Kimi session whose state.json is over the limit is
/// reported as skipped (it was lost as "invalid checkpoint"), and an empty Kimi folder imports
/// cleanly. R-2: a file over the record cap says so, not "over 64 MiB". R-3 / RR1-1: a skip is kept
/// once per file, goes away when the file imports again or is removed, and never falls out of the
/// Field Guide's list behind newer diagnostics.
#[cfg(test)]
mod skip_notices {
    use super::testutil::*;
    use super::*;

    fn run(archive: &Arc<Archive>, targets: &[ImportTarget]) -> (Vec<String>, Vec<String>) {
        let errors = std::sync::Mutex::new(Vec::new());
        let phases = std::sync::Mutex::new(Vec::new());
        Importer::new(archive.clone())
            .run_reporting_inferred(targets, None, &|p: ImportPayload| {
                phases.lock().unwrap().push(format!("{}:{}", p.agent_id, p.phase));
                if let Some(e) = p.error {
                    errors.lock().unwrap().push(e);
                }
            })
            .unwrap();
        (errors.into_inner().unwrap(), phases.into_inner().unwrap())
    }

    fn adapter(id: &str) -> AdapterDef {
        builtin_adapters().into_iter().find(|a| a.id == id).unwrap()
    }

    fn limit_rows(archive: &Archive) -> Vec<ImportDiagnostic> {
        archive.recent_diagnostics(500).unwrap().into_iter().filter(|d| d.code == "limit").collect()
    }

    fn files_under(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                out.extend(files_under(&p));
            } else {
                out.push(p);
            }
        }
        out.sort();
        out
    }

    fn sparse(path: &Path) {
        std::fs::File::create(path).unwrap().set_len(orrery_adapters::boundary::MAX_SOURCE_BYTES + 1024).unwrap();
    }

    #[test]
    fn kimi_state_over_the_limit_in_a_real_session_folder_is_reported_as_skipped() {
        let home = crate::archive_api::testkit::tmp();
        let data_dirs = stage_history_adapter_to_home(home.path(), "kimi-code-cli");
        let state = files_under(&data_dirs[0]).into_iter().find(|p| p.ends_with("state.json")).unwrap();
        assert!(state.parent().unwrap().join("agents/main/wire.jsonl").is_file(), "control: real two file layout");
        sparse(&state);
        let archive = Arc::new(Archive::in_memory().unwrap());
        let (errors, phases) = run(&archive, &[ImportTarget { adapter: adapter("kimi-code-cli"), data_dirs }]);
        assert!(
            errors.iter().any(|e| e.starts_with("Skipped, too large (over 64 MiB): ") && e.ends_with("state.json")),
            "{errors:?}"
        );
        assert!(phases.contains(&"kimi-code-cli:finished".to_string()), "{phases:?}");
        let stored = archive.recent_diagnostics(100).unwrap();
        assert!(stored.iter().all(|d| d.code != "rejected"), "{stored:?}");
        assert_eq!(limit_rows(&archive).len(), 1, "{stored:?}");
    }

    #[test]
    fn an_empty_kimi_folder_imports_without_an_error() {
        let home = crate::archive_api::testkit::tmp();
        let dir = home.path().join(".kimi-code/sessions");
        std::fs::create_dir_all(&dir).unwrap();
        let archive = Arc::new(Archive::in_memory().unwrap());
        let (errors, phases) = run(&archive, &[ImportTarget { adapter: adapter("kimi-code-cli"), data_dirs: vec![dir] }]);
        assert!(errors.is_empty(), "{errors:?}");
        assert!(phases.contains(&"kimi-code-cli:finished".to_string()), "{phases:?}");
    }

    #[test]
    fn a_file_over_the_record_cap_says_records_not_mib() {
        let home = crate::archive_api::testkit::tmp();
        let targets: Vec<ImportTarget> =
            staged_targets(home.path()).into_iter().filter(|t| t.adapter.id == "claude-code").collect();
        let dir = home.path().join(".claude/projects/my-web-app");
        let mut many = String::with_capacity(2_200_000);
        for _ in 0..(orrery_adapters::boundary::MAX_SOURCE_RECORDS + 10) {
            many.push_str("{}\n");
        }
        std::fs::write(dir.join("many.jsonl"), many).unwrap();
        let archive = Arc::new(Archive::in_memory().unwrap());
        let (errors, _) = run(&archive, &targets);
        assert!(
            errors.iter().any(|e| e.starts_with("Skipped, too large (over 250,000 records): ") && e.ends_with("many.jsonl")),
            "{errors:?}"
        );
        assert!(errors.iter().all(|e| !(e.contains("64 MiB") && e.contains("many.jsonl"))), "{errors:?}");
    }

    #[test]
    fn a_skip_is_kept_once_and_goes_away_when_the_file_is_fixed_or_removed() {
        let home = crate::archive_api::testkit::tmp();
        let data_dirs = stage_history_adapter_to_home(home.path(), "continue");
        let targets = vec![ImportTarget { adapter: adapter("continue"), data_dirs: data_dirs.clone() }];
        let big = data_dirs[0].join("big-session.json");
        sparse(&big);
        let archive = Arc::new(Archive::in_memory().unwrap());
        for _ in 0..4 {
            run(&archive, &targets);
        }
        assert_eq!(limit_rows(&archive).len(), 1, "one notice per file, however many runs");
        let total = archive.recent_diagnostics(500).unwrap().len();
        run(&archive, &targets);
        assert_eq!(archive.recent_diagnostics(500).unwrap().len(), total, "the table does not grow per run");

        // Removed: the next full run drops its notice.
        std::fs::remove_file(&big).unwrap();
        run(&archive, &targets);
        assert!(limit_rows(&archive).is_empty(), "a removed file keeps its notice");

        // Back, then shrunk below the limit: the notice comes and goes with it.
        sparse(&big);
        run(&archive, &targets);
        assert_eq!(limit_rows(&archive).len(), 1);
        let small = files_under(&data_dirs[0])
            .into_iter()
            .find(|p| *p != big && p.extension().is_some_and(|x| x == "json"))
            .unwrap();
        std::fs::copy(small, &big).unwrap();
        run(&archive, &targets);
        assert!(limit_rows(&archive).is_empty(), "a fixed file keeps its notice");
    }

    #[test]
    fn the_field_guide_list_keeps_skips_behind_many_newer_diagnostics() {
        let archive = Arc::new(Archive::in_memory().unwrap());
        let home = crate::archive_api::testkit::tmp();
        let data_dirs = stage_history_adapter_to_home(home.path(), "continue");
        sparse(&data_dirs[0].join("big-session.json"));
        run(&archive, &[ImportTarget { adapter: adapter("continue"), data_dirs }]);
        // 150 newer diagnostics of other kinds for other sources.
        for i in 0..150 {
            let key = format!("{:064x}", i + 1);
            archive
                .import_batch(&ImportBatch {
                    source: armillary_model::SourceProvenance {
                        store: orrery_adapters::StoreIdentity::new("x", "/tmp/x", "profile"),
                        source_id: "s".into(),
                        adapter_id: "x".into(),
                        adapter_version: "1".into(),
                        source_path: format!("f{i}"),
                        file_identity: "i".into(),
                        generation: 1,
                        checkpoint: armillary_model::Checkpoint { revision: 1, offset: 0, records: 0, digest: "0".repeat(64) },
                    },
                    mode: armillary_model::ImportMode::Snapshot,
                    read_status: ReadStatus::Failed,
                    sessions: vec![],
                    diagnostics: vec![],
                    live_updates: vec![],
                })
                .unwrap();
            let _ = key;
        }
        let listed = crate::archive_api::import_diagnostics_core(&archive, None).unwrap();
        assert!(listed.iter().any(|d| d.code == "limit"), "the skip fell out of the list");
    }
}

/// R-5 (r2 fix round 2): Claude Code names a project's history folder after the project path, so a
/// project called keychain-app was lost as "Credential file access blocked". It now imports.
#[cfg(test)]
mod project_named_like_a_key_file {
    use super::testutil::*;
    use super::*;

    #[test]
    fn a_claude_project_named_keychain_app_imports() {
        let home = crate::archive_api::testkit::tmp();
        let targets: Vec<ImportTarget> =
            staged_targets(home.path()).into_iter().filter(|t| t.adapter.id == "claude-code").collect();
        let projects = home.path().join(".claude/projects");
        std::fs::rename(projects.join("my-web-app"), projects.join("-Users-dev-code-keychain-app")).unwrap();
        let archive = Arc::new(Archive::in_memory().unwrap());
        let errors = std::sync::Mutex::new(Vec::new());
        Importer::new(archive.clone())
            .run_reporting_inferred(&targets, None, &|p: ImportPayload| {
                if let Some(e) = p.error {
                    errors.lock().unwrap().push(e);
                }
            })
            .unwrap();
        assert!(errors.into_inner().unwrap().is_empty());
        assert!(archive.stats().unwrap().sessions > 0, "the project's history was not imported");
        assert!(archive.recent_diagnostics(100).unwrap().iter().all(|d| d.code != "credential_blocked"));
    }
}
