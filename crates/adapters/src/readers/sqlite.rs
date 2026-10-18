use crate::{
    boundary::{digest, ReadBoundary, MAX_SOURCE_RECORDS},
    readers::jsonl::ReaderError,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value};
use std::{fs, path::Path};

pub fn file_uri(path: &Path) -> String {
    #[cfg(unix)]
    let bytes = {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    };
    #[cfg(not(unix))]
    let bytes = path.to_string_lossy().replace('\\', "/").into_bytes();
    let mut result = "file:".to_string();
    for byte in bytes {
        if byte.is_ascii_alphanumeric() || b"/:-._~".contains(&byte) {
            result.push(byte as char);
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    result.push_str("?mode=ro");
    result
}
pub fn read_sqlite(
    boundary: &ReadBoundary,
    path: &Path,
    query: &str,
) -> Result<Vec<Value>, ReaderError> {
    read_sqlite_bounded(boundary, path, query).map(|r| r.0)
}
pub struct SqliteSnapshot {
    pub conn: Connection,
    pub file_identity: String,
    pub checksum: String,
    /// Byte length of the main database file as captured.
    pub main_len: u64,
    _temp: tempfile::TempDir,
}

impl SqliteSnapshot {
    /// The connection and the private folder that holds the copied files (keep the folder alive
    /// for as long as the connection is used; drop the connection first).
    pub fn into_parts(self) -> (Connection, tempfile::TempDir) {
        (self.conn, self._temp)
    }
}

pub fn open_sqlite_snapshot(
    boundary: &ReadBoundary,
    path: &Path,
) -> Result<SqliteSnapshot, ReaderError> {
    let name = path
        .file_name()
        .ok_or_else(|| ReaderError::Boundary("SQLite source must name a file".into()))?;
    let mut paths = vec![path.to_path_buf()];
    for suffix in ["-wal", "-shm"] {
        let mut companion = name.to_os_string();
        companion.push(suffix);
        paths.push(path.with_file_name(companion));
    }
    for _ in 0..3 {
        let mut captured = vec![];
        for (i, p) in paths.iter().enumerate() {
            match boundary.read(p) {
                Ok(b) => captured.push(Some(b)),
                Err(ReaderError::Io(e)) if i > 0 && e.kind() == std::io::ErrorKind::NotFound => {
                    captured.push(None)
                }
                Err(e) => return Err(e),
            }
        }
        let mut stable = true;
        for (p, before) in paths.iter().zip(&captured) {
            match (before, boundary.read(p)) {
                (Some(a), Ok(b)) if a.file_identity == b.file_identity && a.bytes == b.bytes => {}
                (None, Err(ReaderError::Io(e))) if e.kind() == std::io::ErrorKind::NotFound => {}
                (_, Err(ReaderError::Io(e))) if e.kind() != std::io::ErrorKind::NotFound => {
                    return Err(e.into())
                }
                (_, Err(e @ (ReaderError::Boundary(_) | ReaderError::CredentialBlocked(_)))) => {
                    return Err(e)
                }
                _ => stable = false,
            }
        }
        if !stable {
            continue;
        }
        let temp = tempfile::Builder::new()
            .prefix("armillary-sqlite-")
            .tempdir()?;
        let db = temp.path().join("snapshot.db");
        for (suffix, bytes) in ["", "-wal", "-shm"].iter().zip(&captured) {
            if let Some(b) = bytes {
                let p = temp.path().join(format!("snapshot.db{suffix}"));
                let mut options = fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                use std::io::Write;
                options.open(&p)?.write_all(&b.bytes)?;
            }
        }
        let conn = Connection::open_with_flags(
            file_uri(&db),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| ReaderError::Parse(format!("SQLite snapshot: {e}")))?;
        conn.pragma_update(None, "query_only", true)
            .map_err(|e| ReaderError::Parse(e.to_string()))?;

        let main = captured[0].as_ref().unwrap();
        let mut checksum_bytes = vec![];
        for b in &captured {
            match b {
                Some(b) => {
                    checksum_bytes.extend_from_slice(&(b.bytes.len() as u64).to_be_bytes());
                    checksum_bytes.extend_from_slice(&b.bytes);
                }
                None => checksum_bytes.extend_from_slice(&0_u64.to_be_bytes()),
            }
        }
        return Ok(SqliteSnapshot {
            conn,
            file_identity: main.file_identity.clone(),
            checksum: digest(&checksum_bytes),
            main_len: main.bytes.len() as u64,
            _temp: temp,
        });
    }
    Err(ReaderError::Changed(
        "SQLite source changed during snapshot; retry".into(),
    ))
}

/// Only the private snapshot is opened by SQLite. Source DB, WAL and SHM are
/// read through the same no-follow boundary and checked again after copying.
pub fn read_sqlite_bounded(
    boundary: &ReadBoundary,
    path: &Path,
    query: &str,
) -> Result<(Vec<Value>, String, u64, String), ReaderError> {
    let first = query
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if first != "select" && first != "with" {
        return Err(ReaderError::Parse(
            "SQLite query must be SELECT or WITH".into(),
        ));
    }
    let snapshot = open_sqlite_snapshot(boundary, path)?;
    let mut stmt = snapshot
        .conn
        .prepare(query)
        .map_err(|e| ReaderError::Parse(e.to_string()))?;
    if !stmt.readonly() {
        return Err(ReaderError::Parse("write query rejected".into()));
    }
    let names: Vec<_> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt
        .query([])
        .map_err(|e| ReaderError::Parse(e.to_string()))?;
    let mut out = vec![];
    while let Some(row) = rows.next().map_err(|e| ReaderError::Parse(e.to_string()))? {
        if out.len() >= MAX_SOURCE_RECORDS {
            return Err(ReaderError::Limit("too many SQLite rows".into()));
        }
        let mut obj = Map::new();
        for (i, name) in names.iter().enumerate() {
            let value = match row
                .get_ref(i)
                .map_err(|e| ReaderError::Parse(e.to_string()))?
            {
                rusqlite::types::ValueRef::Null => Value::Null,
                rusqlite::types::ValueRef::Integer(v) => Value::from(v),
                rusqlite::types::ValueRef::Real(v) => serde_json::Number::from_f64(v)
                    .map(Value::Number)
                    .unwrap_or(Value::Null),
                rusqlite::types::ValueRef::Text(v) => Value::String(
                    std::str::from_utf8(v)
                        .map_err(|e| ReaderError::Parse(e.to_string()))?
                        .to_owned(),
                ),
                rusqlite::types::ValueRef::Blob(_) => {
                    return Err(ReaderError::Parse(
                        "BLOB requires a dedicated decoder or SQL projection".into(),
                    ))
                }
            };
            obj.insert(name.clone(), value);
        }
        out.push(Value::Object(obj));
    }
    let len = out.len() as u64;
    Ok((out, snapshot.file_identity, len, snapshot.checksum))
}
