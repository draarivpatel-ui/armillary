//! SEC: a PATH hit on a generic binary name is not proof that an agent is installed.
//! Generic names (`zero`, `happy`, `agent`, `goose`, `q`, ...) collide with unrelated programs,
//! so they only count with corroborating evidence: one of the spec's own data folders, config
//! files or app bundles. Distinctive names (`claude`, `codex`, ...) keep working on their own.
//! Detection stays passive throughout: nothing here (or in the code under test) runs a binary.

use orrery_adapters::env::{Environment, FileSystem, MockEnvironment, MockFileSystem, TargetOs};
use orrery_adapters::path_expansion::expand_path;
use orrery_adapters::{builtin_adapters, detect_agent, get_builtin_adapter, AdapterDef};
use std::collections::BTreeSet;
use std::path::PathBuf;

/// The reviewed list. Adding a name to a builtin's `generic_binaries` means adding it here too.
const GENERIC: &[&str] = &[
    "agent", "agy", "amp", "code", "continue", "copilot", "cosine", "crush", "cs", "cursor",
    "devin", "droid", "dsh", "goose", "gocode", "happy", "hermes", "i", "interpreter", "jan",
    "jules", "junie", "kilo", "koda", "letta", "lms", "mentat", "nca", "pdx", "pool", "q", "roo",
    "sweep", "tabby", "terry", "vibe", "void", "zed", "zero",
];

/// Names the brief called out by name that must be on the list.
const MANDATORY: &[&str] = &[
    "zero", "happy", "jan", "agent", "goose", "amp", "crush", "q", "droid", "junie", "koda",
    "devin", "jules", "letta",
];

const OSES: [(TargetOs, &str); 3] = [
    (TargetOs::Macos, "/Users/testuser"),
    (TargetOs::Linux, "/home/testuser"),
    (TargetOs::Windows, "C:\\Users\\testuser"),
];

fn env_for(os: TargetOs, home: &str) -> MockEnvironment {
    MockEnvironment::new(os, home)
}

fn generic_entries() -> Vec<(AdapterDef, String)> {
    let mut out = Vec::new();
    for spec in builtin_adapters() {
        for bin in spec.detection.generic_binaries.clone() {
            out.push((spec.clone(), bin));
        }
    }
    out
}

fn is_absolute_any_os(p: &str) -> bool {
    p.starts_with('/') || p.starts_with("\\\\") || (p.len() > 2 && p.as_bytes()[1] == b':')
}

#[derive(Debug, Clone)]
enum Evidence {
    Folder(PathBuf),
    File(PathBuf),
    Bundle(PathBuf),
}

/// Evidence this test treats as corroborating, computed independently of the implementation.
fn corroborators(spec: &AdapterDef, os: TargetOs, env: &dyn Environment) -> Vec<Evidence> {
    let shared: BTreeSet<&str> = spec.detection.shared_evidence.iter().map(String::as_str).collect();
    let mut out = Vec::new();
    let paths = spec
        .detection
        .paths
        .get(os.as_str())
        .or_else(|| spec.detection.paths.get("default"));
    if let Some(paths) = paths {
        for pattern in &paths.data_folders {
            if shared.contains(pattern.as_str()) {
                continue;
            }
            if let Ok(p) = expand_path(pattern, os, env) {
                if is_absolute_any_os(&p.to_string_lossy()) {
                    out.push(Evidence::Folder(p));
                }
            }
        }
        for pattern in &paths.config_files {
            if shared.contains(pattern.as_str()) {
                continue;
            }
            if let Ok(p) = expand_path(pattern, os, env) {
                if is_absolute_any_os(&p.to_string_lossy()) {
                    out.push(Evidence::File(p));
                }
            }
        }
    }
    if os == TargetOs::Macos {
        for bundle in &spec.detection.app_bundles {
            if shared.contains(bundle.as_str()) {
                continue;
            }
            let name = if bundle.ends_with(".app") { bundle.clone() } else { format!("{bundle}.app") };
            out.push(Evidence::Bundle(PathBuf::from("/Applications").join(name)));
        }
    }
    out
}

fn apply(fs: &mut MockFileSystem, evidence: &Evidence) {
    match evidence {
        Evidence::Folder(p) | Evidence::Bundle(p) => fs.add_dir(p),
        Evidence::File(p) => fs.add_file(p, b"{}"),
    }
}

fn bin_path(os: TargetOs, name: &str) -> PathBuf {
    match os {
        TargetOs::Windows => PathBuf::from(format!("C:\\tools\\{name}.exe")),
        _ => PathBuf::from(format!("/usr/local/bin/{name}")),
    }
}

#[test]
fn the_generic_list_is_exactly_the_reviewed_one() {
    let found: BTreeSet<String> = generic_entries().into_iter().map(|(_, b)| b).collect();
    let expected: BTreeSet<String> = GENERIC.iter().map(|s| s.to_string()).collect();
    assert_eq!(found, expected, "generic_binaries across the builtins drifted from the reviewed list");
    for name in MANDATORY {
        assert!(found.contains(*name), "{name} must be treated as generic");
    }
}

#[test]
fn every_generic_name_is_one_of_the_specs_binaries() {
    for (spec, bin) in generic_entries() {
        assert!(
            spec.detection.binaries.contains(&bin),
            "{}: generic_binaries lists {bin}, which is not in binaries",
            spec.id
        );
    }
}

#[test]
fn shared_evidence_entries_match_a_listed_path_or_bundle() {
    for spec in builtin_adapters() {
        for item in &spec.detection.shared_evidence {
            let in_bundles = spec.detection.app_bundles.contains(item);
            let in_paths = spec.detection.paths.values().any(|p| {
                p.data_folders.contains(item) || p.config_files.contains(item)
            });
            assert!(in_bundles || in_paths, "{}: shared_evidence {item} matches nothing the spec lists", spec.id);
        }
    }
}

#[test]
fn every_generic_spec_has_a_corroborating_source_on_every_platform() {
    for (spec, bin) in generic_entries() {
        for (os, home) in OSES {
            let env = env_for(os, home);
            assert!(
                !corroborators(&spec, os, &env).is_empty(),
                "{} ({bin}) could never be detected on {}: no absolute, unshared data, config or bundle path",
                spec.id,
                os.as_str()
            );
        }
    }
}

#[test]
fn a_generic_name_on_path_alone_is_not_installed() {
    for (spec, bin) in generic_entries() {
        for (os, home) in OSES {
            let env = env_for(os, home);
            let mut fs = MockFileSystem::new();
            fs.add_binary(&bin, bin_path(os, &bin));
            let result = detect_agent(&spec, &env, &fs);
            assert!(
                !result.installed,
                "{} on {}: `{bin}` alone on PATH must not count as installed",
                spec.id,
                os.as_str()
            );
            assert_eq!(result.executable, None, "{}: an uncorroborated hit must not be launchable", spec.id);
            let reason = result.reason.unwrap_or_default();
            assert!(
                reason.contains(&bin),
                "{}: the diagnostic must name the binary, got {reason:?}",
                spec.id
            );
            assert!(!reason.contains('\u{2014}') && !reason.contains('\u{2013}'));
        }
    }
}

#[test]
fn a_generic_name_with_any_one_corroborator_is_installed_and_launchable() {
    for (spec, bin) in generic_entries() {
        for (os, home) in OSES {
            let env = env_for(os, home);
            for evidence in corroborators(&spec, os, &env) {
                let mut fs = MockFileSystem::new();
                let path = bin_path(os, &bin);
                fs.add_binary(&bin, path.clone());
                apply(&mut fs, &evidence);
                let result = detect_agent(&spec, &env, &fs);
                assert!(
                    result.installed,
                    "{} on {}: `{bin}` plus {evidence:?} should be installed",
                    spec.id,
                    os.as_str()
                );
                // The spec may also have a distinctive binary, but none is on this PATH.
                assert_eq!(
                    result.executable,
                    Some(path),
                    "{} on {}: the corroborated hit should be the executable",
                    spec.id,
                    os.as_str()
                );
                assert_eq!(result.reason, None);
            }
        }
    }
}

#[test]
fn evidence_without_the_binary_still_marks_installed_but_gives_no_executable() {
    for (spec, _) in generic_entries() {
        let env = env_for(TargetOs::Macos, "/Users/testuser");
        for evidence in corroborators(&spec, TargetOs::Macos, &env) {
            let mut fs = MockFileSystem::new();
            apply(&mut fs, &evidence);
            let result = detect_agent(&spec, &env, &fs);
            assert!(result.installed, "{}: {evidence:?} alone is the agent's own evidence", spec.id);
            assert_eq!(result.executable, None, "{}: no binary on PATH, so nothing to launch", spec.id);
        }
    }
}

#[test]
fn distinctive_names_on_path_alone_keep_working() {
    let table = [
        ("claude-code", "claude"),
        ("codex-cli", "codex"),
        ("gemini-cli", "gemini"),
        ("aider", "aider"),
        ("opencode", "opencode"),
        ("gptme", "gptme"),
        ("augment-auggie-cli", "auggie"),
        ("windsurf", "windsurf"),
        ("kiro-ide", "kiro"),
        ("kiro-cli", "kiro-cli"),
        ("cursor-cli", "cursor-agent"),
        ("grok-build-cli", "grok"),
    ];
    for (id, bin) in table {
        let spec = get_builtin_adapter(id).unwrap_or_else(|| panic!("{id} missing"));
        assert!(
            !spec.detection.generic_binaries.contains(&bin.to_string()),
            "{id}: {bin} is a distinctive name and should not need corroboration"
        );
        for (os, home) in OSES {
            let env = env_for(os, home);
            let mut fs = MockFileSystem::new();
            let path = bin_path(os, bin);
            fs.add_binary(bin, path.clone());
            let result = detect_agent(&spec, &env, &fs);
            assert!(result.installed, "{id} on {}: `{bin}` alone should still be enough", os.as_str());
            assert_eq!(result.executable, Some(path), "{id}: executable");
            assert_eq!(result.reason, None);
        }
    }
}

#[test]
fn a_distinctive_sibling_binary_is_preferred_and_needs_nothing_else() {
    let spec = get_builtin_adapter("cursor-cli").unwrap();
    let env = env_for(TargetOs::Macos, "/Users/testuser");
    let mut fs = MockFileSystem::new();
    fs.add_binary("agent", PathBuf::from("/opt/other/bin/agent"));
    fs.add_binary("cursor-agent", PathBuf::from("/Users/testuser/.local/bin/cursor-agent"));
    let result = detect_agent(&spec, &env, &fs);
    assert!(result.installed);
    assert_eq!(result.executable, Some(PathBuf::from("/Users/testuser/.local/bin/cursor-agent")));
}

#[test]
fn shared_directories_do_not_make_an_agent_installed() {
    let env = env_for(TargetOs::Macos, "/Users/testuser");

    // Any JetBrains IDE creates this folder; it says nothing about Junie.
    let junie = get_builtin_adapter("junie").unwrap();
    let mut fs = MockFileSystem::new();
    fs.add_dir("/Users/testuser/Library/Application Support/JetBrains");
    fs.add_binary("junie", PathBuf::from("/usr/local/bin/junie"));
    let result = detect_agent(&junie, &env, &fs);
    assert!(!result.installed, "a JetBrains folder plus a bare `junie` is not Junie");
    assert_eq!(result.executable, None);
    // The folder is still reported as data the importer may look at.
    assert!(result
        .data_paths
        .contains(&PathBuf::from("/Users/testuser/Library/Application Support/JetBrains")));

    // The Cursor IDE creates ~/.cursor, its app bundle and mcp.json; none of it proves the CLI.
    let cursor = get_builtin_adapter("cursor-cli").unwrap();
    let mut fs = MockFileSystem::new();
    fs.add_dir("/Users/testuser/.cursor");
    fs.add_dir("/Applications/Cursor.app");
    fs.add_file("/Users/testuser/.cursor/mcp.json", b"{}");
    fs.add_binary("agent", PathBuf::from("/usr/local/bin/agent"));
    let result = detect_agent(&cursor, &env, &fs);
    assert!(!result.installed, "the Cursor IDE alone is not the Cursor CLI");
    assert_eq!(result.executable, None);

    // The CLI's own config file is real evidence.
    let mut fs = MockFileSystem::new();
    fs.add_file("/Users/testuser/.cursor/cli-config.json", b"{}");
    fs.add_binary("agent", PathBuf::from("/usr/local/bin/agent"));
    let result = detect_agent(&cursor, &env, &fs);
    assert!(result.installed);
    assert_eq!(result.executable, Some(PathBuf::from("/usr/local/bin/agent")));
}

#[test]
fn paths_relative_to_the_working_directory_are_not_evidence() {
    // crush lists ./.crush and ./crush.json, which mean "whatever folder the app was started in".
    let spec = get_builtin_adapter("crush").unwrap();
    let env = env_for(TargetOs::Macos, "/Users/testuser");
    let mut fs = MockFileSystem::new();
    fs.add_dir("./.crush");
    fs.add_file("./crush.json", b"{}");
    fs.add_binary("crush", PathBuf::from("/usr/local/bin/crush"));
    let result = detect_agent(&spec, &env, &fs);
    assert!(!result.installed);
    assert_eq!(result.executable, None);
}

#[test]
fn the_path_hit_is_never_executed_or_probed() {
    struct Tripwire(MockFileSystem);
    impl FileSystem for Tripwire {
        fn exists(&self, p: &std::path::Path) -> bool {
            self.0.exists(p)
        }
        fn is_file(&self, p: &std::path::Path) -> bool {
            self.0.is_file(p)
        }
        fn is_dir(&self, p: &std::path::Path) -> bool {
            self.0.is_dir(p)
        }
        fn read_dir(&self, p: &std::path::Path) -> Result<Vec<PathBuf>, std::io::Error> {
            self.0.read_dir(p)
        }
        fn which(&self, b: &str) -> Option<PathBuf> {
            self.0.which(b)
        }
        fn version_of(&self, _: &std::path::Path, _: &[String]) -> Option<String> {
            panic!("detection must not ask a binary for its version")
        }
    }
    let spec = get_builtin_adapter("zero").unwrap();
    let env = env_for(TargetOs::Linux, "/home/testuser");
    let mut inner = MockFileSystem::new();
    inner.add_binary("zero", PathBuf::from("/usr/bin/zero"));
    inner.add_dir("/home/testuser/.zero");
    let result = detect_agent(&spec, &env, &Tripwire(inner));
    assert!(result.installed);
    assert_eq!(result.version, None);
}
