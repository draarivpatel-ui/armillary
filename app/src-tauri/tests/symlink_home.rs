//! A HOME reached through a symlink must import exactly what the canonical HOME imports.
//!
//! On macOS `/tmp` is a symlink to `/private/tmp`, so a temporary HOME of `/tmp/x` is not its own
//! canonical path. Found in the real app: the adapters whose history is a glob under HOME imported
//! 0 sessions through such a HOME (24 of 60 dataset sessions gathered) while the same scan with a
//! canonicalised HOME gathered all 60. These tests generate the presentation dataset into a real
//! folder, reach it through a symlink, and compare an import through the symlinked HOME with an
//! import through the canonical HOME: same sessions, same ids, every adapter.

#[path = "../src/importer.rs"]
mod importer;
#[path = "../src/archive_api.rs"]
mod archive_api;
#[path = "../src/live.rs"]
mod live;
#[path = "../src/config_scan.rs"]
#[allow(dead_code)]
mod config_scan;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};

use tempfile::TempDir;

use orrery_adapters::env::{Environment, FileSystem, MockEnvironment, SystemFileSystem, TargetOs};
use orrery_archive::{Archive, SessionFilter};

use importer::{discover_targets, Importer};

const NOW: &str = "2026-10-12T18:00:00Z";

/// Session ids per agent id.
type IdsByAgent = BTreeMap<String, BTreeSet<String>>;

fn generator() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../demo/dataset/generate.py")
}

/// Run the generator exactly as documented: `python3 -I generate.py <home> --now <iso>`.
fn run_generator(home: &Path) {
    let script = generator();
    assert!(script.exists(), "generate.py must exist at {}", script.display());
    let out = Command::new("python3")
        .arg("-I")
        .arg(&script)
        .arg(home)
        .args(["--now", NOW])
        .output()
        .expect("failed to execute python3");
    assert!(
        out.status.success(),
        "generate.py failed: {}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

/// The dataset generated once into `<tmp>/real/home`, with `<tmp>/link` -> `<tmp>/real`.
struct Layout {
    _tmp: TempDir,
    /// `<tmp>/real/home`, canonical.
    canonical_home: PathBuf,
    /// `<tmp>/link/home`, reached through the symlink.
    linked_home: PathBuf,
}

fn layout() -> &'static Layout {
    static L: OnceLock<Layout> = OnceLock::new();
    L.get_or_init(|| {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let real = base.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let canonical_home = real.join("home");
        run_generator(&canonical_home);
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let linked_home = link.join("home");
        assert!(linked_home.is_dir(), "the symlinked home must resolve to the dataset");
        assert_ne!(linked_home, linked_home.canonicalize().unwrap(), "the test HOME must not be canonical");
        assert_eq!(linked_home.canonicalize().unwrap(), canonical_home);
        Layout { _tmp: tmp, canonical_home, linked_home }
    })
}

/// Discover and import one HOME the way the first-run flow does: `discover_targets`, then
/// `run_observed` per adapter, all with the same environment.
fn import_with(env: &dyn Environment, fs: &dyn FileSystem) -> IdsByAgent {
    let targets = discover_targets(env, fs);
    assert!(!targets.is_empty(), "discovery found no adapter at all");
    let archive = Arc::new(Archive::in_memory().unwrap());
    let importer = Importer::new(archive.clone());
    for t in &targets {
        if let Err(e) = importer.run_observed(&[t.clone()], None, env, &|_| {}, &|_| {}) {
            panic!("importer failed for adapter '{}': {}", t.adapter.id, e);
        }
    }
    let mut out = IdsByAgent::new();
    let mut offset = 0u32;
    loop {
        let page = archive
            .sessions_query(&SessionFilter { limit: Some(200), offset: Some(offset), ..Default::default() })
            .unwrap();
        let got = page.items.len() as u32;
        for s in page.items {
            out.entry(s.agent_id.clone()).or_default().insert(s.id.clone());
        }
        offset += got;
        if got == 0 || u64::from(offset) >= page.total {
            break;
        }
    }
    out
}

fn total(ids: &IdsByAgent) -> usize {
    ids.values().map(BTreeSet::len).sum()
}

fn counts(ids: &IdsByAgent) -> String {
    ids.iter().map(|(a, s)| format!("{a}={}", s.len())).collect::<Vec<_>>().join(", ")
}

fn assert_same_import(canonical: &IdsByAgent, linked: &IdsByAgent) {
    assert!(total(canonical) > 0, "the canonical import must gather sessions");
    // Every adapter that imports with the canonical HOME also imports with the symlinked one.
    let missing: Vec<String> = canonical
        .iter()
        .filter(|(agent, ids)| !ids.is_empty() && linked.get(*agent).map_or(0, BTreeSet::len) == 0)
        .map(|(agent, _)| agent.clone())
        .collect();
    assert!(
        missing.is_empty(),
        "adapters that import 0 sessions through a symlinked HOME: {missing:?}\n  canonical ({} sessions): {}\n  symlinked ({} sessions): {}",
        total(canonical),
        counts(canonical),
        total(linked),
        counts(linked)
    );
    // Same sessions per adapter, and identical session ids (store identity uses canonical roots).
    assert_eq!(
        counts(linked),
        counts(canonical),
        "per adapter session counts differ between the symlinked and the canonical HOME"
    );
    assert_eq!(total(linked), total(canonical), "the archive must hold the same number of sessions");
    assert_eq!(linked, canonical, "session ids must be identical between the two runs");
}

fn canonical_import() -> &'static IdsByAgent {
    static C: OnceLock<IdsByAgent> = OnceLock::new();
    C.get_or_init(|| {
        let l = layout();
        let env = MockEnvironment::new(TargetOs::Macos, l.canonical_home.to_str().unwrap());
        import_with(&env, &SystemFileSystem)
    })
}

/// The first-run flow hands the raw environment (HOME as the OS reports it) to discovery and import.
#[test]
fn symlinked_home_imports_like_the_canonical_home() {
    let l = layout();
    let env = MockEnvironment::new(TargetOs::Macos, l.linked_home.to_str().unwrap());
    let linked = import_with(&env, &SystemFileSystem);
    assert_same_import(canonical_import(), &linked);
}

/// The app builds its discovery pair with `scope::detection_pair` (ARMILLARY_DETECT_SCOPE=home);
/// the same pair is then used for the import environment.
#[test]
fn symlinked_home_imports_like_the_canonical_home_through_the_home_scope() {
    let l = layout();
    let env = MockEnvironment::new(TargetOs::Macos, l.linked_home.to_str().unwrap());
    let (scoped_env, scoped_fs) = archive_api::scope::detection_pair(Some("home"), env, SystemFileSystem);
    let linked = import_with(scoped_env.as_ref(), scoped_fs.as_ref());
    assert_same_import(canonical_import(), &linked);
}
