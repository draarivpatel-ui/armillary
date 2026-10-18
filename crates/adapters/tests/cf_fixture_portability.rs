//! Reference goldens must survive checkout to a different directory/inode.
use orrery_adapters::{get_builtin_adapter, GoldenHarness};
#[test]
fn reference_golden_is_portable_to_a_new_filesystem_copy() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/claude-code");
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join("projects/my-web-app")).unwrap();
    std::fs::copy(
        root.join("projects/my-web-app/session-001.jsonl"),
        d.path().join("projects/my-web-app/session-001.jsonl"),
    )
    .unwrap();
    std::fs::copy(root.join("expected.json"), d.path().join("expected.json")).unwrap();
    GoldenHarness::run_test(&get_builtin_adapter("claude-code").unwrap(), d.path()).unwrap();
}
