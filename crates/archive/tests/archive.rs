//! Archive acceptance tests migrated to the frozen contract without losing the original query/search gates.
mod common;
use common::*;
use orrery_archive::*;
#[test]
fn model_serde_roundtrip() {
    let b = batch(4, 1, "p");
    assert_eq!(
        b,
        serde_json::from_str::<ImportBatch>(&serde_json::to_string(&b).unwrap()).unwrap()
    );
    let l = live(&b.sessions[0].session.id, LiveState::Waiting);
    assert_eq!(
        l,
        serde_json::from_str::<Live>(&serde_json::to_string(&l).unwrap()).unwrap()
    );
}
#[test]
fn times_are_unix_milliseconds() {
    let a = archive();
    let b = batch(1, 1, "p");
    a.import_batch(&b).unwrap();
    assert_eq!(
        a.get_session(&b.sessions[0].session.id)
            .unwrap()
            .unwrap()
            .started_at,
        Some(1_700_000_000_000)
    );
    assert_eq!(
        a.session_messages(&b.sessions[0].session.id).unwrap()[0].at,
        Some(1_700_000_001_000)
    );
}
#[test]
fn migrations_create_schema_and_are_versioned() {
    let a = archive();
    assert_eq!(a.schema_version().unwrap(), 3);
    assert_eq!(a.stats().unwrap().messages, 0);
}
#[test]
fn migrations_are_idempotent_and_data_persists_across_reopen() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("archive.db");
    let b = batch(4, 1, "p");
    {
        let a = Archive::open(&p).unwrap();
        a.register_agent(&agent("test")).unwrap();
        a.import_batch(&b).unwrap();
    }
    let a = Archive::open(&p).unwrap();
    assert_eq!(a.schema_version().unwrap(), 3);
    assert_eq!(a.stats().unwrap().messages, 4);
    assert!(!a.import_batch(&b).unwrap().applied);
    assert_eq!(a.stats().unwrap().search_rows, 4);
}
#[test]
fn session_id_is_stable_hash_of_store_and_native_id() {
    let a = archive();
    let b = batch(2, 1, "p");
    a.import_batch(&b).unwrap();
    assert!(a
        .get_session(&stable_session_id(&b.source.store.id, "1"))
        .unwrap()
        .is_some());
}
#[test]
fn reimport_is_idempotent() {
    let a = archive();
    let b = batch(4, 1, "p");
    a.import_batch(&b).unwrap();
    let before = a.stats().unwrap();
    a.import_batch(&b).unwrap();
    assert_eq!(a.stats().unwrap(), before);
}
#[test]
fn reimport_updates_changed_fields_and_content() {
    let a = archive();
    let mut b = batch(3, 1, "p");
    a.import_batch(&b).unwrap();
    revision(&mut b, 2);
    b.sessions[0].session.title = Some("Changed title".into());
    b.sessions[0].messages[0].blocks = vec![ContentBlock::Text {
        text: "replacement keyword".into(),
    }];
    a.import_batch(&b).unwrap();
    assert_eq!(
        a.get_session(&b.sessions[0].session.id)
            .unwrap()
            .unwrap()
            .title,
        Some("Changed title".into())
    );
    assert!(a
        .search("canary1", &SearchFilter::default())
        .unwrap()
        .is_empty());
    assert_eq!(
        a.search("replacement", &SearchFilter::default())
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn import_rejects_bad_input() {
    let a = archive();
    let mut b = batch(1, 1, "p");
    b.sessions[0].session.native_id = Some(String::new());
    assert!(a.import_batch(&b).is_err());
    assert_eq!(a.stats().unwrap().sessions, 0);
    assert_eq!(a.diagnostics(&b.source.key()).unwrap().len(), 1);
}
#[test]
fn import_reads_back_in_order() {
    let a = archive();
    let b = batch(5, 1, "p");
    a.import_batch(&b).unwrap();
    assert_eq!(
        a.session_messages(&b.sessions[0].session.id).unwrap(),
        b.sessions[0].messages
    );
}
#[test]
fn live_state_roundtrip_and_update() {
    let a = archive();
    let b = batch(1, 1, "p");
    a.import_batch(&b).unwrap();
    let id = &b.sessions[0].session.id;
    let l = live(id, LiveState::Waiting);
    a.live_update(&LiveMutation {
        session_id: id.clone(),
        action: LiveAction::Update { value: l.clone() },
    })
    .unwrap();
    assert_eq!(a.live_list().unwrap(), vec![l]);
    a.live_update(&LiveMutation {
        session_id: id.clone(),
        action: LiveAction::Preserve,
    })
    .unwrap();
    assert_eq!(a.live_list().unwrap().len(), 1);
}
fn seed(a: &Archive) -> Vec<String> {
    (0..5)
        .map(|i| {
            let mut b = batch(3, 1, &format!("p{i}"));
            b.sessions[0].session.project_root =
                Some(if i % 2 == 0 { "/even" } else { "/odd" }.into());
            b.sessions[0].session.started_at = Some(1_700_000_000_000 + i * 1000);
            let id = b.sessions[0].session.id.clone();
            a.import_batch(&b).unwrap();
            id
        })
        .collect()
}
#[test]
fn sessions_query_filters() {
    let a = archive();
    seed(&a);
    assert_eq!(
        a.sessions_query(&SessionFilter {
            project: Some("/even".into()),
            ..Default::default()
        })
        .unwrap()
        .total,
        3
    );
    assert_eq!(
        a.sessions_query(&SessionFilter {
            agent: Some("missing".into()),
            ..Default::default()
        })
        .unwrap()
        .total,
        0
    );
    assert_eq!(
        a.sessions_query(&SessionFilter {
            from: Some(1_700_000_003_000),
            to: Some(1_700_000_004_000),
            status: Some("unknown".into()),
            model: Some("test-model".into()),
            ..Default::default()
        })
        .unwrap()
        .total,
        2
    );
}
#[test]
fn sessions_query_paging() {
    let a = archive();
    seed(&a);
    let p = a
        .sessions_query(&SessionFilter {
            limit: Some(2),
            offset: Some(2),
            ..Default::default()
        })
        .unwrap();
    assert_eq!((p.items.len(), p.total, p.limit, p.offset), (2, 5, 2, 2));
    let id = &p.items[0].id;
    let m = a.messages_page(id, 1, 1).unwrap();
    assert_eq!((m.items[0].seq, m.total), (2, 3));
}
#[test]
fn search_ranks_messages_with_snippets_and_position() {
    let a = archive();
    let b = batch(2, 1, "p");
    a.import_batch(&b).unwrap();
    let r = a.search("canary1", &SearchFilter::default()).unwrap();
    assert_eq!(r.len(), 1);
    assert!(r[0]
        .snippet
        .contains(&format!("{HIT_START}canary1{HIT_END}")));
    assert!(!r[0].snippet.contains("<mark>"));
    assert_eq!((r[0].seq, r[0].block_index), (1, 0));
    assert_eq!(r[0].message_id, b.sessions[0].messages[0].id);
}
#[test]
fn search_finds_tool_names_and_file_paths() {
    let a = archive();
    let mut b = batch(2, 1, "p");
    b.sessions[0].messages[1]
        .blocks
        .push(ContentBlock::ToolCall {
            call_id: "c".into(),
            native_id: Some("c".into()),
            name: "read_file".into(),
            input: serde_json::json!({"path":"src/main.rs"}),
            files: vec!["src/main.rs".into()],
        });
    a.import_batch(&b).unwrap();
    for q in ["read_file", "main.rs"] {
        let r = a.search(q, &SearchFilter::default()).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(
            (r[0].seq, r[0].block_index, r[0].at),
            (2, 1, b.sessions[0].messages[1].at)
        );
        assert_eq!(r[0].kind, HitKind::Tool);
    }
}
#[test]
fn search_filters_and_empty_query() {
    let a = archive();
    seed(&a);
    assert!(a.search(" ", &SearchFilter::default()).unwrap().is_empty());
    assert_eq!(
        a.search(
            "canary1",
            &SearchFilter {
                project: Some("/even".into()),
                ..Default::default()
            }
        )
        .unwrap()
        .len(),
        3
    );
    assert!(a
        .search(
            "canary1",
            &SearchFilter {
                from: Some(1_800_000_000_000),
                ..Default::default()
            }
        )
        .unwrap()
        .is_empty());
    assert_eq!(
        a.search(
            "canary1",
            &SearchFilter {
                limit: Some(2),
                offset: Some(2),
                ..Default::default()
            }
        )
        .unwrap()
        .len(),
        2
    );
}
#[test]
fn search_survives_reimport_without_duplicates() {
    let a = archive();
    let mut b = batch(2, 1, "p");
    a.import_batch(&b).unwrap();
    revision(&mut b, 2);
    a.import_batch(&b).unwrap();
    assert_eq!(
        a.search("canary1", &SearchFilter::default()).unwrap().len(),
        1
    );
    assert_eq!(a.stats().unwrap().search_rows, 2);
}
#[test]
fn compact_preserves_data_and_search() {
    let a = archive();
    let b = batch(3, 1, "p");
    a.import_batch(&b).unwrap();
    let before = a.search("canary2", &SearchFilter::default()).unwrap();
    a.compact().unwrap();
    assert_eq!(
        a.search("canary2", &SearchFilter::default()).unwrap(),
        before
    );
    assert_eq!(a.stats().unwrap().messages, 3);
}
#[test]
#[ignore = "performance gate; run in release with --ignored"]
fn bench_100k_messages_search_under_200ms() {
    let a = archive();
    let b = batch(100_000, 1, "p");
    a.import_batch(&b).unwrap();
    let start = std::time::Instant::now();
    assert_eq!(
        a.search("canary50000", &SearchFilter::default())
            .unwrap()
            .len(),
        1
    );
    assert!(start.elapsed() < std::time::Duration::from_millis(200));
}
#[test]
fn hit_markers_are_private_use_sentinels() {
    assert_eq!(HIT_START, '\u{E000}');
    assert_eq!(HIT_END, '\u{E001}');
}
#[test]
fn literal_mark_text_is_not_confused_with_hit_markers() {
    let a = archive();
    let mut b = batch(1, 1, "p");
    b.sessions[0].messages[0].blocks = vec![ContentBlock::Text {
        text: "use the <mark>tag</mark> sparingly".into(),
    }];
    a.import_batch(&b).unwrap();
    let r = a.search("sparingly", &SearchFilter::default()).unwrap();
    assert_eq!(r.len(), 1);
    assert!(r[0].snippet.contains("<mark>tag</mark>"));
    assert!(r[0]
        .snippet
        .contains(&format!("{HIT_START}sparingly{HIT_END}")));
}
#[test]
fn recent_diagnostics_are_newest_first_and_limited() {
    let a = archive();
    let mut first = batch(1, 1, "p");
    first.sessions[0].session.native_id = Some(String::new());
    let mut second = batch(1, 1, "q");
    second.sessions[0].session.native_id = Some(String::new());
    assert!(a.recent_diagnostics(10).unwrap().is_empty());
    assert!(a.import_batch(&first).is_err());
    assert!(a.import_batch(&second).is_err());
    let all = a.recent_diagnostics(10).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].source_key, second.source.key(), "newest first");
    assert_eq!(all[1].source_key, first.source.key());
    assert_eq!(a.recent_diagnostics(1).unwrap().len(), 1);
    assert_eq!(a.recent_diagnostics(0).unwrap().len(), 1, "limit clamps to at least 1");
    assert_eq!(a.recent_diagnostics(u32::MAX).unwrap().len(), 2, "limit clamps to at most 500");
}

/// A batch whose messages have no native ids, so their ids come from the
/// message-path fallback and therefore include the source generation.
fn fallback_batch(seqs: &[u32], generation: u64, revision: u64) -> ImportBatch {
    let mut b = batch(*seqs.last().unwrap(), revision, "p");
    b.source.generation = generation;
    b.source.file_identity = format!("synthetic:inode:{generation}");
    let key = b.source.key();
    let session_id = b.sessions[0].session.id.clone();
    b.sessions[0].session.provenance = b.source.clone();
    b.sessions[0].messages.retain(|m| seqs.contains(&m.seq));
    for m in &mut b.sessions[0].messages {
        m.native_id = None;
        m.id = normalized_message_id(&session_id, None, &key, generation, m.seq);
    }
    b
}

#[test]
fn new_generation_with_conflicting_fallback_ids_is_refused_cleanly() {
    let a = archive();
    let gen1 = fallback_batch(&[1, 2, 3], 1, 1);
    a.import_batch(&gen1).unwrap();
    let key = gen1.source.key();
    let session_id = gen1.sessions[0].session.id.clone();
    let messages_before = a.session_messages(&session_id).unwrap();
    let session_before = a.get_session(&session_id).unwrap();
    let stats_before = a.stats().unwrap();
    let search_before = a.search("canary2", &SearchFilter::default()).unwrap();
    assert_eq!(search_before.len(), 1);

    // Same records, new generation: every fallback id changes but the seqs repeat.
    let gen2 = fallback_batch(&[1, 2, 3], 2, 1);
    assert_ne!(gen2.sessions[0].messages[0].id, gen1.sessions[0].messages[0].id);
    let outcome = a
        .import_batch(&gen2)
        .expect("a conflicting new generation is a clean refusal, not a raw error");
    assert!(!outcome.applied);
    assert_eq!(outcome.reason.as_deref(), Some("conflicting_sequence"));

    let diagnostics = a.diagnostics(&key).unwrap();
    assert_eq!(diagnostics.len(), 1, "exactly one diagnostic: {diagnostics:?}");
    assert_eq!(diagnostics[0].code, "conflicting_sequence");
    assert!(
        !diagnostics[0].message.contains("UNIQUE") && !diagnostics[0].message.contains("sqlite"),
        "{}",
        diagnostics[0].message
    );
    assert!(diagnostics[0].message.contains(&session_id), "{}", diagnostics[0].message);
    assert!(diagnostics[0].message.contains("seq 1"), "{}", diagnostics[0].message);

    assert_eq!(a.source_checkpoint(&key).unwrap().unwrap(), gen1.source);
    assert_eq!(a.session_messages(&session_id).unwrap(), messages_before);
    assert_eq!(a.get_session(&session_id).unwrap(), session_before);
    assert_eq!(a.stats().unwrap(), stats_before);
    assert_eq!(
        a.search("canary2", &SearchFilter::default()).unwrap(),
        search_before
    );
}

#[test]
fn conflict_names_the_first_conflicting_seq() {
    let a = archive();
    let gen1 = fallback_batch(&[1, 2, 3], 1, 1);
    a.import_batch(&gen1).unwrap();
    // Generation 2 omits seq 1, so the first collision is at seq 2.
    let gen2 = fallback_batch(&[2, 3, 4], 2, 1);
    let outcome = a.import_batch(&gen2).unwrap();
    assert_eq!(outcome.reason.as_deref(), Some("conflicting_sequence"));
    let d = a.diagnostics(&gen1.source.key()).unwrap();
    assert_eq!(d.len(), 1);
    assert!(d[0].message.contains("seq 2"), "{}", d[0].message);
    assert_eq!(a.stats().unwrap().messages, 3);
}

#[test]
fn new_generation_adding_only_new_seqs_with_fallback_ids_is_accepted() {
    let a = archive();
    let gen1 = fallback_batch(&[1, 2, 3], 1, 1);
    a.import_batch(&gen1).unwrap();
    let gen2 = fallback_batch(&[4, 5], 2, 1);
    let outcome = a.import_batch(&gen2).unwrap();
    assert!(outcome.applied, "{outcome:?}");
    assert_eq!(a.stats().unwrap().messages, 5);
    assert_eq!(
        a.source_checkpoint(&gen2.source.key()).unwrap().unwrap(),
        gen2.source
    );
    assert!(a.diagnostics(&gen2.source.key()).unwrap().is_empty());
    assert_eq!(a.search("canary5", &SearchFilter::default()).unwrap().len(), 1);
}

#[test]
fn new_generation_repeating_native_id_messages_plus_new_seqs_is_accepted() {
    let a = archive();
    let gen1 = batch(3, 1, "p");
    a.import_batch(&gen1).unwrap();
    let mut gen2 = batch(5, 1, "p");
    gen2.source.generation = 2;
    gen2.source.file_identity = "synthetic:inode:2".into();
    gen2.sessions[0].session.provenance = gen2.source.clone();
    let outcome = a.import_batch(&gen2).unwrap();
    assert!(outcome.applied, "{outcome:?}");
    let session_id = &gen1.sessions[0].session.id;
    let seqs: Vec<u32> = a
        .session_messages(session_id)
        .unwrap()
        .iter()
        .map(|m| m.seq)
        .collect();
    assert_eq!(seqs, vec![1, 2, 3, 4, 5]);
    assert_eq!(a.stats().unwrap().messages, 5);
    assert_eq!(a.stats().unwrap().search_rows, 5);
    assert!(a.diagnostics(&gen2.source.key()).unwrap().is_empty());
}

// ---------- activity span and first prompt (read-only helpers) ----------

fn text(t: &str) -> ContentBlock {
    ContentBlock::Text { text: t.into() }
}

/// A one-session batch whose messages are (role, time, blocks), imported into a fresh archive.
fn custom(profile: &str, msgs: Vec<(&str, Option<i64>, Vec<ContentBlock>)>) -> ImportBatch {
    let mut b = batch(msgs.len() as u32, 1, profile);
    for (m, (role, at, blocks)) in b.sessions[0].messages.iter_mut().zip(msgs) {
        m.role = role.into();
        m.at = at;
        m.blocks = blocks;
    }
    b
}

#[test]
fn session_activity_is_min_and_max_message_time_not_first_and_last_row() {
    let a = archive();
    let b = custom(
        "p",
        vec![
            ("user", Some(5_000), vec![text("a")]),
            ("assistant", Some(2_000), vec![text("b")]),
            ("user", Some(9_000), vec![text("c")]),
            ("assistant", Some(7_000), vec![text("d")]),
        ],
    );
    a.import_batch(&b).unwrap();
    let id = b.sessions[0].session.id.clone();
    let act = a.session_activity(&[id.clone()]).unwrap();
    assert_eq!(act[&id], SessionActivity { first_at: Some(2_000), last_at: Some(9_000) });
}

#[test]
fn session_activity_ignores_unknown_times_and_stays_unknown_when_all_are() {
    let a = archive();
    let some = custom(
        "p1",
        vec![
            ("user", None, vec![text("a")]),
            ("assistant", Some(4_000), vec![text("b")]),
            ("user", None, vec![text("c")]),
        ],
    );
    let none = custom("p2", vec![("user", None, vec![text("a")]), ("assistant", None, vec![text("b")])]);
    a.import_batch(&some).unwrap();
    a.import_batch(&none).unwrap();
    let (s, n) = (some.sessions[0].session.id.clone(), none.sessions[0].session.id.clone());
    let act = a.session_activity(&[s.clone(), n.clone(), "missing".to_string()]).unwrap();
    assert_eq!(act[&s], SessionActivity { first_at: Some(4_000), last_at: Some(4_000) });
    assert_eq!(act[&n], SessionActivity { first_at: None, last_at: None }, "unknown is never zero");
    assert_eq!(act["missing"], SessionActivity::default(), "an unknown session id still gets an entry");
}

#[test]
fn first_user_text_skips_assistant_tool_only_and_blank_messages() {
    let a = archive();
    let b = custom(
        "p",
        vec![
            ("assistant", Some(1_000), vec![text("assistant opens")]),
            (
                "user",
                Some(2_000),
                vec![ContentBlock::ToolResult {
                    call_id: "c1".into(),
                    output: serde_json::json!("tool only"),
                    is_error: None,
                }],
            ),
            ("user", Some(3_000), vec![text("   \n ")]),
            (
                "user",
                Some(4_000),
                vec![ContentBlock::Code { code: "let x = 1;".into(), language: None }, text("the real prompt")],
            ),
            ("user", Some(5_000), vec![text("a later prompt")]),
        ],
    );
    let no_user = custom("p2", vec![("assistant", Some(1_000), vec![text("only assistant")])]);
    a.import_batch(&b).unwrap();
    a.import_batch(&no_user).unwrap();
    let (id, other) = (b.sessions[0].session.id.clone(), no_user.sessions[0].session.id.clone());
    let texts = a.first_user_texts(&[id.clone(), other.clone()]).unwrap();
    assert_eq!(texts.get(&id).map(String::as_str), Some("the real prompt"));
    assert!(!texts.contains_key(&other), "no user text means no entry");
}

#[test]
fn first_user_text_is_capped() {
    let a = archive();
    let long = "x".repeat(FIRST_TEXT_MAX_CHARS + 500);
    let b = custom("p", vec![("user", Some(1_000), vec![text(&long)])]);
    a.import_batch(&b).unwrap();
    let id = b.sessions[0].session.id.clone();
    let got = &a.first_user_texts(&[id.clone()]).unwrap()[&id];
    assert_eq!(got.chars().count(), FIRST_TEXT_MAX_CHARS);
}

#[test]
fn get_message_returns_one_stored_message_by_id() {
    let a = archive();
    let b = batch(3, 1, "p");
    a.import_batch(&b).unwrap();
    let want = &b.sessions[0].messages[1];
    assert_eq!(a.get_message(&want.id).unwrap().as_ref(), Some(want));
    assert_eq!(a.get_message("nope").unwrap(), None);
}
