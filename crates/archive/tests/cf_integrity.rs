mod common;
use common::*;
use orrery_archive::*;
#[test]
fn delayed_snapshot_and_truncation_do_not_replace_newer_data() {
    let a = archive();
    let b = batch(5, 5, "p");
    a.import_batch(&b).unwrap();
    assert!(!a.import_batch(&batch(2, 2, "p")).unwrap().applied);
    assert!(a.import_batch(&batch(2, 6, "p")).is_err());
    assert_eq!(a.stats().unwrap().messages, 5);
    assert_eq!(
        a.source_checkpoint(&b.source.key()).unwrap(),
        Some(b.source)
    );
}
#[test]
fn append_requires_exact_checkpoint_and_keeps_earlier_events() {
    let a = archive();
    let first = batch(2, 1, "p");
    a.import_batch(&first).unwrap();
    let mut delta = batch(4, 2, "p");
    delta.mode = ImportMode::Append {
        from: first.source.checkpoint.clone(),
    };
    delta.sessions[0].messages.drain(..2);
    a.import_batch(&delta).unwrap();
    assert_eq!(a.stats().unwrap().messages, 4);
    assert_eq!(a.stats().unwrap().search_rows, 4);
    let mut wrong = batch(5, 3, "p");
    wrong.mode = ImportMode::Append {
        from: first.source.checkpoint.clone(),
    };
    wrong.sessions[0].messages.drain(..4);
    assert!(a.import_batch(&wrong).is_err());
    assert_eq!(a.stats().unwrap().messages, 4);
}
#[test]
fn failed_import_rolls_back_messages_fts_checkpoint_and_live() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("archive.db");
    let a = Archive::open(&p).unwrap();
    a.register_agent(&agent("test")).unwrap();
    let first = batch(2, 1, "p");
    a.import_batch(&first).unwrap();
    let before = a.stats().unwrap();
    let c = rusqlite::Connection::open(&p).unwrap();
    c.execute_batch("CREATE TRIGGER fail_third BEFORE INSERT ON messages WHEN NEW.seq=3 BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;").unwrap();
    let mut next = batch(4, 2, "p");
    let id = next.sessions[0].session.id.clone();
    next.live_updates = vec![LiveMutation {
        session_id: id.clone(),
        action: LiveAction::Update {
            value: live(&id, LiveState::Working),
        },
    }];
    assert!(a.import_batch(&next).is_err());
    assert_eq!(a.stats().unwrap(), before);
    assert_eq!(a.session_messages(&id).unwrap(), first.sessions[0].messages);
    assert_eq!(
        a.source_checkpoint(&first.source.key()).unwrap(),
        Some(first.source)
    );
    assert!(a.live_list().unwrap().is_empty());
    assert!(a
        .search("canary3", &SearchFilter::default())
        .unwrap()
        .is_empty());
    assert_eq!(
        a.search("canary2", &SearchFilter::default()).unwrap().len(),
        1
    );
}
#[test]
fn absence_is_not_deletion_and_confirmed_deletion_removes_fts() {
    let a = archive();
    let b = batch(2, 1, "p");
    a.import_batch(&b).unwrap();
    let mut empty = b.clone();
    revision(&mut empty, 2);
    empty.sessions.clear();
    a.import_batch(&empty).unwrap();
    assert_eq!(a.stats().unwrap().sessions, 1);
    let bogus = ConfirmedSourceDeletion {
        source: b.source.clone(),
        evidence: evidence("missing_on_scan"),
    };
    assert!(a.confirm_source_deleted(&bogus).is_err());
    a.confirm_source_deleted(&ConfirmedSourceDeletion {
        source: empty.source.clone(),
        evidence: evidence("confirmed_source_deletion"),
    })
    .unwrap();
    assert_eq!(a.stats().unwrap().messages, 0);
    assert_eq!(a.stats().unwrap().search_rows, 0);
    assert!(!a.import_batch(&b).unwrap().applied);
}
#[test]
fn rotation_retains_history_and_rejects_delayed_old_file() {
    let a = archive();
    let old = batch(4, 1, "p");
    a.import_batch(&old).unwrap();
    let mut rotated = batch(4, 1, "p");
    rotated.source.generation = 2;
    rotated.source.file_identity = "synthetic:inode:2".into();
    revision(&mut rotated, 1);
    rotated.sessions[0].messages.clear();
    a.import_batch(&rotated).unwrap();
    assert_eq!(a.stats().unwrap().messages, 4);
    assert!(!a.import_batch(&old).unwrap().applied);
}
#[test]
fn unknown_usage_and_timestamp_remain_distinct_from_zero() {
    let a = archive();
    let mut b = batch(1, 1, "p");
    b.sessions[0].session.started_at = None;
    b.sessions[0].messages[0].at = None;
    a.import_batch(&b).unwrap();
    let got = a.get_session(&b.sessions[0].session.id).unwrap().unwrap();
    assert_eq!(got.started_at, None);
    assert_eq!(got.usage.input_tokens, None);
    assert_eq!(
        a.search("canary1", &SearchFilter::default()).unwrap()[0].at,
        None
    );
}
#[test]
fn live_without_evidence_and_stale_observation_are_rejected() {
    let a = archive();
    let b = batch(1, 1, "p");
    a.import_batch(&b).unwrap();
    let id = b.sessions[0].session.id.clone();
    let good = live(&id, LiveState::Waiting);
    a.live_update(&LiveMutation {
        session_id: id.clone(),
        action: LiveAction::Update {
            value: good.clone(),
        },
    })
    .unwrap();
    let mut stale = good.clone();
    stale.observed_at -= 1;
    assert!(a
        .live_update(&LiveMutation {
            session_id: id.clone(),
            action: LiveAction::Update { value: stale }
        })
        .is_err());
    let mut bad = good.clone();
    bad.evidence.clear();
    assert!(a
        .live_update(&LiveMutation {
            session_id: id.clone(),
            action: LiveAction::Update { value: bad }
        })
        .is_err());
    assert_eq!(a.live_list().unwrap(), vec![good]);
}
#[test]
fn native_completion_is_required_before_session_can_be_done() {
    let a = archive();
    let mut b = batch(1, 1, "p");
    b.sessions[0].session.status = "done".into();
    assert!(a.import_batch(&b).is_err());
}
#[test]
fn native_ids_are_immutable_within_an_append() {
    let a = archive();
    let base = batch(2, 1, "p");
    a.import_batch(&base).unwrap();
    let mut b = batch(3, 2, "p");
    b.mode = ImportMode::Append {
        from: base.source.checkpoint,
    };
    b.sessions[0].messages[0].blocks = vec![ContentBlock::Text {
        text: "mutated accepted event".into(),
    }];
    assert!(a.import_batch(&b).is_err());
    assert_eq!(a.stats().unwrap().messages, 2);
}
#[test]
fn v1_migration_preserves_content_and_marks_unresolved_identity() {
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
    let a = Archive::open(&p).unwrap();
    assert_eq!(a.schema_version().unwrap(), 2);
    let s = a
        .sessions_query(&SessionFilter::default())
        .unwrap()
        .items
        .remove(0);
    assert_eq!(s.native_id.as_deref(), Some("1"));
    assert_eq!(s.provenance.store.profile_id, "legacy-unresolved");
    assert_eq!(s.status, "unknown");
    assert_eq!(
        a.search("migrationcanary", &SearchFilter::default())
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        a.diagnostics(&s.provenance.key()).unwrap()[0].code,
        "legacy_identity_unresolved"
    );
}
#[test]
fn reference_adapter_to_archive_preserves_tools_and_hit_timestamps() {
    let a = Archive::in_memory().unwrap();
    let def = orrery_adapters::get_builtin_adapter("claude-code").unwrap();
    a.register_agent(&agent("claude-code")).unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/claude-code");
    let batches = orrery_adapters::AdapterEngine::fixture_batches(&def, &root).unwrap();
    for b in &batches {
        a.import_batch(b).unwrap();
    }
    let id = &batches[0].sessions[0].session.id;
    assert_eq!(
        a.session_messages(id).unwrap(),
        batches[0].sessions[0].messages
    );
    let hits = a.search("Read", &SearchFilter::default()).unwrap();
    assert_eq!(hits[0].seq, 2);
    assert_eq!(hits[0].at, Some(1_791_814_205_000));
    let result = a.search("scripts", &SearchFilter::default()).unwrap();
    assert!(result.iter().any(|h| h.seq == 3 && h.kind == HitKind::Tool));
}
#[test]
fn failed_reader_batch_preserves_archive_and_records_its_source_diagnostic() {
    let d = tempfile::tempdir().unwrap();
    fs_fixture(d.path(),b"{\"sessionId\":\"s\",\"uuid\":\"m1\",\"message\":{\"role\":\"user\",\"content\":\"archivecanary\"}}\n");
    let a = Archive::in_memory().unwrap();
    a.register_agent(&agent("claude-code")).unwrap();
    let def = orrery_adapters::get_builtin_adapter("claude-code").unwrap();
    let first = orrery_adapters::AdapterEngine::fixture_batches(&def, d.path())
        .unwrap()
        .remove(0);
    a.import_batch(&first).unwrap();
    fs_fixture(d.path(),b"{\"sessionId\":\"s\",\"uuid\":\"m1\",\"message\":{\"role\":\"user\",\"content\":\"prefix\"}}\n\xff\n");
    let failed = orrery_adapters::AdapterEngine::fixture_batches(&def, d.path())
        .unwrap()
        .remove(0);
    assert_eq!(failed.read_status, ReadStatus::Failed);
    assert!(!a.import_batch(&failed).unwrap().applied);
    assert_eq!(
        a.search("archivecanary", &SearchFilter::default())
            .unwrap()
            .len(),
        1
    );
    assert!(a
        .diagnostics(&first.source.key())
        .unwrap()
        .iter()
        .any(|d| d.code == "io"));
}
fn fs_fixture(root: &std::path::Path, bytes: &[u8]) {
    std::fs::create_dir_all(root.join("projects/test")).unwrap();
    std::fs::write(root.join("projects/test/s.jsonl"), bytes).unwrap();
}
#[test]
fn stale_live_removal_cannot_erase_a_newer_observation() {
    let a = archive();
    let b = batch(1, 1, "p");
    a.import_batch(&b).unwrap();
    let id = b.sessions[0].session.id.clone();
    a.live_update(&LiveMutation {
        session_id: id.clone(),
        action: LiveAction::Update {
            value: live(&id, LiveState::Working),
        },
    })
    .unwrap();
    let mut e = evidence("native_completion");
    e.at = Some(1);
    assert!(a
        .live_update(&LiveMutation {
            session_id: id,
            action: LiveAction::Remove { evidence: e }
        })
        .is_err());
    assert_eq!(a.live_list().unwrap().len(), 1);
}
#[test]
#[cfg(unix)]
fn disk_archive_and_wal_companions_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("private.db");
    let a = Archive::open(&p).unwrap();
    a.register_agent(&agent("test")).unwrap();
    a.import_batch(&batch(2, 1, "p")).unwrap();
    for p in [
        p.clone(),
        p.with_file_name("private.db-wal"),
        p.with_file_name("private.db-shm"),
    ] {
        assert_eq!(
            std::fs::metadata(p).unwrap().permissions().mode() & 0o077,
            0
        );
    }
}
#[test]
fn later_snapshot_of_rotated_file_keeps_prior_generation_history() {
    let a = archive();
    let old = batch(4, 1, "p");
    a.import_batch(&old).unwrap();
    let mut rotated = old.clone();
    rotated.source.generation = 2;
    rotated.source.file_identity = "synthetic:inode:2".into();
    revision(&mut rotated, 1);
    rotated.sessions[0].messages.clear();
    a.import_batch(&rotated).unwrap();
    revision(&mut rotated, 2);
    a.import_batch(&rotated).unwrap();
    assert_eq!(a.stats().unwrap().messages, 4);
    assert_eq!(
        a.search("canary4", &SearchFilter::default()).unwrap().len(),
        1
    );
}
