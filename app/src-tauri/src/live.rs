use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

pub const BUILTIN_CLAUDE_CODE: &str = include_str!("../../../crates/adapters/src/builtins/claude-code.toml");
pub const BUILTIN_CODEX_CLI: &str = include_str!("../../../crates/adapters/src/builtins/codex-cli.toml");

pub use orrery_adapters::{Confidence, Evidence, Live, LiveState, ProcessIdentity};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    pub pid: u32,
    pub binary: String,
    pub cwd: Option<PathBuf>,
    pub started_at: Option<i64>,
}

pub trait ProcessScanner: Send + Sync {
    fn scan(&self, known_binaries: &[&str]) -> Vec<ProcessInfo>;
}

pub struct FakeProcessScanner {
    processes: Vec<ProcessInfo>,
}

impl FakeProcessScanner {
    pub fn new(processes: Vec<ProcessInfo>) -> Self {
        Self { processes }
    }
}

impl ProcessScanner for FakeProcessScanner {
    fn scan(&self, _known_binaries: &[&str]) -> Vec<ProcessInfo> {
        self.processes.clone()
    }
}

/// Scanner used when `ARMILLARY_PROCESS_SCAN=off`: never reads the process table.
pub struct DisabledProcessScanner;

impl ProcessScanner for DisabledProcessScanner {
    fn scan(&self, _known_binaries: &[&str]) -> Vec<ProcessInfo> {
        Vec::new()
    }
}

/// Reads the `ARMILLARY_PROCESS_SCAN` switch: "off", "0" and "false" (any case) turn the
/// process scan off; anything else, or no value, leaves it on.
pub fn process_scan_enabled(value: Option<&str>) -> bool {
    match value {
        Some(v) => {
            let v = v.trim();
            !(v.eq_ignore_ascii_case("off") || v == "0" || v.eq_ignore_ascii_case("false"))
        }
        None => true,
    }
}

pub struct SysinfoProcessScanner {
    system: Mutex<sysinfo::System>,
}

impl Default for SysinfoProcessScanner {
    fn default() -> Self {
        Self {
            system: Mutex::new(sysinfo::System::new()),
        }
    }
}

impl SysinfoProcessScanner {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ProcessScanner for SysinfoProcessScanner {
    fn scan(&self, known_binaries: &[&str]) -> Vec<ProcessInfo> {
        let mut sys = self.system.lock().unwrap_or_else(|e| e.into_inner());
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        let mut matching = Vec::new();
        for (pid, process) in sys.processes() {
            let proc_name = process.name().to_string_lossy().to_lowercase();
            let exe_name = process
                .exe()
                .and_then(|p| p.file_name())
                .map(|f| f.to_string_lossy().to_lowercase())
                .unwrap_or_default();

            for &known in known_binaries {
                let known_lower = known.to_lowercase();
                let matches_name = proc_name == known_lower
                    || proc_name.starts_with(&format!("{}.", known_lower));
                let matches_exe = exe_name == known_lower
                    || exe_name.starts_with(&format!("{}.", known_lower));
                let matches_cmd = process.cmd().iter().any(|arg| {
                    let a = arg.to_string_lossy().to_lowercase();
                    a == known_lower
                        || a.ends_with(&format!("/{}", known_lower))
                        || a.ends_with(&format!("\\{}", known_lower))
                });

                if matches_name || matches_exe || matches_cmd {
                    let cwd = process.cwd().map(|p| p.to_path_buf());
                    let started_at = {
                        let st = process.start_time();
                        if st > 0 {
                            Some((st * 1000) as i64)
                        } else {
                            None
                        }
                    };
                    matching.push(ProcessInfo {
                        pid: pid.as_u32(),
                        binary: known.to_string(),
                        cwd,
                        started_at,
                    });
                    break;
                }
            }
        }
        matching
    }
}

#[derive(Debug, Clone)]
pub struct LiveDetectorConfig {
    pub history_roots: HashMap<String, PathBuf>,
    pub active_window_secs: u64,
    pub idle_threshold_secs: u64,
    pub min_emit_interval: Duration,
}

impl Default for LiveDetectorConfig {
    fn default() -> Self {
        Self {
            history_roots: HashMap::new(),
            active_window_secs: 900,
            idle_threshold_secs: 120,
            min_emit_interval: Duration::from_millis(250),
        }
    }
}

#[derive(Debug, Clone)]
pub struct KnownAgentConfig {
    pub agent_id: String,
    pub binaries: Vec<String>,
    pub history_patterns: Vec<String>,
}

pub struct LiveDetector {
    pub config: LiveDetectorConfig,
    pub scanner: Box<dyn ProcessScanner>,
    pub state_tracker: HashMap<String, (LiveState, i64)>,
    pub known_agents: Vec<KnownAgentConfig>,
    pub rate_limiter: RateLimiter,
    /// False when process scanning is switched off: nobody looked at processes.
    pub process_scan: bool,
}

impl LiveDetector {
    pub fn new(config: LiveDetectorConfig, scanner: Box<dyn ProcessScanner>) -> Self {
        let min_interval = config.min_emit_interval;
        let mut detector = Self {
            config,
            scanner,
            state_tracker: HashMap::new(),
            known_agents: Vec::new(),
            rate_limiter: RateLimiter::new(min_interval),
            process_scan: true,
        };
        detector.load_builtins();
        detector
    }

    fn load_builtins(&mut self) {
        let os_str = orrery_adapters::env::TargetOs::current().as_str();
        for toml_str in [BUILTIN_CLAUDE_CODE, BUILTIN_CODEX_CLI] {
            if let Ok(spec) = orrery_adapters::AdapterDef::from_toml(toml_str) {
                let mut patterns = Vec::new();
                for src in &spec.history_sources {
                    if let Some(paths) = src.paths.get(os_str) {
                        patterns.extend(paths.clone());
                    }
                }
                self.known_agents.push(KnownAgentConfig {
                    agent_id: spec.id,
                    binaries: spec.detection.binaries,
                    history_patterns: patterns,
                });
            }
        }
    }

    pub fn scan(&mut self, now_ms: i64) -> Vec<Live> {
        let never = std::sync::atomic::AtomicBool::new(false);
        self.scan_until(now_ms, &never).unwrap_or_default()
    }

    pub fn scan_until(&mut self, now_ms: i64, stop: &std::sync::atomic::AtomicBool) -> Option<Vec<Live>> {
        use std::sync::atomic::Ordering;
        if stop.load(Ordering::SeqCst) {
            return None;
        }
        let all_binaries: Vec<&str> = self
            .known_agents
            .iter()
            .flat_map(|a| a.binaries.iter().map(|b| b.as_str()))
            .collect();

        // With the scan switched off nobody reads the process table at all.
        let running_processes = if self.process_scan {
            self.scanner.scan(&all_binaries)
        } else {
            Vec::new()
        };
        if stop.load(Ordering::SeqCst) {
            return None;
        }

        let mut results = Vec::new();
        let mut seen_sessions = HashMap::new();
        // A process is evidence for at most one session: the newest file that matches it.
        let mut claimed_pids: HashSet<u32> = HashSet::new();

        for agent in &self.known_agents {
            if stop.load(Ordering::SeqCst) {
                return None;
            }
            let mut files = self.collect_agent_session_files(agent);
            // Newest first, ties broken by path, so the assignment below is deterministic.
            files.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

            for (file_path, mtime_ms) in files {
                if stop.load(Ordering::SeqCst) {
                    return None;
                }
                if orrery_adapters::credentials::is_credential_file(&file_path) {
                    continue;
                }

                let elapsed_secs = (now_ms - mtime_ms).max(0) / 1000;
                let is_recent = elapsed_secs <= (self.config.active_window_secs as i64);

                let header_info = parse_session_header(&agent.agent_id, &file_path);
                let native_id = header_info
                    .session_id
                    .unwrap_or_else(|| file_path.to_string_lossy().to_string());
                let session_id = contract_session_id(
                    agent,
                    &file_path,
                    &native_id,
                    Some(&self.config.history_roots),
                );
                let project_root = header_info.cwd;

                if seen_sessions.contains_key(&session_id) {
                    continue;
                }
                seen_sessions.insert(session_id.clone(), ());

                let candidates = matching_processes(
                    agent,
                    project_root.as_deref(),
                    &running_processes,
                );
                let matching_process = candidates
                    .iter()
                    .copied()
                    .find(|p| !claimed_pids.contains(&p.pid));
                if matching_process.is_none() && !candidates.is_empty() {
                    // Every process that fits this file is busy with a newer session, so this
                    // file is neither live nor known to be finished: do not list it.
                    continue;
                }
                if let Some(p) = matching_process {
                    claimed_pids.insert(p.pid);
                }

                let is_alive = matching_process.is_some();
                let pid = matching_process.map(|p| p.pid);
                let process = matching_process.map(|p| ProcessIdentity {
                    pid: p.pid,
                    started_at: p.started_at,
                });

                let active_window_ms = (self.config.active_window_secs * 1000) as i64;
                let idle_threshold_ms = (self.config.idle_threshold_secs * 1000) as i64;
                let expires_at = Some(mtime_ms + active_window_ms);

                let (state, confidence, evidence) = if !self.process_scan {
                    if !is_recent {
                        continue;
                    }
                    (
                        LiveState::Unknown,
                        Confidence::Low,
                        vec![Evidence {
                            kind: "file_activity".to_string(),
                            detail: "Session file was written recently; process scanning is disabled, so liveness is unknown".to_string(),
                            native_event_id: None,
                            at: Some(mtime_ms),
                        }],
                    )
                } else if !is_alive {
                    if !is_recent {
                        continue;
                    }
                    (
                        LiveState::Done,
                        Confidence::Medium,
                        vec![Evidence {
                            kind: "process_exit".to_string(),
                            detail: "Process terminated or not found in process table".to_string(),
                            native_event_id: None,
                            at: Some(mtime_ms),
                        }],
                    )
                } else if {
                    if stop.load(Ordering::SeqCst) {
                        return None;
                    }
                    is_waiting_record(&agent.agent_id, &file_path)
                } {
                    (
                        LiveState::Waiting,
                        Confidence::High,
                        vec![Evidence {
                            kind: "native_waiting_signal".to_string(),
                            detail: format!(
                                "Native waiting event observed in session log for {}",
                                agent.agent_id
                            ),
                            native_event_id: None,
                            at: Some(mtime_ms),
                        }],
                    )
                } else if (now_ms - mtime_ms).max(0) >= idle_threshold_ms {
                    (
                        LiveState::Idle,
                        Confidence::Medium,
                        vec![Evidence {
                            kind: "process_idle".to_string(),
                            detail: format!(
                                "Process {} running but no writes for {}s",
                                pid.unwrap_or_default(),
                                elapsed_secs
                            ),
                            native_event_id: None,
                            at: Some(mtime_ms),
                        }],
                    )
                } else {
                    (
                        LiveState::Working,
                        Confidence::High,
                        vec![Evidence {
                            kind: "process_and_activity".to_string(),
                            detail: format!(
                                "Process {} active with recent file write",
                                pid.unwrap_or_default()
                            ),
                            native_event_id: None,
                            at: Some(mtime_ms),
                        }],
                    )
                };

                let since = match self.state_tracker.get(&session_id) {
                    Some(&(prev_state, prev_since)) if prev_state == state => Some(prev_since),
                    _ => Some(now_ms),
                };
                self.state_tracker
                    .insert(session_id.clone(), (state, since.unwrap_or(now_ms)));

                results.push(Live {
                    session_id,
                    state,
                    since,
                    observed_at: now_ms,
                    evidence,
                    confidence,
                    process,
                    expires_at,
                });
            }
        }

        if stop.load(Ordering::SeqCst) {
            return None;
        }
        Some(results)
    }

    fn collect_agent_session_files(&self, agent: &KnownAgentConfig) -> Vec<(PathBuf, i64)> {
        let mut out = Vec::new();

        if !self.config.history_roots.is_empty() {
            if let Some(custom_root) = self.config.history_roots.get(&agent.agent_id) {
                if custom_root.exists() {
                    find_session_files_recursively(custom_root, &mut out);
                }
            }
            return out;
        }

        let sys_env = orrery_adapters::env::SystemEnvironment;
        let os = orrery_adapters::env::TargetOs::current();

        for pattern in &agent.history_patterns {
            let expanded_pattern = match orrery_adapters::path_expansion::expand_path(pattern, os, &sys_env) {
                Ok(p) => p.to_string_lossy().to_string(),
                Err(_) => pattern.clone(),
            };

            // Every match must really sit under the pattern's fixed folder, must not be a link,
            // and no part of its resolved path may name a credential file (R2-RC-2).
            let base = glob_base(&expanded_pattern).canonicalize().ok();
            if let Ok(entries) = glob::glob(&expanded_pattern) {
                for entry in entries.flatten() {
                    let plain_file = fs::symlink_metadata(&entry).map(|m| m.is_file()).unwrap_or(false);
                    let contained = match (&base, entry.canonicalize()) {
                        (Some(base), Ok(real)) => real.starts_with(base) && !credential_path(&real),
                        _ => false,
                    };
                    if plain_file && contained && !credential_path(&entry) {
                        let mtime = fs::metadata(&entry)
                            .and_then(|m| m.modified())
                            .unwrap_or(UNIX_EPOCH);
                        let mtime_ms = mtime
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as i64;
                        out.push((entry, mtime_ms));
                    }
                }
            }
        }

        out
    }

    pub fn get_live_list(&mut self) -> Vec<Live> {
        let now_ms = now_unix_ms();
        self.scan(now_ms)
    }

    pub fn maybe_emit_update<R: tauri::Runtime>(
        &mut self,
        app_handle: &tauri::AppHandle<R>,
        now_ms: i64,
    ) -> Result<bool, String> {
        let now = Instant::now();
        if !self.rate_limiter.can_emit(now) {
            return Ok(false);
        }

        let list = self.scan(now_ms);
        app_handle
            .emit("live:update", &list)
            .map_err(|e| e.to_string())?;
        self.rate_limiter.record_emit(now);
        Ok(true)
    }

    /// Like `maybe_emit_update`, but emits only when the list changed since the last emitted
    /// one (ignoring `observed_at`), still honouring the rate limiter.
    pub fn maybe_emit_if_changed<R: tauri::Runtime>(
        &mut self,
        app_handle: &tauri::AppHandle<R>,
        now_ms: i64,
        gate: &mut EmitGate,
    ) -> Result<bool, String> {
        let never = std::sync::atomic::AtomicBool::new(false);
        self.maybe_emit_if_changed_until(app_handle, now_ms, gate, &never)
    }

    pub fn maybe_emit_if_changed_until<R: tauri::Runtime>(
        &mut self,
        app_handle: &tauri::AppHandle<R>,
        now_ms: i64,
        gate: &mut EmitGate,
        stop: &std::sync::atomic::AtomicBool,
    ) -> Result<bool, String> {
        let now = Instant::now();
        if !self.rate_limiter.can_emit(now) {
            return Ok(false);
        }

        let Some(list) = self.scan_until(now_ms, stop) else {
            return Ok(false);
        };
        if !gate.should_emit(&list) {
            return Ok(false);
        }
        if let Err(e) = app_handle.emit("live:update", &list) {
            gate.reset();
            return Err(e.to_string());
        }
        self.rate_limiter.record_emit(now);
        Ok(true)
    }
}

/// True when the file name names a credential file, or any folder of `path` is a credential store
/// (.ssh, .aws, ~/Library/Keychains, ...). Folder names are not checked as key files: history
/// folders encode project paths, and a project may be called keychain-app (R-5, r2 fix round 2).
fn credential_path(path: &Path) -> bool {
    orrery_adapters::credentials::is_credential_file(path)
        || path
            .components()
            .any(|c| orrery_adapters::credentials::is_credential_place(&c.as_os_str().to_string_lossy()))
}

/// The fixed folder part of a glob pattern: everything before the first component with a glob
/// character.
fn glob_base(pattern: &str) -> PathBuf {
    let mut base = PathBuf::new();
    for component in Path::new(pattern).components() {
        let text = component.as_os_str().to_string_lossy();
        if text.contains(['*', '?', '[', '{']) {
            break;
        }
        base.push(component.as_os_str());
    }
    base
}

/// Open a history file for the header and tail readers without following a link (R2-RC-2): the
/// last component is opened with O_NOFOLLOW, the result must be a regular file, and no part of
/// the declared or resolved path may name a credential file.
fn open_history_file(path: &Path) -> Option<fs::File> {
    if credential_path(path) {
        return None;
    }
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    if credential_path(&path.canonicalize().ok()?) {
        return None;
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    let file = options.open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    Some(file)
}

/// Collect session files under a history root. Links (to files or folders) are never followed.
fn find_session_files_recursively(dir: &Path, out: &mut Vec<(PathBuf, i64)>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            // file_type does not follow links.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                // A folder is skipped only when it is a credential store (R-5): history folders
                // are named after projects, and a project may be called keychain-app.
                if !orrery_adapters::credentials::is_credential_place(&entry.file_name().to_string_lossy()) {
                    find_session_files_recursively(&path, out);
                }
            } else if kind.is_file() {
                if credential_path(&path) {
                    continue;
                }
                if let Some(ext) = path.extension() {
                    if ext == "jsonl" || ext == "json" {
                        let mtime = fs::symlink_metadata(&path)
                            .and_then(|m| m.modified())
                            .unwrap_or(UNIX_EPOCH);
                        let mtime_ms = mtime
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as i64;
                        out.push((path, mtime_ms));
                    }
                }
            }
        }
    }
}

fn normalize_path_str(p: &str) -> String {
    p.trim_end_matches(['/', '\\']).to_string()
}

/// True when `cwd` is `root` or lies under it. Compares normalized path components
/// (trailing separators trimmed, both `/` and `\\` split, ASCII case-insensitive), as strings
/// only: the paths need not exist on disk. An empty root never contains anything.
fn path_is_within(root: &str, cwd: &str) -> bool {
    let root = normalize_path_str(root);
    let cwd = normalize_path_str(cwd);
    if root.is_empty() {
        return false;
    }
    let root_parts: Vec<&str> = root.split(['/', '\\']).collect();
    let cwd_parts: Vec<&str> = cwd.split(['/', '\\']).collect();
    cwd_parts.len() >= root_parts.len()
        && root_parts
            .iter()
            .zip(cwd_parts.iter())
            .all(|(r, c)| r.eq_ignore_ascii_case(c))
}

/// A process is evidence for a session only when its binary matches the agent, its cwd is
/// known, and the session's project root is known and contains that cwd.
#[cfg(test)]
fn find_matching_process<'a>(
    agent: &KnownAgentConfig,
    project_root: Option<&str>,
    processes: &'a [ProcessInfo],
) -> Option<&'a ProcessInfo> {
    matching_processes(agent, project_root, processes).into_iter().next()
}

/// Every process that fits the binary and cwd-under-root rule, in scanner order.
fn matching_processes<'a>(
    agent: &KnownAgentConfig,
    project_root: Option<&str>,
    processes: &'a [ProcessInfo],
) -> Vec<&'a ProcessInfo> {
    let Some(root) = project_root else {
        return Vec::new();
    };
    processes.iter().filter(|proc| {
        let matches_binary = agent
            .binaries
            .iter()
            .any(|b| b.eq_ignore_ascii_case(&proc.binary));
        matches_binary
            && proc
                .cwd
                .as_ref()
                .is_some_and(|cwd| path_is_within(root, &cwd.to_string_lossy()))
    }).collect()
}

/// Session id as the frozen contract (crates/model/CONTRACT.md, armillary.cf.v1) defines it, so a
/// live session lines up with the archived one: uses the shared store identity helper from the
/// importer with the canonical data folder, then the native session id.
fn contract_session_id(
    agent: &KnownAgentConfig,
    file_path: &Path,
    native_id: &str,
    history_roots: Option<&HashMap<String, PathBuf>>,
) -> String {
    let store = crate::importer::resolve_store_for_file(&agent.agent_id, file_path, history_roots);
    let is_path_fallback = native_id == file_path.to_string_lossy();
    let relative = file_path
        .strip_prefix(&store.canonical_root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| file_path.to_string_lossy().to_string());
    orrery_adapters::normalized_session_id(
        &store.id,
        if is_path_fallback { None } else { Some(native_id) },
        &relative,
    )
}

#[derive(Default, Debug)]
pub struct SessionHeader {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Deserialize)]
struct ClaudeRecordHeader {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct CodexRecordHeader {
    payload: Option<CodexPayloadHeader>,
}

#[derive(Deserialize)]
struct CodexPayloadHeader {
    id: Option<String>,
    cwd: Option<String>,
}

fn parse_session_header(agent_id: &str, file_path: &Path) -> SessionHeader {
    if orrery_adapters::credentials::is_credential_file(file_path) {
        return SessionHeader::default();
    }

    let file = match open_history_file(file_path) {
        Some(f) => f,
        None => return SessionHeader::default(),
    };

    let reader = BufReader::new(file);
    let mut header = SessionHeader::default();

    for line in reader.lines().map_while(Result::ok).take(20) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if agent_id == "claude-code" {
            if let Ok(parsed) = serde_json::from_str::<ClaudeRecordHeader>(trimmed) {
                if header.session_id.is_none() && parsed.session_id.is_some() {
                    header.session_id = parsed.session_id;
                }
                if header.cwd.is_none() && parsed.cwd.is_some() {
                    header.cwd = parsed.cwd;
                }
            }
        } else if agent_id == "codex-cli" {
            if let Ok(parsed) = serde_json::from_str::<CodexRecordHeader>(trimmed) {
                if let Some(payload) = parsed.payload {
                    if header.session_id.is_none() && payload.id.is_some() {
                        header.session_id = payload.id;
                    }
                    if header.cwd.is_none() && payload.cwd.is_some() {
                        header.cwd = payload.cwd;
                    }
                }
            }
        }

        if header.session_id.is_some() && header.cwd.is_some() {
            break;
        }
    }

    header
}

#[derive(Deserialize)]
struct RecordTypeProbe {
    #[serde(rename = "type")]
    record_type: Option<String>,
    payload: Option<PayloadTypeProbe>,
}

#[derive(Deserialize)]
struct PayloadTypeProbe {
    #[serde(rename = "type")]
    payload_type: Option<String>,
    item: Option<ItemTypeProbe>,
}

#[derive(Deserialize)]
struct ItemTypeProbe {
    #[serde(rename = "type")]
    item_type: Option<String>,
}

pub fn is_waiting_record(agent_id: &str, file_path: &Path) -> bool {
    if orrery_adapters::credentials::is_credential_file(file_path) {
        return false;
    }

    let line = match read_last_non_empty_line(file_path) {
        Some(l) => l,
        None => return false,
    };

    let probe: RecordTypeProbe = match serde_json::from_str(&line) {
        Ok(p) => p,
        Err(_) => return false,
    };

    let r_type = probe.record_type.as_deref().unwrap_or_default();
    let p_type = probe
        .payload
        .as_ref()
        .and_then(|p| p.payload_type.as_deref())
        .unwrap_or_default();
    let i_type = probe
        .payload
        .as_ref()
        .and_then(|p| p.item.as_ref())
        .and_then(|i| i.item_type.as_deref())
        .unwrap_or_default();

    if agent_id == "claude-code" {
        matches!(
            r_type,
            "permission_prompt"
                | "permission_request"
                | "permission"
                | "idle_prompt"
                | "agent_needs_input"
                | "elicitation_dialog"
                | "ask_user"
                | "user_input_request"
                | "input_request"
                | "waiting_for_input"
        )
    } else if agent_id == "codex-cli" {
        matches!(
            r_type,
            "request_approval"
                | "approval_request"
                | "permission_request"
                | "permission"
                | "waiting_for_input"
                | "user_input_request"
                | "input_request"
                | "ask_user"
        ) || matches!(
            p_type,
            "request_approval"
                | "approval_request"
                | "permission_request"
                | "permission"
                | "waiting_for_input"
                | "user_input_request"
                | "input_request"
                | "ask_user"
        ) || matches!(
            i_type,
            "request_approval"
                | "approval_request"
                | "permission_request"
                | "permission"
                | "waiting_for_input"
                | "user_input_request"
                | "input_request"
                | "ask_user"
        )
    } else {
        false
    }
}

pub fn read_last_non_empty_line(path: &Path) -> Option<String> {
    if orrery_adapters::credentials::is_credential_file(path) {
        return None;
    }
    let mut file = open_history_file(path)?;
    let file_len = file.metadata().ok()?.len();
    if file_len == 0 {
        return None;
    }

    let read_size = std::cmp::min(file_len, 65536);
    file.seek(SeekFrom::End(-(read_size as i64))).ok()?;
    let mut buf = vec![0u8; read_size as usize];
    use std::io::Read;
    file.read_exact(&mut buf).ok()?;

    let text = String::from_utf8_lossy(&buf);
    let mut lines = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>();

    if file_len > read_size && lines.len() <= 1 {
        file.seek(SeekFrom::Start(0)).ok()?;
        let reader = BufReader::new(file);
        let mut all_lines = Vec::new();
        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                all_lines.push(trimmed.to_string());
            }
        }
        return all_lines.pop();
    }

    lines.pop().map(|s| s.to_string())
}

pub fn read_first_non_empty_line(path: &Path) -> Option<String> {
    if orrery_adapters::credentials::is_credential_file(path) {
        return None;
    }
    let file = open_history_file(path)?;
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

pub struct RateLimiter {
    pub min_interval: Duration,
    pub last_emit: Option<Instant>,
}

impl RateLimiter {
    pub fn new(min_interval: Duration) -> Self {
        Self {
            min_interval,
            last_emit: None,
        }
    }

    pub fn can_emit(&self, now: Instant) -> bool {
        match self.last_emit {
            None => true,
            Some(last) => now.duration_since(last) >= self.min_interval,
        }
    }

    pub fn record_emit(&mut self, now: Instant) {
        self.last_emit = Some(now);
    }
}

pub fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

static GLOBAL_DETECTOR: OnceLock<Mutex<LiveDetector>> = OnceLock::new();

pub fn get_global_detector() -> &'static Mutex<LiveDetector> {
    GLOBAL_DETECTOR.get_or_init(|| {
        let scan_on = process_scan_enabled(std::env::var("ARMILLARY_PROCESS_SCAN").ok().as_deref());
        let scanner: Box<dyn ProcessScanner> = if scan_on {
            Box::new(SysinfoProcessScanner::new())
        } else {
            Box::new(DisabledProcessScanner)
        };
        #[allow(unused_mut)]
        let mut config = LiveDetectorConfig::default();
        #[cfg(test)]
        {
            let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
            config.history_roots.insert(
                "claude-code".to_string(),
                repo_root.join("fixtures/live/claude-code"),
            );
            config.history_roots.insert(
                "codex-cli".to_string(),
                repo_root.join("fixtures/live/codex-cli"),
            );
        }
        let mut detector = LiveDetector::new(config, scanner);
        detector.process_scan = scan_on;
        Mutex::new(detector)
    })
}

pub const SCAN_INTERVAL: Duration = Duration::from_secs(2);

/// True when two lists are the same apart from `observed_at` (which changes every scan).
pub fn live_lists_equivalent(a: &[Live], b: &[Live]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b.iter()).all(|(x, y)| {
            x.session_id == y.session_id
                && x.state == y.state
                && x.since == y.since
                && x.evidence == y.evidence
                && x.confidence == y.confidence
                && x.process == y.process
                && x.expires_at == y.expires_at
        })
}

/// Decides whether a scanned list should be emitted as `live:update`: the first list, and
/// then only lists that differ from the last emitted one (ignoring `observed_at`).
#[derive(Default)]
pub struct EmitGate {
    last: Option<Vec<Live>>,
}

impl EmitGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn should_emit(&mut self, list: &[Live]) -> bool {
        if let Some(last) = &self.last {
            if live_lists_equivalent(last, list) {
                return false;
            }
        }
        self.last = Some(list.to_vec());
        true
    }

    /// Forget the last emitted list so the next one is emitted (used after a failed emit).
    pub fn reset(&mut self) {
        self.last = None;
    }
}

/// Runs the list command against a given detector; a poisoned lock is the typed
/// `live_failed` error.
pub fn live_list_from(
    detector: &Mutex<LiveDetector>,
) -> Result<Vec<Live>, crate::archive_api::ApiError> {
    let mut d = detector.lock().map_err(|e| crate::archive_api::ApiError {
        code: "live_failed".to_string(),
        message: format!("Detector lock error: {}", e),
    })?;
    Ok(d.get_live_list())
}

/// The detector loop: scans every `SCAN_INTERVAL` until `stop` is set (consent withdrawn or the
/// archive deleted); then it ends without another scan.
pub fn start_background_detector<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    std::thread::spawn(move || {
        let mut gate = EmitGate::new();
        loop {
            std::thread::sleep(SCAN_INTERVAL);
            if stop.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            let now_ms = now_unix_ms();
            if let Ok(mut detector) = get_global_detector().lock() {
                let _ = detector.maybe_emit_if_changed_until(&app_handle, now_ms, &mut gate, &stop);
            }
        }
    });
}

/// Consent-gated form of the command: without recorded consent neither the process table nor any
/// history file is read.
pub fn live_list_in(
    data_dir: &Path,
    detector: &Mutex<LiveDetector>,
) -> Result<Vec<Live>, crate::archive_api::ApiError> {
    crate::archive_api::consent::require(data_dir)?;
    live_list_from(detector)
}

#[tauri::command]
pub fn live_list(app: tauri::AppHandle) -> Result<Vec<Live>, crate::archive_api::ApiError> {
    let data_dir = crate::archive_api::app_data_dir_of(&app)?;
    live_list_in(&data_dir, get_global_detector())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_state_working() {
        let dir = tempdir().unwrap();
        let session_file = dir.path().join("session.jsonl");
        fs::write(
            &session_file,
            "{\"type\":\"user\",\"sessionId\":\"s1\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T15:00:00Z\"}\n{\"type\":\"assistant\",\"sessionId\":\"s1\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T15:00:05Z\"}\n",
        ).unwrap();

        let mtime = fs::metadata(&session_file).unwrap().modified().unwrap();
        let mtime_ms = mtime.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;

        let mut roots = HashMap::new();
        roots.insert("claude-code".to_string(), dir.path().to_path_buf());
        let config = LiveDetectorConfig {
            history_roots: roots,
            active_window_secs: 600,
            idle_threshold_secs: 120,
            min_emit_interval: Duration::from_millis(250),
        };
        let scanner = Box::new(FakeProcessScanner::new(vec![ProcessInfo {
            pid: 1001,
            binary: "claude".to_string(),
            cwd: Some(PathBuf::from("/app")),
            started_at: Some(mtime_ms - 60_000),
        }]));

        let mut detector = LiveDetector::new(config, scanner);
        let now_ms = mtime_ms + 10_000; // 10 seconds after modification
        let list = detector.scan(now_ms);

        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, LiveState::Working);
        assert_eq!(list[0].process.as_ref().map(|p| p.pid), Some(1001));
        assert_eq!(
            list[0].process.as_ref().and_then(|p| p.started_at),
            Some(mtime_ms - 60_000)
        );
        assert_eq!(list[0].confidence, Confidence::High);
    }

    #[test]
    fn test_state_idle() {
        let dir = tempdir().unwrap();
        let session_file = dir.path().join("session.jsonl");
        fs::write(
            &session_file,
            "{\"type\":\"user\",\"sessionId\":\"s2\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T14:00:00Z\"}\n{\"type\":\"assistant\",\"sessionId\":\"s2\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T14:01:00Z\"}\n",
        ).unwrap();

        let mtime = fs::metadata(&session_file).unwrap().modified().unwrap();
        let mtime_ms = mtime.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;

        let mut roots = HashMap::new();
        roots.insert("claude-code".to_string(), dir.path().to_path_buf());
        let config = LiveDetectorConfig {
            history_roots: roots,
            active_window_secs: 600,
            idle_threshold_secs: 120,
            min_emit_interval: Duration::from_millis(250),
        };
        let scanner = Box::new(FakeProcessScanner::new(vec![ProcessInfo {
            pid: 1002,
            binary: "claude".to_string(),
            cwd: Some(PathBuf::from("/app")),
            started_at: None,
        }]));

        let mut detector = LiveDetector::new(config, scanner);
        let now_ms = mtime_ms + 150_000; // 150 seconds after write (> 120s threshold)
        let list = detector.scan(now_ms);

        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, LiveState::Idle);
        assert_eq!(list[0].confidence, Confidence::Medium);
    }

    #[test]
    fn test_state_done_process_gone() {
        let dir = tempdir().unwrap();
        let session_file = dir.path().join("session.jsonl");
        fs::write(
            &session_file,
            "{\"type\":\"user\",\"sessionId\":\"s3\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T14:00:00Z\"}\n{\"type\":\"assistant\",\"sessionId\":\"s3\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T14:01:00Z\"}\n",
        ).unwrap();

        let mtime = fs::metadata(&session_file).unwrap().modified().unwrap();
        let mtime_ms = mtime.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;

        let mut roots = HashMap::new();
        roots.insert("claude-code".to_string(), dir.path().to_path_buf());
        let config = LiveDetectorConfig {
            history_roots: roots,
            active_window_secs: 600,
            idle_threshold_secs: 120,
            min_emit_interval: Duration::from_millis(250),
        };
        // Process table is EMPTY -> process gone
        let scanner = Box::new(FakeProcessScanner::new(vec![]));

        let mut detector = LiveDetector::new(config, scanner);
        let now_ms = mtime_ms + 10_000;
        let list = detector.scan(now_ms);

        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, LiveState::Done);
        assert!(list[0].process.is_none());
        assert_eq!(list[0].confidence, Confidence::Medium);
    }

    #[test]
    fn test_state_waiting_claude_permission() {
        let dir = tempdir().unwrap();
        let session_file = dir.path().join("session.jsonl");
        fs::write(
            &session_file,
            "{\"type\":\"user\",\"sessionId\":\"s4\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T15:00:00Z\"}\n{\"type\":\"permission_prompt\",\"sessionId\":\"s4\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T15:00:05Z\"}\n",
        ).unwrap();

        assert!(is_waiting_record("claude-code", &session_file));
    }

    #[test]
    fn test_state_waiting_claude_input() {
        let dir = tempdir().unwrap();
        let session_file = dir.path().join("session.jsonl");
        fs::write(
            &session_file,
            "{\"type\":\"user\",\"sessionId\":\"s5\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T15:00:00Z\"}\n{\"type\":\"idle_prompt\",\"sessionId\":\"s5\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T15:00:05Z\"}\n",
        ).unwrap();

        assert!(is_waiting_record("claude-code", &session_file));
    }

    #[test]
    fn test_state_waiting_codex_approval() {
        let dir = tempdir().unwrap();
        let session_file = dir.path().join("rollout.jsonl");
        fs::write(
            &session_file,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"c1\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T15:00:00Z\"}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"request_approval\"}}\n",
        ).unwrap();

        assert!(is_waiting_record("codex-cli", &session_file));
    }

    #[test]
    fn test_state_waiting_codex_input() {
        let dir = tempdir().unwrap();
        let session_file = dir.path().join("rollout.jsonl");
        fs::write(
            &session_file,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"c2\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T15:00:00Z\"}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"waiting_for_input\"}}\n",
        ).unwrap();

        assert!(is_waiting_record("codex-cli", &session_file));
    }

    #[test]
    fn test_read_only_record_type_never_content() {
        let dir = tempdir().unwrap();
        let session_file = dir.path().join("session_privacy.jsonl");
        fs::write(
            &session_file,
            "{\"type\":\"permission_prompt\",\"sensitive_secret_content\":\"SUPER_SECRET_USER_INPUT_DO_NOT_READ\"}\n",
        ).unwrap();

        assert!(is_waiting_record("claude-code", &session_file));
    }

    #[test]
    fn test_credential_files_never_opened() {
        let dir = tempdir().unwrap();
        let auth_file = dir.path().join("auth.json");
        fs::write(&auth_file, "{\"secret\":\"top_secret\"}").unwrap();

        assert!(orrery_adapters::credentials::is_credential_file(&auth_file));
        assert_eq!(read_first_non_empty_line(&auth_file), None);
        assert_eq!(read_last_non_empty_line(&auth_file), None);
        assert!(!is_waiting_record("claude-code", &auth_file));
    }

    struct CountingScanner(std::sync::Arc<std::sync::atomic::AtomicUsize>);
    impl ProcessScanner for CountingScanner {
        fn scan(&self, _known: &[&str]) -> Vec<ProcessInfo> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Vec::new()
        }
    }

    /// R2-REV-1 / LA-2: the Orrery's live list refuses after "Not now": no process-table scan and
    /// no history file is opened.
    #[test]
    fn live_list_refuses_after_decline_and_reads_nothing() {
        use crate::archive_api::testkit::{tmp, write_consented, write_declined};
        let data = tmp();
        let home = tmp();
        fs::write(
            home.path().join("s.jsonl"),
            "{\"type\":\"user\",\"sessionId\":\"FAKE_SID\",\"cwd\":\"/app\"}\n",
        )
        .unwrap();
        let mut roots = HashMap::new();
        roots.insert("claude-code".to_string(), home.path().to_path_buf());
        let config = LiveDetectorConfig { history_roots: roots, ..LiveDetectorConfig::default() };
        let scans = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let detector = Mutex::new(LiveDetector::new(config, Box::new(CountingScanner(scans.clone()))));
        for declined in [false, true] {
            if declined {
                write_declined(data.path());
            }
            let err = live_list_in(data.path(), &detector).unwrap_err();
            assert_eq!(err.code, "consent_required");
            assert_eq!(scans.load(std::sync::atomic::Ordering::SeqCst), 0, "no process scan");
        }
        write_consented(data.path());
        let list = live_list_in(data.path(), &detector).unwrap();
        assert_eq!(list.len(), 1, "control: consent reads the fake history");
        assert!(scans.load(std::sync::atomic::Ordering::SeqCst) > 0);
    }

    /// R2-RC-2 / R2-REV-6: a session-named link to a credential file (or out of the history folder)
    /// is never opened by the walk, the header reader or the tail readers.
    #[test]
    fn live_scanner_skips_links_to_credential_files() {
        let outer = crate::archive_api::testkit::tmp();
        let root = outer.path().join("history");
        fs::create_dir_all(root.join("proj")).unwrap();
        let cred = root.join(".credentials.json");
        fs::write(&cred, "{\"type\":\"user\",\"sessionId\":\"CANARY_SID_ONLY_IN_CRED\",\"cwd\":\"/canary\"}\n").unwrap();
        let outside = outer.path().join("outside.jsonl");
        fs::write(&outside, "{\"type\":\"user\",\"sessionId\":\"CANARY_OUTSIDE\",\"cwd\":\"/canary\"}\n").unwrap();
        std::os::unix::fs::symlink(&cred, root.join("session.jsonl")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("proj/other.jsonl")).unwrap();
        std::os::unix::fs::symlink(outer.path(), root.join("linkdir")).unwrap();

        let link = root.join("session.jsonl");
        assert_eq!(parse_session_header("claude-code", &link).session_id, None);
        assert_eq!(read_first_non_empty_line(&link), None);
        assert_eq!(read_last_non_empty_line(&link), None);

        let mut found = Vec::new();
        find_session_files_recursively(&root, &mut found);
        assert!(found.is_empty(), "links are skipped by the walk: {found:?}");

        let mut roots = HashMap::new();
        roots.insert("claude-code".to_string(), root.clone());
        let config = LiveDetectorConfig { history_roots: roots, ..LiveDetectorConfig::default() };
        let mut detector = LiveDetector::new(config, Box::new(FakeProcessScanner::new(vec![])));
        detector.process_scan = false;
        assert!(detector.scan(now_unix_ms()).is_empty());
    }

    /// R-5 (r2 fix round 2): a project folder named like a key file (keychain-app) keeps its
    /// live session; a credential store or a key file under the history folder stays skipped.
    #[test]
    fn live_scanner_reads_a_project_folder_named_keychain() {
        let outer = crate::archive_api::testkit::tmp();
        let root = outer.path().join("history");
        let session = root.join("-Users-dev-code-keychain-app/session.jsonl");
        fs::create_dir_all(session.parent().unwrap()).unwrap();
        fs::write(&session, "{\"type\":\"user\",\"sessionId\":\"KEYCHAIN_APP_SID\",\"cwd\":\"/Users/dev/code/keychain-app\"}\n").unwrap();
        for refused in [".ssh/s.jsonl", "-Users-dev-x/.aws/s.jsonl", "-Users-dev-x/login.keychain.jsonl"] {
            let p = root.join(refused);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, "{\"type\":\"user\",\"sessionId\":\"CANARY_REFUSED\",\"cwd\":\"/canary\"}\n").unwrap();
        }
        assert_eq!(parse_session_header("claude-code", &session).session_id.as_deref(), Some("KEYCHAIN_APP_SID"));
        let mut found = Vec::new();
        find_session_files_recursively(&root, &mut found);
        let names: Vec<_> = found.iter().map(|(p, _)| p.clone()).collect();
        assert!(names.iter().any(|p| p.ends_with("-Users-dev-code-keychain-app/session.jsonl")), "{names:?}");
        assert_eq!(names.len(), 1, "credential stores and key files stay skipped: {names:?}");
    }

    #[test]
    fn test_rate_limiter_at_most_4_per_second() {
        let mut limiter = RateLimiter::new(Duration::from_millis(250));
        let t0 = Instant::now();

        assert!(limiter.can_emit(t0));
        limiter.record_emit(t0);

        let t1 = t0 + Duration::from_millis(100);
        assert!(!limiter.can_emit(t1));

        let t2 = t0 + Duration::from_millis(250);
        assert!(limiter.can_emit(t2));
    }

    #[test]
    fn test_state_since_preservation() {
        let dir = tempdir().unwrap();
        let session_file = dir.path().join("session.jsonl");
        fs::write(
            &session_file,
            "{\"type\":\"user\",\"sessionId\":\"s-since\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T15:00:00Z\"}\n{\"type\":\"assistant\",\"sessionId\":\"s-since\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T15:00:05Z\"}\n",
        ).unwrap();

        let mtime = fs::metadata(&session_file).unwrap().modified().unwrap();
        let mtime_ms = mtime.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;

        let mut roots = HashMap::new();
        roots.insert("claude-code".to_string(), dir.path().to_path_buf());
        let config = LiveDetectorConfig {
            history_roots: roots,
            active_window_secs: 600,
            idle_threshold_secs: 120,
            min_emit_interval: Duration::from_millis(250),
        };
        let scanner = Box::new(FakeProcessScanner::new(vec![ProcessInfo {
            pid: 1005,
            binary: "claude".to_string(),
            cwd: Some(PathBuf::from("/app")),
            started_at: None,
        }]));

        let mut detector = LiveDetector::new(config, scanner);
        let t1_ms = mtime_ms + 10_000;
        let list1 = detector.scan(t1_ms);
        assert_eq!(list1[0].since, Some(t1_ms));

        let t2_ms = mtime_ms + 20_000;
        let list2 = detector.scan(t2_ms);
        assert_eq!(list2[0].state, LiveState::Working);
        assert_eq!(list2[0].since, Some(t1_ms)); // Preserved since!
    }

    fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            let ty = entry.file_type()?;
            if ty.is_dir() {
                copy_dir_all(&entry.path(), &dst.join(entry.file_name()))?;
            } else {
                fs::copy(entry.path(), dst.join(entry.file_name()))?;
            }
        }
        Ok(())
    }

    #[test]
    fn test_synthetic_fixtures_detection_claude() {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let claude_fixture_dir = repo_root.join("fixtures/live/claude-code");
        assert!(claude_fixture_dir.exists());

        let temp = tempdir().unwrap();
        copy_dir_all(&claude_fixture_dir, temp.path()).unwrap();

        let mut roots = HashMap::new();
        roots.insert("claude-code".to_string(), temp.path().to_path_buf());

        let fake_procs = vec![
            ProcessInfo {
                pid: 2001,
                binary: "claude".to_string(),
                cwd: Some(PathBuf::from("/workspace/frontend")),
                started_at: None,
            },
            ProcessInfo {
                pid: 2002,
                binary: "claude".to_string(),
                cwd: Some(PathBuf::from("/workspace/backend")),
                started_at: None,
            },
            ProcessInfo {
                pid: 2003,
                binary: "claude".to_string(),
                cwd: Some(PathBuf::from("/workspace/cli-tool")),
                started_at: None,
            },
            ProcessInfo {
                pid: 2004,
                binary: "claude".to_string(),
                cwd: Some(PathBuf::from("/workspace/docs-site")),
                started_at: None,
            },
            // /workspace/finished-project has no process running
        ];

        let config = LiveDetectorConfig {
            history_roots: roots,
            active_window_secs: 7200,
            idle_threshold_secs: 120,
            min_emit_interval: Duration::from_millis(250),
        };
        let scanner = Box::new(FakeProcessScanner::new(fake_procs));
        let mut detector = LiveDetector::new(config, scanner);

        let test_now = SystemTime::now();
        let test_now_ms = test_now.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;

        let work_file = temp.path().join("projects/demo-working/session.jsonl");
        let f_work = fs::OpenOptions::new().write(true).open(&work_file).unwrap();
        f_work.set_modified(test_now).unwrap();

        let idle_file = temp.path().join("projects/demo-idle/session.jsonl");
        let f_idle = fs::OpenOptions::new().write(true).open(&idle_file).unwrap();
        f_idle.set_modified(test_now - Duration::from_secs(200)).unwrap();

        let perm_file = temp.path().join("projects/demo-waiting-perm/session.jsonl");
        let f_perm = fs::OpenOptions::new().write(true).open(&perm_file).unwrap();
        f_perm.set_modified(test_now - Duration::from_secs(30)).unwrap();

        let input_file = temp.path().join("projects/demo-waiting-input/session.jsonl");
        let f_input = fs::OpenOptions::new().write(true).open(&input_file).unwrap();
        f_input.set_modified(test_now - Duration::from_secs(40)).unwrap();

        let done_file = temp.path().join("projects/demo-done/session.jsonl");
        let f_done = fs::OpenOptions::new().write(true).open(&done_file).unwrap();
        f_done.set_modified(test_now - Duration::from_secs(60)).unwrap();

        let list = detector.scan(test_now_ms + 1_000);
        let state_by_pid: HashMap<u32, LiveState> = list
            .iter()
            .filter_map(|l| l.process.as_ref().map(|p| (p.pid, l.state)))
            .collect();

        assert_eq!(state_by_pid.get(&2001), Some(&LiveState::Working));
        assert_eq!(state_by_pid.get(&2002), Some(&LiveState::Idle));
        assert_eq!(state_by_pid.get(&2003), Some(&LiveState::Waiting));
        assert_eq!(state_by_pid.get(&2004), Some(&LiveState::Waiting));

        let done_session = list.iter().find(|l| l.process.is_none());
        assert!(done_session.is_some());
        assert_eq!(done_session.unwrap().state, LiveState::Done);
    }

    #[test]
    fn test_synthetic_fixtures_detection_codex() {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let codex_fixture_dir = repo_root.join("fixtures/live/codex-cli");
        assert!(codex_fixture_dir.exists());

        let temp = tempdir().unwrap();
        copy_dir_all(&codex_fixture_dir, temp.path()).unwrap();

        let mut roots = HashMap::new();
        roots.insert("codex-cli".to_string(), temp.path().to_path_buf());

        let fake_procs = vec![
            ProcessInfo {
                pid: 3001,
                binary: "codex".to_string(),
                cwd: Some(PathBuf::from("/projects/engine")),
                started_at: None,
            },
            ProcessInfo {
                pid: 3002,
                binary: "codex".to_string(),
                cwd: Some(PathBuf::from("/projects/parser")),
                started_at: None,
            },
            ProcessInfo {
                pid: 3003,
                binary: "codex".to_string(),
                cwd: Some(PathBuf::from("/projects/db-migrator")),
                started_at: None,
            },
            ProcessInfo {
                pid: 3004,
                binary: "codex".to_string(),
                cwd: Some(PathBuf::from("/projects/indexer")),
                started_at: None,
            },
            // /projects/old-task has no process running
        ];

        let config = LiveDetectorConfig {
            history_roots: roots,
            active_window_secs: 7200,
            idle_threshold_secs: 120,
            min_emit_interval: Duration::from_millis(250),
        };
        let scanner = Box::new(FakeProcessScanner::new(fake_procs));
        let mut detector = LiveDetector::new(config, scanner);

        let test_now = SystemTime::now();
        let test_now_ms = test_now.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;

        let work_file = temp.path().join("sessions/2026/10/12/rollout-work.jsonl");
        let f_work = fs::OpenOptions::new().write(true).open(&work_file).unwrap();
        f_work.set_modified(test_now).unwrap();

        let idle_file = temp.path().join("sessions/2026/10/12/rollout-idle.jsonl");
        let f_idle = fs::OpenOptions::new().write(true).open(&idle_file).unwrap();
        f_idle.set_modified(test_now - Duration::from_secs(200)).unwrap();

        let wait_appr_file = temp.path().join("sessions/2026/10/12/rollout-wait-approval.jsonl");
        let f_appr = fs::OpenOptions::new().write(true).open(&wait_appr_file).unwrap();
        f_appr.set_modified(test_now - Duration::from_secs(30)).unwrap();

        let wait_input_file = temp.path().join("sessions/2026/10/12/rollout-wait-input.jsonl");
        let f_input = fs::OpenOptions::new().write(true).open(&wait_input_file).unwrap();
        f_input.set_modified(test_now - Duration::from_secs(40)).unwrap();

        let done_file = temp.path().join("sessions/2026/10/12/rollout-done.jsonl");
        let f_done = fs::OpenOptions::new().write(true).open(&done_file).unwrap();
        f_done.set_modified(test_now - Duration::from_secs(60)).unwrap();

        let list = detector.scan(test_now_ms + 1_000);
        let state_by_pid: HashMap<u32, LiveState> = list
            .iter()
            .filter_map(|l| l.process.as_ref().map(|p| (p.pid, l.state)))
            .collect();

        assert_eq!(state_by_pid.get(&3001), Some(&LiveState::Working));
        assert_eq!(state_by_pid.get(&3002), Some(&LiveState::Idle));
        assert_eq!(state_by_pid.get(&3003), Some(&LiveState::Waiting));
        assert_eq!(state_by_pid.get(&3004), Some(&LiveState::Waiting));

        let done_session = list.iter().find(|l| l.process.is_none());
        assert!(done_session.is_some());
        assert_eq!(done_session.unwrap().state, LiveState::Done);
    }

    #[test]
    fn test_live_list_command() {
        let list = live_list_from(get_global_detector());
        assert!(list.is_ok());
    }

    #[test]
    fn test_process_without_cwd_is_never_evidence() {
        let dir = tempdir().unwrap();
        let session_file = dir.path().join("session.jsonl");
        fs::write(
            &session_file,
            "{\"type\":\"user\",\"sessionId\":\"s_no_cwd\",\"cwd\":\"/some/restricted/dir\",\"timestamp\":\"2026-10-12T15:00:00Z\"}\n",
        ).unwrap();

        let mtime = fs::metadata(&session_file).unwrap().modified().unwrap();
        let mtime_ms = mtime.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;

        let mut roots = HashMap::new();
        roots.insert("claude-code".to_string(), dir.path().to_path_buf());
        let config = LiveDetectorConfig {
            history_roots: roots,
            active_window_secs: 600,
            idle_threshold_secs: 120,
            min_emit_interval: Duration::from_millis(250),
        };
        // Process has cwd: None (the OS did not give it up): it must not count as evidence.
        let scanner = Box::new(FakeProcessScanner::new(vec![ProcessInfo {
            pid: 4001,
            binary: "claude".to_string(),
            cwd: None,
            started_at: None,
        }]));

        let mut detector = LiveDetector::new(config, scanner);
        let list = detector.scan(mtime_ms + 10_000);

        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, LiveState::Done);
        assert!(list[0].process.is_none());
    }

    fn claude_agent() -> KnownAgentConfig {
        KnownAgentConfig {
            agent_id: "claude-code".to_string(),
            binaries: vec!["claude".to_string()],
            history_patterns: Vec::new(),
        }
    }

    fn proc_at(pid: u32, cwd: Option<&str>) -> ProcessInfo {
        ProcessInfo {
            pid,
            binary: "claude".to_string(),
            cwd: cwd.map(PathBuf::from),
            started_at: None,
        }
    }

    #[test]
    fn test_process_cwd_under_root_matches() {
        let procs = vec![proc_at(10, Some("/x/proj/src/deep"))];
        let found = find_matching_process(&claude_agent(), Some("/x/proj"), &procs);
        assert_eq!(found.map(|p| p.pid), Some(10));
    }

    #[test]
    fn test_process_cwd_sibling_prefix_does_not_match() {
        let procs = vec![proc_at(11, Some("/x/project"))];
        assert!(find_matching_process(&claude_agent(), Some("/x/proj"), &procs).is_none());
        let procs = vec![proc_at(12, Some("/a/bc"))];
        assert!(find_matching_process(&claude_agent(), Some("/a/b"), &procs).is_none());
    }

    #[test]
    fn test_unknown_root_never_matches() {
        let procs = vec![proc_at(13, Some("/x/proj")), proc_at(14, None)];
        assert!(find_matching_process(&claude_agent(), None, &procs).is_none());
    }

    #[test]
    fn test_equal_path_with_trailing_slash_matches() {
        let procs = vec![proc_at(15, Some("/x/proj/"))];
        let found = find_matching_process(&claude_agent(), Some("/x/proj"), &procs);
        assert_eq!(found.map(|p| p.pid), Some(15));
        let procs = vec![proc_at(16, Some("/x/proj"))];
        let found = find_matching_process(&claude_agent(), Some("/x/proj/"), &procs);
        assert_eq!(found.map(|p| p.pid), Some(16));
    }

    #[test]
    fn test_root_missing_on_disk_still_matches_by_string() {
        let root = "/Users/fictional-dev/projects/skyline-weather";
        assert!(!Path::new(root).exists());
        let procs = vec![proc_at(17, Some("/Users/fictional-dev/projects/skyline-weather/src"))];
        let found = find_matching_process(&claude_agent(), Some(root), &procs);
        assert_eq!(found.map(|p| p.pid), Some(17));
    }

    #[test]
    fn test_binary_must_still_match() {
        let mut p = proc_at(18, Some("/x/proj"));
        p.binary = "codex".to_string();
        let procs = vec![p];
        assert!(find_matching_process(&claude_agent(), Some("/x/proj"), &procs).is_none());
    }

    #[test]
    fn test_process_scan_enabled_parsing() {
        assert!(process_scan_enabled(None));
        assert!(process_scan_enabled(Some("on")));
        assert!(process_scan_enabled(Some("")));
        assert!(process_scan_enabled(Some("1")));
        assert!(!process_scan_enabled(Some("off")));
        assert!(!process_scan_enabled(Some("OFF")));
        assert!(!process_scan_enabled(Some("Off")));
        assert!(!process_scan_enabled(Some("0")));
        assert!(!process_scan_enabled(Some("false")));
        assert!(!process_scan_enabled(Some("FALSE")));
    }

    #[test]
    fn test_disabled_scanner_returns_nothing() {
        let scanner = DisabledProcessScanner;
        assert!(scanner.scan(&["claude", "codex"]).is_empty());
    }

    fn scan_disabled_detector(dir: &Path, active_window_secs: u64) -> LiveDetector {
        let mut roots = HashMap::new();
        roots.insert("claude-code".to_string(), dir.to_path_buf());
        let config = LiveDetectorConfig {
            history_roots: roots,
            active_window_secs,
            idle_threshold_secs: 120,
            min_emit_interval: Duration::from_millis(250),
        };
        let mut detector = LiveDetector::new(config, Box::new(DisabledProcessScanner));
        detector.process_scan = false;
        detector
    }

    #[test]
    fn test_scan_off_recent_session_is_unknown_not_done() {
        let dir = tempdir().unwrap();
        let session_file = dir.path().join("session.jsonl");
        fs::write(
            &session_file,
            "{\"type\":\"user\",\"sessionId\":\"s_off\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T15:00:00Z\"}\n",
        ).unwrap();
        let mtime = fs::metadata(&session_file).unwrap().modified().unwrap();
        let mtime_ms = mtime.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;

        let mut detector = scan_disabled_detector(dir.path(), 600);
        let list = detector.scan(mtime_ms + 10_000);

        assert_eq!(list.len(), 1);
        let live = &list[0];
        assert_eq!(live.state, LiveState::Unknown);
        assert_eq!(live.confidence, Confidence::Low);
        assert!(live.process.is_none());
        assert_eq!(live.evidence.len(), 1);
        assert_eq!(live.evidence[0].kind, "file_activity");
        assert!(live.evidence.iter().all(|e| e.kind != "process_exit"));
        assert_eq!(live.expires_at, Some(mtime_ms + 600_000));
    }

    #[test]
    fn test_scan_off_old_session_is_not_listed() {
        let dir = tempdir().unwrap();
        let session_file = dir.path().join("session.jsonl");
        fs::write(
            &session_file,
            "{\"type\":\"user\",\"sessionId\":\"s_off_old\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T10:00:00Z\"}\n",
        ).unwrap();
        let mtime = fs::metadata(&session_file).unwrap().modified().unwrap();
        let mtime_ms = mtime.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;

        let mut detector = scan_disabled_detector(dir.path(), 600);
        assert!(detector.scan(mtime_ms + 1_200_000).is_empty());
    }

    fn sample_live(id: &str, state: LiveState, observed_at: i64) -> Live {
        Live {
            session_id: id.to_string(),
            state,
            since: Some(1_000),
            observed_at,
            evidence: vec![Evidence {
                kind: "process_and_activity".to_string(),
                detail: "d".to_string(),
                native_event_id: None,
                at: Some(500),
            }],
            confidence: Confidence::High,
            process: Some(ProcessIdentity { pid: 1, started_at: None }),
            expires_at: Some(9_000),
        }
    }

    #[test]
    fn test_lists_equivalent_ignores_only_observed_at() {
        let a = vec![sample_live("s1", LiveState::Working, 100)];
        let b = vec![sample_live("s1", LiveState::Working, 200)];
        assert!(live_lists_equivalent(&a, &b));

        let mut c = b.clone();
        c[0].since = Some(2_000);
        assert!(!live_lists_equivalent(&a, &c));
        let mut c = b.clone();
        c[0].expires_at = Some(9_001);
        assert!(!live_lists_equivalent(&a, &c));
        let mut c = b.clone();
        c[0].confidence = Confidence::Low;
        assert!(!live_lists_equivalent(&a, &c));
        let mut c = b.clone();
        c[0].process = None;
        assert!(!live_lists_equivalent(&a, &c));
        let mut c = b.clone();
        c[0].evidence[0].detail = "other".to_string();
        assert!(!live_lists_equivalent(&a, &c));
        assert!(!live_lists_equivalent(&a, &[]));
        assert!(live_lists_equivalent(&[], &[]));
    }

    #[test]
    fn test_emit_gate_first_list_emits_even_if_empty() {
        let mut gate = EmitGate::new();
        assert!(gate.should_emit(&[]));
        assert!(!gate.should_emit(&[]));
    }

    #[test]
    fn test_emit_gate_identical_except_observed_at_does_not_emit() {
        let mut gate = EmitGate::new();
        assert!(gate.should_emit(&[sample_live("s1", LiveState::Working, 100)]));
        assert!(!gate.should_emit(&[sample_live("s1", LiveState::Working, 2_100)]));
        assert!(!gate.should_emit(&[sample_live("s1", LiveState::Working, 4_100)]));
    }

    #[test]
    fn test_emit_gate_state_change_emits() {
        let mut gate = EmitGate::new();
        assert!(gate.should_emit(&[sample_live("s1", LiveState::Working, 100)]));
        assert!(gate.should_emit(&[sample_live("s1", LiveState::Idle, 2_100)]));
        assert!(!gate.should_emit(&[sample_live("s1", LiveState::Idle, 4_100)]));
    }

    #[test]
    fn test_emit_gate_removed_session_emits() {
        let mut gate = EmitGate::new();
        let two = vec![
            sample_live("s1", LiveState::Working, 100),
            sample_live("s2", LiveState::Idle, 100),
        ];
        assert!(gate.should_emit(&two));
        let one = vec![sample_live("s1", LiveState::Working, 2_100)];
        assert!(gate.should_emit(&one));
        assert!(gate.should_emit(&[]));
    }

    #[test]
    fn test_scan_interval_is_two_seconds() {
        assert_eq!(SCAN_INTERVAL, Duration::from_secs(2));
    }

    #[test]
    fn test_live_list_poisoned_lock_is_typed_live_failed() {
        let detector = Mutex::new(LiveDetector::new(
            LiveDetectorConfig::default(),
            Box::new(DisabledProcessScanner),
        ));
        std::thread::scope(|s| {
            let _ = s
                .spawn(|| {
                    let _guard = detector.lock().unwrap();
                    panic!("poison the lock on purpose");
                })
                .join();
        });
        let err = live_list_from(&detector).unwrap_err();
        assert_eq!(err.code, "live_failed");
        assert!(!err.message.is_empty());
    }

    #[test]
    fn test_waiting_state_remains_waiting_even_after_idle_timeout() {
        let dir = tempdir().unwrap();
        let session_file = dir.path().join("session.jsonl");
        fs::write(
            &session_file,
            "{\"type\":\"user\",\"sessionId\":\"s_wait_timeout\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T14:00:00Z\"}\n{\"type\":\"permission_prompt\",\"sessionId\":\"s_wait_timeout\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T14:00:05Z\"}\n",
        ).unwrap();

        let mtime = fs::metadata(&session_file).unwrap().modified().unwrap();
        let mtime_ms = mtime.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;

        let mut roots = HashMap::new();
        roots.insert("claude-code".to_string(), dir.path().to_path_buf());
        let config = LiveDetectorConfig {
            history_roots: roots,
            active_window_secs: 1200,
            idle_threshold_secs: 120,
            min_emit_interval: Duration::from_millis(250),
        };
        let scanner = Box::new(FakeProcessScanner::new(vec![ProcessInfo {
            pid: 5001,
            binary: "claude".to_string(),
            cwd: Some(PathBuf::from("/app")),
            started_at: None,
        }]));

        let mut detector = LiveDetector::new(config, scanner);
        // 600 seconds elapsed (way past the 120s idle threshold)
        let list = detector.scan(mtime_ms + 600_000);

        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, LiveState::Waiting);
    }

    #[test]
    fn test_old_done_session_filtered_out() {
        let dir = tempdir().unwrap();
        let session_file = dir.path().join("session.jsonl");
        fs::write(
            &session_file,
            "{\"type\":\"user\",\"sessionId\":\"s_old_done\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T10:00:00Z\"}\n",
        ).unwrap();

        let mtime = fs::metadata(&session_file).unwrap().modified().unwrap();
        let mtime_ms = mtime.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;

        let mut roots = HashMap::new();
        roots.insert("claude-code".to_string(), dir.path().to_path_buf());
        let config = LiveDetectorConfig {
            history_roots: roots,
            active_window_secs: 600, // 10 minutes window
            idle_threshold_secs: 120,
            min_emit_interval: Duration::from_millis(250),
        };
        // Process is gone
        let scanner = Box::new(FakeProcessScanner::new(vec![]));

        let mut detector = LiveDetector::new(config, scanner);
        // 20 minutes elapsed (> 10 minute active window)
        let list = detector.scan(mtime_ms + 1200_000);

        // Old done session should be filtered out from active live view
        assert_eq!(list.len(), 0);
    }

    #[test]
    fn test_multibyte_utf8_end_of_file_safety() {
        let dir = tempdir().unwrap();
        let session_file = dir.path().join("session_utf8.jsonl");
        let mut content = String::new();
        content.push_str("{\"type\":\"user\",\"sessionId\":\"s_utf8\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T15:00:00Z\"}\n");
        content.push_str("{\"type\":\"assistant\",\"message\":\"Observatory \u{1F52D} Star \u{2B50} \u{2728}\"}\n");
        content.push_str("{\"type\":\"idle_prompt\",\"sessionId\":\"s_utf8\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T15:00:05Z\"}\n");
        fs::write(&session_file, content).unwrap();

        let last_line = read_last_non_empty_line(&session_file);
        assert!(last_line.is_some());
        assert!(last_line.unwrap().contains("idle_prompt"));
        assert!(is_waiting_record("claude-code", &session_file));
    }

    #[test]
    fn test_no_em_or_en_dashes_in_source() {
        let source = include_str!("live.rs");
        assert!(!source.contains('\u{2014}'), "Source code must not contain em dashes");
        assert!(!source.contains('\u{2013}'), "Source code must not contain en dashes");
    }

    #[test]
    fn test_contract_live_shape_and_evidence() {
        let dir = tempdir().unwrap();
        let session_file = dir.path().join("session.jsonl");
        fs::write(
            &session_file,
            "{\"type\":\"user\",\"sessionId\":\"s_g2\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T15:00:00Z\"}\n{\"type\":\"assistant\",\"sessionId\":\"s_g2\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T15:00:05Z\"}\n",
        ).unwrap();

        let mtime = fs::metadata(&session_file).unwrap().modified().unwrap();
        let mtime_ms = mtime.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;

        let mut roots = HashMap::new();
        roots.insert("claude-code".to_string(), dir.path().to_path_buf());
        let config = LiveDetectorConfig {
            history_roots: roots,
            active_window_secs: 600,
            idle_threshold_secs: 120,
            min_emit_interval: Duration::from_millis(250),
        };
        let scanner = Box::new(FakeProcessScanner::new(vec![ProcessInfo {
            pid: 7001,
            binary: "claude".to_string(),
            cwd: Some(PathBuf::from("/app")),
            started_at: Some(mtime_ms - 20_000),
        }]));

        let mut detector = LiveDetector::new(config.clone(), scanner);
        let now_ms = mtime_ms + 10_000;
        let list = detector.scan(now_ms);

        assert_eq!(list.len(), 1);
        let live = &list[0];
        assert_eq!(live.observed_at, now_ms);
        assert_eq!(live.confidence, orrery_adapters::Confidence::High);
        assert!(!live.evidence.is_empty());
        assert_eq!(live.evidence[0].kind, "process_and_activity");
        assert_eq!(live.process.as_ref().map(|p| p.pid), Some(7001));
        assert_eq!(
            live.process.as_ref().and_then(|p| p.started_at),
            Some(mtime_ms - 20_000)
        );
        assert_eq!(
            live.expires_at,
            Some(mtime_ms + (config.active_window_secs * 1000) as i64)
        );
    }

    #[test]
    fn test_stale_observation_expired_without_inferring_completion() {
        let dir = tempdir().unwrap();
        let session_file = dir.path().join("session_stale.jsonl");
        fs::write(
            &session_file,
            "{\"type\":\"user\",\"sessionId\":\"s_stale\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T10:00:00Z\"}\n",
        ).unwrap();

        let mtime = fs::metadata(&session_file).unwrap().modified().unwrap();
        let mtime_ms = mtime.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;

        let mut roots = HashMap::new();
        roots.insert("claude-code".to_string(), dir.path().to_path_buf());
        let config = LiveDetectorConfig {
            history_roots: roots,
            active_window_secs: 300, // 5 minutes
            idle_threshold_secs: 60,
            min_emit_interval: Duration::from_millis(250),
        };
        // Process is dead
        let scanner = Box::new(FakeProcessScanner::new(vec![]));
        let mut detector = LiveDetector::new(config, scanner);

        // Within active window: observed as Done with process_exit evidence
        let list_recent = detector.scan(mtime_ms + 100_000);
        assert_eq!(list_recent.len(), 1);
        assert_eq!(list_recent[0].state, LiveState::Done);
        assert_eq!(list_recent[0].confidence, Confidence::Medium);

        // Beyond active window: observation has expired without inferring completion
        let list_expired = detector.scan(mtime_ms + 400_000);
        assert_eq!(list_expired.len(), 0);
    }

    #[test]
    fn test_waiting_requires_reliable_native_signal() {
        let dir = tempdir().unwrap();
        let session_file = dir.path().join("session_active.jsonl");
        fs::write(
            &session_file,
            "{\"type\":\"user\",\"sessionId\":\"s_active\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T15:00:00Z\"}\n{\"type\":\"assistant\",\"sessionId\":\"s_active\",\"cwd\":\"/app\",\"timestamp\":\"2026-10-12T15:00:05Z\"}\n",
        ).unwrap();

        let mtime = fs::metadata(&session_file).unwrap().modified().unwrap();
        let mtime_ms = mtime.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;

        let mut roots = HashMap::new();
        roots.insert("claude-code".to_string(), dir.path().to_path_buf());
        let config = LiveDetectorConfig {
            history_roots: roots,
            active_window_secs: 600,
            idle_threshold_secs: 120,
            min_emit_interval: Duration::from_millis(250),
        };
        let scanner = Box::new(FakeProcessScanner::new(vec![ProcessInfo {
            pid: 8001,
            binary: "claude".to_string(),
            cwd: Some(PathBuf::from("/app")),
            started_at: None,
        }]));
        let mut detector = LiveDetector::new(config, scanner);

        let list = detector.scan(mtime_ms + 5_000);
        assert_eq!(list.len(), 1);
        // Without native waiting signal, state MUST be Working, NEVER Waiting!
        assert_ne!(list[0].state, LiveState::Waiting);
        assert_eq!(list[0].state, LiveState::Working);
    }

    // ---- one process is evidence for at most one session ----

    fn write_claude_session(
        dir: &Path,
        file_name: &str,
        session_id: &str,
        cwd: &str,
        waiting: bool,
        mtime: SystemTime,
    ) -> PathBuf {
        let path = dir.join(file_name);
        let mut content = format!(
            "{{\"type\":\"user\",\"sessionId\":\"{id}\",\"cwd\":\"{cwd}\",\"timestamp\":\"2026-10-12T15:00:00Z\"}}\n",
            id = session_id,
            cwd = cwd
        );
        if waiting {
            content.push_str(&format!(
                "{{\"type\":\"permission_prompt\",\"sessionId\":\"{id}\",\"cwd\":\"{cwd}\",\"timestamp\":\"2026-10-12T15:00:05Z\"}}\n",
                id = session_id,
                cwd = cwd
            ));
        }
        fs::write(&path, content).unwrap();
        let f = fs::OpenOptions::new().write(true).open(&path).unwrap();
        f.set_modified(mtime).unwrap();
        path
    }

    fn claim_detector(dir: &Path, procs: Vec<ProcessInfo>) -> LiveDetector {
        let mut roots = HashMap::new();
        roots.insert("claude-code".to_string(), dir.to_path_buf());
        let config = LiveDetectorConfig {
            history_roots: roots,
            active_window_secs: 600,
            idle_threshold_secs: 120,
            min_emit_interval: Duration::from_millis(250),
        };
        LiveDetector::new(config, Box::new(FakeProcessScanner::new(procs)))
    }

    fn claude_proc(pid: u32, cwd: &str) -> ProcessInfo {
        ProcessInfo {
            pid,
            binary: "claude".to_string(),
            cwd: Some(PathBuf::from(cwd)),
            started_at: None,
        }
    }

    fn expected_session_id(detector: &LiveDetector, path: &Path, native_id: &str) -> String {
        let agent = detector
            .known_agents
            .iter()
            .find(|a| a.agent_id == "claude-code")
            .unwrap()
            .clone();
        contract_session_id(&agent, path, native_id, Some(&detector.config.history_roots))
    }

    fn ms(t: SystemTime) -> i64 {
        t.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
    }

    #[test]
    fn test_one_process_claims_only_the_newest_session_file() {
        let dir = tempdir().unwrap();
        let now = SystemTime::now();
        let newest = write_claude_session(dir.path(), "new.jsonl", "c-new", "/proj", false, now - Duration::from_secs(30));
        let _mid = write_claude_session(dir.path(), "mid.jsonl", "c-mid", "/proj", false, now - Duration::from_secs(900));
        let _old = write_claude_session(dir.path(), "old.jsonl", "c-old", "/proj", false, now - Duration::from_secs(5000));

        let mut detector = claim_detector(dir.path(), vec![claude_proc(6001, "/proj")]);
        let list = detector.scan(ms(now));

        assert_eq!(list.len(), 1, "one process is evidence for one session only: {:?}", list);
        assert_eq!(list[0].session_id, expected_session_id(&detector, &newest, "c-new"));
        assert_eq!(list[0].process.as_ref().map(|p| p.pid), Some(6001));
        assert_eq!(list[0].state, LiveState::Working);
    }

    #[test]
    fn test_two_processes_claim_the_two_newest_files_one_pid_each() {
        let dir = tempdir().unwrap();
        let now = SystemTime::now();
        let newest = write_claude_session(dir.path(), "a.jsonl", "c-a", "/proj", false, now - Duration::from_secs(20));
        let second = write_claude_session(dir.path(), "b.jsonl", "c-b", "/proj", false, now - Duration::from_secs(60));
        let _third = write_claude_session(dir.path(), "c.jsonl", "c-c", "/proj", false, now - Duration::from_secs(300));

        let mut detector = claim_detector(
            dir.path(),
            vec![claude_proc(6101, "/proj"), claude_proc(6102, "/proj/src")],
        );
        let list = detector.scan(ms(now));

        assert_eq!(list.len(), 2, "the third file has no process left: {:?}", list);
        let id_newest = expected_session_id(&detector, &newest, "c-a");
        let id_second = expected_session_id(&detector, &second, "c-b");
        let live_newest = list.iter().find(|l| l.session_id == id_newest).expect("newest listed");
        let live_second = list.iter().find(|l| l.session_id == id_second).expect("second listed");
        let pid_newest = live_newest.process.as_ref().map(|p| p.pid).unwrap();
        let pid_second = live_second.process.as_ref().map(|p| p.pid).unwrap();
        assert_ne!(pid_newest, pid_second, "each process claims at most one session");
        // The newest file takes the first matching process in scanner order.
        assert_eq!(pid_newest, 6101);
        assert_eq!(pid_second, 6102);
    }

    #[test]
    fn test_waiting_file_older_than_window_stays_waiting_when_newest_for_its_process() {
        let dir = tempdir().unwrap();
        let now = SystemTime::now();
        // Active window is 600s. The waiting file is 2000s old but is the newest file in /proj.
        let waiting = write_claude_session(dir.path(), "wait.jsonl", "c-wait", "/proj", true, now - Duration::from_secs(2000));
        let _older = write_claude_session(dir.path(), "older.jsonl", "c-older", "/proj", false, now - Duration::from_secs(4000));

        let mut detector = claim_detector(dir.path(), vec![claude_proc(6201, "/proj")]);
        let list = detector.scan(ms(now));

        assert_eq!(list.len(), 1, "the older file is not listed: {:?}", list);
        assert_eq!(list[0].session_id, expected_session_id(&detector, &waiting, "c-wait"));
        assert_eq!(list[0].state, LiveState::Waiting);
        assert_eq!(list[0].process.as_ref().map(|p| p.pid), Some(6201));
    }

    #[test]
    fn test_other_binary_does_not_claim_claude_files() {
        let dir = tempdir().unwrap();
        let now = SystemTime::now();
        let recent = write_claude_session(dir.path(), "recent.jsonl", "c-recent", "/proj", false, now - Duration::from_secs(30));
        let _old = write_claude_session(dir.path(), "old.jsonl", "c-old2", "/proj", false, now - Duration::from_secs(5000));

        let codex = ProcessInfo {
            pid: 6301,
            binary: "codex".to_string(),
            cwd: Some(PathBuf::from("/proj")),
            started_at: None,
        };
        let mut detector = claim_detector(dir.path(), vec![codex]);
        let list = detector.scan(ms(now));

        // The codex process is no evidence for claude files: recent one is Done, old one dropped.
        assert_eq!(list.len(), 1, "{:?}", list);
        assert_eq!(list[0].session_id, expected_session_id(&detector, &recent, "c-recent"));
        assert_eq!(list[0].state, LiveState::Done);
        assert!(list[0].process.is_none());
    }

    #[test]
    fn test_equal_mtimes_assign_by_path_deterministically() {
        let dir = tempdir().unwrap();
        let now = SystemTime::now();
        let same = now - Duration::from_secs(40);
        let first = write_claude_session(dir.path(), "a-first.jsonl", "c-first", "/proj", false, same);
        let _second = write_claude_session(dir.path(), "b-second.jsonl", "c-second", "/proj", false, same);

        for _ in 0..5 {
            let mut detector = claim_detector(dir.path(), vec![claude_proc(6401, "/proj")]);
            let list = detector.scan(ms(now));
            assert_eq!(list.len(), 1, "{:?}", list);
            assert_eq!(list[0].session_id, expected_session_id(&detector, &first, "c-first"));
            assert_eq!(list[0].process.as_ref().map(|p| p.pid), Some(6401));
        }
    }

    #[test]
    fn test_running_scan_stops_immediately_when_stop_is_set() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        struct StoppingScanner {
            stop: Arc<AtomicBool>,
            procs: Vec<ProcessInfo>,
        }
        impl ProcessScanner for StoppingScanner {
            fn scan(&self, _known_binaries: &[&str]) -> Vec<ProcessInfo> {
                self.stop.store(true, Ordering::SeqCst);
                self.procs.clone()
            }
        }

        let dir = tempdir().unwrap();
        let now = SystemTime::now();
        let _s1 = write_claude_session(dir.path(), "s1.jsonl", "c-1", "/proj", false, now - Duration::from_secs(10));
        let stop = Arc::new(AtomicBool::new(false));
        let mut roots = HashMap::new();
        roots.insert("claude-code".to_string(), dir.path().to_path_buf());
        let config = LiveDetectorConfig {
            history_roots: roots,
            active_window_secs: 600,
            idle_threshold_secs: 120,
            min_emit_interval: Duration::from_millis(250),
        };
        let mut detector = LiveDetector::new(
            config,
            Box::new(StoppingScanner {
                stop: stop.clone(),
                procs: vec![claude_proc(6501, "/proj")],
            }),
        );
        assert!(
            detector.scan_until(ms(now), &stop).is_none(),
            "a live scan pass must stop immediately when stop is set during the pass"
        );
    }
}
