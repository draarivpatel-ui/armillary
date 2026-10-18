//! First-run backend: the consent plaque's plan, the consent file, and the scan that streams
//! `firstrun:*` events to the UI. The payload shapes mirror ui/firstrun/src/events.ts exactly.
//!

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;

use orrery_adapters::env::{Environment, FileSystem, SystemEnvironment};
use orrery_adapters::{detect_agent, AdapterDef};
use orrery_archive::Archive;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tauri::Manager;

use crate::archive_api::{self, SessionQuery};
use crate::importer::{self, BatchProgress, Importer};

// ---------------------------------------------------------------------------------------------
// Payload types (serde camelCase, identical to events.ts)

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueEntry {
    pub id: String,
    pub name: String,
    pub vendor: String,
    /// Normalised family key (agents::normalize_family).
    pub family: String,
    /// Raw registry kind string.
    pub kind: String,
    /// True when the adapter has history sources.
    pub history: bool,
    /// This agent's own folders on this OS (home shown as "~"), sorted, deduplicated.
    pub folders: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstRunPlan {
    pub platform: String,
    pub entries: Vec<CatalogueEntry>,
    pub folders: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CataloguePayload {
    pub platform: String,
    pub entries: Vec<CatalogueEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPayload {
    pub id: String,
    pub found: bool,
    pub version: Option<String>,
    pub folders: Vec<String>,
    pub history: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPayload {
    pub agent_id: String,
    /// "started" | "progress" | "finished" | "error"
    pub phase: String,
    pub sessions_imported: u32,
    pub sessions_known: u32,
    pub error: Option<String>,
    pub projects: Vec<String>,
}

/// One agent's share of a project: its session count there.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstellationMember {
    pub agent_id: String,
    pub sessions: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Constellation {
    pub name: String,
    pub root: String,
    pub agents: Vec<String>,
    /// Per-agent session counts, sorted by sessions desc then agent id asc.
    pub members: Vec<ConstellationMember>,
    pub sessions: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DonePayload {
    pub constellations: Vec<Constellation>,
    pub live_sessions: u32,
    pub sessions_imported: u32,
    pub agents_found: u32,
    pub catalogue_size: u32,
    pub errors: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstRunStatus {
    pub consented: bool,
    pub completed: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FirstRunEvent {
    Catalogue(CataloguePayload),
    Agent(AgentPayload),
    Import(ImportPayload),
    Done(DonePayload),
}

impl FirstRunEvent {
    pub fn name(&self) -> &'static str {
        match self {
            FirstRunEvent::Catalogue(_) => "firstrun:catalogue",
            FirstRunEvent::Agent(_) => "firstrun:agent",
            FirstRunEvent::Import(_) => "firstrun:import",
            FirstRunEvent::Done(_) => "firstrun:done",
        }
    }

    pub fn payload_json(&self) -> serde_json::Value {
        let v = match self {
            FirstRunEvent::Catalogue(p) => serde_json::to_value(p),
            FirstRunEvent::Agent(p) => serde_json::to_value(p),
            FirstRunEvent::Import(p) => serde_json::to_value(p),
            FirstRunEvent::Done(p) => serde_json::to_value(p),
        };
        v.unwrap_or(serde_json::Value::Null)
    }
}

// ---------------------------------------------------------------------------------------------
// Path display and redaction

/// Replaces the user's home folder with "~" in any string that might carry a path.
struct Redactor {
    /// Home spellings to hide, longest first so "/private/tmp/x" wins over "/tmp/x".
    homes: Vec<String>,
}

impl Redactor {
    fn new(env: &dyn Environment) -> Self {
        let mut homes: Vec<String> = Vec::new();
        if let Some(home) = env.home_dir() {
            let raw = home.to_string_lossy().to_string();
            if let Ok(canon) = std::fs::canonicalize(&home) {
                homes.push(canon.to_string_lossy().to_string());
            }
            homes.push(raw);
        }
        homes.retain(|h| h.len() > 1);
        homes.sort_by(|a, b| b.len().cmp(&a.len()).then(a.cmp(b)));
        homes.dedup();
        Self { homes }
    }

    fn apply(&self, text: &str) -> String {
        let mut out = text.to_string();
        for home in &self.homes {
            out = out.replace(home.as_str(), "~");
        }
        out
    }

    fn path(&self, path: &Path) -> String {
        self.apply(&path.to_string_lossy())
    }
}

/// Registry pattern to display form: on Windows %USERPROFILE% shows as "~"; other variables
/// and relative patterns stay exactly as written.
fn display_pattern(pattern: &str) -> String {
    pattern.replace("%USERPROFILE%", "~")
}

/// The directory to show for a history source pattern: everything before the first glob
/// character, trimmed back to a whole folder. A bare relative file name is shown as written.
fn history_base(pattern: &str) -> Option<String> {
    let prefix = pattern.split(['*', '?', '[']).next().unwrap_or(pattern);
    if prefix.is_empty() {
        return None;
    }
    let base = if prefix.ends_with('/') || prefix.ends_with('\\') {
        prefix.trim_end_matches(['/', '\\'])
    } else if let Some(i) = prefix.rfind(['/', '\\']) {
        prefix[..i].trim_end_matches(['/', '\\'])
    } else {
        prefix
    };
    if base.is_empty() {
        None
    } else {
        Some(base.to_string())
    }
}

fn sorted_adapters() -> Vec<AdapterDef> {
    let mut adapters = orrery_adapters::builtin_adapters();
    adapters.sort_by(|a, b| a.id.cmp(&b.id));
    adapters
}

/// Home-relative, absolute or env-var rooted. Patterns relative to wherever the app started
/// (".aider.chat.history.md", "./.crush") say nothing about where the data lives, so they are dropped.
fn is_anchored(folder: &str) -> bool {
    folder.starts_with(['~', '$', '%', '/']) && !folder.starts_with("./")
}

/// One agent's own folders on this OS: detection data folders plus the base directory of every
/// history source pattern, displayed with the home as "~", sorted and deduplicated.
fn adapter_folders(adapter: &AdapterDef, os_key: &str) -> Vec<String> {
    let mut folders: BTreeSet<String> = BTreeSet::new();
    let detection_paths = adapter
        .detection
        .paths
        .get(os_key)
        .or_else(|| adapter.detection.paths.get("default"));
    if let Some(paths) = detection_paths {
        for folder in &paths.data_folders {
            folders.insert(display_pattern(folder));
        }
    }
    for source in &adapter.history_sources {
        let patterns = source.paths.get(os_key).or_else(|| source.paths.get("default"));
        for pattern in patterns.into_iter().flatten() {
            if let Some(base) = history_base(pattern) {
                folders.insert(display_pattern(&base));
            }
        }
    }
    folders.into_iter().filter(|f| is_anchored(f)).collect()
}

fn catalogue_entries(adapters: &[AdapterDef], os_key: &str) -> Vec<CatalogueEntry> {
    adapters
        .iter()
        .map(|a| CatalogueEntry {
            id: a.id.clone(),
            name: a.name.clone(),
            vendor: a.vendor.clone(),
            family: crate::agents::normalize_family(&a.family),
            kind: a.kind.clone(),
            history: !a.history_sources.is_empty(),
            folders: adapter_folders(a, os_key),
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Pure cores

/// Registry only, no filesystem access (the signature has no FileSystem to touch).
pub fn plan_core(env: &dyn Environment) -> FirstRunPlan {
    let os_key = env.os().as_str();
    let adapters = sorted_adapters();
    let entries = catalogue_entries(&adapters, os_key);
    let folders: BTreeSet<String> = entries.iter().flat_map(|e| e.folders.iter().cloned()).collect();
    FirstRunPlan { platform: os_key.to_string(), entries, folders: folders.into_iter().collect() }
}

/// Every session in the archive (optionally one agent's), read in pages of 200.
fn all_sessions(archive: &Archive, agent: Option<&str>) -> Result<Vec<armillary_model::Session>, String> {
    let mut sessions = Vec::new();
    let mut offset = 0u32;
    loop {
        let query = SessionQuery {
            agent: agent.map(str::to_string),
            limit: Some(200),
            offset: Some(offset),
            ..Default::default()
        };
        let page = archive_api::sessions_query_core(archive, &query).map_err(|e| e.to_string())?;
        let got = page.items.len() as u32;
        sessions.extend(page.items.into_iter().map(|row| row.session));
        offset += got;
        if got == 0 || u64::from(offset) >= page.total {
            break;
        }
    }
    Ok(sessions)
}

fn basename(root: &str) -> String {
    let trimmed = root.trim_end_matches(['/', '\\']);
    match trimmed.rsplit(['/', '\\']).next() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => root.to_string(),
    }
}

fn constellations(sessions: &[armillary_model::Session]) -> Vec<Constellation> {
    let mut by_root: BTreeMap<&str, BTreeMap<&str, u32>> = BTreeMap::new();
    for s in sessions {
        if let Some(root) = s.project_root.as_deref() {
            *by_root.entry(root).or_default().entry(s.agent_id.as_str()).or_default() += 1;
        }
    }
    let mut out: Vec<Constellation> = by_root
        .into_iter()
        .map(|(root, per_agent)| {
            let mut members: Vec<ConstellationMember> = per_agent
                .into_iter()
                .map(|(agent, sessions)| ConstellationMember { agent_id: agent.to_string(), sessions })
                .collect();
            let total = members.iter().map(|m| m.sessions).sum();
            let agents: Vec<String> = members.iter().map(|m| m.agent_id.clone()).collect(); // BTreeMap order: sorted
            members.sort_by(|a, b| b.sessions.cmp(&a.sessions).then_with(|| a.agent_id.cmp(&b.agent_id)));
            Constellation { name: basename(root), root: root.to_string(), agents, members, sessions: total }
        })
        .collect();
    out.sort_by(|a, b| b.sessions.cmp(&a.sessions).then_with(|| a.name.cmp(&b.name)).then_with(|| a.root.cmp(&b.root)));
    out
}

/// Whether an observed batch deserves a `progress` event. `last` is the (known, imported) pair of
/// the last emitted progress event, (0, 0) after "started". Deterministic: no clocks. Large
/// histories produce about 40 events per agent instead of one per file.
fn progress_due(has_error: bool, known: u32, imported: u32, last: (u32, u32)) -> bool {
    if has_error || known != last.0 {
        return true;
    }
    if imported >= known && imported > last.1 {
        return true;
    }
    imported >= last.1.saturating_add((known / 40).max(1)) && imported > last.1
}

/// Detect, import and summarise. Emits catalogue, one agent event per registry entry, the
/// import events per found agent, then exactly one done event.
pub fn scan_core(
    env: &dyn Environment,
    fs: &dyn FileSystem,
    archive: Arc<Archive>,
    live_sessions: u32,
    emit: &dyn Fn(FirstRunEvent),
) -> Result<DonePayload, String> {
    let importer = Importer::new(archive.clone());
    scan_core_with_importer(env, fs, archive, importer, live_sessions, emit)
}

pub(crate) fn scan_core_with_epoch(
    env: &dyn Environment,
    fs: &dyn FileSystem,
    archive: Arc<Archive>,
    epoch: u64,
    live_sessions: u32,
    emit: &dyn Fn(FirstRunEvent),
) -> Result<DonePayload, String> {
    let importer = Importer::with_epoch(archive.clone(), epoch);
    scan_core_with_importer(env, fs, archive, importer, live_sessions, emit)
}

fn scan_core_with_importer(
    env: &dyn Environment,
    fs: &dyn FileSystem,
    archive: Arc<Archive>,
    importer: Importer,
    live_sessions: u32,
    emit: &dyn Fn(FirstRunEvent),
) -> Result<DonePayload, String> {
    let redact = Redactor::new(env);
    let adapters = sorted_adapters();
    let entries = catalogue_entries(&adapters, env.os().as_str());

    emit(FirstRunEvent::Catalogue(CataloguePayload {
        platform: env.os().as_str().to_string(),
        entries: entries.clone(),
    }));

    // Detection is passive. A target exists when the agent is installed or has a data folder.
    let targets = if importer.is_cancelled() { Vec::new() } else { importer::discover_targets(env, fs) };
    let mut found: Vec<bool> = Vec::with_capacity(adapters.len());
    for (adapter, entry) in adapters.iter().zip(&entries) {
        if importer.is_cancelled() {
            found.push(false);
            continue;
        }
        let detection = detect_agent(adapter, env, fs);
        let target = targets.iter().find(|t| t.adapter.id == adapter.id);
        let is_found = detection.installed || target.is_some_and(|t| !t.data_dirs.is_empty());
        let dirs: &[std::path::PathBuf] = match target {
            Some(t) if !t.data_dirs.is_empty() => &t.data_dirs,
            _ => &detection.data_paths,
        };
        emit(FirstRunEvent::Agent(AgentPayload {
            id: adapter.id.clone(),
            found: is_found,
            version: detection.version.clone(),
            folders: dirs.iter().map(|p| redact.path(p)).collect(),
            history: entry.history,
        }));
        found.push(is_found);
    }
    let agents_found = found.iter().filter(|f| **f).count() as u32;

    let import_event = |agent_id: &str, phase: &str, imported: u32, known: u32, error: Option<String>, projects: Vec<String>| {
        emit(FirstRunEvent::Import(ImportPayload {
            agent_id: agent_id.to_string(),
            phase: phase.to_string(),
            sessions_imported: imported,
            sessions_known: known,
            error,
            projects,
        }));
    };

    let mut sessions_imported = 0u32;
    let mut errors = 0u32;
    for (adapter, is_found) in adapters.iter().zip(&found) {
        if !is_found {
            continue;
        }
        let Some(_) = targets.iter().find(|t| t.adapter.id == adapter.id) else {
            continue;
        };
        let id = adapter.id.as_str();
        import_event(id, "started", 0, 0, None, Vec::new());

        let last = RefCell::new((0u32, 0u32));
        let last_emitted = RefCell::new((0u32, 0u32)); // reset to (0, 0) by "started"
        let first_error: RefCell<Option<String>> = RefCell::new(None);
        let observer = |b: BatchProgress| {
            let error = b.error.as_deref().map(|e| redact.apply(e));
            if first_error.borrow().is_none() {
                *first_error.borrow_mut() = error.clone();
            }
            *last.borrow_mut() = (b.sessions_imported, b.sessions_known);
            let due = progress_due(
                error.is_some(),
                b.sessions_known,
                b.sessions_imported,
                *last_emitted.borrow(),
            );
            if !due {
                return;
            }
            *last_emitted.borrow_mut() = (b.sessions_known, b.sessions_imported);
            import_event(id, "progress", b.sessions_imported, b.sessions_known, error, Vec::new());
        };
        let outcome = importer.run_observed(&targets, Some(id), env, &|_| {}, &observer);
        match outcome {
            Ok(summary) => {
                let known = last.borrow().1.max(summary.sessions);
                let mut projects: Vec<String> = all_sessions(&archive, Some(id))?
                    .iter()
                    .filter_map(|s| s.project_root.as_deref())
                    .map(basename)
                    .collect();
                projects.sort();
                projects.dedup();
                let error = first_error.borrow().clone();
                if error.is_some() {
                    errors += 1;
                }
                sessions_imported += summary.sessions;
                import_event(id, "finished", summary.sessions, known, error, projects);
            }
            Err(e) => {
                errors += 1;
                let (imported, known) = *last.borrow();
                if importer.is_cancelled() {
                    // A stop ends the whole scan: no further agent is read (R-1).
                    import_event(id, "error", imported, known, Some("Import stopped".to_string()), Vec::new());
                    break;
                }
                import_event(id, "error", imported, known, Some(redact.apply(&e)), Vec::new());
            }
        }
    }

    let constellations = constellations(&all_sessions(&archive, None)?);
    let done = DonePayload {
        constellations,
        live_sessions,
        sessions_imported,
        agents_found,
        catalogue_size: entries.len() as u32,
        errors,
    };
    emit(FirstRunEvent::Done(done.clone()));
    Ok(done)
}

/// Consent-gated entry used by the command: nothing is read or emitted without recorded consent.
pub fn scan_if_consented(
    data_dir: &Path,
    env: &dyn Environment,
    fs: &dyn FileSystem,
    archive: Arc<Archive>,
    live_sessions: u32,
    emit: &dyn Fn(FirstRunEvent),
) -> Result<DonePayload, String> {
    if !consent_recorded(data_dir) {
        return Err("consent not recorded".to_string());
    }
    scan_core(env, fs, archive, live_sessions, emit)
}

// ---------------------------------------------------------------------------------------------
// Consent persistence: <data_dir>/firstrun.json, written atomically with mode 0600.

use crate::archive_api::consent::{ConsentFile, CONSENT_FILE};

fn status_of(state: &ConsentFile) -> FirstRunStatus {
    FirstRunStatus { consented: state.consented_at.is_some(), completed: state.completed_at.is_some() }
}

/// A missing or corrupt file is the default state. Never panics. One reader: archive_api::consent.
fn read_consent(data_dir: &Path) -> ConsentFile {
    crate::archive_api::consent::read(data_dir)
}

fn write_consent(data_dir: &Path, state: &ConsentFile) -> Result<(), String> {
    use std::io::Write;
    std::fs::create_dir_all(data_dir).map_err(|e| format!("could not create the data folder: {e}"))?;
    let tmp = data_dir.join("firstrun.json.tmp");
    let target = data_dir.join(CONSENT_FILE);
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&tmp);
    let result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, &target)?;
        #[cfg(unix)]
        {
            if let Ok(dir) = std::fs::File::open(data_dir) {
                let _ = dir.sync_all();
            }
        }
        Ok(())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("could not save the first-run state: {e}"));
    }
    Ok(())
}

pub fn status_in(data_dir: &Path) -> FirstRunStatus {
    status_of(&read_consent(data_dir))
}

/// Accepting records consent. Declining ("Not now") records the decline, marks the first run
/// completed so the app opens with an empty archive, and withdraws any earlier consent.
pub fn record_consent_in(data_dir: &Path, accepted: bool, now_ms: i64) -> Result<FirstRunStatus, String> {
    let mut state = read_consent(data_dir);
    if accepted {
        state.consented_at = Some(now_ms);
        state.declined_at = None;
    } else {
        state.consented_at = None;
        state.declined_at = Some(now_ms);
        state.completed_at = Some(now_ms);
    }
    write_consent(data_dir, &state)?;
    Ok(status_of(&state))
}

pub fn mark_completed_in(data_dir: &Path, now_ms: i64) -> Result<FirstRunStatus, String> {
    let mut state = read_consent(data_dir);
    state.completed_at = Some(now_ms);
    write_consent(data_dir, &state)?;
    Ok(status_of(&state))
}

/// Replay: forget completion only. Consent stays.
pub fn reset_for_replay_in(data_dir: &Path) -> Result<FirstRunStatus, String> {
    let mut state = read_consent(data_dir);
    state.completed_at = None;
    write_consent(data_dir, &state)?;
    Ok(status_of(&state))
}

/// Another stream gates its launch-time import on this exact name.
pub fn consent_recorded(data_dir: &Path) -> bool {
    status_in(data_dir).consented
}

// ---------------------------------------------------------------------------------------------
// FPS logging helpers

const FPS_ENV: &str = "ARMILLARY_FPS_LOG";
const FPS_MAX_LINE: usize = 400;

/// Where FPS lines go for a given ARMILLARY_FPS_LOG value.
#[derive(Debug, Clone, PartialEq, Eq)]
enum FpsSink {
    Off,
    StdoutOnly,
    StdoutAndFile(String),
}

fn fps_sink(value: Option<&str>) -> FpsSink {
    match value {
        None | Some("") => FpsSink::Off,
        Some("1") => FpsSink::StdoutOnly,
        Some(path) => FpsSink::StdoutAndFile(path.to_string()),
    }
}

/// One log line: single line, capped length, prefixed.
fn fps_line(line: &str) -> String {
    let flat: String = line
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(FPS_MAX_LINE)
        .collect();
    format!("[armillary-fps] {flat}")
}

pub fn fps_log_enabled() -> bool {
    fps_sink(std::env::var(FPS_ENV).ok().as_deref()) != FpsSink::Off
}

pub fn fps_report_line(line: &str) {
    let sink = fps_sink(std::env::var(FPS_ENV).ok().as_deref());
    if sink == FpsSink::Off {
        return;
    }
    let text = fps_line(line);
    println!("{text}");
    if let FpsSink::StdoutAndFile(path) = sink {
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{text}");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Tauri commands (thin wrappers)

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn firstrun_status(app: tauri::AppHandle) -> Result<FirstRunStatus, String> {
    Ok(status_in(&app_data_dir(&app)?))
}

#[tauri::command]
pub fn firstrun_plan() -> FirstRunPlan {
    plan_core(&SystemEnvironment)
}

#[tauri::command]
pub fn firstrun_consent(app: tauri::AppHandle, accepted: bool) -> Result<FirstRunStatus, String> {
    let status = record_consent_in(&app_data_dir(&app)?, accepted, now_ms())?;
    if !accepted {
        // Withdrawing consent (Not now, also on a Replay) stops the watcher, the live detector and
        // any running import at once; nothing reads the agent folders after this.
        crate::launch::stop_background_services(&app);
    }
    Ok(status)
}

#[tauri::command]
pub async fn firstrun_scan(
    app: tauri::AppHandle,
    state: tauri::State<'_, archive_api::CoreState>,
) -> Result<DonePayload, String> {
    let epoch = importer::current_epoch();
    let data_dir = app_data_dir(&app)?;
    if !consent_recorded(&data_dir) {
        return Err("consent not recorded".to_string());
    }
    let archive = state.archive.clone();
    let live_sessions = crate::live::live_list_from(crate::live::get_global_detector())
        .map(|list| {
            list.iter()
                .filter(|l| l.state != crate::live::LiveState::Done)
                .count() as u32
        })
        .unwrap_or(0);
    let emitter = app.clone();
    let (done, targets) = tauri::async_runtime::spawn_blocking(move || {
        // Detection and discovery honour ARMILLARY_DETECT_SCOPE=home (captures and tests never see
        // this machine's installed apps or PATH outside the temporary HOME).
        let (env, fs) = crate::archive_api::scope::detection_env();
        if !consent_recorded(&data_dir) {
            return Err("consent not recorded".to_string());
        }
        let done = scan_core_with_epoch(env.as_ref(), fs.as_ref(), archive, epoch, live_sessions, &|ev| {
            let _ = emitter.emit(ev.name(), ev.payload_json());
        })?;
        let discovered = if importer::current_epoch() != epoch {
            Vec::new()
        } else {
            importer::discover_targets(env.as_ref(), fs.as_ref())
        };
        Ok::<_, String>((done, discovered))
    })
    .await
    .map_err(|e| e.to_string())??;
    if importer::current_epoch() == epoch {
        state.set_targets(targets);
    }
    Ok(done)
}

#[tauri::command]
pub fn firstrun_complete(app: tauri::AppHandle) -> Result<FirstRunStatus, String> {
    mark_completed_in(&app_data_dir(&app)?, now_ms())
}

#[tauri::command]
pub fn firstrun_reset(app: tauri::AppHandle) -> Result<FirstRunStatus, String> {
    reset_for_replay_in(&app_data_dir(&app)?)
}

#[tauri::command]
pub fn firstrun_fps_enabled() -> bool {
    fps_log_enabled()
}

#[tauri::command]
pub fn firstrun_fps_report(line: String) {
    fps_report_line(&line)
}

// ---------------------------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;
    use orrery_adapters::env::SystemFileSystem;
    use crate::importer::testutil::{stage_history_adapter_to_home, staged_targets};
    use crate::importer::{BatchProgress, Importer};
    use orrery_adapters::env::{MockEnvironment, TargetOs};
    use orrery_adapters::{builtin_adapters, FileSystem};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    const FAMILIES: [&str; 8] = [
        "anthropic",
        "openai",
        "google",
        "github-microsoft",
        "cursor",
        "open-source-clis",
        "chinese-labs",
        "other",
    ];

    /// A real filesystem that counts every call, so a test can prove nothing was touched.
    struct CountingFs {
        calls: AtomicUsize,
        inner: SystemFileSystem,
    }

    impl CountingFs {
        fn new() -> Self {
            Self { calls: AtomicUsize::new(0), inner: SystemFileSystem }
        }
        fn count(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
        fn hit(&self) {
            self.calls.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl FileSystem for CountingFs {
        fn exists(&self, p: &Path) -> bool {
            self.hit();
            self.inner.exists(p)
        }
        fn is_file(&self, p: &Path) -> bool {
            self.hit();
            self.inner.is_file(p)
        }
        fn is_dir(&self, p: &Path) -> bool {
            self.hit();
            self.inner.is_dir(p)
        }
        fn read_dir(&self, p: &Path) -> Result<Vec<PathBuf>, std::io::Error> {
            self.hit();
            self.inner.read_dir(p)
        }
        fn which(&self, b: &str) -> Option<PathBuf> {
            self.hit();
            self.inner.which(b)
        }
        fn version_of(&self, p: &Path, a: &[String]) -> Option<String> {
            self.hit();
            self.inner.version_of(p, a)
        }
    }

    /// A view of the real filesystem limited to one folder; binaries on PATH are never found.
    struct HomeOnlyFs {
        home: PathBuf,
        inner: SystemFileSystem,
    }

    impl FileSystem for HomeOnlyFs {
        fn exists(&self, p: &Path) -> bool {
            p.starts_with(&self.home) && self.inner.exists(p)
        }
        fn is_file(&self, p: &Path) -> bool {
            p.starts_with(&self.home) && self.inner.is_file(p)
        }
        fn is_dir(&self, p: &Path) -> bool {
            p.starts_with(&self.home) && self.inner.is_dir(p)
        }
        fn read_dir(&self, p: &Path) -> Result<Vec<PathBuf>, std::io::Error> {
            if p.starts_with(&self.home) {
                self.inner.read_dir(p)
            } else {
                Err(std::io::ErrorKind::NotFound.into())
            }
        }
        fn which(&self, _b: &str) -> Option<PathBuf> {
            None
        }
        fn version_of(&self, _p: &Path, _a: &[String]) -> Option<String> {
            None
        }
    }

    /// Stage synthetic fixtures for claude-code, codex-cli, gemini-cli and aider into a temp HOME.
    fn staged_home() -> (tempfile::TempDir, PathBuf, MockEnvironment) {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().canonicalize().unwrap();
        for id in ["claude-code", "codex-cli", "gemini-cli", "aider"] {
            let staged = stage_history_adapter_to_home(&home, id);
            assert!(!staged.is_empty(), "fixture for {id} must stage");
        }
        let env = MockEnvironment::new(TargetOs::current(), home.to_str().unwrap());
        (tmp, home, env)
    }

    /// A malformed session file next to the good claude-code one: its read error must surface.
    fn stage_corrupt_claude_session(home: &Path) {
        let dir = home.join(".claude/projects/broken-project");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("broken.jsonl"), b"{ this is not json\n{\"also\": \n").unwrap();
    }

    fn collect() -> (Mutex<Vec<FirstRunEvent>>,) {
        (Mutex::new(Vec::new()),)
    }

    // 1 ------------------------------------------------------------------------------------

    #[test]
    fn plan_reads_registry_only() {
        // plan_core takes no FileSystem at all, so it cannot touch one; the home below does not
        // exist and must never show up in the output either.
        for os in [TargetOs::Macos, TargetOs::Linux, TargetOs::Windows] {
            let home = if os == TargetOs::Windows { "C:\\Users\\secret-person" } else { "/Users/secret-person" };
            let env = MockEnvironment::new(os, home);
            let plan = plan_core(&env);

            assert_eq!(plan.platform, os.as_str());
            assert_eq!(plan.entries.len(), builtin_adapters().len(), "one entry per builtin");
            assert!(!plan.entries.is_empty());

            let ids: Vec<&str> = plan.entries.iter().map(|e| e.id.as_str()).collect();
            let mut sorted = ids.clone();
            sorted.sort();
            sorted.dedup();
            assert_eq!(ids, sorted, "ids unique and sorted");

            for e in &plan.entries {
                assert!(FAMILIES.contains(&e.family.as_str()), "{} has family {}", e.id, e.family);
                assert!(!e.name.is_empty() && !e.kind.is_empty());
            }
            let claude = plan.entries.iter().find(|e| e.id == "claude-code").expect("claude-code");
            assert_eq!(claude.family, "anthropic");
            assert!(claude.history);

            assert!(!plan.folders.is_empty());
            let mut folders = plan.folders.clone();
            folders.sort();
            folders.dedup();
            assert_eq!(plan.folders, folders, "folders sorted and deduplicated");
            for f in &plan.folders {
                assert!(!f.is_empty());
                assert!(!f.contains("secret-person"), "real home leaked: {f}");
                // Home shows as "~"; $VAR and %VAR% patterns stay as written; cwd-relative ones are excluded.
                assert!(
                    f.starts_with(['~', '$', '%']),
                    "unexpected folder shape on {}: {f}",
                    os.as_str()
                );
                if os == TargetOs::Windows {
                    assert!(!f.contains("%USERPROFILE%"), "windows home must show as ~: {f}");
                }
            }
            // Per-agent folders: home-relative, $VAR or %VAR% only (never cwd-relative), sorted, unique.
            let mut union: Vec<String> = Vec::new();
            for e in &plan.entries {
                let mut sorted = e.folders.clone();
                sorted.sort();
                sorted.dedup();
                assert_eq!(e.folders, sorted, "{} folders sorted and unique", e.id);
                for f in &e.folders {
                    assert!(f.starts_with(['~', '$', '%']) || f.starts_with('/'), "{} has non-absolute folder {f}", e.id);
                    assert!(!f.starts_with("./") && !f.starts_with('.'), "{} has relative folder {f}", e.id);
                    assert!(!f.contains("secret-person"));
                }
                union.extend(e.folders.iter().cloned());
            }
            union.sort();
            union.dedup();
            assert_eq!(plan.folders, union, "flat list is the sorted union of every entry's folders");
            let claude = plan.entries.iter().find(|e| e.id == "claude-code").unwrap();
            let want = if os == TargetOs::Windows { "~\\.claude\\projects" } else { "~/.claude/projects" };
            assert!(claude.folders.iter().any(|f| f == want), "claude-code folders: {:?}", claude.folders);
            assert!(claude.folders.len() >= 2, "detection folders and history bases both count");
            for f in &plan.folders {
                assert!(!f.starts_with('.'), "relative pattern in the flat list: {f}");
            }

            if os == TargetOs::Windows {
                assert!(plan.folders.iter().any(|f| f.starts_with("~\\.claude")));
                assert!(plan.folders.iter().any(|f| f.starts_with("%APPDATA%")), "other %VARS% stay as written");
            } else {
                assert!(plan.folders.iter().any(|f| f == "~/.claude/projects"));
                assert!(plan.folders.iter().any(|f| f.starts_with('$')), "$VAR patterns are kept");
                assert!(!plan.folders.iter().any(|f| f == ".aider.chat.history.md"), "relative patterns are excluded");
            }
        }
    }

    // 2 ------------------------------------------------------------------------------------

    #[test]
    fn scan_refuses_without_consent() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let env = MockEnvironment::new(TargetOs::current(), home.path().to_str().unwrap());
        let fs = CountingFs::new();
        let archive = Arc::new(Archive::in_memory().unwrap());
        let (events,) = collect();

        assert!(!consent_recorded(data.path()));
        let result = scan_if_consented(data.path(), &env, &fs, archive.clone(), 0, &|e| {
            events.lock().unwrap().push(e)
        });
        assert_eq!(result.unwrap_err(), "consent not recorded");
        assert!(events.lock().unwrap().is_empty(), "no events before consent");
        assert_eq!(fs.count(), 0, "no filesystem call before consent");

        // "Not now" is also not consent.
        record_consent_in(data.path(), false, 5).unwrap();
        let again = scan_if_consented(data.path(), &env, &fs, archive, 0, &|e| events.lock().unwrap().push(e));
        assert_eq!(again.unwrap_err(), "consent not recorded");
        assert!(events.lock().unwrap().is_empty());
        assert_eq!(fs.count(), 0);
    }

    // 3 ------------------------------------------------------------------------------------

    #[test]
    fn event_sequence_over_temp_home() {
        let (_tmp, home, env) = staged_home();
        stage_corrupt_claude_session(&home);
        let data = tempfile::tempdir().unwrap();
        record_consent_in(data.path(), true, 1_000).unwrap();
        let archive = Arc::new(Archive::in_memory().unwrap());
        let (events,) = collect();

        let done = scan_if_consented(data.path(), &env, &SystemFileSystem, archive, 3, &|e| {
            events.lock().unwrap().push(e)
        })
        .expect("scan should succeed");
        let events = events.into_inner().unwrap();
        let builtin_count = builtin_adapters().len();

        // First: catalogue.
        let entries = match &events[0] {
            FirstRunEvent::Catalogue(c) => c.entries.clone(),
            other => panic!("first event must be the catalogue, got {}", other.name()),
        };
        assert_eq!(entries.len(), builtin_count);

        // Then exactly one Agent event per entry, in catalogue order.
        let agent_events: Vec<&AgentPayload> = events[1..=entries.len()]
            .iter()
            .map(|e| match e {
                FirstRunEvent::Agent(a) => a,
                other => panic!("expected an agent event, got {}", other.name()),
            })
            .collect();
        for (a, e) in agent_events.iter().zip(&entries) {
            assert_eq!(a.id, e.id);
            assert_eq!(a.history, e.history);
        }
        for id in ["claude-code", "codex-cli", "gemini-cli"] {
            let a = agent_events.iter().find(|a| a.id == id).unwrap();
            assert!(a.found, "{id} is staged and must be found");
            assert!(!a.folders.is_empty(), "{id} reports its data folder");
        }
        for a in &agent_events {
            for f in &a.folders {
                assert!(f.starts_with("~/") || f == "~", "folder must be home-relative: {f}");
            }
        }

        // No payload leaks the temp home.
        let home_str = home.to_string_lossy().to_string();
        for e in &events {
            let json = e.payload_json().to_string();
            assert!(!json.contains(&home_str), "{} leaked the home path: {json}", e.name());
        }

        // Then imports, then exactly one Done, last.
        let rest = &events[entries.len() + 1..];
        let dones = rest.iter().filter(|e| matches!(e, FirstRunEvent::Done(_))).count();
        assert_eq!(dones, 1, "exactly one done event");
        assert!(matches!(rest.last(), Some(FirstRunEvent::Done(_))), "done is last");
        let imports: Vec<&ImportPayload> = rest
            .iter()
            .filter_map(|e| match e {
                FirstRunEvent::Import(p) => Some(p),
                _ => None,
            })
            .collect();
        assert_eq!(rest.len(), imports.len() + 1, "only import events sit between agents and done");

        let found_with_history: Vec<&str> = agent_events
            .iter()
            .filter(|a| a.found && a.history)
            .map(|a| a.id.as_str())
            .collect();
        let mut finished_total = 0u32;
        let mut seen_agents: Vec<&str> = Vec::new();
        for p in &imports {
            assert!(found_with_history.contains(&p.agent_id.as_str()), "import for a not-found agent: {}", p.agent_id);
            if !seen_agents.contains(&p.agent_id.as_str()) {
                seen_agents.push(&p.agent_id);
            }
        }
        for id in &seen_agents {
            let seq: Vec<&&ImportPayload> = imports.iter().filter(|p| p.agent_id == *id).collect();
            assert_eq!(seq.first().unwrap().phase, "started", "{id} starts with started");
            let last = seq.last().unwrap();
            assert!(last.phase == "finished" || last.phase == "error", "{id} ends with finished or error");
            let mut prev = 0;
            for p in &seq {
                assert!(p.sessions_imported >= prev, "{id} sessionsImported must not decrease");
                assert!(p.sessions_known >= p.sessions_imported, "{id} known >= imported");
                prev = p.sessions_imported;
            }
            if last.phase == "finished" {
                finished_total += last.sessions_imported;
            }
        }
        for id in ["claude-code", "codex-cli", "gemini-cli"] {
            let last = imports.iter().rev().find(|p| p.agent_id == id).unwrap_or_else(|| panic!("{id} has import events"));
            assert_eq!(last.phase, "finished", "{id} import finishes");
        }

        // The malformed session file is reported (finished with an error, home hidden), and the
        // good sessions beside it still import.
        let claude_last = imports.iter().rev().find(|p| p.agent_id == "claude-code").unwrap();
        assert_eq!(claude_last.phase, "finished");
        assert!(claude_last.error.is_some(), "corrupt source must be reported: {claude_last:?}");
        assert!(claude_last.sessions_imported >= 1);
        assert!(done.errors >= 1, "the corrupt source counts as an error: {done:?}");

        // Done totals.
        assert_eq!(done.catalogue_size as usize, entries.len());
        assert_eq!(done.agents_found as usize, agent_events.iter().filter(|a| a.found).count());
        assert_eq!(done.sessions_imported, finished_total);
        assert!(done.sessions_imported > 0);
        assert_eq!(done.live_sessions, 3);
        assert!(!done.constellations.is_empty());
        for c in &done.constellations {
            assert!(!c.name.contains('/') && !c.name.contains('\\'), "name must be a basename: {}", c.name);
            assert!(!c.agents.is_empty() && c.sessions > 0);
            for a in &c.agents {
                let found = agent_events.iter().any(|e| &e.id == a && e.found);
                assert!(found, "constellation agent {a} was not found");
            }
        }
        match rest.last() {
            Some(FirstRunEvent::Done(d)) => assert_eq!(d, &done, "emitted done equals returned done"),
            _ => unreachable!(),
        }
        // Members: this agent's share per project.
        for c in &done.constellations {
            assert!(!c.members.is_empty(), "{} has members", c.name);
            assert_eq!(c.members.iter().map(|m| m.sessions).sum::<u32>(), c.sessions, "{} member sum", c.name);
            for m in &c.members {
                assert!(c.agents.contains(&m.agent_id), "member {} missing from agents of {}", m.agent_id, c.name);
                assert!(m.sessions > 0);
            }
            assert_eq!(c.members.len(), c.agents.len());
            for w in c.members.windows(2) {
                assert!(
                    w[0].sessions > w[1].sessions || (w[0].sessions == w[1].sessions && w[0].agent_id < w[1].agent_id),
                    "members out of order in {}: {:?}",
                    c.name,
                    c.members
                );
            }
        }
        let wire = serde_json::to_value(&done.constellations[0]).unwrap();
        assert!(wire["members"][0].get("agentId").is_some() && wire["members"][0].get("sessions").is_some());
        // Sorted by sessions desc, then name asc.
        for w in done.constellations.windows(2) {
            assert!(
                w[0].sessions > w[1].sessions || (w[0].sessions == w[1].sessions && w[0].name <= w[1].name),
                "constellations out of order"
            );
        }
    }

    // 4 ------------------------------------------------------------------------------------

    #[test]
    fn consent_file_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let s = |consented, completed| FirstRunStatus { consented, completed };

        assert_eq!(status_in(d), s(false, false));
        assert!(!consent_recorded(d));
        assert_eq!(record_consent_in(d, true, 100).unwrap(), s(true, false));
        assert!(consent_recorded(d));
        assert_eq!(status_in(d), s(true, false));
        assert_eq!(mark_completed_in(d, 200).unwrap(), s(true, true));
        assert_eq!(reset_for_replay_in(d).unwrap(), s(true, false));
        assert_eq!(status_in(d), s(true, false), "consent survives replay reset");

        let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(d.join("firstrun.json")).unwrap()).unwrap();
        assert_eq!(raw["version"], 1);
        assert_eq!(raw["consentedAt"], 100);
        assert!(raw["completedAt"].is_null());
        assert!(raw["declinedAt"].is_null());
        assert!(!d.join("firstrun.json.tmp").exists(), "no temp file left behind");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(d.join("firstrun.json")).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        // "Not now" on a fresh dir: completed, but not consented.
        let fresh = tempfile::tempdir().unwrap();
        assert_eq!(record_consent_in(fresh.path(), false, 50).unwrap(), s(false, true));
        assert!(!consent_recorded(fresh.path()));
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fresh.path().join("firstrun.json")).unwrap()).unwrap();
        assert_eq!(raw["declinedAt"], 50);
        assert_eq!(raw["completedAt"], 50);
        assert!(raw["consentedAt"].is_null());
        // Saying yes later (replay) clears the decline.
        assert_eq!(record_consent_in(fresh.path(), true, 60).unwrap().consented, true);
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fresh.path().join("firstrun.json")).unwrap()).unwrap();
        assert!(raw["declinedAt"].is_null());
        assert!(!fresh.path().join("firstrun.json.tmp").exists());

        // Corrupt file reads as the default and never panics.
        let bad = tempfile::tempdir().unwrap();
        std::fs::write(bad.path().join("firstrun.json"), b"{ not json ]]").unwrap();
        assert_eq!(status_in(bad.path()), s(false, false));
        assert!(!consent_recorded(bad.path()));
        // And a good write recovers it.
        assert_eq!(record_consent_in(bad.path(), true, 1).unwrap(), s(true, false));
    }

    // 5 ------------------------------------------------------------------------------------

    #[test]
    fn importer_observer_reports_batches() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().canonicalize().unwrap();
        let _ = staged_targets(&home); // claude-code and codex-cli in real layouts
        let env = MockEnvironment::new(TargetOs::current(), home.to_str().unwrap());
        let targets = importer::discover_targets(&env, &SystemFileSystem);
        assert!(targets.iter().any(|t| t.adapter.id == "claude-code"), "claude-code discovered");

        let seen: Mutex<Vec<BatchProgress>> = Mutex::new(Vec::new());
        let archive = Arc::new(Archive::in_memory().unwrap());
        let summary = Importer::new(archive)
            .run_observed(&targets, Some("claude-code"), &env, &|_| {}, &|b| seen.lock().unwrap().push(b))
            .expect("observed run");
        let seen = seen.into_inner().unwrap();

        assert!(!seen.is_empty(), "observer must be called");
        assert!(seen.iter().all(|b| b.agent_id == "claude-code"));
        assert!(seen.iter().any(|b| b.sessions_imported > 0), "some batch reports imported sessions");
        let mut prev_imported = 0;
        let mut prev_known = 0;
        for b in &seen {
            assert!(b.sessions_known >= b.sessions_imported, "known >= imported: {b:?}");
            assert!(b.sessions_imported >= prev_imported && b.sessions_known >= prev_known, "monotonic: {b:?}");
            prev_imported = b.sessions_imported;
            prev_known = b.sessions_known;
        }
        assert_eq!(seen.last().unwrap().sessions_imported, summary.sessions);

        // run_with_env is unchanged: same summary on a fresh archive over the same staging.
        let plain = Importer::new(Arc::new(Archive::in_memory().unwrap()))
            .run_with_env(&targets, Some("claude-code"), &env, &|_| {})
            .expect("plain run");
        assert_eq!(plain, summary);
    }

    // 6 ------------------------------------------------------------------------------------

    /// Recording tool, not a check: writes the event log the browser mock replays.
    /// ARMILLARY_RECORD_FIRSTRUN_LOG=<out.json> ARMILLARY_DEMO_HOME=<synthetic home under /tmp>
    /// cargo test --offline --manifest-path app/src-tauri/Cargo.toml record_demo_event_log -- --ignored
    #[test]
    #[ignore]
    fn record_demo_event_log() {
        let (Ok(out), Ok(demo_home)) =
            (std::env::var("ARMILLARY_RECORD_FIRSTRUN_LOG"), std::env::var("ARMILLARY_DEMO_HOME"))
        else {
            eprintln!("record_demo_event_log: set ARMILLARY_RECORD_FIRSTRUN_LOG and ARMILLARY_DEMO_HOME to run");
            return;
        };
        let home = Path::new(&demo_home);
        assert!(
            (home.starts_with("/tmp") || home.starts_with("/private/tmp"))
                && !home.components().any(|c| c.as_os_str() == ".."),
            "ARMILLARY_DEMO_HOME must be a synthetic folder under /tmp or /private/tmp, got {demo_home}"
        );

        // Canonical home (macOS /tmp is a symlink) so adapter globs match the folders they walk.
        let home = home.canonicalize().expect("demo home must exist");
        let env = MockEnvironment::new(TargetOs::current(), home.to_str().unwrap());
        // Only the demo home is visible: the log must not depend on this machine's installed apps.
        let fs = HomeOnlyFs { home: home.clone(), inner: SystemFileSystem };
        let archive = Arc::new(Archive::in_memory().unwrap());
        let start = std::time::Instant::now();
        let recorded: Mutex<Vec<serde_json::Value>> = Mutex::new(Vec::new());
        scan_core(&env, &fs, archive, 0, &|e| {
            recorded.lock().unwrap().push(serde_json::json!({
                "at": start.elapsed().as_millis() as u64,
                "name": e.name(),
                "payload": e.payload_json(),
            }));
        })
        .expect("scan over the synthetic demo home");

        let log = serde_json::json!({
            "source": "mock: recorded by firstrun.rs record_demo_event_log over demo/dataset (synthetic)",
            "plan": plan_core(&env),
            "events": recorded.into_inner().unwrap(),
        });
        std::fs::write(&out, serde_json::to_vec_pretty(&log).unwrap()).unwrap();
    }

    // 7 ------------------------------------------------------------------------------------

    #[test]
    fn redactor_hides_home_in_paths_and_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().canonicalize().unwrap();
        let env = MockEnvironment::new(TargetOs::current(), home.to_str().unwrap());
        let r = Redactor::new(&env);
        let h = home.to_string_lossy();

        assert_eq!(r.path(&home.join(".claude/projects")), "~/.claude/projects");
        let err = format!("unable to open database file {h}/.local/share/opencode/opencode.db (os error 2)");
        let shown = r.apply(&err);
        assert!(!shown.contains(h.as_ref()), "leaked: {shown}");
        assert!(shown.contains("~/.local/share/opencode/opencode.db"));
        // Two spellings of one home (symlinked tmp on macOS): the longer one must not be half-eaten.
        let two = MockEnvironment::new(TargetOs::Macos, "/tmp/armillary-redact-check");
        let r2 = Redactor { homes: vec!["/private/tmp/armillary-redact-check".into(), "/tmp/armillary-redact-check".into()] };
        let _ = two;
        assert_eq!(r2.apply("/private/tmp/armillary-redact-check/a and /tmp/armillary-redact-check/b"), "~/a and ~/b");
        // A bare "/" home must never turn every slash into "~".
        let root = MockEnvironment::new(TargetOs::Linux, "/");
        assert_eq!(Redactor::new(&root).apply("/etc/hosts"), "/etc/hosts");
    }

    // 8 ------------------------------------------------------------------------------------

    #[test]
    fn history_base_trims_to_a_folder() {
        assert_eq!(history_base("~/.claude/projects/*/*.jsonl").as_deref(), Some("~/.claude/projects"));
        assert_eq!(history_base("~/.codex/sessions/**/rollout-*.jsonl").as_deref(), Some("~/.codex/sessions"));
        assert_eq!(history_base("~/.local/share/amp/threads/T-*.json").as_deref(), Some("~/.local/share/amp/threads"));
        assert_eq!(history_base("~/.hermes/state.db").as_deref(), Some("~/.hermes"));
        assert_eq!(history_base("%USERPROFILE%\\.gemini\\tmp\\*\\chats\\x.jsonl").as_deref(), Some("%USERPROFILE%\\.gemini\\tmp"));
        assert_eq!(history_base("$GOOSE_PATH_ROOT/data/sessions/sessions.db").as_deref(), Some("$GOOSE_PATH_ROOT/data/sessions"));
        assert_eq!(history_base(".aider.chat.history.md").as_deref(), Some(".aider.chat.history.md"));
        assert_eq!(history_base("**/.aider.chat.history.md"), None);
    }

    // 9 ------------------------------------------------------------------------------------

    #[test]
    fn fps_helpers_format_and_route() {
        assert_eq!(fps_line("scene fps=59.8 frames=600"), "[armillary-fps] scene fps=59.8 frames=600");
        assert_eq!(fps_line("a\nb\r\tc"), "[armillary-fps] a b  c");
        assert_eq!(fps_line(&"x".repeat(1000)).len(), "[armillary-fps] ".len() + 400);
        assert_eq!(fps_sink(None), FpsSink::Off);
        assert_eq!(fps_sink(Some("")), FpsSink::Off);
        assert_eq!(fps_sink(Some("1")), FpsSink::StdoutOnly);
        assert_eq!(fps_sink(Some("/tmp/fps.log")), FpsSink::StdoutAndFile("/tmp/fps.log".into()));
    }

    // 10 -----------------------------------------------------------------------------------

    #[test]
    fn event_payloads_use_the_typescript_shapes() {
        let e = FirstRunEvent::Import(ImportPayload {
            agent_id: "claude-code".into(),
            phase: "progress".into(),
            sessions_imported: 2,
            sessions_known: 5,
            error: None,
            projects: vec!["a".into()],
        });
        assert_eq!(e.name(), "firstrun:import");
        let v = e.payload_json();
        for key in ["agentId", "phase", "sessionsImported", "sessionsKnown", "error", "projects"] {
            assert!(v.get(key).is_some(), "missing {key}");
        }
        assert!(v["error"].is_null());
        let d = FirstRunEvent::Done(DonePayload {
            constellations: vec![],
            live_sessions: 1,
            sessions_imported: 2,
            agents_found: 3,
            catalogue_size: 4,
            errors: 0,
        });
        for key in ["constellations", "liveSessions", "sessionsImported", "agentsFound", "catalogueSize", "errors"] {
            assert!(d.payload_json().get(key).is_some(), "missing {key}");
        }
    }

    // 11 -----------------------------------------------------------------------------------

    #[test]
    fn progress_throttle_is_deterministic_and_bounded() {
        // A large history: one listing reports 1000 known, then 1000 batches of one session each.
        let mut last = (0u32, 0u32);
        let mut emitted: Vec<(u32, u32)> = Vec::new();
        let mut observe = |known: u32, imported: u32| {
            if progress_due(false, known, imported, last) {
                last = (known, imported);
                emitted.push((known, imported));
            }
        };
        observe(1000, 0);
        for i in 1..=1000 {
            observe(1000, i);
        }
        assert!(
            (40..=45).contains(&emitted.len()),
            "expected 40 to 45 progress events, got {}",
            emitted.len()
        );
        assert_eq!(*emitted.last().unwrap(), (1000, 1000), "the last event reaches known");
        assert!(emitted.windows(2).all(|w| w[1].1 >= w[0].1), "imported never decreases");

        // Same input, same output.
        let mut again = 0;
        let mut l = (0u32, 0u32);
        for (k, i) in std::iter::once((1000, 0)).chain((1..=1000).map(|i| (1000, i))) {
            if progress_due(false, k, i, l) {
                l = (k, i);
                again += 1;
            }
        }
        assert_eq!(again, emitted.len());

        // Rules in isolation.
        assert!(progress_due(true, 10, 3, (10, 3)), "an error always goes out");
        assert!(progress_due(false, 11, 3, (10, 3)), "known changed");
        assert!(progress_due(false, 10, 10, (10, 9)), "imported reached known");
        assert!(!progress_due(false, 100, 51, (100, 50)), "advance of 1 < max(1, 100/40)");
        assert!(progress_due(false, 100, 53, (100, 50)), "advance of 3 >= 100/40 = 2");
        assert!(!progress_due(false, 5, 3, (5, 3)), "nothing changed");
        assert!(progress_due(false, 3, 1, (3, 0)), "small histories advance by at least 1");
    }
}
