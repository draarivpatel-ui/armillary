mod common_readers;
use common_readers::read_json;
use common_readers::read_jsonl;
use common_readers::read_markdown;
use common_readers::read_sqlite;
use orrery_adapters::readers::jsonl::ReaderError;
use rusqlite::Connection;
use std::fs::File;
use std::io::Write;
use tempfile::tempdir;

#[test]
fn test_jsonl_reader_normal_and_truncated() {
    let dir = tempdir().unwrap();
    let file_path = dir.path().join("session.jsonl");

    {
        let mut f = File::create(&file_path).unwrap();
        writeln!(f, r#"{{"type":"user","content":"hello"}}"#).unwrap();
        writeln!(f, r#"   "#).unwrap(); // empty whitespace line
        writeln!(f, r#"{{"type":"assistant","content":"world"}}"#).unwrap();
        write!(f, r#"{{"type":"truncated_json_line"#).unwrap(); // mid-line EOF / malformed
    }

    assert!(matches!(read_jsonl(&file_path), Err(ReaderError::Parse(_))));
}

#[test]
fn test_json_reader_normal_and_malformed() {
    let dir = tempdir().unwrap();
    let valid_path = dir.path().join("data.json");
    let broken_path = dir.path().join("broken.json");

    {
        let mut f = File::create(&valid_path).unwrap();
        write!(f, r#"{{"id":"test-1","status":"done"}}"#).unwrap();
    }
    {
        let mut f = File::create(&broken_path).unwrap();
        write!(f, r#"{{"id":"test-1", incomplete"#).unwrap();
    }

    let val = read_json(&valid_path).unwrap();
    assert_eq!(val["id"], "test-1");

    let err = read_json(&broken_path);
    assert!(err.is_err());
    match err {
        Err(ReaderError::Parse(_)) => {}
        _ => panic!("Expected Parse error on broken JSON"),
    }
}

#[test]
fn test_sqlite_reader_readonly_and_query() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("history.sqlite");

    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, tokens INTEGER)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO threads (id, title, tokens) VALUES ('t1', 'First Thread', 150)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO threads (id, title, tokens) VALUES ('t2', 'Second Thread', 300)",
            [],
        )
        .unwrap();
    }

    let query = "SELECT id, title, tokens FROM threads ORDER BY id ASC";
    let rows = read_sqlite(&db_path, query).unwrap();

    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["id"], "t1");
    assert_eq!(rows[0]["title"], "First Thread");
    assert_eq!(rows[0]["tokens"], 150);
    assert_eq!(rows[1]["id"], "t2");
}

#[test]
fn test_markdown_reader_sections() {
    let dir = tempdir().unwrap();
    let md_path = dir.path().join("transcript.md");

    {
        let mut f = File::create(&md_path).unwrap();
        writeln!(f, "# Session 101").unwrap();
        writeln!(f, "## User").unwrap();
        writeln!(f, "Please write a test.").unwrap();
        writeln!(f, "## Assistant").unwrap();
        writeln!(f, "Here is your test.").unwrap();
    }

    let val = read_markdown(&md_path).unwrap();
    assert_eq!(val["title"], "Session 101");
    let msgs = val["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0]["role"], "user");
    assert_eq!(msgs[0]["text"], "Please write a test.");
    assert_eq!(msgs[1]["role"], "assistant");
    assert_eq!(msgs[1]["text"], "Here is your test.");
}

#[test]
fn test_sqlite_readonly_prevents_write() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("readonly.sqlite");

    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute("CREATE TABLE items (id TEXT PRIMARY KEY)", [])
            .unwrap();
    }

    // Attempting a write statement like INSERT or DROP via read_sqlite should fail
    let write_query = "INSERT INTO items (id) VALUES ('evil')";
    let result = read_sqlite(&db_path, write_query);
    assert!(
        result.is_err(),
        "Write query must fail on read-only sqlite reader"
    );
}
