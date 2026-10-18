//! Presentation snapshot exporter.
//!
//! Runs the production Rust code (detection, import, search, config scan, live detector) over a
//! synthetic demo HOME (see demo/dataset/generate.py) and writes the results as one JSON file,
//! `snapshot.json`. The web build of the app answers its Tauri commands from that file, so the
//! demo recordings and screenshots show real outputs without the desktop shell.
//!
//! Usage: export-presentation <demo-home> <out-dir> [--queries <file>] [--generator <generate.py>]
//!
//! The exporter never reads the clock for anything that reaches the snapshot and never touches
//! the user's real HOME. The same demo HOME exported twice gives byte-identical files.

// Under `cargo test` this crate would otherwise recompile (and re-run) the unit tests of every
// module included below; the exporter has no tests of its own (tests/presentation_export.rs).
#![cfg(not(test))]
#![allow(dead_code, unused_imports)]

#[path = "../src/agents.rs"]
mod agents;
#[path = "../src/archive_api.rs"]
mod archive_api;
#[path = "../src/config_scan.rs"]
mod config_scan;
#[path = "../src/firstrun.rs"]
mod firstrun;
#[path = "../src/importer.rs"]
mod importer;
#[path = "../src/launch.rs"]
mod launch;
#[path = "../src/live.rs"]
mod live;

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::SystemTime;

use orrery_adapters::env::{MockEnvironment, SystemFileSystem, TargetOs};
use orrery_archive::Archive;
use serde::Serialize;
use serde_json::{json, Map, Value};

use archive_api::{scope, ApiError, CoreState, SearchInput, SessionQuery};
use live::{FakeProcessScanner, LiveDetector, LiveDetectorConfig, ProcessInfo};

/// Used when the demo HOME has no manifest: 2026-10-12T18:00:00Z, the dataset's fixed reference.
const FALLBACK_REFERENCE_MS: i64 = 1_791_828_000_000;
/// Distance between live steps (reference + 41 s * step number).
const LIVE_STEP_MS: i64 = 41_000;
/// Pacing hint between import progress events, in milliseconds (see `pace`).
const IMPORT_STEP_MS: u64 = 400;
/// First-run pacing (see `firstrun_section`): catalogue at 0, then these fixed steps.
const FIRSTRUN_AGENT_STEP_MS: u64 = 120;
const FIRSTRUN_IMPORT_STEP_MS: u64 = 200;
const FIRSTRUN_DONE_GAP_MS: u64 = 600;
const FORMAT: &str = "armillary.presentation.v1";

fn main() {
    if let Err(message) = run() {
        eprintln!("export-presentation: {message}");
        std::process::exit(1);
    }
}

struct Args {
    home: PathBuf,
    out: PathBuf,
    queries: PathBuf,
    generator: PathBuf,
}

fn parse_args() -> Result<Args, String> {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut queries = repo.join("demo/presentation/queries.json");
    let mut generator = repo.join("demo/dataset/generate.py");
    let mut positional: Vec<PathBuf> = Vec::new();
    let mut it = std::env::args_os().skip(1);
    while let Some(arg) = it.next() {
        match arg.to_str() {
            Some("--queries") => {
                queries = PathBuf::from(it.next().ok_or("--queries needs a file")?);
            }
            Some("--generator") => {
                generator = PathBuf::from(it.next().ok_or("--generator needs a path")?);
            }
            Some(flag) if flag.starts_with("--") => return Err(format!("unknown option {flag}")),
            _ => positional.push(PathBuf::from(arg)),
        }
    }
    if positional.len() != 2 {
        return Err(
            "usage: export-presentation <demo-home> <out-dir> [--queries <file>] [--generator <generate.py>]"
                .into(),
        );
    }
    let out = positional.pop().unwrap();
    let home = positional.pop().unwrap();
    Ok(Args { home, out, queries, generator })
}

/// Canonicalize the demo HOME and refuse the real one. Runs before anything is scanned.
fn checked_home(raw: &Path) -> Result<PathBuf, String> {
    let home = raw
        .canonicalize()
        .map_err(|e| format!("refusing to run: demo HOME {} is not usable ({e})", raw.display()))?;
    if !home.is_dir() {
        return Err(format!("refusing to run: {} is not a folder", home.display()));
    }
    if let Some(real) = std::env::var_os("HOME").and_then(|h| PathBuf::from(h).canonicalize().ok()) {
        // Equal to the real HOME, or an ancestor of it (which would contain it).
        if real.starts_with(&home) {
            return Err(format!(
                "refusing to run: {} is the real HOME or contains it; pass a generated demo HOME",
                home.display()
            ));
        }
    }
    Ok(home)
}

/// Make the whole process see the demo HOME and nothing else. The importer asks the process
/// environment (`SystemEnvironment`) which home to use; with this it can only ever pick the demo
/// HOME, even if that folder sits under the real HOME. Returns the original PATH, kept only so
/// the dataset generator can be started.
fn confine_process_env(home: &Path) -> Option<std::ffi::OsString> {
    let original_path = std::env::var_os("PATH");
    let keys: Vec<_> = std::env::vars_os().map(|(k, _)| k).collect();
    for key in keys {
        std::env::remove_var(key);
    }
    std::env::set_var("HOME", home);
    std::env::set_var("USERPROFILE", home);
    original_path
}

fn run() -> Result<(), String> {
    let args = parse_args()?;
    let home = checked_home(&args.home)?;
    let original_path = confine_process_env(&home);

    let queries_text = fs::read_to_string(&args.queries)
        .map_err(|e| format!("cannot read queries file {}: {e}", args.queries.display()))?;
    let queries: Value = serde_json::from_str(&queries_text)
        .map_err(|e| format!("queries file is not valid JSON: {e}"))?;
    let query_list: Vec<String> = queries["queries"]
        .as_array()
        .ok_or("queries file needs a \"queries\" array")?
        .iter()
        .map(|q| q.as_str().map(str::to_string).ok_or("every query must be a string"))
        .collect::<Result<_, _>>()?;
    let limit = queries["limit"]
        .as_u64()
        .and_then(|l| u32::try_from(l).ok())
        .ok_or("queries file needs a numeric \"limit\"")?;

    fs::create_dir_all(&args.out)
        .map_err(|e| format!("cannot create {}: {e}", args.out.display()))?;

    // Reference time: the manifest's "now" when present, else the fixed constant. No wall clock.
    let manifest = read_json(&home.join("demo-manifest.json"));
    let reference_ms = manifest
        .as_ref()
        .and_then(|m| m["now"].as_str())
        .and_then(parse_iso_ms)
        .unwrap_or(FALLBACK_REFERENCE_MS);

    // Detection and import, confined to the demo HOME.
    let mut mock = MockEnvironment::new(TargetOs::current(), home.to_str().ok_or("HOME is not UTF-8")?);
    let bin_dir = home.join(".local/bin");
    if bin_dir.is_dir() {
        mock = mock.with_var("PATH", bin_dir.to_str().ok_or("PATH folder is not UTF-8")?);
    }
    let env = scope::HomeScopedEnvironment::new(home.clone(), mock);
    let path_dirs = env.scoped_path_entries();
    let fs_scoped = scope::HomeScopedFileSystem::new(home.clone(), path_dirs, SystemFileSystem);

    let targets = importer::discover_targets(&env, &fs_scoped);
    let archive = Arc::new(Archive::in_memory().map_err(|e| format!("cannot open archive: {e:?}"))?);
    let state = CoreState::new(archive.clone(), targets);
    // Each emitted payload is kept as JSON, so this does not depend on the importer's payload type.
    let progress: RefCell<Vec<Value>> = RefCell::new(Vec::new());
    let summary = archive_api::import_now_core(&state, None, &|p| {
        progress.borrow_mut().push(serde_json::to_value(&p).unwrap_or(Value::Null))
    })
    .map_err(|e| format!("import failed: {e}"))?;
    let mut pacer = ImportPacer::default();
    let events: Vec<Value> = progress
        .into_inner()
        .into_iter()
        .map(|p| {
            let t = pacer.pace(&p);
            json!({"event": "import:progress", "payload": p, "t": t})
        })
        .collect();

    let agents_list = agents::agents_list_with_env(&env, &fs_scoped)?;
    // The dataset keeps its project folders under <home>/projects/<slug> (manifest project_roots_in_home);
    // only folders inside the demo HOME are scanned, in sorted order.
    let mut project_roots: Vec<PathBuf> = manifest
        .as_ref()
        .and_then(|m| m["project_roots_in_home"].as_object())
        .map(|roots| {
            roots
                .values()
                .filter_map(|v| v.as_str())
                .map(|rel| home.join(rel))
                .filter(|p| p.is_dir() && p.canonicalize().map(|c| c.starts_with(&home)).unwrap_or(false))
                .collect()
        })
        .unwrap_or_default();
    project_roots.sort();
    let config_list = config_scan::scan(&config_scan::ScanContext::new(home.clone(), project_roots), None)
        .map_err(|e| format!("config scan failed: {e}"))?;

    // Sessions and messages: every page, in the core's order.
    let mut sessions = Vec::new();
    let mut offset = 0u32;
    loop {
        let page = archive_api::sessions_query_core(
            &archive,
            &SessionQuery { limit: Some(200), offset: Some(offset), ..Default::default() },
        )
        .map_err(|e| format!("sessions_query failed: {e}"))?;
        let n = page.items.len() as u32;
        sessions.extend(page.items);
        offset += n;
        if n == 0 || u64::from(offset) >= page.total {
            break;
        }
    }
    let mut messages: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut message_totals: BTreeMap<String, u64> = BTreeMap::new();
    let mut message_count = 0usize;
    for session in &sessions {
        let mut items = Vec::new();
        let mut offset = 0u32;
        loop {
            let page = archive_api::messages_page_core(&archive, &session.id, Some(200), Some(offset))
                .map_err(|e| format!("messages_page failed for {}: {e}", session.id))?;
            let n = page.items.len() as u32;
            for m in &page.items {
                items.push(to_value(m)?);
            }
            offset += n;
            message_totals.insert(session.id.clone(), page.total);
            if n == 0 || u64::from(offset) >= page.total {
                break;
            }
        }
        message_count += items.len();
        messages.insert(session.id.clone(), items);
    }

    // Search: every typing prefix of every query, in typing order.
    let mut entries: Vec<Value> = Vec::new();
    for query in &query_list {
        for prefix in typing_prefixes(query) {
            let input = SearchInput { query: prefix.clone(), limit: Some(limit), ..Default::default() };
            entries.push(match archive_api::search_core(&archive, &input) {
                Ok(page) => json!({"query": prefix, "limit": limit, "page": to_value(&page)?}),
                Err(error) => json!({"query": prefix, "limit": limit, "error": to_value::<ApiError>(&error)?}),
            });
        }
    }

    let live = live_section(&home, manifest.as_ref(), reference_ms, &args.generator, original_path.as_ref())?;
    let live_steps = live["steps"].as_array().map(|s| s.len()).unwrap_or(0);

    let firstrun = firstrun_section(&env, &fs_scoped, &live)?;

    let mut snapshot = json!({
        "format": FORMAT,
        "reference_time": reference_ms,
        "home": home.to_string_lossy(),
        "import": {"summary": to_value(&summary)?, "events": events},
        "agents_list": to_value(&agents_list)?,
        "config_list": to_value(&config_list)?,
        "sessions": to_value(&sessions)?,
        "messages": messages,
        "message_totals": message_totals,
        "search": {"limit": limit, "entries": entries},
        "live": live,
        "firstrun": firstrun,
    });
    // Optional recorded terminal session for the launchpad scene (asciicast v2).
    if let Some(cast) = read_cast(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../demo/presentation/launchpad.cast"))? {
        snapshot["launchpad"] = json!({"cast": cast});
    }
    let mut text = serde_json::to_string_pretty(&sort_keys(snapshot)).map_err(|e| e.to_string())?;
    text.push('\n');
    let target = args.out.join("snapshot.json");
    fs::write(&target, &text).map_err(|e| format!("cannot write {}: {e}", target.display()))?;

    eprintln!(
        "export-presentation: sessions={} messages={} queries={} search_entries={} live_steps={} snapshot={} bytes",
        sessions.len(),
        message_count,
        query_list.len(),
        entries.len(),
        live_steps,
        text.len()
    );
    Ok(())
}

fn to_value<T: Serialize>(v: &T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| format!("cannot serialize: {e}"))
}

/// Deterministic pacing hint for the recorded `import:progress` events, in milliseconds from the
/// start of the run, computed from each event's JSON alone (`phase` and `agentId`), never measured.
/// A terminal event is one with a non-empty `agentId` whose phase is "adapter", "finished" or
/// "error". With `k` terminal events counted so far (this one included when it is terminal):
/// a terminal event is `400 * k`; the run-level "finished" (empty `agentId`) is `400 * k` for the
/// final `k`; every other event (run-level "started", per-agent "started" and "progress") is
/// `400 * k` for the terminal events counted before it. So run "started" is 0 and the times
/// never go backwards.
#[derive(Default)]
struct ImportPacer {
    terminal: u64,
}

impl ImportPacer {
    fn pace(&mut self, payload: &Value) -> u64 {
        let phase = payload["phase"].as_str().unwrap_or("");
        let has_agent = payload["agentId"].as_str().is_some_and(|a| !a.is_empty());
        if has_agent && matches!(phase, "adapter" | "finished" | "error") {
            self.terminal += 1;
        }
        IMPORT_STEP_MS * self.terminal
    }
}

/// The real first run over the same HOME-confined env and file system: the consent plaque's plan,
/// and every event `scan_core` emits, in order, with the payload the Tauri command would emit
/// (`FirstRunEvent::payload_json`). The scan imports into its own in-memory archive, so the main
/// archive's content and ids are untouched. `live_sessions` counts the recorded initial live list
/// without the sessions that are done.
///
/// Pacing hint `t` (ms, a fixed rule, never measured): the catalogue event is 0; the i-th agent
/// event (1-based) is 120 * i; the j-th import event (1-based) is 200 * j after the last agent
/// event; the done event is 600 after the event before it.
fn firstrun_section(
    env: &dyn orrery_adapters::env::Environment,
    fs: &dyn orrery_adapters::env::FileSystem,
    live: &Value,
) -> Result<Value, String> {
    let plan = to_value(&firstrun::plan_core(env))?;
    let live_sessions = live["initial"]["list"]
        .as_array()
        .map(|list| list.iter().filter(|l| l["state"] != "done").count() as u32)
        .unwrap_or(0);
    let archive = Arc::new(Archive::in_memory().map_err(|e| format!("cannot open first-run archive: {e:?}"))?);
    let recorded: RefCell<Vec<(&'static str, Value)>> = RefCell::new(Vec::new());
    firstrun::scan_core(env, fs, archive, live_sessions, &|ev| {
        recorded.borrow_mut().push((ev.name(), ev.payload_json()));
    })
    .map_err(|e| format!("first-run scan failed: {e}"))?;

    let mut agents = 0u64;
    let mut imports = 0u64;
    let mut last = 0u64;
    let events: Vec<Value> = recorded
        .into_inner()
        .into_iter()
        .map(|(name, payload)| {
            let t = match name {
                "firstrun:agent" => {
                    agents += 1;
                    FIRSTRUN_AGENT_STEP_MS * agents
                }
                "firstrun:import" => {
                    imports += 1;
                    FIRSTRUN_AGENT_STEP_MS * agents + FIRSTRUN_IMPORT_STEP_MS * imports
                }
                "firstrun:done" => last + FIRSTRUN_DONE_GAP_MS,
                _ => 0,
            };
            last = t;
            json!({"event": name, "payload": payload, "t": t})
        })
        .collect();
    Ok(json!({
        "status": {"consented": true, "completed": true},
        "plan": plan,
        "events": events,
    }))
}

/// Typing prefixes of a query (1 character up to the whole query), trimmed, empty ones skipped,
/// identical ones kept once.
fn typing_prefixes(query: &str) -> Vec<String> {
    let chars: Vec<char> = query.chars().collect();
    let mut out: Vec<String> = Vec::new();
    for n in 1..=chars.len() {
        let prefix: String = chars[..n].iter().collect();
        let trimmed = prefix.trim().to_string();
        if !trimmed.is_empty() && !out.contains(&trimmed) {
            out.push(trimmed);
        }
    }
    out
}

/// Rebuild every JSON object with its keys in sorted order, so the file never depends on the
/// iteration order of a hash map inside a serialized type. Arrays keep their order.
fn sort_keys(v: Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map.into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            let mut out = Map::new();
            for (k, val) in entries {
                out.insert(k, sort_keys(val));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(sort_keys).collect()),
        other => other,
    }
}

/// asciicast v2: the first line is a JSON header, every other non-empty line is
/// `[seconds, "o", data]`. Returns `{header, events}`, or `None` when the file is absent.
fn read_cast(path: &Path) -> Result<Option<Value>, String> {
    let Ok(text) = fs::read_to_string(path) else {
        return Ok(None);
    };
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let header: Value = serde_json::from_str(lines.next().ok_or("launchpad.cast is empty")?)
        .map_err(|e| format!("launchpad.cast header is not JSON: {e}"))?;
    let events: Vec<Value> = lines
        .map(|l| serde_json::from_str(l).map_err(|e| format!("launchpad.cast event is not JSON: {e}")))
        .collect::<Result<_, _>>()?;
    Ok(Some(json!({"header": header, "events": events})))
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

// ---------- live ----------

fn read_process_table(home: &Path) -> Option<Vec<ProcessInfo>> {
    let rows = read_json(&home.join("processes.json"))?;
    Some(
        rows.as_array()?
            .iter()
            .filter_map(|r| {
                Some(ProcessInfo {
                    pid: u32::try_from(r["pid"].as_u64()?).ok()?,
                    binary: r["binary"].as_str()?.to_string(),
                    cwd: r["cwd"].as_str().map(PathBuf::from),
                    started_at: r["started_at"].as_i64(),
                })
            })
            .collect(),
    )
}

/// Bytes and mtime of files that a live step is about to change. Restores them on drop, so
/// the input HOME is left exactly as it was even when a step fails.
struct Restore {
    files: Vec<(PathBuf, Vec<u8>, SystemTime)>,
}

impl Restore {
    fn capture(paths: &[PathBuf]) -> Result<Self, String> {
        let mut files = Vec::new();
        for p in paths {
            let bytes = fs::read(p).map_err(|e| format!("cannot back up {}: {e}", p.display()))?;
            let mtime = fs::metadata(p)
                .and_then(|m| m.modified())
                .map_err(|e| format!("cannot read mtime of {}: {e}", p.display()))?;
            files.push((p.clone(), bytes, mtime));
        }
        Ok(Self { files })
    }

    fn restore(&self) -> Result<(), String> {
        for (path, bytes, mtime) in &self.files {
            fs::write(path, bytes).map_err(|e| format!("cannot restore {}: {e}", path.display()))?;
            fs::File::options()
                .write(true)
                .open(path)
                .and_then(|f| f.set_modified(*mtime))
                .map_err(|e| format!("cannot restore mtime of {}: {e}", path.display()))?;
        }
        Ok(())
    }
}

impl Drop for Restore {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

fn live_section(
    home: &Path,
    manifest: Option<&Value>,
    reference_ms: i64,
    generator: &Path,
    original_path: Option<&std::ffi::OsString>,
) -> Result<Value, String> {
    let table = read_process_table(home);
    let process_table = if table.is_some() { "dataset" } else { "absent" };

    let mut history_roots: HashMap<String, PathBuf> = HashMap::new();
    history_roots.insert("claude-code".into(), home.join(".claude/projects"));
    history_roots.insert("codex-cli".into(), home.join(".codex/sessions"));
    let config = LiveDetectorConfig {
        history_roots,
        active_window_secs: 900,
        idle_threshold_secs: 120,
        ..Default::default()
    };
    let mut detector = LiveDetector::new(config, Box::new(FakeProcessScanner::new(table.clone().unwrap_or_default())));

    let initial = to_value(&detector.scan(reference_ms))?;
    let mut steps: Vec<Value> = Vec::new();

    let supports_append = fs::read_to_string(generator)
        .map(|src| src.contains("--append-live"))
        .unwrap_or(false);
    if table.is_some() && supports_append {
        // The generator's own source decides support: an older generator has no argument parser
        // and would read "--help" as a folder name, so it is never run to ask.
        let working: Vec<(String, PathBuf)> = manifest
            .and_then(|m| m["live"].as_array())
            .map(|list| {
                list.iter()
                    .filter(|e| {
                        e["state"] == "working"
                            && matches!(e["agent"].as_str(), Some("claude-code") | Some("codex-cli"))
                    })
                    .filter_map(|e| {
                        let short = e["key"].as_str()?.strip_prefix("live/")?.to_string();
                        let rel = PathBuf::from(e["path"].as_str()?);
                        // The session file must lie inside the demo HOME.
                        if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir)) {
                            return None;
                        }
                        Some((short, home.join(rel)))
                    })
                    .collect()
            })
            .unwrap_or_default();

        for (index, (short, session_file)) in working.iter().enumerate() {
            let step = index as i64 + 1;
            let at = reference_ms + LIVE_STEP_MS * step;
            let guard = Restore::capture(&[session_file.clone(), home.join("demo-manifest.json")])?;
            let mut cmd = Command::new("python3");
            cmd.arg("-I")
                .arg(generator)
                .arg(home)
                .arg("--append-live")
                .arg(short)
                .arg("--now")
                .arg(iso_from_ms(at))
                .env_clear()
                .current_dir(home);
            if let Some(p) = original_path {
                cmd.env("PATH", p);
            }
            let out = cmd.output().map_err(|e| format!("cannot start python3: {e}"))?;
            if !out.status.success() {
                return Err(format!(
                    "generator --append-live {short} failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
            let list = to_value(&detector.scan(at))?;
            guard.restore()?;
            steps.push(json!({"name": format!("{short} asks for permission"), "at": at, "list": list}));
        }
    }

    Ok(json!({
        "process_table": process_table,
        "initial": {"at": reference_ms, "list": initial},
        "steps": steps,
    }))
}

// ---------- time ----------

/// Days since 1970-01-01 for a civil date (proleptic Gregorian).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// "YYYY-MM-DDTHH:MM:SS[.fff]" followed by "Z" or "+HH:MM" / "-HH:MM", as Unix milliseconds.
fn parse_iso_ms(text: &str) -> Option<i64> {
    let t = text.trim();
    let (date, rest) = t.split_once('T')?;
    let mut dp = date.split('-');
    let (y, mo, d): (i64, i64, i64) = (dp.next()?.parse().ok()?, dp.next()?.parse().ok()?, dp.next()?.parse().ok()?);
    let split = rest.find(|c| c == 'Z' || c == '+' || c == '-').unwrap_or(rest.len());
    let (clock, zone) = rest.split_at(split);
    let (hms, frac) = clock.split_once('.').unwrap_or((clock, ""));
    let mut cp = hms.split(':');
    let (h, mi, s): (i64, i64, i64) = (cp.next()?.parse().ok()?, cp.next()?.parse().ok()?, cp.next()?.parse().ok()?);
    let millis: i64 = if frac.is_empty() {
        0
    } else {
        format!("{:0<3}", &frac[..frac.len().min(3)]).parse().ok()?
    };
    let offset_min: i64 = match zone {
        "Z" | "" => 0,
        z => {
            let sign = if z.starts_with('-') { -1 } else { 1 };
            let (oh, om) = z[1..].split_once(':')?;
            sign * (oh.parse::<i64>().ok()? * 60 + om.parse::<i64>().ok()?)
        }
    };
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + s - offset_min * 60;
    Some(secs * 1000 + millis)
}

/// Unix milliseconds as "YYYY-MM-DDTHH:MM:SSZ" (whole seconds).
fn iso_from_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}
