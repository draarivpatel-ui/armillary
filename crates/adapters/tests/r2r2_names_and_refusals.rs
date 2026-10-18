//! r2 fix round 2.
//! R-5: agent history folders encode the project path in their names (Claude Code's
//! projects/-Users-dev-code-keychain-app), so below an agent's folder a folder name is checked
//! against credential stores (.ssh, .aws, ...) only, and every file name in full. A project called
//! keychain-app keeps its history; key files and credential stores stay refused.
//! RR1-3: a module adapter's history file that cannot be opened (no permission, or a link out of
//! the folder) is reported as a Failed batch with its path, like a file over the size limit.
use orrery_adapters::boundary::ReadBoundary;
use orrery_adapters::engine::SourceContext;
use orrery_adapters::readers::jsonl::ReaderError;
use orrery_adapters::*;
use std::path::Path;

fn tmp() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("armillary-r2r2-").tempdir_in("/tmp").unwrap()
}

fn write(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, "{}\n").unwrap();
}

#[test]
fn a_history_folder_named_after_a_keychain_project_is_read() {
    let d = tmp();
    let root = d.path().join(".claude").canonicalize().unwrap_or_else(|_| {
        std::fs::create_dir_all(d.path().join(".claude")).unwrap();
        d.path().join(".claude").canonicalize().unwrap()
    });
    let session = root.join("projects/-Users-dev-code-keychain-app/session-001.jsonl");
    let dotted = root.join("projects/-Users-dev-code-notes.pem/session-002.jsonl");
    write(&session);
    write(&dotted);
    let boundary = ReadBoundary::new(&[root.clone()]).unwrap();
    assert!(boundary.read(&session).is_ok(), "{:?}", boundary.read(&session).err());
    assert!(boundary.read(&dotted).is_ok(), "{:?}", boundary.read(&dotted).err());
}

#[test]
fn key_files_and_credential_stores_below_the_folder_stay_refused() {
    let d = tmp();
    std::fs::create_dir_all(d.path().join("agent")).unwrap();
    let root = d.path().join("agent").canonicalize().unwrap();
    let boundary = ReadBoundary::new(&[root.clone()]).unwrap();
    for refused in [
        ".ssh/id_rsa",
        ".ssh/config",
        "projects/p/.aws/config",
        "projects/p/auth.json",
        "projects/p/server.key",
        "projects/p/.env",
        "projects/p/login.keychain-db",
        "Keychains/data.db",
    ] {
        let path = root.join(refused);
        write(&path);
        match boundary.read(&path) {
            Err(ReaderError::CredentialBlocked(_)) => {}
            other => panic!("{refused}: {:?}", other.map(|b| b.bytes.len())),
        }
    }
    // A link from inside the folder to a file outside it is still refused.
    let outside = d.path().join("outside.jsonl");
    write(&outside);
    let link = root.join("projects/p/link.jsonl");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    assert!(boundary.read(&link).is_err());
    // An agent folder that is itself named like a key file is still refused as a whole.
    std::fs::create_dir_all(d.path().join("my.keychain")).unwrap();
    assert!(ReadBoundary::new(&[d.path().join("my.keychain").canonicalize().unwrap()]).is_err());
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

fn batches(adapter_id: &str, root: &Path) -> Vec<ImportBatch> {
    let adapter = get_builtin_adapter(adapter_id).unwrap();
    let source = adapter.history_sources.iter().find(|s| s.module.is_some()).unwrap().clone();
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

/// Stage the fixture, add one history file at `rel` that cannot be opened, and check it is
/// reported by path while the fixture still imports.
fn check_refused(adapter_id: &str, rel: &str, linked: bool) {
    let d = tmp();
    let root = d.path().join(adapter_id);
    copy_dir(&fixture(adapter_id), &root);
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    if linked {
        let outside = d.path().join("outside.json");
        std::fs::write(&outside, "[]").unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
    } else {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(&path, "[]").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    }
    let out = batches(adapter_id, &root);
    let summary: Vec<_> = out
        .iter()
        .map(|b| (b.read_status, b.source.source_path.clone(), b.diagnostics.first().map(|d| d.code.clone())))
        .collect();
    assert!(
        out.iter().any(|b| b.read_status == ReadStatus::Complete && !b.sessions.is_empty()),
        "{adapter_id}: the normal fixture still imports, got {summary:?}"
    );
    let failed: Vec<_> = out
        .iter()
        .filter(|b| b.read_status == ReadStatus::Failed && b.source.source_path == rel)
        .collect();
    assert_eq!(failed.len(), 1, "{adapter_id} {rel} linked={linked}: one Failed batch naming it, got {summary:?}");
    assert!(!failed[0].diagnostics.is_empty());
}

#[test]
fn unreadable_and_linked_history_files_in_module_families_are_reported() {
    for (adapter, rel) in [
        ("continue", "sessions/locked-session.json"),
        ("roo-code", "tasks/roo-task-locked/api_conversation_history.json"),
        ("kilo-code", "tasks/kilo-task-locked/api_conversation_history.json"),
        ("cline", "tasks/cline-task-locked/api_conversation_history.json"),
    ] {
        check_refused(adapter, rel, false);
        check_refused(adapter, rel, true);
    }
}

/// Optional companion files that are simply missing are not reported (SQLite -wal/-shm, Kimi's
/// wire.jsonl): the plain fixtures give no Failed batch.
#[test]
fn missing_optional_files_are_not_reported() {
    for adapter in ["continue", "roo-code", "kilo-code", "cline", "kimi-code-cli", "opencode", "goose"] {
        if !fixture(adapter).is_dir() {
            continue;
        }
        let d = tmp();
        let root = d.path().join(adapter);
        copy_dir(&fixture(adapter), &root);
        let out = batches(adapter, &root);
        let failed: Vec<_> = out
            .iter()
            .filter(|b| b.read_status != ReadStatus::Complete)
            .map(|b| (b.source.source_path.clone(), b.diagnostics.first().map(|d| d.message.clone())))
            .collect();
        assert!(failed.is_empty(), "{adapter}: {failed:?}");
    }
}
