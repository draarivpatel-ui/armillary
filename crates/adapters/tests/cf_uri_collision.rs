//! A neighboring valid DB must not mask a malformed file: URI via fallback.
use orrery_adapters::{boundary::ReadBoundary, readers::sqlite::read_sqlite};
#[test]
fn sqlite_reserved_filename_cannot_select_a_neighbor_database() {
    let d = tempfile::tempdir().unwrap();
    for (filename, id) in [
        ("history", "wrong-neighbor"),
        ("history?#.db", "correct-source"),
    ] {
        let c = rusqlite::Connection::open(d.path().join(filename)).unwrap();
        c.execute_batch("CREATE TABLE events(id TEXT)").unwrap();
        c.execute("INSERT INTO events VALUES(?1)", [id]).unwrap();
    }
    let p = d.path().join("history?#.db");
    let boundary = ReadBoundary::new(&[d.path().to_path_buf()]).unwrap();
    assert_eq!(
        read_sqlite(&boundary, &p, "SELECT id FROM events").unwrap(),
        vec![serde_json::json!({"id":"correct-source"})]
    );
}
