//! R-3 / RR1-1 (r2 fix round 2): diagnostics that describe a source's latest read replace the
//! earlier ones for that source, stale skip notices can be dropped, and a listing keeps every row
//! of one code (the Field Guide's "limit" skips) behind any number of newer rows.
mod common;
use common::*;
use orrery_archive::*;

fn failed(path: &str, code: &str) -> ImportBatch {
    let mut b = batch(1, 1, path);
    b.sessions.clear();
    b.read_status = ReadStatus::Failed;
    b.diagnostics = vec![ImportDiagnostic {
        source_key: b.source.key(),
        code: code.into(),
        message: format!("{code} {path}"),
        retryable: false,
    }];
    b
}

#[test]
fn clearing_a_source_drops_only_its_own_rows() {
    let a = archive();
    let p = failed("p", "limit");
    let q = failed("q", "limit");
    a.import_batch(&p).unwrap();
    a.import_batch(&q).unwrap();
    assert_eq!(a.diagnostics(&p.source.key()).unwrap().len(), 2, "limit plus incomplete");
    a.clear_diagnostics(&p.source.key()).unwrap();
    assert!(a.diagnostics(&p.source.key()).unwrap().is_empty());
    assert_eq!(a.diagnostics(&q.source.key()).unwrap().len(), 2);
}

#[test]
fn retaining_a_code_drops_rows_of_unseen_sources_only() {
    let a = archive();
    let p = failed("p", "limit");
    let q = failed("q", "limit");
    let r = failed("r", "parse");
    for b in [&p, &q, &r] {
        a.import_batch(b).unwrap();
    }
    let keep = std::collections::HashSet::from([p.source.key()]);
    assert_eq!(a.retain_diagnostics_with_code("limit", &keep).unwrap(), 1);
    let limits: Vec<_> = a.recent_diagnostics(500).unwrap().into_iter().filter(|d| d.code == "limit").collect();
    assert_eq!(limits.len(), 1);
    assert_eq!(limits[0].source_key, p.source.key());
    assert_eq!(a.diagnostics(&r.source.key()).unwrap().len(), 2, "other codes are untouched");
}

#[test]
fn a_listing_keeps_every_row_of_a_code_behind_newer_rows() {
    let a = archive();
    a.import_batch(&failed("big", "limit")).unwrap();
    for i in 0..120 {
        a.import_batch(&failed(&format!("f{i}"), "parse")).unwrap();
    }
    assert!(a.recent_diagnostics(100).unwrap().iter().all(|d| d.code != "limit"), "control: pushed out");
    let listed = a.recent_diagnostics_keeping(100, "limit").unwrap();
    assert_eq!(listed.iter().filter(|d| d.code == "limit").count(), 1);
    assert_eq!(listed.len(), 101);
    assert_eq!(listed[0].code, "incomplete", "still newest first");
    assert_eq!(listed.last().unwrap().code, "limit");
}
