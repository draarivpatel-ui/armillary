//! sol-loop N2: archives written before the SQLite stores (OpenCode, Crush, Goose, Hermes) moved to
//! byte-length checkpoints hold the old shape, with the total message count as offset and records.
//! The new reads report one record, which next to the old count looked like a truncation: the
//! importer started a new generation and the archive merged two copies of the same usage summary
//! and refused the import. Opening such an archive migrates the old checkpoints in place.
mod common;
use common::*;
use armillary_model::{normalized_message_id, ImportBatch};
use orrery_adapters::engine::AdapterEngine;
use orrery_adapters::get_builtin_adapter;
use orrery_archive::*;
use std::path::Path;

/// The importer's generation rule (app/src-tauri/src/importer.rs, `run_observed_seen`), repeated
/// here because the app crate is not a dependency of the archive tests.
fn align(a: &Archive, b: &mut ImportBatch) {
    let Some(old) = a.source_checkpoint(&b.source.key()).unwrap() else { return };
    let new = &b.source.checkpoint;
    let unchanged = new.offset == old.checkpoint.offset
        && new.records == old.checkpoint.records
        && new.digest == old.checkpoint.digest
        && b.source.file_identity == old.file_identity;
    if unchanged {
        b.source.generation = old.generation;
        b.source.checkpoint.revision = old.checkpoint.revision;
    } else if new.offset < old.checkpoint.offset
        || new.records < old.checkpoint.records
        || b.source.file_identity != old.file_identity
    {
        b.source.generation = old.generation + 1;
        b.source.checkpoint.revision = 1;
    } else {
        b.source.generation = old.generation;
        b.source.checkpoint.revision = old.checkpoint.revision + 1;
    }
    for s in &mut b.sessions {
        s.session.provenance = b.source.clone();
        for m in &mut s.messages {
            m.id = normalized_message_id(&s.session.id, m.native_id.as_deref(), &b.source.key(), b.source.generation, m.seq);
        }
    }
}

fn import(a: &Archive, root: &Path) -> Vec<ImportBatch> {
    let def = get_builtin_adapter("opencode").unwrap();
    let mut batches = AdapterEngine::fixture_batches(&def, root).unwrap();
    for b in &mut batches {
        align(a, b);
        a.import_batch(b).expect("import");
    }
    batches
}

fn copy_dir(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap();
    for entry in std::fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let to = dst.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &to);
        } else {
            std::fs::copy(entry.path(), &to).unwrap();
        }
    }
}

#[test]
fn an_archive_with_old_sqlite_checkpoints_still_imports_an_updated_database() {
    let d = tempfile::tempdir().unwrap();
    let store = d.path().join("opencode");
    copy_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/opencode"), &store);
    let path = d.path().join("archive.db");
    let first = {
        let a = Archive::open(&path).unwrap();
        a.register_agent(&agent("opencode")).unwrap();
        import(&a, &store)
    };
    let db = first.iter().find(|b| b.source.source_path.ends_with("opencode.db")).expect("database batch");
    let messages: usize = db.sessions.iter().map(|s| s.messages.len()).sum();
    assert!(messages > 1, "the fixture needs more than one message to look truncated");

    // Rewrite the archive as the previous build left it: message count as extents, schema 2.
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        let old = format!("json_set(%s,'$.checkpoint.offset',{messages},'$.checkpoint.records',{messages})");
        conn.execute(&format!("UPDATE sources SET provenance={} WHERE source_path LIKE '%opencode.db'", old.replace("%s", "provenance")), []).unwrap();
        let session_old = format!("json_set(payload,'$.provenance.checkpoint.offset',{messages},'$.provenance.checkpoint.records',{messages})");
        conn.execute(&format!("UPDATE sessions SET payload={session_old} WHERE json_extract(payload,'$.provenance.source_path') LIKE '%opencode.db'"), []).unwrap();
        conn.execute_batch("PRAGMA user_version = 2").unwrap();
    }
    // The agent goes on working: a cumulative counter (and so its usage summary) changes.
    {
        let conn = rusqlite::Connection::open(store.join("opencode.db")).unwrap();
        conn.execute("UPDATE session SET tokens_input = tokens_input + 1000, time_updated = time_updated + 60000", []).unwrap();
    }

    let a = Archive::open(&path).unwrap();
    let key = db.source.key();
    let migrated = a.source_checkpoint(&key).unwrap().unwrap();
    let second = import(&a, &store);
    assert_eq!(a.schema_version().unwrap(), 3);
    assert_eq!((migrated.generation, migrated.checkpoint.records), (1, 1), "the file keeps its generation");
    let again = second.iter().find(|b| b.source.key() == key).unwrap();
    assert_eq!(again.source.generation, 1, "an updated database is a new revision, not a rotation");
    let accepted = a.source_checkpoint(&key).unwrap().unwrap();
    assert_eq!(accepted.checkpoint.revision, 2);
    let session = a.get_session(&again.sessions[0].session.id).unwrap().unwrap();
    assert_eq!(session.usage.input_tokens, again.sessions[0].session.usage.input_tokens);
}

/// The v1 content copy runs once, with migration 2, and drops the v1 tables. Upgrading a schema 2
/// archive to schema 3 must not run it again: it would fail on the missing tables and the archive
/// would not open.
#[test]
fn a_schema_2_archive_with_migrated_v1_content_opens_at_schema_3() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("old.db");
    {
        let mut c = rusqlite::Connection::open(&p).unwrap();
        let tx = c.transaction().unwrap();
        orrery_archive::schema::migrate(&tx, 1).unwrap();
        orrery_archive::schema::set_version(&tx, 1).unwrap();
        tx.execute_batch("INSERT INTO agents VALUES('test','Test','Synthetic','other','cli'); INSERT INTO sessions VALUES('old','test','1','/synthetic','Old',1700000000000,NULL,NULL,'closed',1,0,0,NULL); INSERT INTO messages VALUES('old',0,'user','migrationcanary',1700000000000);").unwrap();
        tx.commit().unwrap();
    }
    drop(Archive::open(&p).unwrap());
    rusqlite::Connection::open(&p).unwrap().execute_batch("PRAGMA user_version = 2").unwrap();
    let a = Archive::open(&p).unwrap();
    assert_eq!(a.schema_version().unwrap(), 3);
    assert_eq!(a.stats().unwrap().sessions, 1);
    assert_eq!(a.search("migrationcanary", &SearchFilter::default()).unwrap().len(), 1);
}
