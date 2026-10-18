//! Amp keeps one JSON file per thread. A store with two or more threads must import. Since RV-ADP each
//! thread file is its own batch with its own provenance, so no batch mixes provenances.
mod common;
use common::*;
use orrery_archive::*;
use std::path::Path;

fn thread(dir: &Path, id: &str, created: i64, prompt: &str) {
    let body = format!(
        r#"{{"id":"{id}","created":{created},"title":"{prompt}","messages":[
  {{"role":"user","messageId":0,"content":[{{"type":"text","text":"{prompt}"}}]}},
  {{"role":"assistant","messageId":1,"model":"claude-opus-5-5","content":[{{"type":"text","text":"Done: {prompt}"}}],
    "usage":{{"inputTokens":900,"outputTokens":120}}}}],
  "usageLedger":{{"events":[{{"model":"claude-opus-5-5","timestamp":"2026-10-12T10:15:44.000Z","toMessageId":1,
    "tokens":{{"input":900,"output":120}}}}]}}}}"#
    );
    std::fs::write(dir.join(format!("{id}.json")), body).unwrap();
}

fn import_all(root: &Path) -> (Archive, usize) {
    let a = Archive::in_memory().unwrap();
    a.register_agent(&agent("amp")).unwrap();
    let def = orrery_adapters::get_builtin_adapter("amp").unwrap();
    let batches = orrery_adapters::AdapterEngine::fixture_batches(&def, root).unwrap();
    for b in &batches {
        a.import_batch(b).unwrap_or_else(|e| panic!("amp batch refused: {e}"));
    }
    (a, batches.len())
}

#[test]
fn two_amp_threads_import_together() {
    let d = tempfile::tempdir().unwrap();
    let threads = d.path().join("threads");
    std::fs::create_dir_all(&threads).unwrap();
    thread(&threads, "T-aaaaaaaa-0000-4000-8000-000000000001", 1_791_790_000_000, "first thread about the shader");
    thread(&threads, "T-bbbbbbbb-0000-4000-8000-000000000002", 1_791_795_000_000, "second thread about migrations");
    let (a, _) = import_all(d.path());
    assert_eq!(a.stats().unwrap().sessions, 2, "both threads must be in the archive");
    assert_eq!(a.search("shader", &SearchFilter::default()).unwrap().len() > 0, true);
    assert_eq!(a.search("migrations", &SearchFilter::default()).unwrap().len() > 0, true);
}

#[test]
fn a_changed_second_thread_is_noticed() {
    let d = tempfile::tempdir().unwrap();
    let threads = d.path().join("threads");
    std::fs::create_dir_all(&threads).unwrap();
    thread(&threads, "T-aaaaaaaa-0000-4000-8000-000000000001", 1_791_790_000_000, "first thread");
    thread(&threads, "T-bbbbbbbb-0000-4000-8000-000000000002", 1_791_795_000_000, "second thread");
    let def = orrery_adapters::get_builtin_adapter("amp").unwrap();
    let before = orrery_adapters::AdapterEngine::fixture_batches(&def, d.path()).unwrap();
    thread(&threads, "T-bbbbbbbb-0000-4000-8000-000000000002", 1_791_795_000_000, "second thread, edited later");
    let after = orrery_adapters::AdapterEngine::fixture_batches(&def, d.path()).unwrap();
    assert_eq!(before.len(), 2);
    assert_ne!(
        before[1].source.checkpoint.digest, after[1].source.checkpoint.digest,
        "editing a thread must change that thread's checkpoint so a re-import picks it up"
    );
    assert_eq!(
        before[0].source, after[0].source,
        "an untouched thread keeps its checkpoint, so it replays instead of conflicting"
    );
}

#[test]
fn one_amp_thread_still_imports() {
    let d = tempfile::tempdir().unwrap();
    let threads = d.path().join("threads");
    std::fs::create_dir_all(&threads).unwrap();
    thread(&threads, "T-aaaaaaaa-0000-4000-8000-000000000001", 1_791_790_000_000, "only thread");
    let (a, _) = import_all(d.path());
    assert_eq!(a.stats().unwrap().sessions, 1);
}
