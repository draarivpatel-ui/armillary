//! R-1 (r2 fix round 2): a stop (Not now, Delete archive) must end reading, not only writing. Every
//! file content read goes through `ReadBoundary::read`; while a stop check is installed for the
//! thread (`boundary::with_read_stop`), a read after the stop is refused with "import cancelled",
//! so an import finishes at most the one file it is reading.
use orrery_adapters::boundary::{with_read_stop, ReadBoundary};
use orrery_adapters::readers::jsonl::ReaderError;
use std::cell::Cell;
use std::rc::Rc;

fn tmp() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("armillary-r2r2-").tempdir_in("/tmp").unwrap()
}

fn is_cancelled(e: &ReaderError) -> bool {
    matches!(e, ReaderError::Io(io) if io.kind() == std::io::ErrorKind::Interrupted && io.to_string().contains("import cancelled"))
}

#[test]
fn reads_after_a_stop_are_refused_and_the_check_is_removed_afterwards() {
    let d = tmp();
    let root = d.path().canonicalize().unwrap();
    for name in ["a.jsonl", "b.jsonl", "c.jsonl"] {
        std::fs::write(root.join(name), "{}\n").unwrap();
    }
    let boundary = ReadBoundary::new(&[root.clone()]).unwrap();
    let calls = Rc::new(Cell::new(0u32));
    let counter = calls.clone();
    // Stopped once the first read has started: that read finishes, the next two never open.
    let stop: Rc<dyn Fn() -> bool> = Rc::new(move || {
        counter.set(counter.get() + 1);
        counter.get() > 1
    });
    let results: Vec<_> = with_read_stop(stop, || {
        ["a.jsonl", "b.jsonl", "c.jsonl"].iter().map(|n| boundary.read(&root.join(n))).collect()
    });
    assert!(results[0].is_ok(), "the file being read when the stop came finishes");
    for r in &results[1..] {
        match r {
            Err(e) => assert!(is_cancelled(e), "{e}"),
            Ok(_) => panic!("a file was read after the stop"),
        }
    }
    // Outside the scope the check is gone, so other readers (the Switchboard scan) are unaffected.
    assert!(boundary.read(&root.join("b.jsonl")).is_ok());
}

#[test]
fn nested_stop_checks_restore_the_outer_one() {
    let d = tmp();
    let root = d.path().canonicalize().unwrap();
    std::fs::write(root.join("a.jsonl"), "{}\n").unwrap();
    let boundary = ReadBoundary::new(&[root.clone()]).unwrap();
    let outer: Rc<dyn Fn() -> bool> = Rc::new(|| true);
    let inner: Rc<dyn Fn() -> bool> = Rc::new(|| false);
    with_read_stop(outer, || {
        assert!(with_read_stop(inner, || boundary.read(&root.join("a.jsonl"))).is_ok());
        assert!(boundary.read(&root.join("a.jsonl")).is_err(), "the outer stop applies again");
    });
}

#[test]
fn a_module_source_read_under_a_stop_yields_no_sessions() {
    use orrery_adapters::engine::SourceContext;
    use orrery_adapters::*;
    let d = tmp();
    let root = d.path().join("continue");
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/continue");
    copy_dir(&fixture, &root);
    let adapter = get_builtin_adapter("continue").unwrap();
    let source = adapter.history_sources.iter().find(|s| s.module.is_some()).unwrap().clone();
    let root = root.canonicalize().unwrap();
    let context = SourceContext {
        store: StoreIdentity::new("continue", root.to_str().unwrap(), "profile"),
        approved_roots: vec![root.clone()],
        installation_id: None,
        generation: 1,
        revision: 1,
    };
    let env = MockEnvironment::new(TargetOs::Macos, root.to_str().unwrap());
    let control = AdapterEngine::source_batches(&adapter, &source, &context, &env).unwrap();
    assert!(control.iter().any(|b| !b.sessions.is_empty()), "control: the fixture has sessions");
    let stop: Rc<dyn Fn() -> bool> = Rc::new(|| true);
    let stopped = with_read_stop(stop, || AdapterEngine::source_batches(&adapter, &source, &context, &env));
    let sessions: usize = stopped.map(|b| b.iter().map(|b| b.sessions.len()).sum()).unwrap_or(0);
    assert_eq!(sessions, 0, "sessions were read after the stop");
}

fn copy_dir(src: &std::path::Path, dst: &std::path::Path) {
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
