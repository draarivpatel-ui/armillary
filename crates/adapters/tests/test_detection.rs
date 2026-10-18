use orrery_adapters::adapter_spec::AdapterDef;
use orrery_adapters::detection::detect_agent;
use orrery_adapters::env::{MockEnvironment, MockFileSystem, TargetOs};
use std::path::PathBuf;

fn create_claude_adapter_def() -> AdapterDef {
    let toml_str = r#"
id = "claude-code"
name = "Claude Code"
vendor = "Anthropic"
family = "Anthropic"
kind = "cli"

[detection]
binaries = ["claude"]
app_bundles = ["Claude"]

[detection.paths.macos]
data_folders = ["~/.claude/projects"]
config_files = ["~/.claude/settings.json"]
"#;
    AdapterDef::from_toml(toml_str).unwrap()
}

#[test]
fn test_detect_claude_installed_via_binary_and_folder() {
    let adapter = create_claude_adapter_def();
    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let mut fs = MockFileSystem::new();

    // Add binary on path
    fs.add_binary("claude", PathBuf::from("/usr/local/bin/claude"));
    // Add data folder
    fs.add_dir(PathBuf::from("/Users/testuser/.claude/projects"));

    let result = detect_agent(&adapter, &env, &fs);

    assert!(result.installed);
    assert_eq!(
        result.data_paths,
        vec![PathBuf::from("/Users/testuser/.claude/projects")]
    );
}

#[test]
fn test_detect_not_installed() {
    let adapter = create_claude_adapter_def();
    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let fs = MockFileSystem::new();

    let result = detect_agent(&adapter, &env, &fs);

    assert!(!result.installed);
    assert!(result.data_paths.is_empty());
    assert_eq!(result.version, None);
}

#[test]
fn test_detection_leaves_version_unknown_without_an_explicit_probe() {
    let toml_str = r#"
id = "codex-cli"
name = "OpenAI Codex CLI"
vendor = "OpenAI"
family = "OpenAI"
kind = "cli"

[detection]
binaries = ["codex"]

[detection.paths.macos]
data_folders = ["~/.codex/sessions"]
config_files = ["~/.codex/config.toml"]
"#;
    let adapter = AdapterDef::from_toml(toml_str).unwrap();
    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let mut fs = MockFileSystem::new();

    fs.add_binary("codex", PathBuf::from("/usr/local/bin/codex"));
    // Add version file or cheap version info
    fs.add_file("/usr/local/bin/codex.version", b"0.162.1");

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
    assert_eq!(result.version, None);
}

#[test]
fn test_detect_app_bundle_macos() {
    let adapter = create_claude_adapter_def();
    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let mut fs = MockFileSystem::new();

    // No binary on path, but App bundle exists in /Applications
    fs.add_dir(PathBuf::from("/Applications/Claude.app"));

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
}

#[test]
fn test_detect_gemini_cli() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let toml_path = repo_root.join("crates/adapters/src/builtins/gemini-cli.toml");
    let toml_content = std::fs::read_to_string(toml_path).unwrap();
    let adapter = AdapterDef::from_toml(&toml_content).unwrap();

    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let mut fs = MockFileSystem::new();
    fs.add_binary("gemini", PathBuf::from("/usr/local/bin/gemini"));
    fs.add_dir(PathBuf::from("/Users/testuser/.gemini/tmp"));

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
    assert_eq!(
        result.data_paths,
        vec![PathBuf::from("/Users/testuser/.gemini/tmp")]
    );
}

#[test]
fn test_detect_github_copilot_cli_windows() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let toml_path = repo_root.join("crates/adapters/src/builtins/github-copilot-cli.toml");
    let toml_content = std::fs::read_to_string(toml_path).unwrap();
    let adapter = AdapterDef::from_toml(&toml_content).unwrap();

    let env = MockEnvironment::new(TargetOs::Windows, "C:\\Users\\testuser");
    let mut fs = MockFileSystem::new();
    fs.add_binary(
        "copilot",
        PathBuf::from("C:\\Users\\testuser\\AppData\\Local\\copilot.exe"),
    );
    fs.add_dir(PathBuf::from(
        "C:\\Users\\testuser\\.copilot\\session-state",
    ));

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
    assert_eq!(
        result.data_paths,
        vec![PathBuf::from(
            "C:\\Users\\testuser\\.copilot\\session-state"
        )]
    );
}

#[test]
fn test_detect_opencode_app_bundle_macos() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let toml_path = repo_root.join("crates/adapters/src/builtins/opencode.toml");
    let toml_content = std::fs::read_to_string(toml_path).unwrap();
    let adapter = AdapterDef::from_toml(&toml_content).unwrap();

    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let mut fs = MockFileSystem::new();
    fs.add_dir(PathBuf::from("/Applications/ai.opencode.desktop.app"));

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
}

#[test]
fn test_detect_crush_binary_and_config() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let toml_path = repo_root.join("crates/adapters/src/builtins/crush.toml");
    let toml_content = std::fs::read_to_string(toml_path).unwrap();
    let adapter = AdapterDef::from_toml(&toml_content).unwrap();

    let env = MockEnvironment::new(TargetOs::Linux, "/home/testuser");
    let mut fs = MockFileSystem::new();
    fs.add_binary("crush", PathBuf::from("/usr/bin/crush"));
    fs.add_file("/home/testuser/.config/crush/crushrc", b"# crush config");

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
}

#[test]
fn test_detect_qwen_code_linux() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let toml_path = repo_root.join("crates/adapters/src/builtins/qwen-code.toml");
    let toml_content = std::fs::read_to_string(toml_path).unwrap();
    let adapter = AdapterDef::from_toml(&toml_content).unwrap();

    let env = MockEnvironment::new(TargetOs::Linux, "/home/testuser");
    let mut fs = MockFileSystem::new();
    fs.add_binary("qwen", PathBuf::from("/usr/bin/qwen"));
    fs.add_file("/home/testuser/.qwen/settings.json", b"{}");

    let result = detect_agent(&adapter, &env, &fs);
    assert!(result.installed);
}

#[test]
fn test_builtin_adapters_registry_and_a3_agents() {
    use orrery_adapters::{builtin_adapters, get_builtin_adapter};

    let all = builtin_adapters();
    // Every adapter file in builtins/ must be registered.
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/builtins");
    let toml_files = std::fs::read_dir(dir)
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .path()
                .extension()
                .map(|x| x == "toml")
                .unwrap_or(false)
        })
        .count();
    assert_eq!(all.len(), toml_files);

    let a3_ids = [
        "cursor-cli",
        "factory-droid",
        "augment-auggie-cli",
        "hermes-agent-cli",
        "antigravity-cli",
    ];

    for id in a3_ids {
        let adapter = get_builtin_adapter(id).unwrap_or_else(|| panic!("Builtin {} not found", id));
        assert_eq!(adapter.id, id);
        assert!(!adapter.detection.binaries.is_empty());
        assert!(adapter.detection.paths.contains_key("macos"));
        assert!(adapter.detection.paths.contains_key("linux"));
        assert!(adapter.detection.paths.contains_key("windows"));
    }
}

#[test]
fn test_detect_a3_agents_installed() {
    use orrery_adapters::get_builtin_adapter;

    // Test cursor-cli detection via binary and data folder
    let cursor = get_builtin_adapter("cursor-cli").unwrap();
    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let mut fs = MockFileSystem::new();
    fs.add_binary("agent", PathBuf::from("/usr/local/bin/agent"));
    // SEC: `agent` is a generic name and ~/.cursor is also the Cursor IDE's folder, so the
    // CLI's own config file is what corroborates it (see test_sec_detection.rs).
    fs.add_file(
        PathBuf::from("/Users/testuser/.cursor/cli-config.json"),
        b"{}",
    );
    let res = detect_agent(&cursor, &env, &fs);
    assert!(res.installed);

    // Test factory-droid detection on Linux
    let droid = get_builtin_adapter("factory-droid").unwrap();
    let env_linux = MockEnvironment::new(TargetOs::Linux, "/home/testuser");
    let mut fs_linux = MockFileSystem::new();
    fs_linux.add_binary("droid", PathBuf::from("/usr/bin/droid"));
    fs_linux.add_dir(PathBuf::from("/home/testuser/.factory/sessions"));
    let res_droid = detect_agent(&droid, &env_linux, &fs_linux);
    assert!(res_droid.installed);

    // Test augment-auggie-cli detection on Windows
    let auggie = get_builtin_adapter("augment-auggie-cli").unwrap();
    let env_win = MockEnvironment::new(TargetOs::Windows, "C:\\Users\\testuser")
        .with_var("USERPROFILE", "C:\\Users\\testuser");
    let mut fs_win = MockFileSystem::new();
    fs_win.add_binary(
        "auggie",
        PathBuf::from("C:\\Program Files\\nodejs\\auggie.cmd"),
    );
    fs_win.add_dir(PathBuf::from("C:\\Users\\testuser\\.augment\\sessions"));
    let res_auggie = detect_agent(&auggie, &env_win, &fs_win);
    assert!(res_auggie.installed);

    // Test hermes-agent-cli detection on macOS
    let hermes = get_builtin_adapter("hermes-agent-cli").unwrap();
    let mut fs_hermes = MockFileSystem::new();
    fs_hermes.add_binary("hermes", PathBuf::from("/usr/local/bin/hermes"));
    fs_hermes.add_file("/Users/testuser/.hermes/state.db", b"");
    let res_hermes = detect_agent(&hermes, &env, &fs_hermes);
    assert!(res_hermes.installed);

    // Test antigravity-cli detection on macOS
    let agy = get_builtin_adapter("antigravity-cli").unwrap();
    let mut fs_agy = MockFileSystem::new();
    fs_agy.add_binary("agy", PathBuf::from("/Users/testuser/.local/bin/agy"));
    fs_agy.add_dir(PathBuf::from("/Users/testuser/.gemini/antigravity-cli"));
    let res_agy = detect_agent(&agy, &env, &fs_agy);
    assert!(res_agy.installed);
}

#[test]
fn test_detect_cline_vscode_and_cursor() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let toml_path = repo_root.join("crates/adapters/src/builtins/cline.toml");
    let toml_content =
        std::fs::read_to_string(&toml_path).expect("cline.toml adapter spec should exist");
    let adapter = AdapterDef::from_toml(&toml_content).unwrap();

    let env_mac = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let mut fs_mac = MockFileSystem::new();
    fs_mac.add_dir(PathBuf::from(
        "/Users/testuser/Library/Application Support/Cursor/User/globalStorage/saoudrizwan.claude-dev",
    ));
    let res_mac = detect_agent(&adapter, &env_mac, &fs_mac);
    assert!(res_mac.installed);
    assert_eq!(
        res_mac.data_paths,
        vec![PathBuf::from(
            "/Users/testuser/Library/Application Support/Cursor/User/globalStorage/saoudrizwan.claude-dev"
        )]
    );

    let env_win = MockEnvironment::new(TargetOs::Windows, "C:\\Users\\testuser");
    let mut fs_win = MockFileSystem::new();
    fs_win.add_dir(PathBuf::from(
        "C:\\Users\\testuser\\AppData\\Roaming\\Code\\User\\globalStorage\\saoudrizwan.claude-dev",
    ));
    let res_win = detect_agent(&adapter, &env_win, &fs_win);
    assert!(res_win.installed);
}

#[test]
fn test_detect_roo_code_windsurf() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let toml_path = repo_root.join("crates/adapters/src/builtins/roo-code.toml");
    let toml_content =
        std::fs::read_to_string(&toml_path).expect("roo-code.toml adapter spec should exist");
    let adapter = AdapterDef::from_toml(&toml_content).unwrap();

    let env_linux = MockEnvironment::new(TargetOs::Linux, "/home/testuser");
    let mut fs_linux = MockFileSystem::new();
    fs_linux.add_dir(PathBuf::from(
        "/home/testuser/.config/Windsurf/User/globalStorage/rooveterinaryinc.roo-cline",
    ));
    let res_linux = detect_agent(&adapter, &env_linux, &fs_linux);
    assert!(res_linux.installed);
}

#[test]
fn test_detect_kilo_code_vscode() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let toml_path = repo_root.join("crates/adapters/src/builtins/kilo-code.toml");
    let toml_content =
        std::fs::read_to_string(&toml_path).expect("kilo-code.toml adapter spec should exist");
    let adapter = AdapterDef::from_toml(&toml_content).unwrap();

    let env_mac = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let mut fs_mac = MockFileSystem::new();
    fs_mac.add_dir(PathBuf::from(
        "/Users/testuser/Library/Application Support/Code/User/globalStorage/kilocode.kilo-code",
    ));
    let res_mac = detect_agent(&adapter, &env_mac, &fs_mac);
    assert!(res_mac.installed);
}

#[test]
fn test_detect_continue_config_and_vscode() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let toml_path = repo_root.join("crates/adapters/src/builtins/continue.toml");
    let toml_content =
        std::fs::read_to_string(&toml_path).expect("continue.toml adapter spec should exist");
    let adapter = AdapterDef::from_toml(&toml_content).unwrap();

    let env_mac = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let mut fs_mac = MockFileSystem::new();
    fs_mac.add_file("/Users/testuser/.continue/config.json", b"{}");
    let res_mac = detect_agent(&adapter, &env_mac, &fs_mac);
    assert!(res_mac.installed);
}
