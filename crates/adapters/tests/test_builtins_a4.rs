use orrery_adapters::adapter_spec::AdapterDef;
use orrery_adapters::credentials::is_credential_file;
use orrery_adapters::detection::detect_agent;
use orrery_adapters::env::{MockEnvironment, MockFileSystem, TargetOs};
use orrery_adapters::path_expansion::expand_path;
use std::path::{Path, PathBuf};

// A4 batch adapters. The golden tests for these live in tests/test_golden.rs;
// this file checks the rest of the contract: per-OS detection, coverage level,
// credential safety, and that each fixture tree mirrors the real store layout.
const A4_AGENTS: [&str; 8] = [
    "iflow-cli",
    "plandex",
    "gptme",
    "open-interpreter",
    "openhands-cli",
    "letta-code",
    "grok-build-cli",
    "mistral-vibe-cli",
];

const VALID_COVERAGE: [&str; 4] = ["detect", "history", "live", "config"];

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn builtin_path(agent_id: &str) -> PathBuf {
    repo_root().join(format!("crates/adapters/src/builtins/{agent_id}.toml"))
}

fn fixture_root(agent_id: &str) -> PathBuf {
    repo_root().join(format!("fixtures/{agent_id}"))
}

fn load_builtin(agent_id: &str) -> AdapterDef {
    let content = std::fs::read_to_string(builtin_path(agent_id))
        .unwrap_or_else(|e| panic!("{agent_id}.toml should exist: {e}"));
    AdapterDef::from_toml(&content).unwrap_or_else(|e| panic!("{agent_id}.toml should parse: {e}"))
}

fn coverage_of(agent_id: &str) -> String {
    let content = std::fs::read_to_string(builtin_path(agent_id))
        .unwrap_or_else(|e| panic!("{agent_id}.toml should exist: {e}"));
    let doc: toml::Value = content
        .parse()
        .unwrap_or_else(|e| panic!("{agent_id}.toml should be valid TOML: {e}"));
    doc.get("coverage")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("{agent_id}.toml must declare a coverage level"))
        .to_string()
}

fn extension_for(format: &str) -> &'static str {
    match format {
        "jsonl" => "jsonl",
        "json" => "json",
        "sqlite" => "sqlite",
        "markdown" => "md",
        other => panic!("unknown history format {other}"),
    }
}

/// The literal directory prefix of a glob pattern, made relative to the fixture
/// root (a fixture mirrors the agent's home directory, minus the "~/" part).
fn fixture_dir_for_pattern(root: &Path, pattern: &str) -> Option<PathBuf> {
    let relative = pattern
        .strip_prefix("~/")
        .or_else(|| pattern.strip_prefix("~\\"))
        .or_else(|| pattern.strip_prefix("%USERPROFILE%\\"))
        .or_else(|| pattern.strip_prefix("%USERPROFILE%/"))?;
    let literal: String = relative
        .chars()
        .take_while(|c| *c != '*' && *c != '?' && *c != '[')
        .collect();
    let trimmed = literal.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return Some(root.to_path_buf());
    }
    Some(root.join(trimmed.replace('\\', "/")))
}

#[test]
fn a4_builtin_specs_exist_and_parse() {
    for agent_id in A4_AGENTS {
        let adapter = load_builtin(agent_id);
        assert_eq!(adapter.id, agent_id, "adapter id must match its file name");
        assert!(!adapter.name.is_empty(), "{agent_id} needs a display name");
        assert!(!adapter.vendor.is_empty(), "{agent_id} needs a vendor");
        assert!(!adapter.family.is_empty(), "{agent_id} needs a family");
        assert!(
            matches!(adapter.kind.as_str(), "cli" | "desktop" | "ide" | "cloud"),
            "{agent_id} has an unexpected kind {:?}",
            adapter.kind
        );
    }
}

#[test]
fn a4_specs_declare_detection_for_every_os() {
    for agent_id in A4_AGENTS {
        let adapter = load_builtin(agent_id);
        for os in ["macos", "linux", "windows"] {
            let paths = adapter
                .detection
                .paths
                .get(os)
                .unwrap_or_else(|| panic!("{agent_id} has no detection paths for {os}"));
            assert!(
                !paths.data_folders.is_empty() || !paths.config_files.is_empty(),
                "{agent_id} detection for {os} needs a data folder or a config file"
            );
        }
    }
}

#[test]
fn a4_detection_fires_on_every_os() {
    let cases = [
        (TargetOs::Macos, "/Users/testuser"),
        (TargetOs::Linux, "/home/testuser"),
        (TargetOs::Windows, "C:\\Users\\testuser"),
    ];

    for agent_id in A4_AGENTS {
        let adapter = load_builtin(agent_id);
        for (os, home) in cases {
            let env = MockEnvironment::new(os, home);
            let mut fs = MockFileSystem::new();
            let os_key = os.as_str();

            if let Some(paths) = adapter.detection.paths.get(os_key) {
                for folder in &paths.data_folders {
                    if let Ok(expanded) = expand_path(folder, os, &env) {
                        fs.add_dir(expanded);
                    }
                }
                for file in &paths.config_files {
                    if let Ok(expanded) = expand_path(file, os, &env) {
                        fs.add_file(expanded, b"{}");
                    }
                }
            }

            let result = detect_agent(&adapter, &env, &fs);
            assert!(
                result.installed,
                "{agent_id} must be detected as installed on {os_key}"
            );
            assert!(
                !result.data_paths.is_empty(),
                "{agent_id} must report at least one data path on {os_key}"
            );
        }
    }
}

#[test]
fn a4_history_path_patterns_never_name_a_credential_file() {
    for agent_id in A4_AGENTS {
        let adapter = load_builtin(agent_id);
        for source in &adapter.history_sources {
            for (_os, patterns) in &source.paths {
                for pattern in patterns {
                    assert!(
                        !is_credential_file(Path::new(pattern)),
                        "{agent_id} history pattern {pattern} names a credential file"
                    );
                }
            }
        }
        for platform in adapter.detection.paths.values() {
            for file in &platform.config_files {
                assert!(
                    !is_credential_file(Path::new(file)),
                    "{agent_id} detection config file {file} is a credential file and must not be opened"
                );
            }
        }
    }
}

#[test]
fn a4_coverage_level_matches_history_sources() {
    for agent_id in A4_AGENTS {
        let adapter = load_builtin(agent_id);
        let coverage = coverage_of(agent_id);
        assert!(
            VALID_COVERAGE.contains(&coverage.as_str()),
            "{agent_id} coverage {coverage} is not one of {VALID_COVERAGE:?}"
        );
        if coverage == "detect" {
            assert!(
                adapter.history_sources.is_empty(),
                "{agent_id} is detect-only and must not declare history sources"
            );
        } else {
            assert!(
                !adapter.history_sources.is_empty(),
                "{agent_id} claims coverage {coverage} but declares no history source"
            );
        }
    }
}

#[test]
fn a4_fixtures_mirror_the_declared_store_layout() {
    for agent_id in A4_AGENTS {
        let adapter = load_builtin(agent_id);
        let root = fixture_root(agent_id);
        assert!(root.is_dir(), "{agent_id} fixture folder is missing");
        assert!(
            root.join("expected.json").is_file(),
            "{agent_id} fixture is missing expected.json"
        );

        if adapter.history_sources.is_empty() {
            continue;
        }

        for source in &adapter.history_sources {
            let ext = extension_for(&source.format);
            let files: Vec<PathBuf> = walkdir::WalkDir::new(&root)
                .into_iter()
                .filter_map(|e| e.ok())
                .map(|e| e.into_path())
                .filter(|p| {
                    p.is_file()
                        && p.extension().and_then(|s| s.to_str()) == Some(ext)
                        && p.file_name().map(|n| n != "expected.json").unwrap_or(false)
                })
                .collect();
            assert!(
                !files.is_empty(),
                "{agent_id} fixture has no *.{ext} file for its {format} history source",
                format = source.format
            );

            let patterns = source
                .paths
                .get("macos")
                .or_else(|| source.paths.get("default"))
                .unwrap_or_else(|| panic!("{agent_id} history source needs a macos path list"));
            for pattern in patterns {
                let dir = fixture_dir_for_pattern(&root, pattern)
                    .unwrap_or_else(|| panic!("{agent_id} path {pattern} is not home-relative"));
                assert!(
                    dir.is_dir(),
                    "{agent_id} fixture does not mirror {pattern} (expected a folder at {})",
                    dir.display()
                );
            }
        }
    }
}
