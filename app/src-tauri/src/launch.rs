//! Launch-time services gated on first-run consent, plus an env-gated IPC trace.
//!
//! Nothing here touches the user's agent folders until consent is recorded in
//! `<app_data_dir>/firstrun.json` (`consentedAt` is a number). The owner calls
//! `start_background_services` from setup only when `consent_recorded` is true; the
//! first-run flow calls it after the user consents and the first scan.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::archive_api::{ApiError, CoreState};

// The trace helpers live in `archive_api` (which has no launch
// dependency) because several integration tests include `archive_api.rs` on its own as a
// module; they are re-exported here as this module's public API.
pub use crate::archive_api::{
    trace, trace_enabled, trace_enabled_from, truncate_trace_line,
    TRACE_LINE_MAX,
};

/// True only when `<data_dir>/firstrun.json` records consent. One implementation: the consent
/// file reader in `archive_api::consent` (firstrun.rs writes the file).
pub fn consent_recorded(data_dir: &Path) -> bool {
    crate::archive_api::consent::recorded(data_dir)
}

/// True when the launch-time services may start: consent is recorded AND the first run finished.
/// Consent without completion (the app quit during the first run) means the plaque asks again and
/// nothing starts until the user continues.
pub fn services_allowed_at_launch(data_dir: &Path) -> bool {
    crate::archive_api::consent::services_allowed_at_launch(data_dir)
}

/// Err with code "consent_required" unless consent is recorded in `data_dir`.
pub fn require_consent(data_dir: &Path) -> Result<(), ApiError> {
    crate::archive_api::consent::require(data_dir)
}

/// Returns true exactly once per flag: the caller that gets true must start the services.
pub fn claim_start(flag: &AtomicBool) -> bool {
    !flag.swap(true, Ordering::SeqCst)
}

/// What is running while the services are up, so a later decline (or Delete archive) can stop it.
pub struct ServiceSlot {
    started: AtomicBool,
    running: Mutex<Option<Running>>,
}

struct Running {
    /// Dropping the watcher stops its thread and its notify handles.
    _watcher: Option<crate::importer::ImportWatcher>,
    /// The live detector loop and the progress forwarder check this flag.
    stop: Arc<AtomicBool>,
}

impl ServiceSlot {
    pub const fn new() -> Self {
        Self { started: AtomicBool::new(false), running: Mutex::new(None) }
    }

    /// True exactly once until the next `stop`.
    pub fn claim(&self) -> bool {
        claim_start(&self.started)
    }

    /// Record the running watcher; returns the stop flag the background loops must check.
    pub fn install(&self, watcher: Option<crate::importer::ImportWatcher>) -> Arc<AtomicBool> {
        let stop = Arc::new(AtomicBool::new(false));
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        *running = Some(Running { _watcher: watcher, stop: stop.clone() });
        stop
    }

    /// Stop the watcher and signal the loops. Returns true when something was running. After a
    /// stop the services may be claimed again (a later consent starts them afresh).
    pub fn stop(&self) -> bool {
        let taken = self.running.lock().unwrap_or_else(|e| e.into_inner()).take();
        let was_running = match taken {
            Some(running) => {
                running.stop.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        };
        self.started.store(false, Ordering::SeqCst);
        was_running
    }
}

impl Default for ServiceSlot {
    fn default() -> Self {
        Self::new()
    }
}

static SERVICES: ServiceSlot = ServiceSlot::new();

/// Start everything that reads the user's agent folders: discovery, the file watcher, the live
/// detector and one initial import. Idempotent: a second call does nothing until a stop. Must only
/// be called after consent (the caller checks `consent_recorded` or `services_allowed_at_launch`).
pub fn start_background_services<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::{Emitter, Manager};
    let Some(state) = app.try_state::<CoreState>() else {
        // The archive state is registered in setup; without it there is nothing to start.
        trace("services_start skipped: no archive state");
        return;
    };
    if !SERVICES.claim() {
        return;
    }
    // Read first: a stop from here on cancels the initial import below (R2P-2).
    let epoch = crate::importer::current_epoch();
    let archive = state.archive.clone();
    let (detect_env, detect_fs) = crate::archive_api::scope::detection_env();
    let targets = crate::importer::discover_targets(detect_env.as_ref(), detect_fs.as_ref());
    if crate::importer::current_epoch() != epoch {
        SERVICES.stop();
        return;
    }
    state.set_targets(targets.clone());
    trace(&format!("services_start targets={}", targets.len()));

    // Debounced file watcher, forwarding import:progress events.
    let (progress_tx, progress_rx) = crossbeam_channel::unbounded();
    let watcher = crate::importer::spawn_watcher(archive.clone(), targets.clone(), progress_tx).ok();
    let forwarding = watcher.is_some();
    let stop = SERVICES.install(watcher);
    if forwarding {
        let app_handle = app.clone();
        std::thread::spawn(move || {
            // Ends when the watcher (the only sender) is dropped by a stop.
            while let Ok(progress) = progress_rx.recv() {
                let _ = app_handle.emit("import:progress", &progress);
            }
        });
    }

    crate::live::start_background_detector(app.clone(), stop);

    // One initial import of everything discovered. A stop cancels it before its next file read.
    // The importer uses the epoch read when the services started (above), so a stop that comes
    // before the thread builds its importer still cancels it (R2P-2).
    if !targets.is_empty() {
        let app_handle = app.clone();
        std::thread::spawn(move || {
            let emit = |p| {
                let _ = app_handle.emit("import:progress", &p);
            };
            let result = crate::importer::Importer::with_epoch(archive, epoch)
                .run_reporting_inferred(&targets, None, &emit);
            match result {
                Ok(s) => trace(&format!(
                    "initial_import ok adapters={} sessions={} messages={}",
                    s.adapters, s.sessions, s.messages
                )),
                Err(_) => trace("initial_import err import_failed"),
            }
        });
    }
}

/// Stop the watcher, the live detector and any running import (consent withdrawn, or the archive is
/// being deleted). Safe to call when nothing runs.
pub fn stop_background_services<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    crate::importer::cancel_running_imports();
    let stopped = SERVICES.stop();
    if let Some(state) = app.try_state::<CoreState>() {
        state.set_targets(Vec::new());
    }
    trace(&format!("services_stop running={stopped}"));
}

/// Start the launch services once the user has consented. Typed error "consent_required" otherwise.
/// The first run calls this right after its scan (before it marks itself completed), so this
/// checks consent only; the launch-time start in setup also needs completion.
#[tauri::command]
pub fn services_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, CoreState>,
) -> Result<(), ApiError> {
    use tauri::Manager;
    let _ = &state;
    let result = app
        .path()
        .app_data_dir()
        .map_err(|e| ApiError::archive_failed(format!("no app data dir: {e}")))
        .and_then(|dir| require_consent(&dir));
    match &result {
        Ok(()) => {
            start_background_services(&app);
            trace("cmd services_start ok");
        }
        Err(e) => trace(&format!("cmd services_start err {}", e.code)),
    }
    result
}

/// Delete archive and reset (R2-REV-3): stop every service and running import, then delete the
/// archive (database, -wal, -shm), firstrun.json and leftover snapshots. The UI then clears its
/// local storage and shows the first-run plaque again.
#[tauri::command]
pub fn archive_delete(app: tauri::AppHandle, state: tauri::State<'_, CoreState>) -> Result<(), ApiError> {
    let result = crate::archive_api::app_data_dir_of(&app).and_then(|data_dir| {
        stop_background_services(&app);
        crate::archive_api::delete_data_in(&data_dir, &std::env::temp_dir(), &state.archive)
    });
    match &result {
        Ok(()) => trace("cmd archive_delete ok"),
        Err(e) => trace(&format!("cmd archive_delete err {}", e.code)),
    }
    result
}

/// Let the frontend report events it received. A no-op unless `ARMILLARY_TRACE_IPC=1`.
#[tauri::command]
pub fn ui_trace(line: String) {
    if trace_enabled() {
        trace(&truncate_trace_line(&line));
    }
}

/// What the UI needs to show home-relative paths: the process home folder as given, and its
/// canonical spelling when it resolves (macOS temp folders appear as /private/tmp/...).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DisplayContext {
    pub home: Option<String>,
    pub home_canonical: Option<String>,
}

/// Pure part of `display_context`: an empty or missing home yields no home at all.
pub fn build_display_context(
    home: Option<String>,
    canonicalize: impl Fn(&Path) -> Option<std::path::PathBuf>,
) -> DisplayContext {
    let home = home.filter(|h| !h.is_empty());
    let home_canonical = home
        .as_deref()
        .and_then(|h| canonicalize(Path::new(h)))
        .and_then(|p| p.to_str().map(str::to_string));
    DisplayContext { home, home_canonical }
}

/// The home folder (HOME, or USERPROFILE on Windows) for turning absolute paths into "~/..." in the UI.
/// Reads only the environment and canonicalizes the home folder itself; no agent data is touched.
#[tauri::command]
pub fn display_context() -> DisplayContext {
    #[cfg(windows)]
    let var = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let var = std::env::var_os("HOME");
    build_display_context(var.and_then(|v| v.into_string().ok()), |p| std::fs::canonicalize(p).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::importer::testutil::staged_targets;
    use orrery_archive::Archive;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    fn write_firstrun(dir: &Path, body: &str) {
        std::fs::write(dir.join("firstrun.json"), body).unwrap();
    }

    #[test]
    fn consent_false_when_file_missing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!consent_recorded(tmp.path()));
        assert!(!consent_recorded(&tmp.path().join("does-not-exist")));
    }

    #[test]
    fn consent_false_for_bad_json_or_wrong_shape() {
        let tmp = tempfile::tempdir().unwrap();
        for body in [
            "",
            "not json",
            "[]",
            "null",
            "{}",
            r#"{"version":1}"#,
            r#"{"version":1,"consentedAt":null,"completedAt":null,"declinedAt":null}"#,
            r#"{"version":1,"consentedAt":"1700000000000"}"#,
            r#"{"version":1,"consentedAt":true}"#,
            r#"{"version":1,"consentedAt":{"at":1}}"#,
            r#"{"version":1,"consentedAt":null,"completedAt":1700000000000,"declinedAt":1700000000001}"#,
        ] {
            write_firstrun(tmp.path(), body);
            assert!(!consent_recorded(tmp.path()), "body {body:?} must not count as consent");
        }
    }

    #[test]
    fn consent_true_when_consented_at_is_a_number() {
        let tmp = tempfile::tempdir().unwrap();
        write_firstrun(
            tmp.path(),
            r#"{"version":1,"consentedAt":1700000000000,"completedAt":null,"declinedAt":null}"#,
        );
        assert!(consent_recorded(tmp.path()));
        write_firstrun(tmp.path(), r#"{"consentedAt":0}"#);
        assert!(consent_recorded(tmp.path()), "any number counts");
    }

    #[test]
    fn consent_false_when_firstrun_is_a_directory() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("firstrun.json")).unwrap();
        assert!(!consent_recorded(tmp.path()));
    }

    #[test]
    fn trace_is_enabled_only_for_exactly_one() {
        assert!(trace_enabled_from(Some("1")));
        for no in [None, Some(""), Some("0"), Some("true"), Some("yes"), Some(" 1"), Some("11")] {
            assert!(!trace_enabled_from(no), "{no:?}");
        }
    }

    #[test]
    fn trace_lines_are_truncated_to_300_characters() {
        let long = "x".repeat(1000);
        assert_eq!(truncate_trace_line(&long).chars().count(), TRACE_LINE_MAX);
        assert_eq!(truncate_trace_line("short"), "short");
        let exact = "y".repeat(300);
        assert_eq!(truncate_trace_line(&exact), exact);
        // Multi-byte characters are counted as characters and never split.
        let emoji = "\u{1F600}".repeat(400);
        let cut = truncate_trace_line(&emoji);
        assert_eq!(cut.chars().count(), TRACE_LINE_MAX);
        assert!(cut.chars().all(|c| c == '\u{1F600}'));
    }

    #[test]
    fn services_start_requires_consent() {
        let tmp = tempfile::tempdir().unwrap();
        let err = require_consent(tmp.path()).unwrap_err();
        assert_eq!(err.code, "consent_required");
        write_firstrun(tmp.path(), r#"{"version":1,"consentedAt":null,"declinedAt":1700000000000}"#);
        assert_eq!(require_consent(tmp.path()).unwrap_err().code, "consent_required");
        write_firstrun(tmp.path(), r#"{"version":1,"consentedAt":1700000000000}"#);
        assert!(require_consent(tmp.path()).is_ok());
    }

    /// R2-REV-4: consent without a finished first run means "ask again": nothing starts at launch.
    #[test]
    fn services_start_at_launch_only_after_consent_and_completion() {
        let tmp = crate::archive_api::testkit::tmp();
        for (body, allowed) in [
            ("", false),
            (r#"{"version":1,"consentedAt":1700000000000,"completedAt":null}"#, false),
            (r#"{"version":1,"consentedAt":null,"completedAt":1700000000000,"declinedAt":1700000000000}"#, false),
            (r#"{"version":1,"consentedAt":1700000000000,"completedAt":1700000000001}"#, true),
        ] {
            write_firstrun(tmp.path(), body);
            assert_eq!(services_allowed_at_launch(tmp.path()), allowed, "{body}");
        }
    }

    /// R2-REV-4: declining later stops the watcher and the detector, and a later consent can start
    /// them again.
    #[test]
    fn stopping_services_signals_the_detector_and_allows_a_restart() {
        let slot = ServiceSlot::new();
        assert!(slot.claim());
        let stop = slot.install(None);
        assert!(!stop.load(Ordering::SeqCst));
        assert!(slot.stop(), "something was running");
        assert!(stop.load(Ordering::SeqCst), "the detector loop sees the stop flag");
        assert!(!slot.stop(), "a second stop is a no-op");
        assert!(slot.claim(), "after a stop the services may start again");
    }

    #[test]
    fn start_is_claimed_exactly_once() {
        let flag = AtomicBool::new(false);
        assert!(claim_start(&flag));
        assert!(!claim_start(&flag), "a second call does nothing");
        assert!(!claim_start(&flag));
        assert!(flag.load(Ordering::SeqCst));
    }

    #[test]
    fn display_context_carries_home_and_its_canonical_spelling() {
        let ctx = build_display_context(Some("/tmp/h".into()), |p| {
            assert_eq!(p, Path::new("/tmp/h"));
            Some(std::path::PathBuf::from("/private/tmp/h"))
        });
        assert_eq!(ctx.home.as_deref(), Some("/tmp/h"));
        assert_eq!(ctx.home_canonical.as_deref(), Some("/private/tmp/h"));
    }

    #[test]
    fn display_context_without_a_canonical_path_or_without_home() {
        let ctx = build_display_context(Some("/gone".into()), |_| None);
        assert_eq!(ctx.home.as_deref(), Some("/gone"));
        assert_eq!(ctx.home_canonical, None);

        for missing in [None, Some(String::new())] {
            let ctx = build_display_context(missing, |_| panic!("nothing to canonicalize"));
            assert_eq!(ctx, DisplayContext { home: None, home_canonical: None });
        }
    }

    #[test]
    fn display_context_serializes_with_snake_case_keys() {
        let ctx = DisplayContext { home: Some("/h".into()), home_canonical: None };
        assert_eq!(
            serde_json::to_value(&ctx).unwrap(),
            serde_json::json!({ "home": "/h", "home_canonical": null })
        );
    }

    #[test]
    fn display_context_canonicalizes_a_real_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_string_lossy().to_string();
        let ctx = build_display_context(Some(home.clone()), |p| std::fs::canonicalize(p).ok());
        assert_eq!(ctx.home.as_deref(), Some(home.as_str()));
        assert_eq!(
            ctx.home_canonical.map(std::path::PathBuf::from),
            Some(std::fs::canonicalize(tmp.path()).unwrap())
        );
    }
}
