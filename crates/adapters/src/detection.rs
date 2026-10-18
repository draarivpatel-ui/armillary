use crate::adapter_spec::AdapterDef;
use crate::env::{Environment, FileSystem, TargetOs};
use crate::path_expansion::expand_path;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectionResult {
    pub installed: bool,
    pub version: Option<String>,
    pub data_paths: Vec<PathBuf>,
    /// The PATH hit that may be launched: a distinctive binary name, or a generic one with
    /// corroborating evidence. `None` when nothing launchable was found.
    #[serde(default)]
    pub executable: Option<PathBuf>,
    /// Why a PATH hit was not counted as installed (a generic name without corroboration).
    #[serde(default)]
    pub reason: Option<String>,
}

/// True for an absolute path on any supported OS, whatever OS the process runs on
/// (a Windows mock path must count as absolute when tests run on a Mac).
fn is_absolute_any_os(path: &std::path::Path) -> bool {
    let s = path.to_string_lossy();
    s.starts_with('/') || s.starts_with("\\\\") || (s.len() > 2 && s.as_bytes()[1] == b':')
}

/// Passive discovery only. An executable found on PATH is never launched.
///
/// A PATH hit on a name listed in `generic_binaries` (a common word, or the name of an
/// unrelated program) is not evidence by itself. It counts only when the spec's own
/// evidence exists: one of its data folders, config files or app bundles. Evidence listed in
/// `shared_evidence` (folders and bundles other products create too) and paths relative to
/// the working directory never count as evidence. `executable` is the PATH hit that may be
/// launched; a distinctive name is preferred over a corroborated generic one.
pub fn detect_agent(
    adapter: &AdapterDef,
    env: &dyn Environment,
    fs: &dyn FileSystem,
) -> DetectionResult {
    let version: Option<String> = None;
    let mut data_paths = Vec::new();
    let det = &adapter.detection;
    let is_shared = |entry: &str| det.shared_evidence.iter().any(|s| s == entry);
    // Evidence from the spec's own data, config and app bundle (not PATH).
    let mut own_evidence = false;

    // 1. Binaries on PATH, in declared order.
    let mut distinctive: Option<PathBuf> = None;
    let mut generic_hits: Vec<(String, PathBuf)> = Vec::new();
    for binary in &det.binaries {
        if let Some(found) = fs.which(binary) {
            if det.generic_binaries.iter().any(|g| g.eq_ignore_ascii_case(binary)) {
                generic_hits.push((binary.clone(), found));
            } else if distinctive.is_none() {
                distinctive = Some(found);
            }
        }
    }

    let os = env.os();

    // 2. App bundles (macOS)
    if os == TargetOs::Macos {
        let app_dirs = [
            PathBuf::from("/Applications"),
            env.home_dir()
                .map(|h| h.join("Applications"))
                .unwrap_or_default(),
        ];
        for bundle in &det.app_bundles {
            if is_shared(bundle) {
                continue;
            }
            let bundle_name = if bundle.ends_with(".app") {
                bundle.clone()
            } else {
                format!("{}.app", bundle)
            };
            for app_dir in &app_dirs {
                let candidate = app_dir.join(&bundle_name);
                if fs.exists(&candidate) {
                    own_evidence = true;
                }
            }
        }
    }

    // 3. Data folders and config files
    let os_key = os.as_str();
    let platform_paths = det.paths.get(os_key).or_else(|| det.paths.get("default"));

    if let Some(paths) = platform_paths {
        for folder_pattern in &paths.data_folders {
            if let Ok(expanded) = expand_path(folder_pattern, os, env) {
                if fs.exists(&expanded) && fs.is_dir(&expanded) {
                    // Shared folders stay listed as data the importer may read, but are
                    // never proof of installation; neither is anything cwd-relative.
                    if !is_shared(folder_pattern) && is_absolute_any_os(&expanded) {
                        own_evidence = true;
                    }
                    if !data_paths.contains(&expanded) {
                        data_paths.push(expanded);
                    }
                }
            }
        }

        for file_pattern in &paths.config_files {
            if let Ok(expanded) = expand_path(file_pattern, os, env) {
                if fs.exists(&expanded)
                    && fs.is_file(&expanded)
                    && !is_shared(file_pattern)
                    && is_absolute_any_os(&expanded)
                {
                    own_evidence = true;
                }
            }
        }
    }

    // 4. Decide. Generic PATH hits need the spec's own evidence.
    let installed = distinctive.is_some() || own_evidence;
    let mut reason = None;
    let mut executable = distinctive;
    if executable.is_none() {
        if let Some((name, path)) = generic_hits.first() {
            if own_evidence {
                executable = Some(path.clone());
            } else {
                reason = Some(format!(
                    "`{}` was found on the search path, but the name is generic and none of {}'s own data, config or app was found, so it is not counted as installed.",
                    name, adapter.name
                ));
            }
        }
    }

    DetectionResult {
        installed,
        version,
        data_paths,
        executable,
        reason,
    }
}
