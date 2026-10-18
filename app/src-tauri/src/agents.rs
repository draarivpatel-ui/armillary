use orrery_adapters::{
    detect_agent, AdapterDef, Environment, FileSystem, MockEnvironment, MockFileSystem, TargetOs,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentEntry {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub family: String,
    pub kind: String,
    pub installed: bool,
    pub version: Option<String>,
    pub data_paths: Vec<String>,
    pub default_data_paths: Vec<String>,
    pub coverage: Vec<String>,
    pub docs_url: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    /// Why a PATH hit was not counted (a generic program name with none of the agent's own
    /// data, config or app next to it). `None` when there is nothing to explain.
    #[serde(default)]
    pub detection_note: Option<String>,
}

pub(crate) fn normalize_family(family: &str) -> String {
    let lower = family.to_lowercase();
    match lower.as_str() {
        "anthropic" => "anthropic".to_string(),
        "openai" => "openai".to_string(),
        "google" => "google".to_string(),
        "github" | "microsoft" | "github-microsoft" | "github/microsoft" => {
            "github-microsoft".to_string()
        }
        "cursor" => "cursor".to_string(),
        "open-source" | "open-source-clis" | "open-source clis" | "opensource" => {
            "open-source-clis".to_string()
        }
        "chinese-labs" | "chinese labs" => "chinese-labs".to_string(),
        _ => "other".to_string(),
    }
}

pub fn get_docs_url(id: &str) -> Option<String> {
    match id {
        "claude-code" => {
            Some("https://docs.anthropic.com/en/docs/agents-and-tools/claude-code".to_string())
        }
        "codex-cli" => Some("https://github.com/openai/codex".to_string()),
        "gemini-cli" => Some("https://ai.google.dev".to_string()),
        "cursor" => Some("https://docs.cursor.com".to_string()),
        "aider" => Some("https://aider.chat".to_string()),
        "github-copilot-cli" => Some("https://docs.github.com/en/copilot".to_string()),
        _ => None,
    }
}

pub fn compute_coverage(spec: &AdapterDef) -> Vec<String> {
    let mut coverage = Vec::new();

    let has_detection = !spec.detection.binaries.is_empty()
        || !spec.detection.app_bundles.is_empty()
        || spec
            .detection
            .paths
            .values()
            .any(|p| !p.data_folders.is_empty() || !p.config_files.is_empty());
    if has_detection {
        coverage.push("detect".to_string());
    }

    if !spec.history_sources.is_empty() {
        coverage.push("history".to_string());
    }

    if spec.kind == "cli" || spec.id == "claude-code" || spec.id == "codex-cli" {
        coverage.push("live".to_string());
    }

    let has_config = spec
        .detection
        .paths
        .values()
        .any(|p| !p.config_files.is_empty());
    if has_config || spec.id == "claude-code" || spec.id == "codex-cli" {
        coverage.push("config".to_string());
    }

    coverage
}

pub fn get_default_data_paths(spec: &AdapterDef, os: TargetOs) -> Vec<String> {
    let os_key = os.as_str();
    if let Some(paths) = spec
        .detection
        .paths
        .get(os_key)
        .or_else(|| spec.detection.paths.get("default"))
    {
        paths.data_folders.clone()
    } else {
        Vec::new()
    }
}

pub fn load_builtin_specs() -> Vec<AdapterDef> {
    // The adapters crate compiles every builtin spec into the binary, so the list
    // is the same in development and in a packaged app.
    let mut specs = orrery_adapters::builtin_adapters();
    specs.sort_by(|a, b| a.id.cmp(&b.id));
    specs
}

pub fn agents_list_with_env(
    env: &dyn Environment,
    fs: &dyn FileSystem,
) -> Result<Vec<AgentEntry>, String> {
    let specs = load_builtin_specs();
    let mut entries = Vec::with_capacity(specs.len());

    for spec in specs {
        let detection = detect_agent(&spec, env, fs);
        let coverage = compute_coverage(&spec);
        let docs_url = spec.docs_url.clone().or_else(|| get_docs_url(&spec.id));
        let homepage = spec.homepage.clone();
        let detection_note = detection.reason.clone();
        let default_data_paths = get_default_data_paths(&spec, env.os());

        let data_paths: Vec<String> = detection
            .data_paths
            .into_iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();

        entries.push(AgentEntry {
            id: spec.id,
            name: spec.name,
            vendor: spec.vendor,
            family: normalize_family(&spec.family),
            kind: spec.kind,
            installed: detection.installed,
            version: detection.version,
            data_paths,
            default_data_paths,
            coverage,
            docs_url,
            homepage,
            detection_note,
        });
    }

    Ok(entries)
}

/// Consent-gated form of the command: nothing is detected (no file, no PATH lookup) unless the
/// first-run consent is recorded in `data_dir`.
pub fn agents_list_in(
    data_dir: &std::path::Path,
    env: &dyn Environment,
    fs: &dyn FileSystem,
) -> Result<Vec<AgentEntry>, crate::archive_api::ApiError> {
    crate::archive_api::consent::require(data_dir)?;
    agents_list_with_env(env, fs).map_err(|message| crate::archive_api::ApiError { code: "agents_failed".into(), message })
}

#[tauri::command]
pub fn agents_list(app: tauri::AppHandle) -> Result<Vec<AgentEntry>, crate::archive_api::ApiError> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| crate::archive_api::ApiError::archive_failed(format!("no app data dir: {e}")))?;
    crate::archive_api::consent::require(&data_dir)?;
    // ARMILLARY_DETECT_SCOPE=home confines detection to HOME (see scope.rs).
    let (env, fs) = crate::archive_api::scope::detection_env();
    agents_list_in(&data_dir, env.as_ref(), fs.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R2-REV-1 / LA-2: the Field Guide's agent list refuses after "Not now" and touches no file.
    #[test]
    fn agents_list_refuses_after_decline_and_touches_nothing() {
        use crate::archive_api::testkit::{tmp, write_consented, write_declined, CountingFs};
        let data = tmp();
        let home = tmp();
        std::fs::create_dir_all(home.path().join(".claude/projects/p")).unwrap();
        let env = MockEnvironment::new(TargetOs::current(), home.path().to_str().unwrap());
        for declined in [false, true] {
            if declined {
                write_declined(data.path());
            }
            let fs = CountingFs::new(home.path());
            let err = agents_list_in(data.path(), &env, &fs).unwrap_err();
            assert_eq!(err.code, "consent_required");
            assert_eq!(fs.count(), 0, "no filesystem call without consent");
        }
        write_consented(data.path());
        let fs = CountingFs::new(home.path());
        assert!(!agents_list_in(data.path(), &env, &fs).unwrap().is_empty());
        assert!(fs.count() > 0, "control: with consent detection runs");
    }

    #[test]
    fn test_agents_list_returns_all_builtins_with_mock_detection() {
        let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
        let mut fs = MockFileSystem::new();

        // Simulate claude binary on PATH with version companion
        let bin_path = PathBuf::from("/usr/local/bin/claude");
        fs.add_binary("claude", bin_path.clone());
        fs.add_file(
            PathBuf::from("/usr/local/bin/claude.version"),
            b"claude-code v1.0.12\n",
        );

        // Simulate data directory
        let claude_projects = PathBuf::from("/Users/testuser/.claude/projects");
        fs.add_dir(&claude_projects);

        let result =
            agents_list_with_env(&env, &fs).expect("agents_list_with_env should succeed");

        // Must return both builtins from crates/adapters
        assert!(
            result.len() >= 2,
            "Must return at least both builtin adapters"
        );

        let claude = result
            .iter()
            .find(|a| a.id == "claude-code")
            .expect("claude-code must be present");
        assert_eq!(claude.name, "Claude Code");
        assert_eq!(claude.vendor, "Anthropic");
        assert_eq!(claude.family, "anthropic");
        assert_eq!(claude.kind, "cli");
        assert!(claude.installed, "Claude Code should be detected as installed");
        // CF contract: detection is passive, so a binary on PATH is never run to ask for its
        // version. Version stays unknown until a passive source (a manifest) provides it.
        assert_eq!(claude.version, None);
        assert!(claude
            .data_paths
            .iter()
            .any(|p| p.contains(".claude/projects")));
        assert!(claude.coverage.contains(&"detect".to_string()));
        assert!(claude.coverage.contains(&"history".to_string()));
        assert!(claude.coverage.contains(&"live".to_string()));
        assert!(claude.coverage.contains(&"config".to_string()));
        assert!(claude.docs_url.is_some());

        let codex = result
            .iter()
            .find(|a| a.id == "codex-cli")
            .expect("codex-cli must be present");
        assert_eq!(codex.name, "OpenAI Codex CLI");
        assert_eq!(codex.vendor, "OpenAI");
        assert_eq!(codex.family, "openai");
        assert_eq!(codex.kind, "cli");
        assert!(
            !codex.installed,
            "Codex CLI should not be detected as installed"
        );
        assert_eq!(codex.version, None);
        assert!(codex.data_paths.is_empty());
        assert!(codex.coverage.contains(&"detect".to_string()));
        assert!(codex.coverage.contains(&"history".to_string()));
    }

    /// Formerly ran detection on the real machine; tests never read the real home folder, so this
    /// runs the same system detection confined to a fake HOME under /tmp.
    #[test]
    fn test_agents_list_with_system_env_in_fake_home() {
        let home = crate::archive_api::testkit::tmp();
        let env = MockEnvironment::new(TargetOs::current(), home.path().to_str().unwrap());
        let fs = crate::archive_api::testkit::CountingFs::new(home.path());
        let result = agents_list_with_env(&env, &fs).expect("agents_list should succeed");
        assert!(result.len() >= 2);
    }

    #[test]
    fn test_no_em_or_en_dashes_in_agent_metadata() {
        let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
        let fs = MockFileSystem::new();
        let result = agents_list_with_env(&env, &fs).expect("agents_list should succeed");

        for a in result {
            assert!(!a.name.contains('\u{2014}') && !a.name.contains('\u{2013}'));
            assert!(!a.vendor.contains('\u{2014}') && !a.vendor.contains('\u{2013}'));
            assert!(!a.kind.contains('\u{2014}') && !a.kind.contains('\u{2013}'));
            for cov in &a.coverage {
                assert!(!cov.contains('\u{2014}') && !cov.contains('\u{2013}'));
            }
        }
    }

    #[test]
    fn test_generic_binary_without_evidence_is_not_installed_and_says_why() {
        let env = MockEnvironment::new(TargetOs::Macos, "/Users/testuser");
        let mut fs = MockFileSystem::new();
        fs.add_binary("zero", PathBuf::from("/usr/local/bin/zero"));
        fs.add_binary("goose", PathBuf::from("/usr/local/bin/goose"));
        fs.add_binary("claude", PathBuf::from("/usr/local/bin/claude"));
        let result = agents_list_with_env(&env, &fs).unwrap();
        let find = |id: &str| result.iter().find(|a| a.id == id).unwrap().clone();

        let zero = find("zero");
        assert!(!zero.installed, "a bare `zero` on PATH is not the Zero agent");
        assert!(zero.detection_note.as_deref().unwrap_or("").contains("zero"));
        let goose = find("goose");
        assert!(!goose.installed);
        assert!(goose.detection_note.is_some());

        let claude = find("claude-code");
        assert!(claude.installed);
        assert_eq!(claude.detection_note, None);

        // With the agent's own folder the same PATH hit counts.
        fs.add_dir("/Users/testuser/.zero");
        let zero = agents_list_with_env(&env, &fs)
            .unwrap()
            .into_iter()
            .find(|a| a.id == "zero")
            .unwrap();
        assert!(zero.installed);
        assert_eq!(zero.detection_note, None);
    }
}
