//! Acceptance tests for the presentation dataset (demo/dataset/generate.py).
//!
//! The dataset is a fictional developer's HOME in the real agent layouts. These tests generate it,
//! import it through the PRODUCTION importer, and check what the demo needs: believable time, hero
//! sessions that import with plans / diffs / failures / usage, cross agent search, live sessions
//! that the real LiveDetector classifies, Switchboard configs the real scanner reads, determinism.
//!
//! Set ARMILLARY_DEMO_DUMP=<file> to write every imported session and its ordered block kinds to
//! <file> while the tests run (used to check what each adapter really produces).

#[path = "../src/importer.rs"]
mod importer;
#[path = "../src/archive_api.rs"]
mod archive_api;
#[path = "../src/live.rs"]
mod live;
#[path = "../src/config_scan.rs"]
#[allow(dead_code)]
mod config_scan;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

use orrery_adapters::env::{MockEnvironment, SystemFileSystem, TargetOs};
use orrery_archive::{Archive, SearchFilter, SessionFilter};

use importer::{discover_targets, Importer};
use live::{is_waiting_record, FakeProcessScanner, LiveDetector, LiveDetectorConfig, LiveState, ProcessInfo};

/// The fixed instant the live files are written relative to.
const NOW: &str = "2026-10-12T18:00:00Z";
const NOW_MS: i64 = 1_791_828_000_000;
const PROJECTS: [&str; 5] = [
    "skyline-weather",
    "nexus-gateway",
    "aurora-docs",
    "vortex-pipeline",
    "zenith-cli",
];

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn generator() -> PathBuf {
    match std::env::var("DEMO_GENERATOR") {
        Ok(p) => PathBuf::from(p),
        Err(_) => repo_root().join("demo/dataset/generate.py"),
    }
}

/// Run the generator exactly as documented: `python3 -I generate.py <home> --now <iso> [extra]`.
fn run_generator(home: &Path, extra: &[&str]) {
    let script = generator();
    assert!(script.exists(), "generate.py must exist at {}", script.display());
    let out = Command::new("python3")
        .arg("-I")
        .arg(&script)
        .arg(home)
        .args(["--now", NOW])
        .args(extra)
        .output()
        .expect("failed to execute python3");
    assert!(
        out.status.success(),
        "generate.py failed: {}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

struct Fixture {
    _tmp: TempDir,
    home: PathBuf,
    archive: Arc<Archive>,
    sessions: Vec<armillary_model::Session>,
    manifest: Value,
}

fn fixture() -> &'static Fixture {
    static F: OnceLock<Fixture> = OnceLock::new();
    F.get_or_init(|| {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().canonicalize().unwrap();
        run_generator(&home, &[]);
        let archive = import_home(&home);
        let page = archive
            .sessions_query(&SessionFilter { limit: Some(200), ..Default::default() })
            .unwrap();
        let manifest: Value =
            serde_json::from_str(&std::fs::read_to_string(home.join("demo-manifest.json")).expect("demo-manifest.json"))
                .unwrap();
        Fixture { _tmp: tmp, home, archive, sessions: page.items, manifest }
    })
}

/// Production import of a generated HOME: discover targets, run the importer per adapter.
fn import_home(home: &Path) -> Arc<Archive> {
    let env = MockEnvironment::new(TargetOs::Macos, home.to_str().unwrap());
    let fs = SystemFileSystem;
    let targets = discover_targets(&env, &fs);
    let ids: Vec<String> = targets.iter().map(|t| t.adapter.id.clone()).collect();
    for want in [
        "claude-code", "codex-cli", "gemini-cli", "cursor-cli", "opencode", "aider", "goose", "qwen-code",
        "github-copilot-cli", "cline", "amp",
    ] {
        assert!(ids.contains(&want.to_string()), "{want} must be discovered, got {ids:?}");
    }
    let archive = Arc::new(Archive::in_memory().unwrap());
    let importer = Importer::new(archive.clone());
    for t in &targets {
        if let Err(e) = importer.run_with_env(&[t.clone()], None, &env, &|_| {}) {
            panic!("importer failed for adapter '{}': {}", t.adapter.id, e);
        }
    }
    archive
}

/// Ordered blocks of a session, each tagged with its message seq, role and time.
fn blocks_of(f: &Fixture, session_id: &str) -> Vec<(u32, String, Option<i64>, Value)> {
    let mut out = vec![];
    for m in f.archive.session_messages(session_id).unwrap() {
        for b in &m.blocks {
            out.push((m.seq, m.role.clone(), m.at, serde_json::to_value(b).unwrap()));
        }
    }
    out
}

fn session_by_native<'a>(f: &'a Fixture, agent: &str, native: &str) -> &'a armillary_model::Session {
    f.sessions
        .iter()
        .find(|s| s.agent_id == agent && s.native_id.as_deref() == Some(native))
        .unwrap_or_else(|| panic!("session {agent}/{native} not imported"))
}

fn kind(b: &Value) -> &str {
    b["type"].as_str().unwrap_or("")
}

fn dump_if_requested(f: &Fixture) {
    let Ok(path) = std::env::var("ARMILLARY_DEMO_DUMP") else { return };
    let mut out = String::new();
    for s in &f.sessions {
        out.push_str(&format!(
            "SESSION {} {} native={:?} title={:?} start={:?} end={:?} turns={} usage={:?}/{:?} status={}\n",
            s.agent_id, s.project_root.clone().unwrap_or_default(), s.native_id, s.title, s.started_at, s.ended_at,
            s.turns, s.usage.input_tokens, s.usage.output_tokens, s.status
        ));
        for (seq, role, at, b) in blocks_of(f, &s.id) {
            let v: String = b.to_string().chars().take(400).collect();
            out.push_str(&format!("  {seq:>3} {role:<9} {at:?} {v}\n"));
        }
    }
    std::fs::write(path, out).unwrap();
}

// ---------------------------------------------------------------------------

#[test]
fn imports_every_agent_project_and_the_whole_manifest() {
    let f = fixture();
    dump_if_requested(f);
    let n = f.sessions.len();
    assert!((55..=75).contains(&n), "about 60 sessions expected, got {n}");

    let mut by_agent: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_project: BTreeMap<String, usize> = BTreeMap::new();
    for s in &f.sessions {
        *by_agent.entry(s.agent_id.clone()).or_default() += 1;
        if let Some(p) = &s.project_root {
            *by_project.entry(p.clone()).or_default() += 1;
        }
    }
    let at_least = |agent: &str, min: usize| {
        assert!(by_agent.get(agent).copied().unwrap_or(0) >= min, "{agent} needs >= {min}: {by_agent:?}");
    };
    at_least("claude-code", 12);
    at_least("codex-cli", 11);
    at_least("gemini-cli", 5);
    at_least("cursor-cli", 3);
    at_least("opencode", 4);
    at_least("goose", 3);
    at_least("aider", 3);
    at_least("qwen-code", 3);
    at_least("github-copilot-cli", 3);
    at_least("cline", 4);
    at_least("amp", 2);

    for p in PROJECTS {
        let c: usize = by_project.iter().filter(|(k, _)| k.contains(p)).map(|(_, v)| *v).sum();
        assert!(c >= 6, "project {p} should have at least 6 sessions, found {c}");
        assert!(
            by_project.keys().any(|k| k == &format!("/Users/fictional-dev/projects/{p}")),
            "project root of {p} must be the fictional absolute path"
        );
    }

    // blocks are well formed everywhere: every result answers an earlier call, every session has text
    for s in &f.sessions {
        let blocks = blocks_of(f, &s.id);
        let mut calls = BTreeSet::new();
        for (_, _, _, b) in &blocks {
            match kind(b) {
                "tool_call" => {
                    calls.insert(b["call_id"].as_str().unwrap().to_string());
                }
                "tool_result" => assert!(
                    calls.contains(b["call_id"].as_str().unwrap()),
                    "{} {:?}: tool result without an earlier call",
                    s.agent_id, s.native_id
                ),
                _ => {}
            }
        }
        assert!(blocks.iter().any(|(_, r, _, b)| r == "user" && kind(b) == "text"), "{:?} has no user prompt", s.native_id);
        assert!(blocks.iter().any(|(_, r, _, b)| r == "assistant" && kind(b) == "text" && b["text"].as_str().unwrap().len() > 40),
                "{} {:?} has no assistant reply", s.agent_id, s.native_id);
    }

    // documented adapter limit: aider and amp stores carry no project, so those sessions are unassigned
    for s in f.sessions.iter().filter(|s| s.agent_id == "aider" || s.agent_id == "amp") {
        assert!(s.project_root.is_none(), "{} now reports a project root; update the README limits", s.agent_id);
    }

    // every session the generator says it wrote must have imported (no silently dropped source)
    let mut expected: BTreeMap<String, usize> = BTreeMap::new();
    for key in ["sessions", "live"] {
        for e in f.manifest[key].as_array().unwrap() {
            *expected.entry(e["agent"].as_str().unwrap().to_string()).or_default() += 1;
        }
    }
    assert_eq!(expected, by_agent, "imported sessions per agent must equal the manifest");
}

#[test]
fn each_project_is_dominated_by_a_few_agents_and_some_agents_serve_one_project() {
    let f = fixture();
    // project -> agent -> sessions, for sessions whose store records a project (aider and amp do not)
    let mut matrix: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    for s in &f.sessions {
        if let Some(p) = &s.project_root {
            *matrix.entry(p.rsplit('/').next().unwrap().to_string()).or_default().entry(s.agent_id.clone()).or_default() += 1;
        }
    }
    assert_eq!(matrix.len(), 5);
    let mut shapes = BTreeSet::new();
    for (p, agents) in &matrix {
        let total: usize = agents.values().sum();
        let mut counts: Vec<usize> = agents.values().copied().collect();
        counts.sort_unstable_by(|a, b| b.cmp(a));
        let top3: usize = counts.iter().take(3).sum();
        assert!(agents.len() >= 3 && agents.len() <= 8, "{p} uses {} agents: {agents:?}", agents.len());
        assert!(top3 * 100 >= total * 55, "{p}: three agents should hold most sessions: {agents:?}");
        assert!(counts[0] >= 3, "{p}: one agent leads: {agents:?}");
        shapes.insert(format!("{counts:?}"));
    }
    assert!(shapes.len() >= 4, "projects must not share one shape: {shapes:?}");
    // agents used in a single project only
    let mut projects_of: BTreeMap<&str, BTreeSet<&String>> = BTreeMap::new();
    for (p, agents) in &matrix {
        for a in agents.keys() {
            projects_of.entry(a.as_str()).or_default().insert(p);
        }
    }
    let single: Vec<&&str> = projects_of.iter().filter(|(_, ps)| ps.len() == 1).map(|(a, _)| a).collect();
    assert!(!single.is_empty() && single.len() <= 3, "one to three agents serve a single project: {projects_of:?}");
    let leaders: BTreeSet<String> = matrix
        .values()
        .map(|agents| agents.iter().max_by_key(|(_, c)| **c).unwrap().0.clone())
        .collect();
    assert!(leaders.len() >= 3, "different projects are led by different agents: {leaders:?}");
}

#[test]
fn sessions_have_real_durations_and_increasing_times() {
    let f = fixture();
    // adapters whose store keeps a time per message; cursor-cli, aider and amp keep only a start
    // (and amp an end), which is an adapter limit documented in the README
    let timed = [
        "claude-code", "codex-cli", "gemini-cli", "qwen-code", "github-copilot-cli", "cline", "opencode", "goose",
    ];
    let mut spans = vec![];
    for s in &f.sessions {
        let blocks = blocks_of(f, &s.id);
        let times: Vec<i64> = f
            .archive
            .session_messages(&s.id)
            .unwrap()
            .iter()
            .filter_map(|m| m.at)
            .collect();
        assert!(s.started_at.is_some(), "{} {:?} has no start", s.agent_id, s.native_id);
        if timed.contains(&s.agent_id.as_str()) {
            assert!(!blocks.is_empty());
            assert!(
                times.windows(2).all(|w| w[0] <= w[1]),
                "{} {:?}: message times must not go backwards",
                s.agent_id, s.native_id
            );
            let span = times.last().unwrap() - times.first().unwrap();
            spans.push(span);
            assert!(span >= 2 * 60_000, "{} {:?}: duration {} ms is too short", s.agent_id, s.native_id, span);
            assert!(span <= 100 * 60_000, "{} {:?}: duration {} ms is too long", s.agent_id, s.native_id, span);
        }
        if s.agent_id == "amp" {
            assert!(s.ended_at.unwrap() > s.started_at.unwrap(), "amp thread needs a ledger end time");
        }
    }
    spans.sort();
    let median = spans[spans.len() / 2];
    assert!((10 * 60_000..=60 * 60_000).contains(&median), "median duration {median} ms should be 10 to 60 minutes");
    assert!(*spans.last().unwrap() >= 45 * 60_000, "at least one long session expected");
    assert!(*spans.first().unwrap() <= 15 * 60_000, "at least one short session expected");
}

#[test]
fn activity_follows_working_hours_with_quiet_days_and_a_weekend_gap() {
    let f = fixture();
    let day = |ms: i64| ms.div_euclid(86_400_000);
    let mut per_day: BTreeMap<i64, usize> = BTreeMap::new();
    let mut hours = BTreeSet::new();
    // the four live sessions start within the last hour before NOW; the rest is history
    for s in f.sessions.iter().filter(|s| s.started_at.unwrap() < NOW_MS - 60 * 60_000) {
        let st = s.started_at.unwrap();
        *per_day.entry(day(st)).or_default() += 1;
        hours.insert((st / 3_600_000) % 24);
    }
    // 2026-09-28 is a Monday (epoch day 20 724). The window runs 14 days to 2026-10-12.
    let first = day(1_790_618_400_000);
    let mut busy = 0;
    let mut quiet_days = 0;
    for d in first..first + 15 {
        match per_day.get(&d).copied().unwrap_or(0) {
            0 => quiet_days += 1,
            n if n >= 4 => busy += 1,
            _ => {}
        }
    }
    assert!(busy >= 4, "expected several busy days, got {busy}: {per_day:?}");
    assert!(quiet_days >= 2, "expected quiet days / a weekend gap, got {quiet_days}: {per_day:?}");
    assert!(per_day.len() >= 10, "sessions should spread over at least 10 distinct days: {per_day:?}");
    // work hours in US Central are 14:00Z to 02:00Z; nothing should start in the small hours there
    let night: Vec<_> = hours.iter().filter(|h| (3..=10).contains(*h)).collect();
    assert!(night.is_empty(), "sessions should not start between 03:00Z and 10:59Z: {night:?}");
}

#[test]
fn hero_sessions_import_with_plans_diffs_failures_and_usage() {
    let f = fixture();
    let heroes = f.manifest["heroes"].as_array().unwrap();
    assert!((6..=8).contains(&heroes.len()), "six to eight hero sessions, got {}", heroes.len());
    let agents: BTreeSet<&str> = heroes.iter().map(|h| h["agent"].as_str().unwrap()).collect();
    for a in ["claude-code", "codex-cli", "gemini-cli"] {
        assert!(agents.contains(a), "a hero session for {a} is required");
    }
    assert!(agents.len() >= 5, "heroes should cover at least five agents: {agents:?}");

    for h in heroes {
        let agent = h["agent"].as_str().unwrap();
        let native = h["native_id"].as_str().unwrap();
        let key = h["key"].as_str().unwrap();
        let s = session_by_native(f, agent, native);
        let blocks = blocks_of(f, &s.id);
        let calls: Vec<&Value> = blocks.iter().map(|b| &b.3).filter(|b| kind(b) == "tool_call").collect();
        let results: Vec<&Value> = blocks.iter().map(|b| &b.3).filter(|b| kind(b) == "tool_result").collect();
        let texts: Vec<&str> = blocks.iter().map(|b| &b.3).filter(|b| kind(b) == "text").filter_map(|b| b["text"].as_str()).collect();
        assert!(calls.len() >= 6, "{key}: a hero needs at least 6 tool calls, got {}", calls.len());
        assert!(s.turns >= 1, "{key}: needs a user turn, got {} turns", s.turns);
        assert!(
            texts.iter().any(|t| t.contains("```")),
            "{key}: some reply must carry a Markdown code block"
        );
        assert!(
            texts.iter().filter(|t| t.len() > 200).count() >= 2,
            "{key}: replies should be substantial Markdown, not one liners"
        );
        // every result answers a call that came earlier
        let call_ids: BTreeSet<&str> = calls.iter().filter_map(|c| c["call_id"].as_str()).collect();
        for r in &results {
            assert!(call_ids.contains(r["call_id"].as_str().unwrap()), "{key}: result for unknown call {r}");
        }
        // token usage is present and grows over several observations
        assert!(s.usage.input_tokens.unwrap_or(0) > 1_000, "{key}: input tokens");
        assert!(s.usage.output_tokens.unwrap_or(0) > 200, "{key}: output tokens");
        if ["claude-code", "codex-cli", "gemini-cli", "qwen-code", "github-copilot-cli"].contains(&agent) {
            assert!(s.usage.observations.len() >= 4, "{key}: per turn usage observations");
        }
        let times: Vec<i64> = f.archive.session_messages(&s.id).unwrap().iter().filter_map(|m| m.at).collect();
        if !times.is_empty() && agent != "cursor-cli" && agent != "aider" {
            let span = times.last().unwrap() - times.first().unwrap();
            assert!(span >= 20 * 60_000, "{key}: a hero runs at least 20 minutes, got {span} ms");
        }

        let names: Vec<&str> = calls.iter().filter_map(|c| c["name"].as_str()).collect();
        let input = |name: &str| -> Vec<&Value> {
            calls.iter().filter(|c| c["name"] == name).map(|c| &c["input"]).collect()
        };
        let errors = results.iter().filter(|r| r["is_error"] == true).count();
        match (agent, key) {
            ("claude-code", "hero/claude-skyline-radar-jitter") => {
                for n in ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "TodoWrite", "Task"] {
                    assert!(names.contains(&n), "{key}: missing {n} call, have {names:?}");
                }
                let edits = input("Edit");
                assert!(edits.len() >= 3, "{key}: at least three Edit calls");
                assert!(
                    edits.iter().any(|e| e["old_string"].as_str().unwrap_or("").lines().count() >= 14
                        && e["new_string"].as_str().unwrap_or("").lines().count() >= 14),
                    "{key}: one Edit must replace a long block (a multi hunk diff)"
                );
                assert!(edits.iter().all(|e| e["old_string"] != e["new_string"]));
                let todos = input("TodoWrite");
                assert!(todos.len() >= 3, "{key}: the plan is updated as work proceeds");
                let statuses: BTreeSet<&str> = todos
                    .iter()
                    .flat_map(|t| t["todos"].as_array().unwrap())
                    .filter_map(|t| t["status"].as_str())
                    .collect();
                assert!(["pending", "in_progress", "completed"].iter().all(|x| statuses.contains(x)), "{statuses:?}");
                assert!(errors >= 2, "{key}: two failing runs (error tool results) expected, got {errors}");
                let last_bash_ok = results.iter().rev().any(|r| {
                    r["is_error"] != true && r["output"].as_str().unwrap_or("").contains("passed")
                });
                assert!(last_bash_ok, "{key}: ends with a passing test run");
                assert!(results.iter().any(|r| r["output"].as_str().unwrap_or("").contains("FAIL")));
            }
            ("claude-code", "hero/claude-nexus-burst-multiplier") => {
                assert!(results.iter().any(|r| r["is_error"] == true
                    && r["output"].as_str().unwrap_or("").contains("error[E0308]")),
                    "{key}: a rustc E0308 error result");
                assert!(input("Edit").len() >= 2);
                assert!(results.iter().any(|r| r["is_error"] != true
                    && r["output"].as_str().unwrap_or("").contains("test result: ok")));
            }
            ("claude-code", "hero/claude-zenith-diagnostics-plan") => {
                assert!(input("TodoWrite").len() >= 3, "{key}: a plan that is ticked off over time");
                assert!(input("Write").len() >= 1);
            }
            ("codex-cli", "hero/codex-nexus-bucket-refill") => {
                let commands: Vec<&str> = calls.iter().filter_map(|c| c["input"].as_str()).collect();
                assert!(commands.iter().any(|c| c.contains("apply_patch") && c.contains("*** Update File")), "{key}: apply_patch edit");
                assert!(commands.iter().any(|c| c.starts_with("cargo test")), "{key}: runs the tests");
                assert!(results.iter().any(|r| r["output"].as_str().unwrap_or("").contains("FAILED")), "{key}: a failing run");
                assert!(results.iter().any(|r| r["output"].as_str().unwrap_or("").contains("test result: ok")), "{key}: a passing run");
                assert!(texts.iter().any(|t| t.contains("- [x]") && t.contains("- [ ]")), "{key}: plan updates as checklists");
                assert!(s.completion.is_some(), "{key}: codex writes a native completion event");
            }
            ("gemini-cli", _) => {
                for n in ["read_file", "run_shell_command", "replace"] {
                    assert!(names.contains(&n), "{key}: missing {n}, have {names:?}");
                }
            }
            ("cline", _) => {
                assert!(errors >= 1, "{key}: a failing command result");
                assert!(input("replace_in_file").iter().any(|i| i["diff"].as_str().unwrap_or("").contains("<<<<<<< SEARCH")));
            }
            ("opencode", _) => {
                assert!(errors >= 1, "{key}: a failing command result");
                assert!(names.contains(&"edit") && names.contains(&"todowrite"));
            }
            _ => {}
        }
    }
}

#[test]
fn search_finds_anchors_and_cross_agent_terms() {
    let f = fixture();
    let agent_of: HashMap<String, String> =
        f.sessions.iter().map(|s| (s.id.clone(), s.agent_id.clone())).collect();
    let project_of: HashMap<String, String> = f
        .sessions
        .iter()
        .map(|s| (s.id.clone(), s.project_root.clone().unwrap_or_default()))
        .collect();
    for phrase in [
        "Doppler radar sweep",
        "token bucket rate limiter",
        "interactive API playground",
        "parquet zero-copy deserializer",
        "distributed consensus ping",
    ] {
        let hits = f.archive.search(phrase, &SearchFilter { limit: Some(200), ..Default::default() }).unwrap();
        assert!(!hits.is_empty(), "search for '{phrase}' must hit");
    }
    for term in ["rate limiter", "backoff", "flaky test", "schema migration"] {
        let hits = f.archive.search(term, &SearchFilter { limit: Some(200), ..Default::default() }).unwrap();
        let agents: BTreeSet<&String> = hits.iter().filter_map(|h| agent_of.get(&h.session_id)).collect();
        let projects: BTreeSet<&String> = hits.iter().filter_map(|h| project_of.get(&h.session_id)).filter(|p| !p.is_empty()).collect();
        assert!(agents.len() >= 3, "'{term}' should hit at least three agents, got {agents:?}");
        assert!(projects.len() >= 2, "'{term}' should hit at least two projects, got {projects:?}");
    }
    // "rate limiter" is the headline cross agent search: Claude Code, Codex and Gemini all answer it
    let hits = f.archive.search("rate limiter", &SearchFilter { limit: Some(200), ..Default::default() }).unwrap();
    let agents: BTreeSet<&str> = hits.iter().filter_map(|h| agent_of.get(&h.session_id)).map(|s| s.as_str()).collect();
    for a in ["claude-code", "codex-cli", "gemini-cli"] {
        assert!(agents.contains(a), "'rate limiter' must hit {a}: {agents:?}");
    }
}

fn procs_from(home: &Path) -> Vec<ProcessInfo> {
    let rows: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(home.join("processes.json")).unwrap()).unwrap();
    rows.iter()
        .map(|r| ProcessInfo {
            pid: r["pid"].as_u64().unwrap() as u32,
            binary: r["binary"].as_str().unwrap().to_string(),
            cwd: Some(PathBuf::from(r["cwd"].as_str().unwrap())),
            started_at: r["started_at"].as_i64(),
        })
        .collect()
}

fn detector(home: &Path) -> LiveDetector {
    let mut roots = HashMap::new();
    roots.insert("claude-code".to_string(), home.join(".claude"));
    roots.insert("codex-cli".to_string(), home.join(".codex"));
    let cfg = LiveDetectorConfig { history_roots: roots, ..Default::default() };
    LiveDetector::new(cfg, Box::new(FakeProcessScanner::new(procs_from(home))))
}

#[test]
fn processes_json_is_a_synthetic_table_under_the_fictional_roots() {
    let f = fixture();
    let rows: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(f.home.join("processes.json")).unwrap()).unwrap();
    assert_eq!(rows.len(), 4, "one process per live session");
    let mut pids = BTreeSet::new();
    for r in &rows {
        assert!(["claude", "codex"].contains(&r["binary"].as_str().unwrap()));
        let cwd = r["cwd"].as_str().unwrap();
        assert!(cwd.starts_with("/Users/fictional-dev/projects/"), "{cwd}");
        assert!(PROJECTS.iter().any(|p| cwd.ends_with(p)));
        let started = r["started_at"].as_i64().unwrap();
        assert!(started < NOW_MS && started > NOW_MS - 6 * 3_600_000, "start times are recent: {started}");
        assert!(pids.insert(r["pid"].as_u64().unwrap()), "pids are unique");
    }
}

#[test]
fn live_sessions_are_seen_by_the_real_detector_and_can_swing_to_waiting() {
    let f = fixture();
    // waiting signals are native records at the end of the file
    let claude_waiting = f.manifest["live"].as_array().unwrap().iter().find(|e| e["state"] == "waiting" && e["agent"] == "claude-code").unwrap();
    let codex_waiting = f.manifest["live"].as_array().unwrap().iter().find(|e| e["state"] == "waiting" && e["agent"] == "codex-cli").unwrap();
    assert!(is_waiting_record("claude-code", &f.home.join(claude_waiting["path"].as_str().unwrap())));
    assert!(is_waiting_record("codex-cli", &f.home.join(codex_waiting["path"].as_str().unwrap())));

    let mut det = detector(&f.home);
    let live = det.scan(NOW_MS);
    let count = |st: LiveState| live.iter().filter(|l| l.state == st).count();
    eprintln!(
        "LIVE: waiting {} working {} idle {} done {} (total {})",
        count(LiveState::Waiting), count(LiveState::Working), count(LiveState::Idle), count(LiveState::Done), live.len()
    );
    assert_eq!(count(LiveState::Waiting), 2, "two sessions need the user: {live:#?}");
    assert_eq!(count(LiveState::Working), 2, "two sessions are working");

    // the needs-you swing: append the waiting record to a working session at a chosen time
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().canonicalize().unwrap();
    run_generator(&home, &[]);
    let later = "2026-10-12T18:00:40Z";
    let out = Command::new("python3")
        .arg("-I")
        .arg(generator())
        .arg(&home)
        .args(["--append-live", "claude-aurora-working", "--now", later])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let mut det = detector(&home);
    let live = det.scan(NOW_MS + 41_000);
    assert_eq!(live.iter().filter(|l| l.state == LiveState::Waiting).count(), 3, "the working session turned waiting");
    assert_eq!(live.iter().filter(|l| l.state == LiveState::Working).count(), 1);
    // the appended signal is a valid record the importer still accepts
    let archive = import_home(&home);
    assert!(archive.sessions_query(&SessionFilter::default()).unwrap().total >= 55);
}

#[test]
fn switchboard_scanner_reads_the_configs() {
    let f = fixture();
    let roots: Vec<PathBuf> = PROJECTS.iter().map(|p| f.home.join("projects").join(p)).collect();
    for r in &roots {
        assert!(r.is_dir(), "project root {} must exist inside the HOME", r.display());
    }
    let ctx = config_scan::ScanContext::new(f.home.clone(), roots);
    let snap = config_scan::scan(&ctx, None).unwrap();
    assert_eq!(snap.projects.len(), 5);
    assert!(snap.agents.len() >= 8);
    for a in &snap.agents {
        assert!(!a.servers.is_empty(), "{} should have MCP servers", a.agent);
        assert!(a.rules.iter().any(|r| r.exists), "{} should have rules files", a.agent);
        assert!(a.notes.is_empty(), "{}: unparsed files: {:?}", a.agent, a.notes);
    }
    let matrix: HashMap<&str, &config_scan::ServerPresence> =
        snap.server_matrix.iter().map(|p| (p.name.as_str(), p)).collect();
    assert!(snap.server_matrix.iter().any(|p| p.shared_by_all), "some server is configured everywhere");
    assert!(snap.server_matrix.iter().any(|p| !p.missing_from.is_empty() && p.present_in.len() >= 2), "some server is missing from some agents");
    assert!(snap.server_matrix.iter().any(|p| p.definitions > 1), "same name, different wiring somewhere");
    assert!(snap.server_count >= 30);
    assert!(snap.masked_value_count >= 2, "masking is visible");
    let all: Vec<&config_scan::McpServer> = snap.agents.iter().flat_map(|a| a.servers.iter()).collect();
    assert!(all.iter().any(|s| !s.enabled), "one server is disabled");
    assert!(all.iter().any(|s| s.transport == config_scan::Transport::Http));
    assert!(all.iter().any(|s| s.transport == config_scan::Transport::Sse));
    assert!(all.iter().any(|s| s.scope == config_scan::Scope::Project), "project scoped servers");
    assert!(all.iter().any(|s| s.masked_values > 0), "a server carries a masked argument");
    let _ = matrix;
    // rules differ between agents for the same project, and each agent family has its own file
    let rule_paths: BTreeSet<String> = snap.agents.iter().flat_map(|a| a.rules.iter().filter(|r| r.exists).map(|r| r.path.clone())).collect();
    for want in [
        "~/.claude/CLAUDE.md", "~/.codex/AGENTS.md", "~/.gemini/GEMINI.md", "skyline-weather/CLAUDE.md",
        "skyline-weather/AGENTS.md", "skyline-weather/GEMINI.md", "nexus-gateway/CLAUDE.md",
    ] {
        assert!(rule_paths.contains(want), "missing rules file {want}: {rule_paths:?}");
    }
    assert!(rule_paths.iter().any(|p| p.contains(".cursor/rules/") && p.ends_with(".mdc")));
    assert!(rule_paths.iter().any(|p| p.contains("copilot-instructions.md")));
    let previews: BTreeSet<String> = snap
        .agents
        .iter()
        .flat_map(|a| a.rules.iter())
        .filter(|r| r.path == "skyline-weather/CLAUDE.md" || r.path == "skyline-weather/AGENTS.md")
        .filter_map(|r| r.preview.clone())
        .collect();
    assert_eq!(previews.len(), 2, "CLAUDE.md and AGENTS.md of the same project differ");
    // nothing secret shaped comes back, and the placeholder never does
    let json = serde_json::to_string(&snap).unwrap();
    assert!(!json.contains("demo-placeholder-not-a-secret"), "secret values must be masked");
    assert!(json.contains("[masked]"));
}

fn tree_digest(root: &Path) -> BTreeMap<String, (String, u64)> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                let bytes = std::fs::read(&p).unwrap();
                let mtime = std::fs::metadata(&p)
                    .unwrap()
                    .modified()
                    .unwrap()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs();
                let rel = p.strip_prefix(root).unwrap().to_string_lossy().to_string();
                out.insert(rel, (format!("{:x}", Sha256::digest(&bytes)), mtime));
            }
        }
    }
    out
}

#[test]
fn output_is_deterministic() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let (ha, hb) = (a.path().canonicalize().unwrap(), b.path().canonicalize().unwrap());
    run_generator(&ha, &[]);
    run_generator(&hb, &[]);
    let (ta, tb) = (tree_digest(&ha), tree_digest(&hb));
    assert!(ta.len() > 100, "a real tree was generated: {} files", ta.len());
    assert_eq!(ta, tb, "same arguments must give identical files, contents and modification times");
    // a different --now moves only the live files
    let c = tempfile::tempdir().unwrap();
    let hc = c.path().canonicalize().unwrap();
    let out = Command::new("python3")
        .arg("-I")
        .arg(generator())
        .arg(&hc)
        .args(["--now", "2026-10-12T19:30:00Z"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let tc = tree_digest(&hc);
    let mut allowed: BTreeSet<String> = ["processes.json", "demo-manifest.json"].iter().map(|s| s.to_string()).collect();
    for h in [&ha, &hc] {
        let m: Value = serde_json::from_str(&std::fs::read_to_string(h.join("demo-manifest.json")).unwrap()).unwrap();
        for e in m["live"].as_array().unwrap() {
            allowed.insert(e["path"].as_str().unwrap().to_string());
        }
    }
    let keys: BTreeSet<&String> = ta.keys().chain(tc.keys()).collect();
    let changed: Vec<&String> = keys.into_iter().filter(|k| ta.get(*k) != tc.get(*k)).collect();
    assert!(!changed.is_empty());
    for k in &changed {
        assert!(allowed.contains(*k), "--now must only move live files, but {k} changed");
    }
}

#[test]
fn text_is_clean_no_dashes_no_real_looking_secrets() {
    let f = fixture();
    let mut stack = vec![f.home.clone()];
    let mut files = 0;
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            files += 1;
            let bytes = std::fs::read(&p).unwrap();
            let rel = p.strip_prefix(&f.home).unwrap().display().to_string();
            assert!(!bytes.windows(3).any(|w| w == [0xE2, 0x80, 0x94] || w == [0xE2, 0x80, 0x93]), "{rel}: em or en dash");
            let text = String::from_utf8_lossy(&bytes);
            for needle in ["sk-ant", "sk-proj", "ghp_", "AKIA", "AIza", "xoxb-", "-----BEGIN"] {
                assert!(!text.contains(needle), "{rel}: contains {needle}");
            }
            if let Ok(real_home) = std::env::var("HOME") {
                // Only meaningful when HOME is a real folder; skip a bare "/" or empty value.
                if real_home.len() > 1 {
                    assert!(!text.contains(real_home.as_str()), "{rel}: real home path");
                }
            }
        }
    }
    assert!(files > 100);
}
