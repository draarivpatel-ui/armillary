// A2 adapters batch: detection tests for aider, goose, amp, kimi-code-cli, qoder-cli.
// Each adapter is loaded from crates/adapters/src/builtins/<id>.toml and detected
// against mock environments on macOS, Linux and Windows. No real user directories
// are touched: MockEnvironment and MockFileSystem simulate each OS.

use orrery_adapters::adapter_spec::AdapterDef;
use orrery_adapters::detection::detect_agent;
use orrery_adapters::env::{MockEnvironment, MockFileSystem, TargetOs};
use std::path::PathBuf;

fn load_builtin(id: &str) -> AdapterDef {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let toml_path = manifest.join(format!("src/builtins/{}.toml", id));
    let content = std::fs::read_to_string(&toml_path)
        .unwrap_or_else(|e| panic!("builtin adapter {} should exist: {}", id, e));
    let adapter = AdapterDef::from_toml(&content)
        .unwrap_or_else(|e| panic!("builtin adapter {} should parse: {}", id, e));
    assert_eq!(adapter.id, id, "adapter id must match its file name");
    adapter
}

// ---------- aider: detection only (per-repo markdown store) ----------

#[test]
fn test_aider_detects_on_macos_via_config_file() {
    let adapter = load_builtin("aider");
    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let mut fs = MockFileSystem::new();
    fs.add_file("/Users/testuser/.aider.conf.yml", b"model: sonnet\n");

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
}

#[test]
fn test_aider_detects_on_linux_via_binary() {
    let adapter = load_builtin("aider");
    let env = MockEnvironment::new(TargetOs::Linux, "/home/testuser");
    let mut fs = MockFileSystem::new();
    fs.add_binary("aider", PathBuf::from("/usr/local/bin/aider"));

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
}

#[test]
fn test_aider_detects_on_windows() {
    let adapter = load_builtin("aider");
    let env = MockEnvironment::new(TargetOs::Windows, "C:\\Users\\testuser");
    let mut fs = MockFileSystem::new();
    fs.add_file("C:\\Users\\testuser\\.aider.conf.yml", b"model: sonnet\n");

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
}

#[test]
fn test_aider_not_installed_when_empty() {
    let adapter = load_builtin("aider");
    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let fs = MockFileSystem::new();

    let result = detect_agent(&adapter, &env, &fs);
    assert!(!result.installed);
}

#[test]
fn test_aider_has_module_history_source() {
    let adapter = load_builtin("aider");
    assert_eq!(adapter.history_sources.len(), 1);
    assert_eq!(adapter.history_sources[0].module.as_deref(), Some("aider"));
}

// ---------- goose: detection + sqlite session table import ----------

#[test]
fn test_goose_detects_on_macos_via_data_folder() {
    let adapter = load_builtin("goose");
    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let mut fs = MockFileSystem::new();
    fs.add_dir(PathBuf::from("/Users/testuser/.local/share/goose/sessions"));

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
    assert!(result.data_paths.contains(&PathBuf::from(
        "/Users/testuser/.local/share/goose/sessions"
    )));
}

#[test]
fn test_goose_detects_on_linux_via_config_and_folder() {
    let adapter = load_builtin("goose");
    let env = MockEnvironment::new(TargetOs::Linux, "/home/testuser");
    let mut fs = MockFileSystem::new();
    fs.add_file(
        "/home/testuser/.config/goose/config.yaml",
        b"extensions: {}\n",
    );
    fs.add_dir(PathBuf::from("/home/testuser/.local/share/goose/sessions"));

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
}

#[test]
fn test_goose_detects_on_windows_appdata() {
    let adapter = load_builtin("goose");
    let env = MockEnvironment::new(TargetOs::Windows, "C:\\Users\\testuser");
    let mut fs = MockFileSystem::new();
    fs.add_dir(PathBuf::from(
        "C:\\Users\\testuser\\AppData\\Roaming\\Block\\goose\\data\\sessions",
    ));

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
}

#[test]
fn test_goose_not_installed_when_empty() {
    let adapter = load_builtin("goose");
    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let fs = MockFileSystem::new();
    let result = detect_agent(&adapter, &env, &fs);
    assert!(!result.installed);
}

#[test]
fn test_goose_has_sqlite_history_source() {
    let adapter = load_builtin("goose");
    let source = adapter
        .history_sources
        .iter()
        .find(|s| s.format == "sqlite")
        .expect("goose should ship a sqlite history source");
    assert!(
        source.query.is_some(),
        "sqlite source needs a sessions query"
    );
}

// ---------- amp: detection only (cloud-synced thread store, unstable schema) ----------

#[test]
fn test_amp_detects_on_macos_via_threads_folder() {
    let adapter = load_builtin("amp");
    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let mut fs = MockFileSystem::new();
    fs.add_dir(PathBuf::from("/Users/testuser/.local/share/amp/threads"));

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
}

#[test]
fn test_amp_detects_on_linux_via_settings_file() {
    let adapter = load_builtin("amp");
    let env = MockEnvironment::new(TargetOs::Linux, "/home/testuser");
    let mut fs = MockFileSystem::new();
    fs.add_file("/home/testuser/.config/amp/settings.json", b"{}");

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
}

#[test]
fn test_amp_detects_on_windows() {
    let adapter = load_builtin("amp");
    let env = MockEnvironment::new(TargetOs::Windows, "C:\\Users\\testuser");
    let mut fs = MockFileSystem::new();
    fs.add_dir(PathBuf::from(
        "C:\\Users\\testuser\\.local\\share\\amp\\threads",
    ));

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
}

#[test]
fn test_amp_not_installed_when_empty() {
    let adapter = load_builtin("amp");
    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let fs = MockFileSystem::new();
    let result = detect_agent(&adapter, &env, &fs);
    assert!(!result.installed);
}

#[test]
fn test_amp_has_module_history_source() {
    let adapter = load_builtin("amp");
    assert_eq!(adapter.history_sources.len(), 1);
    assert_eq!(adapter.history_sources[0].module.as_deref(), Some("amp"));
}

// ---------- kimi-code-cli: detection only (event journal wire files) ----------

#[test]
fn test_kimi_detects_on_macos_via_data_root() {
    let adapter = load_builtin("kimi-code-cli");
    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let mut fs = MockFileSystem::new();
    fs.add_dir(PathBuf::from("/Users/testuser/.kimi-code/sessions"));

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
}

#[test]
fn test_kimi_detects_on_linux_via_config_file() {
    let adapter = load_builtin("kimi-code-cli");
    let env = MockEnvironment::new(TargetOs::Linux, "/home/testuser");
    let mut fs = MockFileSystem::new();
    fs.add_file(
        "/home/testuser/.kimi-code/config.toml",
        b"default_model = \"kimi-k2\"\n",
    );

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
}

#[test]
fn test_kimi_detects_with_kimi_code_home_override() {
    let adapter = load_builtin("kimi-code-cli");
    let env = MockEnvironment::new(TargetOs::Linux, "/home/testuser")
        .with_var("KIMI_CODE_HOME", "/home/testuser/.config/kimi-code");
    let mut fs = MockFileSystem::new();
    fs.add_dir(PathBuf::from("/home/testuser/.config/kimi-code/sessions"));

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
    assert!(result
        .data_paths
        .contains(&PathBuf::from("/home/testuser/.config/kimi-code/sessions")));
}

#[test]
fn test_kimi_detects_on_windows() {
    let adapter = load_builtin("kimi-code-cli");
    let env = MockEnvironment::new(TargetOs::Windows, "C:\\Users\\testuser");
    let mut fs = MockFileSystem::new();
    fs.add_dir(PathBuf::from("C:\\Users\\testuser\\.kimi-code\\sessions"));

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
}

#[test]
fn test_kimi_not_installed_when_empty() {
    let adapter = load_builtin("kimi-code-cli");
    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let fs = MockFileSystem::new();
    let result = detect_agent(&adapter, &env, &fs);
    assert!(!result.installed);
}

#[test]
fn test_kimi_has_module_history_source() {
    let adapter = load_builtin("kimi-code-cli");
    assert_eq!(adapter.history_sources.len(), 1);
    assert_eq!(adapter.history_sources[0].module.as_deref(), Some("kimi-code-cli"));
}

// ---------- qoder-cli: detection + claude-style jsonl transcripts ----------

#[test]
fn test_qoder_detects_on_macos_via_projects_folder() {
    let adapter = load_builtin("qoder-cli");
    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let mut fs = MockFileSystem::new();
    fs.add_dir(PathBuf::from("/Users/testuser/.qoder/projects"));

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
    assert!(result
        .data_paths
        .contains(&PathBuf::from("/Users/testuser/.qoder/projects")));
}

#[test]
fn test_qoder_detects_on_linux_via_binary_and_settings() {
    let adapter = load_builtin("qoder-cli");
    let env = MockEnvironment::new(TargetOs::Linux, "/home/testuser");
    let mut fs = MockFileSystem::new();
    fs.add_binary("qodercli", PathBuf::from("/usr/local/bin/qodercli"));
    fs.add_file("/home/testuser/.qoder/settings.json", b"{}");

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
}

#[test]
fn test_qoder_detects_with_qoder_config_dir_override() {
    let adapter = load_builtin("qoder-cli");
    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser")
        .with_var("QODER_CONFIG_DIR", "/Users/testuser/custom-qoder");
    let mut fs = MockFileSystem::new();
    fs.add_dir(PathBuf::from("/Users/testuser/custom-qoder/projects"));

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
}

#[test]
fn test_qoder_detects_on_windows() {
    let adapter = load_builtin("qoder-cli");
    let env = MockEnvironment::new(TargetOs::Windows, "C:\\Users\\testuser");
    let mut fs = MockFileSystem::new();
    fs.add_dir(PathBuf::from("C:\\Users\\testuser\\.qoder\\projects"));

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
}

#[test]
fn test_qoder_not_installed_when_empty() {
    let adapter = load_builtin("qoder-cli");
    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let fs = MockFileSystem::new();
    let result = detect_agent(&adapter, &env, &fs);
    assert!(!result.installed);
}

#[test]
fn test_qoder_has_jsonl_history_source() {
    let adapter = load_builtin("qoder-cli");
    let source = adapter
        .history_sources
        .iter()
        .find(|s| s.format == "jsonl")
        .expect("qoder-cli should ship a jsonl history source");
    assert_eq!(
        source.source_unit.as_deref(),
        Some("file_per_session"),
        "qoder writes one transcript per session"
    );
}

// Every A2 adapter must name its family and kind so the Field Guide can group them.
#[test]
fn test_a2_adapters_have_metadata() {
    for id in ["aider", "goose", "amp", "kimi-code-cli", "qoder-cli"] {
        let adapter = load_builtin(id);
        assert!(!adapter.name.is_empty(), "{} missing name", id);
        assert!(!adapter.vendor.is_empty(), "{} missing vendor", id);
        assert!(!adapter.family.is_empty(), "{} missing family", id);
        assert_eq!(adapter.kind, "cli", "{} should be a cli", id);
        assert!(
            !adapter.detection.binaries.is_empty() || !adapter.detection.app_bundles.is_empty(),
            "{} needs a binary or bundle rule",
            id
        );
        for os in ["macos", "linux", "windows"] {
            assert!(
                adapter.detection.paths.contains_key(os),
                "{} missing detection paths for {}",
                id,
                os
            );
        }
    }
}
