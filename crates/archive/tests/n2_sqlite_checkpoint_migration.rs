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

/// sol-loop S7 with N2: a Cline task folder without task_metadata.json was named by its message file,
/// and the previous build stored that file's length as the offset. The offset is now 0 there, so
/// the stored one is rebased, and a reply that comes back shorter after the upgrade is a new
/// revision, not a truncation whose new generation collides with the accepted messages.
#[test]
fn an_archive_with_an_old_cline_task_offset_takes_a_shorter_reply() {
    let d = tempfile::tempdir().unwrap();
    let store = d.path().join("cline");
    let task = store.join("tasks").join("t1");
    std::fs::create_dir_all(&task).unwrap();
    let write_reply = |reply: &str| {
        let api = format!(r#"[{{"role":"user","content":"Hi","ts":1791816000000}},{{"role":"assistant","content":"{reply}","ts":1791816001000}}]"#);
        std::fs::write(task.join("api_conversation_history.json"), api).unwrap();
    };
    let def = get_builtin_adapter("cline").unwrap();
    let read = |a: &Archive| {
        let mut batches = AdapterEngine::fixture_batches(&def, &store).unwrap();
        batches.iter_mut().map(|b| { align(a, b); a.import_batch(b).unwrap() }).collect::<Vec<_>>()
    };
    let path = d.path().join("archive.db");
    write_reply("a long first answer about quillfern and more words after it");
    {
        let a = Archive::open(&path).unwrap();
        a.register_agent(&agent("cline")).unwrap();
        assert!(read(&a).iter().all(|o| o.applied));
    }
    let length = std::fs::metadata(task.join("api_conversation_history.json")).unwrap().len();
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute(&format!("UPDATE sources SET provenance=json_set(provenance,'$.checkpoint.offset',{length})"), []).unwrap();
        conn.execute(&format!("UPDATE sessions SET payload=json_set(payload,'$.provenance.checkpoint.offset',{length})"), []).unwrap();
        conn.execute_batch("PRAGMA user_version = 2").unwrap();
    }
    write_reply("zephyrwick");
    let a = Archive::open(&path).unwrap();
    let outcomes = read(&a);
    assert_eq!(outcomes.len(), 1);
    assert!(outcomes[0].applied, "{:?}", outcomes[0].reason);
    let key = AdapterEngine::fixture_batches(&def, &store).unwrap()[0].source.key();
    let accepted = a.source_checkpoint(&key).unwrap().unwrap();
    assert_eq!((accepted.generation, accepted.checkpoint.revision), (1, 2));
    assert_eq!(a.search("zephyrwick", &SearchFilter::default()).unwrap().len(), 1);
}

/// sol-loop N4: every Cline layout as the two earlier builds stored it. The public release (7da3bce)
/// stored the manifest's or metadata file's length, or the message file's for a task folder without
/// metadata; c75fece stored the sum of every file read. After the upgrade, unchanged input must
/// stay in generation 1: a new generation renames messages without native ids, which then collide
/// with the accepted ones.
#[test]
fn an_archive_from_an_earlier_build_reimports_every_unchanged_cline_layout() {
    for build in ["7da3bce", "c75fece"] {
        let d = tempfile::tempdir().unwrap();
        let store = d.path().join("cline");
        let cli = store.join("sessions").join("s1");
        let with_meta = store.join("tasks").join("t1");
        let without_meta = store.join("tasks").join("t2");
        for dir in [&cli, &with_meta, &without_meta] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(cli.join("s1.json"), r#"{"session_id":"s1","prompt":"Hi"}"#).unwrap();
        std::fs::write(cli.join("s1.messages.json"), r#"{"messages":[{"role":"user","content":"Hi"},{"role":"assistant","content":"quillfern"}]}"#).unwrap();
        let api = r#"[{"role":"user","content":"Hi","ts":1791816000000},{"role":"assistant","content":"quillfern","ts":1791816001000}]"#;
        let ui = r#"[{"type":"say","say":"text","text":"Hi","ts":1791816000000}]"#;
        std::fs::write(with_meta.join("task_metadata.json"), r#"{"taskId":"t1"}"#).unwrap();
        for dir in [&with_meta, &without_meta] {
            std::fs::write(dir.join("api_conversation_history.json"), api).unwrap();
            std::fs::write(dir.join("ui_messages.json"), ui).unwrap();
        }
        let def = get_builtin_adapter("cline").unwrap();
        let read = |a: &Archive| {
            let mut batches = AdapterEngine::fixture_batches(&def, &store).unwrap();
            let outcomes = batches.iter_mut().map(|b| { align(a, b); a.import_batch(b).unwrap() }).collect::<Vec<_>>();
            (batches, outcomes)
        };
        let path = d.path().join("archive.db");
        let first = {
            let a = Archive::open(&path).unwrap();
            a.register_agent(&agent("cline")).unwrap();
            let (batches, outcomes) = read(&a);
            assert!(outcomes.iter().all(|o| o.applied), "{build}: {outcomes:?}");
            batches
        };
        assert_eq!(first.len(), 3, "{build}: one batch per layout");
        let len = |p: &Path| std::fs::metadata(p).unwrap().len();
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            for b in &first {
                let primary = store.join(&b.source.source_path);
                let dir = primary.parent().unwrap();
                let files: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
                let offset: i64 = match build {
                    "7da3bce" => len(&primary) as i64,
                    _ => files.iter().map(|f| len(f) as i64).sum(),
                };
                // 7da3bce's digest covered the primary file only; c75fece's already folded every file.
                let digest = match build {
                    "7da3bce" => orrery_adapters::boundary::digest(&std::fs::read(&primary).unwrap()),
                    _ => b.source.checkpoint.digest.clone(),
                };
                let source_path = &b.source.source_path;
                conn.execute("UPDATE sources SET provenance=json_set(provenance,'$.checkpoint.offset',?1,'$.checkpoint.digest',?2) WHERE source_path=?3", rusqlite::params![offset, digest, source_path]).unwrap();
                conn.execute("UPDATE sessions SET payload=json_set(payload,'$.provenance.checkpoint.offset',?1,'$.provenance.checkpoint.digest',?2) WHERE json_extract(payload,'$.provenance.source_path')=?3", rusqlite::params![offset, digest, source_path]).unwrap();
            }
            conn.execute_batch("PRAGMA user_version = 2").unwrap();
        }
        let a = Archive::open(&path).unwrap();
        let (again, outcomes) = read(&a);
        for (b, o) in again.iter().zip(&outcomes) {
            // A replay is an unchanged checkpoint: nothing to write, and not an error.
            assert!(o.applied || o.reason.as_deref() == Some("replay"), "{build} {}: {:?}", b.source.source_path, o.reason);
            assert_eq!(b.source.generation, 1, "{build} {}: unchanged input keeps its generation", b.source.source_path);
        }
        assert_eq!(a.search("quillfern", &SearchFilter::default()).unwrap().len(), 3, "{build}");
    }
}
