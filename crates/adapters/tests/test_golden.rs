use orrery_adapters::adapter_spec::AdapterDef;
use orrery_adapters::harness::GoldenHarness;
use std::path::PathBuf;

#[test]
fn test_golden_claude_code() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let toml_path = repo_root.join("crates/adapters/src/builtins/claude-code.toml");
    let fixture_dir = repo_root.join("fixtures/claude-code");

    let toml_content =
        std::fs::read_to_string(&toml_path).expect("claude-code.toml adapter spec should exist");
    let adapter = AdapterDef::from_toml(&toml_content).unwrap();

    run_fixture(&adapter, &fixture_dir);
}

#[test]
fn test_golden_codex_cli() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let toml_path = repo_root.join("crates/adapters/src/builtins/codex-cli.toml");
    let fixture_dir = repo_root.join("fixtures/codex-cli");

    let toml_content =
        std::fs::read_to_string(&toml_path).expect("codex-cli.toml adapter spec should exist");
    let adapter = AdapterDef::from_toml(&toml_content).unwrap();

    run_fixture(&adapter, &fixture_dir);
}

// A1 adapters batch.

#[test]
fn test_golden_gemini_cli() {
    run_golden("gemini-cli");
}

#[test]
fn test_golden_github_copilot_cli() {
    run_golden("github-copilot-cli");
}

#[test]
fn test_golden_opencode() {
    run_golden("opencode");
}

#[test]
fn test_golden_crush() {
    run_golden("crush");
}

#[test]
fn test_golden_qwen_code() {
    run_golden("qwen-code");
}

fn run_golden(agent_id: &str) {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let toml_path = repo_root.join(format!("crates/adapters/src/builtins/{}.toml", agent_id));
    let fixture_dir = repo_root.join(format!("fixtures/{}", agent_id));

    let toml_content = std::fs::read_to_string(&toml_path)
        .unwrap_or_else(|e| panic!("{}.toml adapter spec should exist: {}", agent_id, e));
    let adapter = AdapterDef::from_toml(&toml_content)
        .unwrap_or_else(|e| panic!("{}.toml adapter spec should parse: {}", agent_id, e));

    run_fixture(&adapter, &fixture_dir);
}

// A2 adapters batch.

#[test]
fn test_golden_aider() {
    run_golden("aider");
}

#[test]
fn test_golden_goose() {
    run_golden("goose");
}

#[test]
fn test_golden_amp() {
    run_golden("amp");
}

#[test]
fn test_golden_kimi_code_cli() {
    run_golden("kimi-code-cli");
}

#[test]
fn test_golden_qoder_cli() {
    run_golden("qoder-cli");
}

// A3 adapters batch.

#[test]
fn test_golden_cursor_cli() {
    run_golden("cursor-cli");
}

#[test]
fn test_golden_factory_droid() {
    run_golden("factory-droid");
}

#[test]
fn test_golden_augment_auggie_cli() {
    run_golden("augment-auggie-cli");
}

#[test]
fn test_golden_hermes_agent_cli() {
    run_golden("hermes-agent-cli");
}

#[test]
fn test_golden_antigravity_cli() {
    run_golden("antigravity-cli");
}

// A5 adapters batch (IDE extensions, detect only).

#[test]
fn test_golden_cline() {
    run_golden("cline");
}

#[test]
fn test_golden_roo_code() {
    run_golden("roo-code");
}

#[test]
fn test_golden_kilo_code() {
    run_golden("kilo-code");
}

#[test]
fn test_golden_continue() {
    run_golden("continue");
}


// A4 adapters batch.

#[test]
fn test_golden_iflow_cli() {
    run_golden("iflow-cli");
}

#[test]
fn test_golden_plandex() {
    run_golden("plandex");
}

#[test]
fn test_golden_gptme() {
    run_golden("gptme");
}

#[test]
fn test_golden_open_interpreter() {
    run_golden("open-interpreter");
}

#[test]
fn test_golden_openhands_cli() {
    run_golden("openhands-cli");
}

#[test]
fn test_golden_letta_code() {
    run_golden("letta-code");
}

#[test]
fn test_golden_grok_build_cli() {
    run_golden("grok-build-cli");
}

#[test]
fn test_golden_mistral_vibe_cli() {
    run_golden("mistral-vibe-cli");
}

fn run_fixture(adapter: &AdapterDef, dir: &std::path::Path) {
    GoldenHarness::run_test(adapter, dir).unwrap();
}

