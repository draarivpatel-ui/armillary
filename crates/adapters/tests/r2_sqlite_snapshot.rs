//! R2-RC-4: the module adapters' SQLite snapshot (Cursor CLI chats, Cline) uses the checked reader:
//! a write-ahead log that cannot be read safely fails the chat loudly instead of importing the main
//! file alone and reporting success.
use orrery_adapters::engine::SourceContext;
use orrery_adapters::*;
use rusqlite::Connection;
use std::path::Path;

fn tmp() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("armillary-r2fix-").tempdir_in("/tmp").unwrap()
}

/// A Cursor CLI chat store whose newest rows live only in the WAL (the writer stays open).
fn build(root: &Path, rows: usize) -> Connection {
    let chat = root.join("chats/h1/c1");
    std::fs::create_dir_all(&chat).unwrap();
    std::fs::write(chat.join("meta.json"), r#"{"agentId":"c1","name":"t"}"#).unwrap();
    let conn = Connection::open(chat.join("store.db")).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute("CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)", []).unwrap();
    conn.execute("INSERT INTO blobs(data) VALUES (?1)", [br#"{"role":"user","content":"seed row"}"#.to_vec()]).unwrap();
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).unwrap();
    conn.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    for i in 0..rows {
        let j = format!(r#"{{"role":"assistant","content":"row{i}"}}"#);
        conn.execute("INSERT INTO blobs(data) VALUES (?1)", [j.into_bytes()]).unwrap();
    }
    conn
}

fn batches(root: &Path) -> Vec<ImportBatch> {
    let adapter = get_builtin_adapter("cursor-cli").unwrap();
    let source = adapter
        .history_sources
        .iter()
        .find(|s| s.module.as_deref() == Some("cursor-cli"))
        .expect("cursor-cli module source")
        .clone();
    let root = root.canonicalize().unwrap();
    let context = SourceContext {
        store: StoreIdentity::new("cursor-cli", root.to_str().unwrap(), "profile"),
        approved_roots: vec![root.clone()],
        installation_id: None,
        generation: 1,
        revision: 1,
    };
    let env = MockEnvironment::new(TargetOs::Macos, root.to_str().unwrap());
    AdapterEngine::source_batches(&adapter, &source, &context, &env).unwrap()
}

#[test]
fn rows_in_the_wal_are_imported() {
    let d = tmp();
    let root = d.path().join("cursor");
    let _writer = build(&root, 10);
    let out = batches(&root);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].read_status, ReadStatus::Complete);
    assert_eq!(out[0].sessions[0].messages.len(), 11, "seed row plus the ten rows that live only in the WAL");
}

#[test]
fn an_unreadable_wal_fails_the_chat_instead_of_importing_part_of_it() {
    let d = tmp();
    let root = d.path().join("cursor");
    let writer = build(&root, 10);
    // Swap the WAL for a link that leaves the approved root: the boundary refuses it.
    let wal = root.join("chats/h1/c1/store.db-wal");
    let outside = d.path().join("outside-wal");
    std::fs::copy(&wal, &outside).unwrap();
    std::fs::remove_file(&wal).unwrap();
    std::os::unix::fs::symlink(&outside, &wal).unwrap();

    let out = batches(&root);
    assert!(
        out.iter().all(|b| b.read_status != ReadStatus::Complete || b.sessions.iter().all(|s| s.messages.len() != 1)),
        "the main file alone must never be reported as a complete chat"
    );
    let failed: Vec<&ImportBatch> = out.iter().filter(|b| b.read_status == ReadStatus::Failed).collect();
    assert_eq!(failed.len(), 1, "one Failed batch with a diagnostic: {:?}", out.iter().map(|b| b.read_status).collect::<Vec<_>>());
    assert_eq!(failed[0].diagnostics[0].code, "boundary");
    assert!(failed[0].sessions.is_empty());
    drop(writer);
}
