//! The Tauri command surface over the archive:
//! `import_now`, `sessions_query`, `session_get`, `search`, plus the
//! `import:progress` event. Every command validates input and returns typed
//! errors (`ApiError` with a machine-readable code).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use armillary_model::{ContentBlock, ImportDiagnostic, Message, Session};
use orrery_archive::{Archive, HitKind, Page, SearchFilter, SessionFilter, HIT_END, HIT_START};
use serde::{Deserialize, Serialize};

use crate::importer::{ImportPayload, ImportSummary, ImportTarget, Importer};

// Home-scoped detection lives in scope.rs. It is declared here, not in main.rs, because this file
// is also compiled on its own into integration tests through #[path], where `crate::scope` would
// not exist. The app reaches it as `crate::archive_api::scope`.
#[path = "scope.rs"]
pub mod scope;

/// The first-run consent file, `<data_dir>/firstrun.json`. Declared here (not in firstrun.rs) so every
/// command that reads agent folders can check it, including when this file is compiled on its own
/// into an integration test. firstrun.rs writes the file; this module is the one reader.
pub mod consent {
    use super::ApiError;
    use serde::{Deserialize, Serialize};
    use std::path::Path;

    pub const CONSENT_FILE: &str = "firstrun.json";

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct ConsentFile {
        pub version: u32,
        pub consented_at: Option<i64>,
        pub completed_at: Option<i64>,
        pub declined_at: Option<i64>,
    }

    impl Default for ConsentFile {
        fn default() -> Self {
            Self { version: 1, consented_at: None, completed_at: None, declined_at: None }
        }
    }

    /// A missing or corrupt file is the default state (no consent). Never panics.
    pub fn read(data_dir: &Path) -> ConsentFile {
        std::fs::read(data_dir.join(CONSENT_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ConsentFile>(&bytes).ok())
            .unwrap_or_default()
    }

    /// True only when `consentedAt` is a number.
    pub fn recorded(data_dir: &Path) -> bool {
        read(data_dir).consented_at.is_some()
    }

    /// Background services may start at launch only when the user consented AND finished the first
    /// run. Consent without completion (the app quit during the first run) means "ask again".
    pub fn services_allowed_at_launch(data_dir: &Path) -> bool {
        let state = read(data_dir);
        state.consented_at.is_some() && state.completed_at.is_some()
    }

    pub fn required_error() -> ApiError {
        ApiError {
            code: "consent_required".into(),
            message: "Armillary has not been given access to your agent folders".into(),
        }
    }

    /// Err with code "consent_required" unless consent is recorded in `data_dir`. Every command that
    /// reads agent folders or the process table calls this before touching anything.
    pub fn require(data_dir: &Path) -> Result<(), ApiError> {
        if recorded(data_dir) {
            Ok(())
        } else {
            Err(required_error())
        }
    }
}

/// Test helpers shared by the consent tests of every module (compiled only for tests).
#[cfg(test)]
#[allow(dead_code)]
pub mod testkit {
    use orrery_adapters::env::{FileSystem, SystemFileSystem};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A fresh folder under /tmp (never the real home folder).
    pub fn tmp() -> tempfile::TempDir {
        tempfile::Builder::new().prefix("armillary-r2fix-").tempdir_in("/tmp").unwrap()
    }

    pub fn write_declined(data_dir: &Path) {
        std::fs::write(
            data_dir.join("firstrun.json"),
            r#"{"version":1,"consentedAt":null,"completedAt":1700000000000,"declinedAt":1700000000000}"#,
        )
        .unwrap();
    }

    pub fn write_consented(data_dir: &Path) {
        std::fs::write(
            data_dir.join("firstrun.json"),
            r#"{"version":1,"consentedAt":1700000000000,"completedAt":1700000000001,"declinedAt":null}"#,
        )
        .unwrap();
    }

    /// The real filesystem limited to one fake home folder, counting every call.
    pub struct CountingFs {
        pub home: PathBuf,
        calls: AtomicUsize,
    }

    impl CountingFs {
        pub fn new(home: &Path) -> Self {
            Self { home: home.to_path_buf(), calls: AtomicUsize::new(0) }
        }
        pub fn count(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
        fn hit(&self, p: &Path) -> bool {
            self.calls.fetch_add(1, Ordering::SeqCst);
            p.starts_with(&self.home)
        }
    }

    impl FileSystem for CountingFs {
        fn exists(&self, p: &Path) -> bool {
            self.hit(p) && SystemFileSystem.exists(p)
        }
        fn is_file(&self, p: &Path) -> bool {
            self.hit(p) && SystemFileSystem.is_file(p)
        }
        fn is_dir(&self, p: &Path) -> bool {
            self.hit(p) && SystemFileSystem.is_dir(p)
        }
        fn read_dir(&self, p: &Path) -> Result<Vec<PathBuf>, std::io::Error> {
            if self.hit(p) {
                SystemFileSystem.read_dir(p)
            } else {
                Err(std::io::ErrorKind::NotFound.into())
            }
        }
        fn which(&self, _b: &str) -> Option<PathBuf> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            None
        }
        fn version_of(&self, _p: &Path, _a: &[String]) -> Option<String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            None
        }
    }
}

/// Machine-readable error every command can return.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    /// "invalid_input" | "not_found" | "import_failed" | "archive_failed"
    pub code: String,
    pub message: String,
}

impl ApiError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self { code: "invalid_input".into(), message: message.into() }
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self { code: "not_found".into(), message: message.into() }
    }
    pub fn import_failed(message: impl Into<String>) -> Self {
        Self { code: "import_failed".into(), message: message.into() }
    }
    pub fn archive_failed(message: impl Into<String>) -> Self {
        Self { code: "archive_failed".into(), message: message.into() }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

/// Shared state: one archive plus the adapters and folders to import from.
pub struct CoreState {
    pub archive: Arc<Archive>,
    pub targets: Mutex<Vec<ImportTarget>>,
}

impl CoreState {
    pub fn new(archive: Arc<Archive>, targets: Vec<ImportTarget>) -> Self {
        Self { archive, targets: Mutex::new(targets) }
    }

    pub fn targets_snapshot(&self) -> Vec<ImportTarget> {
        self.targets.lock().unwrap().clone()
    }

    pub fn set_targets(&self, targets: Vec<ImportTarget>) {
        *self.targets.lock().unwrap() = targets;
    }
}

/// The archive database inside the app data folder (its -wal and -shm files sit next to it).
pub const ARCHIVE_FILE: &str = "armillary-archive.sqlite3";

/// Temporary snapshot folders the importers make in the system temp folder. They are normally
/// removed as soon as a read ends; a crash can leave one behind.
const SNAPSHOT_PREFIXES: &[&str] = &["armillary-sqlite-", "armillary-module-sqlite-", "orrery-sqlite-snapshot"];

fn remove_if_present(path: &Path) -> Result<(), ApiError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(ApiError::archive_failed(format!("could not remove {}: {e}", path.display()))),
    }
}

/// Delete archive and reset (R2-REV-3). The caller stops the services first. This closes the
/// archive and deletes its database with the -wal, -shm and -journal files (a new empty archive is
/// opened in their place so the running app keeps working), deletes firstrun.json (so consent is
/// asked again) and removes leftover snapshot folders from `temp_dir`. Nothing else is touched.
pub fn delete_data_in(data_dir: &Path, temp_dir: &Path, archive: &Archive) -> Result<(), ApiError> {
    archive
        .reset_to_empty(&data_dir.join(ARCHIVE_FILE))
        .map_err(|e| ApiError::archive_failed(e.to_string()))?;
    // The sessions are gone from here on: a later failure is a partial delete (V-REG-10), and the
    // message says so instead of "not deleted".
    delete_the_rest(data_dir, temp_dir).map_err(|e| ApiError {
        code: "partly_deleted".into(),
        message: format!(
            "the archive was emptied, but not everything was removed ({}). The background watcher and live detector stay stopped until Armillary is opened again.",
            e.message
        ),
    })
}

/// Everything Delete archive and reset removes after the archive itself.
fn delete_the_rest(data_dir: &Path, temp_dir: &Path) -> Result<(), ApiError> {
    remove_if_present(&data_dir.join(consent::CONSENT_FILE))?;
    remove_if_present(&data_dir.join("firstrun.json.tmp"))?;
    // PRIV-2: copies kept by "Move it aside" (<archive>.bak-<time>, with -wal and -shm) are full
    // archives too.
    if let Ok(entries) = std::fs::read_dir(data_dir) {
        let aside = format!("{ARCHIVE_FILE}.bak-");
        for entry in entries.flatten() {
            let is_file = entry.file_type().map(|t| !t.is_dir()).unwrap_or(false);
            if is_file && entry.file_name().to_string_lossy().starts_with(&aside) {
                remove_if_present(&entry.path())?;
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(temp_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !SNAPSHOT_PREFIXES.iter().any(|p| name.starts_with(p)) {
                continue;
            }
            let path = entry.path();
            // file_type does not follow links: a link is removed as a link, never its target.
            let result = match entry.file_type() {
                Ok(t) if t.is_dir() => std::fs::remove_dir_all(&path),
                Ok(_) => std::fs::remove_file(&path),
                Err(e) => Err(e),
            };
            if let Err(e) = result {
                if e.kind() != std::io::ErrorKind::NotFound {
                    return Err(ApiError::archive_failed(format!("could not remove {}: {e}", path.display())));
                }
            }
        }
    }
    Ok(())
}

/// Open the archive, or, when it is damaged or from a newer version, fall back to an empty
/// in-memory archive and return a plain reason (R2-REV-7). The file is never changed here: the
/// user decides to move it aside (`move_archive_aside_in`).
pub fn open_or_recover_in(data_dir: &Path) -> (Arc<Archive>, Option<String>) {
    match open_archive_in(data_dir) {
        Ok(archive) => (archive, None),
        Err(err) => {
            let fallback = Archive::in_memory().expect("an in-memory archive always opens");
            (Arc::new(fallback), Some(open_problem_text(&err.message)))
        }
    }
}

/// The plain reason shown when the archive does not open (R2-REV-7, V-REG-10). Only SQLite's own
/// "not a database" and "malformed" errors, or a schema it cannot read, mean the file is damaged;
/// anything else (a lock, permissions, a full disk, a folder in its place) is named as it is.
fn open_problem_text(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("newer than this build") {
        "The archive was made by a newer version of Armillary, so this version cannot open it.".into()
    } else if lower.contains("not a database") || lower.contains("malformed") || lower.contains("schema") {
        "The archive file is damaged or is not an Armillary archive, so it could not be opened.".into()
    } else {
        let reason = error.strip_prefix("failed to open archive: ").unwrap_or(error);
        format!("The archive file could not be opened ({reason}). It may be in use or not readable; it was not changed.")
    }
}

/// Rename the archive (with its -wal and -shm) to `<name>.bak-<unix ms>` and start a new empty
/// archive at the old path in `archive`. Returns the kept copy's path. Nothing is deleted.
pub fn move_archive_aside_in(data_dir: &Path, archive: &Archive) -> Result<PathBuf, ApiError> {
    let path = data_dir.join(ARCHIVE_FILE);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let kept = data_dir.join(format!("{ARCHIVE_FILE}.bak-{stamp}"));
    std::fs::rename(&path, &kept)
        .map_err(|e| ApiError::archive_failed(format!("could not move the archive aside: {e}")))?;
    for suffix in ["-wal", "-shm"] {
        let from = data_dir.join(format!("{ARCHIVE_FILE}{suffix}"));
        if from.exists() {
            let to = data_dir.join(format!("{ARCHIVE_FILE}.bak-{stamp}{suffix}"));
            std::fs::rename(&from, &to)
                .map_err(|e| ApiError::archive_failed(format!("could not move {suffix} aside: {e}")))?;
        }
    }
    // The handle in use is the in-memory fallback; reset_to_empty opens a new file at the path.
    archive
        .reset_to_empty(&path)
        .map_err(|e| ApiError::archive_failed(e.to_string()))?;
    Ok(kept)
}

/// Whether the archive opened at launch, and if not, why (shown by the UI with a way out).
#[derive(Debug, Default)]
pub struct ArchiveHealth {
    pub problem: Mutex<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArchiveStatus {
    pub ok: bool,
    pub message: Option<String>,
}

#[tauri::command]
pub fn archive_status(health: tauri::State<'_, ArchiveHealth>) -> ArchiveStatus {
    let problem = health.problem.lock().unwrap_or_else(|e| e.into_inner()).clone();
    ArchiveStatus { ok: problem.is_none(), message: problem }
}

/// "Move it aside and start fresh": keeps the old file as a .bak copy, opens an empty archive.
#[tauri::command]
pub fn archive_move_aside(
    app: tauri::AppHandle,
    state: tauri::State<'_, CoreState>,
    health: tauri::State<'_, ArchiveHealth>,
) -> Result<ArchiveStatus, ApiError> {
    let data_dir = app_data_dir_of(&app)?;
    let result = move_aside_core(&data_dir, &state.archive, &health);
    match &result {
        Ok(_) => trace("cmd archive_move_aside ok"),
        Err(e) => trace(&format!("cmd archive_move_aside err {}", e.code)),
    }
    result
}

/// The testable part of `archive_move_aside`.
pub fn move_aside_core(data_dir: &Path, archive: &Archive, health: &ArchiveHealth) -> Result<ArchiveStatus, ApiError> {
    // Only an archive that failed to open is moved aside: a healthy one is the user's history.
    if health.problem.lock().unwrap_or_else(|e| e.into_inner()).is_none() {
        return Err(ApiError::invalid("the archive opened normally, so there is nothing to move aside"));
    }
    move_archive_aside_in(data_dir, archive)?;
    *health.problem.lock().unwrap_or_else(|e| e.into_inner()) = None;
    Ok(ArchiveStatus { ok: true, message: None })
}

/// Open (creating if needed) the archive SQLite file inside the app data folder.
pub fn open_archive_in(data_dir: &Path) -> Result<Arc<Archive>, ApiError> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| ApiError::archive_failed(format!("failed to create data dir: {e}")))?;
    let sqlite_path = data_dir.join(ARCHIVE_FILE);
    let archive = Archive::open(&sqlite_path)
        .map_err(|e| ApiError::archive_failed(format!("failed to open archive: {e}")))?;
    Ok(Arc::new(archive))
}

// ---------- input DTOs ----------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionQuery {
    pub agent: Option<String>,
    pub project: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub status: Option<String>,
    pub model: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchInput {
    pub query: String,
    pub agent: Option<String>,
    pub project: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

// ---------- command cores (testable without a Tauri runtime) ----------

pub fn import_now_core(
    state: &CoreState,
    agent_id: Option<&str>,
    emit: &dyn Fn(ImportPayload),
) -> Result<ImportSummary, ApiError> {
    import_now_core_with_importer(state, Importer::new(state.archive.clone()), agent_id, emit)
}

pub fn import_now_core_with_epoch(
    state: &CoreState,
    epoch: u64,
    agent_id: Option<&str>,
    emit: &dyn Fn(ImportPayload),
) -> Result<ImportSummary, ApiError> {
    import_now_core_with_importer(state, Importer::with_epoch(state.archive.clone(), epoch), agent_id, emit)
}

fn import_now_core_with_importer(
    state: &CoreState,
    importer: Importer,
    agent_id: Option<&str>,
    emit: &dyn Fn(ImportPayload),
) -> Result<ImportSummary, ApiError> {
    if importer.is_cancelled() {
        return Err(import_now_error(crate::importer::IMPORT_CANCELLED.to_string()));
    }
    let targets = state.targets_snapshot();
    if let Some(id) = agent_id {
        if id.trim().is_empty() {
            return Err(ApiError::invalid("agent id cannot be empty"));
        }
        let known = targets.iter().any(|t| t.adapter.id == id);
        if !known {
            return Err(ApiError::invalid(format!("unknown agent id: {id}")));
        }
    }
    importer.run_reporting_inferred(&targets, agent_id, emit).map_err(import_now_error)
}

/// The error Import now answers with; a run ended by a stop (Not now, Delete archive) says so.
fn import_now_error(e: String) -> ApiError {
    if e == crate::importer::IMPORT_CANCELLED {
        ApiError::import_failed("Import stopped")
    } else {
        ApiError::import_failed(e)
    }
}

/// Where a session's `display_title` came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TitleSource {
    Native,
    FirstPrompt,
}

/// A contract Session plus the derived fields the views show. The JSON is a superset of the
/// contract Session (the session's own fields stay at the top level, `title` unchanged).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SessionRow {
    #[serde(flatten)]
    pub session: Session,
    pub display_title: Option<String>,
    pub title_source: Option<TitleSource>,
    pub first_activity_at: Option<i64>,
    pub last_activity_at: Option<i64>,
}

impl std::ops::Deref for SessionRow {
    type Target = Session;
    fn deref(&self) -> &Session {
        &self.session
    }
}

/// Longest `display_title`, in characters, including a trailing "...".
pub const DISPLAY_TITLE_MAX: usize = 70;

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A title from a first prompt: its first sentence or first line, whichever is shorter, with
/// whitespace collapsed and at most `DISPLAY_TITLE_MAX` characters (cut at a word boundary with a
/// plain "..."). `None` when the text is blank.
pub fn derive_display_title(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let line = collapse_ws(trimmed.lines().next().unwrap_or(""));
    let whole = collapse_ws(trimmed);
    let chars: Vec<char> = whole.chars().collect();
    let sentence_end = chars
        .iter()
        .enumerate()
        .find(|(i, c)| matches!(c, '.' | '!' | '?') && chars.get(i + 1).is_none_or(|n| n.is_whitespace()))
        .map(|(i, _)| i + 1)
        .unwrap_or(chars.len());
    let sentence: String = chars[..sentence_end].iter().collect();
    let chosen = if line.chars().count() <= sentence.chars().count() { line } else { sentence };
    let chosen: Vec<char> = chosen.chars().collect();
    if chosen.len() <= DISPLAY_TITLE_MAX {
        return Some(chosen.into_iter().collect());
    }
    let budget = DISPLAY_TITLE_MAX - 3;
    let cut = if chosen[budget].is_whitespace() {
        budget
    } else {
        chosen[..budget].iter().rposition(|c| c.is_whitespace()).unwrap_or(budget)
    };
    let head: String = chosen[..cut].iter().collect();
    Some(format!("{}...", head.trim_end()))
}

fn enrich(archive: &Archive, sessions: Vec<Session>) -> Result<Vec<SessionRow>, ApiError> {
    let failed = |e: orrery_archive::ArchiveError| ApiError::archive_failed(e.to_string());
    let has_native = |s: &Session| s.title.as_deref().is_some_and(|t| !t.trim().is_empty());
    let all_ids: Vec<&str> = sessions.iter().map(|s| s.id.as_str()).collect();
    let need_prompt: Vec<&str> = sessions.iter().filter(|s| !has_native(s)).map(|s| s.id.as_str()).collect();
    let activity = archive.session_activity(&all_ids).map_err(failed)?;
    let prompts = archive.first_user_texts(&need_prompt).map_err(failed)?;
    Ok(sessions
        .into_iter()
        .map(|session| {
            let (display_title, title_source) = if has_native(&session) {
                (session.title.clone(), Some(TitleSource::Native))
            } else {
                match prompts.get(&session.id).and_then(|t| derive_display_title(t)) {
                    Some(title) => (Some(title), Some(TitleSource::FirstPrompt)),
                    None => (None, None),
                }
            };
            let span = activity.get(&session.id).copied().unwrap_or_default();
            SessionRow {
                session,
                display_title,
                title_source,
                first_activity_at: span.first_at,
                last_activity_at: span.last_at,
            }
        })
        .collect())
}

pub fn sessions_query_core(archive: &Archive, query: &SessionQuery) -> Result<Page<SessionRow>, ApiError> {
    if let (Some(from), Some(to)) = (query.from, query.to) {
        if from > to {
            return Err(ApiError::invalid("from timestamp cannot be greater than to timestamp"));
        }
    }
    if let Some(limit) = query.limit {
        if limit == 0 || limit > 200 {
            return Err(ApiError::invalid("limit must be between 1 and 200"));
        }
    }
    let filter = SessionFilter {
        agent: query.agent.clone(),
        project: query.project.clone(),
        from: query.from,
        to: query.to,
        status: query.status.clone(),
        model: query.model.clone(),
        limit: query.limit,
        offset: query.offset,
    };
    let page = archive.sessions_query(&filter).map_err(|e| ApiError::archive_failed(e.to_string()))?;
    Ok(Page { items: enrich(archive, page.items)?, total: page.total, limit: page.limit, offset: page.offset })
}

pub fn session_get_core(archive: &Archive, id: &str) -> Result<SessionRow, ApiError> {
    validate_hex_id(id)?;
    let session = archive
        .get_session(id)
        .map_err(|e| ApiError::archive_failed(e.to_string()))?
        .ok_or_else(|| ApiError::not_found(format!("session not found: {id}")))?;
    Ok(enrich(archive, vec![session])?.remove(0))
}

fn validate_hex_id(id: &str) -> Result<(), ApiError> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::invalid("session id must be hexadecimal"));
    }
    Ok(())
}

pub fn messages_page_core(
    archive: &Archive,
    id: &str,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Page<Message>, ApiError> {
    validate_hex_id(id)?;
    let limit = limit.unwrap_or(100);
    if limit == 0 || limit > 200 {
        return Err(ApiError::invalid("limit must be between 1 and 200"));
    }
    archive
        .get_session(id)
        .map_err(|e| ApiError::archive_failed(e.to_string()))?
        .ok_or_else(|| ApiError::not_found(format!("session not found: {id}")))?;
    archive
        .messages_page(id, limit, offset.unwrap_or(0))
        .map_err(|e| ApiError::archive_failed(e.to_string()))
}

fn is_source_key(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn import_diagnostics_core(
    archive: &Archive,
    source_key: Option<&str>,
) -> Result<Vec<ImportDiagnostic>, ApiError> {
    let result = match source_key {
        Some(key) => {
            if !is_source_key(key) {
                return Err(ApiError::invalid("source key must be 64 lowercase hexadecimal characters"));
            }
            archive.diagnostics(key)
        }
        // Skip notices ("limit") are kept whatever came after them (R-3).
        None => archive.recent_diagnostics_keeping(100, "limit"),
    };
    result.map_err(|e| ApiError::archive_failed(e.to_string()))
}

/// Split an FTS snippet into plain text plus highlight ranges.
///
/// Ranges are `[start, end)` offsets in UTF-16 code units, i.e. JavaScript string indices,
/// so the frontend can use `text.slice(start, end)` directly. The archive wraps hits in the
/// private-use sentinels `HIT_START` / `HIT_END`; they are removed from the text. Malformed
/// input never panics: a start inside an open range and an end with no open range are
/// dropped, a range still open at the end is closed there, and empty ranges are omitted.
pub fn split_snippet(snippet: &str) -> (String, Vec<[u32; 2]>) {
    let mut text = String::with_capacity(snippet.len());
    let mut ranges = Vec::new();
    let mut pos: u32 = 0;
    let mut open: Option<u32> = None;
    for c in snippet.chars() {
        if c == HIT_START {
            if open.is_none() {
                open = Some(pos);
            }
        } else if c == HIT_END {
            if let Some(start) = open.take() {
                if pos > start {
                    ranges.push([start, pos]);
                }
            }
        } else {
            text.push(c);
            pos += c.len_utf16() as u32;
        }
    }
    if let Some(start) = open {
        if pos > start {
            ranges.push([start, pos]);
        }
    }
    (text, ranges)
}

/// One search hit, enriched with its session.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SearchHit {
    pub session_id: String,
    pub message_id: String,
    pub seq: u32,
    pub block_index: u32,
    pub kind: HitKind,
    pub at: Option<i64>,
    pub score: f64,
    /// Plain snippet text (no markup, no sentinels).
    pub text: String,
    /// `[start, end)` UTF-16 offsets into `text`.
    pub highlights: Vec<[u32; 2]>,
    pub agent_id: String,
    pub project_root: Option<String>,
    pub session_title: Option<String>,
    /// The native title, else one derived from the session's first prompt (see SessionRow).
    pub session_display_title: Option<String>,
    pub session_started_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SearchPage {
    pub items: Vec<SearchHit>,
    pub limit: u32,
    pub offset: u32,
    pub has_more: bool,
}

pub fn search_core(archive: &Archive, input: &SearchInput) -> Result<SearchPage, ApiError> {
    let trimmed = input.query.trim();
    if trimmed.is_empty() {
        return Err(ApiError::invalid("search query cannot be empty"));
    }
    if let (Some(from), Some(to)) = (input.from, input.to) {
        if from > to {
            return Err(ApiError::invalid("from timestamp cannot be greater than to timestamp"));
        }
    }
    if let Some(limit) = input.limit {
        if limit == 0 || limit > 200 {
            return Err(ApiError::invalid("limit must be between 1 and 200"));
        }
    }
    let limit = input.limit.unwrap_or(20);
    let offset = input.offset.unwrap_or(0);
    let filter = SearchFilter {
        agent: input.agent.clone(),
        project: input.project.clone(),
        from: input.from,
        to: input.to,
        limit: Some(limit + 1),
        offset: Some(offset),
    };
    let mut rows = archive
        .search(trimmed, &filter)
        .map_err(|e| ApiError::archive_failed(e.to_string()))?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);

    let mut sessions: HashMap<String, Option<Session>> = HashMap::new();
    let mut messages: HashMap<String, Option<Message>> = HashMap::new();
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        if !sessions.contains_key(&row.session_id) {
            let found = archive
                .get_session(&row.session_id)
                .map_err(|e| ApiError::archive_failed(e.to_string()))?;
            sessions.insert(row.session_id.clone(), found);
        }
        let session = sessions.get(&row.session_id).and_then(|s| s.as_ref());
        let (text, highlights) = match tool_hit_text(archive, &mut messages, &row)? {
            Some(rendered) => window_hit(&rendered, trimmed),
            None => split_snippet(&row.snippet),
        };
        items.push(SearchHit {
            session_id: row.session_id,
            message_id: row.message_id,
            seq: row.seq,
            block_index: row.block_index,
            kind: row.kind,
            at: row.at,
            score: row.score,
            text,
            highlights,
            agent_id: session.map(|s| s.agent_id.clone()).unwrap_or_default(),
            project_root: session.and_then(|s| s.project_root.clone()),
            session_title: session.and_then(|s| s.title.clone()),
            session_display_title: None,
            session_started_at: session.and_then(|s| s.started_at),
        });
    }
    // Display titles for the sessions on this page, derived once per session.
    let known: Vec<Session> = sessions.into_values().flatten().collect();
    let titles: HashMap<String, Option<String>> = enrich(archive, known)?
        .into_iter()
        .map(|row| (row.session.id.clone(), row.display_title))
        .collect();
    for item in &mut items {
        item.session_display_title = titles.get(&item.session_id).cloned().flatten();
    }
    Ok(SearchPage { items, limit, offset, has_more })
}

// ---------- readable tool hits ----------

/// Characters of a tool hit's text, before the " ... " edges.
const HIT_WINDOW: usize = 160;
/// Input keys a call is summarised by, in order (the Folio uses the same list).
const MAIN_KEYS: [&str; 8] = ["command", "cmd", "file_path", "filePath", "path", "pattern", "query", "url"];

/// JSON as one compact line with string contents left as they are (no escape sequences).
fn compact_json(v: &serde_json::Value) -> String {
    use serde_json::Value;
    match v {
        Value::String(s) => format!("\"{s}\""),
        Value::Array(a) => format!("[{}]", a.iter().map(compact_json).collect::<Vec<_>>().join(",")),
        Value::Object(o) => format!(
            "{{{}}}",
            o.iter().map(|(k, v)| format!("\"{k}\":{}", compact_json(v))).collect::<Vec<_>>().join(",")
        ),
        other => other.to_string(),
    }
}

/// A value as plain text: strings as they are, anything else as compact JSON; whitespace collapsed.
fn plain_value(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => collapse_ws(s),
        other => collapse_ws(&compact_json(other)),
    }
}

/// `<name>: <main value> (<description>)`, or the name with compact `key: value` pairs when the
/// input has no main string value.
fn render_tool_call(name: &str, input: &serde_json::Value) -> String {
    use serde_json::Value;
    let Value::Object(map) = input else {
        return match input {
            Value::Null => name.to_string(),
            other => format!("{name}: {}", plain_value(other)),
        };
    };
    let description = map.get("description").and_then(Value::as_str).map(collapse_ws).filter(|d| !d.is_empty());
    let main = MAIN_KEYS
        .iter()
        .filter_map(|k| map.get(*k).and_then(Value::as_str))
        .map(collapse_ws)
        .find(|v| !v.is_empty());
    let body = match main {
        Some(main) => main,
        None => map
            .iter()
            .filter(|(k, _)| k.as_str() != "description")
            .map(|(k, v)| format!("{k}: {}", plain_value(v)))
            .collect::<Vec<_>>()
            .join(", "),
    };
    let mut out = name.to_string();
    if !body.is_empty() {
        out.push_str(": ");
        out.push_str(&body);
    }
    if let Some(d) = description {
        out.push_str(&format!(" ({d})"));
    }
    out
}

/// The readable text of a tool hit's block, or `None` for a text hit or a block that is not a tool block.
fn tool_hit_text(
    archive: &Archive,
    cache: &mut HashMap<String, Option<Message>>,
    row: &orrery_archive::SearchResult,
) -> Result<Option<String>, ApiError> {
    if row.kind != HitKind::Tool {
        return Ok(None);
    }
    if !cache.contains_key(&row.message_id) {
        let found = archive.get_message(&row.message_id).map_err(|e| ApiError::archive_failed(e.to_string()))?;
        cache.insert(row.message_id.clone(), found);
    }
    let block = cache.get(&row.message_id).and_then(|m| m.as_ref()).and_then(|m| m.blocks.get(row.block_index as usize));
    Ok(match block {
        Some(ContentBlock::ToolCall { name, input, .. }) => Some(render_tool_call(name, input)),
        Some(ContentBlock::ToolResult { output, .. }) => Some(plain_value(output)),
        _ => None,
    })
}

fn fold_char(c: char) -> char {
    let mut lower = c.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some(l), None) => l,
        _ => c,
    }
}

/// `[start, end)` char ranges of every case-insensitive occurrence of each term (non-overlapping
/// per term), overlaps across terms merged, sorted.
fn find_ranges(folded: &[char], terms: &[Vec<char>]) -> Vec<(usize, usize)> {
    let mut found: Vec<(usize, usize)> = Vec::new();
    for term in terms.iter().filter(|t| !t.is_empty()) {
        let mut i = 0;
        while i + term.len() <= folded.len() {
            if folded[i..i + term.len()] == term[..] {
                found.push((i, i + term.len()));
                i += term.len();
            } else {
                i += 1;
            }
        }
    }
    found.sort();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (s, e) in found {
        match merged.last_mut() {
            Some(last) if s < last.1 => last.1 = last.1.max(e),
            _ => merged.push((s, e)),
        }
    }
    merged
}

/// Cut `text` to a window of about `HIT_WINDOW` characters around the first match of any query term
/// (plain " ... " at a cut edge) and return it with `[start, end)` UTF-16 highlight ranges of every
/// case-insensitive occurrence of each term in the windowed text.
fn window_hit(text: &str, query: &str) -> (String, Vec<[u32; 2]>) {
    let chars: Vec<char> = text.chars().collect();
    let folded: Vec<char> = chars.iter().map(|c| fold_char(*c)).collect();
    let terms: Vec<Vec<char>> = query.split_whitespace().map(|t| t.chars().map(fold_char).collect()).collect();
    let n = chars.len();
    let (mut start, mut end) = (0, n);
    if n > HIT_WINDOW {
        let (m, ml) = find_ranges(&folded, &terms).first().map(|(s, e)| (*s, e - s)).unwrap_or((0, 0));
        let before = (HIT_WINDOW - ml.min(HIT_WINDOW)) / 2;
        start = m.saturating_sub(before);
        end = start + HIT_WINDOW;
        if end > n {
            end = n;
            start = n - HIT_WINDOW;
        }
        // Prefer cutting at a space, within 20 characters and never inside the first match.
        if start > 0 && !chars[start - 1].is_whitespace() && !chars[start].is_whitespace() {
            if let Some(j) = (start..(start + 20).min(m)).find(|j| chars[*j].is_whitespace()) {
                start = j + 1;
            }
        }
        if end < n && !chars[end - 1].is_whitespace() && !chars[end].is_whitespace() {
            if let Some(k) = ((end.saturating_sub(20).max(m + ml))..end).rev().find(|k| chars[*k].is_whitespace()) {
                end = k;
            }
        }
        while start < m && chars[start].is_whitespace() {
            start += 1;
        }
        while end > start + 1 && chars[end - 1].is_whitespace() {
            end -= 1;
        }
    }
    let edge = " ... ";
    let mut out = String::new();
    let mut offset = 0u32;
    if start > 0 {
        out.push_str(edge);
        offset = edge.encode_utf16().count() as u32;
    }
    out.extend(&chars[start..end]);
    if end < n {
        out.push_str(edge);
    }
    // UTF-16 position of every char of the window.
    let mut pos = Vec::with_capacity(end - start + 1);
    let mut at = offset;
    for c in &chars[start..end] {
        pos.push(at);
        at += c.len_utf16() as u32;
    }
    pos.push(at);
    let highlights = find_ranges(&folded[start..end], &terms)
        .into_iter()
        .map(|(s, e)| [pos[s], pos[e]])
        .collect();
    (out, highlights)
}

// ---------- IPC trace and lazy discovery (re-exported by `launch`) ----------

/// Longest line `ui_trace` will print.
pub const TRACE_LINE_MAX: usize = 300;

/// Pure form of `trace_enabled`: the env value is exactly "1".
pub fn trace_enabled_from(value: Option<&str>) -> bool {
    value == Some("1")
}

/// True when env `ARMILLARY_TRACE_IPC` is "1".
pub fn trace_enabled() -> bool {
    trace_enabled_from(std::env::var("ARMILLARY_TRACE_IPC").ok().as_deref())
}

/// Print `[armillary] <line>` to stderr, only when tracing is enabled.
/// Callers pass command names, ok/err codes and counts, never content, titles or paths.
pub fn trace(line: &str) {
    if trace_enabled() {
        eprintln!("[armillary] {line}");
    }
}

/// Truncate to at most `TRACE_LINE_MAX` characters (never splits a character).
pub fn truncate_trace_line(line: &str) -> String {
    line.chars().take(TRACE_LINE_MAX).collect()
}

/// Fill `state` with `discover()` only when it has no targets yet.
pub fn ensure_targets_with(state: &CoreState, discover: impl FnOnce() -> Vec<ImportTarget>) {
    if state.targets_snapshot().is_empty() {
        state.set_targets(discover());
    }
}

// ---------- Tauri command handlers ----------

/// Trace one command outcome: name, ok/err code and counts only, never content, titles or paths.
fn trace_result<T>(command: &str, result: &Result<T, ApiError>, detail: impl FnOnce(&T) -> String) {
    if !trace_enabled() {
        return;
    }
    match result {
        Ok(value) => trace(&format!("cmd {command} ok {}", detail(value))),
        Err(e) => trace(&format!("cmd {command} err {}", e.code)),
    }
}

/// The app data folder (where firstrun.json and the archive live).
pub fn app_data_dir_of<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, ApiError> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map_err(|e| ApiError::archive_failed(format!("no app data dir: {e}")))
}

/// Consent-gated Import now: without recorded consent nothing is discovered or read.
pub fn import_now_in(
    data_dir: &Path,
    state: &CoreState,
    discover: impl FnOnce() -> Vec<ImportTarget>,
    agent_id: Option<&str>,
    emit: &dyn Fn(ImportPayload),
) -> Result<ImportSummary, ApiError> {
    consent::require(data_dir)?;
    let importer = Importer::new(state.archive.clone());
    // After consent discovery may never have run (it is no longer part of launch).
    ensure_targets_with(state, discover);
    import_now_core_with_importer(state, importer, agent_id, emit)
}

#[tauri::command]
pub fn import_now(
    app: tauri::AppHandle,
    state: tauri::State<'_, CoreState>,
    agent_id: Option<String>,
) -> Result<ImportSummary, ApiError> {
    use tauri::Emitter;
    let result = app_data_dir_of(&app).and_then(|data_dir| {
        import_now_in(
            &data_dir,
            &state,
            || {
                let (env, fs) = scope::detection_env();
                crate::importer::discover_targets(env.as_ref(), fs.as_ref())
            },
            agent_id.as_deref(),
            &|p| {
                let _ = app.emit("import:progress", &p);
            },
        )
    });
    trace_result("import_now", &result, |s| {
        format!("adapters={} sessions={} messages={}", s.adapters, s.sessions, s.messages)
    });
    result
}

#[tauri::command]
pub fn sessions_query(
    state: tauri::State<'_, CoreState>,
    query: SessionQuery,
) -> Result<Page<SessionRow>, ApiError> {
    let result = sessions_query_core(&state.archive, &query);
    trace_result("sessions_query", &result, |p| {
        format!("items={} total={}", p.items.len(), p.total)
    });
    result
}

#[tauri::command]
pub fn session_get(state: tauri::State<'_, CoreState>, id: String) -> Result<SessionRow, ApiError> {
    let result = session_get_core(&state.archive, &id);
    trace_result("session_get", &result, |_| "items=1".to_string());
    result
}

#[tauri::command]
pub fn messages_page(
    state: tauri::State<'_, CoreState>,
    id: String,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Page<Message>, ApiError> {
    let result = messages_page_core(&state.archive, &id, limit, offset);
    trace_result("messages_page", &result, |p| {
        format!("items={} total={}", p.items.len(), p.total)
    });
    result
}

#[tauri::command]
pub fn import_diagnostics(
    state: tauri::State<'_, CoreState>,
    source_key: Option<String>,
) -> Result<Vec<ImportDiagnostic>, ApiError> {
    let result = import_diagnostics_core(&state.archive, source_key.as_deref());
    trace_result("import_diagnostics", &result, |d| format!("items={}", d.len()));
    result
}

#[tauri::command]
pub fn search(
    state: tauri::State<'_, CoreState>,
    input: SearchInput,
) -> Result<SearchPage, ApiError> {
    let result = search_core(&state.archive, &input);
    trace_result("search", &result, |p| {
        format!("items={} has_more={}", p.items.len(), p.has_more)
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::importer::testutil::{appended_user_record, append_record, staged_targets};
    use armillary_model::ContentBlock;

    /// R2-REV-1 / LA-2: after "Not now" Import now must refuse before discovery or any read.
    #[test]
    fn import_now_refuses_after_decline_and_reads_nothing() {
        use crate::archive_api::testkit::{tmp, write_consented, write_declined};
        let data = tmp();
        let home = tmp();
        let staged = staged_targets(home.path());
        let state = CoreState::new(Arc::new(Archive::in_memory().unwrap()), staged);
        for declined in [false, true] {
            if declined {
                write_declined(data.path());
            }
            let mut discovered = false;
            let err = import_now_in(data.path(), &state, || {
                discovered = true;
                Vec::new()
            }, None, &|_| {})
            .unwrap_err();
            assert_eq!(err.code, "consent_required");
            assert!(!discovered, "discovery must not run without consent");
            assert_eq!(state.archive.stats().unwrap().sessions, 0, "nothing under the fake HOME was imported");
        }
        // Control: with consent the same call imports the fake HOME.
        write_consented(data.path());
        let summary = import_now_in(data.path(), &state, Vec::new, None, &|_| {}).unwrap();
        assert!(summary.sessions > 0);
    }

    /// R2-REV-3: Delete archive and reset removes the archive content, firstrun.json and leftover
    /// snapshot folders, and leaves everything else alone.
    #[test]
    fn delete_data_removes_archive_firstrun_and_snapshots_only() {
        use crate::archive_api::testkit::{tmp, write_consented};
        let data = tmp();
        let temp = tmp();
        let home = tmp();
        let archive = open_archive_in(data.path()).unwrap();
        let state = CoreState::new(archive.clone(), staged_targets(home.path()));
        import_now_core(&state, None, &|_| {}).unwrap();
        assert!(archive.stats().unwrap().sessions > 0);
        write_consented(data.path());
        std::fs::write(data.path().join("firstrun.json.tmp"), "{}").unwrap();
        std::fs::write(data.path().join("keep.txt"), "user file").unwrap();
        for name in ["armillary-sqlite-abc", "armillary-module-sqlite-def", "orrery-sqlite-snapshot-1", "unrelated"] {
            std::fs::create_dir_all(temp.path().join(name)).unwrap();
            std::fs::write(temp.path().join(name).join("snapshot.db"), "x").unwrap();
        }
        // A link with a snapshot name is removed as a link; its target is never touched.
        std::os::unix::fs::symlink(temp.path().join("unrelated"), temp.path().join("armillary-sqlite-link")).unwrap();

        delete_data_in(data.path(), temp.path(), &archive).unwrap();

        assert_eq!(archive.stats().unwrap().sessions, 0, "the archive is empty");
        assert!(!data.path().join("firstrun.json").exists());
        assert!(!data.path().join("firstrun.json.tmp").exists());
        assert!(!consent::recorded(data.path()), "consent is gone: the first run asks again");
        assert!(data.path().join("keep.txt").exists(), "other files stay");
        for name in ["armillary-sqlite-abc", "armillary-module-sqlite-def", "orrery-sqlite-snapshot-1", "armillary-sqlite-link"] {
            assert!(std::fs::symlink_metadata(temp.path().join(name)).is_err(), "{name} removed");
        }
        assert!(temp.path().join("unrelated/snapshot.db").exists(), "unrelated folders stay");
        // A second delete on the empty state is fine.
        delete_data_in(data.path(), temp.path(), &archive).unwrap();
    }

    /// PRIV-2 / V-REG-3 / P3-2 (r2 fix round 1): "Move it aside" keeps the old archive as
    /// <archive>.bak-<time> with its -wal and -shm. Those are full copies of the history, so Delete
    /// archive and reset removes them too. Other files that only start alike stay.
    #[test]
    fn delete_also_removes_the_moved_aside_copies() {
        use crate::archive_api::testkit::{tmp, write_consented};
        let data = tmp();
        let temp = tmp();
        let home = tmp();
        let archive = open_archive_in(data.path()).unwrap();
        let state = CoreState::new(archive.clone(), staged_targets(home.path()));
        import_now_core(&state, None, &|_| {}).unwrap();
        let kept = move_archive_aside_in(data.path(), &archive).unwrap();
        let stamp = kept.file_name().unwrap().to_string_lossy().to_string();
        for suffix in ["-wal", "-shm"] {
            std::fs::write(data.path().join(format!("{stamp}{suffix}")), "copy").unwrap();
        }
        std::fs::write(data.path().join(format!("{ARCHIVE_FILE}.bak-1700000000000")), "older copy").unwrap();
        std::fs::write(data.path().join("armillary-archive-notes.txt"), "user file").unwrap();
        write_consented(data.path());
        delete_data_in(data.path(), temp.path(), &archive).unwrap();
        let left: Vec<String> = std::fs::read_dir(data.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".bak-"))
            .collect();
        assert!(left.is_empty(), "old archive copies survive Delete archive and reset: {left:?}");
        assert!(data.path().join("armillary-archive-notes.txt").exists(), "other files stay");
    }

    /// V-REG-10 (b): when the archive is emptied but a later file cannot be removed, the error says
    /// the archive was partly deleted (code partly_deleted), not that nothing was deleted.
    #[test]
    fn a_delete_that_stops_after_emptying_the_archive_says_partly_deleted() {
        use crate::archive_api::testkit::tmp;
        let data = tmp();
        let temp = tmp();
        let home = tmp();
        let archive = open_archive_in(data.path()).unwrap();
        let state = CoreState::new(archive.clone(), staged_targets(home.path()));
        import_now_core(&state, None, &|_| {}).unwrap();
        // firstrun.json as a folder with a file in it: remove_file cannot remove it.
        std::fs::create_dir_all(data.path().join(consent::CONSENT_FILE)).unwrap();
        std::fs::write(data.path().join(consent::CONSENT_FILE).join("x"), "x").unwrap();
        let err = delete_data_in(data.path(), temp.path(), &archive).unwrap_err();
        assert_eq!(err.code, "partly_deleted", "{err}");
        assert!(err.message.contains("firstrun.json"), "{err}");
        assert_eq!(archive.stats().unwrap().sessions, 0, "the sessions are gone");
    }

    /// V-REG-10 (a): only a file that is not a database (or not a readable archive) is called
    /// damaged. Any other open error says what went wrong.
    #[test]
    fn an_archive_that_cannot_be_opened_for_another_reason_is_not_called_damaged() {
        use crate::archive_api::testkit::tmp;
        let data = tmp();
        // A folder where the archive file should be: the open fails, the file is not damaged.
        std::fs::create_dir_all(data.path().join(ARCHIVE_FILE)).unwrap();
        let (_archive, problem) = open_or_recover_in(data.path());
        let problem = problem.expect("the open failure is reported");
        assert!(!problem.contains("damaged"), "{problem}");
        assert!(problem.starts_with("The archive file could not be opened"), "{problem}");
    }

    /// V-REG-10 (a): Move it aside is refused while the archive opened normally.
    #[test]
    fn move_aside_is_refused_for_a_healthy_archive() {
        use crate::archive_api::testkit::tmp;
        let data = tmp();
        let archive = open_archive_in(data.path()).unwrap();
        let health = ArchiveHealth::default();
        let err = move_aside_core(data.path(), &archive, &health).unwrap_err();
        assert_eq!(err.code, "invalid_input");
        assert!(data.path().join(ARCHIVE_FILE).exists(), "the archive stays where it is");
        let names: Vec<String> = std::fs::read_dir(data.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert!(!names.iter().any(|n| n.contains(".bak-")), "{names:?}");
        // With a recorded problem the move goes ahead and the problem is cleared.
        *health.problem.lock().unwrap() = Some("damaged".into());
        move_aside_core(data.path(), &archive, &health).unwrap();
        assert!(health.problem.lock().unwrap().is_none());
    }

    /// R2-REV-7: a damaged archive, or one from a newer version, does not stop the app: it opens on
    /// an empty in-memory archive, says why, and leaves the file untouched until the user moves it.
    #[test]
    fn a_damaged_or_newer_archive_is_reported_and_kept_until_moved_aside() {
        use crate::archive_api::testkit::tmp;
        let data = tmp();
        let path = data.path().join(ARCHIVE_FILE);
        std::fs::write(&path, b"this is not a database, it is a damaged archive file").unwrap();
        let before = std::fs::read(&path).unwrap();
        let (archive, problem) = open_or_recover_in(data.path());
        let problem = problem.expect("a damaged archive is reported");
        assert!(problem.contains("damaged"), "{problem}");
        assert_eq!(archive.stats().unwrap().sessions, 0, "the app runs on an empty archive");
        assert_eq!(std::fs::read(&path).unwrap(), before, "the file is left untouched");

        let moved = move_archive_aside_in(data.path(), &archive).unwrap();
        assert_eq!(std::fs::read(&moved).unwrap(), before, "the old file is kept, renamed");
        assert!(moved.file_name().unwrap().to_string_lossy().starts_with("armillary-archive.sqlite3.bak-"));
        let (reopened, problem) = open_or_recover_in(data.path());
        assert!(problem.is_none(), "a fresh archive now sits at the path");
        drop(reopened);

        // A newer schema gets its own message.
        let newer = tmp();
        let newer_path = newer.path().join(ARCHIVE_FILE);
        drop(Archive::open(&newer_path).unwrap());
        // The schema version is SQLite's user_version: 4 big-endian bytes at offset 60 of the header.
        let mut bytes = std::fs::read(&newer_path).unwrap();
        bytes[60..64].copy_from_slice(&99u32.to_be_bytes());
        std::fs::write(&newer_path, bytes).unwrap();
        let _ = std::fs::remove_file(newer.path().join(format!("{ARCHIVE_FILE}-wal")));
        let _ = std::fs::remove_file(newer.path().join(format!("{ARCHIVE_FILE}-shm")));
        let (_a, problem) = open_or_recover_in(newer.path());
        assert!(problem.unwrap().contains("newer version"));
    }

    fn state_with_fixtures(tmp: &Path) -> CoreState {
        let targets = staged_targets(tmp);
        let archive = Arc::new(Archive::in_memory().unwrap());
        let state = CoreState::new(archive, targets);
        import_now_core(&state, None, &|_| {}).unwrap();
        state
    }

    fn claude_file(state: &CoreState) -> PathBuf {
        state.targets_snapshot()[0]
            .data_dirs
            .first()
            .unwrap()
            .join("projects/my-web-app/session-001.jsonl")
    }

    #[test]
    fn open_archive_creates_sqlite_file_in_data_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("armillary-data");
        let archive = open_archive_in(&dir).unwrap();
        assert!(dir.join("armillary-archive.sqlite3").exists());
        assert!(archive.schema_version().unwrap() > 0);
    }

    #[test]
    fn import_then_query_search_and_get() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_with_fixtures(tmp.path());
        let archive = &state.archive;

        // Query, newest first, with filters.
        let all = sessions_query_core(archive, &SessionQuery::default()).unwrap();
        assert_eq!(all.total, 2);
        assert_eq!(all.items[0].agent_id, "claude-code");
        assert_eq!(all.items[0].project_root.as_deref(), Some("/Users/developer/code/my-web-app"));
        let only_codex = sessions_query_core(
            archive,
            &SessionQuery { agent: Some("codex-cli".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(only_codex.items.len(), 1);
        assert_eq!(only_codex.items[0].project_root.as_deref(), Some("/home/developer/projects/core-api"));
        let paged = sessions_query_core(
            archive,
            &SessionQuery { limit: Some(1), offset: Some(1), ..Default::default() },
        )
        .unwrap();
        assert_eq!(paged.items.len(), 1);
        assert_eq!(paged.total, 2);

        // Search over both agents with snippets.
        let hits = search_core(archive, &SearchInput { query: "package".into(), ..Default::default() })
            .unwrap();
        assert!(!hits.items.is_empty());
        assert!(hits.items.iter().any(|h| !h.highlights.is_empty()));
        assert!(hits.items.iter().all(|h| !h.text.contains('<') || !h.text.contains("<mark>")));
        let codex_hits = search_core(
            archive,
            &SearchInput {
                query: "migration".into(),
                agent: Some("codex-cli".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!codex_hits.items.is_empty());
        let wrong_agent = search_core(
            archive,
            &SearchInput {
                query: "migration".into(),
                agent: Some("claude-code".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(wrong_agent.items.is_empty());

        // Session detail round trip using NormalizedSession contract type.
        let id = &all.items[0].id;
        let detail = session_get_core(archive, id).unwrap();
        assert_eq!(detail.agent_id, "claude-code");
        let messages = messages_page_core(archive, id, Some(200), None).unwrap();
        assert!(!messages.items.is_empty());
        assert_eq!(messages.items[0].role, "user");
        let has_package_json = messages.items.iter().any(|m| {
            m.blocks.iter().any(|b| {
                matches!(b, ContentBlock::ToolCall { files, .. } if files.iter().any(|f| f.contains("package.json")))
            })
        });
        assert!(has_package_json, "tool call blocks retained with file arguments");
    }

    #[test]
    fn import_now_streams_run_and_agent_payloads() {
        let tmp = tempfile::tempdir().unwrap();
        let targets = staged_targets(tmp.path());
        let state = CoreState::new(Arc::new(Archive::in_memory().unwrap()), targets);
        let events = std::sync::Mutex::new(Vec::<ImportPayload>::new());
        let summary = import_now_core(&state, None, &|p| events.lock().unwrap().push(p)).unwrap();
        let events = events.into_inner().unwrap();

        let first = events.first().unwrap();
        assert_eq!((first.agent_id.as_str(), first.phase.as_str()), ("", "started"));
        let last = events.last().unwrap();
        assert_eq!((last.agent_id.as_str(), last.phase.as_str()), ("", "finished"));
        assert_eq!(last.sessions_imported, summary.sessions);
        for id in ["claude-code", "codex-cli"] {
            assert!(events.iter().any(|e| e.agent_id == id && e.phase == "started"), "{id} started");
            assert!(events.iter().any(|e| e.agent_id == id && e.phase == "finished"), "{id} finished");
        }
    }

    #[test]
    fn reimport_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_with_fixtures(tmp.path());
        let before = state.archive.stats().unwrap();
        let summary = import_now_core(&state, None, &|_| {}).unwrap();
        assert_eq!(summary.sessions, 2, "second run still reports what it re-imported");
        let after = state.archive.stats().unwrap();
        assert_eq!(before, after, "re-import must not duplicate rows");
        let all = sessions_query_core(&state.archive, &SessionQuery::default()).unwrap();
        assert_eq!(all.total, 2);
    }

    #[test]
    fn changed_fixture_reimports_incrementally() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_with_fixtures(tmp.path());

        append_record(
            &claude_file(&state),
            &appended_user_record("a note mentioning watcherglow"),
        );
        let summary = import_now_core(&state, Some("claude-code"), &|_| {}).unwrap();
        assert_eq!(summary.sessions, 1);

        let hits = search_core(
            &state.archive,
            &SearchInput { query: "watcherglow".into(), ..Default::default() },
        )
        .unwrap();
        assert_eq!(hits.items.len(), 1, "new content is searchable");
        let all = sessions_query_core(&state.archive, &SessionQuery::default()).unwrap();
        assert_eq!(all.total, 2, "still one session per native id");
        let claude = sessions_query_core(
            &state.archive,
            &SessionQuery { agent: Some("claude-code".into()), ..Default::default() },
        )
        .unwrap();
        assert!(claude.items[0].turns > 1, "the changed session grew");
    }

    #[test]
    fn incomplete_read_keeps_old_data() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_with_fixtures(tmp.path());
        let archive = &state.archive;

        let all = sessions_query_core(archive, &SessionQuery::default()).unwrap();
        let claude_session = &all.items[0];
        let original_turns = claude_session.turns;
        let original_messages =
            messages_page_core(archive, &claude_session.id, Some(200), None).unwrap().total;

        // Append a corrupted line to claude's session file.
        append_record(&claude_file(&state), "{\"type\":\"user\",\"broken\":[corrupted");

        // Run import - must not overwrite valid data.
        let _ = import_now_core(&state, Some("claude-code"), &|_| {});

        // Data in archive remains the old complete data.
        let session_after = session_get_core(archive, &claude_session.id).unwrap();
        assert_eq!(session_after.turns, original_turns, "turns preserved");
        let messages_after =
            messages_page_core(archive, &claude_session.id, Some(200), None).unwrap().total;
        assert_eq!(messages_after, original_messages, "messages preserved");

        // Diagnostics recorded the read failure.
        let key = claude_session.provenance.key();
        let diags = archive.diagnostics(&key).unwrap();
        assert!(!diags.is_empty(), "diagnostic recorded for incomplete read");

        // The same diagnostics come back through the command core, per source and recent.
        let via_core = import_diagnostics_core(archive, Some(&key)).unwrap();
        assert_eq!(via_core, diags);
        assert!(via_core.iter().all(|d| d.source_key == key));
        let recent = import_diagnostics_core(archive, None).unwrap();
        assert!(recent.iter().any(|d| d.source_key == key));
    }

    #[test]
    fn commands_return_typed_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_with_fixtures(tmp.path());
        let archive = &state.archive;

        let err = import_now_core(&state, Some("no-such-agent"), &|_| {}).unwrap_err();
        assert_eq!(err.code, "invalid_input");

        let err = session_get_core(archive, "zz not hex").unwrap_err();
        assert_eq!(err.code, "invalid_input");

        let err = session_get_core(archive, "0000000000000000").unwrap_err();
        assert_eq!(err.code, "not_found");

        let err = search_core(archive, &SearchInput { query: "   ".into(), ..Default::default() })
            .unwrap_err();
        assert_eq!(err.code, "invalid_input");

        let err = sessions_query_core(
            archive,
            &SessionQuery { from: Some(10), to: Some(5), ..Default::default() },
        )
        .unwrap_err();
        assert_eq!(err.code, "invalid_input");

        let err = sessions_query_core(
            archive,
            &SessionQuery { limit: Some(100_000), ..Default::default() },
        )
        .unwrap_err();
        assert_eq!(err.code, "invalid_input");
    }

    /// Smoke over every adapter that has a history source: stage its synthetic fixture, import it
    /// into an on-disk archive through the command layer, then search. Prints what each adapter
    /// produced (run with --nocapture); only the two reference adapters are asserted.
    #[test]
    fn smoke_every_history_adapter_fixture_imports_and_searches() {
        use crate::importer::testutil::{repo_fixtures, stage_history_adapter_to_home};
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().canonicalize().unwrap();
        let archive = open_archive_in(&home.join("data")).unwrap();
        let mut targets = Vec::new();
        for adapter in orrery_adapters::builtin_adapters() {
            if adapter.history_sources.is_empty() || !repo_fixtures().join(&adapter.id).is_dir() {
                continue;
            }
            let data_dirs = stage_history_adapter_to_home(&home, &adapter.id);
            if !data_dirs.is_empty() {
                targets.push(ImportTarget { adapter, data_dirs });
            }
        }
        let state = CoreState::new(archive, targets);
        let ids: Vec<String> = state.targets_snapshot().iter().map(|t| t.adapter.id.clone()).collect();
        let mut imported = Vec::new();
        for id in &ids {
            match import_now_core(&state, Some(id), &|_| {}) {
                Ok(sum) => {
                    eprintln!("SMOKE {id}: ok, {} sessions, {} messages", sum.sessions, sum.messages);
                    if sum.sessions > 0 {
                        imported.push(id.clone());
                    }
                }
                Err(e) => eprintln!("SMOKE {id}: ERROR {} {}", e.code, e.message),
            }
        }
        assert!(imported.contains(&"claude-code".to_string()));
        assert!(imported.contains(&"codex-cli".to_string()));
        let page = sessions_query_core(&state.archive, &SessionQuery::default()).unwrap();
        eprintln!("SMOKE total sessions in archive: {}", page.total);
        for term in ["design", "refactor", "parser"] {
            let hits = search_core(
                &state.archive,
                &SearchInput { query: term.into(), limit: Some(5), ..Default::default() },
            )
            .unwrap();
            eprintln!("SMOKE search '{term}': {} hits", hits.items.len());
            for h in hits.items.iter().take(3) {
                eprintln!("  hit session={}.. seq={} kind={:?} score={:.2} text={}", &h.session_id[..8], h.seq, h.kind, h.score, h.text);
            }
        }
    }

    // ---------- synthetic archive helpers ----------

    use armillary_model::{
        stable_message_id, stable_session_id, Agent, Checkpoint, ContentBlock as CB, ImportBatch,
        ImportMode, NormalizedSession, ReadStatus, SourceProvenance, StoreIdentity, Usage,
    };

    const T0: i64 = 1_700_000_000_000;

    /// One session whose message `i` (1-based) holds `texts[i - 1]`; time is T0 + i * 1000.
    fn synth(texts: &[&str]) -> (Arc<Archive>, ImportBatch) {
        let msgs = texts
            .iter()
            .enumerate()
            .map(|(i, text)| {
                let seq = i as i64 + 1;
                (
                    if seq % 2 == 1 { "user" } else { "assistant" },
                    Some(T0 + seq * 1000),
                    vec![CB::Text { text: (*text).to_string() }],
                )
            })
            .collect();
        synth_custom(Some("Synthetic title"), msgs)
    }

    /// One session with the given native title and messages (role, time, blocks) in order.
    fn synth_custom(
        title: Option<&str>,
        msgs: Vec<(&str, Option<i64>, Vec<CB>)>,
    ) -> (Arc<Archive>, ImportBatch) {
        let archive = Archive::in_memory().unwrap();
        archive
            .register_agent(&Agent {
                id: "test".into(),
                name: "test".into(),
                vendor: "Synthetic".into(),
                family: "other".into(),
                kind: "cli".into(),
            })
            .unwrap();
        let n = msgs.len() as u64;
        let source = SourceProvenance {
            store: StoreIdentity::new("test-history", "fixture://test", "p"),
            source_id: "history".into(),
            adapter_id: "test".into(),
            adapter_version: "1".into(),
            source_path: "session.jsonl".into(),
            file_identity: "synthetic:inode:1".into(),
            generation: 1,
            checkpoint: Checkpoint {
                revision: 1,
                offset: n * 100,
                records: n,
                digest: armillary_model::stable_id("checkpoint", &[&n.to_string()]),
            },
        };
        let id = stable_session_id(&source.store.id, "1");
        let messages = msgs
            .into_iter()
            .enumerate()
            .map(|(i, (role, at, blocks))| {
                let seq = i as u32 + 1;
                let native = format!("event-{seq}");
                Message {
                    id: stable_message_id(&id, &native),
                    session_id: id.clone(),
                    native_id: Some(native),
                    seq,
                    role: role.into(),
                    at,
                    blocks,
                }
            })
            .collect::<Vec<_>>();
        let session = Session {
            id,
            agent_id: "test".into(),
            installation_id: None,
            native_id: Some("1".into()),
            provenance: source.clone(),
            project_root: Some("/synthetic".into()),
            title: title.map(str::to_string),
            started_at: Some(T0),
            ended_at: None,
            model: Some("test-model".into()),
            status: "unknown".into(),
            completion: None,
            turns: 1,
            usage: Usage::default(),
            parent_id: None,
            native_parent_id: None,
        };
        let batch = ImportBatch {
            source,
            mode: ImportMode::Snapshot,
            read_status: ReadStatus::Complete,
            sessions: vec![NormalizedSession { session, messages }],
            diagnostics: vec![],
            live_updates: vec![],
        };
        archive.import_batch(&batch).unwrap();
        (Arc::new(archive), batch)
    }

    fn utf16_slice(text: &str, range: [u32; 2]) -> String {
        let units: Vec<u16> = text.encode_utf16().collect();
        String::from_utf16(&units[range[0] as usize..range[1] as usize]).unwrap()
    }

    fn search_input(query: &str, limit: Option<u32>, offset: Option<u32>) -> SearchInput {
        SearchInput { query: query.into(), limit, offset, ..Default::default() }
    }

    // ---------- split_snippet ----------

    const S: char = orrery_archive::HIT_START;
    const E: char = orrery_archive::HIT_END;

    #[test]
    fn split_snippet_ascii_single_hit() {
        let (text, ranges) = split_snippet(&format!("say {S}hello{E} world"));
        assert_eq!(text, "say hello world");
        assert_eq!(ranges, vec![[4, 9]]);
    }

    #[test]
    fn split_snippet_without_hits_is_plain() {
        let (text, ranges) = split_snippet("nothing here");
        assert_eq!(text, "nothing here");
        assert!(ranges.is_empty());
    }

    #[test]
    fn split_snippet_multiple_hits() {
        let (text, ranges) = split_snippet(&format!("{S}a{E} b {S}cc{E} d {S}e{E}"));
        assert_eq!(text, "a b cc d e");
        assert_eq!(ranges, vec![[0, 1], [4, 6], [9, 10]]);
    }

    #[test]
    fn split_snippet_offsets_are_utf16_code_units() {
        // U+1F600 is 1 char, 4 UTF-8 bytes and 2 UTF-16 units; the accented char is 1 unit.
        let (text, ranges) = split_snippet(&format!("\u{1F600} caf\u{e9} {S}hit{E}!"));
        assert_eq!(text, "\u{1F600} caf\u{e9} hit!");
        // chars: 😀 ' ' c a f é ' ' => hit starts at char 7 but UTF-16 unit 8.
        assert_eq!(ranges, vec![[8, 11]]);
        assert_eq!(utf16_slice(&text, ranges[0]), "hit");
        let char_start = text[..text.find("hit").unwrap()].chars().count();
        assert_eq!(char_start, 7, "char offset differs from the UTF-16 offset");
        assert_eq!(text.find("hit"), Some(11), "byte offset differs too");
    }

    #[test]
    fn split_snippet_non_bmp_inside_the_hit() {
        let (text, ranges) = split_snippet(&format!("{S}a\u{1F600}b{E}"));
        assert_eq!(text, "a\u{1F600}b");
        assert_eq!(ranges, vec![[0, 4]]);
    }

    #[test]
    fn split_snippet_unpaired_start_closes_at_end() {
        let (text, ranges) = split_snippet(&format!("ab {S}cd"));
        assert_eq!(text, "ab cd");
        assert_eq!(ranges, vec![[3, 5]]);
    }

    #[test]
    fn split_snippet_unpaired_end_is_dropped() {
        let (text, ranges) = split_snippet(&format!("ab{E} cd"));
        assert_eq!(text, "ab cd");
        assert!(ranges.is_empty());
    }

    #[test]
    fn split_snippet_nested_and_stray_sentinels_never_panic() {
        let (text, ranges) = split_snippet(&format!("{S}a{S}b{E}c{E}{E}{S}{E}{S}"));
        assert!(!text.contains(S) && !text.contains(E));
        assert_eq!(text, "abc");
        assert_eq!(ranges, vec![[0, 2]]);
        for r in &ranges {
            assert!(r[0] < r[1], "no empty ranges: {ranges:?}");
            assert!(r[1] as usize <= text.encode_utf16().count());
        }
        let (empty_text, empty_ranges) = split_snippet("");
        assert_eq!(empty_text, "");
        assert!(empty_ranges.is_empty());
    }

    #[test]
    fn split_snippet_keeps_literal_mark_text_literal() {
        let (text, ranges) = split_snippet(&format!("use <mark>x</mark> and {S}find{E}"));
        assert_eq!(text, "use <mark>x</mark> and find");
        assert_eq!(ranges, vec![[23, 27]]);
        assert_eq!(utf16_slice(&text, ranges[0]), "find");
    }

    // ---------- search hits and paging ----------

    #[test]
    fn search_hits_carry_message_anchor_time_and_session_fields() {
        let (archive, batch) = synth(&["first plain", "second alphaneedle here", "third plain"]);
        let page = search_core(&archive, &search_input("alphaneedle", None, None)).unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(!page.has_more);
        assert_eq!((page.limit, page.offset), (20, 0));
        let hit = &page.items[0];
        let messages = &batch.sessions[0].messages;
        assert_eq!(hit.session_id, batch.sessions[0].session.id);
        assert_eq!(hit.message_id, messages[1].id);
        assert_eq!((hit.seq, hit.block_index), (2, 0));
        assert_eq!(hit.kind, HitKind::Message);
        assert_eq!(hit.at, Some(T0 + 2000));
        assert_eq!(hit.agent_id, "test");
        assert_eq!(hit.project_root.as_deref(), Some("/synthetic"));
        assert_eq!(hit.session_title.as_deref(), Some("Synthetic title"));
        assert_eq!(hit.session_started_at, Some(T0));
        assert!(hit.score.is_finite());
    }

    #[test]
    fn search_hit_serializes_snake_case() {
        let (archive, _) = synth(&["alphaneedle"]);
        let page = search_core(&archive, &search_input("alphaneedle", None, None)).unwrap();
        let json = serde_json::to_value(&page).unwrap();
        assert_eq!(json["has_more"], serde_json::json!(false));
        let item = &json["items"][0];
        for key in [
            "session_id", "message_id", "seq", "block_index", "kind", "at", "score", "text",
            "highlights", "agent_id", "project_root", "session_title", "session_started_at",
        ] {
            assert!(item.get(key).is_some(), "missing key {key}");
        }
        assert_eq!(item["kind"], serde_json::json!("message"));
    }

    #[test]
    fn search_pages_with_has_more_and_offset() {
        let texts: Vec<String> = (1..=5).map(|i| format!("sharedterm number {i}")).collect();
        let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
        let (archive, _) = synth(&refs);

        let p1 = search_core(&archive, &search_input("sharedterm", Some(2), Some(0))).unwrap();
        assert_eq!((p1.items.len(), p1.limit, p1.offset, p1.has_more), (2, 2, 0, true));
        let p2 = search_core(&archive, &search_input("sharedterm", Some(2), Some(2))).unwrap();
        assert_eq!((p2.items.len(), p2.limit, p2.offset, p2.has_more), (2, 2, 2, true));
        let p3 = search_core(&archive, &search_input("sharedterm", Some(2), Some(4))).unwrap();
        assert_eq!((p3.items.len(), p3.limit, p3.offset, p3.has_more), (1, 2, 4, false));

        let mut ids: Vec<String> =
            [p1, p2, p3].iter().flat_map(|p| p.items.iter().map(|h| h.message_id.clone())).collect();
        assert_eq!(ids.len(), 5);
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 5, "every hit appears exactly once across pages");

        let exact = search_core(&archive, &search_input("sharedterm", Some(5), None)).unwrap();
        assert_eq!(exact.items.len(), 5);
        assert!(!exact.has_more, "exactly limit rows is not has_more");
    }

    #[test]
    fn search_limit_validation_is_unchanged() {
        let (archive, _) = synth(&["alphaneedle"]);
        for bad in [0u32, 201] {
            let err = search_core(&archive, &search_input("alphaneedle", Some(bad), None)).unwrap_err();
            assert_eq!(err.code, "invalid_input");
        }
        assert!(search_core(&archive, &search_input("alphaneedle", Some(200), None)).is_ok());
        assert!(search_core(&archive, &search_input("alphaneedle", Some(1), None)).is_ok());
    }

    #[test]
    fn search_highlights_point_at_the_query_term_in_text() {
        let (archive, _) = synth(&["\u{1F600}\u{1F600} some words before needlefind and more after"]);
        let page = search_core(&archive, &search_input("needlefind", None, None)).unwrap();
        let hit = &page.items[0];
        assert!(!hit.text.contains(S) && !hit.text.contains(E), "sentinels removed: {:?}", hit.text);
        assert_eq!(hit.highlights.len(), 1);
        assert_eq!(utf16_slice(&hit.text, hit.highlights[0]).to_lowercase(), "needlefind");
        // The emoji pair before the hit makes UTF-16 offsets differ from char offsets.
        let char_start = hit.text.find("needlefind").map(|b| hit.text[..b].chars().count()).unwrap();
        assert_ne!(hit.highlights[0][0] as usize, char_start);
    }

    #[test]
    fn search_text_keeps_literal_mark_markup_literal() {
        let (archive, _) = synth(&["wrap with <mark>tag</mark> then literalneedle"]);
        let page = search_core(&archive, &search_input("literalneedle", None, None)).unwrap();
        let hit = &page.items[0];
        assert!(hit.text.contains("<mark>tag</mark>"), "literal markup preserved: {:?}", hit.text);
        assert_eq!(hit.highlights.len(), 1);
        assert_eq!(utf16_slice(&hit.text, hit.highlights[0]), "literalneedle");
    }


    // ---------- display title and activity span ----------

    fn utext(t: &str) -> CB {
        CB::Text { text: t.to_string() }
    }

    /// The only session of a synthetic archive, as sessions_query and session_get return it.
    fn rows(archive: &Archive, batch: &ImportBatch) -> (SessionRow, SessionRow) {
        let listed = sessions_query_core(archive, &SessionQuery::default()).unwrap();
        assert_eq!(listed.items.len(), 1);
        (listed.items[0].clone(), session_get_core(archive, &batch.sessions[0].session.id).unwrap())
    }

    #[test]
    fn native_title_wins_and_is_marked_native() {
        let (archive, batch) = synth(&["first prompt text", "reply", "third"]);
        for row in [rows(&archive, &batch).0, rows(&archive, &batch).1] {
            assert_eq!(row.title.as_deref(), Some("Synthetic title"));
            assert_eq!(row.display_title.as_deref(), Some("Synthetic title"));
            assert_eq!(row.title_source, Some(TitleSource::Native));
        }
    }

    #[test]
    fn search_hits_carry_the_session_display_title() {
        let (archive, _batch) = synth_custom(
            None,
            vec![
                ("user", Some(T0 + 1000), vec![utext("Fix the flaky login test. It fails on CI only.")]),
                ("assistant", Some(T0 + 2000), vec![utext("Looking at the zetaneedle fixture now.")]),
            ],
        );
        let page = search_core(&archive, &search_input("zetaneedle", None, None)).unwrap();
        assert_eq!(page.items.len(), 1);
        let hit = &page.items[0];
        assert_eq!(hit.session_title, None, "the native title stays unknown");
        assert_eq!(hit.session_display_title.as_deref(), Some("Fix the flaky login test."));
        let json = serde_json::to_value(hit).unwrap();
        assert!(json.get("session_display_title").is_some());
    }

    #[test]
    fn missing_title_is_derived_from_the_first_user_text_and_contract_title_stays_null() {
        let (archive, batch) = synth_custom(
            None,
            vec![
                ("assistant", Some(T0 + 1000), vec![utext("An assistant line that must not be used.")]),
                ("user", Some(T0 + 2000), vec![utext("Fix the flaky login test. It fails on CI only.")]),
                ("user", Some(T0 + 3000), vec![utext("A later prompt")]),
            ],
        );
        for row in [rows(&archive, &batch).0, rows(&archive, &batch).1] {
            assert_eq!(row.title, None, "the contract title stays unknown");
            assert_eq!(row.display_title.as_deref(), Some("Fix the flaky login test."));
            assert_eq!(row.title_source, Some(TitleSource::FirstPrompt));
        }
        let json = serde_json::to_value(rows(&archive, &batch).0).unwrap();
        assert_eq!(json["title"], serde_json::Value::Null);
        assert_eq!(json["display_title"], serde_json::json!("Fix the flaky login test."));
        assert_eq!(json["title_source"], serde_json::json!("first_prompt"));
        // A superset of the contract Session: its own fields stay at the top level.
        for key in ["id", "agent_id", "provenance", "started_at", "status", "turns", "usage"] {
            assert!(json.get(key).is_some(), "missing contract key {key}");
        }
        // Take the four extra fields away and what remains is exactly the contract Session.
        let mut contract = json;
        for key in ["display_title", "title_source", "first_activity_at", "last_activity_at"] {
            contract.as_object_mut().unwrap().remove(key);
        }
        let back: Session = serde_json::from_value(contract).expect("the rest is a contract Session");
        let stored = archive.get_session(&batch.sessions[0].session.id).unwrap().unwrap();
        assert_eq!(back, stored);
    }

    #[test]
    fn no_user_text_means_no_display_title() {
        let (archive, batch) = synth_custom(
            None,
            vec![
                ("assistant", Some(T0 + 1000), vec![utext("assistant only")]),
                (
                    "user",
                    Some(T0 + 2000),
                    vec![CB::ToolResult { call_id: "c".into(), output: serde_json::json!("x"), is_error: None }],
                ),
            ],
        );
        let (listed, got) = rows(&archive, &batch);
        for row in [listed, got] {
            assert_eq!(row.display_title, None);
            assert_eq!(row.title_source, None);
        }
        let json = serde_json::to_value(rows(&archive, &batch).0).unwrap();
        assert_eq!(json["display_title"], serde_json::Value::Null);
        assert_eq!(json["title_source"], serde_json::Value::Null);
    }

    #[test]
    fn rows_carry_the_activity_span_and_never_an_end() {
        let (archive, batch) = synth_custom(
            Some("t"),
            vec![
                ("user", Some(T0 + 5000), vec![utext("a")]),
                ("assistant", Some(T0 + 1000), vec![utext("b")]),
                ("assistant", None, vec![utext("c")]),
                ("user", Some(T0 + 9000), vec![utext("d")]),
            ],
        );
        let (listed, got) = rows(&archive, &batch);
        for row in [listed, got] {
            assert_eq!(row.first_activity_at, Some(T0 + 1000));
            assert_eq!(row.last_activity_at, Some(T0 + 9000));
            assert_eq!(row.ended_at, None, "activity is not an end");
        }
    }

    #[test]
    fn unknown_message_times_leave_the_activity_span_null() {
        let (archive, batch) = synth_custom(Some("t"), vec![("user", None, vec![utext("a")])]);
        let json = serde_json::to_value(rows(&archive, &batch).0).unwrap();
        assert_eq!(json["first_activity_at"], serde_json::Value::Null);
        assert_eq!(json["last_activity_at"], serde_json::Value::Null);
    }

    #[test]
    fn derive_display_title_picks_the_shorter_of_sentence_and_line() {
        let d = derive_display_title;
        assert_eq!(d("Fix the bug. Then deploy it.").as_deref(), Some("Fix the bug."));
        assert_eq!(d("Refactor the parser\nso that it handles tabs. More.").as_deref(), Some("Refactor the parser"));
        assert_eq!(d("Why is it slow? Profile it.").as_deref(), Some("Why is it slow?"));
        assert_eq!(d("Open main.rs and read it").as_deref(), Some("Open main.rs and read it"), "a dot inside a name ends nothing");
    }

    #[test]
    fn derive_display_title_collapses_whitespace_and_skips_blank_text() {
        let d = derive_display_title;
        assert_eq!(d("  \n  Add   retry\t logic  \n second line").as_deref(), Some("Add retry logic"));
        assert_eq!(d(""), None);
        assert_eq!(d(" \n\t "), None);
    }

    #[test]
    fn derive_display_title_cuts_long_text_at_a_word_boundary() {
        let words: Vec<String> = (1..=40).map(|i| format!("word{i}")).collect();
        let long = words.join(" ");
        let got = derive_display_title(&long).unwrap();
        assert!(got.chars().count() <= 70, "{} chars: {got}", got.chars().count());
        let head = got.strip_suffix("...").expect("a cut title ends with a plain ...");
        assert!(!head.ends_with(' '), "no space before the ellipsis: {got:?}");
        assert!(long.starts_with(head), "the kept part is a prefix");
        let next = long[head.len()..].chars().next().unwrap();
        assert_eq!(next, ' ', "cut on a word boundary, not inside a word");
        assert!(!got.contains('\u{2026}'), "plain three dots");
        // Exactly at the limit is not cut.
        let exact = "a".repeat(70);
        assert_eq!(derive_display_title(&exact).as_deref(), Some(exact.as_str()));
        // One long token has no boundary: a hard cut that still fits.
        let token = derive_display_title(&"x".repeat(200)).unwrap();
        assert!(token.chars().count() <= 70 && token.ends_with("..."), "{token}");
        // Characters, not bytes: non-BMP text is not split in the middle.
        let emoji = derive_display_title(&"\u{1F600} ".repeat(60)).unwrap();
        assert!(emoji.chars().count() <= 70 && emoji.ends_with("..."), "{emoji}");
    }

    // ---------- readable tool hits ----------

    fn tool_call(name: &str, input: serde_json::Value) -> CB {
        CB::ToolCall { call_id: "call-1".into(), native_id: None, name: name.into(), input, files: vec![] }
    }

    fn tool_result(output: serde_json::Value) -> CB {
        CB::ToolResult { call_id: "call-1".into(), output, is_error: None }
    }

    /// Search a one-message archive whose only block is `block`.
    fn one_hit(block: CB, query: &str) -> SearchHit {
        let (archive, _) = synth_custom(Some("t"), vec![("assistant", Some(T0 + 1000), vec![block])]);
        let page = search_core(&archive, &search_input(query, None, None)).unwrap();
        assert_eq!(page.items.len(), 1, "{query}");
        page.items[0].clone()
    }

    #[test]
    fn bash_tool_call_hit_reads_as_a_command_line() {
        let hit = one_hit(
            tool_call(
                "Bash",
                serde_json::json!({"command": "cargo test --lib ratelimit", "description": "Rerun the rate limiter tests"}),
            ),
            "ratelimit",
        );
        assert_eq!(hit.kind, HitKind::Tool);
        assert_eq!(hit.text, "Bash: cargo test --lib ratelimit (Rerun the rate limiter tests)");
        assert!(!hit.text.contains('\\') && !hit.text.contains('{') && !hit.text.contains('}'), "{:?}", hit.text);
        assert_eq!(hit.highlights.len(), 1);
        assert_eq!(utf16_slice(&hit.text, hit.highlights[0]), "ratelimit");
    }

    #[test]
    fn tool_call_main_value_follows_the_folio_key_preference() {
        let hit = one_hit(
            tool_call("Read", serde_json::json!({"description": "look", "pattern": "zzz", "path": "/a/b.rs", "query": "q"})),
            "zzz",
        );
        assert_eq!(hit.text, "Read: /a/b.rs (look)", "path beats pattern and query");
        // The query term is not in the rendered text, so there is nothing to highlight.
        assert!(hit.highlights.is_empty());
    }

    #[test]
    fn tool_call_without_a_main_key_shows_compact_key_value_pairs() {
        let hit = one_hit(
            tool_call("Task", serde_json::json!({"depth": 3, "prompt": "do  the\nthing needlepair", "subagent": "x"})),
            "needlepair",
        );
        assert_eq!(hit.text, "Task: depth: 3, prompt: do the thing needlepair, subagent: x");
        assert_eq!(utf16_slice(&hit.text, hit.highlights[0]), "needlepair");
    }

    #[test]
    fn tool_call_values_are_unescaped_and_whitespace_collapsed() {
        let hit = one_hit(
            tool_call("Bash", serde_json::json!({"command": "echo \"quoted\"\n  && ls\t needleesc"})),
            "needleesc",
        );
        assert_eq!(hit.text, "Bash: echo \"quoted\" && ls needleesc");
    }

    #[test]
    fn tool_result_hit_shows_the_unescaped_output_text() {
        let hit = one_hit(tool_result(serde_json::json!("line one\nline two with needletool\n  \"quoted\"")), "needletool");
        assert_eq!(hit.kind, HitKind::Tool);
        assert_eq!(hit.text, "line one line two with needletool \"quoted\"");
        assert_eq!(utf16_slice(&hit.text, hit.highlights[0]), "needletool");
    }

    #[test]
    fn tool_result_json_output_is_compact_and_unescaped() {
        let hit = one_hit(tool_result(serde_json::json!({"stdout": "ok needlejson \"x\"\nnext", "code": 0})), "needlejson");
        assert!(!hit.text.contains('\\'), "no escape sequences: {:?}", hit.text);
        assert!(!hit.text.contains('\n'));
        assert!(hit.text.contains("ok needlejson \"x\" next"), "{:?}", hit.text);
        assert_eq!(utf16_slice(&hit.text, hit.highlights[0]), "needlejson");
    }

    #[test]
    fn tool_hit_ranges_are_utf16_after_non_bmp_characters() {
        let hit = one_hit(tool_call("Bash", serde_json::json!({"command": "echo \u{1F600}\u{1F600} then marker here"})), "marker");
        assert_eq!(hit.text, "Bash: echo \u{1F600}\u{1F600} then marker here");
        assert_eq!(hit.highlights.len(), 1);
        assert_eq!(utf16_slice(&hit.text, hit.highlights[0]), "marker");
        let char_start = hit.text.find("marker").map(|b| hit.text[..b].chars().count()).unwrap() as u32;
        assert_eq!(hit.highlights[0][0], char_start + 2, "two surrogate pairs shift the UTF-16 offset");
    }

    #[test]
    fn tool_hit_highlights_every_case_insensitive_occurrence_of_each_term() {
        let hit = one_hit(
            tool_call("Bash", serde_json::json!({"command": "Needle then NEEDLE then needle and other"})),
            "needle other",
        );
        let marked: Vec<String> = hit.highlights.iter().map(|r| utf16_slice(&hit.text, *r)).collect();
        assert_eq!(marked, vec!["Needle", "NEEDLE", "needle", "other"]);
    }

    #[test]
    fn long_tool_hit_is_cut_to_a_window_around_the_first_match() {
        let filler = "lorem ipsum dolor sit amet ".repeat(30);
        let hit = one_hit(tool_result(serde_json::json!(format!("{filler}needlewin {filler}"))), "needlewin");
        assert!(hit.text.starts_with(" ... ") && hit.text.ends_with(" ... "), "{:?}", hit.text);
        let n = hit.text.chars().count();
        assert!((150..=190).contains(&n), "about 160 characters plus the edges, got {n}");
        assert_eq!(hit.highlights.len(), 1);
        assert_eq!(utf16_slice(&hit.text, hit.highlights[0]), "needlewin");
    }

    #[test]
    fn match_near_the_start_is_cut_only_at_the_end() {
        let filler = "lorem ipsum dolor sit amet ".repeat(30);
        let hit = one_hit(tool_result(serde_json::json!(format!("needlestart {filler}"))), "needlestart");
        assert!(hit.text.starts_with("needlestart"), "{:?}", hit.text);
        assert!(hit.text.ends_with(" ... "));
        assert_eq!(hit.highlights, vec![[0, 11]]);
    }

    #[test]
    fn text_hits_keep_the_fts_snippet_path() {
        let (archive, _) = synth(&["plain words around needletext and more"]);
        let page = search_core(&archive, &search_input("needletext", None, None)).unwrap();
        assert_eq!(page.items[0].kind, HitKind::Message);
        assert_eq!(utf16_slice(&page.items[0].text, page.items[0].highlights[0]), "needletext");
    }

    // ---------- messages_page ----------

    fn seven() -> (Arc<Archive>, ImportBatch) {
        synth(&["m1", "m2", "m3", "m4", "m5", "m6", "m7"])
    }

    #[test]
    fn messages_page_returns_messages_ordered_by_seq_with_total() {
        let (archive, batch) = seven();
        let id = &batch.sessions[0].session.id;
        let page = messages_page_core(&archive, id, None, None).unwrap();
        assert_eq!((page.total, page.limit, page.offset), (7, 100, 0));
        let seqs: Vec<u32> = page.items.iter().map(|m| m.seq).collect();
        assert_eq!(seqs, vec![1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(page.items, batch.sessions[0].messages, "contract Message, blocks ordered");
    }

    #[test]
    fn messages_page_paging_covers_every_message_once_in_order() {
        let (archive, batch) = seven();
        let id = &batch.sessions[0].session.id;
        let mut seen = Vec::new();
        let mut offset = 0u32;
        loop {
            let page = messages_page_core(&archive, id, Some(3), Some(offset)).unwrap();
            assert_eq!(page.total, 7);
            assert_eq!(page.offset, offset);
            if page.items.is_empty() {
                break;
            }
            seen.extend(page.items.iter().map(|m| m.seq));
            offset += page.items.len() as u32;
        }
        assert_eq!(seen, vec![1, 2, 3, 4, 5, 6, 7]);
        let tail = messages_page_core(&archive, id, Some(3), Some(6)).unwrap();
        assert_eq!(tail.items.len(), 1);
    }

    #[test]
    fn messages_page_rejects_bad_input_and_unknown_sessions() {
        let (archive, batch) = seven();
        let id = &batch.sessions[0].session.id;
        for bad_id in ["", "zz not hex", "../etc"] {
            let err = messages_page_core(&archive, bad_id, None, None).unwrap_err();
            assert_eq!(err.code, "invalid_input", "id {bad_id:?}");
        }
        let err = messages_page_core(&archive, "0000000000000000", None, None).unwrap_err();
        assert_eq!(err.code, "not_found");
        for bad in [0u32, 201] {
            let err = messages_page_core(&archive, id, Some(bad), None).unwrap_err();
            assert_eq!(err.code, "invalid_input", "limit {bad}");
        }
        assert!(messages_page_core(&archive, id, Some(200), None).is_ok());
        assert!(messages_page_core(&archive, id, Some(1), None).is_ok());
    }

    #[test]
    fn session_get_returns_the_contract_session_only() {
        let (archive, batch) = seven();
        let id = &batch.sessions[0].session.id;
        let session = session_get_core(&archive, id).unwrap();
        let expected = &batch.sessions[0].session;
        assert_eq!(session.id, expected.id);
        assert_eq!(session.title, expected.title);
        assert_eq!(session.project_root, expected.project_root);
        assert_eq!(session.agent_id, expected.agent_id);
        let json = serde_json::to_value(&session).unwrap();
        assert!(json.get("messages").is_none(), "messages come from messages_page");
    }

    /// R-1 (r2 fix round 2): an Import now that a stop ends says so in plain words.
    #[test]
    fn a_stopped_import_now_says_import_stopped() {
        let e = import_now_error(crate::importer::IMPORT_CANCELLED.to_string());
        assert_eq!((e.code.as_str(), e.message.as_str()), ("import_failed", "Import stopped"));
        let other = import_now_error("disk full".to_string());
        assert_eq!(other.message, "disk full");
    }

    #[test]
    fn import_now_stops_before_reading_when_cancelled_during_discovery() {
        use crate::archive_api::testkit::{tmp, write_consented};
        let data = tmp();
        let home = tmp();
        write_consented(data.path());
        let staged = staged_targets(home.path());
        let state = CoreState::new(Arc::new(Archive::in_memory().unwrap()), Vec::new());
        let _only_us = crate::importer::cancel_test_write_guard();
        let err = import_now_in(
            data.path(),
            &state,
            || {
                crate::importer::cancel_running_imports();
                staged.clone()
            },
            None,
            &|_| {},
        )
        .unwrap_err();
        assert_eq!((err.code.as_str(), err.message.as_str()), ("import_failed", "Import stopped"));
        assert_eq!(state.archive.stats().unwrap().sessions, 0);
    }

    // ---------- import_diagnostics ----------

    #[test]
    fn import_diagnostics_validates_source_key() {
        let (archive, _) = seven();
        let good = "a".repeat(64);
        assert!(import_diagnostics_core(&archive, Some(&good)).unwrap().is_empty());
        for bad in [
            "".to_string(),
            "abc".to_string(),
            "A".repeat(64),
            "g".repeat(64),
            "a".repeat(63),
            "a".repeat(65),
        ] {
            let err = import_diagnostics_core(&archive, Some(&bad)).unwrap_err();
            assert_eq!(err.code, "invalid_input", "key {bad:?}");
        }
    }

    #[test]
    fn import_diagnostics_none_returns_recent_newest_first() {
        let (archive, _) = seven();
        assert!(import_diagnostics_core(&archive, None).unwrap().is_empty());
        let mut bad = synth(&["x"]).1;
        bad.sessions[0].session.native_id = Some(String::new());
        bad.source.store = StoreIdentity::new("test-history", "fixture://test", "bad-profile");
        assert!(archive.import_batch(&bad).is_err());
        let recent = import_diagnostics_core(&archive, None).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].source_key, bad.source.key());
        let by_key = import_diagnostics_core(&archive, Some(&bad.source.key())).unwrap();
        assert_eq!(by_key, recent);
    }
}
