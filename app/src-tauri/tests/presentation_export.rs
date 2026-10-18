//! Presentation snapshot exporter: determinism, coverage, input immutability, refusal of the
//! real HOME, and the live sequence (against a stub generator, since the append hook needs one).
//! Everything runs on synthetic datasets in tempdirs; the real HOME is never read.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::tempdir;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

fn generator() -> PathBuf {
    repo_root().join("demo/dataset/generate.py")
}

/// True when the generator source mentions the flag. The source is read instead of running
/// `--help`: the older generator has no argument parser and would treat "--help" as a folder name.
fn generator_has(flag: &str) -> bool {
    fs::read_to_string(generator()).unwrap().contains(flag)
}

fn generate_home(home: &Path, scratch: &Path) {
    let mut cmd = Command::new("python3");
    cmd.arg("-I").arg(generator()).arg(home);
    if generator_has("--now") {
        cmd.arg("--now").arg("2026-10-12T18:00:00Z");
    }
    let out = cmd.current_dir(scratch).output().expect("python3 must run");
    assert!(
        out.status.success(),
        "generate.py failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// The exporter is a cargo EXAMPLE (examples/export-presentation.rs): `cargo build` and release builds
/// never build examples and the Tauri bundler never copies them, so the dev-only tool cannot ship.
/// `cargo test` builds examples before it runs the tests, next to this test binary's deps folder.
fn exporter_path() -> PathBuf {
    let deps = std::env::current_exe().expect("test binary path");
    let profile_dir = deps.parent().and_then(|d| d.parent()).expect("target/<profile>");
    let exe = profile_dir.join("examples").join(format!("export-presentation{}", std::env::consts::EXE_SUFFIX));
    assert!(exe.is_file(), "the export-presentation example was not built at {}", exe.display());
    exe
}

fn exporter() -> Command {
    Command::new(exporter_path())
}

#[test]
fn exporter_is_an_example_that_release_builds_never_bundle() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    assert!(
        !manifest.join("src/bin/export-presentation.rs").exists(),
        "a src/bin binary is built by release builds and copied into Armillary.app by the bundler"
    );
    assert!(manifest.join("examples/export-presentation.rs").is_file());
    let cargo_toml = std::fs::read_to_string(manifest.join("Cargo.toml")).unwrap();
    assert!(!cargo_toml.contains("[[bin]]"), "no extra [[bin]] targets in the app package");
}

fn run_export(home: &Path, out: &Path, scratch: &Path, extra: &[&str]) -> Output {
    exporter()
        .arg(home)
        .arg(out)
        .args(extra)
        .current_dir(scratch)
        .output()
        .expect("exporter must start")
}

/// Every file under `root` mapped to (sha256 of bytes, mtime in nanoseconds).
fn tree_state(root: &Path) -> BTreeMap<String, (String, u128)> {
    fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<String, (String, u128)>) {
        let mut entries: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
        entries.sort();
        for p in entries {
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().to_string();
            let meta = fs::symlink_metadata(&p).unwrap();
            if meta.is_dir() {
                out.insert(format!("{rel}/"), (String::new(), 0));
                walk(&p, root, out);
            } else {
                let bytes = fs::read(&p).unwrap_or_default();
                let mtime = meta
                    .modified()
                    .unwrap()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                out.insert(rel, (format!("{:x}", Sha256::digest(&bytes)), mtime));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

fn assert_trees_equal(before: &BTreeMap<String, (String, u128)>, after: &BTreeMap<String, (String, u128)>) {
    for (k, v) in before {
        match after.get(k) {
            None => panic!("input HOME changed: {k} was removed by the export"),
            Some(a) if a != v => panic!("input HOME changed: {k} differs after the export (bytes or mtime)"),
            _ => {}
        }
    }
    for k in after.keys() {
        assert!(before.contains_key(k), "input HOME changed: {k} was created by the export");
    }
}

fn first_difference(a: &str, b: &str) -> String {
    for (i, (la, lb)) in a.lines().zip(b.lines()).enumerate() {
        if la != lb {
            return format!("line {} differs:\n  first : {}\n  second: {}", i + 1, la, lb);
        }
    }
    format!("line counts differ: {} vs {}", a.lines().count(), b.lines().count())
}

fn load(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).expect("snapshot.json must exist")).unwrap()
}

/// The typing prefixes the exporter must record, in order, per query (trimmed, deduplicated).
fn expected_prefixes(query: &str) -> Vec<String> {
    let chars: Vec<char> = query.chars().collect();
    let mut out: Vec<String> = Vec::new();
    for n in 1..=chars.len() {
        let p: String = chars[..n].iter().collect();
        let t = p.trim().to_string();
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

fn waiting_count(list: &Value) -> usize {
    list.as_array()
        .unwrap()
        .iter()
        .filter(|l| l["state"] == "waiting")
        .count()
}

#[test]
fn export_is_deterministic_complete_and_leaves_the_input_untouched() {
    let tmp = tempdir().unwrap();
    let scratch = tempdir().unwrap();
    let home = tmp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let home = home.canonicalize().unwrap();
    generate_home(&home, scratch.path());

    let before = tree_state(&home);
    let out1 = tmp.path().join("out1");
    let out2 = tmp.path().join("out2");
    for out in [&out1, &out2] {
        let r = run_export(&home, out, scratch.path(), &[]);
        assert!(
            r.status.success(),
            "export failed: {}",
            String::from_utf8_lossy(&r.stderr)
        );
    }
    let after = tree_state(&home);
    assert_trees_equal(&before, &after);

    let a = fs::read_to_string(out1.join("snapshot.json")).unwrap();
    let b = fs::read_to_string(out2.join("snapshot.json")).unwrap();
    assert!(
        a == b,
        "the same HOME exported twice gave different snapshot.json: {}",
        first_difference(&a, &b)
    );

    let snap = load(&out1.join("snapshot.json"));
    assert_eq!(snap["format"], "armillary.presentation.v1");
    assert_eq!(snap["home"], home.to_string_lossy().as_ref());
    assert!(snap["reference_time"].as_i64().is_some(), "reference_time must be Unix milliseconds");

    // Agents: one entry per builtin adapter.
    let agents = snap["agents_list"].as_array().expect("agents_list");
    assert_eq!(
        agents.len(),
        orrery_adapters::builtin_adapters().len(),
        "agents_list must list every builtin adapter"
    );

    // Config. The dataset keeps its project folders (rules files, MCP configs) under <home>/projects/<slug>
    // and lists them in demo-manifest.json project_roots_in_home: the scan must include them as projects.
    assert!(snap["config_list"]["agents"].is_array(), "config_list must be a config snapshot");
    let manifest: Option<Value> = std::fs::read_to_string(home.join("demo-manifest.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    if let Some(roots) = manifest.as_ref().and_then(|m| m["project_roots_in_home"].as_object()) {
        if !roots.is_empty() {
            let projects = snap["config_list"]["projects"].as_array().expect("config_list.projects");
            assert_eq!(
                projects.len(),
                roots.len(),
                "every project folder in the dataset must be scanned: {projects:?}"
            );
        }
    }

    // Sessions and messages.
    let sessions = snap["sessions"].as_array().expect("sessions");
    assert!(!sessions.is_empty(), "no sessions were imported from the demo HOME");
    let messages = snap["messages"].as_object().expect("messages map");
    let totals = snap["message_totals"].as_object().expect("message_totals map");
    for s in sessions {
        let id = s["id"].as_str().unwrap();
        for key in ["display_title", "title_source", "first_activity_at", "last_activity_at"] {
            assert!(s.get(key).is_some(), "session {id}: missing derived field {key}");
        }
        match s["title_source"].as_str() {
            Some("native") => assert_eq!(s["display_title"], s["title"], "session {id}"),
            Some("first_prompt") => assert!(s["title"].is_null() && s["display_title"].is_string(), "session {id}"),
            None => assert!(s["display_title"].is_null(), "session {id}"),
            other => panic!("session {id}: unknown title_source {other:?}"),
        }
        let list = messages
            .get(id)
            .unwrap_or_else(|| panic!("session {id} has no messages entry"))
            .as_array()
            .unwrap();
        let reported = totals
            .get(id)
            .unwrap_or_else(|| panic!("session {id} has no message_totals entry"))
            .as_u64()
            .unwrap();
        assert_eq!(
            list.len() as u64,
            reported,
            "session {id}: messages has {} items but messages_page reported {reported}",
            list.len()
        );
        let seqs: Vec<u64> = list.iter().map(|m| m["seq"].as_u64().unwrap()).collect();
        let mut sorted = seqs.clone();
        sorted.sort();
        assert_eq!(seqs, sorted, "session {id}: messages are not in seq order");
        // Privacy edge: the import must have read the demo HOME, never another folder.
        let root = s["provenance"]["store"]["canonical_root"].as_str().unwrap();
        assert!(
            root.starts_with(home.to_str().unwrap()),
            "session {id} was imported from {root}, outside the demo HOME {}",
            home.display()
        );
    }

    // Import events.
    let events = snap["import"]["events"].as_array().expect("import.events");
    assert!(events.len() >= 2, "import.events must hold started and finished");
    assert_eq!(events[0]["event"], "import:progress");
    assert_eq!(events[0]["payload"]["phase"], "started");
    assert_eq!(events[events.len() - 1]["payload"]["phase"], "finished");
    let ts: Vec<u64> = events.iter().map(|e| e["t"].as_u64().unwrap()).collect();
    assert!(ts.windows(2).all(|w| w[0] <= w[1]), "import event pacing must not go backwards: {ts:?}");
    assert!(snap["import"]["summary"]["sessions"].as_u64().unwrap() > 0);

    // Search: an entry for every typing prefix of every query, in order.
    let queries: Value =
        serde_json::from_str(&fs::read_to_string(repo_root().join("demo/presentation/queries.json")).unwrap()).unwrap();
    let limit = queries["limit"].as_u64().unwrap();
    assert_eq!(snap["search"]["limit"].as_u64().unwrap(), limit);
    let entries = snap["search"]["entries"].as_array().expect("search.entries");
    let mut expected: Vec<String> = Vec::new();
    for q in queries["queries"].as_array().unwrap() {
        expected.extend(expected_prefixes(q.as_str().unwrap()));
    }
    let got: Vec<&str> = entries.iter().map(|e| e["query"].as_str().unwrap()).collect();
    for (i, want) in expected.iter().enumerate() {
        assert!(
            got.get(i) == Some(&want.as_str()),
            "search entry {i}: expected prefix {want:?}, found {:?}",
            got.get(i)
        );
    }
    assert_eq!(got.len(), expected.len(), "search has extra or missing entries");
    for e in entries {
        assert_eq!(e["limit"].as_u64().unwrap(), limit);
        assert!(e.get("page").is_some() || e.get("error").is_some(), "entry {} has neither page nor error", e["query"]);
    }
    let mut highlighted_full_query = false;
    for q in queries["queries"].as_array().unwrap() {
        let q = q.as_str().unwrap();
        let entry = entries.iter().rev().find(|e| e["query"] == q).unwrap();
        if let Some(items) = entry["page"]["items"].as_array() {
            for it in items {
                let text = it["text"].as_str().unwrap();
                let utf16 = text.encode_utf16().count() as u64;
                let hl = it["highlights"].as_array().unwrap();
                for r in hl {
                    assert!(r[0].as_u64().unwrap() < r[1].as_u64().unwrap() && r[1].as_u64().unwrap() <= utf16);
                }
                if !hl.is_empty() {
                    highlighted_full_query = true;
                }
            }
        }
    }
    assert!(highlighted_full_query, "no full query produced a hit with a highlight range");

    // Live.
    let live = &snap["live"];
    assert!(live["initial"]["list"].is_array());
    if home.join("processes.json").exists() {
        assert_eq!(live["process_table"], "dataset");
        let initial = waiting_count(&live["initial"]["list"]);
        assert!(initial >= 1, "processes.json exists but the initial scan found no waiting session");
        let steps = live["steps"].as_array().unwrap();
        if let Some(first) = steps.first() {
            assert_eq!(
                waiting_count(&first["list"]),
                initial + 1,
                "the first live step must have one more waiting session than the initial scan"
            );
        }
    } else {
        assert_eq!(live["process_table"], "absent");
        assert!(live["steps"].as_array().unwrap().is_empty(), "no process table, so no live step may be recorded");
    }
}

#[test]
fn exporter_refuses_the_real_home_before_scanning_anything() {
    // The child sees HOME = a tempdir, so "the real home" is a synthetic folder here and the
    // actual user HOME is never handed to the exporter.
    let tmp = tempdir().unwrap();
    let scratch = tempdir().unwrap();
    let fake_home = tmp.path().join("fakehome");
    fs::create_dir_all(fake_home.join(".claude/projects/x")).unwrap();
    fs::write(fake_home.join(".claude/projects/x/s.jsonl"), "{}\n").unwrap();
    let before = tree_state(&fake_home);

    let cases: Vec<(&str, PathBuf)> = vec![
        ("the home itself", fake_home.clone()),
        ("a parent of the home", tmp.path().to_path_buf()),
    ];
    for (label, target) in cases {
        let out = tmp.path().join(format!("refused-out-{}", label.len()));
        let r = exporter()
            .env("HOME", &fake_home)
            .arg(&target)
            .arg(&out)
            .current_dir(scratch.path())
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&r.stderr).to_lowercase();
        assert!(!r.status.success(), "{label}: exporter must exit non-zero");
        assert!(stderr.contains("refus"), "{label}: stderr must say it refuses, got: {stderr}");
        assert!(!out.join("snapshot.json").exists(), "{label}: no snapshot may be written");
    }
    assert_trees_equal(&before, &tree_state(&fake_home));
}

#[test]
fn exporter_refuses_a_missing_demo_home() {
    let tmp = tempdir().unwrap();
    let r = run_export(&tmp.path().join("nope"), &tmp.path().join("out"), tmp.path(), &[]);
    assert!(!r.status.success());
    let stderr = String::from_utf8_lossy(&r.stderr).to_lowercase();
    assert!(stderr.contains("refus"), "a missing demo HOME must be refused, got: {stderr}");
    assert!(!tmp.path().join("out/snapshot.json").exists());
}

const STUB_GENERATOR: &str = r#"
# Stub of the dataset generator's append hook (supports --append-live).
import sys, json, os, datetime
from pathlib import Path
a = sys.argv[1:]
home = Path(a[0])
key = a[a.index("--append-live") + 1]
now = a[a.index("--now") + 1]
ts = datetime.datetime.fromisoformat(now.replace("Z", "+00:00")).timestamp()
mf = home / "demo-manifest.json"
manifest = json.loads(mf.read_text())
entry = next(e for e in manifest["live"] if e["key"] == "live/" + key)
path = home / entry["path"]
rec = {"type": "permission_prompt", "uuid": "p-" + key, "sessionId": "stub-live-session",
       "timestamp": now, "cwd": "/Users/fictional-dev/projects/aurora-docs",
       "message": {"role": "assistant", "content": [{"type": "text", "text": "needs permission"}]}}
with open(path, "a") as f:
    f.write(json.dumps(rec) + "\n")
os.utime(path, (ts, ts))
entry["state"] = "waiting"
mf.write_text(json.dumps(manifest, indent=2) + "\n")
"#;

#[test]
fn live_sequence_appends_scans_and_restores_the_input() {
    let tmp = tempdir().unwrap();
    let scratch = tempdir().unwrap();
    let home = tmp.path().join("home");
    let proj = home.join(".claude/projects/aurora-docs");
    fs::create_dir_all(&proj).unwrap();
    let home = home.canonicalize().unwrap();
    let proj = home.join(".claude/projects/aurora-docs");
    let cwd = "/Users/fictional-dev/projects/aurora-docs";
    let file = proj.join("stub-live-session.jsonl");
    let rec = |ty: &str, role: &str, text: &str, n: u32| {
        format!(
            "{{\"type\":\"{ty}\",\"uuid\":\"u{n}\",\"sessionId\":\"stub-live-session\",\"timestamp\":\"2026-10-12T17:59:{:02}.000Z\",\"cwd\":\"{cwd}\",\"message\":{{\"role\":\"{role}\",\"content\":[{{\"type\":\"text\",\"text\":\"{text}\"}}]}}}}\n",
            50 + n
        )
    };
    let mut body = rec("user", "user", "Add dark mode tokens", 1);
    body.push_str(&rec("assistant", "assistant", "Looking at the playground styles", 2));
    fs::write(&file, body).unwrap();
    // Last write 5 s before the reference time 2026-10-12T18:00:00Z (1791828000 s).
    let mtime = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1791828000 - 5);
    fs::File::options().write(true).open(&file).unwrap().set_modified(mtime).unwrap();

    let manifest = serde_json::json!({
        "reference_now": "2026-10-12T18:00:00Z",
        "now": "2026-10-12T18:00:00Z",
        "fictional_project_roots": {},
        "project_roots_in_home": {},
        "sessions": [],
        "heroes": [],
        "live": [{
            "key": "live/claude-aurora-working", "agent": "claude-code", "project": "aurora-docs",
            "native_id": "stub-live-session",
            "path": ".claude/projects/aurora-docs/stub-live-session.jsonl",
            "state": "working", "start_ms": 1791826000000u64, "last_write_ms": 1791827995000u64
        }]
    });
    fs::write(home.join("demo-manifest.json"), serde_json::to_string_pretty(&manifest).unwrap()).unwrap();
    fs::write(
        home.join("processes.json"),
        serde_json::json!([{"pid": 49102, "binary": "claude", "cwd": cwd, "started_at": 1791824940000u64}]).to_string(),
    )
    .unwrap();
    let stub = tmp.path().join("stub_generate.py");
    fs::write(&stub, STUB_GENERATOR).unwrap();

    let before = tree_state(&home);
    let out = tmp.path().join("out");
    let r = run_export(&home, &out, scratch.path(), &["--generator", stub.to_str().unwrap()]);
    assert!(r.status.success(), "export failed: {}", String::from_utf8_lossy(&r.stderr));
    assert_trees_equal(&before, &tree_state(&home));

    let snap = load(&out.join("snapshot.json"));
    let live = &snap["live"];
    assert_eq!(live["process_table"], "dataset");
    assert_eq!(live["initial"]["at"].as_i64().unwrap(), 1791828000000);
    let initial = live["initial"]["list"].as_array().unwrap();
    assert_eq!(initial.len(), 1, "one live session expected: {initial:?}");
    assert_eq!(initial[0]["state"], "working");
    let steps = live["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 1, "one step per working entry");
    assert_eq!(steps[0]["name"], "claude-aurora-working asks for permission");
    assert_eq!(steps[0]["at"].as_i64().unwrap(), 1791828000000 + 41_000);
    assert_eq!(waiting_count(&steps[0]["list"]), 1);
}

/// Builds the demo HOME, exports it and returns (home, snapshot).
fn export_demo() -> (PathBuf, Value) {
    let tmp = tempdir().unwrap();
    let scratch = tempdir().unwrap();
    let home = tmp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let home = home.canonicalize().unwrap();
    generate_home(&home, scratch.path());
    let out = tmp.path().join("out");
    let r = run_export(&home, &out, scratch.path(), &[]);
    assert!(r.status.success(), "export failed: {}", String::from_utf8_lossy(&r.stderr));
    let snap = load(&out.join("snapshot.json"));
    // The tempdirs are removed at the end of this function; the snapshot is already in memory.
    (home, snap)
}

#[test]
fn snapshot_carries_the_real_first_run_recording() {
    let (home, snap) = export_demo();
    let fr = &snap["firstrun"];
    assert!(fr.is_object(), "snapshot.firstrun is missing: the exporter must record the first run");

    // Status: view tours skip the first run, the first-run tour forces it.
    assert_eq!(fr["status"], serde_json::json!({"consented": true, "completed": true}));

    // Plan: one entry per builtin adapter, plus the folders the scan will read.
    let catalogue_size = orrery_adapters::builtin_adapters().len();
    let plan_entries = fr["plan"]["entries"].as_array().expect("firstrun.plan.entries");
    assert_eq!(plan_entries.len(), catalogue_size, "the plan must list every builtin adapter");
    assert!(
        fr["plan"]["folders"].as_array().is_some_and(|f| !f.is_empty()),
        "the plan must list the folders it reads"
    );
    assert!(fr["plan"]["platform"].as_str().is_some_and(|p| !p.is_empty()));

    // Events: catalogue first, one agent event per catalogue entry, imports, exactly one done last.
    let events = fr["events"].as_array().expect("firstrun.events");
    assert!(!events.is_empty());
    assert_eq!(events[0]["event"], "firstrun:catalogue");
    assert_eq!(events[0]["t"].as_u64(), Some(0));
    assert_eq!(events[0]["payload"]["entries"].as_array().unwrap().len(), catalogue_size);

    let name = |e: &Value| e["event"].as_str().unwrap().to_string();
    let agent_events: Vec<&Value> = events.iter().filter(|e| name(e) == "firstrun:agent").collect();
    assert_eq!(agent_events.len(), catalogue_size, "one firstrun:agent per catalogue entry");
    let catalogue_ids: Vec<&str> = events[0]["payload"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    let agent_ids: Vec<&str> = agent_events.iter().map(|e| e["payload"]["id"].as_str().unwrap()).collect();
    assert_eq!(agent_ids, catalogue_ids, "agent events follow the catalogue order");
    assert!(
        agent_events.iter().any(|e| e["payload"]["found"] == true),
        "the demo HOME must make at least one agent found"
    );

    let finished: Vec<&Value> = events
        .iter()
        .filter(|e| name(e) == "firstrun:import" && e["payload"]["phase"] == "finished")
        .collect();
    assert!(!finished.is_empty(), "at least one firstrun:import with phase finished");
    assert!(events.iter().any(|e| name(e) == "firstrun:import" && e["payload"]["phase"] == "started"));

    let dones: Vec<&Value> = events.iter().filter(|e| name(e) == "firstrun:done").collect();
    assert_eq!(dones.len(), 1, "exactly one firstrun:done");
    assert_eq!(name(events.last().unwrap()), "firstrun:done", "done is the last event");
    let done = &dones[0]["payload"];
    let archived = snap["sessions"].as_array().unwrap().len() as u64;
    assert!(archived > 0);
    assert_eq!(
        done["sessionsImported"].as_u64().unwrap(),
        archived,
        "the first run imports the same sessions the main archive holds"
    );
    assert_eq!(done["catalogueSize"].as_u64().unwrap(), catalogue_size as u64);
    assert_eq!(done["errors"].as_u64().unwrap(), 0);
    assert_eq!(
        done["agentsFound"].as_u64().unwrap(),
        agent_events.iter().filter(|e| e["payload"]["found"] == true).count() as u64
    );
    assert!(done["constellations"].as_array().is_some_and(|c| !c.is_empty()));
    // live_sessions counts the recorded initial live list without the done ones.
    let live_not_done = snap["live"]["initial"]["list"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|l| l["state"] != "done")
        .count() as u64;
    assert_eq!(done["liveSessions"].as_u64().unwrap(), live_not_done);

    // Pacing hints: deterministic, never going backwards.
    let ts: Vec<u64> = events.iter().map(|e| e["t"].as_u64().expect("t is a whole number of ms")).collect();
    assert!(ts.windows(2).all(|w| w[0] <= w[1]), "firstrun pacing must not go backwards: {ts:?}");

    // Privacy: the absolute demo HOME never appears in the recording; folders show "~".
    let text = serde_json::to_string(fr).unwrap();
    assert!(
        !text.contains(home.to_str().unwrap()),
        "the first-run recording contains the absolute demo HOME path"
    );
    assert!(
        agent_events.iter().any(|e| {
            e["payload"]["folders"].as_array().unwrap().iter().any(|f| f.as_str().unwrap().starts_with('~'))
        }),
        "a found agent's folders must be shown relative to the home as ~"
    );
}

#[test]
fn import_progress_pacing_works_from_the_json_alone() {
    // The recorded import:progress events keep their rule (see the README) whatever the Rust
    // payload type is: started is 0 and the times never go backwards.
    let (_home, snap) = export_demo();
    let events = snap["import"]["events"].as_array().unwrap();
    assert_eq!(events[0]["t"].as_u64(), Some(0));
    let ts: Vec<u64> = events.iter().map(|e| e["t"].as_u64().unwrap()).collect();
    assert!(ts.windows(2).all(|w| w[0] <= w[1]));
    let last = events.last().unwrap();
    assert_eq!(last["payload"]["phase"], "finished");
    assert!(last["t"].as_u64().unwrap() > 0, "the closing event comes after the first adapter");
}
