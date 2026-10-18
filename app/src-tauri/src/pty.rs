use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

use orrery_adapters::env::{SystemEnvironment, SystemFileSystem};
use orrery_adapters::{detect_agent, get_builtin_adapter, Environment, FileSystem, TargetOs};

/// Expands a leading "~" to the user's home folder, so the Launchpad's default
/// "~/Projects/..." style paths work. Any other path is used as given.
fn expand_home(path: &str) -> PathBuf {
    if path == "~" || path.starts_with("~/") {
        if let Some(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok() {
            return PathBuf::from(home).join(path.trim_start_matches('~').trim_start_matches('/'));
        }
    }
    PathBuf::from(path)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyError {
    DisallowedAgent(String),
    NotCliAgent(String),
    AgentNotInstalled(String),
    /// A generic binary name was found on PATH but nothing corroborates it (id, reason).
    AgentNotCorroborated(String, String),
    InvalidCwd(String),
    /// The working folder exists but is not inside a folder the app may start programs in.
    CwdNotApproved(String),
    /// The resolved program is not a real executable file.
    BadExecutable(String),
    PtySystem(String),
    SpawnError(String, String),
    SessionNotFound(String),
    Io(String),
    /// The user has not given Armillary access (first-run consent): nothing was looked up.
    ConsentRequired,
}

impl std::fmt::Display for PtyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PtyError::DisallowedAgent(id) => write!(f, "Disallowed agent ID: {}", id),
            PtyError::NotCliAgent(id) => write!(f, "Agent '{}' is not a CLI agent", id),
            PtyError::AgentNotInstalled(id) => {
                write!(f, "Agent '{}' is not installed, or no launchable program was found for it", id)
            }
            PtyError::AgentNotCorroborated(id, reason) => {
                write!(f, "Agent '{}' cannot be launched: {}", id, reason)
            }
            PtyError::CwdNotApproved(path) => {
                write!(f, "Working directory is outside the folders Armillary may start programs in: {}", path)
            }
            PtyError::BadExecutable(path) => {
                write!(f, "Not a launchable program: {}", path)
            }
            PtyError::InvalidCwd(path) => {
                write!(f, "Working directory does not exist or is not a directory: {}", path)
            }
            PtyError::PtySystem(e) => write!(f, "Failed to open PTY pair: {}", e),
            PtyError::SpawnError(prog, e) => write!(f, "Failed to spawn process '{}': {}", prog, e),
            PtyError::SessionNotFound(id) => write!(f, "Session not found: {}", id),
            PtyError::Io(e) => write!(f, "PTY I/O error: {}", e),
            PtyError::ConsentRequired => {
                write!(f, "Armillary has not been given access to your agent folders")
            }
        }
    }
}

impl std::error::Error for PtyError {}

impl Serialize for PtyError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        // The consent error carries the same machine-readable code as every other command, so
        // the UI can show its "not given access" state; the rest stay plain sentences.
        if let PtyError::ConsentRequired = self {
            use serde::ser::SerializeStruct;
            let mut st = serializer.serialize_struct("ApiError", 2)?;
            st.serialize_field("code", "consent_required")?;
            st.serialize_field("message", &self.to_string())?;
            return st.end();
        }
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for PtyError {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(PtyError::DisallowedAgent(s))
    }
}

impl PtyError {
    pub fn contains(&self, needle: &str) -> bool {
        self.to_string().contains(needle)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PtySessionInfo {
    pub id: String,
    pub agent_id: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PtyDataPayload {
    pub id: String,
    pub data: String,
}

struct ActiveSession {
    #[allow(dead_code)]
    pub info: PtySessionInfo,
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Owns every live session. When the last clone of the manager goes away (the app is
/// exiting) every session's whole process group is terminated, so no agent outlives Armillary.
struct Sessions(Mutex<HashMap<String, ActiveSession>>);

impl Drop for Sessions {
    fn drop(&mut self) {
        if let Ok(map) = self.0.get_mut() {
            for (_, mut session) in map.drain() {
                terminate(&mut session.child);
            }
        }
    }
}

#[derive(Clone)]
pub struct PtySessionManager {
    sessions: Arc<Sessions>,
    next_id: Arc<Mutex<u64>>,
    /// Folders programs may be started in, besides the user's home folder. Only Rust code can
    /// widen this (no command does), so page content can never approve a folder for itself.
    extra_roots: Arc<Mutex<Vec<PathBuf>>>,
    /// When set, replaces the home folder as the base root (tests).
    base_roots: Option<Vec<PathBuf>>,
}

impl Default for PtySessionManager {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Sessions(Mutex::new(HashMap::new()))),
            next_id: Arc::new(Mutex::new(1)),
            extra_roots: Arc::new(Mutex::new(Vec::new())),
            base_roots: None,
        }
    }
}

/// Resolves `path` to the real file it names (symlinks followed) and checks it is an absolute
/// path to a regular, executable file. The launch uses this exact path, never a bare name.
pub fn canonical_executable(path: &Path) -> Result<PathBuf, PtyError> {
    let bad = || PtyError::BadExecutable(path.to_string_lossy().to_string());
    if !path.is_absolute() {
        return Err(bad());
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| bad())?;
    let meta = std::fs::metadata(&canonical).map_err(|_| bad())?;
    if !meta.is_file() {
        return Err(bad());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return Err(bad());
        }
    }
    Ok(canonical)
}

/// Every process whose session is `sid`. portable-pty makes the child a session leader, and a
/// job-control shell puts background jobs in their own process groups inside that session, so
/// the group alone does not reach them.
#[cfg(unix)]
fn session_members(sid: i32) -> Vec<i32> {
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    system
        .processes()
        .values()
        .filter(|p| p.session_id().map(|s| s.as_u32() as i32) == Some(sid))
        .map(|p| p.pid().as_u32() as i32)
        .filter(|pid| *pid > 1)
        .collect()
}

/// Ends a session's process: hang up the process group and the whole session (the program and
/// everything it started, including job-control background jobs), give it a moment to leave,
/// then kill whatever is left and reap the child.
fn terminate(child: &mut Box<dyn portable_pty::Child + Send + Sync>) {
    #[cfg(unix)]
    {
        if let Some(leader) = child.process_id().map(|pid| pid as i32).filter(|pid| *pid > 1) {
            // SAFETY: plain signal delivery to the child's own process group and to processes
            // that are members of the child's own session.
            unsafe {
                libc::kill(-leader, libc::SIGHUP);
            }
            for pid in session_members(leader) {
                unsafe {
                    libc::kill(pid, libc::SIGHUP);
                }
            }
            for _ in 0..10 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
            unsafe {
                libc::kill(-leader, libc::SIGKILL);
            }
            // Twice: a process may have forked between looking and killing.
            for _ in 0..2 {
                for pid in session_members(leader) {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                }
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

impl PtySessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// A manager whose only approved folders are `roots` (used by tests).
    pub fn with_roots(roots: Vec<PathBuf>) -> Self {
        Self {
            base_roots: Some(roots),
            ..Self::default()
        }
    }

    /// Adds a folder the user picked. Must be an existing directory; stored canonical.
    pub fn approve_root(&self, path: &Path) -> Result<(), PtyError> {
        let canonical = std::fs::canonicalize(path)
            .map_err(|_| PtyError::InvalidCwd(path.to_string_lossy().to_string()))?;
        if !canonical.is_dir() {
            return Err(PtyError::InvalidCwd(path.to_string_lossy().to_string()));
        }
        let mut roots = self.extra_roots.lock().unwrap();
        if !roots.contains(&canonical) {
            roots.push(canonical);
        }
        Ok(())
    }

    fn approved_roots(&self) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = match &self.base_roots {
            Some(base) => base.clone(),
            None => std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .ok()
                .map(PathBuf::from)
                .into_iter()
                .collect(),
        };
        roots.extend(self.extra_roots.lock().unwrap().iter().cloned());
        roots
            .into_iter()
            .filter_map(|r| std::fs::canonicalize(r).ok())
            .collect()
    }

    /// The working folder for a new session: required, an existing directory, and, once
    /// symlinks and `..` are resolved, inside an approved folder (the user's home folder, or a
    /// folder approved with `approve_root`). Returns the canonical path.
    pub fn approved_cwd(&self, cwd: Option<&str>) -> Result<PathBuf, PtyError> {
        let requested = match cwd.map(str::trim) {
            Some(dir) if !dir.is_empty() => dir,
            _ => {
                return Err(PtyError::InvalidCwd(
                    "A working folder is required".to_string(),
                ))
            }
        };
        let path = expand_home(requested);
        let canonical = std::fs::canonicalize(&path).map_err(|_| {
            PtyError::InvalidCwd(format!("Working directory does not exist: {}", requested))
        })?;
        if !canonical.is_dir() {
            return Err(PtyError::InvalidCwd(format!(
                "Working directory is not a directory: {}",
                requested
            )));
        }
        if self.approved_roots().iter().any(|root| canonical.starts_with(root)) {
            Ok(canonical)
        } else {
            Err(PtyError::CwdNotApproved(requested.to_string()))
        }
    }

    /// Resolves executable and arguments for a given agent_id or command
    pub fn resolve_command(agent_id: &str) -> Result<(PathBuf, Vec<String>), PtyError> {
        Self::resolve_command_with_env(agent_id, &SystemEnvironment, &SystemFileSystem)
    }

    pub fn resolve_command_with_env(
        agent_id: &str,
        env: &dyn Environment,
        fs: &dyn FileSystem,
    ) -> Result<(PathBuf, Vec<String>), PtyError> {
        // Reject empty string or whitespace
        if agent_id.is_empty() || agent_id.chars().any(|c| c.is_whitespace()) {
            return Err(PtyError::DisallowedAgent(agent_id.to_string()));
        }

        // Reject dangerous shell metacharacters and path traversal
        if agent_id.chars().any(|c| {
            matches!(
                c,
                ';' | '$'
                    | '`'
                    | '('
                    | ')'
                    | '&'
                    | '|'
                    | '<'
                    | '>'
                    | '"'
                    | '\''
                    | '*'
                    | '?'
                    | '['
                    | ']'
                    | '{'
                    | '}'
                    | '/'
                    | '\\'
            )
        }) || agent_id.contains("..")
        {
            return Err(PtyError::DisallowedAgent(agent_id.to_string()));
        }

        // Option (b): Literal "shell" starts the user's login shell
        if agent_id == "shell" {
            let shell_path = match env.var("SHELL") {
                Some(s) if !s.trim().is_empty() && fs.exists(Path::new(s.trim())) => {
                    PathBuf::from(s.trim())
                }
                _ => {
                    if env.os() == TargetOs::Windows {
                        env.var("COMSPEC")
                            .map(PathBuf::from)
                            .unwrap_or_else(|| PathBuf::from("powershell.exe"))
                    } else {
                        let candidates = ["/bin/zsh", "/bin/bash", "/bin/sh"];
                        candidates
                            .iter()
                            .map(PathBuf::from)
                            .find(|p| fs.exists(p))
                            .unwrap_or_else(|| PathBuf::from("/bin/sh"))
                    }
                }
            };
            return Ok((shell_path, vec![]));
        }

        // Option (a): CLI agent from the adapter registry
        let spec = get_builtin_adapter(agent_id)
            .ok_or_else(|| PtyError::DisallowedAgent(agent_id.to_string()))?;

        if spec.kind != "cli" {
            return Err(PtyError::NotCliAgent(agent_id.to_string()));
        }

        // The same passive detection the agent list uses decides what may be launched: a generic
        // name on PATH is only launchable with the agent's own evidence next to it.
        let detection = detect_agent(&spec, env, fs);
        if let Some(executable) = detection.executable {
            return Ok((executable, vec![]));
        }
        match detection.reason {
            Some(reason) => Err(PtyError::AgentNotCorroborated(agent_id.to_string(), reason)),
            None => Err(PtyError::AgentNotInstalled(agent_id.to_string())),
        }
    }

    /// Opens a new PTY session and spawns the background reader thread
    pub fn open_session<F>(
        &self,
        agent_id: &str,
        cwd: Option<&str>,
        cols: Option<u16>,
        rows: Option<u16>,
        on_data: F,
    ) -> Result<PtySessionInfo, PtyError>
    where
        F: Fn(PtyDataPayload) + Send + 'static,
    {
        self.open_session_with_env(
            agent_id,
            cwd,
            cols,
            rows,
            &SystemEnvironment,
            &SystemFileSystem,
            on_data,
        )
    }

    /// `open_session_with_env` behind the first-run consent check: without consent no program is
    /// looked up on PATH or in the agent folders.
    #[allow(clippy::too_many_arguments)]
    pub fn open_session_gated<F>(
        &self,
        data_dir: &Path,
        agent_id: &str,
        cwd: Option<&str>,
        cols: Option<u16>,
        rows: Option<u16>,
        env: &dyn Environment,
        fs: &dyn FileSystem,
        on_data: F,
    ) -> Result<PtySessionInfo, PtyError>
    where
        F: Fn(PtyDataPayload) + Send + 'static,
    {
        if !crate::archive_api::consent::recorded(data_dir) {
            return Err(PtyError::ConsentRequired);
        }
        self.open_session_with_env(agent_id, cwd, cols, rows, env, fs, on_data)
    }

    pub fn open_session_with_env<F>(
        &self,
        agent_id: &str,
        cwd: Option<&str>,
        cols: Option<u16>,
        rows: Option<u16>,
        env: &dyn Environment,
        fs: &dyn FileSystem,
        on_data: F,
    ) -> Result<PtySessionInfo, PtyError>
    where
        F: Fn(PtyDataPayload) + Send + 'static,
    {
        // The program is checked first, then the folder; the program is resolved to the exact
        // canonical file that will be started.
        let (prog, args) = Self::resolve_command_with_env(agent_id, env, fs)?;
        let prog = canonical_executable(&prog)?;
        let working_dir = self.approved_cwd(cwd)?;

        let session_num = {
            let mut id_lock = self.next_id.lock().unwrap();
            let cur = *id_lock;
            *id_lock += 1;
            cur
        };
        let session_id = format!("pty-{}", session_num);

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.unwrap_or(24),
                cols: cols.unwrap_or(80),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::PtySystem(e.to_string()))?;

        let mut cmd = CommandBuilder::new(&prog);
        for arg in &args {
            cmd.arg(arg);
        }
        cmd.cwd(&working_dir);

        // Inherit standard environment
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::SpawnError(prog.to_string_lossy().to_string(), e.to_string()))?;

        // Drop slave in parent process so EOF will propagate to reader
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PtyError::Io(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PtyError::Io(e.to_string()))?;

        let info = PtySessionInfo {
            id: session_id.clone(),
            agent_id: agent_id.to_string(),
            cwd: working_dir.to_string_lossy().to_string(),
        };

        let session = ActiveSession {
            info: info.clone(),
            master: pair.master,
            writer,
            child,
        };

        {
            let mut sessions = self.sessions.0.lock().unwrap();
            sessions.insert(session_id.clone(), session);
        }

        // Spawn background thread to stream output
        let thread_session_id = session_id;
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF reached
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        on_data(PtyDataPayload {
                            id: thread_session_id.clone(),
                            data: text,
                        });
                    }
                    Err(_) => break, // Process exited or terminal closed
                }
            }
        });

        Ok(info)
    }

    /// Writes data to an active PTY session
    pub fn write_session(&self, id: &str, data: &str) -> Result<(), PtyError> {
        let mut sessions = self.sessions.0.lock().unwrap();
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| PtyError::SessionNotFound(id.to_string()))?;

        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| PtyError::Io(e.to_string()))?;
        session
            .writer
            .flush()
            .map_err(|e| PtyError::Io(e.to_string()))?;
        Ok(())
    }

    /// Resizes an active PTY session
    pub fn resize_session(&self, id: &str, cols: u16, rows: u16) -> Result<(), PtyError> {
        let sessions = self.sessions.0.lock().unwrap();
        let session = sessions
            .get(id)
            .ok_or_else(|| PtyError::SessionNotFound(id.to_string()))?;

        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::PtySystem(e.to_string()))?;
        Ok(())
    }

    /// Closes an active PTY session and kills its process
    pub fn close_session(&self, id: &str) -> Result<(), PtyError> {
        let mut sessions = self.sessions.0.lock().unwrap();
        let mut session = sessions
            .remove(id)
            .ok_or_else(|| PtyError::SessionNotFound(id.to_string()))?;

        terminate(&mut session.child);
        Ok(())
    }

    /// Terminates every live session's process group (called when the app exits). Returns how
    /// many sessions were closed.
    pub fn close_all(&self) -> usize {
        let mut sessions = self.sessions.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut closed = 0;
        for (_, mut session) in sessions.drain() {
            terminate(&mut session.child);
            closed += 1;
        }
        closed
    }

    /// Checks if a session exists
    pub fn has_session(&self, id: &str) -> bool {
        let sessions = self.sessions.0.lock().unwrap();
        sessions.contains_key(id)
    }
}

#[derive(Clone, Default)]
pub struct PtyState {
    pub manager: PtySessionManager,
}

#[tauri::command]
pub fn pty_open(
    state: tauri::State<PtyState>,
    app_handle: tauri::AppHandle,
    agent_id: Option<String>,
    #[allow(non_snake_case)]
    agentId: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<PtySessionInfo, PtyError> {
    let resolved_agent = agent_id
        .or(agentId)
        .ok_or_else(|| PtyError::DisallowedAgent("Missing agent ID".to_string()))?;

    let data_dir = crate::archive_api::app_data_dir_of(&app_handle)
        .map_err(|e| PtyError::Io(e.message))?;
    let app = app_handle.clone();
    state.manager.open_session_gated(
        &data_dir,
        &resolved_agent,
        cwd.as_deref(),
        cols,
        rows,
        &SystemEnvironment,
        &SystemFileSystem,
        move |payload| {
            let _ = app.emit("pty:data", &payload);
        },
    )
}

#[tauri::command]
pub fn pty_write(
    state: tauri::State<PtyState>,
    id: String,
    data: String,
) -> Result<(), PtyError> {
    state.manager.write_session(&id, &data)
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), PtyError> {
    state.manager.resize_session(&id, cols, rows)
}

#[tauri::command]
pub fn pty_close(state: tauri::State<PtyState>, id: String) -> Result<(), PtyError> {
    state.manager.close_session(&id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use orrery_adapters::{MockEnvironment, MockFileSystem};
    use std::sync::mpsc;
    use std::time::Duration;

    /// R2-REV-1: the Launchpad's program discovery refuses after "Not now" and touches no file.
    #[test]
    fn pty_open_refuses_after_decline_before_discovery() {
        use crate::archive_api::testkit::{tmp, write_declined, CountingFs};
        let data = tmp();
        let home = tmp();
        let env = MockEnvironment::new(orrery_adapters::TargetOs::current(), home.path().to_str().unwrap());
        let manager = PtySessionManager::new();
        for declined in [false, true] {
            if declined {
                write_declined(data.path());
            }
            let fs = CountingFs::new(home.path());
            let err = manager
                .open_session_gated(data.path(), "claude-code", None, None, None, &env, &fs, |_| {})
                .unwrap_err();
            assert_eq!(err, PtyError::ConsentRequired);
            assert_eq!(fs.count(), 0, "no discovery without consent");
            let json = serde_json::to_value(&err).unwrap();
            assert_eq!(json["code"], "consent_required");
        }
    }

    #[test]
    fn test_injection_spaces_rejected() {
        assert!(matches!(
            PtySessionManager::resolve_command("sh -c whoami"),
            Err(PtyError::DisallowedAgent(_))
        ));
        assert!(matches!(
            PtySessionManager::resolve_command("echo hello"),
            Err(PtyError::DisallowedAgent(_))
        ));
        assert!(matches!(
            PtySessionManager::resolve_command("claude code"),
            Err(PtyError::DisallowedAgent(_))
        ));
        assert!(matches!(
            PtySessionManager::resolve_command("shell "),
            Err(PtyError::DisallowedAgent(_))
        ));
    }

    #[test]
    fn test_injection_semicolons_rejected() {
        assert!(matches!(
            PtySessionManager::resolve_command("claude; rm -rf /"),
            Err(PtyError::DisallowedAgent(_))
        ));
        assert!(matches!(
            PtySessionManager::resolve_command("; /bin/sh"),
            Err(PtyError::DisallowedAgent(_))
        ));
        assert!(matches!(
            PtySessionManager::resolve_command("shell; ls"),
            Err(PtyError::DisallowedAgent(_))
        ));
    }

    #[test]
    fn test_injection_command_substitution_subshell_rejected() {
        assert!(matches!(
            PtySessionManager::resolve_command("$(whoami)"),
            Err(PtyError::DisallowedAgent(_))
        ));
        assert!(matches!(
            PtySessionManager::resolve_command("claude$(id)"),
            Err(PtyError::DisallowedAgent(_))
        ));
        assert!(matches!(
            PtySessionManager::resolve_command("$(cat /etc/passwd)"),
            Err(PtyError::DisallowedAgent(_))
        ));
    }

    #[test]
    fn test_injection_backticks_rejected() {
        assert!(matches!(
            PtySessionManager::resolve_command("`whoami`"),
            Err(PtyError::DisallowedAgent(_))
        ));
        assert!(matches!(
            PtySessionManager::resolve_command("shell`id`"),
            Err(PtyError::DisallowedAgent(_))
        ));
    }

    #[test]
    fn test_injection_path_traversal_rejected() {
        assert!(matches!(
            PtySessionManager::resolve_command("../../bin/sh"),
            Err(PtyError::DisallowedAgent(_))
        ));
        assert!(matches!(
            PtySessionManager::resolve_command("/bin/sh"),
            Err(PtyError::DisallowedAgent(_))
        ));
        assert!(matches!(
            PtySessionManager::resolve_command("./evil.sh"),
            Err(PtyError::DisallowedAgent(_))
        ));
    }

    #[test]
    fn test_unknown_agent_id_rejected() {
        assert!(matches!(
            PtySessionManager::resolve_command("unknown"),
            Err(PtyError::DisallowedAgent(_))
        ));
        assert!(matches!(
            PtySessionManager::resolve_command("evil_agent"),
            Err(PtyError::DisallowedAgent(_))
        ));
        assert!(matches!(
            PtySessionManager::resolve_command(""),
            Err(PtyError::DisallowedAgent(_))
        ));
    }

    #[test]
    fn test_non_cli_agent_rejected() {
        // cline is kind = "extension", not "cli"
        assert!(matches!(
            PtySessionManager::resolve_command("cline"),
            Err(PtyError::NotCliAgent(_))
        ));
    }

    #[test]
    fn test_uninstalled_cli_agent_rejected() {
        let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
        let fs = MockFileSystem::new(); // empty filesystem, no binary on PATH
        let res = PtySessionManager::resolve_command_with_env("codex-cli", &env, &fs);
        assert!(matches!(res, Err(PtyError::AgentNotInstalled(_))));
    }

    #[test]
    fn test_known_agent_id_resolves_to_binary() {
        let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
        let mut fs = MockFileSystem::new();
        fs.add_binary("claude", PathBuf::from("/usr/local/bin/claude"));

        let res = PtySessionManager::resolve_command_with_env("claude-code", &env, &fs);
        assert!(res.is_ok(), "claude-code should resolve to binary on PATH");
        let (prog, args) = res.unwrap();
        assert_eq!(prog, PathBuf::from("/usr/local/bin/claude"));
        assert!(args.is_empty(), "Args must be empty, no shell invocation");
    }

    #[test]
    fn test_literal_shell_starts_shell() {
        let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser")
            .with_var("SHELL", "/bin/zsh");
        let mut fs = MockFileSystem::new();
        fs.add_file("/bin/zsh", b"");

        let res = PtySessionManager::resolve_command_with_env("shell", &env, &fs);
        assert!(res.is_ok(), "literal 'shell' should start login shell");
        let (prog, args) = res.unwrap();
        assert_eq!(prog, PathBuf::from("/bin/zsh"));
        assert!(args.is_empty(), "Args must be empty for login shell");
    }

    #[test]
    fn test_cwd_validation_rejects_file() {
        let result = PtySessionManager::new().open_session(
            "shell",
            Some("Cargo.toml"),
            None,
            None,
            |_| {},
        );
        assert!(matches!(result, Err(PtyError::InvalidCwd(_))));
    }

    #[test]
    fn test_cwd_tilde_expands_to_home() {
        let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap();
        let got = PtySessionManager::new().approved_cwd(Some("~")).unwrap();
        assert_eq!(got, std::fs::canonicalize(home).unwrap());
    }

    #[test]
    fn test_cwd_validation_accepts_valid_directory() {
        let cwd = PtySessionManager::with_roots(vec![PathBuf::from(".")]).approved_cwd(Some("."));
        assert!(cwd.is_ok());
        assert!(cwd.unwrap().is_dir());
    }

    #[test]
    fn test_cwd_validation_empty_string_rejected() {
        let manager = PtySessionManager::new();
        let res_empty = manager.open_session("shell", Some(""), None, None, |_| {});
        assert!(matches!(res_empty, Err(PtyError::InvalidCwd(_))));

        let res_whitespace = manager.open_session("shell", Some("   "), None, None, |_| {});
        assert!(matches!(res_whitespace, Err(PtyError::InvalidCwd(_))));
    }

    #[test]
    fn test_open_session_rejects_injection_attempts() {
        let manager = PtySessionManager::new();

        // Spaces
        let res_spaces = manager.open_session("echo pwned", None, None, None, |_| {});
        assert!(matches!(res_spaces, Err(PtyError::DisallowedAgent(_))));

        // Semicolons
        let res_semi = manager.open_session("claude; rm -rf", None, None, None, |_| {});
        assert!(matches!(res_semi, Err(PtyError::DisallowedAgent(_))));

        // Subshell
        let res_sub = manager.open_session("$(id)", None, None, None, |_| {});
        assert!(matches!(res_sub, Err(PtyError::DisallowedAgent(_))));

        // Backticks
        let res_ticks = manager.open_session("`id`", None, None, None, |_| {});
        assert!(matches!(res_ticks, Err(PtyError::DisallowedAgent(_))));

        // Path traversal
        let res_trav = manager.open_session("../../bin/sh", None, None, None, |_| {});
        assert!(matches!(res_trav, Err(PtyError::DisallowedAgent(_))));

        // Unknown agent
        let res_unknown = manager.open_session("unknown_tool", None, None, None, |_| {});
        assert!(matches!(res_unknown, Err(PtyError::DisallowedAgent(_))));
    }

    #[test]
    fn test_pty_error_serde_and_display() {
        let err = PtyError::DisallowedAgent("sh -c evil".to_string());
        let json = serde_json::to_string(&err).expect("serialization to JSON string");
        assert_eq!(json, "\"Disallowed agent ID: sh -c evil\"");

        let deserialized: PtyError = serde_json::from_str(&json).expect("deserialization");
        assert_eq!(deserialized, PtyError::DisallowedAgent("Disallowed agent ID: sh -c evil".to_string()));
    }

    #[test]
    fn test_no_em_or_en_dashes_in_error_messages() {
        let errors = vec![
            PtyError::DisallowedAgent("test".to_string()),
            PtyError::NotCliAgent("test".to_string()),
            PtyError::AgentNotInstalled("test".to_string()),
            PtyError::InvalidCwd("test".to_string()),
            PtyError::PtySystem("test".to_string()),
            PtyError::SpawnError("test".to_string(), "err".to_string()),
            PtyError::SessionNotFound("test".to_string()),
            PtyError::Io("test".to_string()),
        ];
        for err in errors {
            let msg = err.to_string();
            assert!(!msg.contains('\u{2014}'), "Contains em dash: {}", msg);
            assert!(!msg.contains('\u{2013}'), "Contains en dash: {}", msg);
        }
    }

    #[test]
    fn test_pty_session_write_and_close() {
        let dir = tempfile::tempdir().unwrap();
        let manager = PtySessionManager::with_roots(vec![dir.path().to_path_buf()]);
        let (tx, rx) = mpsc::channel();

        let info = manager
            .open_session("shell", dir.path().to_str(), Some(80), Some(24), move |payload| {
                let _ = tx.send(payload.data);
            })
            .expect("should open interactive shell");

        assert!(manager.has_session(&info.id));

        let echo_marker = "PING_PONG_CHECK_7788";
        manager
            .write_session(&info.id, &format!("echo {}\n", echo_marker))
            .expect("write should succeed");

        let mut accumulated = String::new();
        let timeout = Duration::from_secs(5);
        let start = std::time::Instant::now();

        while start.elapsed() < timeout {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                accumulated.push_str(&chunk);
                if accumulated.contains(echo_marker) {
                    break;
                }
            }
        }

        assert!(
            accumulated.contains(echo_marker),
            "Accumulated '{}' should contain marker '{}'",
            accumulated,
            echo_marker
        );

        manager.close_session(&info.id).expect("close should succeed");
        assert!(!manager.has_session(&info.id));
        assert!(manager.close_session(&info.id).is_err());
    }

    #[test]
    fn test_close_all_terminates_every_session() {
        let dir = tempfile::tempdir().unwrap();
        let manager = PtySessionManager::with_roots(vec![dir.path().to_path_buf()]);
        let a = manager
            .open_session("shell", dir.path().to_str(), Some(80), Some(24), |_| {})
            .expect("should open shell a");
        let b = manager
            .open_session("shell", dir.path().to_str(), Some(80), Some(24), |_| {})
            .expect("should open shell b");
        assert!(manager.has_session(&a.id) && manager.has_session(&b.id));

        assert_eq!(manager.close_all(), 2);
        assert!(!manager.has_session(&a.id));
        assert!(!manager.has_session(&b.id));
        assert_eq!(manager.close_all(), 0, "a second call finds nothing to close");
    }

    #[test]
    fn test_pty_session_resize() {
        let dir = tempfile::tempdir().unwrap();
        let manager = PtySessionManager::with_roots(vec![dir.path().to_path_buf()]);
        let info = manager
            .open_session("shell", dir.path().to_str(), Some(80), Some(24), |_| {})
            .expect("should open shell");

        let resize_res = manager.resize_session(&info.id, 120, 40);
        assert!(resize_res.is_ok(), "Resize to 120x40 should succeed");

        assert!(manager.resize_session("invalid-session-id", 80, 24).is_err());
        manager.close_session(&info.id).expect("cleanup");
    }

    #[test]
    fn test_pty_invalid_session_returns_error() {
        let manager = PtySessionManager::new();
        assert!(manager.write_session("non-existent", "test").is_err());
        assert!(manager.resize_session("non-existent", 80, 24).is_err());
        assert!(manager.close_session("non-existent").is_err());
    }

    #[test]
    fn test_pty_invalid_cwd_returns_error() {
        let manager = PtySessionManager::new();
        let result = manager.open_session(
            "shell",
            Some("/non_existent_directory_armillary_12345"),
            None,
            None,
            |_| {},
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does not exist"));
    }

    // ---- SEC: launch boundary -------------------------------------------------------------

    use std::os::unix::fs::{symlink, PermissionsExt};

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn make_exec(path: &Path) {
        std::fs::write(path, b"#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn generic_binary_on_path_without_evidence_is_not_launchable() {
        let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
        let mut fs = MockFileSystem::new();
        fs.add_binary("zero", PathBuf::from("/usr/local/bin/zero"));
        let res = PtySessionManager::resolve_command_with_env("zero", &env, &fs);
        match res {
            Err(PtyError::AgentNotCorroborated(id, reason)) => {
                assert_eq!(id, "zero");
                assert!(reason.contains("zero"), "{reason}");
            }
            other => panic!("expected AgentNotCorroborated, got {other:?}"),
        }
    }

    #[test]
    fn generic_binary_with_its_own_data_folder_is_launchable() {
        let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
        let mut fs = MockFileSystem::new();
        fs.add_binary("zero", PathBuf::from("/usr/local/bin/zero"));
        fs.add_dir("/Users/testuser/.zero");
        let (prog, args) = PtySessionManager::resolve_command_with_env("zero", &env, &fs).unwrap();
        assert_eq!(prog, PathBuf::from("/usr/local/bin/zero"));
        assert!(args.is_empty());
    }

    #[test]
    fn installed_by_data_alone_has_no_executable_to_launch() {
        let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
        let mut fs = MockFileSystem::new();
        fs.add_dir("/Users/testuser/.zero");
        let res = PtySessionManager::resolve_command_with_env("zero", &env, &fs);
        assert!(matches!(res, Err(PtyError::AgentNotInstalled(_))), "{res:?}");
    }

    #[test]
    fn canonical_executable_resolves_symlinks_to_the_real_file() {
        let dir = tmp();
        let real = dir.path().join("real-agent");
        make_exec(&real);
        let link = dir.path().join("agent-link");
        symlink(&real, &link).unwrap();
        let got = canonical_executable(&link).unwrap();
        assert_eq!(got, std::fs::canonicalize(&real).unwrap());
    }

    #[test]
    fn canonical_executable_refuses_non_executables() {
        let dir = tmp();
        let plain = dir.path().join("notes.txt");
        std::fs::write(&plain, b"hello").unwrap();
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(canonical_executable(&plain), Err(PtyError::BadExecutable(_))));
        assert!(matches!(canonical_executable(dir.path()), Err(PtyError::BadExecutable(_))));
        assert!(matches!(
            canonical_executable(&dir.path().join("missing")),
            Err(PtyError::BadExecutable(_))
        ));
        assert!(matches!(
            canonical_executable(Path::new("relative/agent")),
            Err(PtyError::BadExecutable(_))
        ));
    }

    #[test]
    fn cwd_is_required() {
        let root = tmp();
        let manager = PtySessionManager::with_roots(vec![root.path().to_path_buf()]);
        let res = manager.open_session("shell", None, None, None, |_| {});
        assert!(matches!(res, Err(PtyError::InvalidCwd(_))), "{res:?}");
    }

    #[test]
    fn cwd_inside_an_approved_root_is_accepted_and_canonical() {
        let root = tmp();
        let sub = root.path().join("project");
        std::fs::create_dir(&sub).unwrap();
        let manager = PtySessionManager::with_roots(vec![root.path().to_path_buf()]);
        let got = manager.approved_cwd(Some(sub.to_str().unwrap())).unwrap();
        assert_eq!(got, std::fs::canonicalize(&sub).unwrap());
        let got_root = manager.approved_cwd(Some(root.path().to_str().unwrap())).unwrap();
        assert_eq!(got_root, std::fs::canonicalize(root.path()).unwrap());
    }

    #[test]
    fn cwd_outside_every_approved_root_is_refused() {
        let root = tmp();
        let elsewhere = tmp();
        let manager = PtySessionManager::with_roots(vec![root.path().to_path_buf()]);
        let res = manager.approved_cwd(Some(elsewhere.path().to_str().unwrap()));
        assert!(matches!(res, Err(PtyError::CwdNotApproved(_))), "{res:?}");
        let res = manager.approved_cwd(Some("/"));
        assert!(matches!(res, Err(PtyError::CwdNotApproved(_))), "{res:?}");
        let res = manager.approved_cwd(Some("/etc"));
        assert!(matches!(res, Err(PtyError::CwdNotApproved(_))), "{res:?}");
    }

    #[test]
    fn dot_dot_and_symlinks_cannot_escape_the_root() {
        let root = tmp();
        let outside = tmp();
        let manager = PtySessionManager::with_roots(vec![root.path().to_path_buf()]);
        std::fs::create_dir(root.path().join("a")).unwrap();
        let traversal = format!(
            "{}/a/../../{}",
            root.path().display(),
            outside.path().file_name().unwrap().to_string_lossy()
        );
        // `..` out of the root (this path may not exist; either refusal is fine)
        assert!(manager.approved_cwd(Some(&traversal)).is_err());
        // A symlink inside the root pointing outside it
        let link = root.path().join("shortcut");
        symlink(outside.path(), &link).unwrap();
        let res = manager.approved_cwd(Some(link.to_str().unwrap()));
        assert!(matches!(res, Err(PtyError::CwdNotApproved(_))), "{res:?}");
    }

    #[test]
    fn a_folder_the_user_approves_later_becomes_usable() {
        let root = tmp();
        let other = tmp();
        let manager = PtySessionManager::with_roots(vec![root.path().to_path_buf()]);
        assert!(manager.approved_cwd(Some(other.path().to_str().unwrap())).is_err());
        manager.approve_root(other.path()).unwrap();
        assert!(manager.approved_cwd(Some(other.path().to_str().unwrap())).is_ok());
        // Approving a file or a missing path is an error, never a silent widening.
        assert!(manager.approve_root(Path::new("/definitely/not/here")).is_err());
    }

    #[test]
    fn open_session_refuses_an_unapproved_cwd_before_spawning() {
        let root = tmp();
        let elsewhere = tmp();
        let manager = PtySessionManager::with_roots(vec![root.path().to_path_buf()]);
        let res = manager.open_session(
            "shell",
            Some(elsewhere.path().to_str().unwrap()),
            None,
            None,
            |_| {},
        );
        assert!(matches!(res, Err(PtyError::CwdNotApproved(_))), "{res:?}");
    }

    #[test]
    fn closing_a_session_kills_the_whole_process_group() {
        let root = tmp();
        let pidfile = root.path().join("child.pid");
        let manager = PtySessionManager::with_roots(vec![root.path().to_path_buf()]);
        let (tx, rx) = mpsc::channel();
        let info = manager
            .open_session("shell", Some(root.path().to_str().unwrap()), Some(80), Some(24), move |p| {
                let _ = tx.send(p.data);
            })
            .expect("open");
        // A background child in the shell's process group, as an agent's tool process would be.
        manager
            .write_session(
                &info.id,
                &format!("sleep 300 & echo $! > '{}'\n", pidfile.display()),
            )
            .unwrap();
        let started = std::time::Instant::now();
        let pid: i32 = loop {
            if let Ok(text) = std::fs::read_to_string(&pidfile) {
                if let Ok(pid) = text.trim().parse() {
                    break pid;
                }
            }
            let _ = rx.recv_timeout(Duration::from_millis(50));
            assert!(started.elapsed() < Duration::from_secs(8), "shell never wrote the pid");
        };
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "child should be running before close");
        manager.close_session(&info.id).expect("close");
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            // A killed child is briefly a zombie of init; ESRCH means it is gone.
            let alive = unsafe { libc::kill(pid, 0) } == 0;
            if !alive {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "background child {pid} survived close");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
