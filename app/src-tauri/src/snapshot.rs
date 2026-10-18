//! Capture build only (cargo feature `capture`): photograph the app's own WKWebView in-process.
//!
//! `screencapture` needs the Screen Recording permission, which a headless agent session does not
//! have. `WKWebView takeSnapshotWithConfiguration:` photographs the web view's own content and
//! needs no permission at all. Nothing here is compiled into a normal build.
//!
//! The validation half (name and directory checks) is plain Rust and is also compiled for
//! `cargo test`, so the default test run covers it.

use std::path::{Component, Path, PathBuf};

/// Environment variable naming the absolute directory snapshots are written to.
pub const CAPTURE_DIR_ENV: &str = "ARMILLARY_CAPTURE_DIR";

/// A snapshot name is a bare file stem: letters, digits, `-`, `_` and `.`, no separators,
/// no `..`, not empty, not hidden, at most 120 bytes.
pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("snapshot name is empty".into());
    }
    if name.len() > 120 {
        return Err("snapshot name is longer than 120 bytes".into());
    }
    if name.contains("..") {
        return Err("snapshot name must not contain \"..\"".into());
    }
    if name.starts_with('.') {
        return Err("snapshot name must not start with a dot".into());
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        return Err("snapshot name may only use letters, digits, '-', '_' and '.'".into());
    }
    Ok(())
}

/// Turns the capture directory setting and a snapshot name into `<dir>/<name>.png`.
/// Refuses when the directory is unset, empty, relative, contains `..` or is not an existing
/// directory, and when the name is invalid.
pub fn resolve_output_path(dir: Option<&str>, name: &str) -> Result<PathBuf, String> {
    let dir = match dir {
        Some(d) if !d.is_empty() => d,
        _ => return Err(format!("{CAPTURE_DIR_ENV} is not set")),
    };
    validate_name(name)?;
    let dir = Path::new(dir);
    if !dir.is_absolute() {
        return Err(format!("{CAPTURE_DIR_ENV} must be an absolute path"));
    }
    if dir.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("{CAPTURE_DIR_ENV} must not contain \"..\""));
    }
    if !dir.is_dir() {
        return Err(format!("{CAPTURE_DIR_ENV} is not an existing directory"));
    }
    Ok(dir.join(format!("{name}.png")))
}

// ---------------------------------------------------------------------------------------------
// Everything below exists only in a `--features capture` build.
// ---------------------------------------------------------------------------------------------

/// Env var naming a JSON tour file (see app/src/capture/tour.ts). Unset means "no tour".
#[cfg(feature = "capture")]
pub const CAPTURE_TOUR_ENV: &str = "ARMILLARY_CAPTURE_TOUR";

#[cfg(feature = "capture")]
mod native {
    use super::{resolve_output_path, Viewport, CAPTURE_DIR_ENV, CAPTURE_TOUR_ENV};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSWindow};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSDictionary, NSError, NSNumber, NSSize, NSString};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::{Manager, WebviewWindow};

    fn main_window(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
        app.get_webview_window("main")
            .ok_or_else(|| "no window labelled \"main\"".to_string())
    }

    /// Photographs the web view's own content (no Screen Recording permission involved) and
    /// returns PNG bytes. Must be called on the main thread (the `with_webview` closure is).
    fn snapshot_png(
        view: &WKWebView,
        viewport: (f64, f64),
        tx: mpsc::Sender<Result<Vec<u8>, String>>,
    ) {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = tx.send(Err("snapshot must start on the main thread".into()));
            return;
        };
        let config = unsafe { WKSnapshotConfiguration::new(mtm) };
        // `snapshotWidth` is in points and WebKit renders at the backing scale, so a 1440 pt wide
        // view on a Retina display yields a 2880 px wide image. (Passing pixels doubles it again.)
        // The rect is the page's own viewport (CSS pixels from the runner), not the whole native view:
        // the native view can be taller than the page viewport (title bar area), and the extra strip
        // would show the bare canvas colour.
        unsafe {
            config.setRect(CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(viewport.0, viewport.1)));
            config.setSnapshotWidth(Some(&NSNumber::new_f64(viewport.0)));
        }
        let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let result = (|| -> Result<Vec<u8>, String> {
                // SAFETY: WebKit passes either null or a valid autoreleased object.
                let image = unsafe { image.as_ref() }.ok_or_else(|| match unsafe { error.as_ref() } {
                    Some(e) => format!("snapshot failed: {}", e.localizedDescription()),
                    None => "snapshot failed without an error".to_string(),
                })?;
                let tiff = image.TIFFRepresentation().ok_or("could not get a TIFF of the snapshot")?;
                let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("could not decode the snapshot")?;
                let props: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::new();
                // SAFETY: an empty properties dictionary is valid for PNG.
                let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }
                    .ok_or("could not encode the snapshot as PNG")?;
                Ok(png.to_vec())
            })();
            let _ = tx.send(result);
        });
        unsafe { view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block) };
    }

    pub async fn capture(app: tauri::AppHandle, name: String, viewport: Option<Viewport>) -> Result<String, String> {
        let dir = std::env::var(CAPTURE_DIR_ENV).ok();
        let path = resolve_output_path(dir.as_deref(), &name)?;
        let window = main_window(&app)?;
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let inner = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
        let viewport = match viewport {
            Some(v) if v.width >= 1.0 && v.height >= 1.0 => (v.width, v.height),
            _ => (inner.width, inner.height),
        };
        if std::env::var("ARMILLARY_CAPTURE_DEBUG").is_ok() {
            eprintln!(
                "capture: scale {scale}, inner {:?}, outer {:?}",
                window.inner_size(),
                window.outer_size()
            );
        }
        let (tx, rx) = mpsc::channel();
        window
            .with_webview(move |wv| {
                // SAFETY: on macOS `inner()` is the WKWebView, valid for this call on the main thread.
                let view: &WKWebView = unsafe { &*(wv.inner() as *const WKWebView) };
                snapshot_png(view, viewport, tx);
            })
            .map_err(|e| e.to_string())?;
        let bytes = tauri::async_runtime::spawn_blocking(move || {
            rx
                .recv_timeout(Duration::from_secs(20))
                .map_err(|_| "timed out waiting for the snapshot".to_string())?
        })
        .await
        .map_err(|e| e.to_string())??;
        std::fs::write(&path, &bytes).map_err(|e| format!("could not write {}: {e}", path.display()))?;
        Ok(path.to_string_lossy().into_owned())
    }

    pub fn tour_json() -> Result<Option<String>, String> {
        match std::env::var(CAPTURE_TOUR_ENV) {
            Ok(p) if !p.is_empty() => {
                let meta = std::fs::metadata(&p).map_err(|e| format!("tour file {p}: {e}"))?;
                if meta.len() > 1_000_000 {
                    return Err("tour file is larger than 1 MB".into());
                }
                std::fs::read_to_string(&p).map(Some).map_err(|e| format!("tour file {p}: {e}"))
            }
            _ => Ok(None),
        }
    }

    pub fn resize(app: &tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
        if !(200.0..=8000.0).contains(&width) || !(200.0..=8000.0).contains(&height) {
            return Err("window size out of range".into());
        }
        let window = main_window(app)?;
        // A titled macOS window is kept inside the usable screen area (865 pt tall here, which left
        // 833 pt of page for a 900 request). A borderless one is not, and a snapshot never contains
        // the native title bar anyway.
        window.set_decorations(false).map_err(|e| e.to_string())?;
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        // Setting the content size on the NSWindow directly makes sure the size sticks.
        let ns_window = window.ns_window().map_err(|e| e.to_string())? as usize;
        app.run_on_main_thread(move || {
            // SAFETY: the pointer is the live main window's NSWindow and this runs on the main thread.
            let w: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
            w.setContentSize(NSSize::new(width, height));
        })
        .map_err(|e| e.to_string())
    }
}

/// Answers "is this a capture build, and is there a tour?": the tour file's contents, or null.
/// Registered only with the `capture` feature, so a normal build has no such command.
#[cfg(feature = "capture")]
#[tauri::command]
pub fn capture_config() -> Result<Option<String>, String> {
    native::tour_json()
}

/// The page viewport in CSS pixels (`window.innerWidth` and `innerHeight`), sent by the runner.
#[cfg(feature = "capture")]
#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct Viewport {
    pub width: f64,
    pub height: f64,
}

/// Photographs the main web view to `<ARMILLARY_CAPTURE_DIR>/<name>.png` and returns the path
/// once the file is written. Async on purpose: the snapshot completes on the main thread.
#[cfg(feature = "capture")]
#[tauri::command]
pub async fn capture_snapshot(app: tauri::AppHandle, name: String, viewport: Option<Viewport>) -> Result<String, String> {
    native::capture(app, name, viewport).await
}

/// Resizes the main window's content area (CSS pixels).
#[cfg(feature = "capture")]
#[tauri::command]
pub fn capture_resize(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
    native::resize(&app, width, height)
}

/// Writes the runner's report (timings, step results) to `<ARMILLARY_CAPTURE_DIR>/report.json`.
#[cfg(feature = "capture")]
#[tauri::command]
pub fn capture_report(json: String) -> Result<String, String> {
    let dir = std::env::var(CAPTURE_DIR_ENV).ok();
    let path = resolve_output_path(dir.as_deref(), "report")?.with_extension("json");
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Ends the app. The tour's last step, or the runner's failure path (non-zero code).
#[cfg(feature = "capture")]
#[tauri::command]
pub fn capture_quit(app: tauri::AppHandle, code: Option<i32>) {
    app.exit(code.unwrap_or(0));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_names() {
        for n in ["orrery-dark", "frame_0001", "a.b", "Folio-light.v2", "x"] {
            assert!(validate_name(n).is_ok(), "{n} should be accepted");
        }
    }

    #[test]
    fn rejects_separators_and_traversal() {
        for n in ["a/b", "/abs", "..", "../x", "x/..", "a\\b", "a..b", "x/../y", "..\\x"] {
            assert!(validate_name(n).is_err(), "{n:?} should be rejected");
        }
    }

    #[test]
    fn rejects_empty_hidden_nul_and_odd_characters() {
        for n in ["", ".hidden", "a\0b", "a b", "a:b", "a*b", "naïve"] {
            assert!(validate_name(n).is_err(), "{n:?} should be rejected");
        }
        assert!(validate_name(&"a".repeat(121)).is_err());
        assert!(validate_name(&"a".repeat(120)).is_ok());
    }

    #[test]
    fn refuses_unset_empty_relative_or_missing_directory() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(resolve_output_path(None, "x").is_err());
        assert!(resolve_output_path(Some(""), "x").is_err());
        assert!(resolve_output_path(Some("relative/dir"), "x").is_err());
        assert!(resolve_output_path(Some("."), "x").is_err());
        let missing = tmp.path().join("nope");
        assert!(resolve_output_path(missing.to_str(), "x").is_err());
        // A file is not a directory.
        let file = tmp.path().join("f");
        std::fs::write(&file, b"x").unwrap();
        assert!(resolve_output_path(file.to_str(), "x").is_err());
    }

    #[test]
    fn refuses_a_bad_name_even_with_a_good_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path().to_str().unwrap();
        assert!(resolve_output_path(Some(d), "../escape").is_err());
        assert!(resolve_output_path(Some(d), "a/b").is_err());
        assert!(resolve_output_path(Some(d), "").is_err());
    }

    #[test]
    fn resolves_to_png_inside_the_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path().to_str().unwrap();
        let p = resolve_output_path(Some(d), "orrery-dark").unwrap();
        assert_eq!(p, tmp.path().join("orrery-dark.png"));
        assert!(p.starts_with(tmp.path()));
    }

    #[test]
    fn rejects_directories_with_parent_components() {
        let tmp = tempfile::tempdir().unwrap();
        let sneaky = format!("{}/../{}", tmp.path().display(), tmp.path().file_name().unwrap().to_str().unwrap());
        assert!(resolve_output_path(Some(&sneaky), "x").is_err());
    }
}
