//! P2-1 / V-REG-2 (r2 fix round 1): a module adapter's history file over the 64 MiB read limit must
//! come back as a Failed batch with a "limit" diagnostic and the file's own root-relative path (the
//! importer turns that into "Skipped, too large (over 64 MiB): <path>"), never a silent drop. One
//! case per module family; each also imports its normal fixture, so the rest still arrives.
//! The oversized files are sparse (set_len), so nothing large is written to disk.
use orrery_adapters::engine::SourceContext;
use orrery_adapters::*;
use std::path::Path;

fn tmp() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("armillary-r2fix-").tempdir_in("/tmp").unwrap()
}

fn copy_dir(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap();
    for entry in std::fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let to = dst.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &to);
        } else {
            std::fs::copy(entry.path(), &to).unwrap();
        }
    }
}

fn fixture(id: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures").join(id)
}

/// A file just over the limit, sparse.
fn oversized(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let f = std::fs::File::create(path).unwrap();
    f.set_len(boundary::MAX_SOURCE_BYTES + 1024).unwrap();
}

fn batches(adapter_id: &str, root: &Path) -> Vec<ImportBatch> {
    let adapter = get_builtin_adapter(adapter_id).unwrap();
    let source = adapter
        .history_sources
        .iter()
        .find(|s| s.module.is_some())
        .expect("module source")
        .clone();
    let root = root.canonicalize().unwrap();
    let context = SourceContext {
        store: StoreIdentity::new(adapter_id, root.to_str().unwrap(), "profile"),
        approved_roots: vec![root.clone()],
        installation_id: None,
        generation: 1,
        revision: 1,
    };
    let env = MockEnvironment::new(TargetOs::Macos, root.to_str().unwrap());
    AdapterEngine::source_batches(&adapter, &source, &context, &env).unwrap()
}

/// Stage the fixture plus one oversized file at `big` (relative to the root) and check the result.
fn check(adapter_id: &str, big: &str) {
    let d = tmp();
    let root = d.path().join(adapter_id);
    copy_dir(&fixture(adapter_id), &root);
    oversized(&root.join(big));
    let out = batches(adapter_id, &root);
    let summary: Vec<_> = out
        .iter()
        .map(|b| (b.read_status, b.source.source_path.clone(), b.diagnostics.first().map(|d| d.code.clone())))
        .collect();
    assert!(
        out.iter().any(|b| b.read_status == ReadStatus::Complete && !b.sessions.is_empty()),
        "{adapter_id}: the normal fixture still imports, got {summary:?}"
    );
    let limit: Vec<_> = out
        .iter()
        .filter(|b| b.read_status == ReadStatus::Failed && b.diagnostics.first().map(|d| d.code.as_str()) == Some("limit"))
        .collect();
    assert_eq!(limit.len(), 1, "{adapter_id}: exactly one Failed/limit batch, got {summary:?}");
    assert_eq!(limit[0].source.source_path, big, "{adapter_id}: the batch names the oversized file");
    assert!(limit[0].sessions.is_empty());
}

#[test]
fn continue_session_over_the_limit_is_reported() {
    check("continue", "sessions/big-session.json");
}

#[test]
fn roo_code_conversation_over_the_limit_is_reported() {
    check("roo-code", "tasks/roo-task-big/api_conversation_history.json");
}

#[test]
fn kilo_code_conversation_over_the_limit_is_reported() {
    check("kilo-code", "tasks/kilo-task-big/api_conversation_history.json");
}

#[test]
fn cline_task_over_the_limit_is_reported() {
    check("cline", "tasks/cline-task-big/api_conversation_history.json");
}

#[test]
fn cline_sessions_database_over_the_limit_is_reported_without_a_crash() {
    check("cline", "data/sessions.db");
}

#[test]
fn cursor_cli_transcript_over_the_limit_is_reported() {
    check("cursor-cli", "agent-transcripts/big-transcript.jsonl");
}

#[test]
fn kimi_code_state_over_the_limit_is_reported() {
    check("kimi-code-cli", "sessions/wd_big_000000000000/ses_big/state.json");
}

#[test]
fn antigravity_transcript_over_the_limit_is_reported() {
    check("antigravity-cli", "brain/big-0000/.system_generated/logs/transcript.jsonl");
}

/// A Roo Code task whose small files import while its conversation file is too large: the task is
/// still reported as skipped, so the user is told the conversation is missing.
#[test]
fn roo_code_task_with_small_files_and_an_oversized_conversation_is_reported() {
    let d = tmp();
    let root = d.path().join("roo-code");
    copy_dir(&fixture("roo-code"), &root);
    let task = root.join("tasks/roo-task-4002");
    copy_dir(&root.join("tasks/roo-task-4001"), &task);
    std::fs::remove_file(task.join("api_conversation_history.json")).unwrap();
    oversized(&task.join("api_conversation_history.json"));
    let out = batches("roo-code", &root);
    assert!(
        out.iter().any(|b| b.read_status == ReadStatus::Failed
            && b.source.source_path == "tasks/roo-task-4002/api_conversation_history.json"
            && b.diagnostics.first().map(|d| d.code.as_str()) == Some("limit")),
        "got {:?}",
        out.iter().map(|b| (b.read_status, b.source.source_path.clone())).collect::<Vec<_>>()
    );
}

/// Modules that already report their own failed reads are not reported twice.
#[test]
fn sqlite_and_amp_modules_report_an_oversized_file_once() {
    check("opencode", "extra/opencode.db");
    check("goose", "extra/sessions.sqlite");
    check("amp", "threads/T-big.json");
}
