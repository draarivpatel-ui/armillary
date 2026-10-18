//! Same CF scenarios as the red baseline, using the frozen envelope.
mod common;
use common::*;
use orrery_archive::*;
#[test]
fn adapter_and_archive_ids_must_share_one_algorithm() {
    let b = batch(4, 1, "p1");
    let a = archive();
    a.import_batch(&b).unwrap();
    let id = orrery_adapters::stable_session_id(&b.source.store.id, "1");
    assert_eq!(id, stable_session_id(&b.source.store.id, "1"));
    assert_eq!(a.get_session(&id).unwrap().unwrap(), b.sessions[0].session);
}
#[test]
fn incomplete_prefix_cannot_replace_one_hundred_messages() {
    let a = archive();
    let b = batch(100, 1, "p1");
    a.import_batch(&b).unwrap();
    let mut prefix = batch(2, 2, "p1");
    prefix.read_status = ReadStatus::Incomplete;
    assert!(!a.import_batch(&prefix).unwrap().applied);
    assert_eq!(
        a.session_messages(&b.sessions[0].session.id).unwrap().len(),
        100
    );
    assert_eq!(
        a.search("canary99", &SearchFilter::default())
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        a.source_checkpoint(&b.source.key()).unwrap(),
        Some(b.source)
    );
}
#[test]
fn two_profiles_with_native_id_one_cannot_collide() {
    let a = archive();
    let one = batch(1, 1, "p1");
    let two = batch(1, 1, "p2");
    a.import_batch(&one).unwrap();
    a.import_batch(&two).unwrap();
    assert_ne!(one.sessions[0].session.id, two.sessions[0].session.id);
    assert_eq!(a.stats().unwrap().sessions, 2);
}
#[test]
fn explicit_live_remove_clears_previous_working_row() {
    let a = archive();
    let mut b = batch(1, 1, "p1");
    let id = b.sessions[0].session.id.clone();
    b.live_updates.push(LiveMutation {
        session_id: id.clone(),
        action: LiveAction::Update {
            value: live(&id, LiveState::Working),
        },
    });
    a.import_batch(&b).unwrap();
    assert_eq!(a.live_list().unwrap().len(), 1);
    revision(&mut b, 2);
    b.live_updates = vec![LiveMutation {
        session_id: id,
        action: LiveAction::Remove {
            evidence: evidence("native_completion"),
        },
    }];
    a.import_batch(&b).unwrap();
    assert!(a.live_list().unwrap().is_empty());
}
