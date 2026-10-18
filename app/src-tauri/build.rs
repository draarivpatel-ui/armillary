//! Build script: declares the application's own commands as an ACL manifest, so each command
//! needs an explicit `allow-*` permission in a capability file before the webview may call it.
//! Adding a command means adding it here and to `capabilities/default.json`.

/// Every command the main window may call, in the order they appear in `main.rs`.
const COMMANDS: &[&str] = &[
    // agents, config and live detection
    "agents_list",
    "config_list",
    "live_list",
    // embedded terminal
    "pty_open",
    "pty_write",
    "pty_resize",
    "pty_close",
    // archive: import, query, search
    "import_now",
    "sessions_query",
    "session_get",
    "messages_page",
    "import_diagnostics",
    "search",
    // launch services after first-run consent, and the env-gated IPC trace (INT)
    "services_start",
    // Delete archive and reset (removing your data)
    "archive_delete",
    // a damaged or newer archive: report it, and move it aside on request
    "archive_status",
    "archive_move_aside",
    "ui_trace",
    "display_context",
    // first run
    "firstrun_status",
    "firstrun_plan",
    "firstrun_consent",
    "firstrun_scan",
    "firstrun_complete",
    "firstrun_reset",
    "firstrun_fps_enabled",
    "firstrun_fps_report",
];

/// Only compiled in when the `capture` cargo feature is on (screenshot and video tooling).
const CAPTURE_COMMANDS: &[&str] = &[
    "capture_snapshot",
    "capture_config",
    "capture_quit",
    "capture_resize",
    "capture_report",
];

fn main() {
    let capture = std::env::var_os("CARGO_FEATURE_CAPTURE").is_some();
    let mut commands: Vec<&str> = COMMANDS.to_vec();
    if capture {
        commands.extend_from_slice(CAPTURE_COMMANDS);
    }

    // The manifest wants 'static data; a build script runs once, so leaking is fine.
    let commands: &'static [&'static str] = Box::leak(commands.into_boxed_slice());

    // Normal builds read only `capabilities/`; the capture feature also reads
    // `capabilities-capture/`, which grants the capture commands to the main window.
    let pattern = if capture {
        "./capabilities*/*.json"
    } else {
        "./capabilities/*.json"
    };
    println!("cargo:rerun-if-changed=capabilities");
    println!("cargo:rerun-if-changed=capabilities-capture");
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_CAPTURE");

    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(commands))
        .capabilities_path_pattern(pattern);
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
