//! Explicit maintainer tool. Only synthetic reference fixtures are read or written.
//! Usage: `cargo run --offline -p orrery-adapters --example reference_goldens [agent-id ...]`
//! (no arguments regenerates the two reference adapters, claude-code and codex-cli).
use orrery_adapters::{get_builtin_adapter, AdapterEngine};
fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let mut ids: Vec<String> = std::env::args().skip(1).collect();
    if ids.is_empty() {
        ids = vec!["claude-code".into(), "codex-cli".into()];
    }
    for id in ids.iter().map(String::as_str) {
        let def = get_builtin_adapter(id).unwrap();
        let dir = root.join(id);
        let sessions = AdapterEngine::process_fixture_dir(&def, &dir).unwrap();
        std::fs::write(
            dir.join("expected.json"),
            serde_json::to_string_pretty(&sessions).unwrap() + "\n",
        )
        .unwrap();
    }
}
