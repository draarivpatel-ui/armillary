#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
pub mod archive_api;
mod config_scan;
mod firstrun;
pub mod importer;
pub mod launch;
pub mod live;
mod pty;
// Validation is unit-tested in a default `cargo test`; the WKWebView snapshot itself needs `--features capture`.
#[cfg(any(feature = "capture", test))]
#[cfg_attr(not(feature = "capture"), allow(dead_code))]
mod snapshot;

fn main() {
    tauri::Builder::default()
        .manage(pty::PtyState::default())
        .setup(|app| {
            use tauri::Manager;
            // The archive commands read this state; without it every call would fail.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            // A damaged archive, or one from a newer version, no longer stops the launch: the app
            // opens on an empty in-memory archive and the UI explains and offers to move the file
            // aside (R2-REV-7). The file itself is not touched.
            let (archive, problem) = archive_api::open_or_recover_in(&data_dir);
            let archive_ok = problem.is_none();
            if !archive_ok {
                launch::trace("launch: archive could not be opened; running on an empty archive");
            }
            app.manage(archive_api::ArchiveHealth { problem: std::sync::Mutex::new(problem) });
            // No discovery yet: nothing reads the user's agent folders before first-run consent.
            app.manage(archive_api::CoreState::new(archive, Vec::new()));

            // Discovery, the file watcher, the live detector and the launch import start only once
            // consent is recorded AND the first run finished. Consent without completion (the app
            // quit during the first run) means the plaque asks again before anything is read.
            if archive_ok && launch::services_allowed_at_launch(&data_dir) {
                launch::start_background_services(app.handle());
            } else {
                launch::trace("launch: first run not finished with consent, background services not started");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agents::agents_list,
            config_scan::config_list,
            live::live_list,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            archive_api::import_now,
            archive_api::sessions_query,
            archive_api::session_get,
            archive_api::messages_page,
            archive_api::search,
            firstrun::firstrun_status,
            firstrun::firstrun_plan,
            firstrun::firstrun_consent,
            firstrun::firstrun_scan,
            firstrun::firstrun_complete,
            firstrun::firstrun_reset,
            firstrun::firstrun_fps_enabled,
            firstrun::firstrun_fps_report,
            archive_api::import_diagnostics,
            launch::services_start,
            launch::archive_delete,
            archive_api::archive_status,
            archive_api::archive_move_aside,
            launch::ui_trace,
            launch::display_context,
            #[cfg(feature = "capture")]
            snapshot::capture_config,
            #[cfg(feature = "capture")]
            snapshot::capture_snapshot,
            #[cfg(feature = "capture")]
            snapshot::capture_resize,
            #[cfg(feature = "capture")]
            snapshot::capture_report,
            #[cfg(feature = "capture")]
            snapshot::capture_quit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // The PTY manager's Drop covers normal exits only; close every terminal on exit too.
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                app.state::<pty::PtyState>().manager.close_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{firstrun, importer};

    /// The background import stream and the first run's import events are one shape.
    #[test]
    fn import_progress_payload_matches_the_firstrun_payload() {
        for (phase, error) in [("progress", None), ("finished", Some("read failed".to_string()))] {
            let first = firstrun::ImportPayload {
                agent_id: "claude-code".into(),
                phase: phase.into(),
                sessions_imported: 3,
                sessions_known: 7,
                error: error.clone(),
                projects: vec!["alpha".into(), "beta".into()],
            };
            let live = importer::ImportPayload {
                agent_id: "claude-code".into(),
                phase: phase.into(),
                sessions_imported: 3,
                sessions_known: 7,
                error,
                projects: vec!["alpha".into(), "beta".into()],
            };
            assert_eq!(serde_json::to_value(&first).unwrap(), serde_json::to_value(&live).unwrap());
        }
    }
}
