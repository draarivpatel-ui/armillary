//! Synthetic acceptance coverage beyond the original review regressions.
use orrery_adapters::boundary::ReadBoundary;
use orrery_adapters::engine::SourceContext;
use orrery_adapters::*;
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};
fn def(format: &str, mapping: &str, extra: &str) -> AdapterDef {
    AdapterDef::from_toml(&format!(
        r#"id="test"
name="Test"
vendor="Synthetic"
family="other"
kind="cli"
[[history_sources]]
id="history"
format="{format}"
fixture_paths=["history.*"]
{extra}
[history_sources.paths]
default=["history.*"]
{mapping}
"#
    ))
    .unwrap()
}
#[test]
fn mapped_sqlite_groups_rows_by_native_id_and_orders_tool_results() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("history.db");
    let c = rusqlite::Connection::open(&p).unwrap();
    c.execute_batch("CREATE TABLE events(sid TEXT, mid TEXT, role TEXT, body TEXT, at INTEGER); INSERT INTO events VALUES('s1','m1','user','hello',1700000000000),('s1','m2','assistant','reply',1700000001000),('s2','m3','user','second',1700000002000);").unwrap();
    let a = def(
        "sqlite",
        r#"[history_sources.mapping.session]
id="/sid"
[history_sources.mapping.records.messages]
native_id_pointer="/mid"
role_pointer="/role"
text_pointer="/body"
timestamp_pointer="/at"
timestamp_format="unix_milliseconds"
"#,
        "query=\"SELECT * FROM events ORDER BY at\"\nsource_unit=\"shared_database\"",
    );
    let sessions = AdapterEngine::process_fixture_dir(&a, d.path()).unwrap();
    assert_eq!(sessions.len(), 2);
    let s = sessions
        .iter()
        .find(|n| n.session.native_id.as_deref() == Some("s1"))
        .unwrap();
    assert_eq!(s.messages.len(), 2);
    assert_eq!(s.messages[1].native_id.as_deref(), Some("m2"));
    assert_eq!(s.messages[1].at, Some(1_700_000_001_000));
}
#[test]
fn markdown_mapping_controls_title_text_transform_and_unknown_times() {
    let d = tempfile::tempdir().unwrap();
    fs::write(
        d.path().join("history.md"),
        "# Native title\n## User\nHello\n## Assistant\n```rust\n## not a speaker\n```\nReply\n",
    )
    .unwrap();
    let a = def(
        "markdown",
        r#"[history_sources.mapping.session]
title="/title"
[history_sources.mapping.records]
array_pointer="/messages"
[history_sources.mapping.records.messages]
role_pointer="/role"
text_pointer="/text"
text_transform="json"
"#,
        "",
    );
    let s = AdapterEngine::process_fixture_dir(&a, d.path()).unwrap();
    assert_eq!(s[0].session.title.as_deref(), Some("Native title"));
    assert_eq!(s[0].messages.len(), 2);
    assert!(matches!(&s[0].messages[0].blocks[0],ContentBlock::Text{text} if text=="\"Hello\""));
    assert_eq!(s[0].messages[1].at, None);
}
#[test]
fn jsonl_filters_and_explicit_timestamp_formats_are_applied() {
    let d = tempfile::tempdir().unwrap();
    fs::write(
        d.path().join("history.jsonl"),
        concat!(
            "{\"kind\":\"meta\",\"id\":\"s\"}\n",
            "{\"kind\":\"ignored\",\"role\":\"user\",\"text\":\"wrong\",\"at\":1700000000}\n",
            "{\"kind\":\"message\",\"role\":\"user\",\"text\":\"correct\",\"at\":1700000000}\n"
        ),
    )
    .unwrap();
    let a = def(
        "jsonl",
        r#"[history_sources.mapping.session]
id="/id"
meta_filter_pointer="/kind"
meta_filter_value="meta"
[history_sources.mapping.records]
type_pointer="/kind"
[history_sources.mapping.records.messages]
match_type="message"
role_pointer="/role"
text_pointer="/text"
timestamp_pointer="/at"
timestamp_format="unix_seconds"
"#,
        "",
    );
    let s = AdapterEngine::process_fixture_dir(&a, d.path()).unwrap();
    assert_eq!(s[0].messages.len(), 1);
    assert_eq!(s[0].messages[0].at, Some(1_700_000_000_000));
    assert_eq!(s[0].messages[0].seq, 3);
}
#[test]
fn production_sources_use_only_their_own_declared_paths() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().canonicalize().unwrap();
    fs::write(root.join("history.json"), "{\"id\":\"selected\"}").unwrap();
    fs::write(root.join("other.json"), "{\"id\":\"forbidden-source\"}").unwrap();
    let a = def("json", "", "");
    let context = SourceContext {
        store: StoreIdentity::new("test", root.to_str().unwrap(), "profile"),
        approved_roots: vec![root.clone()],
        installation_id: None,
        generation: 1,
        revision: 1,
    };
    let env = MockEnvironment::new(TargetOs::Macos, root.to_str().unwrap());
    let batches = AdapterEngine::source_batches(&a, &a.history_sources[0], &context, &env).unwrap();
    assert_eq!(batches.len(), 1);
    assert_eq!(
        batches[0].sessions[0].session.native_id.as_deref(),
        Some("selected")
    );
    assert!(AdapterEngine::read_manifest(
        &a,
        &a.history_sources[0],
        &context,
        &env,
        &[root.join("other.json")]
    )
    .is_err());
}
#[test]
#[cfg(unix)]
fn all_reader_formats_reject_credential_symlinks_and_outside_roots() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().join("history");
    fs::create_dir(&root).unwrap();
    fs::write(d.path().join("auth.json"), "synthetic canary").unwrap();
    fs::write(d.path().join("outside.json"), "{}").unwrap();
    let b = ReadBoundary::new(std::slice::from_ref(&root)).unwrap();
    for name in [
        "session.json",
        "session.jsonl",
        "history.db",
        "transcript.md",
    ] {
        let p = root.join(name);
        std::os::unix::fs::symlink("../auth.json", &p).unwrap();
        assert!(b.read(&p).is_err());
    }
    let outside = root.join("outside.json");
    std::os::unix::fs::symlink("../outside.json", &outside).unwrap();
    assert!(b.read(&outside).is_err());
}
#[test]
fn interrupted_reader_never_yields_a_successful_prefix() {
    struct Interrupted {
        first: bool,
    }
    impl std::io::Read for Interrupted {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.first {
                self.first = false;
                let bytes = b"{\"id\":\"s\"}\n";
                buf[..bytes.len()].copy_from_slice(bytes);
                Ok(bytes.len())
            } else {
                Err(std::io::Error::other("synthetic mid-stream I/O failure"))
            }
        }
    }
    assert!(orrery_adapters::readers::jsonl::parse_jsonl(Interrupted { first: true }).is_err());
}
#[test]
fn invalid_supported_mapping_values_are_rejected_at_load_time() {
    let prefix="id='t'\nname='T'\nvendor='T'\nfamily='other'\nkind='cli'\n[[history_sources]]\nformat='json'\n";
    for mapping in [
        "[history_sources.mapping.records.messages]\ntext_transform='join_magic'",
        "[history_sources.mapping.records.messages]\ntimestamp_format='made_up'",
        "[history_sources.mapping.records.usage]\nsemantics='sum_everything'",
        "[history_sources.mapping.session]\nid='not_a_json_pointer'",
    ] {
        assert!(AdapterDef::from_toml(&format!("{prefix}{mapping}")).is_err());
    }
}
#[test]
fn zero_usage_is_retained_and_completion_requires_matching_native_event() {
    let d = tempfile::tempdir().unwrap();
    fs::create_dir(d.path().join("sessions")).unwrap();
    fs::write(d.path().join("sessions/rollout-s.jsonl"),concat!("{\"type\":\"session_meta\",\"payload\":{\"id\":\"s\"}}\n","{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":0,\"output_tokens\":0}}}}\n","{\"type\":\"event_msg\",\"payload\":{\"type\":\"session_completed\",\"timestamp\":\"2026-10-12T14:00:00Z\"}}\n")).unwrap();
    let s =
        AdapterEngine::process_fixture_dir(&get_builtin_adapter("codex-cli").unwrap(), d.path())
            .unwrap();
    assert_eq!(s[0].session.usage.input_tokens, Some(0));
    assert_eq!(s[0].session.status, "done");
    assert!(s[0].session.completion.is_some());
    assert!(s[0].session.ended_at.is_some());
}
#[test]
fn sqlite_uri_encodes_reserved_characters_without_fallback() {
    let uri = orrery_adapters::readers::sqlite::file_uri(Path::new("/synthetic/a ?#%.db"));
    assert_eq!(uri, "file:/synthetic/a%20%3F%23%25.db?mode=ro");
}
#[cfg(unix)]
fn shim(script: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("version-shim");
    fs::write(&p, format!("#!/bin/sh\n{script}\n")).unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
    let p = p.canonicalize().unwrap();
    (dir, p)
}
#[test]
#[cfg(unix)]
fn real_hanging_version_shim_is_bounded_and_untrusted_path_is_never_run() {
    let (_dir, p) = shim("while :; do sleep 1; done");
    let start = Instant::now();
    assert!(matches!(
        orrery_adapters::probe::probe_trusted_version(
            &p,
            &[],
            &[],
            Duration::from_millis(100),
            1024
        ),
        Err(orrery_adapters::probe::ProbeError::Untrusted)
    ));
    assert!(matches!(
        orrery_adapters::probe::probe_trusted_version(
            &p,
            std::slice::from_ref(&p),
            &[],
            Duration::from_millis(100),
            1024
        ),
        Err(orrery_adapters::probe::ProbeError::Timeout)
    ));
    assert!(start.elapsed() < Duration::from_secs(2));
}
#[test]
#[cfg(unix)]
fn version_probe_output_is_capped_and_success_is_explicit() {
    let (_dir, p) = shim("while :; do printf 'spamspamspamspam'; done");
    assert!(matches!(
        orrery_adapters::probe::probe_trusted_version(
            &p,
            std::slice::from_ref(&p),
            &[],
            Duration::from_secs(1),
            128
        ),
        Err(orrery_adapters::probe::ProbeError::OutputLimit)
    ));
    let (_dir, p) = shim("printf 'Synthetic agent 1.2.3\\n'");
    assert_eq!(
        orrery_adapters::probe::probe_trusted_version(
            &p,
            std::slice::from_ref(&p),
            &[],
            Duration::from_secs(1),
            1024
        )
        .unwrap(),
        Some("1.2.3".into())
    );
}
#[test]
fn unsupported_mapping_combinations_fail_before_import() {
    let prefix="id='t'\nname='T'\nvendor='T'\nfamily='other'\nkind='cli'\n[[history_sources]]\nformat='sqlite'\nquery='SELECT 1 AS id'\n";
    assert!(AdapterDef::from_toml(&format!(
        "{prefix}[history_sources.mapping.records]\narray_pointer='/messages'"
    ))
    .is_err());
    let prefix = prefix.replace("format='sqlite'\nquery='SELECT 1 AS id'", "format='json'");
    assert!(AdapterDef::from_toml(&format!("{prefix}[history_sources.mapping.records.messages]\nmatch_type='message'\nrole_pointer='/role'")).is_err());
}
#[test]
fn source_size_limit_is_enforced_before_allocating_contents() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("history.json");
    std::fs::File::create(&p)
        .unwrap()
        .set_len(orrery_adapters::boundary::MAX_SOURCE_BYTES + 1)
        .unwrap();
    let b = ReadBoundary::new(&[d.path().to_path_buf()]).unwrap();
    assert!(matches!(
        b.read(&p),
        Err(orrery_adapters::readers::jsonl::ReaderError::Limit(_))
    ));
}
#[test]
fn sqlite_cannot_attach_an_unapproved_database() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("history.db");
    let c = rusqlite::Connection::open(&p).unwrap();
    c.execute_batch("CREATE TABLE test(id TEXT)").unwrap();
    let b = ReadBoundary::new(&[d.path().to_path_buf()]).unwrap();
    assert!(orrery_adapters::readers::sqlite::read_sqlite(
        &b,
        &p,
        "ATTACH DATABASE '/synthetic/forbidden' AS other"
    )
    .is_err());
}
