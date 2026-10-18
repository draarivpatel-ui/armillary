//! R2-REV-3: Delete archive and reset closes the archive, removes its files and leaves an empty,
//! working archive in their place, without the caller dropping its handle.
mod common;
use common::*;
use orrery_archive::*;

#[test]
fn reset_to_empty_deletes_the_files_and_keeps_the_handle_usable() {
    let d = tempfile::Builder::new().prefix("armillary-r2fix-").tempdir_in("/tmp").unwrap();
    let p = d.path().join("armillary-archive.sqlite3");
    let a = Archive::open(&p).unwrap();
    a.register_agent(&agent("test")).unwrap();
    a.import_batch(&batch(4, 1, "p")).unwrap();
    assert_eq!(a.stats().unwrap().messages, 4);
    let old_inode = {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(&p).unwrap().ino()
    };

    a.reset_to_empty(&p).unwrap();

    // The old file is gone: a new, empty database sits at the same path.
    use std::os::unix::fs::MetadataExt;
    assert_ne!(std::fs::metadata(&p).unwrap().ino(), old_inode, "the file was replaced, not emptied in place");
    let stats = a.stats().unwrap();
    assert_eq!((stats.sessions, stats.messages, stats.search_rows), (0, 0, 0));
    assert!(a.search("canary", &SearchFilter::default()).unwrap().is_empty());
    // Still a working archive.
    a.register_agent(&agent("test")).unwrap();
    a.import_batch(&batch(2, 1, "p")).unwrap();
    assert_eq!(a.stats().unwrap().messages, 2);
    // Nothing of the old content survives in the files on disk.
    for suffix in ["", "-wal", "-shm"] {
        let f = d.path().join(format!("armillary-archive.sqlite3{suffix}"));
        if let Ok(bytes) = std::fs::read(&f) {
            assert!(!bytes.windows(7).any(|w| w == b"canary3"), "{suffix} holds old text");
        }
    }
}
