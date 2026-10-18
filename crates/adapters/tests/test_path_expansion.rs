use orrery_adapters::env::{MockEnvironment, TargetOs};
use orrery_adapters::path_expansion::{expand_path, PathError};
use std::path::PathBuf;

#[test]
fn test_expand_macos_home() {
    let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
    let result = expand_path("~/.claude/projects/*/*.jsonl", TargetOs::Macos, &env).unwrap();
    assert_eq!(
        result,
        PathBuf::from("/Users/testuser/.claude/projects/*/*.jsonl")
    );
}

#[test]
fn test_expand_linux_home_and_env() {
    let env = MockEnvironment::new(TargetOs::Linux, "/home/testuser")
        .with_var("CODEX_HOME", "/home/testuser/custom_codex");
    let result = expand_path(
        "$CODEX_HOME/sessions/**/rollout-*.jsonl",
        TargetOs::Linux,
        &env,
    )
    .unwrap();
    assert_eq!(
        result,
        PathBuf::from("/home/testuser/custom_codex/sessions/**/rollout-*.jsonl")
    );

    let result2 = expand_path("${CODEX_HOME}/sessions", TargetOs::Linux, &env).unwrap();
    assert_eq!(
        result2,
        PathBuf::from("/home/testuser/custom_codex/sessions")
    );
}

#[test]
fn test_expand_windows_userprofile_and_appdata() {
    let env = MockEnvironment::new(TargetOs::Windows, "C:\\Users\\testuser")
        .with_var("APPDATA", "C:\\Users\\testuser\\AppData\\Roaming");

    let result = expand_path(
        "%USERPROFILE%\\.codex\\config.toml",
        TargetOs::Windows,
        &env,
    )
    .unwrap();
    assert_eq!(
        result,
        PathBuf::from("C:\\Users\\testuser\\.codex\\config.toml")
    );

    let result_appdata = expand_path(
        "%APPDATA%\\Claude\\local-agent-mode-sessions",
        TargetOs::Windows,
        &env,
    )
    .unwrap();
    assert_eq!(
        result_appdata,
        PathBuf::from("C:\\Users\\testuser\\AppData\\Roaming\\Claude\\local-agent-mode-sessions")
    );
}

#[test]
fn test_expand_missing_env_error() {
    let env = MockEnvironment::new(TargetOs::Linux, "/home/testuser");
    let result = expand_path("$NON_EXISTENT_VAR/path", TargetOs::Linux, &env);
    assert_eq!(
        result,
        Err(PathError::UnresolvedEnv("NON_EXISTENT_VAR".to_string()))
    );
}
