//! A6 acceptance tests: the detection-only builtin registry.
//!
//! The builtins directory holds one TOML per known agent. Two of them
//! (claude-code, codex-cli) ship with history sources from package P3;
//! every other entry is a detection-only A6 builtin and must satisfy the
//! invariants below.

use orrery_adapters::adapter_spec::AdapterDef;
use orrery_adapters::credentials::is_credential_file;
use orrery_adapters::detection::detect_agent;
use orrery_adapters::env::{MockEnvironment, MockFileSystem, TargetOs};
use orrery_adapters::path_expansion::expand_path;
use std::path::{Path, PathBuf};

const REFERENCE_IDS: [&str; 2] = ["claude-code", "codex-cli"];
const A6_MIN_ENTRIES: usize = 50;

/// SPEC 3.2 agent families (planet colours).
const ALLOWED_FAMILIES: [&str; 8] = [
    "Anthropic",
    "OpenAI",
    "Google",
    "GitHub/Microsoft",
    "Cursor",
    "open-source CLIs",
    "Chinese labs",
    "other",
];

/// SPEC 5 surface kinds tracked by the Field Guide.
const ALLOWED_KINDS: [&str; 9] = [
    "cli",
    "desktop",
    "ide",
    "ide_extension",
    "cloud",
    "tui",
    "terminal",
    "server",
    "mobile",
];

fn builtins_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src/builtins")
}

/// Every `*.toml` file in the builtins directory, sorted by name.
fn builtin_files() -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(builtins_dir())
        .unwrap_or_else(|e| panic!("cannot read builtins dir {:?}: {}", builtins_dir(), e))
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("toml"))
        .collect();
    entries.sort();
    entries
}

fn load(path: &Path) -> (String, AdapterDef) {
    let content = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("cannot read {}: {}", path.display(), e));
    let adapter = AdapterDef::from_toml(&content)
        .unwrap_or_else(|e| panic!("{} does not parse: {}", path.display(), e));
    (content, adapter)
}

/// True for every builtin that is not an A6 detection-only entry: the two P3
/// reference adapters and the history adapters from A1, A2, A3 and A5 have their
/// own golden tests and may declare history sources.
fn is_reference(id: &str) -> bool {
    REFERENCE_IDS.contains(&id)
        || orrery_adapters::builtins::BUILTINS
            .iter()
            .any(|b| b.id == id && b.package != "A6")
}

/// A6 entries: only the builtins whose registry package is "A6".
fn a6_adapters() -> Vec<(String, AdapterDef)> {
    builtin_files()
        .iter()
        .map(|path| load(path).1)
        .filter(|adapter| !is_reference(&adapter.id))
        .map(|adapter| (adapter.id.clone(), adapter))
        .collect()
}

fn mock_env(os: TargetOs) -> MockEnvironment {
    match os {
        TargetOs::Macos => MockEnvironment::new(TargetOs::Macos, "/Users/testuser"),
        TargetOs::Linux => MockEnvironment::new(TargetOs::Linux, "/home/testuser"),
        TargetOs::Windows => MockEnvironment::new(TargetOs::Windows, "C:\\Users\\testuser"),
    }
}

#[test]
fn every_builtin_parses() {
    let files = builtin_files();
    assert!(
        !files.is_empty(),
        "no builtin TOML files found in {:?}",
        builtins_dir()
    );
    for path in &files {
        let (_, adapter) = load(path);
        assert!(
            !adapter.id.is_empty(),
            "{} has an empty id",
            path.display()
        );
    }
}

#[test]
fn every_builtin_has_a_unique_id() {
    let mut seen: Vec<String> = Vec::new();
    for path in builtin_files() {
        let (_, adapter) = load(&path);
        assert!(
            !seen.contains(&adapter.id),
            "duplicate builtin id: {}",
            adapter.id
        );
        seen.push(adapter.id.clone());
    }
}

#[test]
fn builtin_file_name_matches_its_id() {
    for path in builtin_files() {
        let (_, adapter) = load(&path);
        let stem = path.file_stem().unwrap().to_string_lossy().to_string();
        assert_eq!(
            stem, adapter.id,
            "{} declares id {} but the file name must match",
            path.display(),
            adapter.id
        );
    }
}

#[test]
fn ids_and_kinds_and_families_use_the_allowed_vocabulary() {
    for (_, adapter) in a6_adapters() {
        assert!(
            adapter.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            "id {} must be kebab-case (a-z, 0-9, hyphen)",
            adapter.id
        );
        assert!(
            !adapter.id.starts_with('-') && !adapter.id.ends_with('-'),
            "id {} must not start or end with a hyphen",
            adapter.id
        );
        assert!(
            ALLOWED_FAMILIES.contains(&adapter.family.as_str()),
            "id {} has family {:?}, which is not a SPEC 3.2 family",
            adapter.id,
            adapter.family
        );
        assert!(
            ALLOWED_KINDS.contains(&adapter.kind.as_str()),
            "id {} has kind {:?}, which is not an allowed kind",
            adapter.id,
            adapter.kind
        );
    }
}

#[test]
fn every_builtin_carries_its_display_metadata() {
    for (_, adapter) in a6_adapters() {
        for (field, value) in [
            ("name", &adapter.name),
            ("vendor", &adapter.vendor),
            ("family", &adapter.family),
            ("kind", &adapter.kind),
        ] {
            assert!(
                !value.trim().is_empty(),
                "id {} has an empty {}",
                adapter.id,
                field
            );
        }
    }
}

#[test]
fn a6_names_and_vendors_are_unique() {
    let mut names: Vec<String> = Vec::new();
    for (_, adapter) in a6_adapters() {
        assert!(
            !names.contains(&adapter.name),
            "duplicate display name: {}",
            adapter.name
        );
        names.push(adapter.name.clone());
    }
}

#[test]
fn registry_has_at_least_fifty_a6_entries() {
    let entries = a6_adapters();
    assert!(
        entries.len() >= A6_MIN_ENTRIES,
        "expected at least {} detection-only builtins, found {}",
        A6_MIN_ENTRIES,
        entries.len()
    );
}

#[test]
fn a6_entries_are_detection_only() {
    for path in builtin_files() {
        let (content, adapter) = load(&path);
        if is_reference(&adapter.id) {
            continue;
        }
        assert!(
            adapter.history_sources.is_empty(),
            "id {} is a detection-only builtin and must not declare history_sources",
            adapter.id
        );
        assert!(
            !content.contains("[[history_sources]]"),
            "id {} is a detection-only builtin and must not declare a [[history_sources]] block",
            adapter.id
        );
    }
}

#[test]
fn a6_entries_have_detection_rules_for_all_three_operating_systems() {
    for path in builtin_files() {
        let (content, adapter) = load(&path);
        if is_reference(&adapter.id) {
            continue;
        }
        for os in ["macos", "linux", "windows"] {
            let section = adapter.detection.paths.get(os).unwrap_or_else(|| {
                panic!("id {} has no [detection.paths.{}] section", adapter.id, os)
            });
            let signals = section.data_folders.len() + section.config_files.len();
            if signals == 0 {
                // A product that does not run on this OS, or whose vendor publishes
                // no data path for it, must say so out loud instead of leaving a
                // silently empty section.
                let annotated = content.lines().any(|line| {
                    line.trim().starts_with(&format!("# no-documented-path: {}", os))
                });
                assert!(
                    annotated,
                    "id {}: [detection.paths.{}] is empty but carries no `# no-documented-path: {}` note",
                    adapter.id,
                    os,
                    os
                );
            }
        }
    }
}

#[test]
fn a6_entries_have_a_local_artifact_to_look_for() {
    for (_, adapter) in a6_adapters() {
        let has_local_hook = !adapter.detection.binaries.is_empty()
            || !adapter.detection.app_bundles.is_empty()
            || adapter
                .detection
                .paths
                .values()
                .any(|p| !p.data_folders.is_empty());
        assert!(
            has_local_hook,
            "id {} has no binary, app bundle or data folder to detect",
            adapter.id
        );
    }
}

#[test]
fn a6_entries_cite_their_sources_in_a_comment() {
    for path in builtin_files() {
        let (content, adapter) = load(&path);
        if is_reference(&adapter.id) {
            continue;
        }
        let has_source_comment = content.lines().any(|line| {
            let trimmed = line.trim();
            trimmed.starts_with("# Sources:") && trimmed.contains("https://")
        });
        assert!(
            has_source_comment,
            "id {} must cite its detection sources in a `# Sources:` comment with an https URL",
            adapter.id
        );
        // AdapterDef (owned by P3) has no homepage field, so the docs link lives in
        // a comment until the schema grows one. The Field Guide needs it.
        let has_homepage_comment = content.lines().any(|line| {
            let trimmed = line.trim();
            trimmed.starts_with("# Homepage:") && trimmed.contains("https://")
        });
        assert!(
            has_homepage_comment,
            "id {} must record its homepage in a `# Homepage:` comment",
            adapter.id
        );
    }
}

#[test]
fn no_builtin_names_a_credential_file() {
    for (_, adapter) in a6_adapters() {
        for (os, paths) in &adapter.detection.paths {
            for pattern in paths.data_folders.iter().chain(paths.config_files.iter()) {
                let as_path = Path::new(pattern);
                assert!(
                    !is_credential_file(as_path),
                    "id {} points at a credential file ({}) in [detection.paths.{}]",
                    adapter.id,
                    pattern,
                    os
                );
            }
        }
    }
}

/// `Path::is_absolute` follows the host platform, but these patterns are read on
/// every OS, so decide absoluteness from the string instead.
fn looks_absolute(path: &std::path::Path) -> bool {
    let text = path.to_string_lossy();
    text.starts_with('/')
        || text.starts_with('\\')
        || text.as_bytes().get(1) == Some(&b':')
}

#[test]
fn every_path_pattern_expands_on_its_own_operating_system() {
    for (_, adapter) in a6_adapters() {
        for os in ["macos", "linux", "windows"] {
            let target = match os {
                "macos" => TargetOs::Macos,
                "linux" => TargetOs::Linux,
                _ => TargetOs::Windows,
            };
            let env = mock_env(target);
            let paths = adapter.detection.paths.get(os).expect("os rules present");
            for pattern in paths.data_folders.iter().chain(paths.config_files.iter()) {
                let expanded = expand_path(pattern, target, &env).unwrap_or_else(|e| {
                    panic!(
                        "id {}: pattern {:?} does not expand on {} ({}); add a ~ or %USERPROFILE% fallback",
                        adapter.id, pattern, os, e
                    )
                });
                assert!(
                    looks_absolute(&expanded),
                    "id {}: pattern {:?} expands to a relative path on {}: {}",
                    adapter.id,
                    pattern,
                    os,
                    expanded.display()
                );
            }
        }
    }
}

#[test]
fn builtin_text_carries_no_typographic_dashes() {
    for path in builtin_files() {
        let content = std::fs::read_to_string(&path).unwrap();
        for forbidden in ['\u{2013}', '\u{2014}', '\u{2012}', '\u{2015}'] {
            assert!(
                !content.contains(forbidden),
                "{} contains U+{:04X}; user-facing text uses plain ASCII hyphens",
                path.display(),
                forbidden as u32
            );
        }
    }
}

#[test]
fn an_existing_data_folder_marks_the_agent_installed() {
    let mut checked = 0usize;
    for (_, adapter) in a6_adapters() {
        let Some(pattern) = adapter.detection.paths["macos"]
            .data_folders
            .first()
            .cloned()
        else {
            continue;
        };
        let os = TargetOs::Macos;
        let env = mock_env(os);
        let mut fs = MockFileSystem::new();
        let expanded = expand_path(&pattern, os, &env)
            .unwrap_or_else(|e| panic!("id {}: {:?} does not expand ({})", adapter.id, pattern, e));
        fs.add_dir(expanded.clone());
        let result = detect_agent(&adapter, &env, &fs);
        assert!(
            result.installed,
            "id {}: creating {} did not detect the agent",
            adapter.id,
            expanded.display()
        );
        assert!(
            result.data_paths.contains(&expanded),
            "id {}: {} was not reported as a data path",
            adapter.id,
            expanded.display()
        );
        checked += 1;
    }
    assert!(
        checked >= A6_MIN_ENTRIES - 10,
        "only {} of the detection-only builtins expose a macOS data folder",
        checked
    );
}

#[test]
fn a_binary_on_the_path_marks_the_agent_installed() {
    let mut checked = 0usize;
    for (_, adapter) in a6_adapters() {
        // SEC: a generic name alone is not proof (see test_sec_detection.rs), so only
        // distinctive binary names are expected to detect the agent on their own.
        let Some(binary) = adapter
            .detection
            .binaries
            .iter()
            .find(|b| !adapter.detection.generic_binaries.contains(b))
            .cloned()
        else {
            continue;
        };
        let os = TargetOs::Linux;
        let env = mock_env(os);
        let mut fs = MockFileSystem::new();
        fs.add_binary(&binary, PathBuf::from("/usr/local/bin").join(&binary));
        let result = detect_agent(&adapter, &env, &fs);
        assert!(
            result.installed,
            "id {}: finding {} on PATH did not detect the agent",
            adapter.id,
            binary
        );
        checked += 1;
    }
    assert!(
        checked >= A6_MIN_ENTRIES / 3,
        "only {} of the detection-only builtins declare a distinctive binary",
        checked
    );
}

#[test]
fn an_empty_filesystem_detects_nothing() {
    let env = mock_env(TargetOs::Macos);
    let fs = MockFileSystem::new();
    for (_, adapter) in a6_adapters() {
        let result = detect_agent(&adapter, &env, &fs);
        assert!(
            !result.installed,
            "id {} was detected on an empty machine",
            adapter.id
        );
        assert!(
            result.data_paths.is_empty(),
            "id {} reported data paths on an empty machine",
            adapter.id
        );
    }
}

#[test]
fn a_macos_app_bundle_marks_the_agent_installed() {
    let mut checked = 0usize;
    for (_, adapter) in a6_adapters() {
        // SEC: bundles listed in shared_evidence belong to another product (the Cursor IDE).
        let Some(bundle) = adapter
            .detection
            .app_bundles
            .iter()
            .find(|b| !adapter.detection.shared_evidence.contains(b))
        else {
            continue;
        };
        let env = mock_env(TargetOs::Macos);
        let mut fs = MockFileSystem::new();
        let name = if bundle.ends_with(".app") {
            bundle.clone()
        } else {
            format!("{}.app", bundle)
        };
        fs.add_dir(PathBuf::from("/Applications").join(&name));
        let result = detect_agent(&adapter, &env, &fs);
        assert!(
            result.installed,
            "id {}: /Applications/{} did not detect the agent",
            adapter.id,
            name
        );
        checked += 1;
    }
    assert!(
        checked >= 10,
        "only {} desktop or IDE builtins declare a macOS app bundle",
        checked
    );
}

#[test]
fn lib_exposes_the_builtins_module_and_registers_every_file() {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let lib_rs = std::fs::read_to_string(crate_root.join("src/lib.rs")).unwrap();
    assert!(
        lib_rs.contains("pub mod builtins;"),
        "src/lib.rs must expose the builtin registration list"
    );

    let registry_path = crate_root.join("src/builtins.rs");
    let registry = std::fs::read_to_string(&registry_path)
        .unwrap_or_else(|e| panic!("missing registration list {}: {}", registry_path.display(), e));
    for path in builtin_files() {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        assert!(
            registry.contains(&format!("builtins/{}", name)),
            "the registration list does not include {}",
            name
        );
    }
}

#[test]
fn builtins_public_api_returns_all_parsed_adapters() {
    let all = orrery_adapters::builtins::builtin_adapters();
    assert_eq!(all.len(), orrery_adapters::builtins::BUILTINS.len());
    assert_eq!(all.len(), builtin_files().len());
    let a6 = orrery_adapters::builtins::a6_adapters();
    assert_eq!(
        a6.len(),
        orrery_adapters::builtins::BUILTINS
            .iter()
            .filter(|b| b.package == "A6")
            .count()
    );
    assert!(a6.len() >= A6_MIN_ENTRIES);
}

