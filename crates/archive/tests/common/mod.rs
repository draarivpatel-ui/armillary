#![allow(dead_code)]
use orrery_archive::*;
pub fn agent(id: &str) -> Agent {
    Agent {
        id: id.into(),
        name: id.into(),
        vendor: "Synthetic".into(),
        family: "other".into(),
        kind: "cli".into(),
    }
}
pub fn archive() -> Archive {
    let a = Archive::in_memory().unwrap();
    a.register_agent(&agent("test")).unwrap();
    a
}
pub fn batch(n: u32, revision: u64, profile: &str) -> ImportBatch {
    let source = SourceProvenance {
        store: StoreIdentity::new("test-history", "fixture://test", profile),
        source_id: "history".into(),
        adapter_id: "test".into(),
        adapter_version: "1".into(),
        source_path: "session.jsonl".into(),
        file_identity: "synthetic:inode:1".into(),
        generation: 1,
        checkpoint: Checkpoint {
            revision,
            offset: n as u64 * 100,
            records: n as u64,
            digest: stable_id("checkpoint", &[&n.to_string()]),
        },
    };
    let id = stable_session_id(&source.store.id, "1");
    let messages = (1..=n)
        .map(|seq| {
            let native = format!("event-{seq}");
            Message {
                id: stable_message_id(&id, &native),
                session_id: id.clone(),
                native_id: Some(native),
                seq,
                role: if seq % 2 == 1 {
                    "user".into()
                } else {
                    "assistant".into()
                },
                at: Some(1_700_000_000_000 + seq as i64 * 1000),
                blocks: vec![ContentBlock::Text {
                    text: format!("canary{seq} synthetic message"),
                }],
            }
        })
        .collect::<Vec<_>>();
    let session = Session {
        id,
        agent_id: "test".into(),
        installation_id: None,
        native_id: Some("1".into()),
        provenance: source.clone(),
        project_root: Some("/synthetic".into()),
        title: Some("Test".into()),
        started_at: Some(1_700_000_000_000),
        ended_at: None,
        model: Some("test-model".into()),
        status: "unknown".into(),
        completion: None,
        turns: n.div_ceil(2),
        usage: Usage::default(),
        parent_id: None,
        native_parent_id: None,
    };
    ImportBatch {
        source,
        mode: ImportMode::Snapshot,
        read_status: ReadStatus::Complete,
        sessions: vec![NormalizedSession { session, messages }],
        diagnostics: vec![],
        live_updates: vec![],
    }
}
pub fn live(id: &str, state: LiveState) -> Live {
    Live {
        session_id: id.into(),
        state,
        since: Some(1_700_000_000_000),
        observed_at: 1_700_000_000_100,
        evidence: vec![Evidence {
            kind: "native_signal".into(),
            detail: "synthetic observation".into(),
            native_event_id: Some("state-1".into()),
            at: Some(1_700_000_000_100),
        }],
        confidence: Confidence::High,
        process: Some(ProcessIdentity {
            pid: 123,
            started_at: Some(1_700_000_000_000),
        }),
        expires_at: Some(1_700_000_060_000),
    }
}
pub fn evidence(kind: &str) -> Evidence {
    Evidence {
        kind: kind.into(),
        detail: "synthetic confirmed event".into(),
        native_event_id: Some("synthetic-confirmation".into()),
        at: Some(1_700_000_000_200),
    }
}
pub fn revision(b: &mut ImportBatch, r: u64) {
    b.source.checkpoint.revision = r;
    for n in &mut b.sessions {
        n.session.provenance = b.source.clone();
    }
}
