//! RV-ADP: the directory-style adapters (Amp, Aider) through the real archive.
mod common;
use common::*;
use orrery_adapters::engine::AdapterEngine;
use orrery_adapters::get_builtin_adapter;
use orrery_archive::*;
use std::fs;
use std::path::Path;

fn import_all(a: &Archive, id: &str, root: &Path) -> Vec<ImportOutcome> {
    let def = get_builtin_adapter(id).unwrap();
    AdapterEngine::fixture_batches(&def, root)
        .unwrap()
        .iter()
        .map(|b| a.import_batch(b).unwrap())
        .collect()
}

fn thread(id: &str, text: &str) -> String {
    format!(
        r#"{{"id":"{id}","created":1791800000000,"messages":[{{"role":"user","content":"{text}"}},{{"role":"assistant","content":[{{"type":"text","text":"ok"}}]}}]}}"#
    )
}

#[test]
fn amp_reimport_after_a_thread_file_is_deleted_keeps_history_and_is_not_refused() {
    let d = tempfile::tempdir().unwrap();
    fs::create_dir_all(d.path().join("threads")).unwrap();
    fs::write(d.path().join("threads/T-a.json"), thread("T-a", "alphacanary")).unwrap();
    fs::write(d.path().join("threads/T-b.json"), thread("T-b", "betacanary")).unwrap();
    let a = Archive::in_memory().unwrap();
    a.register_agent(&agent("amp")).unwrap();
    assert!(import_all(&a, "amp", d.path()).iter().all(|o| o.applied));
    assert_eq!(a.stats().unwrap().sessions, 2);

    fs::remove_file(d.path().join("threads/T-a.json")).unwrap();
    // The importer reuses generation and revision for an unchanged source; an unchanged thread must
    // replay cleanly, and the deleted thread's history must stay in the archive.
    let again = import_all(&a, "amp", d.path());
    assert_eq!(again.len(), 1);
    assert_eq!(again[0].reason.as_deref(), Some("replay"));
    assert_eq!(a.stats().unwrap().sessions, 2, "a missing file never deletes archive history");
    assert_eq!(a.search("alphacanary", &SearchFilter::default()).unwrap().len(), 1);
}

#[test]
fn aider_histories_from_two_repos_import_without_overwriting_each_other() {
    let d = tempfile::tempdir().unwrap();
    let body = "\n# aider chat started at 2026-10-12 15:04:22\n\n#### repo question  \n\nreply text\n";
    for repo in ["alpha", "beta"] {
        fs::create_dir_all(d.path().join(repo)).unwrap();
        fs::write(d.path().join(repo).join(".aider.chat.history.md"), body).unwrap();
    }
    let a = Archive::in_memory().unwrap();
    a.register_agent(&agent("aider")).unwrap();
    assert!(import_all(&a, "aider", d.path()).iter().all(|o| o.applied));
    assert_eq!(a.stats().unwrap().sessions, 2, "same start second in two repos must not collapse into one session");
}

#[test]
fn aider_history_that_grows_imports_as_a_new_revision_of_the_same_source() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join(".aider.chat.history.md");
    fs::write(&p, "\n# aider chat started at 2026-10-12 15:04:22\n\n#### first  \n\nreply one\n").unwrap();
    let a = Archive::in_memory().unwrap();
    a.register_agent(&agent("aider")).unwrap();
    let def = get_builtin_adapter("aider").unwrap();
    let first = AdapterEngine::fixture_batches(&def, d.path()).unwrap();
    assert!(a.import_batch(&first[0]).unwrap().applied);
    fs::write(&p, "\n# aider chat started at 2026-10-12 15:04:22\n\n#### first  \n\nreply one\n\n#### second  \n\nreply two\n").unwrap();
    let mut second = AdapterEngine::fixture_batches(&def, d.path()).unwrap().remove(0);
    assert_eq!(second.source.key(), first[0].source.key());
    second.source.checkpoint.revision = 2;
    second.sessions[0].session.provenance = second.source.clone();
    assert!(a.import_batch(&second).unwrap().applied);
    assert_eq!(a.search("second", &SearchFilter::default()).unwrap().len(), 1);
}
