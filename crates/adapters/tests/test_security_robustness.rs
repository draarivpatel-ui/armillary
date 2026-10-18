use orrery_adapters::credentials::is_credential_file;
mod common_readers;
use common_readers::read_json;
use common_readers::read_jsonl;
use common_readers::read_markdown;
use common_readers::read_sqlite;
use orrery_adapters::readers::jsonl::ReaderError;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::tempdir;
use walkdir::WalkDir;

#[test]
fn test_credential_file_filter_rules() {
    assert!(is_credential_file(Path::new("/home/user/auth.json")));
    assert!(is_credential_file(Path::new(
        "C:\\Users\\user\\.credentials.json"
    )));
    assert!(is_credential_file(Path::new("secret.key")));
    assert!(is_credential_file(Path::new("/etc/my.key")));
    assert!(is_credential_file(Path::new(".env")));
    assert!(is_credential_file(Path::new(".env.local")));
    assert!(is_credential_file(Path::new("login.keychain")));
    assert!(is_credential_file(Path::new("id_rsa")));
    assert!(is_credential_file(Path::new("id_ed25519")));

    assert!(!is_credential_file(Path::new("session.jsonl")));
    assert!(!is_credential_file(Path::new("rollout-2026-10-12.jsonl")));
    assert!(!is_credential_file(Path::new("state_5.sqlite")));
    assert!(!is_credential_file(Path::new("README.md")));
}

#[test]
fn test_readers_refuse_credential_files() {
    let dir = tempdir().unwrap();
    let auth_path = dir.path().join("auth.json");
    let cred_path = dir.path().join(".credentials.json");
    let key_path = dir.path().join("private.key");

    {
        File::create(&auth_path)
            .unwrap()
            .write_all(b"{\"token\":\"secret\"}")
            .unwrap();
        File::create(&cred_path)
            .unwrap()
            .write_all(b"{\"api_key\":\"secret\"}")
            .unwrap();
        File::create(&key_path)
            .unwrap()
            .write_all(b"PRIVATE KEY DATA")
            .unwrap();
    }

    assert!(matches!(
        read_jsonl(&auth_path),
        Err(ReaderError::CredentialBlocked(_))
    ));
    assert!(matches!(
        read_json(&cred_path),
        Err(ReaderError::CredentialBlocked(_))
    ));
    assert!(matches!(
        read_sqlite(&key_path, "SELECT 1"),
        Err(ReaderError::CredentialBlocked(_))
    ));
    assert!(matches!(
        read_markdown(&key_path),
        Err(ReaderError::CredentialBlocked(_))
    ));
}

#[test]
fn test_malformed_and_garbage_never_panics() {
    let dir = tempdir().unwrap();
    let garbage_path = dir.path().join("garbage.dat");
    {
        let mut f = File::create(&garbage_path).unwrap();
        // Write random binary garbage
        f.write_all(&[0x00, 0xFF, 0xFE, 0x80, 0x12, 0x34, 0x56, 0x78])
            .unwrap();
    }

    // None of these should panic
    let _ = read_jsonl(&garbage_path);
    let _ = read_json(&garbage_path);
    let _ = read_sqlite(&garbage_path, "SELECT * FROM threads");
    let _ = read_markdown(&garbage_path);
}

#[test]
fn test_engine_with_truncated_and_corrupt_files_never_panics() {
    use orrery_adapters::adapter_spec::AdapterDef;
    use orrery_adapters::engine::AdapterEngine;

    let dir = tempdir().unwrap();
    // Create random corrupted files with supported extensions
    let corrupt_jsonl = dir.path().join("corrupt.jsonl");
    let corrupt_json = dir.path().join("corrupt.json");
    let corrupt_sqlite = dir.path().join("corrupt.sqlite");
    let corrupt_md = dir.path().join("corrupt.md");

    {
        File::create(&corrupt_jsonl)
            .unwrap()
            .write_all(b"{\"type\": broken\n{incomplete\n")
            .unwrap();
        File::create(&corrupt_json)
            .unwrap()
            .write_all(b"{\"invalid\": [")
            .unwrap();
        File::create(&corrupt_sqlite)
            .unwrap()
            .write_all(b"NOT A SQLITE DATABASE")
            .unwrap();
        File::create(&corrupt_md)
            .unwrap()
            .write_all(b"\xFF\xFE\x00\x00")
            .unwrap();
    }

    let adapter_str = r#"
id = "test-agent"
name = "Test Agent"
vendor = "Test Vendor"
family = "Test"
kind = "cli"

[[history_sources]]
format = "jsonl"
fixture_paths = ["corrupt.jsonl"]

[[history_sources]]
format = "json"
fixture_paths = ["corrupt.json"]

[[history_sources]]
format = "sqlite"
fixture_paths = ["corrupt.sqlite"]
query = "SELECT * FROM threads"

[[history_sources]]
format = "markdown"
fixture_paths = ["corrupt.md"]
"#;
    let adapter = AdapterDef::from_toml(adapter_str).unwrap();

    // Corrupt reads must produce explicit errors, never successful prefixes.
    let result = AdapterEngine::process_fixture_dir(&adapter, dir.path());
    assert!(result.is_err());
    let batches = AdapterEngine::fixture_batches(&adapter, dir.path()).unwrap();
    assert_eq!(batches.len(), 4);
    assert!(batches
        .iter()
        .all(|b| b.read_status == orrery_adapters::ReadStatus::Failed
            && !b.diagnostics.is_empty()
            && b.sessions.is_empty()));
}

#[test]
fn test_no_em_or_en_dashes_in_source_and_configs() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut violations = Vec::new();

    for entry in WalkDir::new(&root).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() {
            let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
            if ext == "rs" || ext == "toml" || ext == "json" {
                if let Ok(content) = std::fs::read_to_string(path) {
                    for (line_idx, line) in content.lines().enumerate() {
                        if line.contains('\u{2014}') {
                            violations.push(format!(
                                "Em dash found in {}:{} -> {}",
                                path.display(),
                                line_idx + 1,
                                line
                            ));
                        }
                        if line.contains('\u{2013}') {
                            violations.push(format!(
                                "En dash found in {}:{} -> {}",
                                path.display(),
                                line_idx + 1,
                                line
                            ));
                        }
                    }
                }
            }
        }
    }

    assert!(
        violations.is_empty(),
        "Em or En dashes found in files:\n{}",
        violations.join("\n")
    );
}
